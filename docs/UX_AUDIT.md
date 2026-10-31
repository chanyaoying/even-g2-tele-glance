# TeleGlance code audit: usability, speed and interaction (1.0.69)

Method: CodeGraph index (94 files, 2,256 symbols) used to trace startup, input dispatch, the send/record flow, the HTTP layer, the phone UI and the backend services. Findings cite the code read; items marked *unverified on device* need a glasses check.

Priority: **H** = users hit it regularly, **M** = noticeable, **L** = polish.

## Speed

| # | P | Finding | Where | Suggested change |
|---|---|---------|-------|------------------|
| S1 | H | Startup is serial: `authStatus()` finishes before `loadChats()` starts, so the chat list waits one extra encrypted round-trip. | `appController.init` (~l.356) | Start `listChats` in parallel with `authStatus`; discard the list if auth fails. |
| S2 | H | The chat list waits on `listFolders()` (`Promise.all`) even though folders are optional. | `loadChats` (~l.1203) | Show chats as soon as they arrive; apply folders when they land. |
| S3 | H | Every glasses `foreground` event runs the whole `init()` again (auth check, full reload, back to the chat list). Returning to the glasses loses the open thread. | `dispatch`, `foreground` branch | If a session is already loaded, refresh in place (`handleStreamReconnect`-style catch-up) and keep the screen. |
| S4 | M | One flat 15 s timeout covers every request, including `/api/transcribe`. A 30-60 s clip on CPU Whisper can legitimately exceed it and show "timed out" for a transcription that is still running. | `api.request` (`DEFAULT_REQUEST_TIMEOUT_MS`) | Per-call timeouts (transcribe ~60 s, send ~20 s, reads 15 s). |
| S5 | M | Each message fetch makes a second Telegram call to resolve reply quotes, sequentially after the page fetch. | `list_messages` / `attach_replies` | Cache resolved reply previews per chat (small LRU) so repeat pages cost one call. |
| S6 | M | Chat list freshness is a full `list_chats` on every stream event. | `handleTelegramUpdate` | Patch the single chat (last message, unread) from the update; reconcile on the 10 s poll. |
| S7 | L | Reads are never compressed before encryption; message pages with extras grow. | `secure_auth` | Measure first (Server-Timing is now available); only then consider gzip-before-encrypt. |

## Interaction (glasses)

| # | P | Finding | Where | Suggested change |
|---|---|---------|-------|------------------|
| I1 | H | Silent or empty recordings return to the thread with no message. The user cannot tell whether nothing was heard or the app failed. | `handleSidebarRecording` (`hasRecordableAudio` and empty transcript branches) | Return with status "Didn't catch that" (localized), same for the server's "recording is silent" error, which currently becomes a full error screen. |
| I2 | H | A failed send throws the user to the error screen and the transcript is lost. Pressing on the error screen restores the previous state and then calls `init()`, which reloads to the chat list. | `run`, `handleError` | For send/transcribe failures keep the confirm screen with the transcript and a "Retry / Cancel" choice. Make single press on other errors retry the failed action, not restart the app. |
| I3 | H | Possible duplicate sends: a send that times out client-side after 15 s may still have gone through; retrying sends it again. No idempotency key. | `handleSidebarConfirm`, `sendTextFromPhone`, `api.sendMessage` | After a send timeout, check the newest page for the same text from "me" before offering retry; or send a client token the server de-duplicates. |
| I4 | M | Error text is raw and long (for example the 15 s timeout sentence) on a 576x288 display, and English only. | `api.ts` messages, `run` | Short localized errors ("No connection", "Server slow"), full text only on the phone. |
| I5 | M | Stored (cached) chats are shown with no sign that they may be stale; unread counts can be old for a second or two. | `showingStoredChats` | Show a subtle "Updating..." in the footer until the live list arrives. |
| I6 | L | Recording gives no elapsed time or remaining-time cue near the 60 s cap (*unverified on device*). | recording screen | Show `REC 0:12` and a last-10-seconds warning. |
| I7 | L | Reopening the app always starts at the chat list; the last open thread is not remembered. | `init` | Optionally restore the last chat from the persistent cache. |

## Phone UI

| # | P | Finding | Where | Suggested change |
|---|---|---------|-------|------------------|
| P1 | M | Phone message bubbles show sender and text only. Replies, forwards, polls, link cards and photo labels added in 1.0.66 are glasses-only, and there are no timestamps. | `ChatScreen.MessageBubble` | Reuse the same fields: quote line, "Forwarded from", poll rows, link card, time. |
| P2 | M | Settings has no "Test connection" action. Wrong URL or secret only shows up later as a failed load on the glasses. | `SettingsScreen` | Add a button that calls `/health` and `/api/session/status` and reports each result in plain words. |
| P3 | L | `SettingsScreen` has no tests; it holds the secrets, cache and logout controls. | tests | Add render tests for save/reset/logout/clear cache. |
| P4 | L | The 1.0.68 strings (`settingsClearCache`, `settingsCacheCleared`) are English in all 24 other locales. | `web/src/locales` | Translate. |

## Backend

| # | P | Finding | Where | Suggested change |
|---|---|---------|-------|------------------|
| B1 | M | Unknown Telegram errors become HTTP 400 with raw `str(exc)`. Rate limits (`FloodWaitError`) show as a vague failure with no wait time. | `wrap_telegram_error`, `raise_telegram_http_error` | Map flood waits to 429 with `Retry-After`; have the phone show "Telegram asks you to wait N s". |
| B2 | M | `update_events` uses a bounded queue of 50 per stream; confirm the overflow behavior drops the oldest and triggers a phone catch-up rather than silently losing messages. | `telegram.py` `update_events` | Verify and add a test; send a "resync" event on overflow. |
| B3 | L | Real Telethon `send_message` (including forum `reply_to`) has no test; only the fake service is exercised. | `tests/backend` | Add a test with a mocked client asserting `reply_to=topic_id`. |

## Maintainability (affects how fast UX fixes can ship)

- `appController.ts` is 2,870 lines. The "return to the message view" state is rebuilt by hand about ten times (about 15 copied fields each) in the recording, transcribing, confirm and send handlers. One `backToMessages(state, overrides)` helper would remove the duplication and the risk that a new field (for example `typing`) is forgotten in one copy.
- Controller status strings ('Checking Telegram session...', auth messages) are English literals outside the locale files.
- CodeGraph reported no direct tests for `formatMessageBlocks`, `formatListAsText` and `SettingsScreen` within 3 caller hops; they are covered only indirectly.

## Suggested order

1. I1, I2, I3 (trust in sending and recording), S4 (stops false timeouts).
2. S1, S2, S3 (faster start and no lost place).
3. P1, P2, B1 (phone parity and clearer failures).
4. The rest, plus the `backToMessages` refactor before touching the controller further.
