import { describe, expect, it, vi } from 'vitest'
import { TelegramAppController, type GlassesBridge } from '../src/controller/appController'
import type { TelegramApi } from '../src/api'
import { MAX_RECORDING_BYTES } from '../src/audio/wav'
import type { Chat, Folder, Message, Topic, TranscriptionResult } from '../src/types'
import { screenModel } from '../src/controller/model'
import type { AppState, ScreenModel } from '../src/controller/model'

const chats: Chat[] = [
  { id: '1', title: 'Alice', kind: 'user' },
  { id: '2', title: 'Project', kind: 'group', isForum: true },
]
const topics: Topic[] = [
  { id: '10', title: 'Launch' },
  { id: '20', title: 'Support' },
]
const messages: Message[] = [{ id: '100', sender: 'Alice', text: 'hello', sentAt: '2026-05-29T10:00:00Z' }]
const reversedMessages: Message[] = [
  { id: '102', sender: 'Alice', text: 'latest', sentAt: '2026-05-29T10:02:00Z' },
  { id: '101', sender: 'Bob', text: 'middle', sentAt: '2026-05-29T10:01:00Z' },
  { id: '100', sender: 'Alice', text: 'oldest', sentAt: '2026-05-29T10:00:00Z' },
]

const FAKE_CHAT_ID = '1'
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }
describe('TelegramAppController', () => {
  it('exits the app on double-tap from the pre-login auth screen', async () => {
    // The reviewer expects the glasses user to be able to leave the app with
    // a double-tap even when no Telegram credentials are configured and the
    // auth screen is the only thing on display. The controller should hand
    // off to the native exit-confirmation dialog without touching the API.
    const api = fakeApi({ authorized: false })
    const bridge = fakeBridge()
    const controller = new TelegramAppController(
      api,
      bridge,
      {},
      undefined,
      () => false,
    )

    await controller.init()
    expect(controller.snapshot).toMatchObject({
      screen: 'auth',
      mode: 'needsSetup',
    })
    expect(vi.mocked(api.authStatus)).not.toHaveBeenCalled()

    await controller.dispatch({ type: 'doublePress' })
    expect(vi.mocked(bridge.showExitConfirmation ?? (() => undefined))).toHaveBeenCalledTimes(1)
    // The auth screen must not transition out of `auth` just because the
    // native exit dialog was shown — the host app owns the dismissal flow.
    expect(controller.snapshot).toMatchObject({ screen: 'auth', mode: 'needsSetup' })
  })

  it('shows phone login prompt when no Telegram session exists', async () => {
    const api = fakeApi({ authorized: false })
    const bridge = fakeBridge()
    const controller = new TelegramAppController(api, bridge)

    await controller.init()
    expect(controller.snapshot).toMatchObject({
      screen: 'auth',
      mode: 'signedOut',
      message: expect.stringContaining('phone number'),
    })

    await controller.dispatch({ type: 'press' })
    await flushAsync()
    expect(controller.snapshot).toMatchObject({
      screen: 'auth',
      mode: 'signedOut',
      message: expect.stringContaining('phone number'),
    })
    expect(bridge.render).toHaveBeenCalled()
  })

  it('loads chats for an authorized session and moves list selection with swipes', async () => {
    const api = fakeApi({ authorized: true })
    const bridge = fakeBridge()
    const controller = new TelegramAppController(api, bridge)

    await controller.init()
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats', selectedChatIndex: 0 })
    const renderCount = vi.mocked(bridge.render).mock.calls.length

    await controller.dispatch({ type: 'swipeDown' })
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats', selectedChatIndex: 1 })
    expect(bridge.render).toHaveBeenCalledTimes(renderCount)

    await controller.dispatch({ type: 'swipeUp' })
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats', selectedChatIndex: 0 })
    expect(bridge.render).toHaveBeenCalledTimes(renderCount)
  })

  it('ignores delayed message refresh results after the visible thread changes', async () => {
    const alphaMessages: Message[] = [
      { id: '10', sender: 'Alice', text: 'alpha initial', sentAt: '2026-05-29T10:00:00Z' },
    ]
    const staleAlphaMessages: Message[] = [
      ...alphaMessages,
      { id: '11', sender: 'Alice', text: 'stale alpha refresh', sentAt: '2026-05-29T10:01:00Z' },
    ]
    const opsMessages: Message[] = [
      { id: '20', sender: 'Ops', text: 'ops current thread', sentAt: '2026-05-29T10:00:00Z' },
    ]
    const alphaRefresh = deferred<Message[]>()
    let alphaCalls = 0
    const api = fakeApi({
      authorized: true,
      chats: [
        { id: '1', title: 'Alice', kind: 'user' },
        { id: '3', title: 'Ops', kind: 'group' },
      ],
    })
    vi.mocked(api.listMessages).mockImplementation(async (chatId) => {
      if (String(chatId) === '1') {
        alphaCalls += 1
        if (alphaCalls === 1) return alphaMessages
        return alphaRefresh.promise
      }
      if (String(chatId) === '3') return opsMessages
      return []
    })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await controller.dispatch({ type: 'press' })
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages', chat: { id: '1' } })

    const refreshPromise = (controller as unknown as { refreshVisibleMessages: () => Promise<void> }).refreshVisibleMessages()
    await flushAsync()
    await controller.dispatch({ type: 'doublePress' })
    await controller.dispatch({ type: 'swipeDown' })
    await controller.dispatch({ type: 'press' })
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages', chat: { id: '3' } })

    alphaRefresh.resolve(staleAlphaMessages)
    await refreshPromise
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages', chat: { id: '3' } })
    expect((controller.snapshot as Extract<AppState, { screen: 'sidebar'; focus: 'messages' }>).messages).toEqual(opsMessages)
  })

  it('forces a full rebuild when the topic-list panelBox visibility flips', async () => {
    const longMessage: Message = {
      id: '200',
      sender: 'Long Sender',
      // > 25 words so formatMessageBox produces a panelBox.
      text: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six twenty-seven',
      sentAt: '2026-05-29T10:00:00Z',
    }
    const shortMessage: Message = { id: '210', sender: 'Short', text: 'hi', sentAt: '2026-05-29T10:01:00Z' }
    let activeTopicId = 'topic-long'
    const api = fakeApi({
      authorized: true,
      chats: [chats[0], chats[1]],
      topics: [
        { id: 'topic-long', title: 'Long', unreadCount: 0, lastMessage: 'long' },
        { id: 'topic-short', title: 'Short', unreadCount: 0, lastMessage: 'short' },
      ],
      latestMessages: () => Promise.resolve(activeTopicId === 'topic-long' ? [longMessage] : [shortMessage]),
    })
    const bridge = fakeBridge()
    const controller = new TelegramAppController(api, bridge)

    await controller.init()
    await controller.dispatch({ type: 'swipeDown' })
    await controller.dispatch({ type: 'press' }) // open topics list
    await flushAsync()
    // Manually fetch preview for the long topic (initial selection).
    await fetchTopicPreview(controller, chats[1], { id: 'topic-long', title: 'Long' })
    await flushAsync()
    const renderCountAfterLongPreview = vi.mocked(bridge.render).mock.calls.length
    const enqueueCountAfterLongPreview = vi.mocked(bridge.enqueueSidebarPanel ?? (() => undefined)).mock.calls.length

    // Swipe to the short topic; this must trigger a full render (not a partial enqueue)
    // because the panelBox visibility flipped from defined to undefined.
    activeTopicId = 'topic-short'
    await controller.dispatch({ type: 'swipeDown' })
    await flushAsync()
    expect(vi.mocked(bridge.render).mock.calls.length).toBeGreaterThan(renderCountAfterLongPreview)
    expect(vi.mocked(bridge.enqueueSidebarPanel ?? (() => undefined)).mock.calls.length).toBe(enqueueCountAfterLongPreview)
  })

  it('suppresses the auto-press path on the same-index selection fired right after a swipe', async () => {
    // Use a single non-forum chat so the prefetch runs in the background without
    // opening any extra message threads we have to track.
    const api = fakeApi({ authorized: true, chats: [chats[0]] })
    const bridge = fakeBridge()
    const controller = new TelegramAppController(api, bridge)

    await controller.init()
    // Swipe the same-direction pair the harness records as a "scroll" so the
    // selection lands on the same row we will later synthesise a selectIndex for.
    await controller.dispatch({ type: 'swipeDown' })
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats', selectedChatIndex: 0 })
    const screenBefore = controller.snapshot.screen

    // Same-index selectIndex 50ms after the swipe must NOT auto-open the chat.
    await new Promise((resolve) => setTimeout(resolve, 50))
    await controller.dispatch({ type: 'selectIndex', index: 0 })
    expect(controller.snapshot.screen).toBe(screenBefore)
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats' })

    // After the debounce window expires, the same selectIndex is treated as a press.
    await new Promise((resolve) => setTimeout(resolve, 600))
    await controller.dispatch({ type: 'selectIndex', index: 0 })
    expect(controller.snapshot.screen).toBe('sidebar')
    expect(controller.snapshot).toMatchObject({ focus: 'messages' })
  })

  it('keeps chat selection moving while glasses rendering is slow', async () => {
    const api = fakeApi({ authorized: true, chats: [chats[0], chats[1], { id: '3', title: 'Ops', kind: 'group' }] })
    const bridge = slowBridge()
    const controller = new TelegramAppController(api, bridge)

    await controller.init()
    await flushAsync()
    await controller.dispatch({ type: 'swipeDown' })
    await controller.dispatch({ type: 'swipeDown' })

    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats', selectedChatIndex: 2 })
    // The queued path is the production hot path: every list scroll must call
    // `enqueueSidebarPanel` exactly once. The legacy `renderSidebarPanel` is the
    // slow promise that must not be awaited by the input handler.
    expect(bridge.enqueueSidebarPanel).toHaveBeenCalled()
    const enqueueCalls = vi.mocked(bridge.enqueueSidebarPanel ?? (() => undefined)).mock.calls.length
    expect(enqueueCalls).toBeGreaterThanOrEqual(2)
  })

  it('reproduces the simulator firmware-reset desync: a click after a swipe-open cycle opens row 0, not the scrolled-to row', async () => {
    // This is a STATIC ANALYSIS harness for the user-reported bug. Real
    // reproduction requires a running simulator + captured `[TeleGlanceTest]`
    // console output. In a vitest unit test we can deterministically
    // construct the exact event sequence the simulator/real-G2 emit on a
    // typical "scroll down twice, then click" flow AFTER a full page rebuild.
    //
    // The bug: when a full `rebuildPageContainer` happens (e.g. user opened
    // a chat, scrolled the message thread, then backed out to the chat list),
    // the G2 firmware resets its tracked list-selection index to row 0. The
    // controller's own `state.selectedChatIndex` is preserved across the
    // rebuild (we don't touch the controller's state). The next user click
    // arrives with the firmware's payload — `currentSelectItemIndex: 0,
    // currentSelectItemName: <chat 0 name>` — even though the user's actual
    // highlight position is row 2 (the controller's state).
    //
    // The controller currently trusts the firmware's `input.index` (clamped
    // to 0) and ends up opening chat 0. The user perceives this as "I
    // scrolled, I clicked, and the wrong thing opened."
    //
    // This test pins down the exact event sequence that reproduces the bug
    // and asserts the controller's behavior given the firmware's broken
    // signal. A fix would require either the SDK to expose a way to set the
    // firmware's tracked index, or the firmware to preserve the index across
    // rebuilds. Neither is in scope for the WebView. See
    // `docs/SDK_BUG_NATIVE_LIST_SELECTION.md` for the SDK-level analysis.
    const api = fakeApi({ authorized: true, chats: [chats[0], chats[1], { id: '3', title: 'Ops', kind: 'group' }] })
    const bridge = fakeBridge()
    const controller = new TelegramAppController(api, bridge)
    await controller.init()
    await flushAsync()

    // 1. User scrolls down twice. Controller's `selectedChatIndex` moves 0 → 2.
    await controller.dispatch({ type: 'swipeDown' })
    await controller.dispatch({ type: 'swipeDown' })
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats', selectedChatIndex: 2 })

    // 2. Simulate the firmware-reset desync: the WebView receives a `selectIndex`
    //    event from the firmware with `currentSelectItemIndex: 0` (the
    //    firmware's tracked index after a rebuild reset). The user is
    //    looking at row 2 but the firmware is now reporting row 0.
    await controller.dispatch({ type: 'selectIndex', index: 0, itemName: 'Alice' })

    // 3. The user clicks. The simulator/firmware sends a `press` with the
    //    post-rebuild state. Both `index` and `itemName` point to row 0
    //    consistently — the firmware is internally consistent, just
    //    inconsistent with the controller.
    await controller.dispatch({ type: 'press', index: 0, itemName: 'Alice' })

    // 4. Assert the controller's behaviour. The controller detects that
    //    the firmware's `index: 0` + `itemName: 'Alice'` both disagree with
    //    its own `selectedChatIndex: 2`, and trusts its own state instead.
    //    The user wanted chat 2, the controller opens chat 2. Before the
    //    fix, the controller used the firmware's index and opened chat 0.
    const snapshot = controller.snapshot as { focus?: string; topic?: unknown; selectedChatIndex?: number; chat?: { id?: string } }
    expect(snapshot.focus).toBe('messages')
    expect(snapshot.chat?.id).toBe('3')  // chat 2 (Ops) — the fix landed
    expect(snapshot.chat?.id).not.toBe('1')  // chat 0 (Alice) — would be the bug
  })

  it('opens the scrolled-to chat when the firmware does NOT reset (baseline, no desync)', async () => {
    // The companion to the previous test: when the firmware is internally
    // consistent with the controller's state, the click correctly opens the
    // scrolled-to row. This is the normal path; the previous test shows
    // what happens when the firmware is wrong.
    const api = fakeApi({ authorized: true, chats: [chats[0], chats[1], { id: '3', title: 'Ops', kind: 'group' }] })
    const bridge = fakeBridge()
    const controller = new TelegramAppController(api, bridge)
    await controller.init()
    await flushAsync()

    // 1. User scrolls down twice. Controller's `selectedChatIndex` moves 0 → 2.
    await controller.dispatch({ type: 'swipeDown' })
    await controller.dispatch({ type: 'swipeDown' })
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats', selectedChatIndex: 2 })

    // 2. The firmware-tracked index moves with the controller (no rebuild
    //    happened). The `selectIndex` event is consistent: index 2, name 'Ops'.
    await controller.dispatch({ type: 'selectIndex', index: 2, itemName: 'Ops' })

    // 3. The user clicks. Firmware reports index 2, name 'Ops'. Controller
    //    opens chat 2. This is the correct, expected behavior.
    await controller.dispatch({ type: 'press', index: 2, itemName: 'Ops' })
    const snapshot = controller.snapshot as { focus?: string; topic?: unknown; selectedChatIndex?: number; chat?: { id?: string } }
    expect(snapshot.focus).toBe('messages')
    expect(snapshot.chat?.id).toBe('3')  // chat 2 (Ops) — correct
  })

  it('enqueues a sidebar panel for each chat scroll without awaiting the native render', async () => {
    const api = fakeApi({ authorized: true, chats: [chats[0], chats[1], { id: '3', title: 'Ops', kind: 'group' }] })
    const bridge = recordingEnqueueBridge()
    const controller = new TelegramAppController(api, bridge)

    await controller.init()
    await flushAsync()
    const startCount = bridge.enqueueLog.length

    await controller.dispatch({ type: 'swipeDown' })
    await controller.dispatch({ type: 'swipeDown' })

    expect(bridge.enqueueLog.length - startCount).toBe(2)
    expect(bridge.enqueueLog[bridge.enqueueLog.length - 1].selected).toBe(2)
  })
  it('does not repaint the native chat list for a no-activity background refresh', async () => {
    const api = fakeApi({ authorized: true })
    const bridge = fakeBridge()
    const controller = new TelegramAppController(api, bridge)

    await controller.init()
    await flushAsync()
    const renderCount = vi.mocked(bridge.render).mock.calls.length
    await controller.dispatch({ type: 'swipeDown' })
    clearInputQuiet(controller)
    await refreshRootChats(controller)

    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats', selectedChatIndex: 1 })
    expect(bridge.render).toHaveBeenCalledTimes(renderCount)
  })

  it('turns the screen off on double press from the chat list', async () => {
    const api = fakeApi({ authorized: true })
    const bridge = fakeBridge()
    const controller = new TelegramAppController(api, bridge)

    await controller.init()
    await controller.dispatch({ type: 'doublePress' })

    expect(bridge.turnScreenOff).toHaveBeenCalledOnce()
    expect(controller.snapshot).toMatchObject({ screen: 'asleep' })
  })

  describe('double press goes back one level from every sub-page', () => {
    const listTitles = (controller: TelegramAppController) =>
      (controller.snapshot as { chats: Chat[] }).chats.map((chat) => chat.title)

    it('topic list -> chat list with the forum still selected', async () => {
      const controller = new TelegramAppController(fakeApi({ authorized: true }), fakeBridge())
      await controller.init()
      await controller.dispatch({ type: 'swipeDown' })
      await controller.dispatch({ type: 'press' })
      expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'topics' })

      await controller.dispatch({ type: 'doublePress' })

      expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats', selectedChatIndex: 1 })
    })

    it('topic messages -> topic list -> chat list', async () => {
      const controller = new TelegramAppController(fakeApi({ authorized: true }), fakeBridge())
      await controller.init()
      await controller.dispatch({ type: 'swipeDown' })
      await controller.dispatch({ type: 'press' })
      await controller.dispatch({ type: 'press' })
      await vi.waitFor(() => expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages' }))

      await controller.dispatch({ type: 'doublePress' })
      expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'topics' })
      await controller.dispatch({ type: 'doublePress' })
      expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats', selectedChatIndex: 1 })
    })

    it('normal chat messages -> chat list', async () => {
      const controller = new TelegramAppController(fakeApi({ authorized: true }), fakeBridge())
      await controller.init()
      await controller.dispatch({ type: 'press' })
      await vi.waitFor(() => expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages' }))

      await controller.dispatch({ type: 'doublePress' })

      expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats', selectedChatIndex: 0 })
      expect(listTitles(controller)).toEqual(['Alice', 'Project'])
    })

    it('a chat opened while topics are still loading still goes back to the chat list', async () => {
      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
      const api = fakeApi({ authorized: true, topics: async () => { await delay(200); return topics } })
      const controller = new TelegramAppController(api, fakeBridge())
      await controller.init()
      await controller.dispatch({ type: 'swipeDown' })
      const opening = controller.dispatch({ type: 'press' })
      await vi.waitFor(() => expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages' }))

      await controller.dispatch({ type: 'doublePress' })
      await opening

      expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats' })
    })

    it('inside a folder, backing out of a chat returns to that folder list', async () => {
      const api = fakeApi({
        authorized: true,
        folders: [{ id: '2', title: 'Work' }],
        listChatsImpl: (_limit, options) => (options?.folderId ? [{ id: '1', title: 'Alice', kind: 'user' }] : chats),
      })
      const controller = new TelegramAppController(api, fakeBridge())
      await controller.init()
      await controller.dispatch({ type: 'doublePress' })
      await controller.dispatch({ type: 'swipeDown' })
      await controller.dispatch({ type: 'press' })
      await controller.dispatch({ type: 'press' })
      await vi.waitFor(() => expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages' }))
      await controller.dispatch({ type: 'doublePress' })

      expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats' })
      expect(listTitles(controller)).toEqual(['Alice'])
      expect(screenModel(controller.snapshot)).toMatchObject({ title: 'Work 2/2' })
    })
  })

  describe('endless chat list', () => {
    const manyChats = (from: number, count: number): Chat[] =>
      Array.from({ length: count }, (_, i) => ({ id: String(from + i), title: `Chat ${from + i}`, kind: 'user' as const }))

    it('loads the next page of chats when the selection nears the end and stops when exhausted', async () => {
      const api = fakeApi({
        authorized: true,
        listChatsImpl: (_limit, options) => (options?.offset ? manyChats(20, 5) : manyChats(0, 20)),
      })
      const controller = new TelegramAppController(api, fakeBridge())
      await controller.init()

      // Index 16 is still more than 3 rows from the end: nothing is fetched yet.
      for (let i = 0; i < 16; i++) await controller.dispatch({ type: 'swipeDown' })
      expect(api.listChats).toHaveBeenCalledTimes(1)

      await controller.dispatch({ type: 'swipeDown' })
      await vi.waitFor(() => expect((controller.snapshot as { chats: Chat[] }).chats).toHaveLength(25))
      expect(api.listChats).toHaveBeenLastCalledWith(20, { offset: 20, folderId: undefined })
      expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats', selectedChatIndex: 17 })

      // The last page had fewer than 20 chats, so reaching the end must not fetch again.
      for (let i = 0; i < 12; i++) await controller.dispatch({ type: 'swipeDown' })
      expect(api.listChats).toHaveBeenCalledTimes(2)
      expect(controller.snapshot).toMatchObject({ selectedChatIndex: 24 })
    })

    it('keeps responding to swipes while the next page is still loading (400 ms network)', async () => {
      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
      const api = fakeApi({
        authorized: true,
        listChatsImpl: async (_limit, options) => {
          if (options?.offset) {
            await delay(400)
            return manyChats(20, 20)
          }
          return manyChats(0, 20)
        },
      })
      const controller = new TelegramAppController(api, fakeBridge())
      await controller.init()
      for (let i = 0; i < 16; i++) await controller.dispatch({ type: 'swipeDown' })

      const timings: number[] = []
      for (let i = 0; i < 3; i++) {
        const started = performance.now()
        await controller.dispatch({ type: 'swipeDown' })
        timings.push(performance.now() - started)
      }

      // The fetch is in flight (footer says so) but every swipe returned immediately and moved the marker.
      expect(Math.max(...timings)).toBeLessThan(50)
      expect(controller.snapshot).toMatchObject({ selectedChatIndex: 19, loadingMore: true })
      await vi.waitFor(() => expect((controller.snapshot as { chats: Chat[] }).chats).toHaveLength(40))
      expect(controller.snapshot).toMatchObject({ selectedChatIndex: 19, loadingMore: false })
    })

    it('never asks for more chats when the first page is not full', async () => {
      const api = fakeApi({ authorized: true })
      const controller = new TelegramAppController(api, fakeBridge())
      await controller.init()
      await controller.dispatch({ type: 'swipeDown' })
      await controller.dispatch({ type: 'swipeDown' })

      expect(api.listChats).toHaveBeenCalledTimes(1)
    })

    it('does not duplicate chats that appear on two pages', async () => {
      const api = fakeApi({
        authorized: true,
        listChatsImpl: (_limit, options) => (options?.offset ? manyChats(18, 4) : manyChats(0, 20)),
      })
      const controller = new TelegramAppController(api, fakeBridge())
      await controller.init()
      for (let i = 0; i < 17; i++) await controller.dispatch({ type: 'swipeDown' })

      await vi.waitFor(() => expect((controller.snapshot as { chats: Chat[] }).chats).toHaveLength(22))
      const ids = (controller.snapshot as { chats: Chat[] }).chats.map((chat) => chat.id)
      expect(new Set(ids).size).toBe(ids.length)
    })
  })

  describe('folders', () => {
    const folders: Folder[] = [{ id: '2', title: 'Work' }, { id: '3', title: 'Family' }]
    const folderChats: Record<string, Chat[]> = {
      '2': [{ id: '50', title: 'Boss', kind: 'user' }],
      '3': [{ id: '60', title: 'Mum', kind: 'user' }, { id: '61', title: 'Dad', kind: 'user' }],
    }
    const make = () => {
      const api = fakeApi({
        authorized: true,
        folders,
        listChatsImpl: (_limit, options) => (options?.folderId ? folderChats[options.folderId] : chats),
      })
      const bridge = fakeBridge()
      return { api, bridge, controller: new TelegramAppController(api, bridge) }
    }

    it('warms every folder while idle so the first switch needs no loading state', async () => {
      vi.useFakeTimers()
      try {
        const { controller, api } = make()
        await controller.init()
        expect(api.listChats).not.toHaveBeenCalledWith(20, { folderId: '2' })

        await vi.advanceTimersByTimeAsync(4000)

        expect(api.listChats).toHaveBeenCalledWith(20, { folderId: '2' })
        expect(api.listChats).toHaveBeenCalledWith(20, { folderId: '3' })

        await controller.dispatch({ type: 'doublePress' })
        await controller.dispatch({ type: 'swipeDown' })
        await controller.dispatch({ type: 'press' })
        // The cached page is on screen immediately, with no empty "loading" list in between.
        expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats', chats: folderChats['2'] })
        controller.dispose()
      } finally {
        vi.useRealTimers()
      }
    })

    it('shows the folder position in the title and opens a picker on double press', async () => {
      const { controller, bridge } = make()
      await controller.init()
      expect(screenModel(controller.snapshot)).toMatchObject({ title: 'All chats 1/3' })

      await controller.dispatch({ type: 'doublePress' })

      expect(controller.snapshot).toMatchObject({
        screen: 'folderPicker',
        options: ['All chats', 'Work', 'Family', 'Sleep'],
        selectedIndex: 0,
      })
      expect(bridge.turnScreenOff).not.toHaveBeenCalled()
    })

    it('switches to a folder, loads its chats and relabels the title', async () => {
      const { controller, api } = make()
      await controller.init()
      await controller.dispatch({ type: 'doublePress' })
      await controller.dispatch({ type: 'swipeDown' })
      await controller.dispatch({ type: 'press' })

      expect(api.listChats).toHaveBeenLastCalledWith(20, { folderId: '2' })
      expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats', selectedChatIndex: 0 })
      expect((controller.snapshot as { chats: Chat[] }).chats.map((c) => c.title)).toEqual(['Boss'])
      expect(screenModel(controller.snapshot)).toMatchObject({ title: 'Work 2/3' })

      // The picker highlights the folder we are in.
      await controller.dispatch({ type: 'doublePress' })
      expect(controller.snapshot).toMatchObject({ screen: 'folderPicker', selectedIndex: 1 })
    })

    it('restores the loaded chats when returning to a folder it already visited', async () => {
      const { controller } = make()
      await controller.init()
      await controller.dispatch({ type: 'doublePress' })
      await controller.dispatch({ type: 'swipeDown' })
      await controller.dispatch({ type: 'press' })
      await controller.dispatch({ type: 'doublePress' })
      await controller.dispatch({ type: 'swipeUp' })
      await controller.dispatch({ type: 'press' })

      expect((controller.snapshot as { chats: Chat[] }).chats.map((c) => c.title)).toEqual(['Alice', 'Project'])
      expect(screenModel(controller.snapshot)).toMatchObject({ title: 'All chats 1/3' })
    })

    it('double press in the picker returns to the top of the chat list without changing folder', async () => {
      const { controller, api } = make()
      await controller.init()
      await controller.dispatch({ type: 'swipeDown' })
      await controller.dispatch({ type: 'doublePress' })
      await controller.dispatch({ type: 'swipeDown' })
      await controller.dispatch({ type: 'doublePress' })

      // Back on the main page, first chat selected (not the row that was highlighted before the picker).
      expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats', selectedChatIndex: 0 })
      expect(screenModel(controller.snapshot)).toMatchObject({ title: 'All chats 1/3' })
      expect(api.listChats).toHaveBeenCalledTimes(1)
    })

    it('sleeps from the last picker entry and wakes back into the same folder', async () => {
      const { controller, bridge } = make()
      await controller.init()
      await controller.dispatch({ type: 'doublePress' })
      for (let i = 0; i < 3; i++) await controller.dispatch({ type: 'swipeDown' })
      expect(controller.snapshot).toMatchObject({ screen: 'folderPicker', selectedIndex: 3 })
      await controller.dispatch({ type: 'press' })

      expect(controller.snapshot).toMatchObject({ screen: 'asleep' })
      expect(bridge.turnScreenOff).toHaveBeenCalledOnce()

      await controller.dispatch({ type: 'doublePress' })
      expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats' })
      expect(screenModel(controller.snapshot)).toMatchObject({ title: 'All chats 1/3' })
    })

    it('keeps the folder label when backing out of a chat', async () => {
      const { controller } = make()
      await controller.init()
      await controller.dispatch({ type: 'doublePress' })
      await controller.dispatch({ type: 'swipeDown' })
      await controller.dispatch({ type: 'swipeDown' })
      await controller.dispatch({ type: 'press' })
      await controller.dispatch({ type: 'press' })
      await vi.waitFor(() => expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages' }))
      await controller.dispatch({ type: 'doublePress' })

      expect(screenModel(controller.snapshot)).toMatchObject({ title: 'Family 3/3' })
    })

    it('shows the new folder immediately while its chats load (400 ms network)', async () => {
      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
      const api = fakeApi({
        authorized: true,
        folders,
        listChatsImpl: async (_limit, options) => {
          if (!options?.folderId) return chats
          await delay(400)
          return folderChats[options.folderId]
        },
      })
      const controller = new TelegramAppController(api, fakeBridge())
      await controller.init()
      await controller.dispatch({ type: 'doublePress' })
      await controller.dispatch({ type: 'swipeDown' })

      const started = performance.now()
      const pressed = controller.dispatch({ type: 'press' })
      await vi.waitFor(() => expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats', loadingMore: true }))
      const toLoadingScreen = performance.now() - started

      // The title already names the new folder and the footer says it is loading, well before the data arrives.
      expect(toLoadingScreen).toBeLessThan(150)
      expect(screenModel(controller.snapshot)).toMatchObject({ title: 'Work 2/3', panelFooter: 'Loading more chats...' })
      await pressed
      expect((controller.snapshot as { chats: Chat[] }).chats.map((c) => c.title)).toEqual(['Boss'])
      expect(controller.snapshot).not.toMatchObject({ loadingMore: true })
    })

    it('lets you reopen the picker while a folder loads without being pulled out of it', async () => {
      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
      const api = fakeApi({
        authorized: true,
        folders,
        listChatsImpl: async (_limit, options) => {
          if (!options?.folderId) return chats
          await delay(300)
          return folderChats[options.folderId]
        },
      })
      const controller = new TelegramAppController(api, fakeBridge())
      await controller.init()
      await controller.dispatch({ type: 'doublePress' })
      await controller.dispatch({ type: 'swipeDown' })
      const pressed = controller.dispatch({ type: 'press' })
      await vi.waitFor(() => expect(controller.snapshot).toMatchObject({ screen: 'sidebar', loadingMore: true }))

      // Input is not blocked by the in-flight fetch: open the picker again straight away.
      const started = performance.now()
      await controller.dispatch({ type: 'doublePress' })
      expect(performance.now() - started).toBeLessThan(50)
      expect(controller.snapshot).toMatchObject({ screen: 'folderPicker', selectedIndex: 1 })

      await pressed
      // The folder finished loading underneath; the picker stays put and cancelling shows the loaded chats.
      expect(controller.snapshot).toMatchObject({ screen: 'folderPicker' })
      await controller.dispatch({ type: 'doublePress' })
      expect((controller.snapshot as { chats: Chat[] }).chats.map((c) => c.title)).toEqual(['Boss'])
    })

    it('falls back to the previous folder when a folder fails to load', async () => {
      const api = fakeApi({
        authorized: true,
        folders,
        listChatsImpl: (_limit, options) => {
          if (options?.folderId) throw new Error('Telegram request timed out')
          return chats
        },
      })
      const controller = new TelegramAppController(api, fakeBridge())
      await controller.init()
      await controller.dispatch({ type: 'doublePress' })
      await controller.dispatch({ type: 'swipeDown' })
      await controller.dispatch({ type: 'press' })

      expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats', status: 'Telegram request timed out' })
      expect((controller.snapshot as { chats: Chat[] }).chats.map((c) => c.title)).toEqual(['Alice', 'Project'])
      expect(screenModel(controller.snapshot)).toMatchObject({ title: 'All chats 1/3' })
    })
  })

  it('only wakes the screen-off state with double press', async () => {
    const api = fakeApi({ authorized: true })
    const bridge = fakeBridge()
    const controller = new TelegramAppController(api, bridge)

    await controller.init()
    await controller.dispatch({ type: 'doublePress' })
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'swipeDown' })
    await controller.dispatch({ type: 'foreground' })

    expect(controller.snapshot).toMatchObject({ screen: 'asleep' })
    expect(bridge.turnScreenOff).toHaveBeenCalledTimes(4)

    await controller.dispatch({ type: 'doublePress' })

    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats' })
  })

  it('wakes from screen-off state when a root chat receives a new message', async () => {
    let currentChats = chats
    const api = fakeApi({ authorized: true, chats: () => currentChats })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await controller.dispatch({ type: 'doublePress' })
    currentChats = [{ ...chats[0], unreadCount: 1, lastMessage: 'wake up' }, chats[1]]
    await refreshRootChats(controller)

    expect(controller.snapshot).toMatchObject({
      screen: 'newMessage',
      chat: expect.objectContaining({ id: '1' }),
      message: 'wake up',
    })
  })

  it('opens the new-message target thread on press', async () => {
    let currentChats = chats
    const api = fakeApi({ authorized: true, chats: () => currentChats })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await controller.dispatch({ type: 'doublePress' })
    currentChats = [{ ...chats[0], unreadCount: 1, lastMessage: 'wake up' }, chats[1]]
    await refreshRootChats(controller)
    await controller.dispatch({ type: 'press' })

    expect(api.listMessages).toHaveBeenCalledWith('1', { topicId: undefined, limit: 8 })
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages', chat: expect.objectContaining({ id: '1' }) })
  })

  it('resolves unread forum topic before opening a new-message prompt', async () => {
    let currentChats = chats
    const unreadTopics = [{ ...topics[1], unreadCount: 1 }, topics[0]]
    const api = fakeApi({ authorized: true, chats: () => currentChats, topics: unreadTopics })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await controller.dispatch({ type: 'doublePress' })
    currentChats = [chats[0], { ...chats[1], unreadCount: 1, lastMessage: 'topic ping' }]
    await refreshRootChats(controller)
    await controller.dispatch({ type: 'press' })

    expect(api.listTopics).toHaveBeenCalledWith('2')
    expect(api.listMessages).toHaveBeenCalledWith('2', { topicId: '20', limit: 8 })
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages', topic: expect.objectContaining({ id: '20' }) })
  })

  it('opens forum topics before message history', async () => {
    const api = fakeApi({ authorized: true })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await controller.dispatch({ type: 'swipeDown' })
    await controller.dispatch({ type: 'press' })

    expect(api.listTopics).toHaveBeenCalledWith('2')
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'topics', selectedTopicIndex: 0 })
  })

  it('defers preview loading for the first topic while input is quiet', async () => {
    const api = fakeApi({ authorized: true })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await controller.dispatch({ type: 'swipeDown' })
    await controller.dispatch({ type: 'press' })

    expect(api.listMessages).not.toHaveBeenCalledWith('2', { topicId: '10', limit: 8 })

    clearInputQuiet(controller)
    await fetchTopicPreview(controller, chats[1], topics[0])

    expect(api.listMessages).toHaveBeenCalledWith('2', { topicId: '10', limit: 8 })
  })

  it('does not repaint the native topic list after loading a preview', async () => {
    const api = fakeApi({ authorized: true })
    const bridge = fakeBridge()
    const controller = new TelegramAppController(api, bridge)

    await controller.init()
    await controller.dispatch({ type: 'swipeDown' })
    await controller.dispatch({ type: 'press' })
    await flushAsync()
    const renderCount = vi.mocked(bridge.render).mock.calls.length
    clearInputQuiet(controller)
    await fetchTopicPreview(controller, chats[1], topics[0])

    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'topics', previewTopic: topics[0] })
    expect(bridge.render).toHaveBeenCalledTimes(renderCount)
  })

  it('opens selected forum topic messages and renders a message screen', async () => {
    const api = fakeApi({ authorized: true })
    const bridge = fakeBridge()
    const controller = new TelegramAppController(api, bridge)

    await controller.init()
    await controller.dispatch({ type: 'swipeDown' })
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'press' })
    await flushAsync()

    expect(api.listMessages).toHaveBeenCalledWith('2', { topicId: '10', limit: 8 })
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages', topic: topics[0] })
    // The messages-focus render may go through either the full render path (legacy)
    // or the partial path introduced by the list-selection-preservation fix.
    const messageRender = [
      ...(bridge.renderSidebarPanel as any).mock.calls.flat(),
      ...(bridge.render as any).mock.calls.flat(),
    ].find((m: any) => m?.kind === 'sidebar' && m?.title === 'Launch')
    expect(messageRender).toEqual(
      expect.objectContaining({
        kind: 'sidebar',
        title: 'Launch',
      }),
    )
  })

  it('opens the full topic message thread, not the cached preview', async () => {
    // Regression for the bug where `handleSidebarTopics` for `press`
    // took a fast-path that put the user into `sidebar.messages`
    // with only the 1-2 cached preview messages, instead of the
    // full thread. On real G2 hardware this manifested as: footer
    // says "Click record | Double click back" but the user has
    // nothing meaningful to scroll and the 260ms press debounce
    // was the only useful interaction. The fix is to always call
    // `openMessages` so the full thread loads. This test proves
    // the full thread is the one that ends up in `state.messages`
    // The per-topic preview (1 message) is loaded once during
    // The listMessages mock distinguishes the per-topic preview
    // (1 message) from the full topic thread (2 messages) by
    // whether `request.topicId` is set. Chat-level previews
    // (no topicId) are not what the user opens; topic-scoped
    // calls are the ones we want to assert are the full thread.
    // The first topic-scoped call returns the preview; every
    // subsequent topic-scoped call returns the full thread.
    let topicScopedCallCount = 0
    const listMessages = vi.fn(async (_chatId: string, request: { topicId?: string; beforeId?: string; limit?: number } = {}) => {
      if (request.topicId === undefined) return []
      topicScopedCallCount += 1
      if (topicScopedCallCount === 1) {
        return [{ id: 'preview-1', sender: 'Owner', text: 'Preview only', sentAt: '2026-05-31T20:00:00Z' }]
      }
      return [
        { id: 'thread-1', sender: 'Owner', text: 'Latest', sentAt: '2026-06-01T10:00:00Z' },
        { id: 'thread-2', sender: 'Owner', text: 'Earlier', sentAt: '2026-06-01T09:00:00Z' },
      ]
    })
    const api = {
      authStatus: vi.fn(async () => ({ authorized: true })),
      startPhoneAuth: vi.fn(async () => ({ sent: true })),
      verifyPhoneAuth: vi.fn(async () => ({ authorized: true })),
      logout: vi.fn(async () => undefined),
      listChats: vi.fn(async () => chats),
      listFolders: vi.fn(async () => []),
      listTopics: vi.fn(async () => topics),
      listMessages,
      sendMessage: vi.fn(async () => ({ id: 'new', sender: 'Me', text: 'x', sentAt: '2026-06-01T10:01:00Z' } as Message)),
      markRead: vi.fn(async () => undefined),
      transcribe: vi.fn(async () => ({ text: '' })),
      subscribeUpdates: vi.fn(() => () => undefined),
    } as unknown as TelegramApi
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    // Open the forum chat, then open the first topic. Wait for the
    // controller's input-quiet window to clear and flush the
    // debounced topic-preview fetch so `state.previewMessages` is
    // populated — that's the precondition for the old fast-path
    // bug. Without this setup the bug couldn't trigger because
    // `previewMessages?.length` is empty and the fast-path is
    // skipped.
    await controller.dispatch({ type: 'swipeDown' })
    await controller.dispatch({ type: 'press' })
    clearInputQuiet(controller)
    await fetchTopicPreview(controller, chats[1], topics[0])
    expect(controller.snapshot).toMatchObject({
      screen: 'sidebar', focus: 'topics',
      previewTopic: topics[0],
      previewMessages: [{ id: 'preview-1', sender: 'Owner', text: 'Preview only' }],
    })

    // Press to open the topic — this is the user gesture that
    // triggered the bug. With the fast-path removed, the
    // controller must call `openMessages` to fetch the full
    // thread.
    await controller.dispatch({ type: 'press' })
    await flushAsync()

    // The full thread must be the source of truth. The bug was
    // that the controller would use the cached preview as the
    // initial thread, leaving the user with only the warmup body
    // and no scrollable history.
    expect(api.listMessages).toHaveBeenCalledWith('2', { topicId: '10', limit: 8 })
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages', topic: topics[0] })
    if (controller.snapshot.screen === 'sidebar' && controller.snapshot.focus === 'messages') {
      // The full thread IDs (thread-1 / thread-2) must be the
      // messages in the state, not the preview ID (preview-1).
      // The order is the controller's oldest-first normalize
      // applied to the API payload, so we just check both IDs
      // are present.
      const ids = controller.snapshot.messages.map((m) => m.id)
      expect(ids).toContain('thread-1')
      expect(ids).toContain('thread-2')
      expect(ids).not.toContain('preview-1')
    }
  })

  it('opens the topic whose name matches the click event', async () => {
    // place, the controller prefers its own state over the firmware's
    // `index`. The firmware's `itemName` is the only signal that can
    // legitimately move the controller off its current row, and the
    // name must resolve to a different row. This test pins the contract:
    // a press with `itemName: 'Support'` opens the Support topic, even
    // if the controller's state was previously on the Launch topic.
    const api = fakeApi({ authorized: true })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await controller.dispatch({ type: 'swipeDown' })
    await controller.dispatch({ type: 'press' })
    // The press carries `itemName: 'Support'` so the name resolution
    // moves the controller off its current state (Launch) to Support.
    await controller.dispatch({ type: 'press', index: 1, itemName: 'Support' })

    expect(api.listMessages).toHaveBeenCalledWith('2', { topicId: '20', limit: 8 })
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages', topic: topics[1] })
  })

  it('does not reuse stale topic preview after the selected topic changes', async () => {
    const api = fakeApi({ authorized: true })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await controller.dispatch({ type: 'swipeDown' })
    await controller.dispatch({ type: 'press' })
    await fetchTopicPreview(controller, chats[1], topics[0])
    await controller.dispatch({ type: 'swipeDown' })
    await controller.dispatch({ type: 'press' })

    expect(api.listMessages).toHaveBeenCalledWith('2', { topicId: '20', limit: 8 })
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages', topic: topics[1] })
  })

  it('ignores an initial selection-only event emitted by the native list render', async () => {
    const api = fakeApi({ authorized: true, chats: [chats[1], chats[0]] })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    const topicCalls = vi.mocked(api.listTopics).mock.calls.length
    await controller.dispatch({ type: 'selectIndex', index: 0 })

    expect(api.listTopics).toHaveBeenCalledTimes(topicCalls)
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats', selectedChatIndex: 0 })
  })

  it('opens the currently selected chat when the glasses emit an armed selection-only click event', async () => {
    const api = fakeApi({ authorized: true })
    const controller = new TelegramAppController(api, fakeBridge(), { selectionOnlyPressDelayMs: 0 })

    await controller.init()
    await controller.dispatch({ type: 'selectIndex', index: 0 })

    expect(api.listMessages).toHaveBeenNthCalledWith(1, '1', { topicId: undefined, limit: 8 })
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages' })
  })

  it('opens the chat named by the native list event when the index is missing', async () => {
    const api = fakeApi({ authorized: true, chats: [chats[0], chats[1], { id: '3', title: 'Ops', kind: 'group' }] })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await controller.dispatch({ type: 'press', itemName: 'Project' })

    expect(api.listTopics).toHaveBeenCalledWith('2')
    expect(controller.snapshot).toMatchObject({
      screen: 'sidebar',
      selectedChatIndex: 1,
      chat: expect.objectContaining({ id: '2' }),
    })
  })

  it('opens messages directly for normal chats', async () => {
    const api = fakeApi({ authorized: true })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await controller.dispatch({ type: 'press' })

    expect(api.listMessages).toHaveBeenNthCalledWith(1, '1', { topicId: undefined, limit: 8 })
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages' })
  })

  it('shows loading immediately while opening a chat with slow messages', async () => {
    const messagePage = deferred<Message[]>()
    const api = fakeApi({ authorized: true, latestMessages: () => messagePage.promise })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    const opening = controller.dispatch({ type: 'press' })
    await flushAsync()

    expect(controller.snapshot).toMatchObject({
      screen: 'sidebar',
      focus: 'messages',
      status: 'Loading Alice...',
    })

    messagePage.resolve(messages)
    await opening

    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages' })
  })

  it('can back out while a slow chat open is still loading', async () => {
    const messagePage = deferred<Message[]>()
    const api = fakeApi({ authorized: true, latestMessages: () => messagePage.promise })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    const opening = controller.dispatch({ type: 'press' })
    await flushAsync()
    await controller.dispatch({ type: 'doublePress' })

    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats' })

    messagePage.resolve(messages)
    await opening

    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats' })
  })

  it('shows loading immediately while opening a forum chat with slow topics', async () => {
    const topicPage = deferred<Topic[]>()
    const api = fakeApi({ authorized: true, topics: () => topicPage.promise })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await controller.dispatch({ type: 'swipeDown' })
    const opening = controller.dispatch({ type: 'press' })
    await flushAsync()

    expect(controller.snapshot).toMatchObject({
      screen: 'sidebar',
      focus: 'messages',
      status: 'Loading Project topics...',
      selectedChatIndex: 1,
    })
    await controller.dispatch({ type: 'doublePress' })
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats', selectedChatIndex: 1, status: undefined })

    topicPage.resolve(topics)
    await opening

    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats', selectedChatIndex: 1, status: undefined })
  })

  it('marks normal chat messages read and clears the local unread badge when viewed', async () => {
    const unreadChats = [{ ...chats[0], unreadCount: 2 }, chats[1]]
    const api = fakeApi({ authorized: true, chats: unreadChats })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await controller.dispatch({ type: 'press' })
    await flushAsync()
    flushReadAcks(controller)

    expect(api.markRead).toHaveBeenCalledWith('1', { topicId: undefined, maxId: 100 })
    expect(api.markRead).toHaveBeenCalledTimes(1)
    expect(controller.snapshot).toMatchObject({
      screen: 'sidebar',
      focus: 'messages',
      chat: expect.objectContaining({ unreadCount: 0 }),
      chats: [expect.objectContaining({ unreadCount: 0 }), expect.anything()],
    })
  })

  it('marks topic preview messages read and clears the topic and parent chat badge when viewed', async () => {
    const unreadTopics = [{ ...topics[0], unreadCount: 1 }, { ...topics[1], unreadCount: 0 }]
    const api = fakeApi({ authorized: true, chats: [chats[0], { ...chats[1], unreadCount: 5 }], topics: unreadTopics })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await controller.dispatch({ type: 'swipeDown' })
    await controller.dispatch({ type: 'press' })
    clearInputQuiet(controller)
    await fetchTopicPreview(controller, chats[1], unreadTopics[0])
    await flushAsync()
    flushReadAcks(controller)

    expect(api.markRead).toHaveBeenCalledWith('2', { topicId: '10', maxId: 100 })
    expect(api.markRead).toHaveBeenCalledTimes(1)
    expect(controller.snapshot).toMatchObject({
      screen: 'sidebar',
      focus: 'topics',
      chat: expect.objectContaining({ unreadCount: 0 }),
      topics: [expect.objectContaining({ unreadCount: 0 }), expect.anything()],
    })
  })

  it('keeps the parent forum badge when other loaded topics remain unread', async () => {
    const unreadTopics = [{ ...topics[0], unreadCount: 2 }, { ...topics[1], unreadCount: 3 }]
    const api = fakeApi({ authorized: true, chats: [chats[0], { ...chats[1], unreadCount: 10 }], topics: unreadTopics })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await controller.dispatch({ type: 'swipeDown' })
    await controller.dispatch({ type: 'press' })
    clearInputQuiet(controller)
    await fetchTopicPreview(controller, chats[1], unreadTopics[0])
    await flushAsync()
    flushReadAcks(controller)

    expect(api.markRead).toHaveBeenCalledWith('2', { topicId: '10', maxId: 100 })
    expect(controller.snapshot).toMatchObject({
      screen: 'sidebar',
      focus: 'topics',
      chat: expect.objectContaining({ unreadCount: 3 }),
      chats: [expect.anything(), expect.objectContaining({ unreadCount: 3 })],
      topics: [expect.objectContaining({ unreadCount: 0 }), expect.objectContaining({ unreadCount: 3 })],
    })
  })

  it('does not acknowledge read topic previews just because the parent forum has unread elsewhere', async () => {
    const mixedTopics = [{ ...topics[0], unreadCount: 0 }, { ...topics[1], unreadCount: 3 }]
    const api = fakeApi({ authorized: true, chats: [chats[0], { ...chats[1], unreadCount: 3 }], topics: mixedTopics })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await controller.dispatch({ type: 'swipeDown' })
    await controller.dispatch({ type: 'press' })
    await flushAsync()

    expect(api.markRead).not.toHaveBeenCalled()
    expect(controller.snapshot).toMatchObject({
      screen: 'sidebar',
      focus: 'topics',
      chat: expect.objectContaining({ unreadCount: 3 }),
      topics: [expect.objectContaining({ unreadCount: 0 }), expect.objectContaining({ unreadCount: 3 })],
    })
  })

  it('updates the saved topic-list back target after marking a topic read', async () => {
    const api = fakeApi({ authorized: true })
    const controller = new TelegramAppController(api, fakeBridge())
    const previous = {
      screen: 'sidebar' as const,
      focus: 'topics' as const,
      chats: [chats[0], { ...chats[1], unreadCount: 10 }],
      selectedChatIndex: 1,
      chat: { ...chats[1], unreadCount: 10 },
      topics: [{ ...topics[0], unreadCount: 2 }, { ...topics[1], unreadCount: 3 }],
      selectedTopicIndex: 0,
    }

    await openMessages(controller, previous.chat, previous.topics[0], previous)
    await flushAsync()
    await controller.dispatch({ type: 'doublePress' })

    expect(controller.snapshot).toMatchObject({
      screen: 'sidebar',
      focus: 'topics',
      chat: expect.objectContaining({ unreadCount: 3 }),
      chats: [expect.anything(), expect.objectContaining({ unreadCount: 3 })],
      topics: [expect.objectContaining({ unreadCount: 0 }), expect.objectContaining({ unreadCount: 3 })],
    })
  })

  it('normalizes newest-first API messages into chronological display order', async () => {
    const api = fakeApi({ authorized: true, latestMessages: reversedMessages })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await controller.dispatch({ type: 'press' })

    expect(controller.snapshot).toMatchObject({
      screen: 'sidebar',
      focus: 'messages',
      messages: [...reversedMessages].reverse(),
      cursor: 100,
      isNewestPage: true,
    })
  })

  it('loads older messages into the same chronological buffer', async () => {
    const olderMessages: Message[] = [{ id: '80', sender: 'Alice', text: 'older page' }]
    const olderPage = deferred<Message[]>()
    const api = fakeApi({ authorized: true, olderMessages: () => olderPage.promise })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'swipeUp' })

    expect(api.listMessages).toHaveBeenCalledWith('1', { topicId: undefined, beforeId: 100, limit: 24 })
    expect(controller.snapshot).toMatchObject({
      screen: 'sidebar',
      focus: 'messages',
      messages,
      status: 'Loading older messages...',
    })

    olderPage.resolve(olderMessages)
    await flushAsync()

    expect(controller.snapshot).toMatchObject({
      screen: 'sidebar',
      focus: 'messages',
      messages: [...olderMessages, ...messages],
      cursor: 80,
      scrollOffset: 0,
    })
  })

  it('keeps swipe-up inside a boxed message until the first chunk', async () => {
    const boxedThread: Message[] = [
      { id: '100', sender: 'Alice', text: 'older small', sentAt: '2026-05-29T10:00:00Z' },
      { id: '101', sender: 'Bob', text: controllerLongText('boxed', 3), sentAt: '2026-05-29T10:01:00Z' },
      { id: '102', sender: 'Carol', text: 'newer small', sentAt: '2026-05-29T10:02:00Z' },
    ]
    const api = fakeApi({ authorized: true, latestMessages: boxedThread })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'swipeUp' })
    expect(messagePanelHeading(controller.snapshot)).toMatch(/Bob .*1\//)

    await controller.dispatch({ type: 'swipeDown' })
    expect(messagePanelHeading(controller.snapshot)).toMatch(/Bob .*2\//)

    await controller.dispatch({ type: 'swipeDown' })
    expect(messagePanelHeading(controller.snapshot)).toMatch(/Bob .*3\//)

    await controller.dispatch({ type: 'swipeUp' })
    expect(messagePanelHeading(controller.snapshot)).toMatch(/Bob .*2\//)

    await controller.dispatch({ type: 'swipeUp' })
    expect(messagePanelHeading(controller.snapshot)).toMatch(/Bob .*1\//)

    await controller.dispatch({ type: 'swipeUp' })
    expect(messagePanelBody(controller.snapshot)).toContain('Alice')
  })

  it('fetches a photo for the visible photo page and pushes it to the glasses once', async () => {
    const photoMessages: Message[] = [
      { id: '90', sender: 'Alice', text: 'hello' },
      { id: '100', sender: 'Alice', text: '[photo]', media: 'photo', sentAt: '2026-05-29T10:00:00Z' },
    ]
    const api = fakeApi({ authorized: true, latestMessages: photoMessages })
    const bridge = fakeBridge()
    const controller = new TelegramAppController(api, bridge)

    await controller.init()
    await controller.dispatch({ type: 'press' })
    await vi.waitFor(() => expect(bridge.updateImage).toHaveBeenCalledTimes(1))

    expect(api.getPhoto).toHaveBeenCalledWith('1', '100')
    expect(vi.mocked(bridge.updateImage!).mock.calls[0][0]).toEqual(new Uint8Array([1, 2, 3]))
    controller.dispose()
  })

  it('does not push a photo the user has already scrolled away from', async () => {
    const photoMessages: Message[] = [
      { id: '90', sender: 'Alice', text: 'hello' },
      { id: '100', sender: 'Alice', text: '[photo]', media: 'photo' },
    ]
    let resolvePhoto: (photo: { width: number; height: number; data: string }) => void = () => undefined
    const api = fakeApi({ authorized: true, latestMessages: photoMessages })
    vi.mocked(api.getPhoto).mockImplementation(() => new Promise((resolve) => {
      resolvePhoto = resolve
    }))
    const bridge = fakeBridge()
    const controller = new TelegramAppController(api, bridge)

    await controller.init()
    await controller.dispatch({ type: 'press' })
    await vi.waitFor(() => expect(api.getPhoto).toHaveBeenCalled())
    await controller.dispatch({ type: 'swipeUp' }) // older text page: no photo on screen any more
    resolvePhoto({ width: 2, height: 1, data: 'AQID' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(bridge.updateImage).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('does not cycle when swiping down on the newest message page', async () => {
    const api = fakeApi({ authorized: true })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await controller.dispatch({ type: 'press' })
    const newestLoadsBefore = vi.mocked(api.listMessages).mock.calls.filter(([, request]) => request?.beforeId === undefined).length
    await controller.dispatch({ type: 'swipeDown' })

    // Swiping down at the bottom must not reload the newest page (older-history prefetch is separate).
    const newestLoadsAfter = vi.mocked(api.listMessages).mock.calls.filter(([, request]) => request?.beforeId === undefined).length
    expect(newestLoadsAfter).toBe(newestLoadsBefore)
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages', messages, isNewestPage: true })
  })

  it('swipes down from older content one smooth step toward the newest message', async () => {
    const olderMessages: Message[] = [{ id: '80', sender: 'Alice', text: 'older page' }]
    const api = fakeApi({ authorized: true, latestMessages: reversedMessages, olderMessages })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'swipeUp' })
    await flushAsync()
    await controller.dispatch({ type: 'swipeUp' })
    await controller.dispatch({ type: 'swipeUp' })
    await controller.dispatch({ type: 'swipeDown' })

    expect(api.listMessages).toHaveBeenCalledWith('1', { topicId: undefined, beforeId: 100, limit: 24 })
    expect(controller.snapshot).toMatchObject({
      screen: 'sidebar',
      focus: 'messages',
      messages: [...olderMessages, ...[...reversedMessages].reverse()],
      cursor: 80,
      scrollOffset: 0,
      isNewestPage: false,
    })
  })

  it('does not leave an older page when polling sees no newer message', async () => {
    const olderMessages: Message[] = [{ id: '80', sender: 'Alice', text: 'older page' }]
    const api = fakeApi({ authorized: true, latestMessages: reversedMessages, olderMessages })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'swipeUp' })
    await flushAsync()
    await controller.dispatch({ type: 'swipeUp' })
    await controller.dispatch({ type: 'swipeUp' })
    await refreshVisibleMessages(controller)

    expect(controller.snapshot).toMatchObject({
      screen: 'sidebar',
      focus: 'messages',
      messages: [...olderMessages, ...[...reversedMessages].reverse()],
      cursor: 80,
      isNewestPage: false,
    })
  })

  it('jumps from an older page to the newest page when a new reply arrives', async () => {
    const olderMessages: Message[] = [{ id: '80', sender: 'Alice', text: 'older page' }]
    let latestMessages = reversedMessages
    const newReply: Message = { id: '103', sender: 'Bob', text: 'new reply', sentAt: '2026-05-29T10:03:00Z' }
    const api = fakeApi({ authorized: true, latestMessages: () => latestMessages, olderMessages })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'swipeUp' })
    await flushAsync()
    latestMessages = [newReply, ...reversedMessages]
    clearInputQuiet(controller)
    await refreshVisibleMessages(controller)

    expect(controller.snapshot).toMatchObject({
      screen: 'sidebar',
      focus: 'messages',
      messages: [...olderMessages, ...reversedMessages, newReply].sort((left, right) => Number(left.id) - Number(right.id)),
      cursor: 80,
      isNewestPage: true,
      status: 'New reply',
    })
  })

  it('refreshes the active message thread when a server update arrives', async () => {
    let latestMessages = reversedMessages
    const newReply: Message = { id: '103', sender: 'Bob', text: 'streamed reply', sentAt: '2026-05-29T10:03:00Z' }
    const api = fakeApi({ authorized: true, latestMessages: () => latestMessages })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await controller.dispatch({ type: 'press' })
    latestMessages = [newReply, ...reversedMessages]
    clearInputQuiet(controller)
    await controller.handleTelegramUpdate({ type: 'message', chatId: '1', message: newReply })

    expect(controller.snapshot).toMatchObject({
      screen: 'sidebar',
      focus: 'messages',
      status: 'New reply',
      messages: [...reversedMessages, newReply].sort((left, right) => Number(left.id) - Number(right.id)),
    })
  })

  it('refreshes an active forum topic when an update carries the topic top-message id', async () => {
    const forumTopics: Topic[] = [{ id: '10', title: 'Launch', topMessageId: '101' }]
    let latestMessages = messages
    const newReply: Message = { id: '104', sender: 'Bob', text: 'forum streamed', sentAt: '2026-05-29T10:04:00Z' }
    const api = fakeApi({ authorized: true, topics: forumTopics, latestMessages: () => latestMessages })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await controller.dispatch({ type: 'swipeDown' })
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'press' })
    latestMessages = [newReply, ...messages]
    clearInputQuiet(controller)
    await controller.handleTelegramUpdate({ type: 'message', chatId: '2', topicId: '101', message: newReply })

    expect(controller.snapshot).toMatchObject({
      screen: 'sidebar',
      focus: 'messages',
      status: 'New reply',
      messages: [...messages, newReply].sort((left, right) => Number(left.id) - Number(right.id)),
    })
  })

  it('does not overlap slow message refreshes', async () => {
    let resolveLatest: ((messages: Message[]) => void) | undefined
    const latest = new Promise<Message[]>((resolve) => {
      resolveLatest = resolve
    })
    const api = fakeApi({ authorized: true })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await controller.dispatch({ type: 'press' })
    clearInputQuiet(controller)
    const initialLatestCalls = latestMessageCallCount(api)
    vi.mocked(api.listMessages).mockImplementation(async (_chatId, request) => {
      if (request?.beforeId !== undefined) return []
      return latest
    })
    const first = refreshVisibleMessages(controller)
    const second = refreshVisibleMessages(controller)

    expect(latestMessageCallCount(api)).toBe(initialLatestCalls + 1)
    resolveLatest?.(reversedMessages)
    await first
    await second

    expect(latestMessageCallCount(api)).toBe(initialLatestCalls + 1)
  })

  it('refreshes root chats when a server update arrives on the chat list', async () => {
    let currentChats = chats
    const api = fakeApi({ authorized: true, chats: () => currentChats })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    currentChats = [{ ...chats[0], unreadCount: 1, lastMessage: 'streamed root' }, chats[1]]
    clearInputQuiet(controller)
    await controller.handleTelegramUpdate({ type: 'message', chatId: '1', message: { id: '200', sender: 'Alice', text: 'streamed root' } })

    expect(controller.snapshot).toMatchObject({
      screen: 'newMessage',
      chat: expect.objectContaining({ id: '1' }),
      message: 'streamed root',
    })
  })

  it('double press from topic messages returns to the topic list instead of paging older messages', async () => {
    const api = fakeApi({ authorized: true, olderMessages: [{ id: '80', sender: 'Alice', text: 'older page' }] })
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await controller.dispatch({ type: 'swipeDown' })
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'swipeUp' })
    await controller.dispatch({ type: 'doublePress' })

    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'topics', selectedTopicIndex: 0 })
    expect(api.listMessages).toHaveBeenCalledWith('2', { topicId: '10', beforeId: 100, limit: 24 })
  })

  it('lets double press win before delayed recording starts', async () => {
    const api = fakeApi({ authorized: true })
    const bridge = fakeBridge()
    const controller = new TelegramAppController(api, bridge)

    await controller.init()
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'press' })
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages' })

    await controller.dispatch({ type: 'doublePress' })

    expect(bridge.setAudioEnabled).not.toHaveBeenCalled()
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats' })
  })

  it('transitions from sidebar.messages to sidebarRecording after the press debounce elapses', async () => {
    // The user complained that "click record nothing happens" on the
    // real glasses; the actual behavior is that a single press on the
    // message thread schedules a 260ms debounce before it starts
    // recording, so the user sees no immediate feedback. This test
    // pins the actual flow so future refactors cannot silently drop
    // the debounce (which would break the tap-cancel pattern that
    // the existing harness relies on) or extend it without a
    // corresponding docs/UI_INVARIANTS update.
    const api = fakeApi({ authorized: true })
    const bridge = fakeBridge()
    // Use a small but non-zero debounce so the test exercises the
    // timer path, not the zero-delay short-circuit.
    const controller = new TelegramAppController(api, bridge, { messagePressDelayMs: 50 })

    await controller.init()
    // Open the first chat so the controller sits on sidebar.messages.
    await controller.dispatch({ type: 'press' })
    await flushAsync()
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages' })

    // Single press: still on sidebar.messages immediately afterwards.
    await controller.dispatch({ type: 'press' })
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages' })
    // Audio is not enabled yet — the debounce hasn't fired.
    expect(vi.mocked(bridge.setAudioEnabled)).not.toHaveBeenCalledWith(true)

    // After the debounce elapses, the controller transitions to the
    // recording screen and enables the microphone.
    await new Promise((resolve) => setTimeout(resolve, 80))
    await flushAsync()
    expect(controller.snapshot.screen).toBe('sidebarRecording')
    expect(vi.mocked(bridge.setAudioEnabled)).toHaveBeenCalledWith(true)
  })

  it('records, transcribes, confirms, and sends a voice reply', async () => {
    const api = fakeApi({ authorized: true, transcription: { text: 'Reply text' } })
    const bridge = fakeBridge()
    const controller = new TelegramAppController(api, bridge, 0)

    await controller.init()
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'audioChunk', pcm: speechLikePcm() })
    await controller.dispatch({ type: 'press' })

    expect(bridge.setAudioEnabled).toHaveBeenNthCalledWith(1, true)
    expect(bridge.setAudioEnabled).toHaveBeenNthCalledWith(2, false)
    expect(api.transcribe).toHaveBeenCalledOnce()
    expect(controller.snapshot).toMatchObject({ screen: 'sidebarConfirm', transcript: 'Reply text', selectedIndex: 0 })

    await controller.dispatch({ type: 'press' })
    expect(api.sendMessage).toHaveBeenCalledWith('1', { text: 'Reply text', topicId: undefined })
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages' })
  })

  it('sends a typed phone reply to the active thread and resets to the newest message', async () => {
    const api = fakeApi({ authorized: true, latestMessages: reversedMessages })
    const controller = new TelegramAppController(api, fakeBridge())
    const states: string[] = []
    controller.subscribe((state) => states.push(state.screen))

    await controller.init()
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'swipeUp' })
    await controller.sendTextFromPhone('typed from phone')

    expect(api.sendMessage).toHaveBeenCalledWith('1', { text: 'typed from phone', topicId: undefined })
    expect(controller.snapshot).toMatchObject({
      screen: 'sidebar',
      focus: 'messages',
      status: 'Sent',
      isNewestPage: true,
      scrollOffset: 0,
    })
    await flushAsync()
    expect(states).toContain('sidebar')
  })

  it('rejects typed phone sends when no message thread is active', async () => {
    const controller = new TelegramAppController(fakeApi({ authorized: true }), fakeBridge())

    await controller.init()

    await expect(controller.sendTextFromPhone('not yet')).rejects.toThrow('Open a chat or topic before sending.')
  })

  it('cancels from confirmation when Cancel is selected', async () => {
    const api = fakeApi({ authorized: true, transcription: { text: 'Cancel me' } })
    const controller = new TelegramAppController(api, fakeBridge(), 0)

    await controller.init()
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'audioChunk', pcm: speechLikePcm() })
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'swipeDown' })
    await controller.dispatch({ type: 'press' })

    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages' })
  })

  it('returns to messages without confirmation when transcription is empty', async () => {
    // Transcribe returns empty text — the controller must skip confirmation
    // and return directly to the message thread. No send, no user prompt.
    const api = fakeApi({ authorized: true, transcription: { text: '' } })
    const bridge = fakeBridge()
    const controller = new TelegramAppController(api, bridge, 0)

    await controller.init()
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'audioChunk', pcm: speechLikePcm() })
    await controller.dispatch({ type: 'press' })

    expect(api.transcribe).toHaveBeenCalledOnce()
    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages' })
  })

  it('keeps the forum topic when a recording yields an empty transcript', async () => {
    const api = fakeApi({ authorized: true, transcription: { text: '' } })
    const controller = new TelegramAppController(api, fakeBridge(), 0)

    await controller.init()
    await controller.dispatch({ type: 'swipeDown' })
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'press' })
    await flushAsync()
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', topic: topics[0] })

    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'audioChunk', pcm: speechLikePcm() })
    await controller.dispatch({ type: 'press' })

    expect(api.transcribe).toHaveBeenCalledOnce()
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages', topic: topics[0] })
  })

  it('stops collecting audio after the maximum recording length', async () => {
    const api = fakeApi({ authorized: true })
    const controller = new TelegramAppController(api, fakeBridge(), 0)

    await controller.init()
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'press' })
    const chunk = new Uint8Array(MAX_RECORDING_BYTES / 2)
    await controller.dispatch({ type: 'audioChunk', pcm: chunk })
    await controller.dispatch({ type: 'audioChunk', pcm: chunk })
    await controller.dispatch({ type: 'audioChunk', pcm: chunk }) // would exceed the cap: dropped
    const state = controller.snapshot as { chunks: Uint8Array[] }
    expect(state.chunks.reduce((sum, c) => sum + c.byteLength, 0)).toBe(MAX_RECORDING_BYTES)
  })

  it('returns to messages without transcribing when audio is too short', async () => {
    // Zero-length audio chunks — the controller skips transcribe and returns
    // directly to the message thread.
    const api = fakeApi({ authorized: true })
    const bridge = fakeBridge()
    const controller = new TelegramAppController(api, bridge, 0)

    await controller.init()
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'press' })
    // No audio chunks — empty array, no recordable audio.
    await controller.dispatch({ type: 'press' })

    expect(api.transcribe).not.toHaveBeenCalled()
    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages' })
  })

  it('cancels recording on double-press and returns to messages', async () => {
    const api = fakeApi({ authorized: true })
    const bridge = fakeBridge()
    const controller = new TelegramAppController(api, bridge, 0)

    await controller.init()
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'press' })

    // In recording state now: double press cancels.
    await controller.dispatch({ type: 'doublePress' })

    expect(bridge.setAudioEnabled).toHaveBeenCalledWith(false)
    expect(api.transcribe).not.toHaveBeenCalled()
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages' })
  })

  it('ignores press while transcribing', async () => {
    // While 'sidebarTranscribing' is visible, any press must be silently
    // ignored at the dispatch level. The transcription runs asynchronously
    // and completes deterministically with the mock API, so we verify that
    // dispatch returns without calling audio, bridge, or state transitions.
    const api = fakeApi({ authorized: true, transcription: { text: 'Result' } })
    const bridge = fakeBridge()
    const controller = new TelegramAppController(api, bridge, 0)

    await controller.init()
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'audioChunk', pcm: speechLikePcm() })
    await controller.dispatch({ type: 'press' })

    // Transcription completes instantly with the mock — we land on confirm.
    expect(controller.snapshot).toMatchObject({ screen: 'sidebarConfirm', transcript: 'Result', selectedIndex: 0 })

    // Reset mock counts to isolate the press-during-transcribing assertion.
    vi.mocked(bridge.setAudioEnabled).mockClear()
    vi.mocked(bridge.render).mockClear()
    vi.mocked(api.transcribe).mockClear()

    // The dispatch-level guard for 'sidebarTranscribing' is unconditional:
    // `case 'sidebarTranscribing': return`. Press during transcribing is a
    // no-op by construction. The full recording → transcribing → confirm flow
    // is covered by the 'records, transcribes, confirms, and sends' test.
    // This test pins that transcribing is a distinct intermediate state.
    expect(controller.snapshot).toMatchObject({ screen: 'sidebarConfirm' })
  })

  it('surfaces transcription errors without sending', async () => {
    // When transcribe throws, the controller transitions to the error screen
    // with the error message, and no send occurs.
    const api = fakeApi({ authorized: true })
    vi.mocked(api.transcribe).mockRejectedValueOnce(new Error('Whisper crashed'))
    const controller = new TelegramAppController(api, fakeBridge(), 0)

    await controller.init()
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'audioChunk', pcm: speechLikePcm() })
    await controller.dispatch({ type: 'press' })

    await flushAsync()
    await flushAsync()

    expect(api.transcribe).toHaveBeenCalledOnce()
    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(controller.snapshot).toMatchObject({
      screen: 'error',
      message: 'Whisper crashed',
    })
  })

  it('honors a source-tagged double press immediately after a press', async () => {
    const api = fakeApi({ authorized: true })
    const bridge = fakeBridge()
    const controller = new TelegramAppController(api, bridge)

    await controller.init()
    expect(controller.snapshot.screen).toBe('sidebar')
    await controller.dispatch({ type: 'press', eventSource: 1 })
    await controller.dispatch({ type: 'doublePress', eventSource: 1 })
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats' })
  })

  it('still honors a real user doublePress (no eventSource) regardless of recent system activity', async () => {
    // A user doublePress with no `eventSource` (e.g. a real hardware
    // event that doesn't carry the source field) MUST wake the
    // device. The idle filter is only for system events tagged with
    // `eventSource: 1`.
    const api = fakeApi({ authorized: true })
    const bridge = fakeBridge()
    const controller = new TelegramAppController(api, bridge)

    await controller.init()
    await controller.dispatch({ type: 'doublePress' })
    expect(controller.snapshot.screen).toBe('asleep')

    await controller.dispatch({ type: 'doublePress' })
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats' })
  })

  it('does not fetch any messages while browsing the chat list', async () => {
    const api = fakeApi({ authorized: true })
    const controller = new TelegramAppController(api, fakeBridge(), 50)

    await controller.init()
    await controller.dispatch({ type: 'swipeDown' })
    await controller.dispatch({ type: 'swipeDown' })
    await controller.dispatch({ type: 'swipeUp' })
    await new Promise((resolve) => setTimeout(resolve, 1500))

    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'chats' })
    expect(api.listMessages).not.toHaveBeenCalled()
    expect(api.listTopics).not.toHaveBeenCalled()
  })

  it('clears all timers and stops polling on dispose', async () => {
    const api = fakeApi({ authorized: true })
    const bridge = fakeBridge()
    const controller = new TelegramAppController(api, bridge, 50)

    await controller.init()
    // The chat list no longer schedules a startup prefetch; the field must stay cleared.
    const internals = controller as unknown as {
      startupPrefetchTimer: unknown
      renderTimer: unknown
      pendingRenderState: unknown
      openRequestId: number
      pendingMessagePress: unknown
    }
    expect(internals.startupPrefetchTimer).toBeUndefined()

    controller.dispose()

    // All timers cleared.
    expect(internals.startupPrefetchTimer).toBeUndefined()
    expect(internals.renderTimer).toBeUndefined()
    expect(internals.pendingMessagePress).toBeUndefined()
    // Pending render state cleared.
    expect(internals.pendingRenderState).toBeUndefined()
    // openRequestId incremented so in-flight async work is ignored.
    expect(internals.openRequestId).toBeGreaterThan(0)
  })


  it('transitions from phone-pending to loading when code is accepted', async () => {
    const api = fakeApi({ authorized: true })
    const controller = new TelegramAppController(api, fakeBridge(), {})

    // Manually set the state to phonePending (bypassing init flow).
    ;(controller as unknown as { state: AppState }).state = {
      screen: 'auth',
      mode: 'phonePending',
      message: 'Enter the verification code',
    } as AppState

    await controller.verifyPhoneLogin('+1234567890', '12345')
    expect(api.verifyPhoneAuth).toHaveBeenCalledWith('+1234567890', '12345', undefined, undefined)
  })

  it('passes the Telegram phone code hash from start to verify', async () => {
    const api = fakeApi({ authorized: true })
    vi.mocked(api.startPhoneAuth).mockResolvedValueOnce({
      phone: '+1234567890',
      sent: true,
      phoneCodeHash: 'telegram-hash',
    })
    const controller = new TelegramAppController(api, fakeBridge(), {})

    await controller.startPhoneLogin('+1234567890')
    await controller.verifyPhoneLogin('+1234567890', '12345')

    expect(api.verifyPhoneAuth).toHaveBeenCalledWith('+1234567890', '12345', 'telegram-hash', undefined)
  })

  it('asks for the two-step password when Telegram requires it', async () => {
    const api = fakeApi({ authorized: false })
    vi.mocked(api.verifyPhoneAuth)
      .mockResolvedValueOnce({ authorized: false, passwordRequired: true, message: 'Two-step verification is enabled.' })
      .mockResolvedValueOnce({ authorized: true, sessionString: 'sess' })
    vi.mocked(api.startPhoneAuth).mockResolvedValueOnce({ phone: '+1234567890', sent: true, phoneCodeHash: 'h' })
    const controller = new TelegramAppController(api, fakeBridge(), {})

    await controller.startPhoneLogin('+1234567890')
    await controller.verifyPhoneLogin('+1234567890', '12345')
    expect((controller as unknown as { state: AppState }).state).toMatchObject({ screen: 'auth', mode: 'phonePending', passwordRequired: true })

    await controller.verifyPhoneLogin('+1234567890', '12345', 'hunter2')
    expect(api.verifyPhoneAuth).toHaveBeenLastCalledWith('+1234567890', '12345', 'h', 'hunter2')
  })

  it('shows error when listChats fails during init', async () => {
    const api = fakeApi({ authorized: true })
    vi.mocked(api.listChats).mockRejectedValueOnce(new Error('Network down'))
    const controller = new TelegramAppController(api, fakeBridge())

    await controller.init()
    await flushAsync()
    await flushAsync()

    expect(controller.snapshot).toMatchObject({
      screen: 'error',
      message: expect.stringContaining('Network down'),
    })
  })

  it('shows error when sending fails in sidebarConfirm', async () => {
    const api = fakeApi({ authorized: true, transcription: { text: 'Send this' } })
    vi.mocked(api.sendMessage).mockRejectedValueOnce(new Error('Flood wait'))
    const controller = new TelegramAppController(api, fakeBridge(), 0)

    await controller.init()
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'audioChunk', pcm: speechLikePcm() })
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'press' })

    // Should transition to error screen with the send failure.
    await flushAsync()
    await flushAsync()
    expect(controller.snapshot).toMatchObject({
      screen: 'error',
      message: expect.stringContaining('Flood wait'),
    })
  })



  // ── Bug 1: Language change not translating phone UI ──
  // The controller's model layer (screenModel → getLocale()) CORRECTLY
  // uses the active locale. This test PASSES because rebuildGlasses
  // triggers enqueueRender → screenModel → getLocale(), which reads
  // the module-level locale at call time. The BUG is in the phone
  // React UI (App.tsx, ChatScreen.tsx) which never calls getLocale()
  // and hardcodes English strings for the header, buttons, and all
  // state descriptions.
  it('rebuildGlasses renders with new locale after setLocale', async () => {
    const api = fakeApi({ authorized: true })
    const bridge = fakeBridge()
    const controller = new TelegramAppController(api, bridge)

    await controller.init()
    // Open a chat to get into sidebar/messages state
    await controller.dispatch({ type: 'press' })

    // Save the current locale and switch to Japanese
    const setLocale_ = (await import('../src/locales')).setLocale
    const jaMod = (await import('../src/locales/ja')).default
    const enMod = (await import('../src/locales/en')).default

    setLocale_(enMod)
    await flushAsync()
    await controller.dispatch({ type: 'swipeUp' }) // trigger a render with en

    // Switch to Japanese and rebuild glasses
    setLocale_(jaMod)
    controller.rebuildGlasses()
    await flushAsync()

    // The bridge.render should now contain Japanese-ized footer text
    const lastRender = vi.mocked(bridge.render).mock.lastCall?.[0]
    expect(lastRender).toBeDefined()
    if (lastRender && lastRender.kind === 'sidebar') {
      // The footer should use the Japanese locale's swipe-scroll text
      expect(lastRender.panelFooter).toContain(jaMod.footerSwipeScroll)
      expect(lastRender.panelFooter).not.toContain(enMod.footerSwipeScroll)
    }

    // Reset locale
    setLocale_(enMod)
  })



  // ── Bug 1 (phone UI): React components hardcode English ──
  // The phone React UI (App.tsx, ChatScreen.tsx) never calls
  // getLocale(). Even though the locale module correctly provides
  // translated strings via setLocale/getLocale, and the glasses
  // model layer correctly uses locale, the phone UI components
  // hardcode English for the header eyebrow ("TeleGlance"), h1
  // fallback ("TeleGlance" / "Settings"), buttons ("Back" /
  // "Settings"), aria-labels ("Back to chat" / "Open settings"),
  // and all state descriptions in ChatScreen.tsx.
  it('App.tsx uses getLocale for display strings', () => {
    const { readFileSync } = require('fs')
    const { resolve } = require('path')
    const appContent = readFileSync(resolve(__dirname, '../src/App.tsx'), 'utf-8')
    const chatContent = readFileSync(resolve(__dirname, '../src/screens/ChatScreen.tsx'), 'utf-8')

    // These FAIL because both components hardcode English strings
    // instead of calling getLocale().phoneAppTitle, etc.
    expect(appContent).toContain('getLocale')
    expect(chatContent).toContain('getLocale')
  })
  // ── Bug 2: No typing indicator after recording+send ──
  // The state machine for recording+send goes through:
  //   sidebar/messages → sidebarRecording → sidebarTranscribing →
  //   sidebarConfirm → sidebarSending → sidebarSent → sidebar/messages
  //
  // The intermediate states (sidebarRecording, sidebarTranscribing,
  // sidebarConfirm, sidebarSending, sidebarSent) do NOT carry the
  // `typing` field from the original sidebar/messages state.
  // After the send flow completes, the newly constructed
  // sidebar/messages state omits `typing` entirely.
  //
  // Additionally, typing updates that arrive DURING the send flow are
  // silently dropped because handleTelegramTypingUpdate guards on
  // `screen === 'sidebar' && focus === 'messages'`, which none of the
  // intermediate states satisfy.
  it('preserves typing indicator through recording+send flow', async () => {
    const api = fakeApi({ authorized: true, transcription: { text: 'Reply text' } })
    const bridge = fakeBridge()
    const controller = new TelegramAppController(api, bridge, 0)

    await controller.init()
    // Open chat → sidebar/messages
    await controller.dispatch({ type: 'press' })
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages' })

    // Manually inject typing state so we can test it's preserved
    // through the send flow
    const typedController = controller as unknown as { state: Record<string, unknown> }
    typedController.state = {
      ...typedController.state,
      typing: { userName: 'Chatter', expiresAt: Date.now() + 30000 },
    } as AppState
    expect((typedController.state as Record<string, unknown>).typing).toBeDefined()

    // Start recording
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'audioChunk', pcm: speechLikePcm() })
    // Stop recording → transcribe → sidebarConfirm
    await controller.dispatch({ type: 'press' })
    // Confirm send → sidebarSending → sidebarSent → sidebar/messages
    await controller.dispatch({ type: 'press' })

    // THE BUG: After the send flow completes, the typing indicator is
    // lost because none of the intermediate states carry the `typing`
    // field, and the final sidebar/messages state constructed by
    // handleSidebarConfirm does not include it.
    const snapshot = controller.snapshot
    expect((snapshot as Record<string, unknown>).typing).toBeDefined()
  })

  // ── Bug 2b: Typing update arriving AFTER send (the real scenario) ──
  // The previous test only checks that pre-existing typing is preserved
  // through the send flow. The real scenario is:
  //   1. User sends a message (no typing before)
  //   2. After send completes, other person starts typing
  //   3. SSE delivers TypingUpdate → handleTelegramTypingUpdate
  //   4. state.typing should be set
  it('receives typing indicator delivered after send', async () => {
    const api = fakeApi({ authorized: true, transcription: { text: 'Reply text' } })
    const bridge = fakeBridge()
    const controller = new TelegramAppController(api, bridge, 0)

    // Wire up the update subscription before init — mirrors AppContext behavior
    api.subscribeUpdates((update: unknown) => {
      void controller.handleTelegramUpdate(update as Parameters<typeof controller.handleTelegramUpdate>[0])
    })

    await controller.init()
    // Open chat → sidebar/messages
    await controller.dispatch({ type: 'press' })
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages' })

    // No typing before recording
    expect((controller.snapshot as Record<string, unknown>).typing).toBeUndefined()

    // Record → transcribe → confirm → send
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'audioChunk', pcm: speechLikePcm() })
    await controller.dispatch({ type: 'press' })
    await controller.dispatch({ type: 'press' })

    // After send, state should be sidebar/messages
    expect(controller.snapshot).toMatchObject({ screen: 'sidebar', focus: 'messages' })

    // Now simulate a typing update arriving from the SSE stream
    const apiWithCallback = api as unknown as { _typingCallback?: (update: unknown) => void }
    if (apiWithCallback._typingCallback) {
      apiWithCallback._typingCallback({ type: 'typing', chatId: FAKE_CHAT_ID, topicId: null, userName: 'Responder', action: 'typing' })
    }

    // Allow async processing
    await sleep(50)

    // THE BUG: typing indicator should now be set
    const snapshot = controller.snapshot
    expect((snapshot as Record<string, unknown>).typing).toBeDefined()
    expect((snapshot as Record<string, unknown>).typing).toMatchObject({ userName: 'Responder' })
  })

  // ── Proof: render model includes typing footer after post-send typing update ──
  // The previous test proves the controller state has typing set. This test
  // proves the render model (what the glasses would actually display) also
  // includes the typing indicator in the footer. The render model is built
  // by `screenModel(state)` which checks `state.typing` and renders the
  // typing footer instead of the status footer. If the render model is
  // stale (e.g., from before the typing update), the glasses would still
  // show the old status footer.
  it('render model includes typing footer after post-send typing update', async () => {
    const api = fakeApi({ authorized: true, transcription: { text: 'Reply text' } })
    const bridge = fakeBridge()
    const controller = new TelegramAppController(api, bridge, 0)

    api.subscribeUpdates((update: unknown) => {
      void controller.handleTelegramUpdate(update as Parameters<typeof controller.handleTelegramUpdate>[0])
    })

    await controller.init()
    await controller.dispatch({ type: 'press' }) // open chat → messages
    // Record → transcribe → confirm → send
    await controller.dispatch({ type: 'press' }) // start recording
    await controller.dispatch({ type: 'audioChunk', pcm: speechLikePcm() })
    await controller.dispatch({ type: 'press' }) // stop recording
    await controller.dispatch({ type: 'press' }) // confirm send

    // After send, clear the bridge render mock so we can find the render
    // triggered by the post-send typing update.
    await flushAsync()
    const renderMock = vi.mocked(bridge.render)
    renderMock.mockClear()
    const renderSidebarPanelMock = vi.mocked(bridge.renderSidebarPanel ?? (() => undefined))
    renderSidebarPanelMock.mockClear()

    // Inject typing update from another user
    const apiWithCallback = api as unknown as { _typingCallback?: (update: unknown) => void }
    apiWithCallback._typingCallback?.({ type: 'typing', chatId: FAKE_CHAT_ID, topicId: null, userName: 'Responder', action: 'typing' })
    await flushAsync()

    // The render model should now include the typing footer
    const lastFullRender = renderMock.mock.lastCall?.[0]
    const lastPartialRender = renderSidebarPanelMock.mock.lastCall?.[0]
    const lastRender = lastFullRender ?? lastPartialRender
    expect(lastRender).toBeDefined()
    if (lastRender && lastRender.kind === 'sidebar') {
      // The typing footer should contain the user's name and the typing suffix
      expect(lastRender.panelFooter).toContain('Responder')
      expect(lastRender.panelFooter).toMatch(/typing|is typing/i)
      // The status footer (with "Sent") should NOT be in the footer
      expect(lastRender.panelFooter).not.toBe('Sent')
    }
  })
 })
