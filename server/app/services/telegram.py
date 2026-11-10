import asyncio
import base64
import logging
from collections import OrderedDict
import math
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Literal, Optional, Protocol, Union

from app.config import Settings
from app.services.imaging import MAX_SOURCE_BYTES, ImagingError, prepare_glasses_image
from app.services.message_content import forwarded_from, link_info, media_label, poll_info, reply_preview, reply_target_id, rich_text, service_text
from app.models import (
    ChatSummary,
    FolderSummary,
    MessageSummary,
    PhotoResponse,
    ReplyInfo,
    PhoneLoginStart,
    PhoneLoginStatus,
    ResyncUpdate,
    SendMessageResponse,
    TelegramUpdate,
    TopicSummary,
    TypingUpdate,
)

_telethon_logger = logging.getLogger("telethon")
_telethon_logger.addFilter(lambda record: not _is_auth_key_msg(str(record.msg)))


def _is_auth_key_msg(msg: str) -> bool:
    return "AuthKeyUnregisteredError" in msg or "AuthKeyDuplicatedError" in msg or "account is not logged in" in msg



class TelegramServiceError(RuntimeError):
    pass


class TelegramSessionExpiredError(TelegramServiceError):
    pass


class TelegramServiceTimeoutError(TelegramServiceError):
    pass


class TelegramUnavailableError(TelegramServiceError):
    """Telegram could not be reached (connect failed or timed out, connection dropped); worth a retry."""


class TelegramRateLimitError(TelegramServiceError):
    """Telegram asked the account to wait; `seconds` is how long."""

    def __init__(self, seconds: int) -> None:
        self.seconds = max(1, int(seconds))
        super().__init__(f"Telegram asks you to wait {self.seconds} s before trying again.")


SESSION_EXPIRED_MESSAGE = "Telegram session has expired. Reconnect in TeleGlance Settings."
# The phone recognises expiry by the phrase "session has expired" (and by X-TeleGlance-Error / "code").
SESSION_INVALID_MESSAGE = "Telegram session has expired or is invalid. Reconnect in TeleGlance Settings."
UNAVAILABLE_MESSAGE = "Could not reach Telegram. Please retry."
GENERIC_ERROR_MESSAGE = "Telegram request failed. Please retry."
_AUTH_KEY_ERROR_NAMES = {"AuthKeyUnregisteredError", "AuthKeyDuplicatedError", "SessionRevokedError", "SessionExpiredError"}


def _is_auth_key_error(exc: Exception) -> bool:
    return exc.__class__.__name__ in _AUTH_KEY_ERROR_NAMES


_FLOOD_WAIT_NAMES = {"FloodWaitError", "SlowModeWaitError", "FloodPremiumWaitError", "FloodTestPhoneWaitError"}


def _flood_wait_seconds(exc: Exception) -> Optional[int]:
    # Telethon's flood errors are separate classes (SlowModeWaitError is not a FloodWaitError subclass), so match by name.
    if not any(cls.__name__ in _FLOOD_WAIT_NAMES for cls in type(exc).__mro__):
        return None
    seconds = getattr(exc, "seconds", None)
    return int(seconds) if isinstance(seconds, (int, float)) else 1


# Telegram errors whose meaning the user can act on. Everything else gets GENERIC_ERROR_MESSAGE and the
# real text only goes to the server log: raw RPC/exception text can carry internals (ids, request names).
_USER_ERROR_MESSAGES = {
    "PeerIdInvalidError": "Chat not found.",
    "ChannelInvalidError": "Chat not found.",
    "ChatIdInvalidError": "Chat not found.",
    "ChannelPrivateError": "This chat is private or you were removed from it.",
    "MessageIdInvalidError": "Message not found.",
    "TopicDeletedError": "This topic was deleted.",
    "ChatWriteForbiddenError": "You cannot send messages in this chat.",
    "UserBannedInChannelError": "You cannot send messages in this chat.",
    "ChatAdminRequiredError": "You cannot send messages in this chat.",
    "MessageTooLongError": "Message is too long.",
    "MessageEmptyError": "Message is empty.",
    "PhoneNumberInvalidError": "Phone number is invalid.",
    "PhoneNumberBannedError": "This phone number is banned by Telegram.",
    "PhoneNumberUnoccupiedError": "This phone number is not registered with Telegram.",
    "PhoneNumberFloodError": "Too many login attempts. Try again later.",
    "PhoneCodeInvalidError": "Verification code is incorrect.",
    "PhoneCodeExpiredError": "Verification code has expired. Request a new one.",
    "PhoneCodeEmptyError": "Verification code is required",
    "ApiIdInvalidError": "Telegram API ID or API hash is invalid.",
}
# Telethon raises a plain ValueError for an id it cannot resolve (not in the session's entity cache).
_ENTITY_NOT_FOUND_HINTS = ("Could not find the input entity", "Cannot find any entity", "No user has", "Cannot get entity")
_logger = logging.getLogger(__name__)


def wrap_telegram_error(exc: Exception) -> TelegramServiceError:
    if isinstance(exc, TelegramServiceError):
        return exc
    flood = _flood_wait_seconds(exc)
    if flood is not None:
        return TelegramRateLimitError(flood)
    if isinstance(exc, TimeoutError):
        return TelegramServiceTimeoutError("Telegram request timed out. Please retry.")
    if _is_auth_key_error(exc):
        return TelegramSessionExpiredError(SESSION_EXPIRED_MESSAGE)
    if isinstance(exc, (ConnectionError, OSError)):
        _logger.warning("Telegram unreachable: %s: %s", exc.__class__.__name__, exc)
        return TelegramUnavailableError(UNAVAILABLE_MESSAGE)
    known = next((_USER_ERROR_MESSAGES[cls.__name__] for cls in type(exc).__mro__ if cls.__name__ in _USER_ERROR_MESSAGES), None)
    if known is not None:
        return TelegramServiceError(known)
    if isinstance(exc, ValueError) and any(hint in str(exc) for hint in _ENTITY_NOT_FOUND_HINTS):
        return TelegramServiceError("Chat not found.")
    _logger.warning("Telegram request failed: %s: %s", exc.__class__.__name__, exc)
    return TelegramServiceError(GENERIC_ERROR_MESSAGE)


