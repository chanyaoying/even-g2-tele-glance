from datetime import datetime, timezone
import json
import time

import httpx
import pytest

from app.config import Settings
from app.dependencies import get_telegram_service, get_transcription_service
from app.main import create_app
from app.models import (
    ChatSummary,
    FolderSummary,
    MessageSummary,
    PhoneLoginStart,
    SendMessageResponse,
    TelegramUpdate,
    TopicSummary,
    TranscriptionResponse,
)
from app.services.telegram import TelegramServiceTimeoutError
from app.services.secure_auth import decrypt_payload, encrypt_payload


class FakeTelegramService:
    def __init__(self):
        self.sent = []
        self.message_calls = []
        self.read = []

    async def auth_status(self):
        return {"configured": False, "authorized": False}

    async def start_phone_login(self, phone):
        return PhoneLoginStart(phone=phone, sent=True, message="Verification code sent.")

    async def complete_phone_login(self, phone, code, phone_code_hash=None, password=None):
        return {"authorized": False, "message": None, "sessionString": None}

    async def logout(self):
        return None

    async def list_chats(self, limit, offset=0, folder_id=None):
        self.chat_calls = getattr(self, "chat_calls", [])
        self.chat_calls.append({"limit": limit, "offset": offset, "folder_id": folder_id})
        return [
            ChatSummary(id=1, title="Ada", kind="user", last_message="hello"),
            ChatSummary(id=2, title="Project", kind="group", is_forum=True),
        ][offset:offset + limit]

    async def list_folders(self):
        return [FolderSummary(id=2, title="Work"), FolderSummary(id=3, title="Family")]

    async def list_topics(self, chat_id):
        assert chat_id == 2
        return [TopicSummary(id=11, title="Build", top_message_id=101, unread_count=2)]

    async def list_messages(self, chat_id, *, topic_id=None, before_id=None, limit=8):
        self.message_calls.append(
            {"chat_id": chat_id, "topic_id": topic_id, "before_id": before_id, "limit": limit}
        )
        return [
            MessageSummary(
                id=8,
                sender="Ada",
                text="Latest",
                sent_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            )
        ]

    async def send_message(self, chat_id, *, text, topic_id=None):
        self.sent.append({"chat_id": chat_id, "text": text, "topic_id": topic_id})
        return SendMessageResponse(id=55)

    async def mark_read(self, chat_id, *, topic_id=None, max_id=None):
        self.read.append({"chat_id": chat_id, "topic_id": topic_id, "max_id": max_id})

    async def update_events(self):
        yield TelegramUpdate(
            chat_id=1,
            message=MessageSummary(
                id=9,
                sender="Ada",
                text="Streamed",
                sent_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            ),
        )


class FakeTranscriptionService:
    def __init__(self):
        self.payloads = []
        self.languages = []

    async def transcribe_wav(self, wav_bytes, language=None):
        self.payloads.append(wav_bytes)
        self.languages.append(language)
        return TranscriptionResponse(text="send the update", language=language or "en", duration_seconds=0.5)


class TimeoutTelegramService(FakeTelegramService):
    async def auth_status(self):
        raise TelegramServiceTimeoutError("Telegram request timed out. Please retry.")

    async def list_chats(self, limit, offset=0, folder_id=None):
        raise TelegramServiceTimeoutError("Telegram request timed out. Please retry.")


@pytest.fixture
def fake_services():
    return FakeTelegramService(), FakeTranscriptionService()


@pytest.fixture
def app(fake_services):
    telegram, transcription = fake_services
    app = create_app()
    app.dependency_overrides[get_telegram_service] = lambda: telegram
    app.dependency_overrides[get_transcription_service] = lambda: transcription
    return app


