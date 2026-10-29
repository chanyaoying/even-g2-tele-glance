import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from app.config import Settings
from app.services.telegram import TelegramClientCredentials, TelethonTelegramService, normalize_chat_action, normalize_dialog, normalize_message, normalize_topic


@dataclass
class Entity:
    id: int
    title: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    username: Optional[str] = None
    forum: bool = False
    broadcast: bool = False
    bot: bool = False


@dataclass
class Dialog:
    entity: Entity
    unread_count: int
    message: object


@dataclass
class Message:
    id: int
    message: str
    date: datetime
    out: bool = False
    sender: Optional[Entity] = None
    from_id: object = None


@dataclass
class RawTextMessage:
    id: int
    message: str
    raw_text: str
    date: datetime
    out: bool = False
    sender: Optional[Entity] = None
    from_id: object = None


@dataclass
class RichMessage:
    id: int
    message: str
    raw_text: str
    date: datetime
    media: object = None
    action: object = None
    out: bool = False
    sender: Optional[Entity] = None
    from_id: object = None


@dataclass
class PeerUser:
    user_id: int


@dataclass
class Topic:
    id: int
    title: str
    top_message: int
    unread_count: int = 0


@dataclass
class ActionMessage:
    action: object
    reply_to: object = None


@dataclass
class TypingEvent:
    chat_id: int
    user: Optional[Entity] = None
    user_id: Optional[int] = None
    action_message: Optional[ActionMessage] = None
    action: object = None
    typing: bool = False


@dataclass
class ReplyTo:
    reply_to_msg_id: int


class SendMessageTypingAction:
    pass


class SendMessageCancelAction:
    pass


def test_normalize_dialog_from_user_entity():
    dialog = Dialog(
        entity=Entity(id=42, first_name="Ada", last_name="Lovelace"),
        unread_count=3,
        message=Message(id=9, message="Last note", date=datetime.now(timezone.utc)),
    )

    chat = normalize_dialog(dialog)

    assert chat.id == 42
    assert chat.title == "Ada Lovelace"
    assert chat.kind == "user"
    assert chat.unread_count == 3
    assert chat.last_message == "Last note"


def test_normalize_forum_group_and_topic():
    dialog = Dialog(
        entity=Entity(id=100, title="Core Team", forum=True),
        unread_count=0,
        message=None,
    )

    chat = normalize_dialog(dialog)
    topic = normalize_topic(Topic(id=7, title="Release", top_message=77, unread_count=1))

    assert chat.kind == "group"
    assert chat.is_forum is True
    assert topic.top_message_id == 77


def test_normalize_message_sender_and_outgoing_flag():
    message = Message(
        id=12,
        sender=Entity(id=1, username="owner"),
        message="On it",
        date=datetime(2026, 1, 1, tzinfo=timezone.utc),
        out=True,
    )

    normalized = normalize_message(message)

    assert normalized.id == 12
    assert normalized.sender == "@owner"
    assert normalized.text == "On it"
    assert normalized.outgoing is True


def test_normalize_message_sender_from_result_entities_when_sender_is_missing():
    message = Message(
        id=13,
        from_id=PeerUser(user_id=2),
        sender=None,
        message="Reply from bundled user",
        date=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )

    normalized = normalize_message(message, {2: Entity(id=2, first_name="Lin")})

    assert normalized.sender == "Lin"


def test_normalize_message_uses_raw_text_when_message_body_is_empty():
    message = RawTextMessage(
        id=14,
        message="",
        raw_text="Raw text fallback",
        date=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )

    normalized = normalize_message(message)

    assert normalized.text == "Raw text fallback"


def test_normalize_message_appends_unsupported_marker_to_readable_media_caption():
    message = RichMessage(
        id=15,
        message="Readable caption",
        raw_text="Readable caption",
        media=object(),
        date=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )

    normalized = normalize_message(message)

    assert normalized.text == "Readable caption [unsupported content]"


def test_normalize_message_shows_unsupported_marker_when_media_has_no_text():
    message = RichMessage(
        id=16,
        message="",
        raw_text="",
        media=object(),
        date=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )

    normalized = normalize_message(message)

    assert normalized.text == "[unsupported content]"


def test_normalize_typing_from_chat_action_event():
    event = TypingEvent(
        chat_id=123,
        user=Entity(id=5, first_name="Ada"),
        action_message=ActionMessage(
            action=SendMessageTypingAction(),
            reply_to=ReplyTo(reply_to_msg_id=77),
        ),
    )

    update = normalize_chat_action(event)

    assert update is not None
    assert update.chat_id == 123
    assert update.topic_id == 77
    assert update.user_name == "Ada"
    assert update.action == "typing"


def test_normalize_typing_from_user_update_event_without_name():
    event = TypingEvent(
        chat_id=123,
        user_id=42,
        action=SendMessageTypingAction(),
    )

    update = normalize_chat_action(event)

    assert update is not None
    assert update.chat_id == 123
    assert update.user_name == "User 42"
    assert update.action == "typing"


def test_normalize_typing_uses_resolved_user_override():
    event = TypingEvent(
        chat_id=123,
        user_id=42,
        action=SendMessageTypingAction(),
    )

    update = normalize_chat_action(event, Entity(id=42, first_name="Akira"))

    assert update is not None
    assert update.user_name == "Akira"


