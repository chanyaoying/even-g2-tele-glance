"""TelethonTelegramService lifecycle with a stubbed Telethon client: create, connect, close, reconnect, errors.

Most other tests replace `_get_client`; these exercise the real one so connection handling stays covered.
"""
import asyncio
import json
import time
from types import SimpleNamespace

import httpx
import pytest
import telethon

import app.dependencies as dependencies
import app.services.telegram as telegram_module
from app.config import Settings, get_settings
from app.dependencies import get_telegram_service
from app.main import create_app
from app.models import ResyncUpdate
from app.services.secure_auth import encrypt_payload
from app.services.telegram import (
    TelegramClientCredentials,
    TelegramServiceError,
    TelegramSessionExpiredError,
    TelegramUnavailableError,
    TelethonTelegramService,
)

SECRET = "lifecycle-secret-long-enough"


def valid_session_string() -> str:
    from telethon.crypto import AuthKey
    from telethon.sessions import StringSession

    session = StringSession()
    session.set_dc(2, "149.154.167.51", 443)
    session.auth_key = AuthKey(b"\x01" * 256)
    return session.save()


VALID_SESSION = valid_session_string()


class StubClient:
    instances: list["StubClient"] = []
    connect_delay = 0.0
    connect_error: Exception = None

    def __init__(self, session, api_id, api_hash, **kwargs):
        self.session_arg = session
        self.kwargs = kwargs
        self.connected = False
        self.connects = 0
        self.disconnects = 0
        self.handlers = []
        self.authorized = True
        self.session = SimpleNamespace(save=lambda: "SIGNED-IN-SESSION")
        StubClient.instances.append(self)

    def is_connected(self):
        return self.connected

    async def connect(self):
        self.connects += 1
        if StubClient.connect_error is not None:
            raise StubClient.connect_error
        await asyncio.sleep(StubClient.connect_delay)
        self.connected = True

    async def disconnect(self):
        self.disconnects += 1
        self.connected = False

    def add_event_handler(self, callback, event):
        self.handlers.append(callback)

    async def get_me(self):
        return SimpleNamespace(id=1)

    async def is_user_authorized(self):
        return self.authorized

    async def sign_in(self, **kwargs):
        self.authorized = True

    async def get_dialogs(self, limit=None):
        return []


@pytest.fixture(autouse=True)
def stub_telethon(monkeypatch):
    StubClient.instances = []
    StubClient.connect_delay = 0.0
    StubClient.connect_error = None
    monkeypatch.setattr(telethon, "TelegramClient", StubClient)
    dependencies._telegram_services.clear()
    dependencies._pending_telegram_services.clear()
    yield
    dependencies._telegram_services.clear()
    dependencies._pending_telegram_services.clear()


def make_service(session=VALID_SESSION, **kwargs):
    return TelethonTelegramService(
        Settings(TELEGLANCE_SHARED_SECRET=SECRET),
        TelegramClientCredentials(api_id=1, api_hash="hash", session_string=session, **kwargs),
    )


def run(coro):
    return asyncio.run(coro)


def test_client_is_built_so_flood_waits_reach_the_phone_and_connects_fail_fast(monkeypatch):
    service = make_service(session=None)
    run(service._get_client())
    (client,) = StubClient.instances
    assert client.kwargs["flood_sleep_threshold"] == telegram_module.FLOOD_SLEEP_THRESHOLD_SECONDS <= 2
    assert client.kwargs["connection_retries"] == telegram_module.CONNECTION_RETRIES


def test_parallel_first_requests_share_one_client_and_one_connect():
    StubClient.connect_delay = 0.02
    service = make_service(session=None)

    async def scenario():
        return await asyncio.gather(*(service._get_client() for _ in range(5)))

    clients = run(scenario())
    assert len(StubClient.instances) == 1
    assert all(client is clients[0] for client in clients)
    assert clients[0].connects == 1
    assert len(clients[0].handlers) == 4  # handlers registered once


def test_hanging_connect_times_out_as_unavailable_and_starts_clean_next_time(monkeypatch):
    monkeypatch.setattr(telegram_module, "CONNECT_TIMEOUT_SECONDS", 0.05)
    StubClient.connect_delay = 5
    service = make_service(session=None)
    with pytest.raises(TelegramUnavailableError):
        run(service._get_client())
    assert service._client is None
    StubClient.connect_delay = 0
    assert run(service._get_client()) is StubClient.instances[-1]
    assert len(StubClient.instances) == 2


