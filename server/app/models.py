from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


def to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class AuthStatus(ApiModel):
    configured: bool
    authorized: bool


class PhoneLoginStartRequest(ApiModel):
    phone: str = Field(min_length=5)


class PhoneLoginStart(ApiModel):
    phone: str
    sent: bool = True
    message: Optional[str] = None
    phone_code_hash: Optional[str] = None


class PhoneLoginVerifyRequest(ApiModel):
    phone: str = Field(min_length=5)
    code: Optional[str] = None
    phone_code_hash: Optional[str] = None
    password: Optional[str] = None


class PhoneLoginStatus(ApiModel):
    authorized: bool
    message: Optional[str] = None
    session_string: Optional[str] = None
    password_required: bool = False


class ChatSummary(ApiModel):
    id: int
    title: str
    kind: Literal["user", "group", "channel"]
    unread_count: int = 0
    is_forum: bool = False
    last_message: Optional[str] = None


class FolderSummary(ApiModel):
    id: int
    title: str


class TopicSummary(ApiModel):
    id: int
    title: str
    top_message_id: int
    unread_count: int = 0
    last_message: Optional[str] = None


class ReplyInfo(ApiModel):
    message_id: int
    sender: Optional[str] = None
    preview: str = ""


class PollOption(ApiModel):
    text: str
    percent: Optional[int] = None
    voters: Optional[int] = None
    chosen: bool = False
    correct: bool = False


class PollInfo(ApiModel):
    question: str
    options: list[PollOption] = []
    total_voters: Optional[int] = None
    closed: bool = False
    quiz: bool = False
    multiple: bool = False


class LinkInfo(ApiModel):
    title: Optional[str] = None
    domain: Optional[str] = None
    description: Optional[str] = None


class MessageSummary(ApiModel):
    id: int
    sender: Optional[str] = None
    text: str
    sent_at: Optional[datetime] = None
    outgoing: bool = False
    media: Optional[str] = None  # "photo" or "sticker" when the message carries a picture the glasses can show
    reply_to: Optional[ReplyInfo] = None
    forwarded_from: Optional[str] = None
    poll: Optional[PollInfo] = None
    link: Optional[LinkInfo] = None


class PhotoResponse(ApiModel):
    width: int
    height: int
    format: str = "png"
    data: str  # base64


class TelegramUpdate(ApiModel):
    type: Literal["message"] = "message"
    chat_id: int
    topic_id: Optional[int] = None
    message: MessageSummary



class TypingUpdate(ApiModel):
    type: Literal["typing"] = "typing"
    chat_id: int
    topic_id: Optional[int] = None
    user_name: Optional[str] = None
    action: Literal["typing", "cancel"] = "typing"

class ResyncUpdate(ApiModel):
    """Sent when a burst overflowed the stream's queue: the phone must refetch what it is showing."""

    type: Literal["resync"] = "resync"


class SendMessageRequest(ApiModel):
    text: str = Field(min_length=1)
    topic_id: Optional[int] = None


class SendMessageResponse(ApiModel):
    id: int
    status: Literal["sent"] = "sent"


class MarkReadRequest(ApiModel):
    topic_id: Optional[int] = None
    max_id: Optional[int] = None


class MarkReadResponse(ApiModel):
    status: Literal["ok"] = "ok"


class TranscriptionResponse(ApiModel):
    text: str
    language: Optional[str] = None
    duration_seconds: Optional[float] = None


class DebugEvent(ApiModel):
    source: str = "web"
    build_version: Optional[str] = None
    raw: Any
    mapped: Any = None
    note: Optional[str] = None
