# TeleGlance UI Invariants

This document is the source of truth for every screen the glasses can show. The simulator harness (`scripts/simulator-flow.mjs`) consumes `docs/UI_INVARIANTS.json`, which is generated from the same definitions that appear in this file.

## 1. Layout contract

The glasses display is `576 x 288` pixels. The Even Hub SDK imposes these hard limits, which the harness enforces on every render event.

| Region         | Container                                       | Byte limit | Visible rows       | Other                                          |
| -------------- | ----------------------------------------------- | ---------- | ------------------ | ---------------------------------------------- |
| `title`        | `TextContainerProperty`                         | 120        | 1-2                | full width                                     |
| `outer`        | `TextContainerProperty`                         | 0          | n/a                | 2 px border, color 8                           |
| `sidebar`      | `TextContainerProperty`                         | 999        | 7 visible rows      | left x=2, y=38, width=166                      |
| `separator`    | `TextContainerProperty`                         | 0          | n/a                | x=168, width=2, height=206                     |
| `panelBody`    | `TextContainerProperty`                         | 999        | up to 12 compact rows | right x=170, y=38, width=404                |
| `panelBox`     | `TextContainerProperty`                         | 999        | up to 8 rows       | x=184, y=54, width=376, 1 px border            |
| `panelFooter`  | `TextContainerProperty`                         | 120        | 1-2                | x=2, y=248, width=572                          |
| `eventOverlay` | `TextContainerProperty`                         | 0          | n/a                | full size, capture 1 when focus=panel          |
| hidden list    | `ListContainerProperty`                         | n/a        | 1 empty item       | hidden 1x1 compatibility container, capture disabled (text/sidebar pages) |
| native list    | `ListContainerProperty`                         | item names <= 64 | 1-20 items   | chat/topic list pages only: x=2, y=38, 572x208, capture 1, selection border on (section 1.6) |

Harness invariants on every render:
- `model.title` UTF-8 bytes <= 120
- `model.panelBody` UTF-8 bytes <= 999
- `model.panelFooter` UTF-8 bytes <= 120
- `model.sidebarItems` length 1..20, each item byte length <= 64
- For `kind === 'sidebar'` without `nativeList`, the bridge always renders container IDs `0..7` (the harness parses the bridge JSON for these IDs and asserts no stale container survives a state change)
- For `kind === 'sidebar'` with `nativeList` (chat and topic lists), the bridge renders the native list page: container IDs `0, 1, 4` (text) and `8` (list), section 1.6
- Every page stays within the host limits (README of `@evenrealities/even_hub_sdk` 0.0.16 and on-glasses evidence): 1-12 containers, at most 8 text containers, exactly one `isEventCapture: 1`, `zOrderIndex` on all containers or none (unique). `web/test/evenBridge.test.ts` asserts this for the native list page and its text fallback

## 1.5 Container ID contract

Container IDs are shared across `TextContainerProperty`, `ListContainerProperty`, and `ImageContainerProperty` objects passed to the Even Hub SDK. The firmware treats container ID as a unique key; duplicate IDs cause one container to be silently dropped.

| ID  | Container        | Type | Notes                                               |
| --- | ---------------- | ---- | --------------------------------------------------- |
| 0   | `outer`          | Text | 2 px border, full size                              |
| 1   | `title`          | Text | Top bar, 36 px height                               |
| 2   | `event-overlay`  | Text | Full-size transparent tap target                    |
| 3   | `separator`      | Text | 2 px vertical line between sidebar + panel          |
| 4   | `footer`         | Text | Bottom bar, 38 px height                            |
| 5   | `sidebar`        | Text | Sidebar text content (panel-focus only)             |
| 6   | `panelBody`      | Text | Right-side message/preview text                     |
| 7   | `panelBox`       | Text | Bordered message box (optional)                     |
| 8   | `list` / `chat-list-<n>` / `topic-list-<n>` | List | Hidden 1x1 compatibility list on text and sidebar pages; the visible, event-capturing native list on chat/topic list pages (`<n>` numbers each drawing of the list, section 1.6) |

**Invariant**: Container IDs MUST be unique across ALL containers sent in a single `rebuildPageContainer` or `createStartUpPageContainer` call. A list container and a text container with the same ID is a bug. Every render event's bridge payload MUST be validated by the harness for:
- All container IDs are unique across `textObject`, `listObject`, and `imageObject`
- On text and sidebar (non-list) pages `listObject[0]` is the hidden list (1x1, one empty item, no capture, no selection border) and one text container captures input (`event-overlay`, `body` or `body-events`)
- On chat/topic list pages `listObject[0]` is the visible native list and is the only container capturing input
- `containerTotalNum` equals `textObject.length + listObject.length + imageObject.length`
- No `TextContainerProperty` has `containerID === 8`

## 1.6 Native list contract (chat and topic lists)

The chat list and the forum topic list are drawn by the glasses firmware as a native list (`ListContainerProperty`), like other G2 apps: a selection box (`isItemSelectBorderEn: 1`) around the whole row, scrolled by the firmware with momentum, so a big swipe on the glasses or the R1 ring moves through several rows. The firmware does not tell the app where the box is; only a click reports a row.

**Page shape** (`buildNativeListPage` in `web/src/bridge/evenBridge.ts`), 4 containers, no `zOrderIndex`:

| ID | Name | Type | Geometry | Notes |
| -- | ---- | ---- | -------- | ----- |
| 0 | `outer` | Text | 0,0 576x288, border 2 | |
| 1 | `title` | Text | 2,2 572x36 | `Chats`, `<folder> <n>/<total>` or the forum title |
| 4 | `footer` | Text | 2,248 572x38, border 1 | controls; status; `New activity` while an update is held |
| 8 | `chat-list-<n>` / `topic-list-<n>` | List | 2,38 572x208, padding 4 | `isEventCapture: 1`, `itemCount` = rows (1-20), `itemWidth: 0`, `isItemSelectBorderEn: 1` |

