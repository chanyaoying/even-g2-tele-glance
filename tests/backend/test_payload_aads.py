"""Proto 2 (`X-TeleGlance-Proto: 2`): distinct AES-GCM AADs for request bodies and responses; proto 1 unchanged."""
import json
import time

import httpx
import pytest

from app.config import Settings
from app.dependencies import get_telegram_service
from app.main import create_app
from app.models import SendMessageResponse, TelegramUpdate, MessageSummary
from app.services import secure_auth
from app.services.secure_auth import AUTH_AAD, REQUEST_AAD, RESPONSE_AAD, SecureAuthError, decrypt_payload, encrypt_payload

SECRET = "aad-secret-long-enough-for-tests"
PROTO2 = {"X-TeleGlance-Proto": "2"}


def auth_header(aad=AUTH_AAD):
    payload = {"apiId": "1", "apiHash": "hash", "session": "s", "ts": int(time.time())}
    return encrypt_payload(json.dumps(payload).encode("utf-8"), SECRET, aad)


def envelope(payload, aad):
    return json.dumps({"encryptedPayload": encrypt_payload(json.dumps(payload).encode("utf-8"), SECRET, aad)}).encode()


class Telegram:
    def __init__(self):
        self.sent = []

    async def send_message(self, chat_id, text, topic_id=None):
        self.sent.append(text)
        return SendMessageResponse(id=7)

    async def update_events(self):
        yield TelegramUpdate(chat_id=1, message=MessageSummary(id=3, sender="a", text="hi"))


@pytest.fixture
def app_and_telegram():
    telegram = Telegram()
    app = create_app(Settings(TELEGLANCE_SHARED_SECRET=SECRET, BACKEND_CORS_ORIGINS=["http://phone.test"]))
    app.dependency_overrides[get_telegram_service] = lambda: telegram
    return app, telegram


async def send(app, body, extra_headers=None):
    headers = {"X-TeleGlance-Auth": auth_header(), "Content-Type": "application/json", **(extra_headers or {})}
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.post("/api/chats/1/messages", headers=headers, content=body)


@pytest.mark.asyncio
async def test_proto2_round_trip_uses_request_and_response_aads(app_and_telegram):
    app, telegram = app_and_telegram
    response = await send(app, envelope({"text": "hello"}, REQUEST_AAD), PROTO2)
    assert response.status_code == 200
    assert telegram.sent == ["hello"]
    encrypted = response.json()["encryptedPayload"]
    assert json.loads(decrypt_payload(encrypted, SECRET, RESPONSE_AAD))["id"] == 7
    with pytest.raises(SecureAuthError):
        decrypt_payload(encrypted, SECRET, AUTH_AAD)


@pytest.mark.asyncio
@pytest.mark.parametrize("wrong_aad", [AUTH_AAD, RESPONSE_AAD])
async def test_proto2_refuses_a_body_sealed_for_another_purpose(app_and_telegram, wrong_aad):
    app, telegram = app_and_telegram
    response = await send(app, envelope({"text": "replayed"}, wrong_aad), PROTO2)
    assert response.status_code == 400
    assert telegram.sent == []


@pytest.mark.asyncio
async def test_proto1_is_unchanged(app_and_telegram):
    app, telegram = app_and_telegram
    response = await send(app, envelope({"text": "legacy"}, AUTH_AAD))
    assert response.status_code == 200
    assert telegram.sent == ["legacy"]
    assert json.loads(decrypt_payload(response.json()["encryptedPayload"], SECRET, AUTH_AAD))["id"] == 7


@pytest.mark.asyncio
async def test_proto1_does_not_accept_a_proto2_body(app_and_telegram):
    app, telegram = app_and_telegram
    response = await send(app, envelope({"text": "x"}, REQUEST_AAD))
    assert response.status_code == 400
    assert telegram.sent == []


@pytest.mark.asyncio
@pytest.mark.parametrize("headers, aad", [(PROTO2, RESPONSE_AAD), ({}, AUTH_AAD)])
async def test_stream_events_are_sealed_with_the_response_aad_under_proto2(app_and_telegram, headers, aad):
    app, _ = app_and_telegram
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/updates", headers={"X-TeleGlance-Auth": auth_header(), **headers})
    data_line = next(line for line in response.text.splitlines() if line.startswith("data: "))
    encrypted = json.loads(data_line[len("data: "):])["encryptedPayload"]
    assert json.loads(decrypt_payload(encrypted, SECRET, aad))["message"]["id"] == 3


def test_auth_header_always_uses_the_auth_aad():
    secure_auth._seen_nonces.clear()
    assert secure_auth.decrypt_auth_header(auth_header(AUTH_AAD), SECRET)["apiId"] == "1"
    for aad in (REQUEST_AAD, RESPONSE_AAD):
        with pytest.raises(SecureAuthError):
            secure_auth.decrypt_auth_header(auth_header(aad), SECRET)


@pytest.mark.asyncio
async def test_preflight_allows_the_proto_header(app_and_telegram):
    app, _ = app_and_telegram
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.options(
            "/api/chats/1/messages",
            headers={
                "Origin": "http://phone.test",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "x-teleglance-auth, x-teleglance-proto, content-type",
            },
        )
    assert response.status_code == 200
    assert "x-teleglance-proto" in response.headers["access-control-allow-headers"].lower()
