# Frontend Architecture

## Summary

The frontend has two separate rendering targets:

- Phone/debug UI: a React DOM app for configuration, message browsing, and typed replies.
- Glasses UI: the existing Even Hub 576x288 container UI driven by `screenModel`.

Both targets share the same Telegram controller so the phone and glasses stay synchronized. The phone UI must not reuse `screenModel` for rich DOM rendering; `screenModel` remains a glasses-only projection with byte and visible-line limits.

## Structure

- `web/src/main.tsx`: React bootstrap.
- `web/src/App.tsx`: phone app shell and screen switching.
- `web/src/contexts/AppContext.tsx`: owns `HttpTelegramApi`, `EvenHubGlassesBridge`, and `TelegramAppController`.
- `web/src/screens/ChatScreen.tsx`: phone message view plus typed composer.
- `web/src/screens/SettingsScreen.tsx`: frontend-only configuration.
- `web/src/storage.ts`: typed localStorage config defaults.
- `web/src/api.ts`: `HttpTelegramApi` (encrypted transport, error classification, update stream); `web/src/secureAuth.ts`: AES-GCM helpers and per-purpose AADs.
- `web/src/cache/persistentCache.ts`: `PersistentCache`, the on-phone cache of the chat list, recent thread pages and photos.
- `web/src/controller/appController.ts`: `TelegramAppController`, the shared app state machine (input handling, loading, polling, rendering).
- `web/src/controller/threadStore.ts`: `ThreadStore`, the per-thread caches (latest page, topic list, "last read" point, last read mark sent), LRU-capped at 50 threads, plus message-page helpers; `lruMap.ts` is the LRU map it and the photo/folder caches use.
- `web/src/controller/unreadState.ts`: pure helpers that read and clear a thread's unread count across every copy inside an `AppState`.
- `web/src/controller/model.ts`: `AppState` and the glasses `screenModel` projection (also `localizeStatus`).
- `web/src/bridge/*`: Even Hub bridge and event mapping.
- `web/src/locales/*`: UI strings; `en.ts` is the source of truth and every other locale must translate every key (enforced by `test/locales.test.ts`).

The glasses bridge is created once and is not recreated while switching between phone screens.

## Phone UI

The phone chat screen shows full DOM message history, separate from the glasses view:

- Chat/topic title when a thread is active.
- Full messages oldest-to-newest with sender labels.
- Scrollable message list that stays at the latest message after open/send/receive.
- Separate text box and Send button for typed phone replies.
- Empty states for auth, chat list, topic list, asleep, new-message prompt, and errors.

The phone composer sends directly to the currently open Telegram chat/topic. It does not enter the glasses voice-recording confirmation flow. After send, the controller refreshes the latest messages and keeps the glasses screen anchored to the latest message.

## Settings

Settings are frontend-specific and persisted in localStorage.

Practical V1 settings:

- First-use Telegram API ID/API hash setup with `my.telegram.org` instructions.
- Required backend shared secret setup. The same `TELEGLANCE_SHARED_SECRET` value must be configured in backend `.env` and phone Settings.
- Frontend-local Telegram StringSession status and clear-session action. The UI describes this as stored on the phone only.
- Login action after credentials are configured: phone-code login with an international-format mobile number. QR login has been removed from the app and backend API surface.
- Backend setup instructions with `https://github.com/jalatif/even-g2-tele-glance.git`.
- Backend URL save/reset. There is no default backend: with an empty Backend URL the app shows the setup flow and sends nothing.
- Optional STT Server Url override; blank uses the backend URL and backend-local `faster-whisper`.
- Debug event logging toggle.
- Recording minimum duration in milliseconds.
- Advanced fallback refresh intervals for chat/message polling, hidden behind details because SSE is the primary update path. They apply only while the live stream is down.
- Read-only current API URL and session status.
- Read-only app/build version.

Changing backend URL, STT URL, backend shared secret, Telegram credentials, or the Telegram session requires a reload so the API client and controller restart from a consistent identity. Recording and fallback refresh settings are applied live to the controller.

Telegram API hash, shared secret, and session string are sensitive. They are kept out of backend disk storage in the public setup path, but localStorage is still only appropriate for a self-hosted/user-owned deployment.

## Controller Contract

The controller exposes phone-facing APIs in addition to glasses input dispatch:

- `subscribe(listener)`: notify React whenever controller state changes.
- `snapshot`: current `AppState`.
- `sendTextFromPhone(text)`: send a typed reply to the active chat/topic.
- `updateRuntimeConfig(config)`: update polling and recording timing.

`sendTextFromPhone(text)` only works while the controller is in a state with an active message thread. It sends to the current chat/topic, refreshes newest messages, normalizes ordering, resets the visible pointer to latest, and re-renders glasses.

Phone-code login returns `sessionString`; the React context persists it to localStorage and all later Telegram API requests include it inside encrypted `X-TeleGlance-Auth`.

## Glasses Message Projection

`screenModel` is a glasses-only projection and owns the 576x288 constraints:

