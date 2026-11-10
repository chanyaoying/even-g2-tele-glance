"""Request bodies are size-checked, and /api/transcribe authenticated, before anything reads or parses them."""
import json
import time

import httpx
import pytest
import starlette.requests

from app.config import Settings
from app.dependencies import get_telegram_service, get_transcription_service
from app.main import create_app
from app.models import SendMessageResponse, TranscriptionResponse
from app.services.secure_auth import decrypt_payload, encrypt_payload

SECRET = "body-limit-secret-long-enough"


def auth_header():
    payload = {"apiId": "1", "apiHash": "hash", "session": "s", "ts": int(time.time())}
    return encrypt_payload(json.dumps(payload).encode("utf-8"), SECRET)


class RecordingTelegram:
    def __init__(self):
        self.sent = []

    async def send_message(self, chat_id, text, topic_id=None):
        self.sent.append(text)
        return SendMessageResponse(id=1)


class RecordingTranscription:
    def __init__(self):
        self.calls = 0

    async def transcribe_wav(self, raw, language=None):
        self.calls += 1
        return TranscriptionResponse(text="hello")


@pytest.fixture
def form_parses(monkeypatch):
    """Count multipart form parses: an unauthenticated upload must never get that far."""
    calls = []
    original = starlette.requests.Request._get_form

    async def counting(self, *args, **kwargs):
        calls.append(self.url.path)
        return await original(self, *args, **kwargs)

    monkeypatch.setattr(starlette.requests.Request, "_get_form", counting)
    return calls


def make_app(**settings):
    app = create_app(Settings(TELEGLANCE_SHARED_SECRET=SECRET, BACKEND_CORS_ORIGINS=["http://phone.test"], **settings))
    telegram = RecordingTelegram()
    transcription = RecordingTranscription()
    app.dependency_overrides[get_telegram_service] = lambda: telegram
    app.dependency_overrides[get_transcription_service] = lambda: transcription
    return app, telegram, transcription


async def post(app, path, **kwargs):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.post(path, **kwargs)


@pytest.mark.asyncio
async def test_declared_oversize_json_body_is_refused_before_it_is_read():
    app, telegram, _ = make_app(REQUEST_MAX_JSON_BYTES=1024)
    response = await post(
        app,
        "/api/chats/1/messages",
        headers={"X-TeleGlance-Auth": auth_header(), "Origin": "http://phone.test"},
        content=b"x" * 5000,
    )
    assert response.status_code == 413
    assert response.json() == {"detail": "Request body is too large"}
    # CORS sits outside the limit, so the phone can read the status.
    assert response.headers["access-control-allow-origin"] == "http://phone.test"
    assert telegram.sent == []


@pytest.mark.asyncio
async def test_streamed_body_without_content_length_is_cut_off_at_the_limit():
    app, telegram, _ = make_app(REQUEST_MAX_JSON_BYTES=1024)

    async def chunks():
        for _ in range(10):
            yield b"y" * 512

    response = await post(app, "/api/chats/1/messages", headers={"X-TeleGlance-Auth": auth_header()}, content=chunks())
    assert response.status_code == 413
    assert telegram.sent == []


@pytest.mark.asyncio
async def test_small_streamed_body_is_replayed_to_the_app():
    app, telegram, _ = make_app()
    body = json.dumps({"encryptedPayload": encrypt_payload(b'{"text":"hi"}', SECRET)}).encode()

    async def chunks():
        yield body[:10]
        yield body[10:]

    headers = {"X-TeleGlance-Auth": auth_header(), "Content-Type": "application/json"}
    response = await post(app, "/api/chats/1/messages", headers=headers, content=chunks())
    assert response.status_code == 200
    assert telegram.sent == ["hi"]


@pytest.mark.asyncio
async def test_unauthenticated_upload_is_refused_before_the_form_is_parsed(form_parses):
    app, _, transcription = make_app()
    response = await post(app, "/api/transcribe", files={"audio": ("a.pcm", b"\x00" * 100_000, "audio/pcm")})
    assert response.status_code == 400
    assert form_parses == [] and transcription.calls == 0


@pytest.mark.asyncio
async def test_forged_auth_on_upload_is_refused_before_the_form_is_parsed(form_parses):
    app, _, transcription = make_app()
    response = await post(
        app,
        "/api/transcribe",
        headers={"X-TeleGlance-Auth": "v1.AAAAAAAAAAAAAAAA." + "A" * 40},
        files={"audio": ("a.pcm", b"\x00" * 1000, "audio/pcm")},
    )
    assert response.status_code == 401
    assert form_parses == [] and transcription.calls == 0


@pytest.mark.asyncio
async def test_oversize_upload_is_refused_before_auth_or_parsing(form_parses):
    app, _, transcription = make_app(TRANSCRIBE_MAX_UPLOAD_BYTES=1000)
    response = await post(
        app,
        "/api/transcribe",
        headers={"X-TeleGlance-Auth": auth_header()},
        files={"audio": ("a.pcm", b"\x00" * 600_000, "audio/pcm")},
    )
    assert response.status_code == 413
    assert form_parses == [] and transcription.calls == 0


@pytest.mark.asyncio
async def test_authenticated_upload_is_checked_once_and_transcribed(form_parses):
    # The middleware validates the single-use auth nonce; the route must not reject it as replayed.
    app, _, transcription = make_app()
    response = await post(
        app,
        "/api/transcribe",
        headers={"X-TeleGlance-Auth": auth_header()},
        files={"audio": ("a.pcm", b"\x00\x01" * 1000, "audio/pcm")},
    )
    assert response.status_code == 200
    assert json.loads(decrypt_payload(response.json()["encryptedPayload"], SECRET))["text"] == "hello"
    assert form_parses == ["/api/transcribe"] and transcription.calls == 1


@pytest.mark.asyncio
async def test_get_requests_pass_untouched():
    app, _, _ = make_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/health")
    assert response.status_code == 200
