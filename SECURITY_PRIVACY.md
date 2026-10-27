# Security And Privacy Audit

This document is the audit trail for the TeleGlance v1 self-hosted release. It
records what is sensitive, where it lives, what is checked into git, and what
must NOT be pushed to a public repository or shared with anyone else.

A separate local-only `SECURITY_PRIVACY_FUTURE.md` keeps open work-in-progress
notes that have not been audited for public consumption.

## 1. Threat model

TeleGlance v1 is a single-user self-hosted app:

- The user runs the FastAPI backend on their own machine or LAN/Tailscale.
- The user installs the Even Hub `.ehpk` on their own phone/glasses.
- The user supplies their own Telegram `api_id`, `api_hash`, and phone-code
  login session.
- There is no central server, no multi-tenant database, and no remote logging.

The realistic adversaries are:

- **Passive network observers** on the phone's Wi-Fi/LAN who can read
  cleartext HTTP to the backend.
- **A misconfigured backend** exposed to the internet by accident.
- **A local attacker with device access** who can read the WebView's
  storage.
- **A prompt-injection payload** delivered through Telegram (a malicious
  message, link, or contact) trying to abuse the backend.

Out of scope for v1: shared multi-tenant hosting, public app-store
distribution with auto-generated sessions, anonymous public sign-up.

## 2. Secret inventory

| Secret | Lives in | Format | Where it travels |
| --- | --- | --- | --- |
| `TELEGLANCE_SHARED_SECRET` | backend `.env`, frontend phone Settings | text | AES-GCM-encrypted header `X-TeleGlance-Auth` and request/response body envelopes |
| Telegram `api_id` | frontend phone Settings (or fixture defaults) | numeric | AES-GCM-encrypted inside `X-TeleGlance-Auth` |
| Telegram `api_hash` | frontend phone Settings (or fixture defaults) | hex | AES-GCM-encrypted inside `X-TeleGlance-Auth` |
| Telegram `StringSession` | frontend phone Settings (returned by `complete_phone_login` for frontend-credential mode) | base64 | AES-GCM-encrypted inside `X-TeleGlance-Auth` |
| Real Telethon `telegram.session` file | `server/data/telegram.session` (gitignored) | SQLite | stays on the backend host only |
| User phone number (entered at phone-code login) | frontend phone UI, transient | text | AES-GCM-encrypted in `start_phone_login` body |
| Telegram login code (entered by user) | frontend phone UI, transient | text | AES-GCM-encrypted in `complete_phone_login` body |
| Phone-code hash returned by Telethon | backend in-memory dict keyed by phone, on a pending login client that is discarded once sign-in succeeds | text | stays in backend memory |
| User `chatId` / `topicId` / message text | backend session state, in-flight JSON | text | AES-GCM-encrypted over the wire |

## 3. Git-tracked files: what is and is not checked in

### 3.1 Tracked (safe)

- All source code in `web/src/`, `server/app/`, `scripts/`, `tests/`.
- Documentation in `docs/`, `AGENTS.md`, `README.md`, etc.
- `app.json` — manifest with `http://<BACKEND_URL>:8787` as a runtime
  placeholder. No per-developer Tailscale IP.
- `.env.example` — placeholder values only (`<enter-secret-token>`,
  `12345`, `placeholder=...`).
- Test fixtures use obvious fake values (`session-string`, `+14155552671`,
  `shared-secret`).
- The GitHub repo URL `https://github.com/jalatif/even-g2-tele-glance.git`
  is referenced in the Settings UI and README; it is the public repo the
  user wants the public to know about.

### 3.2 Gitignored (must NEVER be committed)

Confirmed by `git check-ignore` on every sensitive path:

- `.env` — the user's real `TELEGLANCE_SHARED_SECRET`.
- `server/data/telegram.session` — real Telethon session (SQLite).
- `server/.env`, `server/.env.*` — backend env variants.
- `*.session`, `*.session-journal` — any Telethon session.
- `*.ehpk` — packaged app.
- `web/dist/`, `dist/`, `build/` — build outputs.
- `server/.venv/`, `__pycache__/`, `.pycache/`, `.pytest_cache/`, `.mypy_cache/`,
  `.ruff_cache/`, `node_modules/`, `.vite/`, `coverage/`.
- `artifacts/`, `web/test/simulator-goldens/` (goldens are committed via the
  `!` exception, the harness output dir is not).
- `SECURITY_PRIVACY_FUTURE.md` — local-only work-in-progress notes.
- `web/test/seed-credentials*.json` — historical real Telegram session seed
  files, never committed (the seed-credentials feature was removed in
  `e962c6d` but the gitignore entries remain as defense in depth).

### 3.3 Vestigial local files (not in git, not needed)

