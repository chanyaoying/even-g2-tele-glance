import base64
from functools import lru_cache
import json
import os
import time
from typing import Any


AUTH_HEADER_PREFIX = "v1."
AUTH_AAD = b"teleglance-auth-v1"
AUTH_SALT = b"TeleGlance encrypted auth v1"
AUTH_MAX_AGE_SECONDS = 120
AUTH_REPLAY_TTL_SECONDS = 300
AUTH_PBKDF2_ITERATIONS = 200_000

_seen_nonces: dict[str, float] = {}


class SecureAuthError(ValueError):
    pass


def decrypt_auth_header(header_value: str, shared_secret: str) -> dict[str, Any]:
    if not shared_secret.strip():
        raise SecureAuthError("Encrypted auth requires TELEGLANCE_SHARED_SECRET on the backend")
    if not header_value.startswith(AUTH_HEADER_PREFIX):
        raise SecureAuthError("Unsupported encrypted auth format")

    try:
        _version, encoded_nonce, encoded_ciphertext = header_value.split(".", 2)
        nonce = _base64url_decode(encoded_nonce)
        ciphertext = _base64url_decode(encoded_ciphertext)
    except ValueError as exc:
        raise SecureAuthError("Malformed encrypted auth header") from exc

    if len(nonce) != 12:
        raise SecureAuthError("Malformed encrypted auth nonce")

    _check_replay(encoded_nonce)

    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        plaintext = AESGCM(_derive_key(shared_secret)).decrypt(nonce, ciphertext, AUTH_AAD)
        payload = json.loads(plaintext.decode("utf-8"))
    except ImportError as exc:
        raise SecureAuthError("Install server requirements to enable encrypted auth") from exc
    except Exception as exc:
        raise SecureAuthError("Encrypted auth could not be decrypted") from exc

    _validate_payload(payload)
    _record_nonce(encoded_nonce)
    return payload


def encrypt_payload(plaintext: bytes, shared_secret: str) -> str:
    if not shared_secret.strip():
        raise SecureAuthError("Encrypted payload requires TELEGLANCE_SHARED_SECRET on the backend")
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError as exc:
        raise SecureAuthError("Install server requirements to enable encrypted auth") from exc

    nonce = os.urandom(12)
    ciphertext = AESGCM(_derive_key(shared_secret)).encrypt(nonce, plaintext, AUTH_AAD)
    return f"v1.{_base64url_encode(nonce)}.{_base64url_encode(ciphertext)}"


def decrypt_payload(encrypted_payload: str, shared_secret: str) -> bytes:
    if not shared_secret.strip():
        raise SecureAuthError("Encrypted payload requires TELEGLANCE_SHARED_SECRET on the backend")
    if not encrypted_payload.startswith(AUTH_HEADER_PREFIX):
        raise SecureAuthError("Unsupported encrypted payload format")
    try:
        _version, encoded_nonce, encoded_ciphertext = encrypted_payload.split(".", 2)
        nonce = _base64url_decode(encoded_nonce)
        ciphertext = _base64url_decode(encoded_ciphertext)
    except ValueError as exc:
        raise SecureAuthError("Malformed encrypted payload") from exc
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        return AESGCM(_derive_key(shared_secret)).decrypt(nonce, ciphertext, AUTH_AAD)
    except ImportError as exc:
        raise SecureAuthError("Install server requirements to enable encrypted auth") from exc
    except Exception as exc:
        raise SecureAuthError("Encrypted payload could not be decrypted") from exc


def _validate_payload(payload: object) -> None:
    if not isinstance(payload, dict):
        raise SecureAuthError("Encrypted auth payload is invalid")
    timestamp = payload.get("ts")
    if not isinstance(timestamp, int):
        raise SecureAuthError("Encrypted auth timestamp is invalid")
    if abs(int(time.time()) - timestamp) > AUTH_MAX_AGE_SECONDS:
        raise SecureAuthError("Encrypted auth timestamp expired")


def _prune_nonces(now: float) -> None:
    expired = [nonce for nonce, expires_at in _seen_nonces.items() if expires_at <= now]
    for nonce in expired:
        _seen_nonces.pop(nonce, None)


def _check_replay(encoded_nonce: str) -> None:
    _prune_nonces(time.monotonic())
    if encoded_nonce in _seen_nonces:
        raise SecureAuthError("Encrypted auth nonce was already used")


def _record_nonce(encoded_nonce: str) -> None:
    # Only nonces from headers that decrypted and validated are remembered, so unauthenticated
    # callers cannot grow this map.
    now = time.monotonic()
    if encoded_nonce in _seen_nonces:
        raise SecureAuthError("Encrypted auth nonce was already used")
    _seen_nonces[encoded_nonce] = now + AUTH_REPLAY_TTL_SECONDS


def _base64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii"))


def _base64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


@lru_cache(maxsize=4)
def _derive_key(shared_secret: str) -> bytes:
    # Cached per secret: the 200k-iteration PBKDF2 must not run per request (it blocks the event loop).
    try:
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    except ImportError as exc:
        raise SecureAuthError("Install server requirements to enable encrypted auth") from exc

    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=AUTH_SALT,
        iterations=AUTH_PBKDF2_ITERATIONS,
    )
    return kdf.derive(shared_secret.encode("utf-8"))