class TelegramService(Protocol):
    async def auth_status(self) -> dict[str, bool]:
        ...

    async def start_phone_login(self, phone: str) -> PhoneLoginStart:
        ...

    async def complete_phone_login(
        self,
        phone: str,
        code: str,
        phone_code_hash: Optional[str] = None,
        password: Optional[str] = None,
    ) -> PhoneLoginStatus:
        ...

    async def close(self) -> None:
        """Disconnect without logging out and stop serving requests."""
        ...

    async def logout(self) -> None:
        ...

    async def list_chats(self, limit: int, offset: int = 0, folder_id: Optional[int] = None) -> list[ChatSummary]:
        ...

    async def list_folders(self) -> list[FolderSummary]:
        ...

    async def list_topics(self, chat_id: int, *, limit: int = 20, offset: int = 0) -> list[TopicSummary]:
        ...

    async def list_messages(
        self,
        chat_id: int,
        *,
        topic_id: Optional[int] = None,
        before_id: Optional[int] = None,
        after_id: Optional[int] = None,
        limit: int = 8,
    ) -> list[MessageSummary]:
        ...

    async def get_photo(
        self,
        chat_id: int,
        message_id: int,
        *,
        max_width: int = 288,
        max_height: int = 120,
    ) -> PhotoResponse:
        ...

    async def send_message(
        self,
        chat_id: int,
        *,
        text: str,
        topic_id: Optional[int] = None,
    ) -> SendMessageResponse:
        ...

    async def mark_read(
        self,
        chat_id: int,
        *,
        topic_id: Optional[int] = None,
        max_id: Optional[int] = None,
    ) -> None:
        ...

    def update_events(self) -> AsyncIterator[Union[TelegramUpdate, TypingUpdate, ResyncUpdate]]:
        ...


def _display_name(entity: Any) -> str:
    title = getattr(entity, "title", None)
    if title:
        return str(title)
    first_name = getattr(entity, "first_name", "") or ""
    last_name = getattr(entity, "last_name", "") or ""
    name = f"{first_name} {last_name}".strip()
    username = getattr(entity, "username", None)
    return name or (f"@{username}" if username else "Unknown")


def _is_custom_folder(dialog_filter: Any) -> bool:
    # DialogFilterDefault ("All chats") has no id/title; real folders do.
    return getattr(dialog_filter, "id", None) is not None and getattr(dialog_filter, "title", None) is not None


def _folder_title(dialog_filter: Any) -> str:
    title = getattr(dialog_filter, "title", None)
    return str(getattr(title, "text", title) or "Folder")


def _input_peer_id(peer: Any) -> Optional[int]:
    try:
        from telethon import utils

        return int(utils.get_peer_id(peer))
    except Exception:
        return None


def dialog_matches_filter(dialog_filter: Any, dialog: Any) -> bool:
    """Apply a Telegram chat folder (DialogFilter) to a Telethon Dialog."""
    dialog_id = int(getattr(dialog, "id"))
    entity = getattr(dialog, "entity", None)

    def ids(attr: str) -> set[int]:
        return {i for i in (_input_peer_id(p) for p in (getattr(dialog_filter, attr, None) or [])) if i is not None}

    if dialog_id in ids("exclude_peers"):
        return False
    if dialog_id in ids("include_peers") or dialog_id in ids("pinned_peers"):
        return True

    is_user = bool(getattr(dialog, "is_user", False))
    is_bot = bool(getattr(entity, "bot", False))
    is_contact = bool(getattr(entity, "contact", False))
    is_channel = bool(getattr(dialog, "is_channel", False))
    is_group = bool(getattr(dialog, "is_group", False))
    category = (
        (getattr(dialog_filter, "contacts", False) and is_user and not is_bot and is_contact)
        or (getattr(dialog_filter, "non_contacts", False) and is_user and not is_bot and not is_contact)
        or (getattr(dialog_filter, "groups", False) and is_group)
        or (getattr(dialog_filter, "broadcasts", False) and is_channel and not is_group)
        or (getattr(dialog_filter, "bots", False) and is_bot)
    )
    if not category:
        return False
    if getattr(dialog_filter, "exclude_archived", False) and getattr(dialog, "archived", False):
        return False
    if getattr(dialog_filter, "exclude_read", False) and not getattr(dialog, "unread_count", 0):
        return False
    if getattr(dialog_filter, "exclude_muted", False):
        notify = getattr(getattr(dialog, "dialog", None), "notify_settings", None)
        if getattr(notify, "mute_until", None):
            return False
    return True


# Telegram returns 100 dialogs per request, so fetching in blocks of 100 costs the same number of
# requests as fetching exactly what one page needs while serving the following pages from memory.
DIALOG_BLOCK = 100
# A cached prefix older than this is discarded; the first page is always refetched regardless.
DIALOG_CACHE_TTL_SECONDS = 45.0
# Deep folder pages scan this many extra matching chats ahead so the next few pages are cache hits.
FOLDER_LOOKAHEAD = 60
# A refresh of page one only needs the top of the list; the deeper cached chats are kept.
HEAD_REFRESH = 40
PHOTO_CACHE_SIZE = 128
UPDATE_QUEUE_SIZE = 50
REPLY_CACHE_CHATS = 16
REPLY_CACHE_PER_CHAT = 200
ENTITY_CACHE_SIZE = 1000
USER_NAME_CACHE_SIZE = 2000
# A folder page scans the account's chat list from the top; never walk further than this.
FOLDER_SCAN_LIMIT = 1000
FOLDER_CACHE_TTL_SECONDS = 60.0
# Telethon sleeps through FloodWaits up to this many seconds itself. Longer waits must reach the phone as
# 429 + Retry-After: an internal sleep would outlast our request timeouts and turn into a 504.
FLOOD_SLEEP_THRESHOLD_SECONDS = 2
CONNECT_TIMEOUT_SECONDS = 15.0
CONNECTION_RETRIES = 2
# A live update waits at most this long for its reply quote before it is published without one.
LIVE_REPLY_TIMEOUT_SECONDS = 3.0
TOPIC_PAGE_MAX = 100


class _LruDict(OrderedDict):
    """An OrderedDict that keeps at most `max_size` entries, dropping the least recently used."""

    def __init__(self, max_size: int) -> None:
        super().__init__()
        self.max_size = max_size

    def get(self, key: Any, default: Any = None) -> Any:
        if key not in self:
            return default
        self.move_to_end(key)
        return self[key]

    def __setitem__(self, key: Any, value: Any) -> None:
        super().__setitem__(key, value)
        self.move_to_end(key)
        while len(self) > self.max_size:
            self.popitem(last=False)


@dataclass
class _DialogSnapshot:
    dialogs: list[Any]
    exhausted: bool  # True when `dialogs` is the account's complete chat list
    head_at: float
    tail_at: float  # when the deepest part of `dialogs` was fetched; the TTL applies to this