**Limits.** The SDK (0.0.16 `index.d.ts`, README) declares no list limits and no way to set the selected row; the host limits used are the ones this app has always enforced (AGENTS.md "list item count 1-20", harness "item byte length <= 64"): at most 20 rows, each item name at most 64 UTF-8 bytes (`NATIVE_LIST_MAX_ITEMS`, `NATIVE_LIST_ITEM_BYTES`). An empty list still sends one placeholder row (`Empty`, or `Loading more chats...` while a folder loads).

**Windowing.** The controller's `selectedChatIndex` / `selectedTopicIndex` is the list's *anchor*, not the highlighted row: the window starts at it (`nativeListWindow` in `web/src/controller/model.ts`). Rows: the chats/topics from the anchor, then `More chats...` / `More topics...` if anything follows (loaded, or more chats on the server), then `Back to top` if the window does not start at the top. A page rebuild puts the firmware's box on row 0 (seen in the simulator, and the reason the native list was dropped in June 2026), so row 0 is always the anchor item:
- startup, folder switch, `Back to top`, double press out of the folder picker: anchor 0 (the top);
- returning from a chat or topic (double press), or waking from sleep: anchor = the chat/topic that was open, so the box is on it again and one click reopens it (this is how "selection kept by chat id" survives without a way to set the highlight);
- `More...`: anchor = the first chat after the last row shown; when that window would reach the end of the loaded chats and the server has more, the next 20 are fetched first (footer `Loading more chats...`), then the window is drawn.

**Input.**
- Swipes move only the firmware box. The simulator sends no event at all; real glasses may send bare scroll events. Either way the app does not move its anchor, does not render, and only notes that the list was touched.
- A click arrives as a list event: `currentSelectItemIndex` (+ `currentSelectItemName` when the host sends it) and the container name. Row 0 often comes with no index at all (protobuf omits 0): a list event that names its container but no row is row 0 (`mapEvenHubEvent`). The row is read against the rows *as drawn* (`shownList` in the controller), never against newer data: index in range wins unless the reported name names another drawn row; out of range falls back to the name; neither -> ignored (debug note `list.click-unresolved`).
- A click whose container name is not the page last drawn (`chat-list-<n>` numbering) is from a page being replaced and is dropped (`list.stale-click`).
- A row-0 report within `nativeListEchoMs` (150 ms) of the list landing (or being sent, before it lands) is dropped: native lists were seen to report their highlighted row by themselves when drawn.
- Double press keeps its meaning (folder picker or sleep on chats, back to chats on topics). Long press is ignored on lists.
- While the glasses still show the plain-text startup page (`showingStartupText`), the list behaves as before: swipes move a `> ` marker in that text and a press opens the marked chat; the native list that lands afterwards starts at the marked chat.

**Live updates (hold rule).** A rebuild of the list puts the box back on row 0, and the app does not know where the user left it. So:
- If the list was not touched (no swipe) since it was drawn, background changes (stream/poll refresh, unread counts, reordering, the stored -> fresh chat list at startup, a refreshed topic list) redraw it. A window that starts at the top stays at the top; one anchored further down keeps its anchor chat/topic by id.
- Once the user has swiped it, a change of the drawn rows that the user did not cause is **held**: the state takes the new data, only the title/footer containers are updated (`New activity | ...` in the footer, `listUpdatePending` in the state), and the rows are redrawn at the next rebuild the user causes: opening and leaving a chat, `Back to top` / `More...`, a folder switch, waking, or the app coming back to the foreground. Changes that leave the drawn rows identical only update the title/footer. A list that only shows a placeholder row is always replaced.
- Partial updates on a native list page touch only containers 1 and 4; the list container is never updated in place.

**Fallback.** If the host refuses a native list page (a quick `false`, or still refused after the timeout retries), the bridge draws the same screen as the long-standing text page (marker list in `panelBody`, event overlay), reports `supportsNativeList() === false` from then on and tells the controller (`onNativeListUnavailable`), which goes back to moving the marker itself (sections 4.5-4.7 text behaviour). Bridges without native-list support (tests, the browser fallback) always get the text pages.

**Hardware-only checks.** The simulator confirms: the page is accepted, up/down move the box with no app event, a click reports the row index (no name; no index for row 0), double click arrives as a system event, and a rebuild puts the box on row 0. Only real glasses/R1 can confirm: momentum scrolling, whether scroll events or row-0 echoes arrive, whether `currentSelectItemName` is sent, the 20-item/64-byte limits, and how the ring's click arrives.

## 2. Matcher rules

`contains` arrays are matched against the screen model with:
- Case-insensitive substring match
- Whitespace normalised to single space
- For `panelBox.heading.contains` and `panelBox.content.contains`, the matcher applies the same `formatBoxContent` pipeline the bridge uses, so it tolerates the same `+`, `-`, `|` decorations the bridge removes
- For `panelBody.contains` on text-kind screens, the matcher ignores trailing ellipsis added by `trimForContainer`
- `renderBodyContains` matches against the latest render model emitted by the bridge (`[TeleGlanceTest] {"event":"render",...}` payload). Each needle is a substring of the JSON-serialised model.
- `renderBodyNotContains` is the inverse: each needle MUST NOT appear anywhere in the render model. Use it to catch stale data: a previous chat/topic name leaking through after a swipe, "Older fixture" surviving a back navigation, "Sent" status persisting into a new recording, the wrong preview body on a cached-only topic.
- `noLifecycles: ["asleep", "wake"]` fails the step if any matching `lifecycle` event fires during the step's input window. The G2 simulator (and the real G2 hardware on screen-timeout) fires system `doublePress` events that send the controller to `asleep` and back. The user perceives this as "scroll doesn't work" or "I select something and something else opens up". Use `noLifecycles: ["asleep", "wake"]` on a single-input step with a budget >= 4s to assert the controller stays in the active screen during a known-good interaction.
- `noContainerFailures: true` fails the step if the simulator rejected any `textContainerUpgrade` call during the step (matched by the `[simulator] [WARN ...] TextContainerUpgrade failed: container N not found` log line). The G2 simulator emits this warning when the WebView asks to update a container ID the current page layout does not own. Each rejected call means the panel body, panel box, or sidebar text did not update visually on the glasses — the exact class of bug ("ghost text", "stale right side") that passes the state-only harness checks but is visible to the user on the display.

