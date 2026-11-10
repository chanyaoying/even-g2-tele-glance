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