- `server/server/data/telegram.session` — an extra session file in a
  duplicated `server/server/` directory. The whole `server/server/` tree is
  a leftover from an early scaffold and can be deleted. It is gitignored
  via `*.session`, but deleting it shrinks the workspace and removes a
  session file the user may have forgotten about.
- `ghost-bug-screenshot.png` (132 KB, June 2, untracked) — a debugging
  artifact for a chat-list rendering issue, already covered by
  `*.png` in `.gitignore`.
- Built `*.ehpk` packages are gitignored. `tele-glance-1.0.45.ehpk` was force-added in an earlier commit and old `even-telegram-*.ehpk` blobs remain in history; they were decoded in the audit and hold no credentials, but should be untracked.

## 4. `.ehpk` bundle audit

The packaged `.ehpk` was built from `web/dist/`. `grep` against the dist
bundle surfaces these URL-shaped strings:

- `http://localhost:8787` — backend default, whitelisted.
- `http://127.0.0.1:8787` — backend default, whitelisted.
- `http://127.0.0.1:5174` — Vite dev server port (fixture mode only),
  whitelisted as a defensive entry.
- `http://<BACKEND_URL>:8787` — runtime placeholder in the Settings UI
  hint. No concrete IP.
- `https://my.telegram.org` — Settings link, whitelisted.
- `https://react.dev/errors/` — React production error overlay URL,
  whitelisted.
- `https://github.com/...` (systemjs, core-js, this repo) — appear in
  minified third-party source bundles as documentation/error-message
  strings, not as network calls the app makes.
- `http://www.w3.org/...` (MathML, xlink, svg, XML) — XML namespace
  identifiers in minified code, not network calls.

No `100.x.x.x` Tailscale IP, no `192.168.x.x` LAN IP, no real phone number,
session string, or API credentials appear in the dist bundle. The packaged
frontend no longer carries a public shared-backend default.

## 5. Encrypted transport

- Frontend (`web/src/secureAuth.ts`):
  - AES-GCM with PBKDF2-SHA256, 200,000 iterations, fixed salt.
  - 12-byte random nonce per request, AAD `teleglance-auth-v1`.
  - The derived `CryptoKey` is cached per shared secret in
    `derivedKeyCache` so PBKDF2 runs once per secret change, not per
    request.
- Backend (`server/app/services/secure_auth.py`):
  - Same AES-GCM + PBKDF2 + AAD scheme.
  - Replay window: nonce seen within 300 s is rejected.
  - Auth timestamp must be within ±120 s of server time.
  - The server caches the derived key per secret (`functools.lru_cache`
    on `_derive_key`) so the 200k-iteration PBKDF2 does not run per request
    and cannot be used to stall the event loop. Replay nonces are recorded
    only after a header decrypts and validates, so unauthenticated callers
    cannot grow the nonce map.
  - Every mutating `/api/` request that carries `X-TeleGlance-Auth` must send an
    encrypted body envelope regardless of Content-Type spelling (only the
    multipart `/api/transcribe` upload is exempt).
  - Scope of the protection: the app-layer AES-GCM gives confidentiality
    against passive observers. It is not a substitute for TLS: responses are
    not authenticated (the client only decrypts when the plain
    `X-TeleGlance-Encrypted` header is present), so an active attacker on a
    plain-HTTP hop can tamper with or block traffic. Use Tailscale (WireGuard)
    or HTTPS as the real transport boundary.
- Encrypted JSON envelopes: every `/api/...` request and response body
  passes through `encrypt_payload`/`decrypt_payload` when the auth
  header is present and the secret is set. `Content-Type` must be JSON.
- CORS: the server `expose_headers` includes `X-TeleGlance-Encrypted` so
  the browser-side `fetch` can tell an encrypted body apart from a
  plain error string.

## 6. Storage and cookies

- Sensitive keys (`backendSharedSecret`, `telegramApiId`,
  `telegramApiHash`, `telegramSession`) are written to `localStorage`
  only via `writeSensitiveString`, which **removes** any matching cookie
  on every save (`removeCookie`).
- The earlier bug that mirrored sensitive values to cookies was fixed
  (commit `e962c6d` removed the seed-credentials mechanism that
  introduced the regression; the cookie-removal path remains in
  `web/src/storage.ts`).
- `localStorage` in a packaged Even Hub WebView is not encrypted at
  rest. Anyone with device, browser, or extension access can read it.
  This is acceptable for v1 because the device is the user's own; it
  must be revisited before any multi-user hosted distribution.

## 7. Backend CORS and network exposure

- `BACKEND_CORS_ORIGINS` defaults to `http://localhost:5173` and
  `http://127.0.0.1:5173` (the Vite dev server).
- When `TAILSCALE_ENABLED=true` (default), an additional regex
  `^https?://(localhost|127\.0\.0\.1|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.\d{1,3}\.\d{1,3})(:\d+)?$`
  is appended. This admits the entire Tailscale `100.64.0.0/10` range
  but NOT public IPs.