`notContains` catches stale data: stale chat name on the right panel after a swipe, "Older fixture page" appearing twice, "Sent" status surviving into the next recording flow.

## 3. Performance budgets

| Budget                | Value (ms) | What it covers                                                                          |
| --------------------- | ---------: | --------------------------------------------------------------------------------------- |
| `maxTransitionMs`     | 1000       | Every state-to-state step. Includes input posting, controller dispatch, render, capture |
| `maxApiCallMs`        | 300        | Single `api.*` call. Multiple calls in one step sum independently                       |
| `maxMessageLoadMs`    | 1000       | `press` -> `state.screen === 'sidebar'` & `focus === 'messages'` & messages non-empty   |
| `maxChatLoadMs`       | 1000       | `init` -> `state.screen === 'sidebar'` & `focus === 'chats'`                            |
| `maxSendRoundtripMs`  | 2000       | `press` on `sidebarConfirm` (Send) -> `state.status === 'Sent'` and outgoing message    |
| `maxSwipeSelectionMs` | 50         | `swipeUp`/`swipeDown` on chat/topic list -> `selectedIndex` update (no render)         |
| `maxInitialRenderMs`  | 800        | First `render` event after `init()` completes                                          |
| `maxLoadingStateMs`   | 500        | `press` on chat/topic -> render with loading status must appear before blocking I/O    |
| `maxRightPanelUpdateMs`| 1000      | Topic preview / background message refresh -> right-panel update without left flicker  |
| `longRunningStates`   | --         | `sidebarTranscribing`, `sidebarSending`                                                 |

Per-step latencies are split into `stateMs` (input -> matching state event), `apiMs` (sum of `api` event durations), `renderMs` (render event -> screenshot), `totalMs` (wall clock).

## 3.5 UI responsiveness (non-blocking invariants)

- Opening a chat or topic MUST render a loading state (right panel only) within `maxLoadingStateMs` before any network I/O blocks the controller
- Native chat/topic lists (section 1.6): swipes MUST NOT trigger any render or state change; the firmware moves the selection. Text-fallback lists: swipes MUST update `selectedIndex` within `maxSwipeSelectionMs` without triggering a full render
- Topic preview fetching (text fallback only) MUST NOT block sidebar scroll input; controller selection moves before preview loading completes
- Startup prefetching MUST NOT delay the first visible chat list render past `maxInitialRenderMs`; speculative warming begins after 1.2 seconds and is bounded to chats 2-3 plus at most one forum topic
- SDK-delivered gestures are dispatched at most one per 20 ms window. Movement (swipes, list selection, foreground) MUST be latest-wins so a stale swipe burst cannot replay on a later screen, but presses (press, double press, long press/release) MUST never be coalesced or dropped, and a swipe still pending when a press arrives MUST be dispatched before the press (so "swipe then press" opens the row swiped to). The backlog is capped at 4 entries
- Background refreshes MUST NOT overwrite the controller-owned sidebar marker, and MUST NOT redraw a native list the user has swiped since it was drawn (hold rule, section 1.6)
- Async results from stale requests (previous chat open that was abandoned by backing out) MUST be discarded silently
- Text-fallback chat/topic scroll MUST dispatch a partial render through `bridge.enqueueSidebarPanel` rather than a full rebuild. The partial update includes the text sidebar marker and right panel. Rapid swipes MUST coalesce so only the latest model reaches the glasses. On a native list page a partial update only rewrites the title and footer
- The bridge exposes `render.partial.enqueue` and `render.partial.flush` events for the harness to verify coalescing. `getPartialRenderStats().dropped > 0` is expected during a swipe streak

### 4.1 `loading`
- **state**: `{ screen: 'loading', message: 'Starting...' or 'Checking Telegram session...' }`
- **render**: `{ kind: 'text', title: 'Telegram' }`
- **body.contains**: `['Checking Telegram session']` (default) OR `['Starting']` (briefly during boot)
- **transitions**: `press` -> stays (no-op). `foreground` -> re-runs `init()`
- **budget**: 500 ms
- **apiCalls**: `authStatus`
- **eventMustEmit**: `lifecycle.kind === 'start'`

### 4.2 `auth.needsSetup`
- **state**: `{ screen: 'auth', mode: 'needsSetup', message: 'Follow the in ... on the phone.' }`
- **render**: `{ kind: 'text', title: 'Telegram' }`
- **body.contains**: `['instructions', 'Settings']`
- **transitions**: `press` -> stays; message re-rendered. `doublePress` -> `bridge.showExitConfirmation()` invoked; state stays on `auth.needsSetup` (the host app owns the dismissal flow).
- **budget**: 500 ms
- **apiCalls**: `authStatus` returns `{ configured: false, authorized: false }`
- **bridgeCalls**: `showExitConfirmation` is called once on `doublePress` from the auth screen.

### 4.3 `auth.signedOut`
- **state**: `{ screen: 'auth', mode: 'signedOut', message: '... phone number ...' }`
- **render**: `{ kind: 'text', title: 'Telegram' }`
- **body.contains**: `['phone number']`
- **transitions**: `press` -> stays. `doublePress` -> `bridge.showExitConfirmation()` invoked; state stays on `auth.signedOut`.
- **budget**: 500 ms
- **apiCalls**: `authStatus` returns `{ configured: true, authorized: false }`
- **bridgeCalls**: `showExitConfirmation` is called once on `doublePress` from the auth screen.

