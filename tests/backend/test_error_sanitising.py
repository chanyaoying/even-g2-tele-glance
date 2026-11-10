"""Internal exception text stays in the server log; clients get fixed, user-meaningful messages."""
import json
import time

import httpx
import pytest

from app.config import Settings
from app.dependencies import get_telegram_service, get_transcription_service
from app.main import create_app
from app.services.imaging import ImagingError, prepare_glasses_image
from app.services.secure_auth import decrypt_payload, encrypt_payload
from app.services.telegram import wrap_telegram_error
from app.services.transcription import TranscriptionBusyError

SECRET = "sanitising-secret-long-enough"


def auth_header():
    payload = {"apiId": "1", "apiHash": "hash", "session": "s", "ts": int(time.time())}
    return encrypt_payload(json.dumps(payload).encode("utf-8"), SECRET)


def detail(response):
    body = response.json()
    if "encryptedPayload" in body:
        body = json.loads(decrypt_payload(body["encryptedPayload"], SECRET))
    return body["detail"]


class ExplodingTranscription:
    def __init__(self, error):
        self.error = error

    async def transcribe_wav(self, raw, language=None):
        raise self.error


class FailingTelegram:
    async def list_chats(self, limit, offset=0, folder_id=None):
        raise wrap_telegram_error(KeyError("internal cache key 0xdeadbeef"))


def make_app():
    return create_app(Settings(TELEGLANCE_SHARED_SECRET=SECRET, BACKEND_CORS_ORIGINS=[]))


async def upload(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.post(
            "/api/transcribe",
            headers={"X-TeleGlance-Auth": auth_header()},
            files={"audio": ("a.pcm", b"\x00\x01" * 100, "audio/pcm")},
        )


@pytest.mark.asyncio
async def test_unexpected_transcription_failure_hides_the_exception_text(caplog):
    app = make_app()
    app.dependency_overrides[get_transcription_service] = lambda: ExplodingTranscription(RuntimeError("/models/secret-path missing"))
    response = await upload(app)
    assert response.status_code == 500
    assert detail(response) == "transcription failed"
    assert "secret-path" in caplog.text  # still available to the operator


@pytest.mark.asyncio
async def test_busy_transcription_is_503_with_retry_after():
    app = make_app()
    app.dependency_overrides[get_transcription_service] = lambda: ExplodingTranscription(TranscriptionBusyError("transcription is busy, please retry"))
    response = await upload(app)
    assert response.status_code == 503
    assert response.headers["Retry-After"] == "5"
    assert detail(response) == "transcription is busy, please retry"


@pytest.mark.asyncio
async def test_unknown_telegram_failure_is_a_generic_400():
    app = make_app()
    app.dependency_overrides[get_telegram_service] = lambda: FailingTelegram()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/chats", headers={"X-TeleGlance-Auth": auth_header()})
    assert response.status_code == 400
    assert detail(response) == "Telegram request failed. Please retry."


@pytest.mark.asyncio
async def test_malformed_envelope_gets_a_fixed_message():
    app = make_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/chats/1/messages",
            headers={"X-TeleGlance-Auth": auth_header(), "Content-Type": "application/json"},
            content=b'{"encryptedPayload": "v1.unterminated',
        )
    assert response.status_code == 400
    assert response.json()["detail"] == "Encrypted JSON request body is required"


def test_image_decode_error_does_not_carry_pillow_text():
    with pytest.raises(ImagingError) as info:
        prepare_glasses_image(b"\x89PNG\r\n\x1a\n" + b"garbage" * 10)
    assert str(info.value) == "image could not be decoded"


# --- machine-readable error signals for the phone ----------------------------------------------------

from app.services.telegram import SESSION_EXPIRED_MESSAGE, SESSION_INVALID_MESSAGE, TelegramSessionExpiredError


class ExpiredTelegram:
    async def list_chats(self, limit, offset=0, folder_id=None):
        raise TelegramSessionExpiredError(SESSION_EXPIRED_MESSAGE)

    async def update_events(self):
        raise TelegramSessionExpiredError(SESSION_EXPIRED_MESSAGE)
        yield  # pragma: no cover


def test_session_messages_keep_the_phrase_the_phone_matches():
    assert "session has expired" in SESSION_EXPIRED_MESSAGE
    assert "session has expired" in SESSION_INVALID_MESSAGE


@pytest.mark.asyncio
async def test_expired_session_401_carries_the_error_code_header():
    app = create_app(Settings(TELEGLANCE_SHARED_SECRET=SECRET, BACKEND_CORS_ORIGINS=["http://phone.test"]))
    app.dependency_overrides[get_telegram_service] = lambda: ExpiredTelegram()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/chats", headers={"X-TeleGlance-Auth": auth_header(), "Origin": "http://phone.test"})
    assert response.status_code == 401
    assert response.headers["X-TeleGlance-Error"] == "session_expired"
    assert "x-teleglance-error" in response.headers["access-control-expose-headers"].lower()
    assert "session has expired" in detail(response)


@pytest.mark.asyncio
async def test_expired_session_stream_error_has_a_code():
    app = make_app()
    app.dependency_overrides[get_telegram_service] = lambda: ExpiredTelegram()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/updates", headers={"X-TeleGlance-Auth": auth_header(), "X-TeleGlance-Proto": "2"})
    data_line = next(line for line in response.text.splitlines() if line.startswith("data: "))
    from app.services.secure_auth import RESPONSE_AAD

    event = json.loads(decrypt_payload(json.loads(data_line[6:])["encryptedPayload"], SECRET, RESPONSE_AAD))
    assert event["code"] == "session_expired" and "session has expired" in event["detail"]


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/api/chats", "/api/transcribe"])
async def test_rejected_auth_header_401_says_backend_auth(path, monkeypatch):
    # get_telegram_service reads the global settings
    monkeypatch.setattr("app.dependencies.get_settings", lambda: Settings(TELEGLANCE_SHARED_SECRET=SECRET))
    app = make_app()
    transport = httpx.ASGITransport(app=app)
    forged = {"X-TeleGlance-Auth": "v1.AAAAAAAAAAAAAAAA." + "A" * 40}
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        if path == "/api/transcribe":
            response = await client.post(path, headers=forged, files={"audio": ("a.pcm", b"\x00\x00", "audio/pcm")})
        else:
            response = await client.get(path, headers=forged)
    assert response.status_code == 401
    assert response.headers["X-TeleGlance-Error"] == "backend_auth"
    assert "encrypt" in detail(response).lower()


@pytest.mark.asyncio
async def test_proto2_transcribe_response_uses_the_response_aad():
    from app.models import TranscriptionResponse
    from app.services.secure_auth import RESPONSE_AAD

    class Ok:
        async def transcribe_wav(self, raw, language=None):
            return TranscriptionResponse(text="hello")

    app = make_app()
    app.dependency_overrides[get_transcription_service] = lambda: Ok()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/transcribe",
            headers={"X-TeleGlance-Auth": auth_header(), "X-TeleGlance-Proto": "2"},
            files={"audio": ("a.pcm", b"\x00\x01" * 100, "audio/pcm")},
        )
        health = await client.get("/health", headers={"X-TeleGlance-Proto": "2"})
    assert response.status_code == 200
    assert json.loads(decrypt_payload(response.json()["encryptedPayload"], SECRET, RESPONSE_AAD))["text"] == "hello"
    assert health.json() == {"status": "ok"}
