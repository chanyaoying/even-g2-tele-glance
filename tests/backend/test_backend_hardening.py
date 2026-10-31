import asyncio
from types import SimpleNamespace

import httpx
import pytest

from app.config import Settings
from app.dependencies import get_telegram_service
from app.main import create_app
from app.models import MessageSummary, ResyncUpdate, TelegramUpdate
from app.services.telegram import (
    ReplyPreviewCache,
    TelegramClientCredentials,
    TelegramRateLimitError,
    TelegramServiceError,
    TelethonTelegramService,
    attach_replies,
    normalize_message,
    wrap_telegram_error,
)


# --- B1: flood waits -------------------------------------------------------


class FloodWaitError(Exception):
    def __init__(self, seconds):
        super().__init__(f"A wait of {seconds} seconds is required")
        self.seconds = seconds


class SlowModeWaitError(Exception):
    def __init__(self, seconds):
        self.seconds = seconds


class FloodPremiumWaitError(FloodWaitError):
    pass


@pytest.mark.parametrize("exc_type", [FloodWaitError, SlowModeWaitError, FloodPremiumWaitError])
def test_flood_waits_become_rate_limit_errors(exc_type):
    wrapped = wrap_telegram_error(exc_type(42))
    assert isinstance(wrapped, TelegramRateLimitError)
    assert wrapped.seconds == 42
    assert "42" in str(wrapped)


def test_wrapping_keeps_existing_service_errors():
    original = TelegramServiceError("x")
    assert wrap_telegram_error(original) is original


class RateLimitedService:
    async def list_chats(self, limit, offset=0, folder_id=None):
        raise TelegramRateLimitError(17)


@pytest.mark.asyncio
async def test_rate_limit_returns_429_with_retry_after():
    app = create_app()
    app.dependency_overrides[get_telegram_service] = lambda: RateLimitedService()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/chats?limit=5")
    assert response.status_code == 429
    assert response.headers["retry-after"] == "17"
    assert "17" in response.json()["detail"]


@pytest.mark.asyncio
async def test_retry_after_is_exposed_to_cors():
    app = create_app()
    app.dependency_overrides[get_telegram_service] = lambda: RateLimitedService()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/health", headers={"Origin": "http://localhost:5173"})
    assert "retry-after" in response.headers.get("access-control-expose-headers", "").lower()


# --- B2: update queue overflow ----------------------------------------------


def _update(message_id):
    return TelegramUpdate(chat_id=1, message=MessageSummary(id=message_id, sender="a", text=str(message_id)))


def test_full_update_queue_drops_oldest_and_adds_resync_marker():
    service = TelethonTelegramService(settings=Settings())
    queue: asyncio.Queue = asyncio.Queue(maxsize=3)
    service._update_queues.add(queue)
    for i in range(1, 4):
        service._publish(_update(i))
    service._publish(_update(4))

    items = []
    while not queue.empty():
        items.append(queue.get_nowait())
    assert isinstance(items[-2], ResyncUpdate)
    assert items[-1].message.id == 4  # the newest update is never lost
    assert [i.message.id for i in items if not isinstance(i, ResyncUpdate)] == [3, 4]


def test_non_full_queue_gets_no_marker():
    service = TelethonTelegramService(settings=Settings())
    queue: asyncio.Queue = asyncio.Queue(maxsize=3)
    service._update_queues.add(queue)
    service._publish(_update(1))
    assert queue.qsize() == 1
    assert not isinstance(queue.get_nowait(), ResyncUpdate)


class ResyncStreamService:
    async def update_events(self):
        yield ResyncUpdate()


@pytest.mark.asyncio
async def test_stream_turns_marker_into_resync_sse_event():
    app = create_app()
    app.dependency_overrides[get_telegram_service] = lambda: ResyncStreamService()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/updates")
    assert "event: resync\ndata: " in response.text
    assert '"type":"resync"' in response.text


# --- B3: real send_message --------------------------------------------------


