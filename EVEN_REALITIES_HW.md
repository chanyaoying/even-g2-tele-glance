# Even Realities Hardware Notes

These notes capture hardware-specific implementation details and quirks observed while building and testing TeleGlance. They are intentionally focused on real device behavior, not simulator-only behavior.

## Packaging And Runtime

- The `.ehpk` package contains the frontend and `app.json` manifest only. The FastAPI backend is not packaged and must keep running somewhere reachable from the phone/glasses path.
- Even Hub treats `package_id` as the app identity. Keep `package_id` stable across renamed builds; changing it from the originally installed package id can trigger manifest/package mismatch errors during install. The user-facing app name and `.ehpk` filename can change independently.
- Start the backend with `scripts/start-backend.sh --reload` from the repo root, or `../scripts/start-backend.sh --reload` from `server/`. Do not use plain `uvicorn`; it can resolve from another active virtualenv and then fail with missing dependencies such as `ModuleNotFoundError: No module named 'telethon'`.
- For local hardware testing, Tailscale has been the practical default route:
  - `npm run configure:tailscale --prefix web`
  - `npm run build:tailscale --prefix web`
  - package with `evenhub-cli pack`
- `TAILSCALE_ENABLED=true` allows backend CORS for Tailscale `100.64.0.0/10` origins.
- The shipped `app.json` does not bake in a per-developer Tailscale IP. Its `network` whitelist is `http://localhost:8787`, `http://127.0.0.1:8787`, the runtime placeholder `http://<BACKEND_URL>:8787`, plus the two static entries the frontend actually hard-references (`https://my.telegram.org` for the Settings link and `https://react.dev/errors/` for React's minified error messages). For local device testing, `npm run configure:tailscale --prefix web` saves the developer's Tailscale IP to the gitignored `app.local.json` (tracked `app.json` is left alone) and packaging substitutes it into the generated `.app-build/app.json`; the resulting `.ehpk` is for that developer's test only and is never published with the placeholder still in place.
- The phone running the Even Realities app must be able to reach the backend URL entered in TeleGlance phone Settings `Backend URL`. The Settings URL is the source of truth at runtime; the manifest whitelist just has to admit whatever URL the user enters.
- Before repacking for local device testing, run `npm run configure:tailscale --prefix web` once so `app.local.json` holds this machine's real Tailscale IP, then bump `app.json` `version` and delete stale `.ehpk` outputs so the package metadata and filename match.
- The app also supports a phone/debug-side `Backend URL` field stored in `localStorage`/Even Hub SDK local storage, so the backend route can be changed without rebuilding.
- The Even phone app/glasses path can keep running stale packaged frontend code after reinstall-like workflows. If a fix appears not to apply, fully remove the app/package from the phone app and reinstall the new `.ehpk`.
- Add a frontend build marker to debug events when validating hardware fixes. In this app, `buildVersion` is sent with `/api/debug/events`; if backend output shows `build_version: null` or an older value, the device is not running the expected package.

## Display Containers

- The G2 display target is `576x288`.
- Text/list container limits are strict on hardware and simulator.
- Text content must be byte-bounded, not character-bounded. Content over roughly `999` UTF-8 bytes can fail rendering or leave the glasses on a stale screen.
- List item count should stay within `1-20`.
- Stable container IDs matter. Rebuilding from one screen type to another with different or stale IDs can make the browser/debug view look correct while the glasses display remains on the previous page.
- Optional containers need stable IDs too. When a message page switches from a native boxed long message back to normal body text, keep the `panel-box` container in the rebuild and hide it when unused; omitting the container can leave stale boxed content on device.
- Native boxed content must not also be rendered as body text. If `panelBox` is set for topic preview, recording, sent, or message states, keep the right-panel body empty for that page; otherwise the old ASCII box text overlaps the native bordered container and looks like ghost text.
- Hidden containers should be kept stable when switching page layouts.
- Message history is safest as one chronological buffer with a bottom-relative scroll pointer:
  - Swipe up moves the pointer one display chunk older when loaded history is available.
  - Fetch older Telegram history only when the pointer reaches the oldest loaded message.
  - Swipe down moves the pointer one display chunk newer.
  - The latest message pointer is treated as the bottom boundary.
  - Opening a chat/topic, sending a message, or receiving a new incoming message should reset the pointer to latest.
- Large messages must be split into scrollable display chunks before applying the `999` byte container cap. Trimming one oversized message line directly causes the user to see only a short prefix plus `...`, with no way to read the rest.
- Older history should be prefetched in the background while a message thread is open and as the user approaches the oldest loaded content. Waiting until the exact oldest visible chunk causes a noticeable page-load jump on glasses.
- For longer threads, prefetch should chain multiple older pages ahead up to a bounded local buffer. One-page lookahead is still too easy to outrun with repeated swipes.
- Avoid showing passive polling text such as `Checking replies...` in the footer. Keep the footer quiet unless there is a meaningful transient state such as `New reply`, `Sent`, recording, or scroll direction feedback.
- Root chat-list double-click should not invoke shutdown because touch-and-hold already reaches the Even Hub shutdown flow on hardware.
- Touch-and-hold on the root screen already triggers the Even Hub shutdown flow on hardware, so root double-click is better used as an app-level screen-off/asleep shortcut.
- The SDK version in use does not document a dedicated screen-off API. The app should render a blank/asleep screen and optionally attempt best-effort native methods such as `screenOff` when present.
- While asleep, keep root chat polling active. A changed recent chat with unread count should wake the display into a `New Telegram` prompt; clicking that prompt should open the target chat, and for forum chats it should resolve the first unread topic when available.
- Manual wake from the app-level asleep screen should only respond to double-click. Single click, swipe, and foreground events should leave the app asleep and re-request screen-off so accidental touches do not turn the display back on.
- Long message display should include visible block markers before and after each message. Splitting long messages into chunks without separators makes it hard to tell where a Telegram message begins or ends while scrolling.
- Messages over roughly twenty-five words read better as fixed-width/native-bordered text boxes on G2. Keep short messages compact as `Sender: text`; render longer messages with a sender header and wrapped content rows inside a native `TextContainerProperty` border.
- Do not infer native text-box content by parsing text-drawn ASCII boxes from the glasses body. Keep a structured `box` projection alongside the debug/body text so the bridge can send clean `heading`/`content` to the native bordered container. Otherwise the glasses can show both the native box and old `+---` marker format.
- Long-message boxes should paginate as complete rectangles. Each scroll stop should include exactly one boxed page so text never appears outside the box while reading through a long message.
- Compact/non-box messages should scroll by full visible pages, not by individual message blocks. If each short message is its own scroll unit, repeated swipes make the latest page appear to shed one message at a time before a whole-page jump.
- Boxed-message pages and compact-message pages need different scroll semantics:
  - Inside a multi-page boxed message, swipe up/down should move one box page at a time.
  - At the first/last boxed page, the next swipe should move to the adjacent message/page.
  - For compact messages, one swipe should move to the previous/next visible page.
- The frontend message window must be both byte-bounded and visible-line-bounded. Sending a latest page that is under `999` bytes but taller than the body container lets firmware keep its own internal scroll position, so `scrollOffset: 0` may show the last page but not the actual last message. Keep the model output to the visible row count so the newest window ends at the latest message marker.
- Message content and control hints should be separate containers where possible. This avoids mixing scrollable message text with footer/control text.

## Input Events

- Simulator and real G2 hardware emit different event shapes.
- Scroll events can work while click events do not, so event mapping must handle:
  - SDK-normalized events
  - raw/protobuf-like events
  - gesture `eventType` values from `listEvent`, `textEvent`, or `sysEvent`
  - `camelCase`
  - `snake_case`
  - protobuf-style names such as `Event_Type`
  - numeric strings
  - press/tap aliases
- The SDK can normalize `CLICK_EVENT` value `0` to `undefined` in some paths. Treat missing `eventType` on an event-capturing text/list container as a single press.
- Double-click can surface as a `sysEvent` rather than a `textEvent`/`listEvent` depending on the active container/layout. Match Caduceus/even-toolkit behavior by mapping gestures from `listEvent ?? textEvent ?? sysEvent`.
- The SDK parser may produce `sysEvent` with `eventSource` but without `eventType`, while raw `jsonData.eventType` still contains the real value. Preserve raw `jsonData.eventType`; otherwise captured hardware payloads such as `{ eventType: 3, eventSource: 2 }` can incorrectly fall through to single press.
- Native list events can identify the selected row by item name instead of index. Preserve `currentSelectItemName`/`CurrentSelect_ItemName`/`current_select_item_name` and resolve it against visible chat/topic labels, stripping unread-count suffixes before matching.
- During the double-click investigation, hardware logs showed the actual double-click payload as:
  - raw `jsonData`: `{ "eventType": 3, "eventSource": 2 }`
  - normalized `sysEvent`: sometimes `{ "eventType": 3, "eventSource": 2 }`, sometimes only `{ "eventSource": 2 }`
  - stale frontend builds mapped this to single press.
- If logs show `eventType: 3` but mapped input is `press`, first verify the running `buildVersion` before changing gesture code. The final fix was already correct locally; the device was still running stale package code.
- A list click may surface only as a selection event with the same index already highlighted. If using native lists, `selectIndex` on the current item should be interpreted as a press.
- Relying on native `ListContainerProperty` for navigation was unreliable on hardware. Clicks only registered inconsistently.
- The reliable hardware pattern, borrowed from `~/Work/g2-caduceus`, is:
  - Render list-like UI as plain text.
  - Add a full-screen invisible text container with `isEventCapture: 1`.
  - Manage selection/highlight in app state.
  - Re-render text on swipe to move the visible highlight.
- Do not synthesize double press by coalescing two click events. Hardware can emit duplicate tap payloads, and delayed coalescing made single tap behavior unreliable.
- Use immediate tap dispatch with duplicate debounce instead:
  - Single tap dispatches immediately.
  - Near-duplicate tap payloads are ignored.
  - Native `DOUBLE_CLICK_EVENT` maps to double press/back.
- Avoid synchronously rebuilding the page or starting audio on the first tap when that same screen also supports double-click. On G2 hardware, changing page state immediately after the first tap can prevent the native double-click event from being generated. Delay only the conflicting single-tap action briefly; keep list/chat selection immediate.
- Current debounce constants:
  - duplicate tap debounce around `90ms`
  - duplicate double-tap debounce around `140ms`
  - post-double-tap cooldown around `30ms`
- Scroll events may also duplicate on hardware. Caduceus suppresses repeated same-direction scrolls for a short window and suppresses spurious scrolls shortly after text updates.
- Same-direction swipe duplicates inside 30ms are suppressed. Longer rapid swipe sequences must remain intact for fast navigation.
- Background state refreshes must not overwrite the controller-owned text sidebar selection.
- Render the initial chat list before speculative prefetch. Delay warming until the startup/input path is idle, bound the number of chats/topics warmed, and dispose delayed work on React remount.
- Native/SDK stalls can release multiple buffered gestures together. Collapse each short delivery burst to the latest gesture; never allow a backlog to replay after the app has transitioned to another screen.
- Skip unchanged `TextContainerUpgrade` calls. Each native upgrade can take hundreds of milliseconds on hardware, so updating title/footer/box when their content did not change directly increases input starvation.
- Open message threads should use the full 576 px width. Keep the split layout only for chat/topic selection and restore it with double click.
- Confirmation after transcription must be a standalone screen with transcript and actions, not controls painted over the active message page.

## Audio

- The documented SDK exposes press, double press, and swipe. True hold was not used for v1 recording UX.
- Current recording fallback:
  - Single press starts recording.
  - Single press stops recording and transcribes.
  - Double press cancels/back.
- Audio control uses `bridge.audioControl(true/false)`.
- Audio arrives through `audioEvent.audioPcm`.
- Expected format is 16 kHz signed 16-bit little-endian PCM.
- The frontend wraps collected PCM chunks as WAV before sending to `/api/transcribe`.
- Simulator microphone input can produce silent/all-zero audio. The app guards against too-short/all-zero recordings to avoid unnecessary Whisper calls.
- On hardware, audio can cut off if tap events duplicate or if a stop tap is interpreted too early. The Caduceus app handles this better with:
  - a recorder abstraction
  - minimum recording duration
  - optional VAD/silence auto-stop
  - auto-stop callback that closes the mic and still delivers the WAV blob
- If audio remains unreliable, port the Caduceus recorder/VAD pattern next rather than relying only on manual start/stop.

## Backend And Debugging

- Public builds keep Telegram API credentials, the required backend shared secret, and the MTProto StringSession in phone localStorage. Telegram/session requests use encrypted `X-TeleGlance-Auth`; do not put session strings or shared secrets in URLs, cookies, `.env` beyond `TELEGLANCE_SHARED_SECRET`, or debug logs.
- The backend no longer exposes QR login or compatibility auth endpoints. Phone-code login is the only supported Telegram login path.
- JSON Telegram request/response bodies are encrypted with the shared secret. CORS must expose `X-TeleGlance-Encrypted` or the frontend cannot detect/decrypt encrypted responses.
- The backend `/api/transcribe` endpoint runs local `faster-whisper` and requires encrypted shared-secret auth when using the main backend. The phone setting `STT Server Url (Optional)` should be blank unless the user runs a trusted compatible STT server. Custom STT requests intentionally do not receive Telegram auth headers.
- Hardware debug logging is useful because WebView console access is limited.
- The backend has temporary in-memory debug endpoints:
  - `POST /api/debug/events`
  - `GET /api/debug/events`
  - `DELETE /api/debug/events`
- The debug endpoints require encrypted shared-secret auth. The frontend logs each raw Even Hub event plus its mapped app input to `/api/debug/events` only when debug logging is enabled and auth settings are configured.
- Debug logs should include the frontend `buildVersion` during hardware validation. This is the fastest way to distinguish a real mapping bug from stale device code.
- If hardware input fails again:
  - Clear events with `DELETE /api/debug/events`.
  - Perform the failing gesture on glasses.
  - Inspect `GET /api/debug/events`.
  - Confirm `build_version` is the expected package version.
  - If the version is stale or null, fully remove/reinstall the packaged app.
  - If no events appear at all, use ADB/logcat because the WebView may not be receiving the event.
- Telethon operations wrapped with `asyncio.wait_for` can time out transiently when the phone/glasses repeatedly hit chat/message endpoints. Treat these as retryable backend service timeouts (`504`) rather than `400 Bad Request` or `500`, and keep the glasses error copy retry-oriented.

## Telegram-Specific Hardware Validation

- The real Telegram phone-code login flow has succeeded with encrypted frontend-supplied credentials/session.
- Real chat loading, forum topic listing, and forum topic message loading were validated against the Akira Agents group.
- For Telethon `1.43`, forum message history uses `topic.id`, not `topMessageId`; `topMessageId` remains useful DTO/debug context.
- Incoming forum update payloads can identify the topic differently from the history API. Treat matching chat id with `topic.id`, `topMessageId`, or a missing topic id as a reason to refresh the active forum thread; the follow-up history fetch is the source of truth.
- Topic preview fetches must remain selected-topic scoped. Clear cached preview fields when selection changes and only reuse preview messages when the cached `previewTopic.id` equals the selected topic id, or a fast swipe/press can display one topic's messages while opening another.
- When opening a forum chat, start fetching the first selected topic preview immediately. Before preview messages arrive, the right side should show selected-topic loading copy, not a duplicate of the left topic list.
- Avoid backend topic-list preview fanout. Fetching one latest message per topic serially can stall `/topics` on large forum groups; return forum topic metadata quickly and let the frontend preview/open path fetch messages for the selected topic.
- Telethon forum/reply history can return messages without `message.sender` populated while the result contains separate `users`/`chats` entity lists. Normalize sender names from those bundled entities using `from_id`/peer ids before returning API DTOs, otherwise incoming replies render as `Unknown`.
- After sending, the frontend refreshes the newest messages, briefly polls so quick replies appear on glasses, and resets the visible pointer to the latest message.
- Incoming replies detected while reading older content should jump back to the newest/latest pointer.
- The glasses text renderer has a narrower practical line width than the browser/debug pane. A 44-character Unicode box can look correct in the browser but wrap badly on the glasses display; use ASCII borders and keep boxed message lines around 30 characters total so the right border stays on the same rendered row. Normal trailing spaces can be collapsed or ignored before a right border, so boxed rows use non-breaking space padding.
- Text-drawn rectangles still do not visually align on G2 because the glasses renderer is not a true monospace grid; hyphens and letters have different pixel widths. For long-message pages, prefer native `TextContainerProperty` borders and put the message text inside the bordered container instead of drawing borders with text.
- The browser/debug pane and glasses display are not interchangeable for final layout QA. The browser can make text-drawn boxes look correct while the glasses pane exposes proportional glyph widths, collapsed spacing, or firmware wrapping. Treat the glasses pane or real G2 as the source of truth.
- LVGL can warn on unsupported Telegram glyphs, including colored-circle emoji and other pictographic emoji seen in real messages. Replace known status circles with text labels and strip unsupported emoji ranges before rendering to glasses text containers to avoid repeated `glyph dsc. not found` warnings.
- Compact message rows should wrap on word boundaries just like boxed long-message rows. Character-based wrapping makes ordinary messages split words mid-letter on the G2 display.

## Current Known Good Input Pattern

The click reliability fix that worked on real hardware in package `0.1.4` was:

1. Render chat/topic/confirmation lists as text, not native list containers.
2. Put an invisible full-screen event-capturing text overlay over the page.
3. Dispatch single tap immediately.
4. Debounce duplicate tap payloads.
5. Trust native `DOUBLE_CLICK_EVENT` for back/cancel instead of synthesizing double press.
6. Re-render app-managed text highlight on swipe.
7. For message screens, delay tap-to-record briefly so double-click-back can win before audio starts and the page rebuilds.
8. Preserve raw `jsonData.eventType` before SDK normalization can drop it.
9. Verify the device is actually running the intended build before interpreting gesture results.

This should be treated as the baseline for future G2 screens in this app.

## Remaining Hardware QA Cases

- Audio recording on real G2 after the input reliability fix.
- Minimum recording duration and VAD behavior.
- Phone locked or backgrounded.
- Idle for more than two minutes.
- Returning from another phone app.
- Root-page exit behavior.
- Recovery after backend disconnect.
- Backend URL changes from the phone/debug config screen.
- Real message send/receive smoke test before private release.