@pytest.mark.asyncio
async def test_auth_status_without_session(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/session/status")

    assert response.status_code == 200
    assert response.json() == {
        "configured": False,
        "authorized": False,
    }


@pytest.mark.asyncio
async def test_telegram_timeout_returns_gateway_timeout(fake_services):
    _, transcription = fake_services
    app = create_app()
    app.dependency_overrides[get_telegram_service] = lambda: TimeoutTelegramService()
    app.dependency_overrides[get_transcription_service] = lambda: transcription
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        auth = await client.get("/api/session/status")
        chats = await client.get("/api/chats?limit=5")

    assert auth.status_code == 504
    assert chats.status_code == 504
    assert auth.json() == {"detail": "Telegram request timed out. Please retry."}
    assert chats.json() == {"detail": "Telegram request timed out. Please retry."}


@pytest.mark.asyncio
async def test_chat_topic_and_message_endpoints(app, fake_services):
    telegram, _ = fake_services
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        chats = await client.get("/api/chats?limit=5")
        topics = await client.get("/api/chats/2/topics")
        messages = await client.get("/api/chats/2/messages?topic_id=101&before_id=99&limit=3")

    assert chats.status_code == 200
    assert chats.json()[1]["isForum"] is True
    assert topics.json() == [{"id": 11, "title": "Build", "topMessageId": 101, "unreadCount": 2, "lastMessage": None}]
    assert messages.json()[0]["text"] == "Latest"
    assert telegram.message_calls == [
        {"chat_id": 2, "topic_id": 101, "before_id": 99, "limit": 3}
    ]


@pytest.mark.asyncio
async def test_chats_support_offset_folder_and_folders_endpoint(app, fake_services):
    telegram, _ = fake_services
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        second_page = await client.get("/api/chats?limit=1&offset=1&folder_id=3")
        folders = await client.get("/api/folders")
        bad_offset = await client.get("/api/chats?limit=5&offset=-1")
        bad_folder = await client.get("/api/chats?limit=5&folder_id=0")

    assert [chat["title"] for chat in second_page.json()] == ["Project"]
    assert telegram.chat_calls[-1] == {"limit": 1, "offset": 1, "folder_id": 3}
    assert folders.json() == [{"id": 2, "title": "Work"}, {"id": 3, "title": "Family"}]
    assert bad_offset.status_code == 422
    assert bad_folder.status_code == 422


@pytest.mark.asyncio
async def test_debug_events_require_encrypted_auth(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/debug/events",
            json={"source": "even-hub", "buildVersion": "test", "raw": {"eventType": 0}, "mapped": None},
        )

    assert response.status_code == 400


@pytest.mark.asyncio
async def test_debug_events_accept_null_mapped_input(fake_services):
    app = secure_test_app(fake_services)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/debug/events",
            headers=auth_headers(json_body=True),
            json=encrypted_json_body({"source": "even-hub", "buildVersion": "test", "raw": {"eventType": 0}, "mapped": None}),
        )
        events = await client.get("/api/debug/events")

    assert response.status_code == 200
    assert decrypted_json(response) == {"count": 1}
    assert events.status_code == 400

    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        events = await client.get("/api/debug/events", headers=auth_headers())

    assert decrypted_json(events)[0]["mapped"] is None


@pytest.mark.asyncio
async def test_debug_events_skip_audio_chunks(fake_services):
    app = secure_test_app(fake_services)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/debug/events",
            headers=auth_headers(json_body=True),
            json=encrypted_json_body({"source": "even-hub", "buildVersion": "test", "raw": {}, "mapped": {"type": "audioChunk"}}),
        )
        events = await client.get("/api/debug/events", headers=auth_headers())

    assert response.status_code == 200
    assert decrypted_json(response) == {"count": 0}
    assert decrypted_json(events) == []