### 4.4 `auth.phonePending`
- **state**: `{ screen: 'auth', mode: 'phonePending', message: '... code ...', phone: '+1...' }`
- **render**: `{ kind: 'text', title: 'Telegram Login' }`
- **body.contains**: `['code']`
- **transitions**: `press` -> stays
- **budget**: 500 ms
- **apiCalls**: `startPhoneAuth` then `verifyPhoneAuth`

### 4.5 `sidebar.chats` (root chat list, native list, full width, no preview)
- **state**: `{ screen: 'sidebar', focus: 'chats', chats: [...], selectedChatIndex, listUpdatePending? }`; `selectedChatIndex` is the list's anchor (section 1.6), not the highlighted row
- **render**: `{ kind: 'sidebar', title: 'Chats', focus: 'panel', fullWidth: true, nativeList: { name: 'chat-list', items, keys } }`
- **glasses**: the native list page (section 1.6). `nativeList.items` are the unread-first labels from the anchor (`(3) Fixture Forum`), then `More chats...`, then `Back to top`; `keys` are `chat:<id>` / `more` / `top`. `panelBody` is only the plain-text fallback (startup page, refused native list) with a `> ` marker on the anchor
  - `panelFooter`: `'Swipe chats | Press open'`; `Loading more chats...` while the next page loads; `New activity | ...` while an update is held
  - `panelBox`: `null`; no message previews anywhere
- **transitions**:
  - `swipeUp` / `swipeDown` -> no state change, no render (the firmware moves the box)
  - click on a chat row -> `sidebar.messages.normal`, or `sidebar.topics` for a forum
  - click on `More chats...` -> `sidebar.chats` anchored at the next chat (fetching the next page first when needed)
  - click on `Back to top` -> `sidebar.chats` anchored at 0
  - `doublePress` -> `asleep` when the account has no Telegram folders; bridge must call `turnScreenOff` before state event
  - `doublePress` -> `sidebar.folderPicker` when the account has folders
- **returning**: double press from a chat's messages draws the list anchored at that chat (box on it; a click reopens it)
- **paging**: 20 chats per server page. No automatic loading while scrolling; `More chats...` loads the next page (`offset` = loaded count), appended without duplicates.
- **backend cache**: the backend fetches chats from Telegram in blocks of 100 (one request each) and keeps them for 45 s, so consecutive pages cost no extra Telegram requests. Page one (`offset=0`) is always refetched and refreshes only the head of the cache, so background refreshes never discard pages already scrolled in. Folder pages scan from the top once and look ahead 60 matches on deeper pages.
- **title**: `Chats`, or `<folder> <n>/<total>` (e.g. `Work 2/3`) when folders exist.
- **text fallback** (host refused native lists): the long-standing marker list: swipes move `selectedChatIndex` (clamped, no network), a press opens the marked chat, and the next page loads when the marker is within 3 rows of the end.
- **budget**: 500 ms per click, 1000 ms after `init`
- **apiCalls**: `listChats` (+ `listFolders` at startup, + paged `listChats` from `More chats...`). No `listMessages`/`listTopics` and no read acknowledgements while browsing the list; messages load when a chat is opened.

### 4.5a `sidebar.folderPicker` (choose a Telegram folder or sleep)
- **state**: `{ screen: 'folderPicker', chats, selectedChatIndex, options: ['All chats', ...folders, 'Sleep'], selectedIndex }`
- **render**: `{ kind: 'sidebar', title: 'Folders', focus: 'panel', fullWidth: true }`; the body is the windowed option list with a `> ` marker on `selectedIndex`
- **right**: `panelFooter`: `'Swipe choose | Press select | Double back'`; `panelBox`: `null`
- **transitions**:
  - `swipeUp` / `swipeDown` -> `selectedIndex` moves (clamped)
  - `press` on a folder -> `sidebar.chats` for that folder (cached pages are restored; otherwise page 1 is fetched, falling back to the previous folder with an error status on failure)
  - `press` on `Sleep` -> `asleep`
  - `doublePress` -> `sidebar.chats` for the current folder, scrolled to the top (first chat selected)
- **fixture note**: the fixture account has no folders, so the simulator harness never reaches this screen; it is covered by `web/test/controller.test.ts` (`folders`).

### 4.6 `sidebar.topics` (forum topics, native list, full width, no preview)
- **state**: `{ screen: 'sidebar', focus: 'topics', chat, topics: [...], selectedTopicIndex, listUpdatePending? }`; `selectedTopicIndex` is the anchor
- **render**: `{ kind: 'sidebar', title: <forum title>, focus: 'panel', fullWidth: true, nativeList: { name: 'topic-list', items, keys } }`
- **glasses**: the native list page (section 1.6) with the topics (`(1) Fixture Topic One`), `More topics...` and `Back to top` as for chats; footer `TAP TO OPEN TOPIC` (status first when `Offline`)
- **no preview**: nothing is fetched while browsing topics; a topic's messages load when it is opened (accepted trade-off: the native list cannot report the highlighted topic, so a preview could not follow it)
- **transitions**:
  - `swipeUp` / `swipeDown` -> no state change, no render
  - click on a topic -> `sidebar.messages.topic` (`listMessages` with the forum **topic id**)
  - click on `More topics...` / `Back to top` -> `sidebar.topics` re-anchored
  - `doublePress` -> `sidebar.chats` anchored at the forum
- **returning**: double press from a topic's messages draws the topic list anchored at that topic
- **budget**: 1000 ms
- **apiCalls**: `listTopics` (stored topic lists open at once and are refreshed behind; the hold rule applies to the refresh)