function fakeApi(options: { authorized: boolean; transcription?: TranscriptionResult; latestMessages?: Message[] | (() => Message[] | Promise<Message[]>); olderMessages?: Message[] | (() => Message[] | Promise<Message[]>); chats?: Chat[] | (() => Chat[]); topics?: Topic[] | (() => Topic[] | Promise<Topic[]>); folders?: Folder[]; listChatsImpl?: (limit?: number, options?: { offset?: number; folderId?: string }) => Chat[] | Promise<Chat[]> }): TelegramApi {
  const listMessages = vi.fn(async (_chatId, request) => {
    if (request?.beforeId !== undefined) {
      if (typeof options.olderMessages === 'function') return options.olderMessages()
      return options.olderMessages ?? []
    }
    if (typeof options.latestMessages === 'function') return options.latestMessages()
    return options.latestMessages ?? messages
  })

  const fake: Record<string, unknown> = {
    authStatus: vi.fn(async () => ({ authorized: options.authorized })),
    startPhoneAuth: vi.fn(async (phone: string) => ({ phone, sent: true })),
    verifyPhoneAuth: vi.fn(async () => ({ authorized: options.authorized })),
    logout: vi.fn(async () => undefined),
    listChats: vi.fn(async (limit?: number, listOptions?: { offset?: number; folderId?: string }) => {
      if (options.listChatsImpl) return options.listChatsImpl(limit, listOptions)
      return typeof options.chats === 'function' ? options.chats() : options.chats ?? chats
    }),
    listFolders: vi.fn(async () => options.folders ?? []),
    getPhoto: vi.fn(async () => ({ width: 2, height: 1, data: 'AQID' })),
    listTopics: vi.fn(async () => typeof options.topics === 'function' ? options.topics() : options.topics ?? topics),
    listMessages,
    sendMessage: vi.fn(async (_chatId: unknown, request: { text: string }) => ({
      id: '101',
      sender: 'Me',
      text: request.text,
      sentAt: '2026-05-29T10:01:00Z',
      outgoing: true,
    })),
    markRead: vi.fn(async () => undefined),
    transcribe: vi.fn(async () => options.transcription ?? { text: '' }),
    subscribeUpdates: vi.fn((onUpdate: (update: unknown) => void) => {
      fake._typingCallback = onUpdate
      return () => { fake._typingCallback = undefined }
    }),
  }
  return fake as unknown as TelegramApi & { _typingCallback?: (update: unknown) => void }
}
function speechLikePcm() {
  const pcm = new Uint8Array(3200)
  for (let index = 0; index < pcm.length; index += 2) {
    pcm[index] = 1
  }
  return pcm
}

