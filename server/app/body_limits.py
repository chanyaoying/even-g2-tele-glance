"""Reject oversized request bodies before anything reads or parses them.

FastAPI parses a multipart form (spooling it to disk) and the encryption middleware reads a JSON body into
memory before any route dependency, i.e. before authentication, runs. This ASGI middleware sits outside
both: it refuses a declared Content-Length over the limit at once, counts streamed bytes for chunked
uploads, and for paths in `auth_first_paths` checks the auth header before reading a single body byte.
"""
import json
from typing import Awaitable, Callable, Iterable, Optional

from fastapi import HTTPException

BODY_METHODS = {"POST", "PUT", "PATCH"}
# Set in the ASGI scope state once the middleware has validated the auth header of an auth-first path, so
# the route does not validate (and burn) the same single-use nonce a second time.
AUTH_VALIDATED_STATE_KEY = "teleglance_auth_validated"


class RequestBodyLimitMiddleware:
    def __init__(
        self,
        app,
        *,
        default_limit: int,
        path_limits: dict[str, int],
        auth_first_paths: Iterable[str] = (),
        validate_auth: Optional[Callable[[Optional[str]], None]] = None,
    ) -> None:
        self.app = app
        self.default_limit = default_limit
        self.path_limits = dict(path_limits)
        self.auth_first_paths = set(auth_first_paths)
        self.validate_auth = validate_auth

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http" or scope.get("method") not in BODY_METHODS:
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        limit = self.path_limits.get(path, self.default_limit)
        headers = {name.lower(): value for name, value in scope.get("headers", [])}

        declared = headers.get(b"content-length")
        if declared is not None:
            try:
                declared_length = int(declared)
            except ValueError:
                await _send_json(send, 400, "Invalid Content-Length")
                return
            if declared_length > limit:
                await _send_json(send, 413, "Request body is too large")
                return

        if path in self.auth_first_paths and self.validate_auth is not None:
            auth = headers.get(b"x-teleglance-auth")
            try:
                self.validate_auth(auth.decode("latin-1") if auth is not None else None)
            except HTTPException as exc:
                await _send_json(send, exc.status_code, str(exc.detail), getattr(exc, "headers", None))
                return
            scope.setdefault("state", {})[AUTH_VALIDATED_STATE_KEY] = True

        # Read the (bounded) body here and replay it, so a chunked upload cannot grow past the limit.
        chunks: list[bytes] = []
        total = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body = message.get("body", b"")
            total += len(body)
            if total > limit:
                await _send_json(send, 413, "Request body is too large")
                return
            chunks.append(body)
            if not message.get("more_body", False):
                break
        body = b"".join(chunks)
        replayed = False

        async def replay_receive():
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        await self.app(scope, replay_receive, send)


async def _send_json(
    send: Callable[[dict], Awaitable[None]], status: int, detail: str, extra_headers: Optional[dict[str, str]] = None
) -> None:
    payload = json.dumps({"detail": detail}).encode("utf-8")
    headers = [(b"content-type", b"application/json"), (b"content-length", str(len(payload)).encode("ascii"))]
    headers += [(name.lower().encode("latin-1"), value.encode("latin-1")) for name, value in (extra_headers or {}).items()]
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": payload})