- It builds bottom-anchored visible pages from the chronological message buffer.
- Compact messages are grouped into full visible pages.
- Messages over twenty-five words become structured boxed pages.
- Multi-page boxed messages remain separate scroll stops until the user reaches the first/last page.
- The returned `body` remains useful for the phone/debug pane, but the glasses bridge uses structured `box` metadata for native bordered containers.
- For any page that returns `box`, the glasses projection must keep that page's right-panel `body` empty. This prevents old text-drawn box content from rendering underneath the native bordered container.
- Forum topic preview panels render the selected topic plus loading copy until preview messages arrive; they should not mirror the full topic list from the left sidebar.

Avoid parsing ASCII/debug text to infer native glasses layout. That caused duplicated text-box content because the native container and the old marker format could both render.

## Encrypted Transport

Every backend request carries `X-TeleGlance-Proto: 2`. Telegram credentials and the session string travel in the encrypted `X-TeleGlance-Auth` header; JSON request bodies are encrypted too, and the backend encrypts its responses (`X-TeleGlance-Encrypted: 1`). All use AES-GCM with a key derived from the shared secret, and each purpose has its own AAD (`teleglance-auth-v1`, `teleglance-req-v1`, `teleglance-resp-v1`), so a ciphertext made for one purpose never decrypts as another.

Errors are `ApiError`s with a short glasses `message` and a longer phone `detail`. A 401 is classified by the `X-TeleGlance-Error` header (`session_expired`: sign in again; `backend_auth`: wrong shared secret or phone clock, the login is kept), falling back to the detail text. With a wrong secret the encrypted error body cannot be decrypted; that counts as rejected auth, not a crypto error. Early rejections (413, pre-auth 401) are plain JSON. 429/503 honour `Retry-After`. Missing settings are `kind: 'notConfigured'`.

Short status texts (`Offline`, `Backend rejected auth`, `No connection`, `Server busy`, ...) are English sentinels the code compares; `localizeStatus` translates them when the glasses or phone draw them. Longer texts are localised when created.

## Realtime Updates

The backend exposes `/api/updates` as an SSE stream for Telegram message updates. The React context subscribes once (in parallel with startup), forwards updates to the shared controller, and the controller merges a streamed message into the open thread or refreshes the root chats. `event: resync` (the backend reconnected to Telegram or dropped queued updates) triggers the same catch-up as a stream reconnect; `event: error` with `code: session_expired` signs out.

Polling is only a fallback: the configured fast intervals run while the stream is down (from an error until the next open), a 60 s safety poll runs while it is up, and nothing polls while asleep. While the user is swiping, the controller (and only the controller) defers refreshes and stream-driven work until input is quiet.

The frontend intentionally uses `fetch` streaming instead of browser `EventSource` because `EventSource` cannot attach encrypted app auth headers. Credentials/session must not be put in query parameters.

## Caches

- `PersistentCache` keeps the chat list, the newest 24 messages of recently opened threads and recent photos in Even App SDK storage (browser storage in the simulator), within a byte budget and a 7-day age limit, written in batches while input is quiet. At startup the stored chat list is shown at once (footer `Updating...`, or `Offline` with background retries if the backend cannot be reached). Everything stored is usable before the session check finishes: stored threads (also ones with unread messages, shown as `Updating...` until the fresh page places the unread divider) and stored forum topic lists open at once, and the network chat list never pulls a user who has left the stored list back to it. A failed background refresh of stored data shows `Offline`, never the error screen. It is not encrypted; signing out or Reset clears it.
- In memory, `ThreadStore` keeps per-thread pages, topic lists, unread points and read marks for the 50 most recently used threads; photos and folder chat lists use the same LRU map. An open thread grows while the user pages back through history and is cut back to the newest 240 messages once the view returns to the newest message.

## Folders

Telegram chat folders load after the chat list and never block it. With folders, double press on the chat list opens a folder picker (All chats, each folder, Sleep); the chat-list title shows the folder and its position. Each folder's first page is warmed in the background while input is quiet, and loaded folder pages are kept so switching back is instant.

## Hardware Notes

The browser/debug pane and glasses display are not interchangeable for layout validation. The G2 display is not a true monospace grid, so long-message borders on glasses must use native `TextContainerProperty` borders rather than text-drawn rectangles.

Hardware input can emit duplicate same-direction swipes. Event mapping uses a narrow 30ms duplicate window so immediate duplicates are filtered without dropping deliberate rapid navigation.

Chat/topic navigation uses a text-rendered sidebar and one full-screen event overlay. The controller owns the selected index and updates the visible marker and right-side preview together. Native item-name/index payloads remain compatibility inputs rather than the primary selection mechanism.

The initial chat list renders before speculative work; the chat list itself has no preview, so nothing is fetched until a chat is opened. Hardware input is dispatched at most one gesture per 20 ms window: swipes and selection are latest-wins so SDK/native stalls cannot release a long sequence onto later screens, while presses are never coalesced and a pending swipe is dispatched before a following press.

Chat and topic selection retain the split sidebar/preview layout. Opening the selected thread expands messages across the full glasses width; double click restores the saved split-view back target. Voice transcription confirmation is a standalone text page containing the transcript and `Send`/`Cancel` choices.

## Validation

Required checks:

- `npm run typecheck --prefix web`
- `npm test --prefix web`
- `PYTHONPYCACHEPREFIX=.pycache server/.venv/bin/python -m pytest tests/backend`
- `npm run build:tailscale --prefix web`
