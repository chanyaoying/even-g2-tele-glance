import asyncio
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import json
import logging
import time
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse

from app.config import Settings, get_settings
from app.dependencies import discard_pending_telegram_service, get_telegram_service, get_transcription_service, validate_backend_auth
from app.models import (
    AuthStatus,
    ChatSummary,
    FolderSummary,
    DebugEvent,
    MessageSummary,
    PhotoResponse,
    MarkReadRequest,
    MarkReadResponse,
    PhoneLoginStart,
    PhoneLoginStartRequest,
    PhoneLoginStatus,
    PhoneLoginVerifyRequest,
    SendMessageRequest,
    SendMessageResponse,
    ResyncUpdate,
    TopicSummary,
    TelegramUpdate,
    TranscriptionResponse,
    TypingUpdate,
)
from app.services.audio import pcm16le_to_wav
from app.services.secure_auth import SecureAuthError, decrypt_payload, encrypt_payload
from app.services.telegram import TelegramService, TelegramServiceError, TelegramRateLimitError, TelegramServiceTimeoutError, TelegramSessionExpiredError
from app.services.transcription import TranscriptionServiceError, WhisperTranscriptionService

# Seconds of silence before the update stream sends a keepalive comment; the phone treats ~3x this as dead.
STREAM_KEEPALIVE_SECONDS = 15.0
timing_logger = logging.getLogger("uvicorn.error")


def raise_telegram_http_error(exc: Exception) -> None:
    if isinstance(exc, TelegramSessionExpiredError):
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    if isinstance(exc, TelegramRateLimitError):
        raise HTTPException(status_code=429, detail=str(exc), headers={"Retry-After": str(exc.seconds)}) from exc
    if isinstance(exc, (TelegramServiceTimeoutError, TimeoutError)):
        raise HTTPException(status_code=504, detail=str(exc) or "Telegram request timed out. Please retry.") from exc
    raise HTTPException(status_code=400, detail=str(exc)) from exc