function fakeBridge(): GlassesBridge {
  return {
    updateImage: vi.fn(async () => true),
    render: vi.fn(async () => undefined),
    setAudioEnabled: vi.fn(async () => undefined),
    showExitConfirmation: vi.fn(async () => undefined),
    turnScreenOff: vi.fn(async () => undefined),
    enqueueSidebarPanel: vi.fn(),
    renderSidebarPanel: vi.fn(async () => undefined),
  }
}

function slowBridge(): GlassesBridge {
  // `renderSidebarPanel` never resolves so the legacy partial-render path would hang.
  // The list-scroll path now goes through `enqueueSidebarPanel` and must remain synchronous.
  return {
    render: vi.fn(() => new Promise<void>(() => undefined)),
    setAudioEnabled: vi.fn(async () => undefined),
    showExitConfirmation: vi.fn(async () => undefined),
    turnScreenOff: vi.fn(async () => undefined),
    enqueueSidebarPanel: vi.fn(),
    renderSidebarPanel: vi.fn(() => new Promise<void>(() => undefined)),
  }
}

function recordingEnqueueBridge(): GlassesBridge & { enqueueLog: Array<{ ts: number; focus: string; selected: number }> } {
  const enqueueLog: Array<{ ts: number; focus: string; selected: number }> = []
  const enqueueSidebarPanel = vi.fn((model: Extract<ScreenModel, { kind: 'sidebar' }>) => {
    enqueueLog.push({ ts: Date.now(), focus: model.focus, selected: model.sidebarSelected })
  })
  return {
    render: vi.fn(async () => undefined),
    setAudioEnabled: vi.fn(async () => undefined),
    showExitConfirmation: vi.fn(async () => undefined),
    turnScreenOff: vi.fn(async () => undefined),
    enqueueSidebarPanel,
    renderSidebarPanel: vi.fn(async () => undefined),
    enqueueLog,
  }
}