def _send_service(sent_id=99):
    service = TelethonTelegramService(
        settings=Settings(),
        credentials=TelegramClientCredentials(api_id=1, api_hash="hash"),
    )
    calls = []

    class Client:
        async def send_message(self, entity, text, **kwargs):
            calls.append((entity, text, kwargs))
            return SimpleNamespace(id=sent_id)

    async def get_client():
        return Client()

    async def get_entity(chat_id):
        return f"entity:{chat_id}"

    service._get_client = get_client  # type: ignore[method-assign]
    service._get_entity = get_entity  # type: ignore[method-assign]
    return service, calls


def test_forum_topic_send_replies_to_topic_id():
    service, calls = _send_service()
    result = asyncio.run(service.send_message(-100123, text="hello", topic_id=555))
    assert result.id == 99
    assert calls == [("entity:-100123", "hello", {"reply_to": 555})]


def test_normal_chat_send_has_no_reply_to():
    service, calls = _send_service()
    asyncio.run(service.send_message(77, text="hi"))
    assert calls == [("entity:77", "hi", {})]


def test_send_flood_wait_maps_to_rate_limit():
    service, _ = _send_service()

    async def get_client():
        class Client:
            async def send_message(self, *a, **k):
                raise SlowModeWaitError(30)

        return Client()

    service._get_client = get_client  # type: ignore[method-assign]
    with pytest.raises(TelegramRateLimitError) as info:
        asyncio.run(service.send_message(1, text="x"))
    assert info.value.seconds == 30


# --- S5: reply preview cache --------------------------------------------------


def _msg(message_id, text, reply_to=None, sender=None):
    from datetime import datetime, timezone

    return SimpleNamespace(
        id=message_id,
        message=text,
        date=datetime(2026, 1, 1, tzinfo=timezone.utc),
        out=False,
        sender=sender,
        from_id=None,
        reply_to=reply_to,
        media=None,
        action=None,
        fwd_from=None,
        entities=None,
    )


def _reply(target):
    return SimpleNamespace(reply_to_msg_id=target, reply_to_top_id=None, forum_topic=False)


def test_repeat_page_fetch_costs_one_lookup_with_cache():
    cache = ReplyPreviewCache()
    original = _msg(5, "the original", sender=SimpleNamespace(id=2, first_name="Bo"))
    lookups = []

    async def lookup(ids):
        lookups.append(ids)
        return [original]

    async def page():
        raws = [_msg(10, "re", reply_to=_reply(5))]
        summaries = [normalize_message(raw) for raw in raws]
        await attach_replies(lookup, raws, summaries, cache=cache, chat_id=1)
        return summaries[0].reply_to

    first = asyncio.run(page())
    second = asyncio.run(page())
    assert lookups == [[5]]
    assert first.sender == second.sender == "Bo"
    assert first.preview == second.preview == "the original"


def test_cache_invalidate_forces_refetch_and_is_per_chat():
    cache = ReplyPreviewCache()
    cache.put(1, 5, "Bo", "old")
    cache.put(2, 5, "Cy", "other chat")
    cache.invalidate(1, 5)
    assert cache.get(1, 5) is None
    assert cache.get(2, 5) == ("Cy", "other chat")


def test_cache_is_bounded():
    cache = ReplyPreviewCache(max_chats=2, per_chat=3)
    for message_id in range(10):
        cache.put(1, message_id, None, "x")
    assert cache.get(1, 0) is None and cache.get(1, 9) is not None
    cache.put(2, 1, None, "x")
    cache.put(3, 1, None, "x")
    assert cache.get(1, 9) is None  # least recently used chat evicted
    assert len(cache._chats) == 2


def test_edit_event_invalidates_cached_preview():
    service = TelethonTelegramService(settings=Settings())
    service._update_queues.add(asyncio.Queue())
    service._reply_cache.put(1, 5, "Bo", "stale")
    message = _msg(5, "edited text")
    event = SimpleNamespace(message=message, chat_id=1)

    async def noop(update, message):
        return None

    service._resolve_live_reply = noop  # type: ignore[method-assign]
    asyncio.run(service._handle_new_message(event))
    assert service._reply_cache.get(1, 5) is None