def test_connection_refused_maps_to_unavailable_not_a_bare_error():
    StubClient.connect_error = ConnectionRefusedError("refused")
    service = make_service()
    with pytest.raises(TelegramUnavailableError, match="Could not reach Telegram"):
        run(service.list_chats(limit=5))
    with pytest.raises(TelegramUnavailableError):
        run(service.list_messages(1))
    with pytest.raises(TelegramUnavailableError):
        run(service.auth_status())


def test_malformed_session_string_is_a_session_error_not_a_500():
    service = make_service(session="not a valid session!!")
    with pytest.raises(TelegramSessionExpiredError, match="invalid"):
        run(service.list_chats(limit=5))
    assert service.expired is True
    assert StubClient.instances == []


def test_close_disconnects_and_refuses_to_reconnect():
    service = make_service()
    client = run(service._get_client())
    run(service.close())
    assert client.disconnects == 1
    with pytest.raises(TelegramUnavailableError):
        run(service._get_client())
    assert len(StubClient.instances) == 1  # no orphan client was created after close


def test_close_clears_per_account_caches():
    service = make_service()
    run(service._get_client())
    service._entity_cache[5] = object()
    service._folder_cache = (0.0, ["filter"])
    service._dialog_snapshot = object()
    run(service.close())
    assert len(service._entity_cache) == 0
    assert service._folder_cache is None
    assert service._dialog_snapshot is None


def test_reconnect_after_a_drop_tells_open_streams_to_resync():
    service = make_service()

    async def scenario():
        queue: asyncio.Queue = asyncio.Queue()
        await service._get_client()
        service._update_queues.add(queue)
        assert queue.empty()  # the first connect is not a reconnect
        StubClient.instances[0].connected = False  # Telethon gave up reconnecting on its own
        await service.ensure_stream_connection()
        return queue

    queue = run(scenario())
    assert StubClient.instances[0].connects == 2
    assert isinstance(queue.get_nowait(), ResyncUpdate)


def test_ensure_stream_connection_is_free_while_connected():
    service = make_service()
    run(service._get_client())
    run(service.ensure_stream_connection())
    assert StubClient.instances[0].connects == 1


def test_entity_and_user_name_caches_are_bounded(monkeypatch):
    service = make_service()
    service._entity_cache.max_size = 3
    for chat_id in range(10):
        service._entity_cache[chat_id] = chat_id
    assert list(service._entity_cache) == [7, 8, 9]
    service._entity_cache.get(7)  # a hit keeps an entry
    service._entity_cache[10] = 10
    assert list(service._entity_cache) == [9, 7, 10]
    assert service._user_name_cache.max_size == telegram_module.USER_NAME_CACHE_SIZE


def test_slow_reply_lookup_does_not_hold_back_a_live_message(monkeypatch):
    monkeypatch.setattr(telegram_module, "LIVE_REPLY_TIMEOUT_SECONDS", 0.05)
    service = make_service()

    async def slow_reply(update, message):
        await asyncio.sleep(5)

    service._resolve_live_reply = slow_reply  # type: ignore[method-assign]
    message = SimpleNamespace(id=9, message="hi", date=None, out=False, sender=None, reply_to=None, media=None, action=None, fwd_from=None, entities=None)

    async def scenario():
        queue: asyncio.Queue = asyncio.Queue()
        service._update_queues.add(queue)
        started = time.perf_counter()
        await service._handle_new_message(SimpleNamespace(message=message, chat_id=1))
        return queue, time.perf_counter() - started

    queue, elapsed = run(scenario())
    assert elapsed < 1
    assert queue.get_nowait().message.id == 9


# --- through the HTTP API ----------------------------------------------------------------


def auth_header(session=""):
    payload = {"apiId": "1", "apiHash": "hash", "session": session, "ts": int(time.time())}
    return encrypt_payload(json.dumps(payload).encode("utf-8"), SECRET)


def envelope(payload):
    return json.dumps({"encryptedPayload": encrypt_payload(json.dumps(payload).encode("utf-8"), SECRET)}).encode()


@pytest.fixture
def secret_env(monkeypatch):
    monkeypatch.setenv("TELEGLANCE_SHARED_SECRET", SECRET)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_finished_phone_login_closes_the_real_pending_client(secret_env):
    app = create_app(Settings(TELEGLANCE_SHARED_SECRET=SECRET, BACKEND_CORS_ORIGINS=[]))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        StubClient.connect_delay = 0
        response = await client.post(
            "/api/session/phone/verify",
            headers={"X-TeleGlance-Auth": auth_header(), "Content-Type": "application/json"},
            content=envelope({"phone": "+15550000001", "code": "12345"}),
        )
    assert response.status_code == 200
    (stub,) = StubClient.instances
    assert stub.disconnects == 1 and stub.connected is False
    assert dependencies._pending_telegram_services == {}


