"""Pure Telethon-to-API normalisation: turn Telegram entities, dialogs, messages and events into API models.

No network and no service state here (attach_replies only calls the lookup it is given), so these helpers are
easy to test on their own. app.services.telegram re-exports them for existing callers.
"""
import logging
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any, Literal, Optional

from app.models import ChatSummary, MessageSummary, ReplyInfo, TelegramUpdate, TopicSummary, TypingUpdate
from app.services.message_content import forwarded_from, link_info, media_label, poll_info, reply_preview, reply_target_id, rich_text, service_text

REPLY_CACHE_CHATS = 16
REPLY_CACHE_PER_CHAT = 200


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
