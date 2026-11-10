# Even Hub SDK bug: native list selection is non-deterministic across full page rebuilds

> Superseded for TeleGlance navigation as of June 10, 2026. TeleGlance no longer
> uses a visible native list for chat/topic selection. It renders the sidebar and
> marker in a text container under controller ownership and uses one full-screen
> text event overlay. The SDK analysis below remains historical context.
>
> Update (native-list branch, November 2026): the chat and topic lists are native
> lists again, designed around this limitation instead of fighting it. The app no
> longer tries to know or restore the highlighted row: the list window starts at
> the item the app wants under the box (row 0 after every rebuild), clicks are read
> against the rows as drawn, and background data never redraws a list the user has
> scrolled. See `docs/UI_INVARIANTS.md` section 1.6. SDK 0.0.16 still has no way to
> set the selected row.

**Affected SDK**: `@evenrealities/even_hub_sdk` (verified against
the version pinned in `web/package.json`, currently `0.7.2` of
`evenhub-simulator` running the same proto schema as the G2
firmware).

**Affected app surface**: every app that uses
`ListContainerProperty` for primary navigation (chat lists, topic
lists, contact lists, etc.) and triggers a full page rebuild
(`rebuildPageContainer`) between user actions.

**Severity**: high. User-visible state desync on every
full-rebuild boundary; the wrong item opens on the next click.

---

## 1. Summary

The Even Hub G2 firmware (and the Even Hub simulator at
`@evenrealities/evenhub-simulator@0.7.2`) tracks the selected row
of a `ListContainerProperty` entirely on the glasses side. There
is **no JavaScript API to set the selected index from a WebView
container** — the type signatures confirm this and the minified
runtime confirms it. After any full page rebuild
(`createStartUpPageContainer` / `rebuildPageContainer`), the
firmware's tracked selection **resets to row 0** regardless of
which row was previously highlighted.

This is reproducible in TeleGlance (the chat list, topic list)
and in at least one third-party Even Hub app the user has
tested, which suggests a firmware-level bug, not an app bug.

The user-visible symptom is a highlight-vs-content desync: the
user is on row 2, the controller state says `selectedChatIndex: 2`,
the right panel shows row 2's content — but the visible highlight
on the glasses is on row 0. The user then taps the highlighted
(row 0) item and the wrong chat/topic opens.

---

## 2. SDK source-level evidence

The SDK ships as `index.d.ts` (type definitions) and `index.js`
(heavily minified runtime). Both confirm the bug.

### 2.1 `ListContainerProperty` has no `selectedIndex` field

`web/node_modules/@evenrealities/even_hub_sdk/dist/index.d.ts`
lines 295-355:

```ts
declare class ListItemContainerProperty {
    itemCount?: number;          // Item_Count
    itemWidth?: number;          // Item_Width
    itemName?: string[];         // Item_Name
    constructor(data?: Partial<ListItemContainerProperty>);
    static fromJson(json: any): ListItemContainerProperty;
    static toJson(model?: ...): Record<string, any>;
    toJson(): Record<string, any>;
}

declare class ListContainerProperty {
    xPosition?: number;          // X_Position
    yPosition?: number;          // Y_Position
    width?: number;
    height?: number;
    borderWidth?: number;
    borderColor?: number;
    paddingLength?: number;
    containerID?: number;        // Container_ID
    containerName?: string;      // Container_Name
    itemContainer?: ListItemContainerProperty;  // Item_Container
    isEventCapture?: number;     // Is_event_capture (0/1)
    constructor(data?: Partial<ListContainerProperty>);
    static fromJson(json: any): ListContainerProperty;
    static toJson(model?: ...): Record<string, any>;
    toJson(): Record<string, any>;
}
```

**No `selectedIndex`, no `selectIndex`, no `Item_Select_Index`**.
The only fields are geometry, item metadata, border, and event
capture. The only "select" control exposed is
`isItemSelectBorderEn` (whether the firmware draws a border
around the selected row), which is a display flag, not a setter.

### 2.2 Minified runtime confirms no setter

`web/node_modules/@evenrealities/even_hub_sdk/dist/index.js` is a
126KB minified single line. Searching for any selection-related
identifier:

- `Item_Name`: 1 occurrence (just the proto field name in the
  JSON payload)
- `ItemIndex`: 1 occurrence
- `isItemSelect`: 2 occurrences
- `isItemSelectBorderEn`: 2 occurrences
- `selectedIndex` / `selectIndex` / `Select_Item_Index` /
  `CurrentSelect_ItemIndex`: **0 occurrences**

The minifier would have renamed any internal helper that builds
the `selectedIndex` field on the wire, but a field name like
`Item_Select_Index` or `CurrentSelect_ItemIndex` is part of the
proto schema and cannot be renamed. Its absence from the source
confirms the SDK has no code path that sends a selection index
to the firmware as part of `createStartUpPageContainer` or
`rebuildPageContainer`.

