"""Regression tests for the security audit (run-1) fixes."""
import json
import time

import httpx
import pytest

import app.dependencies as dependencies
import app.services.secure_auth as secure_auth
from app.config import Settings, get_settings
from app.dependencies import get_telegram_service, get_transcription_service
from app.main import create_app
from app.models import PhoneLoginStatus, SendMessageResponse
from app.services.secure_auth import encrypt_payload

SECRET = "shared-secret"


def auth_header(session: str = "session-string", api_hash: str = "abc") -> str:
    payload = {"apiId": "12345", "apiHash": api_hash, "session": session, "ts": int(time.time())}
    return encrypt_payload(json.dumps(payload).encode("utf-8"), SECRET)


def envelope(payload: dict) -> bytes:
    return json.dumps({"encryptedPayload": encrypt_payload(json.dumps(payload).encode("utf-8"), SECRET)}).encode()


class RecordingTelegram:
    def __init__(self):
        self.sent = []

    async def send_message(self, chat_id, text, topic_id=None):
        self.sent.append((chat_id, text, topic_id))
        return SendMessageResponse(id=1)


class NoTranscription:
    payloads = []

    async def transcribe_wav(self, raw, language=None):  # pragma: no cover - must not be reached
        self.payloads.append(raw)
        raise AssertionError("transcription must not run")


@pytest.mark.asyncio
async def test_default_app_transcribe_enforces_upload_cap(monkeypatch):
    """create_app() with no explicit Settings (how uvicorn serves it) must use the resolved settings."""
    monkeypatch.setenv("TELEGLANCE_SHARED_SECRET", SECRET)
    monkeypatch.setenv("TRANSCRIBE_MAX_UPLOAD_BYTES", "3")
    get_settings.cache_clear()
    try:
        app = create_app()
    finally:
        get_settings.cache_clear()
    app.dependency_overrides[get_transcription_service] = lambda: NoTranscription()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/transcribe",
            headers={"X-TeleGlance-Auth": auth_header()},
            files={"audio": ("sample.pcm", b"\x00\x00\xff\x7f\x00\x00", "audio/pcm")},
        )
    assert response.status_code == 413


@pytest.mark.asyncio
@pytest.mark.parametrize("content_type", ["Application/JSON", "application/merge-patch+json", "text/plain", "application/json; charset=utf-8", None])
async def test_plaintext_body_is_rejected_whatever_the_content_type(content_type):
    telegram = RecordingTelegram()
    app = create_app(Settings(TELEGLANCE_SHARED_SECRET=SECRET, BACKEND_CORS_ORIGINS=[]))
    app.dependency_overrides[get_telegram_service] = lambda: telegram
    headers = {"X-TeleGlance-Auth": auth_header()}
    if content_type:
        headers["Content-Type"] = content_type
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/api/chats/42/messages", headers=headers, content=b'{"text":"ATTACKER-CHOSEN-TEXT"}')
    assert response.status_code == 400
    assert telegram.sent == []


@pytest.mark.asyncio
@pytest.mark.parametrize("content_type", ["application/json", "Application/JSON"])
async def test_encrypted_body_is_accepted_whatever_the_content_type_spelling(content_type):
    telegram = RecordingTelegram()
    app = create_app(Settings(TELEGLANCE_SHARED_SECRET=SECRET, BACKEND_CORS_ORIGINS=[]))
    app.dependency_overrides[get_telegram_service] = lambda: telegram
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/chats/42/messages",
            headers={"X-TeleGlance-Auth": auth_header(), "Content-Type": content_type},
            content=envelope({"text": "legit"}),
        )
    assert response.status_code == 200
    assert telegram.sent == [(42, "legit", None)]


def test_derived_key_is_cached_per_secret():
    secure_auth._derive_key.cache_clear()
    first = secure_auth._derive_key("a-secret")
    hits_before = secure_auth._derive_key.cache_info().hits
    second = secure_auth._derive_key("a-secret")
    assert first == second
    assert secure_auth._derive_key.cache_info().hits == hits_before + 1


def test_unvalidated_nonces_are_not_remembered():
    secure_auth._seen_nonces.clear()
    forged = "v1.AAAAAAAAAAAAAAAA." + "A" * 40  # 12-byte nonce, ciphertext that cannot decrypt
    with pytest.raises(secure_auth.SecureAuthError):
        secure_auth.decrypt_auth_header(forged, SECRET)
    assert secure_auth._seen_nonces == {}