def create_app(settings: Optional[Settings] = None) -> FastAPI:
    app_settings = settings or get_settings()
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if app_settings.whisper_preload:
            # Warm the model in the background so the first recording after a restart is not slow.
            _app.state.preload_task = asyncio.create_task(get_transcription_service().preload())
        yield

    api = FastAPI(title="TeleGlance Backend", lifespan=lifespan)
    debug_events: deque[dict] = deque(maxlen=100)
    api.add_middleware(
        CORSMiddleware,
        allow_origins=app_settings.backend_cors_origins,
        allow_origin_regex=app_settings.backend_cors_origin_regex,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-TeleGlance-Encrypted", "Server-Timing", "Retry-After"],
    )

    async def require_app_backend_auth(request: Request) -> None:
        validate_backend_auth(request.headers.get("X-TeleGlance-Auth"), app_settings.teleglance_shared_secret)

    @api.middleware("http")
    async def encrypted_json_payloads(request: Request, call_next):
        shared_secret = app_settings.teleglance_shared_secret
        encrypted_auth = request.headers.get("X-TeleGlance-Auth")
        should_encrypt = bool(shared_secret and encrypted_auth and request.url.path.startswith("/api/"))

        if should_encrypt and _requires_encrypted_body(request):
            try:
                raw_body = await request.body()
                if raw_body:
                    envelope = json.loads(raw_body.decode("utf-8"))
                    encrypted_body = envelope.get("encryptedPayload") if isinstance(envelope, dict) else None
                    if not isinstance(encrypted_body, str):
                        return JSONResponse({"detail": "Encrypted JSON request body is required"}, status_code=400)
                    decrypted = decrypt_payload(encrypted_body, shared_secret)
                    request = _replace_request_body(request, decrypted)
            except (json.JSONDecodeError, UnicodeDecodeError, SecureAuthError) as exc:
                return JSONResponse({"detail": str(exc)}, status_code=400)

        started = time.perf_counter()
        response = await call_next(request)
        handled_ms = (time.perf_counter() - started) * 1000
        if request.url.path.startswith("/api/") and request.url.path != "/api/updates":
            # Lets the phone tell server time from network time (readable via Server-Timing / DevTools).
            response.headers["Server-Timing"] = f"app;dur={handled_ms:.0f}"
            # Handler time (Telegram + normalising), excluding wire transfer; shows where a slow load went.
            timing_logger.info("%s %s -> %s in %.0f ms", request.method, request.url.path, response.status_code, handled_ms)
        if not should_encrypt or not _is_json_response(response):
            return response

        body = b""
        async for chunk in response.body_iterator:
            body += chunk
        encrypted = encrypt_payload(body, shared_secret)
        headers = dict(response.headers)
        headers.pop("content-length", None)
        headers["X-TeleGlance-Encrypted"] = "1"
        return JSONResponse(
            {"encryptedPayload": encrypted},
            status_code=response.status_code,
            headers=headers,
        )

    @api.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @api.post("/api/debug/events", dependencies=[Depends(require_app_backend_auth)])
    async def append_debug_event(payload: DebugEvent) -> dict[str, int]:
        event = payload.model_dump(mode="json")
        mapped = event.get("mapped") or {}
        if mapped.get("type") == "audioChunk":
            return {"count": len(debug_events)}
        event["received_at"] = datetime.now(timezone.utc).isoformat()
        debug_events.append(event)
        return {"count": len(debug_events)}

    @api.get("/api/debug/events", dependencies=[Depends(require_app_backend_auth)])
    async def list_debug_events() -> list[dict]:
        return list(debug_events)

    @api.delete("/api/debug/events", dependencies=[Depends(require_app_backend_auth)])
    async def clear_debug_events() -> dict[str, int]:
        debug_events.clear()
        return {"count": 0}

    @api.get("/api/session/status", response_model=AuthStatus)
    async def session_status(
        telegram: TelegramService = Depends(get_telegram_service),
    ) -> AuthStatus:
        try:
            return AuthStatus(**await telegram.auth_status())
        except (TelegramServiceError, TimeoutError) as exc:
            raise_telegram_http_error(exc)

    @api.post("/api/session/phone/start", response_model=PhoneLoginStart)
    async def start_phone_login(
        payload: PhoneLoginStartRequest,
        telegram: TelegramService = Depends(get_telegram_service),
    ) -> PhoneLoginStart:
        try:
            return await telegram.start_phone_login(payload.phone)
        except (TelegramServiceError, TimeoutError) as exc:
            raise_telegram_http_error(exc)

    @api.post("/api/session/phone/verify", response_model=PhoneLoginStatus)
    async def verify_phone_login(
        payload: PhoneLoginVerifyRequest,
        telegram: TelegramService = Depends(get_telegram_service),
    ) -> PhoneLoginStatus:
        try:
            status = await telegram.complete_phone_login(payload.phone, payload.code or "", payload.phone_code_hash, payload.password)
            if _login_finished(status):
                # The session now belongs to this caller; do not leave the signed-in client in the
                # pending cache where another caller with the same api_id/api_hash could reuse it.
                discarded = discard_pending_telegram_service(telegram)
                close = getattr(discarded, "close", None)
                if close is not None:
                    await close()
            return status
        except (TelegramServiceError, TimeoutError) as exc:
            raise_telegram_http_error(exc)

    @api.post("/api/session/logout")
    async def logout_session(
        telegram: TelegramService = Depends(get_telegram_service),
    ) -> dict[str, str]:
        try:
            await telegram.logout()
            return {"status": "ok"}
        except (TelegramServiceError, TimeoutError) as exc:
            raise_telegram_http_error(exc)

    @api.get("/api/chats", response_model=list[ChatSummary])
    async def list_chats(
        limit: int = Query(default=5, ge=1, le=20),
        offset: int = Query(default=0, ge=0, le=5000),
        folder_id: Optional[int] = Query(default=None, ge=1),
        telegram: TelegramService = Depends(get_telegram_service),
    ) -> list[ChatSummary]:
        try:
            return await telegram.list_chats(limit=limit, offset=offset, folder_id=folder_id)
        except (TelegramServiceError, TimeoutError) as exc:
            raise_telegram_http_error(exc)

    @api.get("/api/folders", response_model=list[FolderSummary])
    async def list_folders(
        telegram: TelegramService = Depends(get_telegram_service),
    ) -> list[FolderSummary]:
        try:
            return await telegram.list_folders()
        except (TelegramServiceError, TimeoutError) as exc:
            raise_telegram_http_error(exc)

    @api.get("/api/chats/{chat_id}/topics", response_model=list[TopicSummary])
    async def list_topics(
        chat_id: int,
        telegram: TelegramService = Depends(get_telegram_service),
    ) -> list[TopicSummary]:
        try:
            return await telegram.list_topics(chat_id)
        except (TelegramServiceError, TimeoutError) as exc:
            raise_telegram_http_error(exc)

    @api.get("/api/chats/{chat_id}/messages", response_model=list[MessageSummary])
    async def list_messages(
        chat_id: int,
        topic_id: Optional[int] = None,
        before_id: Optional[int] = None,
        after_id: Optional[int] = None,
        limit: int = Query(default=8, ge=1, le=50),
        telegram: TelegramService = Depends(get_telegram_service),
    ) -> list[MessageSummary]:
        extra = {"after_id": after_id} if after_id is not None else {}
        try:
            return await telegram.list_messages(
                chat_id,
                topic_id=topic_id,
                before_id=before_id,
                limit=limit,
                **extra,
            )
        except (TelegramServiceError, TimeoutError) as exc:
            raise_telegram_http_error(exc)

    @api.get("/api/updates")
    async def stream_updates(
        request: Request,
        telegram: TelegramService = Depends(get_telegram_service),
    ) -> StreamingResponse:
        encrypt_events = bool(app_settings.teleglance_shared_secret and request.headers.get("X-TeleGlance-Auth"))

        def event_data(payload: str) -> str:
            if not encrypt_events:
                return payload
            encrypted = encrypt_payload(payload.encode("utf-8"), app_settings.teleglance_shared_secret or "")
            return json.dumps({"encryptedPayload": encrypted})

        async def events():
            updates = telegram.update_events().__aiter__()
            pending: Optional[asyncio.Future] = None
            try:
                while True:
                    if pending is None:
                        pending = asyncio.ensure_future(updates.__anext__())
                    done, _ = await asyncio.wait({pending}, timeout=STREAM_KEEPALIVE_SECONDS)
                    if not done:
                        # A comment line: ignored by the phone's parser, but it proves the connection is alive
                        # and stops proxies and phones from silently dropping an idle stream.
                        yield ": keepalive\n\n"
                        continue
                    future, pending = pending, None
                    try:
                        update = future.result()
                    except StopAsyncIteration:
                        return
                    payload = update.model_dump_json(by_alias=True)
                    if isinstance(update, ResyncUpdate):
                        yield f"event: resync\ndata: {event_data(payload)}\n\n"
                    elif isinstance(update, TypingUpdate):
                        yield f"event: typing\ndata: {event_data(payload)}\n\n"
                    else:
                        yield f"event: message\ndata: {event_data(payload)}\n\n"
            except TelegramServiceError as exc:
                payload = json.dumps({"detail": str(exc)})
                yield f"event: error\ndata: {event_data(payload)}\n\n"
            finally:
                if pending is not None:
                    pending.cancel()
                aclose = getattr(updates, "aclose", None)
                if aclose is not None:
                    await aclose()

        return StreamingResponse(
            events(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-store",
                "Connection": "keep-alive",
            },
        )

    @api.get("/api/chats/{chat_id}/messages/{message_id}/photo", response_model=PhotoResponse)
    async def get_photo(
        chat_id: int,
        message_id: int,
        max_width: int = Query(default=288, ge=20, le=288),
        max_height: int = Query(default=120, ge=20, le=144),
        telegram: TelegramService = Depends(get_telegram_service),
    ) -> PhotoResponse:
        try:
            return await telegram.get_photo(chat_id, message_id, max_width=max_width, max_height=max_height)
        except (TelegramServiceError, TimeoutError) as exc:
            raise_telegram_http_error(exc)

    @api.post("/api/chats/{chat_id}/messages", response_model=SendMessageResponse)
    async def send_message(
        chat_id: int,
        payload: SendMessageRequest,
        telegram: TelegramService = Depends(get_telegram_service),
    ) -> SendMessageResponse:
        try:
            return await telegram.send_message(chat_id, text=payload.text, topic_id=payload.topic_id)
        except (TelegramServiceError, TimeoutError) as exc:
            raise_telegram_http_error(exc)

    @api.post("/api/chats/{chat_id}/read", response_model=MarkReadResponse)
    async def mark_read(
        chat_id: int,
        payload: MarkReadRequest,
        telegram: TelegramService = Depends(get_telegram_service),
    ) -> MarkReadResponse:
        try:
            await telegram.mark_read(chat_id, topic_id=payload.topic_id, max_id=payload.max_id)
            return MarkReadResponse()
        except (TelegramServiceError, TimeoutError) as exc:
            raise_telegram_http_error(exc)

    @api.post("/api/transcribe", response_model=TranscriptionResponse, dependencies=[Depends(require_app_backend_auth)])
    async def transcribe(
        audio: UploadFile = File(...),
        language: str = Form(""),
        transcription: WhisperTranscriptionService = Depends(get_transcription_service),
    ) -> TranscriptionResponse:
        max_bytes = app_settings.transcribe_max_upload_bytes
        raw = await audio.read(max_bytes + 1)
        if len(raw) > max_bytes:
            raise HTTPException(status_code=413, detail="audio upload is too large")
        try:
            if audio.content_type in {"audio/pcm", "application/octet-stream"}:
                raw = pcm16le_to_wav(raw)
            return await transcription.transcribe_wav(raw, language=language or None)
        except (ValueError, TranscriptionServiceError) as exc:
            timing_logger.warning("transcribe rejected (%d bytes): %s", len(raw), exc)
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"transcription failed: {exc}") from exc

    return api