### 4.7 `sidebar.topics.noPreview` / `sidebar.topics.preview` (text fallback only)
Only when the host refused native lists (section 1.6): topic list on the left with a `> ` marker, preview of the marked topic on the right (`Loading messages...` until it arrives, then the cached/fetched messages; it must never show another topic's messages), footer `TAP TO OPEN TOPIC`. Swipes move `selectedTopicIndex` and fetch the preview after a short idle delay; `press` opens the marked topic; `doublePress` returns to `sidebar.chats`.

### 4.8 `sidebar.messages.normal` (normal chat messages, no loading)
- **state**: `{ screen: 'sidebar', focus: 'messages', chat, messages: [...], cursor, isNewestPage: true, scrollOffset: 0, back }`
- **render**: `{ kind: 'sidebar', focus: 'panel' }`
- **layout**: `fullWidth === true`; the sidebar and separator are hidden and message content spans the full display width
- **content**:
  - `panelBody.contains`: each visible message's `text`. For `fixture-chat-0`: `'Alpha message page contains fixture-alpha-body for startup testing.'` and `'Alpha outgoing marker for visual validation.'`
  - `panelBody.byteLength`: <= 999
  - `panelFooter`: `'Swipe scroll | Hold to record | Double click back'`
  - `panelBox`: optional for long messages
- **transitions**:
  - `press` -> `sidebarRecording`
  - `doublePress` -> `back` (which is `sidebar.chats` for normal chats)
  - `swipeUp` -> `loadOlderMessages`; intermediate `state.status === 'Loading older messages...'`
  - `swipeDown` on newest page -> no-op
  - `swipeDown` on older page -> returns toward newest
- **budget**: 1000 ms first page; 1000 ms per older page
- **apiCalls**: `listMessages` on open, `markRead` after first frame

### 4.9 `sidebar.messages.topic` (forum topic messages, no loading)
- **state**: same as `sidebar.messages.normal` with `topic`, `topics`, `selectedTopicIndex` populated
- **render**: `{ kind: 'sidebar', focus: 'panel' }`
- **left**:
  - `sidebarTitle`: `'Topics'`
  - `sidebarItems`: topic list, marker at `state.selectedTopicIndex`
- **right**: same rules as `sidebar.messages.normal`
- **transitions**:
  - `doublePress` -> `back` (which is `sidebar.topics` for forum topics), NOT chats
- **budget**: 1000 ms
- **apiCalls**: `listMessages(chat.id, { topicId, limit: 50 })` using **forum topic id**, not `topMessageId`

### 4.10 `sidebar.messages.typing` (typing indicator active in message view)
- **state**: same as `sidebar.messages.normal` plus `typing: { userName: 'Alice', expiresAt: <future timestamp> }`
- **render**: `{ kind: 'sidebar', focus: 'panel', fullWidth: true }`
- **content**:
  - `panelBody`: unchanged from the parent message view
  - `panelFooter`: `'<userName> typing\u2026'` (e.g. `'Alice typing\u2026'`), \u2264 120 bytes
  - `panelFooter.notContains`: normal controls (`'Swipe scroll'`, `'Hold to record'`, `'Double click back'`)
- **transitions**:
  - auto -> `sidebar.messages.normal` after 5s timeout or on `cancel` update
  - `press` -> `sidebarRecording` (still works; typing cleared on transition)
  - `doublePress` -> `back`
- **budget**: 500 ms to render after typing injection

### 4.11 `sidebar.messages.typing-resolved` (typing cancelled or timed out)
- **state**: `typing: null`, footer restored to `sidebar.messages.normal`
- **render**: same as `sidebar.messages.normal`
- **content**:
  - `panelFooter.contains`: `'Swipe scroll'` (normal controls restored)
- **transitions**: same as `sidebar.messages.normal`

### 4.12 `sidebar.messages.loading` (intermediate state)
- **state**: same as `sidebar.messages.normal` or `topic` but `state.status === 'Loading ...'` and `state.messages === []`
- **render**: `{ kind: 'sidebar', focus: 'panel' }`
- **right**:
  - `panelBody.contains`: `['Loading ']`
  - `panelFooter.contains`: `['Loading ']`
  - `panelBox`: `null`
- **transitions**: automatic -> `sidebar.messages.normal` or `sidebar.topics`
- **budget**: 1000 ms
- **eventMustEmit**: `api.startedAt` precedes the state render, the render with data follows `api.endedAt`

### 4.13 `sidebarRecording` (recording in progress)
- **state**: `{ screen: 'sidebarRecording', focus: 'messages', chat, topic?, messages, back, chunks: [...Uint8Array], startedAt }`
- **render**: `{ kind: 'sidebar', title: 'REC Recording reply', focus: 'panel', fullWidth: true }`
- **content**:
  - `panelTitle`: `'Recording'`
  - `panelBody`: the open thread's visible messages
  - `panelFooter`: `'Release to stop | Double click cancel'`
- **transitions**:
  - `press` -> `sidebarTranscribing`; `setAudioEnabled(true)` then `setAudioEnabled(false)` observed
  - `doublePress` -> back to `sidebar.messages` without sending
  - `audioChunk` events accumulate into `state.chunks`
- **budget**: 2000 ms total recording + transcribe + confirm
- **eventMustEmit**: `recording.kind` sequence: `start`, `audioChunk` x N, `stop`, `transcribe.start`, `transcribe.end`

### 4.14 `sidebarTranscribing`
- **state**: `{ screen: 'sidebarTranscribing', focus: 'messages', chat, topic?, messages, back }`
- **render**: `{ kind: 'text', title: 'Transcribing', body: 'Converting voice...' }`
- **transitions**: automatic -> `sidebarConfirm` once `api.transcribe` returns
- **budget**: 1000 ms
- **apiCalls**: `transcribe(wav)`
- **eventMustEmit**: `recording.kind === 'transcribe.end'`

### 4.15 `sidebarConfirm.send` (Send highlighted)
- **state**: `{ screen: 'sidebarConfirm', focus: 'messages', chat, topic?, messages, transcript, selectedIndex: 0, back }`
- **render**: `{ kind: 'sidebar', focus: 'panel', fullWidth: true }` with a `popup` (the dialog drawn over the thread)
- **popup**: `title: 'Confirm reply'`; `body` is the transcript followed by `> Send` and `  Cancel`. The thread stays visible underneath in `panelBody`
- **glasses**: the popup is not part of the `panelBody` text; check it in `steps/<step>.glasses.png`
- **footer**: `'Swipe select | Press confirm'` (`panelFooter`)
- **transitions**:
  - `press` -> `sidebarSending` -> `sidebar.messages` with `state.status === 'Sent'`
  - `swipeUp` / `swipeDown` -> `sidebarConfirm.cancel`
  - `doublePress` -> back to `sidebar.messages` without sending
- **budget**: 2000 ms full roundtrip
- **apiCalls**: `sendMessage(chat.id, { text, topicId? })`

### 4.16 `sidebarConfirm.cancel` (Cancel highlighted)
Same screen as 4.15 with `> Cancel` / `  Send` in the popup body (`selectedIndex: 1`). The block below describes the following `sidebarSending` screen.
- **state**: `{ screen: 'sidebarSending', focus: 'messages', chat, topic?, messages, transcript, back }`
- **render**: `{ kind: 'text', title: 'Sending reply' }`
- **body**: contains `Sending...` and `state.transcript`
- **transitions**: automatic -> `sidebar.messages` with `state.status === 'Sent'`
- **budget**: 2000 ms
- **apiCalls**: `sendMessage`

### 4.17 `sidebarSent`
- **state**: `{ screen: 'sidebarSent', focus: 'messages', chat, topic?, messages, back }`
- **render**: `{ kind: 'sidebar', title: 'Reply sent', focus: 'panel' }`
- **right**:
  - `panelBody.contains`: outgoing message text
  - `panelFooter`: `'Swipe scroll | Hold to record | Double click back'`
- **transitions**:
  - `press` -> `sidebarRecording`
  - `doublePress` -> `back`
- **budget**: 500 ms

### 4.18 `newMessage.normal` (incoming message notification, normal chat)
- **state**: `{ screen: 'newMessage', chat, message, chats, selectedChatIndex }`
- **render**: `{ kind: 'text', title: 'New Telegram' }`
- **body.contains**: `[chat.title, 'New message', 'Click to open']`
- **body.notContains**: stale chat name
- **footer.contains**: `['Double click dismiss']`
- **transitions**:
  - `press` -> `sidebar.messages.normal` for `state.chat`
  - `doublePress` -> `asleep`
- **budget**: 1000 ms from `TelegramUpdate`
- **apiCalls**: `listChats` triggered internally

### 4.19 `newMessage.topic`
- **state**: same as `newMessage.normal` with `topic` set
- **body.contains**: `[chat.title, topic.title]` (e.g. `'Fixture Forum / Fixture Topic One'`)
- **transitions**: `press` -> `sidebar.messages.topic`

### 4.20 `asleep` (screen off)
- **state**: `{ screen: 'asleep', chats, selectedChatIndex }`
- **render**: `{ kind: 'text', title: '', body: '' }`
- **transitions**:
  - `press`, `swipeUp`, `swipeDown` -> stays; calls `turnScreenOff` on every input
  - `doublePress` -> `sidebar.chats` with previous `selectedChatIndex`
- **budget**: 500 ms
- **eventMustEmit**: `lifecycle.kind === 'asleep'`, then `lifecycle.kind === 'wake'`

### 4.21 `error`
- **state**: `{ screen: 'error', message, previous? }`
- **render**: `{ kind: 'text', title: 'Error' }`
- **body.contains**: `[state.message, 'Press to retry']`
- **body.contains** (with previous): `['Double press back']`
- **transitions**:
  - `press` -> re-runs `init()`
  - `doublePress` with `state.previous` -> `state.previous`
- **budget**: 1000 ms

## 5. Test execution order

|#|Step name|Input|Expected target|Extra assertions|
|---|---|---|---|---|
|00|`00-startup-loading`|(boot)|`loading`|first render after `init`|
|01|`01-chats-startup`|(after `init`)|`sidebar.chats`|`selectedChatIndex === 0`; render carries `nativeList` `chat-list` with rows `chat:fixture-chat-0`, `chat:fixture-chat-1`, ...; no `listMessages`|
|02|`02-chats-native-swipe-no-redraw`|`down` x3|`sidebar.chats`|no full render, no API call (the simulator moves its box and sends no event)|
|03|`03-chats-click-opens-highlighted-row`|`click`|`sidebar.messages.normal`|the click reports row 3: `selectedChatIndex === 3` (Fixture Research)|
|04|`04-chats-back-starts-at-opened-chat`|`double_click`|`sidebar.chats`|`selectedChatIndex === 3`; rows start `chat:fixture-chat-3`, `chat:fixture-chat-4` (box on the chat just left)|
|05|`05-chats-back-to-top`|`down` x3, `click`|`sidebar.chats`|the last row, `Back to top`: anchor 0, rows start `chat:fixture-chat-0`|
|06|`06-chats-open-forum-topics`|`down`, `click`|`sidebar.topics`|`selectedChatIndex === 1`, `topic-list` rows `topic:fixture-topic-0`, ...; `listTopics`; no `listMessages` (no preview)|
|07|`07-topics-open-topic-one`|`down`, `click`|`sidebar.messages.topic`|`selectedTopicIndex === 1`, `fixture-topic-one-body`, never `Topic zero warmup body`|
|08|`08-topic-messages-scroll-older`|`up`|`sidebar.messages.topic` (older page)|`isNewestPage === false`, `Older fixture`, `listMessages` with `beforeId`|
|09|`09-topic-messages-back`|`double_click`|`sidebar.topics`|returns to topics, NOT chats; rows start `topic:fixture-topic-1`; no preview body|
|10|`10-topics-open-topic-two`|`down`, `click`|`sidebar.messages.topic`|`selectedTopicIndex === 2`, `fixture-topic-two-body`, `markRead`|
|11|`11-topic-two-back`|`double_click`|`sidebar.topics`|rows start `topic:fixture-topic-2`|
|12|`12-topics-open-topic-three`|`down`, `click`, `up`|`sidebar.messages.topic`|`selectedTopicIndex === 3`, scrolled one block up (`first line is preserved`)|
|13|`13-topic-long-message-verify`|`up` x2|`sidebar.messages.topic`|`fixture-long-topic-body-anchor`|
|14|`14-topic-three-back`|`double_click`|`sidebar.topics`|rows start `topic:fixture-topic-3`|
|15|`15-topics-back-to-top`|`down` x4, `click`|`sidebar.topics`|`Back to top`: `selectedTopicIndex === 0`|
|16|`16-topics-double-back-to-chats`|`double_click`|`sidebar.chats`|`selectedChatIndex === 1`, rows start `chat:fixture-chat-1`|
|17|`17-chats-back-to-top`|`down` x5, `click`|`sidebar.chats`|`selectedChatIndex === 0`|
|21|`21-chats-open-alpha`|`click`|`sidebar.messages.normal`|row 0 (a list click without an index): chat 0, both messages|
|21a|`21a-back-to-chats`|`double_click`|`sidebar.chats`|`selectedChatIndex === 0`|
|21b|`21b-chats-swipe-to-archive`|`down` x4|`sidebar.chats`|no full render, no API call|
|21c|`21c-archive-long-message`|`click`, `up`|`sidebar.messages.normal`|`selectedChatIndex === 4`, long-message anchor|
|21d|`21d-archive-paginate-older`|`up`|`sidebar.messages.normal`|older page|
|21e|`21e-back-from-archive`|`double_click`|`sidebar.chats`|rows start `chat:fixture-chat-4`|
|21f|`21f-chats-back-to-top`|`down` x2, `click`|`sidebar.chats`|`selectedChatIndex === 0`|
|22|`22-chats-reopen-alpha`|`click`|`sidebar.messages.normal`|chat 0, ends on the message thread with the press debounce armed|
|22a|`22a-press-debounce-starts-recording`|(wait for `messagePressDelayMs`)|`sidebarRecording`|`setAudioEnabled(true)` called — pins the 260ms debounce that turns a single press into recording (without it the user has no feedback when they tap "record")|
|23|`23-alpha-record-start`|`click` (no-op, controller already recording)|`sidebarRecording`|`setAudioEnabled(true)` (idempotent)|
|24|`24-alpha-record-audio-2`|`audioChunk` x 1|`sidebarRecording`|`state.chunks.length === 2`|
|25|`25-alpha-record-audio-3`|`audioChunk` x 1|`sidebarRecording`|`state.chunks.length === 3`|
|26|`26-alpha-record-stop`|`press`|`sidebarTranscribing`|`setAudioEnabled(false)`|
|27|`27-alpha-transcribe-done`|(wait)|`sidebarConfirm.send`|transcript === `'Fixture transcript'`|
|28|`28-alpha-confirm-send`|`press`|`sidebarSending` -> `sidebar.messages.normal`|outgoing message present, `sendMessage` called|
|29|`29-chats-reload`|(back)|`sidebar.messages.normal` (chat 2)|both Ops messages visible|
|30|`30-ops-record-cancel-doublepress`|`press` -> `press` -> `doublePress`|`sidebar.messages.normal`|`transcribe` NOT called|
|31|`31-ops-record-confirm-cancel`|`press` -> `press` -> `swipeDown` -> `press`|`sidebar.messages.normal`|`sendMessage` NOT called|
|32|`32-chats-asleep`|`doublePress` (from chats)|`asleep`|`turnScreenOff` called once, `lifecycle === 'asleep'`|
|33|`33-asleep-noop-press`|`press`|`asleep`|`turnScreenOff` called again, state stays|
|34|`34-asleep-wake`|`doublePress`|`sidebar.chats`|`selectedChatIndex` preserved, `lifecycle === 'wake'`|
|35|`35-newmessage-inject`|`TelegramUpdate` via `/api/test/notify`|`newMessage.normal`|body contains chat title and `New message`|
|36|`36-newmessage-open`|`press`|`sidebar.messages.normal`|`listMessages` called for that chat|
|37|`37-error-inject`|`error` mode then `init`|`error`|body contains `Error` and `Press to retry`|
|38|`38-error-retry`|`press`|(re-runs `init`)|`authStatus` called again|
|39|`39-perf-budget-chat-list`|`slow` mode then `init`|`sidebar.chats` after 1200 ms|harness FAILS with clear latency-budget message|
|50..52|n/a|see `scripts/simulator-topic-scroll.mjs`|n/a|Standalone test (NOT a catalog step) that drives the simulator with `up`/`down`/`click`/`double_click` to navigate to fixture topics 4, 5, 6 and exhaustively scroll through all 12 messages of each. Asserts every `topic-N-m<M>` anchor (M=1..12) appears in `panelBodyExcerpt`. **Blocked on simulator** — see step 50 status below.|
|50|standalone test topic 4|navigate to topic 4, swipe up 30x|n/a|`renderBodyContainsAny` finds every `topic-4-m<M>` anchor (M=1..12) across the test window. The fixture embeds `topic-N-m<M>` in every message so the test can assert exhaustive coverage without parsing `state.messages`. **Not runnable on the simulator** because `@evenrealities/evenhub-simulator@0.7.2`'s `up` and `down` actions produce 0 console events (the sim silently drops swipe actions). Unit tests already verify the controller's swipe logic; real G2 hardware delivers swipes correctly. Will run end-to-end when the simulator fixes its `up`/`down` handling.|
|51|standalone test topic 5|back, navigate to topic 5, swipe up 30x|n/a|same exhaustive-scroll assertion for topic 5. Blocked on sim `up`/`down` bug.|
|52|standalone test topic 6|back, navigate to topic 6, swipe up 30x|n/a|same exhaustive-scroll assertion for topic 6. Blocked on sim `up`/`down` bug.|
| — |**simulator harness strict-mode bug**|`renderBodyContains` etc. silently fail in fixture mode|n/a|The harness's `[flow] ok` marker is independent of the `failures` array — the run completes with `ok` markers even when content assertions have been firing as failures. Real mode doesn't enforce `renderBodyContains` at all. The harness's 100+ per-step "failures" in the existing 48-step run are not regressions from my changes; they are pre-existing strict-mode timing and content mismatches. **Not fixed in this commit** because the user's question was about scroll-on-messages, not about the harness's report shape. Worth a separate pass to tighten the harness's exit code on fixture-mode content mismatches.|
 ## 6. Fixture data dictionary

| Field | Value |
| --- | --- |
| `fixtureChats[0]` | `{ id: 'fixture-chat-0', title: 'Fixture Alpha', kind: 'user', lastMessage: 'Alpha preview baseline for startup selection.' }` |
| `fixtureChats[1]` | `{ id: 'fixture-chat-1', title: 'Fixture Forum', kind: 'group', isForum: true, unreadCount: 3, lastMessage: 'Forum preview: topic content is available.' }` |
| `fixtureChats[2]` | `{ id: 'fixture-chat-2', title: 'Fixture Ops', kind: 'group', lastMessage: 'Ops preview: deployment status green.' }` |
| `fixtureChats[3]` | `{ id: 'fixture-chat-3', title: 'Fixture Research', kind: 'channel', lastMessage: 'Research preview: visual validation sample.' }` |
| `fixtureChats[4]` | `{ id: 'fixture-chat-4', title: 'Fixture Archive', kind: 'group', lastMessage: 'Archive preview: older test data.' }` |
| `fixtureTopics[*]` | Four topics: `id: 'fixture-topic-0..3'`, `topMessageId: 'fixture-topic-N-top'`, `unreadCount: 1` on 1,2,3. |
| `messagePages[fixture-chat-0]` | Two messages, second is outgoing from `Me`. |
| `messagePages[fixture-chat-1, fixture-topic-0]` | One warmup message. |
| `messagePages[fixture-chat-1, fixture-topic-1]` | Two messages including `fixture-topic-one-body`. |
| `messagePages[fixture-chat-1, fixture-topic-2]` | Two messages including `fixture-topic-two-body`. |
| `messagePages[fixture-chat-1, fixture-topic-3]` | Two messages including `fixture-topic-three-body`. |
| `transcribe()` | Returns `{ text: 'Fixture transcript' }` unless overridden via `/api/test/transcript`. |
| `sendMessage()` | Generates outgoing message with `id: Date.now()`. Recorded in `__fixture.sent`. |

## 7. Blank-detection rules

The glasses screenshot is BLANK (and the step fails) when ALL of the following are true:
- `uniqueNonTransparentColors <= 5`
- All non-transparent colors are within Euclidean distance 30 of the LVGL selection-border green `(0, 255, 0, alpha)` for some alpha in `[0, 255]`

Otherwise the screenshot is considered rendered. The harness additionally computes:
- `nonTransparentPixelCount`
- `dominantRegion` (4x4 grid of average color, downsampled)
- `textLikePixelCount` (pixels with `R > 20 || B > 20`)

A regression check asserts that no step has `textLikePixelCount === 0` AND the render model contained text. If that combination happens, the harness fails with `Glasses screenshot has no text pixels for a screen that has text content`. This is the exact regression that hid the user's reported bug.

## 8. Webview fallback

When the glasses screenshot is blank per the rules above, the harness additionally:
- Locates the embedded 576x288 LVGL frame in the webview screenshot (by color signature)
- Computes the same three structural metrics on that region
- Asserts the metrics fall in the expected range (e.g. `textLikePixelCount >= 200` for the chat list)
- If the webview region also has `textLikePixelCount < 200`, the harness fails with a clear message

This validates visual correctness even when the simulator's `/api/screenshot/glasses` is empty (the current state of `@evenrealities/evenhub-simulator@0.7.2`). The webview check is only a fallback; as soon as the simulator renders text, the harness switches back to glasses-only.

## 9. Coverage additions to keep queued

These screens already exist in the app and the catalog, but they should stay explicitly covered by harness steps so regressions are visible instead of implied:

| Screen | Step shape | Expected assertion |
| --- | --- | --- |
| `auth.needsSetup` | fixture auth mode `missing` | `state.mode === 'needsSetup'` and body includes `Settings` |
| `auth.signedOut` | fixture auth mode `signed-out` | `state.mode === 'signedOut'` and body includes `phone number` |
| `auth.phonePending` | drive phone login from fixture mode | `state.mode === 'phonePending'` and body includes `code` |
| `sidebar.messages.loading` | slow message open or older-page fetch | body/footer show `Loading...` before the data render |
| `sidebarSent` | after phone-sent or send-reply flow | `state.screen === 'sidebarSent'` before returning to message view |
| `newMessage.topic` | injected notification with `topicId` | body includes both chat title and topic title |

Harness detail:
- The fixture path should be able to select `teleGlanceAuth=missing`, `teleGlanceAuth=signed-out`, and a phone-pending login path independently through either a URL override or a dedicated fixture command.
- The topic notification step should inject `topicId` so the notification screen proves the forum-topic branch, not the normal-chat branch.
- The loading-state assertion should capture the transient state itself, not only the final post-load screen.