def normalize_dialog(dialog: Any) -> ChatSummary:
    entity = getattr(dialog, "entity", dialog)
    dialog_id = getattr(dialog, "id", getattr(entity, "id"))
    has_title = bool(getattr(entity, "title", None))
    has_user_name = bool(
        getattr(entity, "first_name", None)
        or getattr(entity, "last_name", None)
        or getattr(entity, "username", None)
    )
    is_user = bool(not has_title and getattr(entity, "bot", False) is False and has_user_name)
    is_channel = bool(getattr(entity, "broadcast", False))
    kind = "user" if is_user else "channel" if is_channel else "group"
    message = getattr(dialog, "message", None)
    last_message = getattr(message, "message", None) if message else None
    return ChatSummary(
        id=int(dialog_id),
        title=_display_name(entity),
        kind=kind,
        unread_count=int(getattr(dialog, "unread_count", 0) or 0),
        is_forum=bool(getattr(entity, "forum", False)),
        last_message=last_message or None,
    )


def normalize_topic(topic: Any, last_message: Optional[str] = None) -> TopicSummary:
    return TopicSummary(
        id=int(getattr(topic, "id")),
        title=str(getattr(topic, "title", "Untitled")),
        top_message_id=int(getattr(topic, "top_message", getattr(topic, "top_message_id", 0))),
        unread_count=int(getattr(topic, "unread_count", 0) or 0),
        last_message=last_message,
    )


def _topic_preview(message: Any) -> Optional[str]:
    """The newest message of a forum topic as one line of text (the topic list's preview)."""
    if message is None:
        return None
    try:
        text = normalize_message(message).text
    except Exception:  # an odd message type must not break the topic list
        return None
    return text or None


def normalize_message(message: Any, entities_by_peer: Optional[dict[int, Any]] = None) -> MessageSummary:
    sender = getattr(message, "sender", None)
    if sender is None and entities_by_peer:
        sender = entities_by_peer.get(_message_peer_key(message))
    sender_name = _display_name(sender) if sender is not None else None
    media = "photo" if _is_photo_message(message) else "sticker" if _is_sticker_message(message) else None
    poll = poll_info(message)
    link = link_info(message)
    service = getattr(message, "action", None) is not None and not (getattr(message, "message", None) or "")
    if service:
        text = service_text(message, sender_name)
    elif media == "photo":
        text = _photo_text(message)
    elif media == "sticker":
        text = "[sticker]"
    elif poll is not None:
        text = poll.question
    else:
        text = _message_readable_text(message)
    return MessageSummary(
        id=int(getattr(message, "id")),
        sender=sender_name,
        text=text,
        sent_at=getattr(message, "date", None),
        outgoing=bool(getattr(message, "out", False)),
        media=media,
        service=service,
        forwarded_from=forwarded_from(message),
        poll=poll,
        link=link,
    )


class ReplyPreviewCache:
    """Small LRU of resolved reply originals, per chat: repeat page fetches then skip the Telegram lookup."""

    def __init__(self, max_chats: int = REPLY_CACHE_CHATS, per_chat: int = REPLY_CACHE_PER_CHAT) -> None:
        self._chats: "OrderedDict[int, OrderedDict[int, tuple[Optional[str], str]]]" = OrderedDict()
        self._max_chats = max_chats
        self._per_chat = per_chat

    def get(self, chat_id: int, message_id: int) -> Optional[tuple[Optional[str], str]]:
        entries = self._chats.get(chat_id)
        if entries is None or message_id not in entries:
            return None
        entries.move_to_end(message_id)
        self._chats.move_to_end(chat_id)
        return entries[message_id]

    def put(self, chat_id: int, message_id: int, sender: Optional[str], preview: str) -> None:
        entries = self._chats.setdefault(chat_id, OrderedDict())
        entries[message_id] = (sender, preview)
        entries.move_to_end(message_id)
        while len(entries) > self._per_chat:
            entries.popitem(last=False)
        self._chats.move_to_end(chat_id)
        while len(self._chats) > self._max_chats:
            self._chats.popitem(last=False)

    def invalidate(self, chat_id: int, message_id: int) -> None:
        entries = self._chats.get(chat_id)
        if entries is not None:
            entries.pop(message_id, None)

    def clear(self) -> None:
        self._chats.clear()


async def attach_replies(
    client_get_messages: Any,
    raw_messages: list[Any],
    summaries: list[MessageSummary],
    *,
    topic_id: Optional[int] = None,
    cache: Optional[ReplyPreviewCache] = None,
    chat_id: Optional[int] = None,
) -> None:
    """Fill `reply_to` on each summary. Originals already in the batch are reused; the rest cost one lookup.

    With `cache` and `chat_id`, originals resolved earlier come from the cache and only unseen ones are fetched.
    """
    use_cache = cache is not None and chat_id is not None
    targets = {}
    for raw, summary in zip(raw_messages, summaries):
        target = reply_target_id(raw, topic_id)
        if target is not None:
            targets[summary.id] = target
    if not targets:
        return
    known = {int(getattr(raw, "id")): (raw, summary) for raw, summary in zip(raw_messages, summaries)}
    cached: dict[int, tuple[Optional[str], str]] = {}
    if use_cache:
        for target in set(targets.values()):
            if target not in known:
                hit = cache.get(chat_id, target)
                if hit is not None:
                    cached[target] = hit
    missing = sorted({target for target in targets.values() if target not in known and target not in cached})
    fetched: dict[int, Any] = {}
    if missing:
        try:
            for original in await client_get_messages(missing) or []:
                if original is not None and getattr(original, "id", None) is not None:
                    fetched[int(original.id)] = original
        except Exception:  # a failed lookup only costs the quote text
            logging.getLogger(__name__).debug("reply lookup failed", exc_info=True)
    for summary in summaries:
        target = targets.get(summary.id)
        if target is None:
            continue
        if target in known:
            original, original_summary = known[target]
            sender = original_summary.sender
        elif target in cached:
            sender, preview = cached[target]
            summary.reply_to = ReplyInfo(message_id=target, sender=sender, preview=preview)
            continue
        elif target in fetched:
            original = fetched[target]
            sender = _display_name(getattr(original, "sender", None)) if getattr(original, "sender", None) is not None else None
            if use_cache:
                cache.put(chat_id, target, sender, reply_preview(original))
        else:
            summary.reply_to = ReplyInfo(message_id=target)
            continue
        summary.reply_to = ReplyInfo(message_id=target, sender=sender, preview=reply_preview(original))


def _is_photo_message(message: Any) -> bool:
    # Only real photos: link previews also expose `.photo` but are not worth an image download.
    return type(getattr(message, "media", None)).__name__ == "MessageMediaPhoto"


def _is_sticker_message(message: Any) -> bool:
    # Telethon exposes the document as `.sticker` only when it carries the sticker attribute.
    return getattr(message, "sticker", None) is not None


