from collections import OrderedDict
from functools import lru_cache
import hashlib
import logging
import threading
import time
from typing import Annotated, Optional

from fastapi import Header, HTTPException

from app.config import get_settings
from app.services.secure_auth import SecureAuthError, decrypt_auth_header
from app.services.telegram import TelegramClientCredentials, TelethonTelegramService, TelegramService
from app.services.transcription import WhisperTranscriptionService

logger = logging.getLogger(__name__)
# Machine-readable reason on 401s, so the phone need not match detail text: "backend_auth" (shared secret /
# encrypted auth header rejected) or "session_expired" (the Telegram session is gone; sign in again).
ERROR_CODE_HEADER = "X-TeleGlance-Error"
BACKEND_AUTH_ERROR_HEADERS = {ERROR_CODE_HEADER: "backend_auth"}
SESSION_EXPIRED_ERROR_HEADERS = {ERROR_CODE_HEADER: "session_expired"}

# Each cached service owns a connected Telethon client, an update loop and per-account caches, so the caches
# are bounded and idle entries are closed (not just forgotten). FastAPI runs these sync dependencies in a
# worker thread, hence the lock; closing happens on the event loop in sweep_telegram_services().
_telegram_services: "OrderedDict[str, tuple[float, TelegramService]]" = OrderedDict()
_pending_telegram_services: dict[str, tuple[float, TelegramService]] = {}
_services_to_close: list[TelegramService] = []
_cache_lock = threading.Lock()
PENDING_TELEGRAM_SERVICE_TTL_SECONDS = 10 * 60
MAX_PENDING_TELEGRAM_SERVICES = 16
MAX_TELEGRAM_SERVICES = 32
IDLE_TELEGRAM_SERVICE_SECONDS = 30 * 60
# An expired session holds no client; dropping it soon lets a re-login start from a clean service.
EXPIRED_TELEGRAM_SERVICE_SECONDS = 60
SWEEP_INTERVAL_SECONDS = 60


def get_telegram_service(
    x_teleglance_auth: Annotated[Optional[str], Header(alias="X-TeleGlance-Auth")] = None,
) -> TelegramService:
    settings = get_settings()
    credentials = telegram_credentials_from_encrypted_header(x_teleglance_auth, settings.teleglance_shared_secret)
    if credentials is not None and not credentials.session_string:
        return get_pending_telegram_service(settings, credentials)
    cache_key = telegram_service_cache_key(credentials)
    now = time.monotonic()
    with _cache_lock:
        cached = _telegram_services.get(cache_key)
        service = cached[1] if cached is not None else TelethonTelegramService(settings, credentials)
        _telegram_services[cache_key] = (now, service)
        _telegram_services.move_to_end(cache_key)
        _evict_over_capacity(keep=cache_key)
    return service


def get_pending_telegram_service(settings, credentials: TelegramClientCredentials) -> TelegramService:
    now = time.monotonic()
    cache_key = telegram_service_cache_key(credentials)
    with _cache_lock:
        _evict_expired_pending(now)
        cached = _pending_telegram_services.get(cache_key)
        if cached is not None:
            return cached[1]
        service = TelethonTelegramService(settings, credentials)
        _pending_telegram_services[cache_key] = (now, service)
        while len(_pending_telegram_services) > MAX_PENDING_TELEGRAM_SERVICES:
            oldest = min(_pending_telegram_services, key=lambda key: _pending_telegram_services[key][0])
            _services_to_close.append(_pending_telegram_services.pop(oldest)[1])
    return service


def _evict_expired_pending(now: float) -> None:
    for key, (created_at, service) in list(_pending_telegram_services.items()):
        if now - created_at > PENDING_TELEGRAM_SERVICE_TTL_SECONDS:
            _pending_telegram_services.pop(key, None)
            _services_to_close.append(service)


def _subscribers(service: TelegramService) -> int:
    return int(getattr(service, "subscriber_count", 0) or 0)


def _evict_over_capacity(keep: str) -> None:
    """Least recently used first; the requested service and any with an open update stream stay, even over the cap."""
    excess = len(_telegram_services) - MAX_TELEGRAM_SERVICES
    for key in list(_telegram_services):
        if excess <= 0:
            break
        service = _telegram_services[key][1]
        if key == keep or _subscribers(service):
            continue
        _telegram_services.pop(key)
        _services_to_close.append(service)
        excess -= 1