app = create_app()


def _login_finished(status: object) -> bool:
    if isinstance(status, dict):
        return bool(status.get("authorized") and (status.get("session_string") or status.get("sessionString")))
    return bool(getattr(status, "authorized", False) and getattr(status, "session_string", None))


ENCRYPTED_BODY_EXEMPT_PATHS = {"/api/transcribe"}  # multipart audio upload; authenticated by header only


def _requires_encrypted_body(request: Request) -> bool:
    """Every mutating /api request that carries an auth header must send an encrypted JSON envelope.

    This deliberately does not look at Content-Type: FastAPI parses application/json and
    application/*+json case-insensitively, so a Content-Type-based gate can be bypassed.
    """
    return request.method in {"POST", "PUT", "PATCH"} and request.url.path not in ENCRYPTED_BODY_EXEMPT_PATHS


def _is_json_response(response: Response) -> bool:
    content_type = response.headers.get("content-type", "")
    return content_type.startswith("application/json")


def _replace_request_body(request: Request, body: bytes) -> Request:
    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    request._receive = receive  # type: ignore[attr-defined]
    request._body = body  # type: ignore[attr-defined]
    headers = [
        (name, value)
        for name, value in request.scope.get("headers", [])
        if name.lower() != b"content-length"
    ]
    headers.append((b"content-length", str(len(body)).encode("ascii")))
    request.scope["headers"] = headers
    return request