def _sticker_is_static(message: Any) -> bool:
    # Static stickers are WebP files; animated (.tgs) and video (.webm) ones only offer a still preview thumbnail.
    document = getattr(message, "sticker", None)
    return str(getattr(document, "mime_type", "") or "").lower() == "image/webp"


def _photo_text(message: Any) -> str:
    caption = str(getattr(message, "message", None) or getattr(message, "raw_text", None) or "").strip()
    return f"{caption} [photo]" if caption else "[photo]"


def _message_readable_text(message: Any) -> str:
    text = str(getattr(message, "message", None) or getattr(message, "raw_text", None) or "").strip() or rich_text(message)
    label = media_label(message)
    if label is None and not text and getattr(message, "action", None) is not None:
        sender = getattr(message, "sender", None)
        return service_text(message, _display_name(sender) if sender is not None else None)
    if label is None:
        return text
    return f"{text} {label}" if text else label


def normalize_update_message(message: Any, chat_id: Optional[int] = None) -> TelegramUpdate:
    return TelegramUpdate(
        chat_id=int(chat_id if chat_id is not None else getattr(message, "chat_id", 0)),
        topic_id=_message_topic_id(message),
        message=normalize_message(message),
    )


def normalize_chat_action(event: Any, user_override: Any = None) -> Optional[TypingUpdate]:
    action_message = getattr(event, "action_message", None)
    action = action_message if action_message is not None else event
    action_value = getattr(action, "action", None)
    if action_value is None:
        action_value = getattr(event, "action", None)
    if action_value is None and getattr(event, "typing", False):
        typing_action: Literal["typing", "cancel"] = "typing"
    elif action_value is None:
        return None
    else:
        action_type = type(action_value).__name__
        if action_type == "SendMessageTypingAction":
            typing_action = "typing"
        elif action_type == "SendMessageCancelAction":
            typing_action = "cancel"
        else:
            return None

    user_name = None
    if isinstance(user_override, str):
        user_name = user_override
    else:
        user = user_override if user_override is not None else getattr(event, "user", None)
    if user_name is None and user is not None:
        user_name = getattr(user, "first_name", None) or getattr(user, "username", None)
    if not user_name:
        user_id = getattr(event, "user_id", None)
        user_name = f"User {user_id}" if user_id is not None else "Someone"
    chat_id = getattr(event, "chat_id", None)
    topic_id = _chat_action_topic_id(action)

    return TypingUpdate(
        chat_id=chat_id,
        topic_id=topic_id,
        user_name=user_name,
        action=typing_action,
    )


def _chat_action_topic_id(action: Any) -> Optional[int]:
    reply_to = getattr(action, "reply_to", None)
    if reply_to is None:
        return None
    return getattr(reply_to, "reply_to_msg_id", None)


def _entity_lookup(entities: list[Any]) -> dict[int, Any]:
    lookup: dict[int, Any] = {}
    for entity in entities:
        for key in _entity_keys(entity):
            lookup[key] = entity
    return lookup


def _entity_keys(entity: Any) -> set[int]:
    keys: set[int] = set()
    entity_id = getattr(entity, "id", None)
    if entity_id is not None:
        keys.add(int(entity_id))
        if getattr(entity, "broadcast", False) or getattr(entity, "megagroup", False) or getattr(entity, "forum", False):
            keys.add(-1000000000000 - int(entity_id))
    try:
        from telethon import utils

        keys.add(int(utils.get_peer_id(entity)))
    except Exception:
        pass
    return keys


def _message_peer_key(message: Any) -> Optional[int]:
    peer = getattr(message, "from_id", None) or getattr(message, "peer_id", None)
    if peer is None:
        sender_id = getattr(message, "sender_id", None)
        return int(sender_id) if sender_id is not None else None
    for attr in ("user_id", "chat_id", "channel_id"):
        value = getattr(peer, attr, None)
        if value is not None:
            return int(value)
    try:
        from telethon import utils

        return int(utils.get_peer_id(peer))
    except Exception:
        return None


def _message_topic_id(message: Any) -> Optional[int]:
    reply_to = getattr(message, "reply_to", None)
    if reply_to is None:
        return None
    for attr in ("reply_to_top_id", "reply_to_msg_id", "forum_topic_id"):
        value = getattr(reply_to, attr, None)
        if value is not None:
            return int(value)
    return None


def normalize_expiry(expires: Any) -> Optional[datetime]:
    if isinstance(expires, datetime):
        return expires
    if isinstance(expires, (int, float)):
        return datetime.fromtimestamp(expires, tz=timezone.utc)
    return None


def is_expired(expires: Any) -> bool:
    expires_at = normalize_expiry(expires)
    if expires_at is None:
        return False
    now = datetime.now(expires_at.tzinfo or timezone.utc)
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at <= now


@dataclass(frozen=True)
class TelegramClientCredentials:
    api_id: Optional[int]
    api_hash: Optional[str]
    session_string: Optional[str] = None