async def sweep_telegram_services(now: Optional[float] = None) -> int:
    """Close services that are idle (no request and no stream for a while), expired or already evicted.

    Returns how many services were closed.
    """
    now = time.monotonic() if now is None else now
    with _cache_lock:
        _evict_expired_pending(now)
        for key, (last_used, service) in list(_telegram_services.items()):
            idle = now - last_used
            expired = bool(getattr(service, "expired", False))
            if (expired and idle > EXPIRED_TELEGRAM_SERVICE_SECONDS) or (
                idle > IDLE_TELEGRAM_SERVICE_SECONDS and not _subscribers(service)
            ):
                _telegram_services.pop(key)
                _services_to_close.append(service)
        to_close = list(_services_to_close)
        _services_to_close.clear()
    for service in to_close:
        await _close_service(service)
    return len(to_close)


async def close_all_telegram_services() -> None:
    with _cache_lock:
        to_close = [service for _used, service in _telegram_services.values()]
        to_close += [service for _created, service in _pending_telegram_services.values()]
        to_close += _services_to_close
        _telegram_services.clear()
        _pending_telegram_services.clear()
        _services_to_close.clear()
    for service in to_close:
        await _close_service(service)


async def _close_service(service: TelegramService) -> None:
    close = getattr(service, "close", None)
    if close is None:
        return
    try:
        await close()
    except Exception:
        logger.warning("closing a Telegram service failed", exc_info=True)


def discard_pending_telegram_service(service: TelegramService) -> Optional[TelegramService]:
    """Drop a pending phone-login service from the shared cache once its login is finished.

    The pending cache is keyed by api_id/api_hash only, so a service that has signed in must not stay
    reachable to the next caller using the same credentials.
    """
    with _cache_lock:
        for key, (_created_at, cached) in list(_pending_telegram_services.items()):
            if cached is service:
                _pending_telegram_services.pop(key, None)
                return cached
    return None


def forget_telegram_service(service: TelegramService) -> None:
    """Remove a service from both caches (after logout); the caller has already closed it."""
    with _cache_lock:
        for cache in (_telegram_services, _pending_telegram_services):
            for key, (_stamp, cached) in list(cache.items()):
                if cached is service:
                    cache.pop(key, None)


def telegram_credentials_from_encrypted_header(
    encrypted_auth: Optional[str],
    shared_secret: Optional[str],
) -> Optional[TelegramClientCredentials]:
    if not shared_secret:
        raise HTTPException(status_code=400, detail="Backend shared secret is required. Set TELEGLANCE_SHARED_SECRET in backend .env and the same value in TeleGlance Settings.")
    if not encrypted_auth or not encrypted_auth.strip():
        raise HTTPException(status_code=400, detail="Encrypted auth is required. Fill Backend shared secret, Telegram API ID, and Telegram API hash in TeleGlance Settings.")
    try:
        payload = decrypt_auth_header(encrypted_auth.strip(), shared_secret)
    except SecureAuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc), headers=BACKEND_AUTH_ERROR_HEADERS) from exc
    api_id = str(payload.get("apiId") or "")
    api_hash = str(payload.get("apiHash") or "")
    session = str(payload.get("session") or "")

    api_id = (api_id or "").strip()
    api_hash = (api_hash or "").strip()
    session = (session or "").strip()
    if not api_id and not api_hash and not session:
        return None
    try:
        parsed_api_id = int(api_id)
    except ValueError:
        parsed_api_id = None
    return TelegramClientCredentials(
        api_id=parsed_api_id,
        api_hash=api_hash or None,
        session_string=session or None,
    )


def require_backend_auth(
    x_teleglance_auth: Annotated[Optional[str], Header(alias="X-TeleGlance-Auth")] = None,
) -> None:
    settings = get_settings()
    validate_backend_auth(x_teleglance_auth, settings.teleglance_shared_secret)


def validate_backend_auth(encrypted_auth: Optional[str], shared_secret: Optional[str]) -> None:
    if not shared_secret:
        raise HTTPException(status_code=400, detail="Backend shared secret is required. Set TELEGLANCE_SHARED_SECRET in backend .env and the same value in TeleGlance Settings.")
    if not encrypted_auth or not encrypted_auth.strip():
        raise HTTPException(status_code=400, detail="Encrypted auth is required.")
    try:
        decrypt_auth_header(encrypted_auth.strip(), shared_secret)
    except SecureAuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc), headers=BACKEND_AUTH_ERROR_HEADERS) from exc


def telegram_service_cache_key(credentials: Optional[TelegramClientCredentials]) -> str:
    if credentials is None:
        return "env"
    value = f"{credentials.api_id or ''}:{credentials.api_hash or ''}:{credentials.session_string or 'pending'}"
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


@lru_cache
def get_transcription_service() -> WhisperTranscriptionService:
    return WhisperTranscriptionService(get_settings())