- `BACKEND_CORS_ORIGIN_REGEX` lets a user override the regex for a
  custom LAN setup.
- The backend binds `0.0.0.0:8787`. Users must not expose that port to
  the public internet without also putting TLS in front. The backend
  does not enforce TLS itself.

## 8. Debug event endpoint

`/api/debug/events` (POST/GET/DELETE) is gated by encrypted auth
(`require_app_backend_auth`). It accepts any JSON payload from the
frontend and stores up to 100 events in an in-memory deque.

- `audioChunk` events are accepted but discarded to avoid buffering
  audio.
- Other events are stored verbatim minus a `received_at` timestamp.
- The frontend can include `currentSelectItemName`, message sender
  names, and any other text it can observe from the active screen. This
  is opt-in via the Settings "Debug event logging" checkbox and is
  **off by default**.
- The endpoint is in-memory only — restart of the backend erases the
  log. There is no remote logging service.

The user-facing Settings hint discloses the risk: *"When enabled, raw
glasses input events are sent to the backend debug endpoint and may
include message or gesture context."*

## 9. Backend error responses

All `TelegramServiceError` instances are constructed in
`server/app/services/telegram.py` with a fixed, user-friendly string
(no PII). The `wrap_telegram_error` helper falls back to
`str(exc) or exc.__class__.__name__` for unknown errors.

For Telethon's `RPCError` subclasses, `_fmt_request` only embeds the
**class name** of the request (e.g. `RequestSendCodeRequest`), not
field values. So:

- `PhoneNumberInvalidError` → `"The phone number is invalid (caused
  by RequestSendCodeRequest)"` — **does not leak the phone number**.
- `PhoneCodeInvalidError` → `"The phone code entered was invalid
  (caused by ...)"` — **does not leak the code**.
- `FloodWaitError` → `"A wait of N seconds is required (caused by
  ...)"` — does not leak anything sensitive.
- `AuthKeyDuplicatedError` → the literal string mentions "two
  different IP addresses" but does not include the IPs.
- `SessionRevokedError`, `SessionPasswordNeededError`, etc. — fixed
  strings, no PII.

The CORS preflight responses do not echo request headers; the
debug event store does not include raw request headers either.

## 10. Telethon logging filter

Telethon's `logging` module is verbose. `GetDifferenceRequest`-class
calls fire constantly after login and log "Account is not logged in"
on dead sessions. The app's process should silence the `telethon`
logger to `WARNING` or higher to avoid leaking session state into
backend logs. (Already noted in `AGENTS.md` observed issues.)

## 11. Pre-push checklist (use before `git push`)

1. `git status --short --ignored` and review every line.
2. `git diff --stat` against `main` and grep the diff for:
   - IP-shaped strings `\b(?:\d{1,3}\.){3}\d{1,3}\b`
   - URLs that are not `localhost`, `127.0.0.1`, `github.com`,
     `my.telegram.org`, `react.dev/errors/`, or this repo.
   - Strings matching `apiId`, `apiHash`, `sessionString`,
     `phoneNumber`, `verification code` that aren't test fixtures.
3. Confirm `.env` is still on disk locally but is **not** staged:
   `git ls-files | grep -E "^\.env$"` must return empty.
4. Confirm no real session files are staged:
   `git ls-files | grep -E "\.session"` must return empty.
5. Confirm `app.json` does not contain a concrete Tailscale IP. The
   shipped manifest must show `http://<BACKEND_URL>:8787`; the
   substituted form is only valid for the dev's own local `.ehpk`.
6. Confirm `.ehpk` is not committed (gitignored).
7. Confirm the local `SECURITY_PRIVACY_FUTURE.md` (work-in-progress
   notes) is not staged.
8. Run the harness in fixture mode once to confirm a clean
   `web/dist/` and that the dist still contains only the whitelisted
   URLs.
9. Delete the vestigial `server/server/` directory if it still exists.

## 12. Open issues (deferred to SECURITY_PRIVACY_FUTURE.md)

- Backend `.env` ships with `my-secret-token` as a placeholder; the
  user should generate a real random secret before any non-local use.
  The `.env.example` shows the same placeholder.
- Telethon log silencing should be enforced in the backend entrypoint.
- `/api/debug/events` could be gated by an additional header or
  disabled at startup rather than just per-request.
- localStorage secrets should be encrypted with a key derived from the
  shared secret before any multi-user hosted deployment.
- A CSP should be set on the WebView serving the packaged frontend.
- Custom STT endpoint URLs are passed through with the audio but
  **without** Telegram auth headers, which is correct; the contract
  should be documented in a public `docs/CONTRIBUTING.md`.