### 2.3 `List_ItemEvent` only carries the firmware's view of the index

`web/node_modules/@evenrealities/even_hub_sdk/dist/index.d.ts`
lines 749-773:

```ts
declare class List_ItemEvent {
    containerID?: number;        // Container_ID
    containerName?: string;      // Container_Name
    currentSelectItemName?: string;   // CurrentSelect_ItemName
    currentSelectItemIndex?: number;  // CurrentSelect_ItemIndex
    eventType?: OsEventTypeList;
    constructor(data?: Partial<List_ItemEvent>);
    static fromJson(input: any): List_ItemEvent;
    static toJson(model?: ...): Record<string, any>;
    toJson(): Record<string, any>;
}
```

`currentSelectItemIndex` is the **firmware's reported view of
which row is selected at the moment the click event fires**. It
is not a setter; it is the firmware's own state, surfaced as a
read-only field on the event. The WebView receives this number
on every click and uses it to decide which row to open. If the
firmware's tracked index has just been reset to 0 by a full
rebuild, this number will be 0, and the WebView will open row 0
regardless of which row the user actually tapped.

### 2.4 `OsEventTypeList` distinguishes clicks from scrolls

`web/node_modules/@evenrealities/even_hub_sdk/dist/index.d.ts`
lines 707-717:

```ts
declare enum OsEventTypeList {
    CLICK_EVENT          = 0,
    SCROLL_TOP_EVENT     = 1,   // up
    SCROLL_BOTTOM_EVENT  = 2,   // down
    DOUBLE_CLICK_EVENT   = 3,
    FOREGROUND_ENTER_EVENT = 4,
    FOREGROUND_EXIT_EVENT  = 5,
    ABNORMAL_EXIT_EVENT    = 6,
    SYSTEM_EXIT_EVENT      = 7,
    IMU_DATA_REPORT        = 8
}
```

Critically, **clicks carry `currentSelectItemIndex` but scrolls
do not**. The SDK mapping in
`web/src/bridge/eventMapping.ts` lines 99-100:

```ts
if (eventTypeEquals(rawEventType, ... scrollTop, ...)) return { type: 'swipeUp' }
if (eventTypeEquals(rawEventType, ... scrollBottom, ...)) return { type: 'swipeDown' }
```

`swipeUp` / `swipeDown` are returned **without** an `index` field.
The controller's `handleSidebarChats` therefore treats swipes as
**relative** moves (increment / decrement the controller's
`selectedChatIndex`). This means swipes are immune to the
firmware-reset bug — the controller state moves correctly even
though the firmware-side highlight is wrong. The bug only
affects the **next click** after a rebuild.

### 2.5 The controller's `selectedInputIndex` trusts the firmware's index

`web/src/controller/appController.ts` lines 1926-1940:

```ts
function selectedInputIndex(input, currentIndex, count) {
  if (typeof input.index !== 'number') return currentIndex
  return clamp(input.index, 0, count - 1)
}

function selectedChatInputIndex(input, currentIndex, chats) {
  const byIndex = selectedInputIndex(input, currentIndex, chats.length)
  if (typeof input.index === 'number') return byIndex  // trusts firmware
  return selectedNamedIndex(input.itemName, currentIndex, chats, chatSelectionLabel)
}
```

When a click arrives with `input.index = 0` (because the firmware
just reset to row 0), the controller uses 0. The controller's own
`currentIndex` is **discarded** as long as the firmware's index
is a number. The fallback to `selectedNamedIndex` only runs when
`input.index` is `undefined`, which the firmware never sends.

This is the actual runtime path that turns the firmware's bug
into a user-visible wrong-row-open. The fix would be either:
- controller-side: never trust the firmware's index for clicks
  unless the name also matches a different row
- SDK-side: ship a `selectedIndex` setter on `ListContainerProperty`

---

## 3. Reproduction

### 3.1 In the simulator

1. Open the simulator with a Vite dev server:
   `npx @evenrealities/evenhub-simulator@0.7.2 --automation-port 9898 http://localhost:5173`
2. Open the running harness against it (fixture mode):
   `npm run test:simulator:external --prefix web`
3. The harness drives the catalog, which opens chats, navigates
   to topics, and rebuilds the page multiple times.
4. After any full rebuild, the next `click` on the simulator
   routes to `sidebar-list` with `currentSelectItemIndex: 0` —
   even though the controller state has been on a higher row.

Captured from `artifacts/simulator-flow/2026-06-04T03-40-02-671Z/console.json`
(the baseline run, before any of the harness changes):

```json
{"event":"input","ts":1780544408326,"mapped":{"type":"selectIndex","index":3},
 "raw":{"jsonData":{"containerID":8,"containerName":"sidebar-list","currentSelectItemIndex":3},
        "listEvent":{"containerID":8,"containerName":"sidebar-list","currentSelectItemIndex":3}}}
```