def test_normalize_typing_uses_cached_name_string_override():
    event = TypingEvent(
        chat_id=123,
        user_id=42,
        action=SendMessageTypingAction(),
    )

    update = normalize_chat_action(event, "Akira")

    assert update is not None
    assert update.user_name == "Akira"


def test_handle_chat_action_does_not_wait_for_async_user_lookup():
    class SlowTypingEvent(TypingEvent):
        async def get_user(self):
            await asyncio.sleep(60)
            return Entity(id=42, first_name="Too Late")

    service = TelethonTelegramService(settings=Settings())
    queue: asyncio.Queue = asyncio.Queue()
    service._update_queues.add(queue)
    event = SlowTypingEvent(chat_id=123, user_id=42, action=SendMessageTypingAction())

    asyncio.run(asyncio.wait_for(service._handle_chat_action(event), timeout=0.1))

    update = queue.get_nowait()
    assert update.chat_id == 123
    assert update.user_name == "User 42"
    assert update.action == "typing"


def test_normalize_typing_cancel_from_user_update_event():
    event = TypingEvent(
        chat_id=123,
        user=Entity(id=5, username="ada"),
        action=SendMessageCancelAction(),
    )

    update = normalize_chat_action(event)

    assert update is not None
    assert update.user_name == "ada"
    assert update.action == "cancel"


def test_phone_login_requests_then_uses_two_step_password():
    class SessionPasswordNeededError(Exception):
        pass

    class FakeClient:
        def __init__(self):
            self.calls = []

        async def is_user_authorized(self):
            return bool(self.calls and "password" in self.calls[-1])

        async def sign_in(self, **kwargs):
            self.calls.append(kwargs)
            if "password" not in kwargs:
                raise SessionPasswordNeededError()

    service = TelethonTelegramService(
        settings=Settings(),
        credentials=TelegramClientCredentials(api_id=1, api_hash="hash"),
    )
    client = FakeClient()

    async def fake_get_client():
        return client

    service._get_client = fake_get_client  # type: ignore[method-assign]

    async def scenario():
        first = await service.complete_phone_login("+15555550100", "12345", "h")
        assert first.authorized is False and first.password_required is True

        second = await service.complete_phone_login("+15555550100", "", None, "secret")
        assert client.calls[-1] == {"password": "secret"}
        assert second.password_required is False

    asyncio.run(scenario())


class MessageMediaPhoto:
    """Stand-in with the same class name Telethon uses for a real photo attachment."""


class MessageMediaWebPage:
    pass


def test_photo_messages_are_flagged_and_keep_a_text_fallback():
    captioned = RichMessage(id=30, message="Look", raw_text="Look", media=MessageMediaPhoto(), date=datetime(2026, 1, 1, tzinfo=timezone.utc))
    bare = RichMessage(id=31, message="", raw_text="", media=MessageMediaPhoto(), date=datetime(2026, 1, 1, tzinfo=timezone.utc))

    assert normalize_message(captioned).media == "photo"
    assert normalize_message(captioned).text == "Look [photo]"
    assert normalize_message(bare).text == "[photo]"


def test_link_previews_and_other_media_are_not_treated_as_photos():
    preview = RichMessage(id=32, message="see this", raw_text="see this", media=MessageMediaWebPage(), date=datetime(2026, 1, 1, tzinfo=timezone.utc))

    normalized = normalize_message(preview)

    assert normalized.media is None
    assert normalized.text == "see this [unsupported content]"


class _PhotoClient:
    def __init__(self, message, payload):
        self.message = message
        self.payload = payload
        self.downloads = 0

    async def get_messages(self, entity, ids=None):
        return self.message

    async def download_media(self, message, file=None, thumb=None):
        self.downloads += 1
        assert thumb == -1
        return self.payload


def _photo_service(client):
    service = TelethonTelegramService(
        Settings(TELEGLANCE_SHARED_SECRET="test-secret-long-enough"),
        TelegramClientCredentials(api_id=1, api_hash="hash", session_string="s"),
    )

    async def get_client():
        return client

    async def get_entity(chat_id):
        return object()

    service._get_client = get_client
    service._get_entity = get_entity
    return service


def test_get_photo_downloads_converts_and_caches():
    pil = __import__("pytest").importorskip("PIL.Image")
    import base64, io

    buffer = io.BytesIO()
    pil.new("RGB", (800, 400), (200, 40, 40)).save(buffer, format="JPEG")
    message = RichMessage(id=40, message="", raw_text="", media=MessageMediaPhoto(), date=datetime(2026, 1, 1, tzinfo=timezone.utc))
    client = _PhotoClient(message, buffer.getvalue())
    service = _photo_service(client)

    first = asyncio.run(service.get_photo(1, 40))
    second = asyncio.run(service.get_photo(1, 40))

    assert (first.width, first.height) == (288, 144)
    image = pil.open(io.BytesIO(base64.b64decode(first.data)))
    assert image.mode == "L" and image.size == (288, 144)
    assert second is first
    assert client.downloads == 1


def test_get_photo_rejects_a_message_without_a_photo():
    import pytest
    from app.services.telegram import TelegramServiceError

    message = RichMessage(id=41, message="text only", raw_text="text only", media=None, date=datetime(2026, 1, 1, tzinfo=timezone.utc))
    service = _photo_service(_PhotoClient(message, b""))

    with pytest.raises(TelegramServiceError, match="no photo"):
        asyncio.run(service.get_photo(1, 41))