@pytest.mark.asyncio
async def test_unreachable_telegram_is_503_with_retry_after(secret_env):
    StubClient.connect_error = OSError("network is unreachable")
    app = create_app(Settings(TELEGLANCE_SHARED_SECRET=SECRET, BACKEND_CORS_ORIGINS=[]))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/chats", headers={"X-TeleGlance-Auth": auth_header(VALID_SESSION)})
    assert response.status_code == 503
    assert response.headers["Retry-After"] == "5"


class BrokenStream:
    async def update_events(self):
        raise RuntimeError("socket internals /var/run/secret")
        yield  # pragma: no cover


class DroppedStream:
    async def update_events(self):
        await asyncio.sleep(10)
        yield  # pragma: no cover

    async def ensure_stream_connection(self):
        raise TelegramUnavailableError("Could not reach Telegram. Please retry.")


@pytest.mark.asyncio
async def test_unexpected_stream_failure_ends_with_a_generic_error_event():
    app = create_app()
    app.dependency_overrides[get_telegram_service] = lambda: BrokenStream()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/updates")
    assert "event: error" in response.text
    assert "Update stream failed" in response.text
    assert "secret" not in response.text


@pytest.mark.asyncio
async def test_idle_stream_with_a_dead_connection_reports_an_error(monkeypatch):
    import app.main as main_module

    monkeypatch.setattr(main_module, "STREAM_KEEPALIVE_SECONDS", 0.01)
    app = create_app()
    app.dependency_overrides[get_telegram_service] = lambda: DroppedStream()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/updates")
    assert "event: error" in response.text
    assert "Could not reach Telegram" in response.text


# --- forum topics ------------------------------------------------------------------------


class TopicClient:
    def __init__(self, total):
        self.total = total
        self.requests = []

    async def __call__(self, request):
        self.requests.append(request)
        topics = list(range(1, self.total + 1))
        if request.offset_topic:
            topics = topics[topics.index(request.offset_topic) + 1:]
        page = topics[: request.limit]
        return SimpleNamespace(
            topics=[SimpleNamespace(id=t, title=f"T{t}", top_message=1000 + t, unread_count=0) for t in page],
            messages=[
                SimpleNamespace(id=1000 + t, message=f"latest in {t}", date=None, out=False, sender=None, reply_to=None, media=None, action=None, fwd_from=None, entities=None)
                for t in page
            ],
        )


def topic_service(client):
    service = make_service()

    async def get_client():
        return client

    async def get_entity(chat_id):
        return chat_id

    service._get_client = get_client  # type: ignore[method-assign]
    service._get_entity = get_entity  # type: ignore[method-assign]
    return service


def test_default_topic_list_is_one_request_of_twenty_with_previews():
    client = TopicClient(total=30)
    topics = run(topic_service(client).list_topics(5))
    assert [t.id for t in topics] == list(range(1, 21))
    assert len(client.requests) == 1 and client.requests[0].limit == 20
    assert topics[0].last_message == "latest in 1"


def test_topic_offset_pages_through_telegram_cursors():
    client = TopicClient(total=250)
    topics = run(topic_service(client).list_topics(5, limit=30, offset=150))
    assert [t.id for t in topics] == list(range(151, 181))
    assert [r.limit for r in client.requests] == [100, 80]
    assert client.requests[1].offset_topic == 100 and client.requests[1].offset_id == 1100


def test_topic_paging_stops_at_the_end():
    client = TopicClient(total=5)
    assert run(topic_service(client).list_topics(5, limit=10, offset=3))[0].id == 4
    assert len(client.requests) == 1


def test_wrapped_errors_never_echo_raw_exception_text():
    error = telegram_module.wrap_telegram_error(RuntimeError("RPC internals: request 0xdeadbeef"))
    assert isinstance(error, TelegramServiceError)
    assert "deadbeef" not in str(error)
    assert str(error) == telegram_module.GENERIC_ERROR_MESSAGE


def test_known_telegram_errors_keep_a_useful_message():
    from telethon import errors

    assert str(telegram_module.wrap_telegram_error(errors.PeerIdInvalidError(request=None))) == "Chat not found."
    assert str(telegram_module.wrap_telegram_error(errors.PhoneCodeInvalidError(request=None))) == "Verification code is incorrect."
    assert str(telegram_module.wrap_telegram_error(ValueError("Could not find the input entity for PeerUser(user_id=5)"))) == "Chat not found."
    assert isinstance(telegram_module.wrap_telegram_error(errors.SessionRevokedError(request=None)), TelegramSessionExpiredError)
