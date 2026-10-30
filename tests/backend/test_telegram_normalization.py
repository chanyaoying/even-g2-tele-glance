import asyncio
from types import SimpleNamespace
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
    sticker: object = None
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
    assert normalized.text == "see this"


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

    assert (first.width, first.height) == (288, 120)
    image = pil.open(io.BytesIO(base64.b64decode(first.data)))
    assert image.mode == "L" and image.size == (288, 120)
    assert second is first
    assert client.downloads == 1


def test_get_photo_rejects_a_message_without_a_photo():
    import pytest
    from app.services.telegram import TelegramServiceError

    message = RichMessage(id=41, message="text only", raw_text="text only", media=None, date=datetime(2026, 1, 1, tzinfo=timezone.utc))
    service = _photo_service(_PhotoClient(message, b""))

    with pytest.raises(TelegramServiceError, match="no photo"):
        asyncio.run(service.get_photo(1, 41))


def _sticker_message(message_id, mime):
    document = SimpleNamespace(mime_type=mime)
    return RichMessage(id=message_id, message="", raw_text="", media=None, sticker=document, date=datetime(2026, 1, 1, tzinfo=timezone.utc))


def test_stickers_are_flagged_as_pictures_with_a_text_fallback():
    normalized = normalize_message(_sticker_message(50, "image/webp"))

    assert normalized.media == "sticker"
    assert normalized.text == "[sticker]"


class _StickerClient(_PhotoClient):
    """Records whether the full file or only the preview thumbnail was requested."""

    async def download_media(self, message, file=None, thumb=None):
        self.downloads += 1
        self.thumb = thumb
        return self.payload


def _transparent_webp():
    pil = __import__("pytest").importorskip("PIL.Image")
    import io

    buffer = io.BytesIO()
    image = pil.new("RGBA", (512, 512), (0, 0, 0, 0))
    for x in range(128, 384):
        for y in range(128, 384):
            image.putpixel((x, y), (255, 255, 255, 255))
    image.save(buffer, format="WEBP")
    return buffer.getvalue()


def test_a_static_sticker_downloads_the_real_file_on_a_black_background():
    pil = __import__("pytest").importorskip("PIL.Image")
    import base64, io

    client = _StickerClient(_sticker_message(51, "image/webp"), _transparent_webp())
    photo = asyncio.run(_photo_service(client).get_photo(1, 51))

    assert client.thumb is None  # the sticker file itself, not a thumbnail
    image = pil.open(io.BytesIO(base64.b64decode(photo.data)))
    assert image.size == (288, 120)
    assert image.getpixel((144, 60)) > 200  # the white square
    assert image.getpixel((144, 4)) == 0  # transparent area is black, not whatever colour hides under it


def test_an_animated_sticker_uses_its_preview_thumbnail():
    client = _StickerClient(_sticker_message(52, "application/x-tgsticker"), _transparent_webp())
    asyncio.run(_photo_service(client).get_photo(1, 52))

    assert client.thumb == -1


# --- replies, forwards, polls, link cards and content labels -------------------------------------


def _msg(id=1, text="", media=None, **extra):
    base = dict(id=id, message=text, raw_text=text, date=datetime(2026, 10, 30, 12, 0, tzinfo=timezone.utc), media=media)
    base.update(extra)
    return SimpleNamespace(**base)


def _make(name, fields):
    obj = type(name, (), {})()
    for key, value in fields.items():
        setattr(obj, key, value)
    return obj


def test_media_labels_replace_the_generic_unsupported_text():
    voice = _msg(2, media=_make("MessageMediaDocument", {}), voice=object(), file=SimpleNamespace(duration=12.4))
    assert normalize_message(voice).text == "[voice 0:12]"
    note = _msg(3, media=_make("MessageMediaDocument", {}), video_note=object(), file=SimpleNamespace(duration=75))
    assert normalize_message(note).text == "[video note 1:15]"
    video = _msg(4, "look", media=_make("MessageMediaDocument", {}), video=object(), file=SimpleNamespace(duration=5))
    assert normalize_message(video).text == "look [video 0:05]"
    gif = _msg(5, media=_make("MessageMediaDocument", {}), gif=object())
    assert normalize_message(gif).text == "[GIF]"
    document = _msg(6, media=_make("MessageMediaDocument", {}), file=SimpleNamespace(name="report.pdf", duration=None))
    assert normalize_message(document).text == "[file report.pdf]"
    assert normalize_message(_msg(7, media=_make("MessageMediaGeo", {}))).text == "[location]"
    assert normalize_message(_msg(8, media=_make("MessageMediaContact", {"first_name": "Ann", "last_name": "Lee"}))).text == "[contact Ann Lee]"
    assert normalize_message(_msg(9, media=_make("MessageMediaUnknownThing", {}))).text == "[unsupported content]"


