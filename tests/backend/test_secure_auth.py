import json
import time

import httpx
import pytest
from fastapi import HTTPException

import app.dependencies as dependencies
from app.dependencies import get_telegram_service, telegram_credentials_from_encrypted_header
from app.main import create_app
from app.config import Settings
from app.models import PhoneLoginStart
from app.services.secure_auth import decrypt_payload, encrypt_payload


def test_encrypted_payload_round_trip():
    encrypted = encrypt_payload(b'{"hello":"world"}', "shared-secret")

    assert decrypt_payload(encrypted, "shared-secret") == b'{"hello":"world"}'


def test_telegram_credentials_require_encrypted_auth():
    with pytest.raises(HTTPException) as missing_secret:
        telegram_credentials_from_encrypted_header(None, None)
    assert missing_secret.value.status_code == 400

    with pytest.raises(HTTPException) as missing_auth:
        telegram_credentials_from_encrypted_header(None, "shared-secret")
    assert missing_auth.value.status_code == 400


def test_telegram_credentials_decrypt_encrypted_auth():
    payload = {
        "apiId": "12345",
        "apiHash": "abc",
        "session": "session-string",
        "ts": int(time.time()),
    }
    encrypted_auth = encrypt_payload(json.dumps(payload).encode("utf-8"), "shared-secret")

    credentials = telegram_credentials_from_encrypted_header(encrypted_auth, "shared-secret")

    assert credentials is not None
    assert credentials.api_id == 12345
    assert credentials.api_hash == "abc"
    assert credentials.session_string == "session-string"


def test_pending_telegram_services_are_cached_briefly(monkeypatch):
    created = []

    class FakeService:
        def __init__(self, settings, credentials):
            self.settings = settings
            self.credentials = credentials
            created.append(self)

    monkeypatch.setattr(dependencies, "TelethonTelegramService", FakeService)
    dependencies._telegram_services.clear()
    dependencies._pending_telegram_services.clear()
    settings = Settings(TELEGLANCE_SHARED_SECRET="shared-secret", BACKEND_CORS_ORIGINS=[])
    monkeypatch.setattr(dependencies, "get_settings", lambda: settings)

    def header(session=""):
        return encrypt_payload(json.dumps({
            "apiId": "12345",
            "apiHash": "abc",
            "session": session,
            "ts": int(time.time()),
        }).encode("utf-8"), "shared-secret")

    first = dependencies.get_telegram_service(header())
    second = dependencies.get_telegram_service(header())
    authenticated_first = dependencies.get_telegram_service(header("session-a"))
    authenticated_second = dependencies.get_telegram_service(header("session-a"))

    assert first is second
    assert authenticated_first is authenticated_second
    assert len(created) == 2
    dependencies._telegram_services.clear()
    dependencies._pending_telegram_services.clear()


def test_pending_telegram_services_expire(monkeypatch):
    created = []
    now = 1000.0

    class FakeService:
        def __init__(self, settings, credentials):
            self.settings = settings
            self.credentials = credentials
            created.append(self)

    monkeypatch.setattr(dependencies, "TelethonTelegramService", FakeService)
    monkeypatch.setattr(dependencies.time, "monotonic", lambda: now)
    dependencies._telegram_services.clear()
    dependencies._pending_telegram_services.clear()
    settings = Settings(TELEGLANCE_SHARED_SECRET="shared-secret", BACKEND_CORS_ORIGINS=[])
    monkeypatch.setattr(dependencies, "get_settings", lambda: settings)
    encrypted_auth = encrypt_payload(json.dumps({
        "apiId": "12345",
        "apiHash": "abc",
        "session": "",
        "ts": int(time.time()),
    }).encode("utf-8"), "shared-secret")

    first = dependencies.get_telegram_service(encrypted_auth)
    now += dependencies.PENDING_TELEGRAM_SERVICE_TTL_SECONDS + 1
    second = dependencies.get_telegram_service(encrypted_auth)

    assert first is not second
    assert len(created) == 2
    dependencies._telegram_services.clear()
    dependencies._pending_telegram_services.clear()


@pytest.mark.asyncio
async def test_encrypted_json_request_body_is_decrypted_before_validation():
    app = create_app(Settings(TELEGLANCE_SHARED_SECRET="shared-secret", BACKEND_CORS_ORIGINS=[]))
    seen_phone = {}

    class PhoneLoginService:
        async def start_phone_login(self, phone):
            seen_phone["value"] = phone
            return PhoneLoginStart(
                phone=phone,
                sent=True,
                message="Verification code sent.",
                phone_code_hash="hash-from-telegram",
            )

    app.dependency_overrides[get_telegram_service] = lambda: PhoneLoginService()
    encrypted_auth = encrypt_payload(json.dumps({
        "apiId": "12345",
        "apiHash": "abc",
        "session": "",
        "ts": int(time.time()),
    }).encode("utf-8"), "shared-secret")
    encrypted_body = encrypt_payload(b'{"phone":"+14155552671"}', "shared-secret")
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/session/phone/start",
            headers={
                "Content-Type": "application/json",
                "X-TeleGlance-Auth": encrypted_auth,
            },
            json={"encryptedPayload": encrypted_body},
        )

    assert response.status_code == 200
    assert response.headers["X-TeleGlance-Encrypted"] == "1"
    decrypted = decrypt_payload(response.json()["encryptedPayload"], "shared-secret")
    assert json.loads(decrypted) == {
        "phone": "+14155552671",
        "sent": True,
        "message": "Verification code sent.",
        "phoneCodeHash": "hash-from-telegram",
    }
    assert seen_phone == {"value": "+14155552671"}


@pytest.mark.asyncio
async def test_encrypted_phone_verify_passes_phone_code_hash_to_service():
    app = create_app(Settings(TELEGLANCE_SHARED_SECRET="shared-secret", BACKEND_CORS_ORIGINS=[]))
    seen = {}

    class PhoneLoginService:
        async def complete_phone_login(self, phone, code, phone_code_hash=None, password=None):
            seen.update({
                "phone": phone,
                "code": code,
                "phone_code_hash": phone_code_hash,
            })
            return {"authorized": True, "sessionString": "session-string"}

    app.dependency_overrides[get_telegram_service] = lambda: PhoneLoginService()
    encrypted_auth = encrypt_payload(json.dumps({
        "apiId": "12345",
        "apiHash": "abc",
        "session": "",
        "ts": int(time.time()),
    }).encode("utf-8"), "shared-secret")
    encrypted_body = encrypt_payload(
        b'{"phone":"+14155552671","code":"12345","phoneCodeHash":"hash-from-start"}',
        "shared-secret",
    )
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/session/phone/verify",
            headers={
                "Content-Type": "application/json",
                "X-TeleGlance-Auth": encrypted_auth,
            },
            json={"encryptedPayload": encrypted_body},
        )

    assert response.status_code == 200
    assert seen == {
        "phone": "+14155552671",
        "code": "12345",
        "phone_code_hash": "hash-from-start",
    }