def test_valid_header_cannot_be_replayed():
    secure_auth._seen_nonces.clear()
    header = auth_header()
    secure_auth.decrypt_auth_header(header, SECRET)
    with pytest.raises(secure_auth.SecureAuthError, match="already used"):
        secure_auth.decrypt_auth_header(header, SECRET)


@pytest.mark.asyncio
async def test_completed_phone_login_is_not_reachable_by_the_next_caller(monkeypatch):
    created = []

    class FakeService:
        def __init__(self, settings, credentials):
            self.authorized = False
            self.closed = False
            created.append(self)

        async def complete_phone_login(self, phone, code, phone_code_hash=None, password=None):
            if self.authorized:
                return PhoneLoginStatus(authorized=True, session_string="SESSION-OF-USER-A")
            self.authorized = True
            return PhoneLoginStatus(authorized=True, session_string="SESSION-OF-USER-A")

        async def close(self):
            self.closed = True

    monkeypatch.setattr(dependencies, "TelethonTelegramService", FakeService)
    dependencies._telegram_services.clear()
    dependencies._pending_telegram_services.clear()
    get_settings.cache_clear()
    monkeypatch.setenv("TELEGLANCE_SHARED_SECRET", SECRET)
    app = create_app(Settings(TELEGLANCE_SHARED_SECRET=SECRET, BACKEND_CORS_ORIGINS=[]))
    get_settings.cache_clear()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        first = await client.post(
            "/api/session/phone/verify",
            headers={"X-TeleGlance-Auth": auth_header(session=""), "Content-Type": "application/json"},
            content=envelope({"phone": "+15550000001", "code": "12345"}),
        )
        assert first.status_code == 200
    assert dependencies._pending_telegram_services == {}
    assert created[0].closed is True
    # A later caller with the same api_id/api_hash gets a different (fresh) service object.
    service_for_b = dependencies.get_pending_telegram_service(
        Settings(TELEGLANCE_SHARED_SECRET=SECRET),
        dependencies.TelegramClientCredentials(api_id=12345, api_hash="abc", session_string=None),
    )
    assert service_for_b is not created[0]
    assert service_for_b.authorized is False


# ---- hardening follow-ups ----
import io
import logging
import wave

from pydantic import ValidationError

from app.services.transcription import TranscriptionServiceError, WhisperTranscriptionService


@pytest.mark.parametrize("placeholder", ["<enter-secret-token>", "my-secret-token", "changeme", "<anything>"])
def test_placeholder_shared_secret_is_refused(placeholder):
    with pytest.raises(ValidationError, match="placeholder"):
        Settings(TELEGLANCE_SHARED_SECRET=placeholder)


def test_short_shared_secret_warns_but_starts(caplog):
    with caplog.at_level(logging.WARNING, logger="app.config"):
        Settings(TELEGLANCE_SHARED_SECRET="short-secret")
    assert "shorter than 16" in caplog.text


def test_strong_shared_secret_is_accepted_silently(caplog):
    with caplog.at_level(logging.WARNING, logger="app.config"):
        Settings(TELEGLANCE_SHARED_SECRET="x" * 40)
    assert caplog.text == ""


@pytest.mark.asyncio
async def test_non_wav_bytes_never_reach_the_decoder():
    service = WhisperTranscriptionService(settings=Settings())
    service._load_model = lambda: (_ for _ in ()).throw(AssertionError("decoder must not be reached"))
    playlist = b"#EXTM3U\n#EXT-X-VERSION:3\nhttp://169.254.169.254/latest/meta-data\n" * 60
    with pytest.raises(TranscriptionServiceError, match="RIFF/WAVE"):
        await service.transcribe_wav(playlist)


@pytest.mark.asyncio
async def test_transcription_runs_off_the_event_loop_and_passes_model_revision(monkeypatch):
    import threading, types, math, struct
    loop_thread = threading.get_ident()
    seen = {}

    class FakeModel:
        def transcribe(self, path, **kwargs):
            seen["thread"] = threading.get_ident()
            return [types.SimpleNamespace(text=" hello ")], types.SimpleNamespace(language="en", duration=0.5)

    service = WhisperTranscriptionService(settings=Settings(WHISPER_MODEL_REVISION="abc123"))
    service._model = FakeModel()
    pcm = b"".join(struct.pack("<h", int(8192 * math.sin(2 * math.pi * 500 * i / 16000))) for i in range(8000))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(pcm)
    result = await service.transcribe_wav(buf.getvalue())
    assert result.text == "hello"
    assert seen["thread"] != loop_thread
    assert service.settings.whisper_model_revision == "abc123"
