"""The per-session Telegram service cache: bounded, idle entries closed, logout and shutdown clean up."""
import asyncio
import json
import time

import httpx
import pytest

import app.dependencies as dependencies
from app.config import Settings, get_settings
from app.main import create_app
from app.services.secure_auth import encrypt_payload

SECRET = "cache-secret-long-enough"


class FakeService:
    created: list["FakeService"] = []

    def __init__(self, settings, credentials):
        self.credentials = credentials
        self.closed = 0
        self.subscriber_count = 0
        self.expired = False
        self.logged_out = False
        FakeService.created.append(self)

    async def close(self):
        self.closed += 1

    async def logout(self):
        self.logged_out = True


@pytest.fixture(autouse=True)
def fake_services(monkeypatch):
    FakeService.created = []
    monkeypatch.setattr(dependencies, "TelethonTelegramService", FakeService)
    settings = Settings(TELEGLANCE_SHARED_SECRET=SECRET, BACKEND_CORS_ORIGINS=[])
    monkeypatch.setattr(dependencies, "get_settings", lambda: settings)
    clock = {"now": 1000.0}
    monkeypatch.setattr(dependencies.time, "monotonic", lambda: clock["now"])
    dependencies._telegram_services.clear()
    dependencies._pending_telegram_services.clear()
    dependencies._services_to_close.clear()
    yield clock
    dependencies._telegram_services.clear()
    dependencies._pending_telegram_services.clear()
    dependencies._services_to_close.clear()


def header(session="session-a"):
    payload = {"apiId": "1", "apiHash": "hash", "session": session, "ts": int(time.time())}
    return encrypt_payload(json.dumps(payload).encode("utf-8"), SECRET)


def test_cache_is_bounded_and_evicted_services_are_closed(monkeypatch, fake_services):
    monkeypatch.setattr(dependencies, "MAX_TELEGRAM_SERVICES", 2)
    a = dependencies.get_telegram_service(header("a"))
    b = dependencies.get_telegram_service(header("b"))
    dependencies.get_telegram_service(header("a"))  # a is now the most recently used
    c = dependencies.get_telegram_service(header("c"))
    assert [s for _t, s in dependencies._telegram_services.values()] == [a, c]
    assert asyncio.run(dependencies.sweep_telegram_services()) == 1
    assert b.closed == 1 and a.closed == 0 and c.closed == 0


def test_a_service_with_an_open_stream_is_not_evicted_for_capacity(monkeypatch):
    monkeypatch.setattr(dependencies, "MAX_TELEGRAM_SERVICES", 1)
    streaming = dependencies.get_telegram_service(header("a"))
    streaming.subscriber_count = 1
    other = dependencies.get_telegram_service(header("b"))
    assert streaming in [s for _t, s in dependencies._telegram_services.values()]
    assert other in [s for _t, s in dependencies._telegram_services.values()]


def test_idle_services_are_closed_unless_streaming(fake_services):
    idle = dependencies.get_telegram_service(header("idle"))
    streaming = dependencies.get_telegram_service(header("stream"))
    streaming.subscriber_count = 1
    fake_services["now"] += dependencies.IDLE_TELEGRAM_SERVICE_SECONDS - 5
    recent = dependencies.get_telegram_service(header("recent"))
    fake_services["now"] += 10
    assert asyncio.run(dependencies.sweep_telegram_services()) == 1
    assert idle.closed == 1 and streaming.closed == 0 and recent.closed == 0
    # The next request for the idle session gets a fresh service.
    assert dependencies.get_telegram_service(header("idle")) is not idle


def test_expired_sessions_are_dropped_soon(fake_services):
    service = dependencies.get_telegram_service(header("old"))
    service.expired = True
    fake_services["now"] += dependencies.EXPIRED_TELEGRAM_SERVICE_SECONDS + 1
    asyncio.run(dependencies.sweep_telegram_services())
    assert service.closed == 1
    assert dependencies._telegram_services == {}


def test_expired_pending_logins_are_closed_not_just_forgotten(fake_services):
    pending = dependencies.get_telegram_service(header(""))
    fake_services["now"] += dependencies.PENDING_TELEGRAM_SERVICE_TTL_SECONDS + 1
    asyncio.run(dependencies.sweep_telegram_services())
    assert pending.closed == 1
    assert dependencies._pending_telegram_services == {}


def test_pending_logins_are_bounded(monkeypatch, fake_services):
    monkeypatch.setattr(dependencies, "MAX_PENDING_TELEGRAM_SERVICES", 2)
    settings = Settings(TELEGLANCE_SHARED_SECRET=SECRET)
    services = []
    for api_id in range(3):
        fake_services["now"] += 1
        credentials = dependencies.TelegramClientCredentials(api_id=api_id, api_hash="h")
        services.append(dependencies.get_pending_telegram_service(settings, credentials))
    assert len(dependencies._pending_telegram_services) == 2
    asyncio.run(dependencies.sweep_telegram_services())
    assert services[0].closed == 1


@pytest.mark.asyncio
async def test_logout_removes_the_service_from_the_cache(monkeypatch):
    monkeypatch.setenv("TELEGLANCE_SHARED_SECRET", SECRET)
    get_settings.cache_clear()
    app = create_app(Settings(TELEGLANCE_SHARED_SECRET=SECRET, BACKEND_CORS_ORIGINS=[]))
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/api/session/logout",
                headers={"X-TeleGlance-Auth": header("session-a")},
                content=json.dumps({"encryptedPayload": encrypt_payload(b"{}", SECRET)}),
            )
    finally:
        get_settings.cache_clear()
    assert response.status_code == 200
    assert FakeService.created[0].logged_out is True
    assert dependencies._telegram_services == {}


@pytest.mark.asyncio
async def test_shutdown_closes_every_cached_service():
    active = dependencies.get_telegram_service(header("a"))
    pending = dependencies.get_telegram_service(header(""))
    app = create_app(Settings(TELEGLANCE_SHARED_SECRET=SECRET, BACKEND_CORS_ORIGINS=[], WHISPER_PRELOAD=False))
    async with app.router.lifespan_context(app):
        pass
    assert active.closed == 1 and pending.closed == 1
    assert dependencies._telegram_services == {} and dependencies._pending_telegram_services == {}