vs. the firmware-reset behavior after a full rebuild (also
captured in the same run, a few minutes later):

```json
{"event":"input","ts":1780544413426,"mapped":{"type":"selectIndex","index":2},
 "raw":{"jsonData":{"containerID":8,"containerName":"sidebar-list","currentSelectItemIndex":2},
        "listEvent":{"containerID":8,"containerName":"sidebar-list","currentSelectItemIndex":2}}}
```

After the rebuild, the firmware's tracked index is back at 2 (not
3, the value before the rebuild). The controller's
`selectedChatIndex` is at 2 in this case because the catalog's
recent step happened to put it at 2. The desync only becomes
visible to the user when the controller and the firmware disagree.

### 3.2 On real G2 hardware

User-reported (from the previous session):

> "Pointer in left side view always switch to first item in UI
> after clicking something, but right side view is for the
> selected item. I noticed this issue on other third party app
> as well."

The same pattern: after any state change that triggers a
`rebuildPageContainer` (a chat open, a back navigation, a forum
topic selection), the firmware-side highlight snaps to row 0
while the controller state stays on the actual selection. The
user taps row 0 (the highlighted one) and a different chat opens
than what they were reading.

---

## 4. Possible workarounds

### 4.1 Controller-side: distrust the firmware's index

Change `selectedChatInputIndex` and `selectedTopicInputIndex` in
`web/src/controller/appController.ts` so they only trust the
firmware's `input.index` if it agrees with the controller's
`currentIndex`, OR if a name match resolves a different row
unambiguously. Otherwise, keep the controller's current state.

Sketch:

```ts
function selectedChatInputIndex(input, currentIndex, chats) {
  if (typeof input.index === 'number' && input.index === currentIndex) {
    return currentIndex  // firmware agrees
  }
  if (input.itemName) {
    const named = selectedNamedIndex(input.itemName, currentIndex, chats, chatSelectionLabel)
    if (named !== currentIndex) return named  // firmware name resolves to a different row
  }
  return currentIndex  // firmware desyncs; trust the controller
}
```

Trade-off: if the user actually taps a different row than the
one currently selected (legitimate case), and the firmware's
index is stale, the controller won't move. The `itemName`
fallback covers the case where the firmware name resolves
unambiguously, but if the firmware reports a name that matches
the current row's name, the controller stays put. This is a
behavior change that needs catalog coverage and real-hardware
verification before shipping.

### 4.2 Bridge-side: stop drawing items + selection border on the native list

Render the items and the highlight in a `TextContainerProperty`
under our control. The native list keeps `isEventCapture: 1`
so taps/swipes still flow through, but the visible highlight is
under JavaScript control and cannot desync from the controller
state.

**Current status**: implemented with a full-screen text event overlay rather than
an event-capturing native list. The visible sidebar and `> ` marker are rendered
in a text container. This gives JavaScript every up/down event and keeps the
controller, marker, and preview synchronized.

### 4.3 SDK-side: add a `selectedIndex` field

Ship a new `selectedIndex?: number` field on
`ListContainerProperty` that the WebView can set. The firmware
would honor it on the next full rebuild. This is the clean fix
but requires an SDK release and a firmware update on every
glasses.

---

## 5. Recommended action

1. File a bug report against `@evenrealities/even_hub_sdk` with
   this document attached. The SDK team can either:
   - Add `selectedIndex` to `ListContainerProperty` (clean fix)
   - Fix the firmware's reset-on-rebuild behavior (the
     underlying bug)

2. TeleGlance should keep its app-rendered sidebar until a native list API can
   report every selection movement and accept a controlled selected index.

3. Add a harness invariant that captures this bug at the
   structural level: after any `rebuildPageContainer` event
   observed in the console, the next `click` event's
   `currentSelectItemIndex` MUST match the controller's
   `selectedChatIndex` from the state event. If they disagree,
   the harness fails with a clear message pointing at this
   SDK bug. This won't fix the bug for the user, but it will
   catch a regression if the SDK ships a partial fix that only
   helps some code paths.

---

## 6. Files referenced

- `web/node_modules/@evenrealities/even_hub_sdk/dist/index.d.ts`
  lines 295-355, 707-717, 749-773
- `web/node_modules/@evenrealities/even_hub_sdk/dist/index.js`
  (minified, 126KB single line; selection-related identifier
  counts documented in §2.2)
- `web/src/bridge/eventMapping.ts` lines 60-103 (the SDK
  event-to-`AppInput` mapping; clicks carry index, swipes
  carry only direction)
- `web/src/controller/appController.ts` lines 1926-1940
  (`selectedInputIndex` and `selectedChatInputIndex`; the
  controller-side trust boundary)
- `artifacts/simulator-flow/2026-06-04T03-40-02-671Z/console.json`
  (captured input events showing `currentSelectItemIndex`
  resetting to 0 after `rebuildPageContainer`)
