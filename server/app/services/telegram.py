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
from app.services.imaging import ImagingError, prepare_glasses_image
from app.models import (
    ChatSummary,
    FolderSummary,
    MessageSummary,
    PhotoResponse,
    PhoneLoginStart,
    PhoneLoginStatus,
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



def _is_auth_key_error(exc: Exception) -> bool:
    name = exc.__class__.__name__
    return name in ("AuthKeyUnregisteredError", "AuthKeyDuplicatedError")


def wrap_telegram_error(exc: Exception) -> TelegramServiceError:
    if isinstance(exc, TimeoutError):
        return TelegramServiceTimeoutError("Telegram request timed out. Please retry.")
    if _is_auth_key_error(exc):
        return TelegramSessionExpiredError("Telegram session has expired. Reconnect in TeleGlance Settings.")
    return TelegramServiceError(str(exc) or exc.__class__.__name__)


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
        """Disconnect without logging out (the session string was handed to the owner)."""
        await self._discard_client()

    async def logout(self) -> None:
        ...

    async def list_chats(self, limit: int, offset: int = 0, folder_id: Optional[int] = None) -> list[ChatSummary]:
        ...

    async def list_folders(self) -> list[FolderSummary]:
        ...

    async def list_topics(self, chat_id: int) -> list[TopicSummary]:
        ...

    async def list_messages(
        self,
        chat_id: int,
        *,
        topic_id: Optional[int] = None,
        before_id: Optional[int] = None,
        limit: int = 8,
    ) -> list[MessageSummary]:
        ...

    async def get_photo(
        self,
        chat_id: int,
        message_id: int,
        *,
        max_width: int = 288,
        max_height: int = 144,
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

    def update_events(self) -> AsyncIterator[Union[TelegramUpdate, TypingUpdate]]:
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
PHOTO_CACHE_SIZE = 48


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


def normalize_message(message: Any, entities_by_peer: Optional[dict[int, Any]] = None) -> MessageSummary:
    sender = getattr(message, "sender", None)
    if sender is None and entities_by_peer:
        sender = entities_by_peer.get(_message_peer_key(message))
    sender_name = _display_name(sender) if sender is not None else None
    media = "photo" if _is_photo_message(message) else "sticker" if _is_sticker_message(message) else None
    text = _photo_text(message) if media == "photo" else "[sticker]" if media == "sticker" else _message_readable_text(message)
    return MessageSummary(
        id=int(getattr(message, "id")),
        sender=sender_name,
        text=text,
        sent_at=getattr(message, "date", None),
        outgoing=bool(getattr(message, "out", False)),
        media=media,
    )


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
    text = str(getattr(message, "message", None) or getattr(message, "raw_text", None) or "").strip()
    if not _message_has_unsupported_content(message):
        return text
    if text:
        return f"{text} [unsupported content]"
    return "[unsupported content]"


def _message_has_unsupported_content(message: Any) -> bool:
    return bool(getattr(message, "media", None) is not None or getattr(message, "action", None) is not None)


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
        self._update_queues: set[asyncio.Queue[Union[TelegramUpdate, TypingUpdate]]] = set()
        self._updates_registered = False
        self._entity_cache: dict[int, Any] = {}
        self._photo_cache: OrderedDict = OrderedDict()
        self._chat_requests: dict = {}
        self._dialog_lock = asyncio.Lock()
        self._user_name_cache: dict[int, str] = {}
        self._phone_code_hashes: dict[str, str] = {}
        self._dialog_snapshot: Optional[_DialogSnapshot] = None

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
            raise TelegramSessionExpiredError("Telegram session has expired. Reconnect in TeleGlance Settings.")
        if self._client is None:
            try:
                from telethon import TelegramClient
            except ImportError as exc:
                raise TelegramServiceError("Telethon is not installed. Install server requirements.") from exc

            try:
                from telethon.sessions import StringSession
            except ImportError as exc:
                raise TelegramServiceError("Telethon StringSession support is unavailable") from exc

            self._client = TelegramClient(
                StringSession((self.credentials.session_string if self.credentials else None) or ""),
                int(self.api_id or 0),
                self.api_hash or "",
            )
        if not self._client.is_connected():
            try:
                await self._client.connect()
            except ValueError as exc:
                if "cannot be reused after logging out" not in str(exc):
                    raise
                await self._discard_client()
                return await self._get_client()
            if self.credentials and self.credentials.session_string:
                try:
                    await asyncio.wait_for(self._client.get_me(), timeout=10)
                except Exception as exc:
                    if _is_auth_key_error(exc):
                        self._expired = True
                        await self._discard_client()
                        raise TelegramSessionExpiredError("Telegram session has expired. Reconnect in TeleGlance Settings.") from exc
        await self._ensure_update_handler()
        return self._client

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
        for queue in list(self._update_queues):
            try:
                queue.put_nowait(update)
            except asyncio.QueueFull:
                pass

    async def _handle_chat_action(self, event: Any) -> None:
        if not self._update_queues:
            return
        update = normalize_chat_action(event, self._typing_user_override(event))
        if update is None:
            return
        for queue in list(self._update_queues):
            try:
                queue.put_nowait(update)
            except asyncio.QueueFull:
                pass

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

    async def update_events(self) -> AsyncIterator[Union[TelegramUpdate, TypingUpdate]]:
        client = await self._get_client()
        if not await client.is_user_authorized():
            raise TelegramServiceError("Telegram session is not authorized")
        queue: asyncio.Queue[Union[TelegramUpdate, TypingUpdate]] = asyncio.Queue(maxsize=50)
        self._update_queues.add(queue)
        try:
            while True:
                yield await queue.get()
        finally:
            self._update_queues.discard(queue)

    async def auth_status(self) -> dict[str, bool]:
        if not self.configured:
            return {"configured": False, "authorized": False}
        client = await self._get_client()
        return {
            "configured": True,
            "authorized": bool(await client.is_user_authorized()),
        }

    async def start_phone_login(self, phone: str) -> PhoneLoginStart:
        if not self.configured:
            raise TelegramServiceError("Telegram API credentials are not configured")
        normalized_phone = phone.strip()
        client = await self._get_client()
        if await client.is_user_authorized():
            return PhoneLoginStart(phone=normalized_phone, sent=True, message="Telegram is already connected.")
        try:
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
        client = await self._get_client()
        if await client.is_user_authorized():
            return PhoneLoginStatus(authorized=True, session_string=self.current_session_string())
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
        return PhoneLoginStatus(
            authorized=bool(await client.is_user_authorized()),
            session_string=self.current_session_string(),
        )

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
        self._phone_code_hashes.clear()
        self._dialog_snapshot = None
        if client is None:
            return
        try:
            if client.is_connected():
                await client.disconnect()
        except Exception:
            pass

    async def logout(self) -> None:
        client = await self._get_client()
        try:
            if await client.is_user_authorized():
                await client.log_out()
        finally:
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
        client = await self._get_client()
        try:
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
        async for dialog in client.iter_dialogs():
            scanned.append(dialog)
            if dialog_matches_filter(dialog_filter, dialog):
                found += 1
                if found >= target:
                    exhausted = False
                    break
        self._store_head(scanned, exhausted)
        snapshot = self._dialog_snapshot
        matches = [dialog for dialog in snapshot.dialogs if dialog_matches_filter(dialog_filter, dialog)]
        return matches[offset:need]

    async def list_folders(self) -> list[FolderSummary]:
        client = await self._get_client()
        try:
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
        cached = getattr(self, "_folder_cache", None)
        now = asyncio.get_running_loop().time()
        if cached and now - cached[0] < 60:
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

    async def list_topics(self, chat_id: int) -> list[TopicSummary]:
        client = await self._get_client()
        try:
            from telethon.tl.functions.messages import GetForumTopicsRequest
        except ImportError as exc:
            raise TelegramServiceError("Telethon forum topic API is unavailable") from exc

        try:
            entity = await self._get_entity(chat_id)
            result = await asyncio.wait_for(
                client(
                    GetForumTopicsRequest(
                        peer=entity,
                        offset_date=None,
                        offset_id=0,
                        offset_topic=0,
                        limit=20,
                        q="",
                    )
                ),
                timeout=20,
            )
            topics = getattr(result, "topics", [])
            return [normalize_topic(topic) for topic in topics]
        except Exception as exc:
            raise wrap_telegram_error(exc) from exc

    async def list_messages(
        self,
        chat_id: int,
        *,
        topic_id: Optional[int] = None,
        before_id: Optional[int] = None,
        limit: int = 8,
    ) -> list[MessageSummary]:
        client = await self._get_client()
        try:
            entity = await self._get_entity(chat_id)
            kwargs: dict[str, Any] = {"limit": limit}
            if before_id is not None:
                kwargs["offset_id"] = before_id
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
                            min_id=0,
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
                return [normalize_message(message, entities_by_peer) for message in messages]

            messages = await asyncio.wait_for(client.get_messages(entity, **kwargs), timeout=20)
            for message in messages:
                self._cache_message_sender(message)
            return [normalize_message(message) for message in messages]
        except Exception as exc:
            raise wrap_telegram_error(exc) from exc

    async def get_photo(
        self,
        chat_id: int,
        message_id: int,
        *,
        max_width: int = 288,
        max_height: int = 144,
    ) -> PhotoResponse:
        key = (int(chat_id), int(message_id), int(max_width), int(max_height))
        cached = self._photo_cache.get(key)
        if cached is not None:
            self._photo_cache.move_to_end(key)
            return cached
        client = await self._get_client()
        try:
            entity = await self._get_entity(chat_id)
            message = await asyncio.wait_for(client.get_messages(entity, ids=int(message_id)), timeout=20)
            if message is None or not (_is_photo_message(message) or _is_sticker_message(message)):
                raise TelegramServiceError("Telegram message has no photo")
            if _is_sticker_message(message) and _sticker_is_static(message):
                # A static sticker is itself a small WebP picture: use the real file.
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
        client = await self._get_client()
        try:
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
        client = await self._get_client()
        try:
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