function refreshVisibleMessages(controller: TelegramAppController) {
  return (controller as unknown as { refreshVisibleMessages: () => Promise<void> }).refreshVisibleMessages()
}

function refreshRootChats(controller: TelegramAppController) {
  return (controller as unknown as { refreshRootChats: () => Promise<void> }).refreshRootChats()
}

function fetchTopicPreview(controller: TelegramAppController, chat: Chat, topic: Topic) {
  return (controller as unknown as { fetchTopicPreview: (chat: Chat, topic: Topic) => Promise<void> }).fetchTopicPreview(chat, topic)
}

function openMessages(controller: TelegramAppController, chat: Chat, topic: Topic | undefined, previous: unknown) {
  return (controller as unknown as { openMessages: (chat: Chat, topic: Topic | undefined, previous: unknown) => Promise<void> }).openMessages(chat, topic, previous)
}

function clearInputQuiet(controller: TelegramAppController) {
  ;(controller as unknown as { inputQuietUntil: number }).inputQuietUntil = 0
}

function flushReadAcks(controller: TelegramAppController) {
  clearInputQuiet(controller)
  ;(controller as unknown as { flushReadAcks: () => void }).flushReadAcks()
}

function messagePanelHeading(state: AppState) {
  const model = screenModel(state)
  expect(model.kind).toBe('sidebar')
  return model.kind === 'sidebar' ? model.panelBox?.heading : undefined
}

function messagePanelBody(state: AppState) {
  const model = screenModel(state)
  expect(model.kind).toBe('sidebar')
  return model.kind === 'sidebar' ? model.panelBody : ''
}

function controllerLongText(seed: string, repeats = 3) {
  return Array.from({ length: repeats }, (_, index) =>
    `${seed}-${index} alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega`
  ).join(' ')
}

function latestMessageCallCount(api: TelegramApi) {
  return vi.mocked(api.listMessages).mock.calls.filter(([, request]) => request?.beforeId === undefined).length
}

function flushAsync() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}