@pytest.mark.asyncio
async def test_updates_stream_emits_sse_message(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/updates")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert "event: message" in response.text
    assert '"chatId":1' in response.text
    assert '"text":"Streamed"' in response.text


@pytest.mark.asyncio
async def test_send_payload_generation_for_normal_and_topic_chats(app, fake_services):
    telegram, _ = fake_services
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        normal = await client.post("/api/chats/1/messages", json={"text": "hi"})
        topic = await client.post("/api/chats/2/messages", json={"text": "ship it", "topic_id": 101})

    assert normal.json() == {"id": 55, "status": "sent"}
    assert topic.json() == {"id": 55, "status": "sent"}
    assert telegram.sent == [
        {"chat_id": 1, "text": "hi", "topic_id": None},
        {"chat_id": 2, "text": "ship it", "topic_id": 101},
    ]


@pytest.mark.asyncio
async def test_mark_read_payload_generation_for_normal_and_topic_chats(app, fake_services):
    telegram, _ = fake_services
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        normal = await client.post("/api/chats/1/read", json={"maxId": 8})
        topic = await client.post("/api/chats/2/read", json={"topicId": 11, "maxId": 9})

    assert normal.json() == {"status": "ok"}
    assert topic.json() == {"status": "ok"}
    assert telegram.read == [
        {"chat_id": 1, "topic_id": None, "max_id": 8},
        {"chat_id": 2, "topic_id": 11, "max_id": 9},
    ]


@pytest.mark.asyncio
async def test_transcribe_requires_encrypted_auth(app, fake_services):
    _, transcription = fake_services
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/transcribe",
            files={"audio": ("sample.pcm", b"\x00\x00\xff\x7f", "audio/pcm")},
        )

    assert response.status_code == 400
    assert transcription.payloads == []


@pytest.mark.asyncio
async def test_transcribe_wraps_pcm_upload_as_wav(fake_services):
    _, transcription = fake_services
    app = secure_test_app(fake_services)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/transcribe",
            headers=auth_headers(),
            files={"audio": ("sample.pcm", b"\x00\x00\xff\x7f", "audio/pcm")},
        )

    assert response.status_code == 200
    assert decrypted_json(response)["text"] == "send the update"
    assert transcription.payloads[0].startswith(b"RIFF")


@pytest.mark.asyncio
async def test_transcribe_forwards_language(fake_services):
    _, transcription = fake_services
    app = secure_test_app(fake_services)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/transcribe",
            headers=auth_headers(),
            data={"language": "es"},
            files={"audio": ("sample.pcm", b"\x00\x00\xff\x7f", "audio/pcm")},
        )

    assert response.status_code == 200
    assert decrypted_json(response)["language"] == "es"
    assert transcription.languages == ["es"]


@pytest.mark.asyncio
async def test_transcribe_rejects_oversize_upload(fake_services):
    _, transcription = fake_services
    app = create_app(
        Settings(
            TELEGLANCE_SHARED_SECRET="shared-secret",
            BACKEND_CORS_ORIGINS=[],
            TRANSCRIBE_MAX_UPLOAD_BYTES=3,
        )
    )
    app.dependency_overrides[get_telegram_service] = lambda: fake_services[0]
    app.dependency_overrides[get_transcription_service] = lambda: transcription
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/transcribe",
            headers=auth_headers(),
            files={"audio": ("sample.pcm", b"\x00\x00\xff\x7f", "audio/pcm")},
        )

    assert response.status_code == 413
    assert transcription.payloads == []


def secure_test_app(fake_services):
    telegram, transcription = fake_services
    app = create_app(Settings(TELEGLANCE_SHARED_SECRET="shared-secret", BACKEND_CORS_ORIGINS=[]))
    app.dependency_overrides[get_telegram_service] = lambda: telegram
    app.dependency_overrides[get_transcription_service] = lambda: transcription
    return app


def auth_headers(json_body: bool = False):
    headers = {
        "X-TeleGlance-Auth": encrypt_payload(json.dumps({
            "apiId": "12345",
            "apiHash": "abc",
            "session": "session-string",
            "ts": int(time.time()),
        }).encode("utf-8"), "shared-secret"),
    }
    if json_body:
        headers["Content-Type"] = "application/json"
    return headers


def encrypted_json_body(payload):
    return {"encryptedPayload": encrypt_payload(json.dumps(payload).encode("utf-8"), "shared-secret")}


def decrypted_json(response):
    encrypted = response.json()["encryptedPayload"]
    return json.loads(decrypt_payload(encrypted, "shared-secret"))