@dataclass
class TelethonTelegramService:
    settings: Settings
    credentials: Optional[TelegramClientCredentials] = None

    def __post_init__(self) -> None:
        self._client = None
        self._expired = False
        self._closed = False
        self._has_connected = False
        self._update_queues: set[asyncio.Queue[Union[TelegramUpdate, TypingUpdate]]] = set()
        self._updates_registered = False
        self._entity_cache: _LruDict = _LruDict(ENTITY_CACHE_SIZE)
        self._photo_cache: OrderedDict = OrderedDict()
        self._reply_cache = ReplyPreviewCache()
        self._chat_requests: dict = {}
        self._dialog_lock = asyncio.Lock()
        # Only one request creates/connects the client; the others wait for it instead of racing connect().
        self._connect_lock = asyncio.Lock()
        self._user_name_cache: _LruDict = _LruDict(USER_NAME_CACHE_SIZE)
        self._phone_code_hashes: dict[str, str] = {}
        self._dialog_snapshot: Optional[_DialogSnapshot] = None
        self._folder_cache: Optional[tuple[float, list[Any]]] = None

    @property
    def expired(self) -> bool:
        return self._expired

    @property
    def subscriber_count(self) -> int:
        """How many update streams are attached; a service with streams is never evicted for being idle."""
        return len(self._update_queues)

    @property
    def configured(self) -> bool:
        return bool(self.api_id and self.api_hash)

    @property
    def api_id(self) -> Optional[int]:
        return self.credentials.api_id if self.credentials is not None else None

    @property
    def api_hash(self) -> Optional[str]:
        return self.credentials.api_hash if self.credentials is not None else None

    async def _get_client(self):
        if not self.configured:
            raise TelegramServiceError("Telegram API credentials are not configured")
        if self._expired:
            raise TelegramSessionExpiredError(SESSION_EXPIRED_MESSAGE)
        if self._closed:
            raise TelegramUnavailableError(UNAVAILABLE_MESSAGE)
        client = self._client
        if client is not None and self._updates_registered and client.is_connected():
            return client
        async with self._connect_lock:
            return await self._connect_locked()

    async def _connect_locked(self):
        reconnected = False
        for _attempt in range(2):
            if self._expired:
                raise TelegramSessionExpiredError(SESSION_EXPIRED_MESSAGE)
            if self._closed:
                raise TelegramUnavailableError(UNAVAILABLE_MESSAGE)
            if self._client is None:
                self._client = self._new_client()
            if self._client.is_connected():
                break
            reconnected = self._has_connected
            try:
                await asyncio.wait_for(self._client.connect(), timeout=CONNECT_TIMEOUT_SECONDS)
            except ValueError as exc:
                if "cannot be reused after logging out" not in str(exc):
                    raise wrap_telegram_error(exc) from exc
                await self._discard_client()
                continue
            except (TimeoutError, ConnectionError, OSError) as exc:
                # A half-made connection is not worth keeping; the next request starts clean.
                await self._discard_client()
                _logger.warning("Telegram connect failed: %s", exc.__class__.__name__)
                raise TelegramUnavailableError(UNAVAILABLE_MESSAGE) from exc
            if self.credentials and self.credentials.session_string:
                try:
                    await asyncio.wait_for(self._client.get_me(), timeout=10)
                except Exception as exc:
                    if _is_auth_key_error(exc):
                        self._expired = True
                        await self._discard_client()
                        raise TelegramSessionExpiredError(SESSION_EXPIRED_MESSAGE) from exc
            break
        else:
            raise TelegramUnavailableError(UNAVAILABLE_MESSAGE)
        self._has_connected = True
        await self._ensure_update_handler()
        if reconnected:
            # Updates sent while the connection was down are lost; tell open streams to refetch.
            self._publish(ResyncUpdate())
        return self._client

    def _new_client(self) -> Any:
        try:
            from telethon import TelegramClient
        except ImportError as exc:
            raise TelegramServiceError("Telethon is not installed. Install server requirements.") from exc

        try:
            from telethon.sessions import StringSession
        except ImportError as exc:
            raise TelegramServiceError("Telethon StringSession support is unavailable") from exc

        try:
            session = StringSession((self.credentials.session_string if self.credentials else None) or "")
        except ValueError as exc:
            # A malformed session string will never work: treat it like an expired session (401).
            self._expired = True
            raise TelegramSessionExpiredError(SESSION_INVALID_MESSAGE) from exc
        return TelegramClient(
            session,
            int(self.api_id or 0),
            self.api_hash or "",
            flood_sleep_threshold=FLOOD_SLEEP_THRESHOLD_SECONDS,
            connection_retries=CONNECTION_RETRIES,
        )

    async def ensure_stream_connection(self) -> None:
        """Called by an idle update stream: reconnect a dropped client so updates flow again.

        Raises a TelegramServiceError when Telegram cannot be reached, so the stream can report it.
        """
        client = self._client
        if client is not None and client.is_connected():
            return
        await self._get_client()

    async def close(self) -> None:
        """Disconnect without logging out (the session string belongs to its owner) and refuse further use."""
        self._closed = True
        await self._discard_client()

    async def _get_entity(self, chat_id: int) -> Any:
        cached = self._entity_cache.get(int(chat_id))
        if cached is not None:
            return cached
        client = await self._get_client()
        entity = await asyncio.wait_for(client.get_entity(chat_id), timeout=15)
        self._entity_cache[int(chat_id)] = entity
        return entity

    async def _ensure_update_handler(self) -> None:
        if self._updates_registered or self._client is None:
            return
        try:
            from telethon import events
        except ImportError as exc:
            raise TelegramServiceError("Telethon update API is unavailable") from exc

        self._client.add_event_handler(self._handle_new_message, events.NewMessage())
        # An edit is delivered like a new message with the same id; the phone replaces the old copy.
        self._client.add_event_handler(self._handle_new_message, events.MessageEdited())
        self._client.add_event_handler(self._handle_chat_action, events.ChatAction())
        self._client.add_event_handler(self._handle_chat_action, events.UserUpdate())
        self._updates_registered = True

    async def _handle_new_message(self, event: Any) -> None:
        if not self._update_queues:
            return
        message = getattr(event, "message", None)
        if message is None:
            return
        update = normalize_update_message(message, getattr(event, "chat_id", None))
        # An edit changes what a reply to this message should quote; drop the stale copy.
        self._reply_cache.invalidate(update.chat_id, update.message.id)
        try:
            await asyncio.wait_for(self._resolve_live_reply(update, message), timeout=LIVE_REPLY_TIMEOUT_SECONDS)
        except TimeoutError:
            pass  # publish without the quote rather than hold the message back
        self._publish(update)

    def _publish(self, update: Any) -> None:
        """Fan an update out to every stream. A full queue drops its oldest items and gets a resync marker."""
        for queue in list(self._update_queues):
            try:
                queue.put_nowait(update)
            except asyncio.QueueFull:
                # Make room for the marker and the new update, then tell the phone it missed something.
                for _ in range(2):
                    try:
                        queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                queue.put_nowait(ResyncUpdate())
                queue.put_nowait(update)

    async def _resolve_live_reply(self, update: TelegramUpdate, message: Any) -> None:
        """Quote the replied-to message on a live update, as list_messages does, so the phone can use it as is."""
        if reply_target_id(message, update.topic_id) is None:
            return
        try:
            client = await self._get_client()
            entity = await self._get_entity(update.chat_id)
            await attach_replies(
                lambda ids: asyncio.wait_for(client.get_messages(entity, ids=ids), timeout=3),
                [message],
                [update.message],
                topic_id=update.topic_id,
                cache=self._reply_cache,
                chat_id=update.chat_id,
            )
        except Exception:  # a missing quote is cosmetic; never hold back the message itself
            logging.getLogger(__name__).debug("live reply lookup failed", exc_info=True)

    async def _handle_chat_action(self, event: Any) -> None:
        if not self._update_queues:
            return
        update = normalize_chat_action(event, self._typing_user_override(event))
        if update is None:
            return
        self._publish(update)

    def _typing_user_override(self, event: Any) -> Any:
        user = getattr(event, "user", None)
        if user is not None:
            self._cache_user_name(user)
            return user
        user_id = getattr(event, "user_id", None)
        if user_id is None:
            return None
        return self._user_name_cache.get(int(user_id))

    def _cache_user_name(self, entity: Any) -> None:
        if entity is None:
            return
        entity_id = getattr(entity, "id", None)
        if entity_id is None:
            return
        name = _display_name(entity)
        if name:
            self._user_name_cache[int(entity_id)] = name

    def _cache_message_sender(self, message: Any, entities_by_peer: Optional[dict[int, Any]] = None) -> None:
        sender = getattr(message, "sender", None)
        if sender is None and entities_by_peer:
            sender = entities_by_peer.get(_message_peer_key(message))
        self._cache_user_name(sender)

    async def update_events(self) -> AsyncIterator[Union[TelegramUpdate, TypingUpdate, ResyncUpdate]]:
        try:
            client = await self._get_client()
            authorized = await client.is_user_authorized()
        except Exception as exc:
            raise wrap_telegram_error(exc) from exc
        if not authorized:
            raise TelegramServiceError("Telegram session is not authorized")
        queue: asyncio.Queue = asyncio.Queue(maxsize=UPDATE_QUEUE_SIZE)
        self._update_queues.add(queue)
        try:
            while True:
                yield await queue.get()
        finally:
            self._update_queues.discard(queue)

    async def auth_status(self) -> dict[str, bool]:
        if not self.configured:
            return {"configured": False, "authorized": False}
        try:
            client = await self._get_client()
            authorized = bool(await client.is_user_authorized())
        except Exception as exc:
            raise wrap_telegram_error(exc) from exc
        return {"configured": True, "authorized": authorized}

    async def start_phone_login(self, phone: str) -> PhoneLoginStart:
        if not self.configured:
            raise TelegramServiceError("Telegram API credentials are not configured")
        normalized_phone = phone.strip()
        try:
            client = await self._get_client()
            if await client.is_user_authorized():
                return PhoneLoginStart(phone=normalized_phone, sent=True, message="Telegram is already connected.")
            sent = await client.send_code_request(normalized_phone)
        except Exception as exc:
            raise wrap_telegram_error(exc) from exc
        phone_code_hash = getattr(sent, "phone_code_hash", None)
        if phone_code_hash:
            self._phone_code_hashes[normalized_phone] = str(phone_code_hash)
        return PhoneLoginStart(
            phone=normalized_phone,
            sent=True,
            message="Verification code sent.",
            phone_code_hash=str(phone_code_hash) if phone_code_hash else None,
        )

    async def complete_phone_login(
        self,
        phone: str,
        code: str,
        phone_code_hash: Optional[str] = None,
        password: Optional[str] = None,
    ) -> PhoneLoginStatus:
        if not self.configured:
            raise TelegramServiceError("Telegram API credentials are not configured")
        normalized_phone = phone.strip()
        try:
            client = await self._get_client()
            if await client.is_user_authorized():
                return PhoneLoginStatus(authorized=True, session_string=self.current_session_string())
        except Exception as exc:
            raise wrap_telegram_error(exc) from exc
        try:
            if password:
                # The pending client already accepted the code; Telegram now wants the 2FA password.
                await client.sign_in(password=password)
            else:
                if not code.strip():
                    raise TelegramServiceError("Verification code is required")
                kwargs: dict[str, Any] = {
                    "phone": normalized_phone,
                    "code": code.strip(),
                }
                resolved_phone_code_hash = (phone_code_hash or "").strip() or self._phone_code_hashes.get(normalized_phone)
                if resolved_phone_code_hash:
                    kwargs["phone_code_hash"] = resolved_phone_code_hash
                await client.sign_in(**kwargs)
        except TelegramServiceError:
            raise
        except Exception as exc:
            error_name = exc.__class__.__name__
            if error_name == "SessionPasswordNeededError":
                return PhoneLoginStatus(
                    authorized=False,
                    password_required=True,
                    message="Two-step verification is enabled. Enter your Telegram cloud password.",
                )
            if error_name == "PasswordHashInvalidError":
                return PhoneLoginStatus(
                    authorized=False,
                    password_required=True,
                    message="Incorrect Telegram password. Try again.",
                )
            raise wrap_telegram_error(exc) from exc
        self._phone_code_hashes.pop(normalized_phone, None)
        try:
            authorized = bool(await client.is_user_authorized())
        except Exception as exc:
            raise wrap_telegram_error(exc) from exc
        return PhoneLoginStatus(authorized=authorized, session_string=self.current_session_string())

    def current_session_string(self) -> Optional[str]:
        if self._client is None:
            return None
        session = getattr(self._client, "session", None)
        save = getattr(session, "save", None)
        if not callable(save):
            return None
        value = save()
        return str(value) if value else None

    async def _discard_client(self) -> None:
        client = self._client
        self._client = None
        self._updates_registered = False
        self._entity_cache.clear()
        self._reply_cache.clear()
        self._phone_code_hashes.clear()
        self._dialog_snapshot = None
        self._folder_cache = None
        self._chat_requests.clear()
        if client is None:
            return
        try:
            if client.is_connected():
                await client.disconnect()
        except Exception:
            pass

    async def logout(self) -> None:
        try:
            client = await self._get_client()
            if await client.is_user_authorized():
                await client.log_out()
        except Exception as exc:
            raise wrap_telegram_error(exc) from exc
        finally:
            self._closed = True
            await self._discard_client()

    async def list_chats(self, limit: int, offset: int = 0, folder_id: Optional[int] = None) -> list[ChatSummary]:
        # Identical requests that arrive together share one Telegram fetch. Without this a burst of duplicate
        # requests runs the same account scan many times over one connection and they all time out together.
        key = (int(limit), int(offset), folder_id)
        task = self._chat_requests.get(key)
        if task is None:
            task = asyncio.ensure_future(self._list_chats_uncoalesced(limit, offset, folder_id))
            self._chat_requests[key] = task

            def finished(done: "asyncio.Future[Any]", key=key) -> None:
                self._chat_requests.pop(key, None)
                if not done.cancelled():
                    done.exception()  # mark retrieved: every waiter may have gone away

            task.add_done_callback(finished)
        # shield: one client giving up must not cancel the fetch the others are waiting for.
        return await asyncio.shield(task)

    async def _list_chats_uncoalesced(self, limit: int, offset: int, folder_id: Optional[int]) -> list[ChatSummary]:
        try:
            client = await self._get_client()
            dialog_filter = await self._get_folder_filter(client, folder_id) if folder_id else None
            # One dialog fetch at a time: a second, different request then finds the cache the first one filled.
            async with self._dialog_lock:
                dialogs = await asyncio.wait_for(
                    self._page_dialogs(client, limit=limit, offset=offset, dialog_filter=dialog_filter),
                    timeout=30,
                )
            for dialog in dialogs:
                entity = getattr(dialog, "entity", None)
                self._cache_user_name(entity)
                # Seed the entity cache so opening a listed chat never needs a get_entity round trip.
                dialog_id = getattr(dialog, "id", None)
                if entity is not None and dialog_id is not None:
                    self._entity_cache[int(dialog_id)] = entity
            return [normalize_dialog(dialog) for dialog in dialogs]
        except TelegramServiceError:
            raise
        except Exception as exc:
            raise wrap_telegram_error(exc) from exc

    def _valid_snapshot(self) -> Optional[_DialogSnapshot]:
        snapshot = self._dialog_snapshot
        if snapshot is None:
            return None
        if time.monotonic() - snapshot.tail_at > DIALOG_CACHE_TTL_SECONDS:
            self._dialog_snapshot = None
            return None
        return snapshot

    def _store_head(self, fresh: list[Any], exhausted: bool) -> None:
        """Replace the top of the cached chat list with freshly fetched dialogs.

        Deeper, older entries are kept when the fresh block lines up with them (its last chat is found in
        the old list), so the background refresh of page one does not throw away pages already scrolled in.
        """
        now = time.monotonic()
        old = self._valid_snapshot()
        dialogs, tail_at, snapshot_exhausted = fresh, now, exhausted
        if old is not None and fresh and not exhausted:
            fresh_ids = {dialog.id for dialog in fresh}
            last_id = fresh[-1].id
            position = next((i for i, dialog in enumerate(old.dialogs) if dialog.id == last_id), None)
            if position is not None:
                tail = [dialog for dialog in old.dialogs[position + 1:] if dialog.id not in fresh_ids]
                if tail:
                    dialogs, tail_at, snapshot_exhausted = fresh + tail, old.tail_at, old.exhausted
        self._dialog_snapshot = _DialogSnapshot(dialogs=dialogs, exhausted=snapshot_exhausted, head_at=now, tail_at=tail_at)

    async def _page_dialogs(self, client: Any, *, limit: int, offset: int, dialog_filter: Any) -> list[Any]:
        if dialog_filter is None:
            return await self._page_unfiltered(client, limit, offset)
        return await self._page_folder(client, limit, offset, dialog_filter)

    async def _page_unfiltered(self, client: Any, limit: int, offset: int) -> list[Any]:
        need = offset + limit
        snapshot = self._valid_snapshot()
        if offset == 0 and snapshot is not None and need <= HEAD_REFRESH:
            # Page one is always fresh, but with a cached list only the top needs downloading.
            fresh = list(await client.get_dialogs(limit=HEAD_REFRESH))
            self._store_head(fresh, exhausted=len(fresh) < HEAD_REFRESH)
            return list(self._dialog_snapshot.dialogs[offset:need])
        if offset == 0 or snapshot is None or (len(snapshot.dialogs) < need and not snapshot.exhausted):
            # A cold start or a deeper miss fetches down to the next block boundary.
            target = max(DIALOG_BLOCK, math.ceil(need / DIALOG_BLOCK) * DIALOG_BLOCK)
            fresh = list(await client.get_dialogs(limit=target))
            self._store_head(fresh, exhausted=len(fresh) < target)
            snapshot = self._dialog_snapshot
        return list(snapshot.dialogs[offset:need])

    async def _page_folder(self, client: Any, limit: int, offset: int, dialog_filter: Any) -> list[Any]:
        need = offset + limit
        snapshot = self._valid_snapshot()
        if snapshot is not None:
            if offset == 0:
                # Refresh just the top of the list, then answer from the cache when it already holds enough
                # matches. This avoids rescanning the whole account for a sparse folder.
                fresh = list(await client.get_dialogs(limit=HEAD_REFRESH))
                self._store_head(fresh, exhausted=len(fresh) < HEAD_REFRESH)
                snapshot = self._dialog_snapshot
            matches = [dialog for dialog in snapshot.dialogs if dialog_matches_filter(dialog_filter, dialog)]
            if len(matches) >= need or snapshot.exhausted:
                return matches[offset:need]
        # Scan from the top (Telegram offers no "chats in this folder" call). Page one stops as soon as it
        # has enough matches; deeper pages look ahead so the following pages come from the cache.
        target = need if offset == 0 else need + FOLDER_LOOKAHEAD
        scanned: list[Any] = []
        found = 0
        exhausted = True
        async for dialog in client.iter_dialogs(limit=FOLDER_SCAN_LIMIT):
            scanned.append(dialog)
            if dialog_matches_filter(dialog_filter, dialog):
                found += 1
                if found >= target:
                    exhausted = False
                    break
        if len(scanned) >= FOLDER_SCAN_LIMIT:
            exhausted = False  # stopped at the scan cap, not at the end of the account's chats
        self._store_head(scanned, exhausted)
        snapshot = self._dialog_snapshot
        matches = [dialog for dialog in snapshot.dialogs if dialog_matches_filter(dialog_filter, dialog)]
        return matches[offset:need]

    async def list_folders(self) -> list[FolderSummary]:
        try:
            client = await self._get_client()
            filters = await self._fetch_dialog_filters(client)
            return [
                FolderSummary(id=int(f.id), title=_folder_title(f))
                for f in filters
                if _is_custom_folder(f)
            ]
        except TelegramServiceError:
            raise
        except Exception as exc:
            raise wrap_telegram_error(exc) from exc

    async def _fetch_dialog_filters(self, client: Any) -> list[Any]:
        cached = self._folder_cache
        now = asyncio.get_running_loop().time()
        if cached and now - cached[0] < FOLDER_CACHE_TTL_SECONDS:
            return cached[1]
        from telethon.tl.functions.messages import GetDialogFiltersRequest

        result = await asyncio.wait_for(client(GetDialogFiltersRequest()), timeout=20)
        filters = list(getattr(result, "filters", result) or [])
        self._folder_cache = (now, filters)
        return filters

    async def _get_folder_filter(self, client: Any, folder_id: int) -> Any:
        for dialog_filter in await self._fetch_dialog_filters(client):
            if _is_custom_folder(dialog_filter) and int(dialog_filter.id) == int(folder_id):
                return dialog_filter
        raise TelegramServiceError("Telegram folder not found")

    async def list_topics(self, chat_id: int, *, limit: int = 20, offset: int = 0) -> list[TopicSummary]:
        try:
            from telethon.tl.functions.messages import GetForumTopicsRequest
        except ImportError as exc:
            raise TelegramServiceError("Telethon forum topic API is unavailable") from exc

        try:
            client = await self._get_client()
            entity = await self._get_entity(chat_id)
            need = int(offset) + int(limit)
            collected: list[tuple[Any, Optional[str]]] = []
            offset_date, offset_id, offset_topic = None, 0, 0
            # Telegram pages topics by cursor (the last topic's newest message), at most 100 per request.
            while len(collected) < need:
                batch = min(TOPIC_PAGE_MAX, need - len(collected))
                result = await asyncio.wait_for(
                    client(
                        GetForumTopicsRequest(
                            peer=entity,
                            offset_date=offset_date,
                            offset_id=offset_id,
                            offset_topic=offset_topic,
                            limit=batch,
                            q="",
                        )
                    ),
                    timeout=20,
                )
                topics = list(getattr(result, "topics", None) or [])
                latest = {int(m.id): m for m in getattr(result, "messages", None) or [] if getattr(m, "id", None) is not None}
                for topic in topics:
                    top = latest.get(int(getattr(topic, "top_message", 0) or 0))
                    collected.append((topic, _topic_preview(top)))
                if len(topics) < batch:
                    break
                last = topics[-1]
                offset_id = int(getattr(last, "top_message", 0) or 0)
                offset_topic = int(getattr(last, "id", 0) or 0)
                offset_date = getattr(latest.get(offset_id), "date", None)
            return [normalize_topic(topic, preview) for topic, preview in collected[offset:need]]
        except Exception as exc:
            raise wrap_telegram_error(exc) from exc

    async def list_messages(
        self,
        chat_id: int,
        *,
        topic_id: Optional[int] = None,
        before_id: Optional[int] = None,
        after_id: Optional[int] = None,
        limit: int = 8,
    ) -> list[MessageSummary]:
        try:
            client = await self._get_client()
            entity = await self._get_entity(chat_id)
            kwargs: dict[str, Any] = {"limit": limit}
            if before_id is not None:
                kwargs["offset_id"] = before_id
            if after_id is not None:
                # Only messages newer than the one the phone already has (newest first, at most `limit`).
                kwargs["min_id"] = after_id
            if topic_id is not None:
                try:
                    from telethon.tl.functions.messages import GetRepliesRequest
                except ImportError as exc:
                    raise TelegramServiceError("Telethon replies API is unavailable") from exc

                result = await asyncio.wait_for(
                    client(
                        GetRepliesRequest(
                            peer=entity,
                            msg_id=topic_id,
                            offset_id=before_id or 0,
                            offset_date=None,
                            add_offset=0,
                            limit=limit,
                            max_id=0,
                            min_id=after_id or 0,
                            hash=0,
                        )
                    ),
                    timeout=20,
                )
                entities = [*getattr(result, "users", []), *getattr(result, "chats", [])]
                entities_by_peer = _entity_lookup(entities)
                for entity in entities:
                    self._cache_user_name(entity)
                messages = getattr(result, "messages", [])
                for message in messages:
                    self._cache_message_sender(message, entities_by_peer)
                summaries = [normalize_message(message, entities_by_peer) for message in messages]
                await attach_replies(
                    lambda ids: asyncio.wait_for(client.get_messages(entity, ids=ids), timeout=10),
                    list(messages),
                    summaries,
                    topic_id=topic_id,
                    cache=self._reply_cache,
                    chat_id=chat_id,
                )
                return summaries

            messages = await asyncio.wait_for(client.get_messages(entity, **kwargs), timeout=20)
            for message in messages:
                self._cache_message_sender(message)
            summaries = [normalize_message(message) for message in messages]
            await attach_replies(
                lambda ids: asyncio.wait_for(client.get_messages(entity, ids=ids), timeout=10),
                list(messages),
                summaries,
                cache=self._reply_cache,
                chat_id=chat_id,
            )
            return summaries
        except Exception as exc:
            raise wrap_telegram_error(exc) from exc

    async def get_photo(
        self,
        chat_id: int,
        message_id: int,
        *,
        max_width: int = 288,
        max_height: int = 120,
    ) -> PhotoResponse:
        key = (int(chat_id), int(message_id), int(max_width), int(max_height))
        cached = self._photo_cache.get(key)
        if cached is not None:
            self._photo_cache.move_to_end(key)
            return cached
        try:
            client = await self._get_client()
            entity = await self._get_entity(chat_id)
            message = await asyncio.wait_for(client.get_messages(entity, ids=int(message_id)), timeout=20)
            if message is None or not (_is_photo_message(message) or _is_sticker_message(message)):
                raise TelegramServiceError("Telegram message has no photo")
            if _is_sticker_message(message) and _sticker_is_static(message):
                # A static sticker is itself a small WebP picture: use the real file, unless it is not small.
                size = getattr(getattr(message, "file", None), "size", None)
                if isinstance(size, int) and size > MAX_SOURCE_BYTES:
                    raise TelegramServiceError("image is too large")
                raw = await asyncio.wait_for(client.download_media(message, file=bytes), timeout=40)
            else:
                # thumb=-1 is the largest size Telegram offers (photo, or the still preview of an animated sticker).
                raw = await asyncio.wait_for(client.download_media(message, file=bytes, thumb=-1), timeout=40)
            png, width, height = await asyncio.to_thread(prepare_glasses_image, raw or b"", max_width, max_height)
        except ImagingError as exc:
            raise TelegramServiceError(str(exc)) from exc
        except TelegramServiceError:
            raise
        except Exception as exc:
            raise wrap_telegram_error(exc) from exc
        photo = PhotoResponse(width=width, height=height, data=base64.b64encode(png).decode("ascii"))
        self._photo_cache[key] = photo
        while len(self._photo_cache) > PHOTO_CACHE_SIZE:
            self._photo_cache.popitem(last=False)
        return photo

    async def send_message(
        self,
        chat_id: int,
        *,
        text: str,
        topic_id: Optional[int] = None,
    ) -> SendMessageResponse:
        try:
            client = await self._get_client()
            entity = await self._get_entity(chat_id)
            kwargs: dict[str, Any] = {}
            if topic_id is not None:
                kwargs["reply_to"] = topic_id
            sent = await asyncio.wait_for(client.send_message(entity, text, **kwargs), timeout=20)
            return SendMessageResponse(id=int(getattr(sent, "id")))
        except Exception as exc:
            raise wrap_telegram_error(exc) from exc

    async def mark_read(
        self,
        chat_id: int,
        *,
        topic_id: Optional[int] = None,
        max_id: Optional[int] = None,
    ) -> None:
        try:
            client = await self._get_client()
            entity = await self._get_entity(chat_id)
            read_max_id = int(max_id or 0)
            if topic_id is not None:
                try:
                    from telethon.tl.functions.messages import ReadDiscussionRequest
                except ImportError as exc:
                    raise TelegramServiceError("Telethon discussion read API is unavailable") from exc

                await asyncio.wait_for(
                    client(ReadDiscussionRequest(peer=entity, msg_id=int(topic_id), read_max_id=read_max_id)),
                    timeout=20,
                )
                return
            await asyncio.wait_for(client.send_read_acknowledge(entity, max_id=read_max_id), timeout=20)
        except Exception as exc:
            raise wrap_telegram_error(exc) from exc