def test_a_link_preview_keeps_the_text_and_adds_a_card():
    page = _make("WebPage", {"title": "Even Hub docs", "description": "Build  apps\nfor G2", "display_url": "www.hub.evenrealities.com/docs", "url": "https://x"})
    message = normalize_message(_msg(10, "see https://hub.evenrealities.com/docs", media=_make("MessageMediaWebPage", {"webpage": page})))
    assert message.text == "see https://hub.evenrealities.com/docs"
    assert message.link.title == "Even Hub docs"
    assert message.link.domain == "hub.evenrealities.com"
    assert message.link.description == "Build apps for G2"
    empty = _make("WebPageEmpty", {})
    assert normalize_message(_msg(11, "x", media=_make("MessageMediaWebPage", {"webpage": empty}))).link is None


def test_a_poll_is_summarised_with_percentages_and_my_vote():
    answers = [
        SimpleNamespace(text=SimpleNamespace(text="Pizza"), option=b"1"),
        SimpleNamespace(text="Sushi", option=b"2"),
    ]
    results = SimpleNamespace(
        total_voters=4,
        results=[
            SimpleNamespace(option=b"1", voters=3, chosen=True, correct=False),
            SimpleNamespace(option=b"2", voters=1, chosen=False, correct=False),
        ],
    )
    poll = SimpleNamespace(question=SimpleNamespace(text="Lunch?"), answers=answers, closed=False, quiz=False, multiple_choice=False)
    message = normalize_message(_msg(12, media=_make("MessageMediaPoll", {"poll": poll, "results": results})))
    assert message.text == "Lunch?"
    assert message.poll.total_voters == 4
    assert [(o.text, o.percent, o.chosen) for o in message.poll.options] == [("Pizza", 75, True), ("Sushi", 25, False)]


def test_a_poll_without_results_has_no_percentages():
    poll = SimpleNamespace(question="Q?", answers=[SimpleNamespace(text="A", option=b"1")], closed=True, quiz=False, multiple_choice=False)
    message = normalize_message(_msg(13, media=_make("MessageMediaPoll", {"poll": poll, "results": None})))
    assert message.poll.closed is True
    assert message.poll.options[0].percent is None


def test_forwarded_from_uses_the_header_name_or_the_resolved_source():
    named = _msg(14, "hi", fwd_from=SimpleNamespace(from_name="Hidden Bob"))
    assert normalize_message(named).forwarded_from == "Hidden Bob"
    channel = _msg(15, "hi", fwd_from=SimpleNamespace(from_name=None), forward=SimpleNamespace(chat=Entity(id=1, title="News"), sender=None))
    assert normalize_message(channel).forwarded_from == "News"
    unknown = _msg(16, "hi", fwd_from=SimpleNamespace(from_name=None), forward=None)
    assert normalize_message(unknown).forwarded_from == "unknown"
    assert normalize_message(_msg(17, "hi")).forwarded_from is None


def _reply_header(target, top=None, forum_topic=False):
    return SimpleNamespace(reply_to_msg_id=target, reply_to_top_id=top, forum_topic=forum_topic)


def test_replies_resolve_from_the_batch_and_by_lookup():
    from app.services.telegram import attach_replies

    alice = Entity(id=1, first_name="Alice")
    original = _msg(20, "can you send the file over when you get a chance please", sender=alice)
    in_batch = _msg(21, "sure", reply_to=_reply_header(20))
    outside = _msg(22, "also", reply_to=_reply_header(5))
    outside_original = _msg(5, "", media=_make("MessageMediaPhoto", {}), sender=Entity(id=2, first_name="Bo"))
    raws = [original, in_batch, outside]
    summaries = [normalize_message(raw) for raw in raws]

    async def lookup(ids):
        assert ids == [5]
        return [outside_original]

    asyncio.run(attach_replies(lookup, raws, summaries))
    assert summaries[0].reply_to is None
    assert summaries[1].reply_to.sender == "Alice"
    assert summaries[1].reply_to.preview == "can you send the file over when you ge.."
    assert summaries[2].reply_to.sender == "Bo"
    assert summaries[2].reply_to.preview == "[photo]"


def test_forum_topic_root_replies_are_not_quoted_but_real_replies_are():
    from app.services.telegram import attach_replies

    plain = _msg(31, "hello", reply_to=_reply_header(30, forum_topic=True))
    by_id = _msg(32, "hello", reply_to=_reply_header(30))
    real = _msg(33, "re", reply_to=_reply_header(31, top=30, forum_topic=True))
    raws = [plain, by_id, real]
    summaries = [normalize_message(raw) for raw in raws]

    async def lookup(ids):
        return []

    asyncio.run(attach_replies(lookup, raws, summaries, topic_id=30))
    assert summaries[0].reply_to is None
    assert summaries[1].reply_to is None
    assert summaries[2].reply_to.message_id == 31


def test_a_failed_reply_lookup_keeps_the_message_with_a_bare_reply_marker():
    from app.services.telegram import attach_replies

    raws = [_msg(41, "x", reply_to=_reply_header(7))]
    summaries = [normalize_message(raw) for raw in raws]

    async def lookup(ids):
        raise RuntimeError("boom")

    asyncio.run(attach_replies(lookup, raws, summaries))
    assert summaries[0].reply_to.message_id == 7
    assert summaries[0].reply_to.sender is None
