"""Turns the non-text parts of a Telegram message into small, glasses-friendly values.

Everything here is defensive: Telethon objects vary by layer and message kind, so each helper uses
getattr with defaults and never raises on an unexpected shape.
"""

from typing import Any, Optional
from urllib.parse import urlparse

from app.models import LinkInfo, PollInfo, PollOption

PREVIEW_CHARS = 40


def _text_of(value: Any) -> str:
    # Newer layers wrap strings in TextWithEntities(text=...); older ones use a plain str.
    inner = getattr(value, "text", value)
    return str(inner or "").strip()


def _media_kind(message: Any) -> str:
    return type(getattr(message, "media", None)).__name__


def format_duration(seconds: Any) -> str:
    try:
        total = int(float(seconds))
    except (TypeError, ValueError):
        return ""
    if total < 0:
        return ""
    return f"{total // 60}:{total % 60:02d}"


def _file_duration(message: Any) -> str:
    return format_duration(getattr(getattr(message, "file", None), "duration", None))


def media_label(message: Any) -> Optional[str]:
    tag = _media_tag(message)
    return f"[{tag}]" if tag else None


def _media_tag(message: Any) -> Optional[str]:
    """Short tag for content the glasses cannot show, e.g. "[voice 0:12]". None when there is nothing to label."""
    kind = _media_kind(message)
    if kind in ("NoneType", "MessageMediaPhoto", "MessageMediaPoll", "MessageMediaWebPage"):
        return None
    if getattr(message, "voice", None) is not None:
        return _join_label("voice", _file_duration(message))
    if getattr(message, "video_note", None) is not None:
        return _join_label("video note", _file_duration(message))
    if getattr(message, "gif", None) is not None:
        return "GIF"
    if getattr(message, "video", None) is not None:
        return _join_label("video", _file_duration(message))
    if getattr(message, "audio", None) is not None:
        audio = getattr(message, "file", None)
        title = str(getattr(audio, "title", None) or "").strip()
        performer = str(getattr(audio, "performer", None) or "").strip()
        name = " - ".join(part for part in (performer, title) if part)
        return _join_label("audio", _file_duration(message), name[:24])
    if kind in ("MessageMediaGeo", "MessageMediaGeoLive"):
        return "location live" if kind == "MessageMediaGeoLive" else "location"
    if kind == "MessageMediaVenue":
        title = str(getattr(getattr(message, "media", None), "title", None) or "").strip()
        return _join_label("location", title[:24])
    if kind == "MessageMediaContact":
        media = getattr(message, "media", None)
        name = f"{getattr(media, 'first_name', '') or ''} {getattr(media, 'last_name', '') or ''}".strip()
        return _join_label("contact", name[:24])
    if kind == "MessageMediaDice":
        media = getattr(message, "media", None)
        return _join_label("dice", str(getattr(media, "emoticon", "") or ""), str(getattr(media, "value", "") or ""))
    if kind == "MessageMediaDocument":
        name = str(getattr(getattr(message, "file", None), "name", None) or "").strip()
        return _join_label("file", name[:28])
    if kind == "MessageMediaGame":
        return "game"
    if kind == "MessageMediaInvoice":
        return "invoice"
    if kind == "MessageMediaStory":
        return "story"
    return "unsupported content"


def _join_label(*parts: str) -> str:
    return " ".join(part for part in parts if part)


def poll_info(message: Any) -> Optional[PollInfo]:
    if _media_kind(message) != "MessageMediaPoll":
        return None
    media = getattr(message, "media", None)
    poll = getattr(media, "poll", None)
    if poll is None:
        return None
    results = getattr(media, "results", None)
    by_option = {}
    for entry in getattr(results, "results", None) or []:
        by_option[bytes(getattr(entry, "option", b""))] = entry
    total = getattr(results, "total_voters", None)
    if total is None and by_option:
        total = sum(int(getattr(entry, "voters", 0) or 0) for entry in by_option.values())
    options = []
    for answer in getattr(poll, "answers", None) or []:
        entry = by_option.get(bytes(getattr(answer, "option", b"")))
        voters = int(getattr(entry, "voters", 0) or 0) if entry is not None else None
        percent = round(voters * 100 / total) if voters is not None and total else None
        options.append(
            PollOption(
                text=_text_of(getattr(answer, "text", "")),
                percent=percent,
                voters=voters,
                chosen=bool(getattr(entry, "chosen", False)),
                correct=bool(getattr(entry, "correct", False)),
            )
        )
    return PollInfo(
        question=_text_of(getattr(poll, "question", "")),
        options=options,
        total_voters=int(total) if total is not None else None,
        closed=bool(getattr(poll, "closed", False)),
        quiz=bool(getattr(poll, "quiz", False)),
        multiple=bool(getattr(poll, "multiple_choice", False)),
    )


def _domain_of(url: str) -> Optional[str]:
    if not url:
        return None
    parsed = urlparse(url if "//" in url else f"//{url}")
    host = (parsed.hostname or "").lower()
    return host[4:] if host.startswith("www.") else host or None


def link_info(message: Any) -> Optional[LinkInfo]:
    if _media_kind(message) != "MessageMediaWebPage":
        return None
    page = getattr(getattr(message, "media", None), "webpage", None)
    if page is None or type(page).__name__ in ("WebPageEmpty", "WebPagePending", "WebPageNotModified"):
        return None
    title = str(getattr(page, "title", None) or getattr(page, "site_name", None) or "").strip() or None
    description = " ".join(str(getattr(page, "description", None) or "").split()) or None
    domain = _domain_of(str(getattr(page, "display_url", None) or getattr(page, "url", None) or ""))
    if not (title or description):
        return None
    return LinkInfo(title=title, domain=domain, description=description)


def forwarded_from(message: Any) -> Optional[str]:
    header = getattr(message, "fwd_from", None)
    if header is None:
        return None
    name = str(getattr(header, "from_name", None) or "").strip()
    if not name:
        forward = getattr(message, "forward", None)
        source = getattr(forward, "chat", None) or getattr(forward, "sender", None)
        title = getattr(source, "title", None)
        if title:
            name = str(title)
        elif source is not None:
            first = getattr(source, "first_name", "") or ""
            last = getattr(source, "last_name", "") or ""
            name = f"{first} {last}".strip() or (f"@{source.username}" if getattr(source, "username", None) else "")
    return name or "unknown"


def reply_target_id(message: Any, topic_id: Optional[int] = None) -> Optional[int]:
    """Id of the message this one replies to, or None.

    Forum topics make Telegram fill reply_to for every message in the topic (pointing at the topic root),
    which is not a real reply.
    """
    header = getattr(message, "reply_to", None)
    target = getattr(header, "reply_to_msg_id", None)
    if target is None:
        return None
    target = int(target)
    if getattr(header, "reply_to_top_id", None) is None and getattr(header, "forum_topic", False):
        return None
    if topic_id is not None and target == int(topic_id):
        return None
    return target


def reply_preview(message: Any) -> str:
    """One short line describing a message that is being replied to."""
    text = " ".join(str(getattr(message, "message", None) or "").split())
    if not text:
        if type(getattr(message, "media", None)).__name__ == "MessageMediaPhoto":
            text = "[photo]"
        elif getattr(message, "sticker", None) is not None:
            text = "[sticker]"
        else:
            text = media_label(message) or ""
    return text if len(text) <= PREVIEW_CHARS else text[: PREVIEW_CHARS - 2].rstrip() + ".."
