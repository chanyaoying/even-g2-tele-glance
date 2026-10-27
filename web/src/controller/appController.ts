import { MAX_RECORDING_BYTES, pcmChunksToWav } from '../audio/wav'
import type { TelegramApi } from '../api'
import type { Chat, Folder, Id, Message, TelegramUpdate, TelegramTypingUpdate, Topic } from '../types'
import { getLocale } from '../locales'
import type { AppInput, AppState, RecoverableState, ScreenModel } from './model'
import { messageScrollUnitCount, nextMessageScrollOffset, screenModel } from './model'
import { isTeleGlanceFixtureMode, logLifecycleEvent, logRecordingEvent, logStateWork, nowMs } from '../testMode'
import { consumeInjectedAudioChunks } from '../fixtureApi'

export interface GlassesBridge {
  render(model: ScreenModel): Promise<void>
  renderSidebarPanel?(model: Extract<ScreenModel, { kind: 'sidebar' }>): Promise<void>
  /**
   * Fire-and-forget partial-render for chat/topic list scrolls. The bridge coalesces
   * rapid enqueues into a single latest-wins native render so the input handler returns
   * immediately without awaiting `textContainerUpgrade` calls. Implementations that lack
   * partial-render support may fall back to a queued full `render` call.
   */
  enqueueSidebarPanel?(model: Extract<ScreenModel, { kind: 'sidebar' }>): void
  setAudioEnabled(enabled: boolean): Promise<void>
  getLocalStorage?(key: string): Promise<string>
  setLocalStorage?(key: string, value: string): Promise<boolean>
  showExitConfirmation?(): Promise<void>
  turnScreenOff?(): Promise<void>
  dispose?(): void
}

const MESSAGE_PAGE_LIMIT = 8
const OLDER_PREFETCH_LOW_WATER = 4
const CHAT_LIST_LIMIT = 20
// When the selection gets this close to the end of the loaded chats, fetch the next page.
const CHAT_LOAD_MORE_THRESHOLD = 3
const LOADING_OLDER_STATUS = 'Loading older messages...'
const RENDER_DEFER_MS = 0
const RENDER_COOLDOWN_MS = 60
const INPUT_QUIET_MS = 900
const TOPIC_PREVIEW_IDLE_MS = 200
// How long after a full `bridge.render()` we treat a list click as
// post-firmware-reset. The G2 firmware (and the simulator) reset the
// post-firmware-reset. The G2 firmware (and the simulator) reset the
// tracked list-selection index to 0 on every full page rebuild, and the
// next click event reports the post-reset index. Inside this window we
// trust the controller's state instead of the firmware's payload.
const DEFAULT_RUNTIME_CONFIG: ControllerRuntimeConfig = {
  messagePressDelayMs: 260,
  messagePollMs: 3000,
  chatPollMs: 5000,
  recordingMinDurationMs: 900,
  language: 'en',
  swipeToPressDebounceMs: 200,
  selectionOnlyPressDelayMs: 400,
  firmwareResetWindowMs: 250,
}

export type ControllerRuntimeConfig = {
  messagePressDelayMs: number
  messagePollMs: number
  chatPollMs: number
  recordingMinDurationMs: number
  language: string
  swipeToPressDebounceMs: number
  selectionOnlyPressDelayMs: number
  firmwareResetWindowMs: number
}

type StateListener = (state: AppState) => void


export class TelegramAppController {
  private state: AppState = { screen: 'loading', message: 'Starting...' }
  private runtimeConfig: ControllerRuntimeConfig
  private listeners = new Set<StateListener>()
  private messagePoll: ReturnType<typeof setInterval> | undefined
  private chatPoll: ReturnType<typeof setInterval> | undefined
  private pendingMessagePress: ReturnType<typeof setTimeout> | undefined
  private lastMessagePressAt = 0
  private chatFingerprints = new Map<string, string>()
  private olderPrefetch:
    | {
      key: string
      cursor: string
      promise: Promise<boolean>
    }
    | undefined
  private rootRefreshInFlight = false
  // Telegram chat folders. `activeFolderId === undefined` means "All chats".
  private folders: Folder[] = []
  private activeFolderId: Id | undefined
  private chatsHasMore = false
  private loadingMoreChats = false
  private folderSwitchId = 0
  private folderChatsCache = new Map<string, { chats: Chat[]; hasMore: boolean }>()
  private messageRefreshInFlight = false
  private topicPreviewDebounce: ReturnType<typeof setTimeout> | undefined
  private deferredRootRefreshTimer: ReturnType<typeof setTimeout> | undefined
  private deferredMessageRefreshTimer: ReturnType<typeof setTimeout> | undefined
  // `messageCache` is the single source of truth for the latest messages of a chat/topic.
  // It is populated by `prefetchVisibleChats` on startup, by `prefetchTopics`/`prefetchMessages`
  // on demand, and by background refreshes. The legacy `chatPreviewCache`/`topicPreviewCache`
  // are kept for backwards compatibility (and for cache-write observability) but reads always
  // fall through to `messageCache` so the startup prefetch is reused for previews.
  private messageCache = new Map<string, { messages: Message[]; cursor?: Id }>()
  private topicPreviewCache = this.messageCache
  private topicPreviewInFlight = new Set<string>()
  private chatPreviewDebounce: ReturnType<typeof setTimeout> | undefined
  private chatPreviewInFlight = new Set<string>()
  private topicsCache = new Map<string, Topic[]>()
  private topicsPrefetchInFlight = new Map<string, Promise<Topic[]>>()
  private messagePrefetchInFlight = new Map<string, Promise<Message[]>>()
  private readAckMaxIds = new Map<string, Id>()
  private pendingReadAcks = new Map<string, { chat: Chat; topic?: Topic; maxId: Id }>()
  private readAckFlushTimer: ReturnType<typeof setTimeout> | undefined
  private startupPrefetchTimer: ReturnType<typeof setTimeout> | undefined
  private selectionOnlyPressReadyAt = 0
  private lastSelectIndexPressAt = 0
  // Wall-clock timestamp of the most recent swipe (up or down). Used to suppress
  // the chat/topic-list auto-press path for a short window after a scroll, so the
  // native list-selection-only events that follow a swipe do not auto-open a thread.
  private lastSwipeAt = 0
  // Whether the most recent native render sent a visible `panelBox` container to the
  // glasses. The partial-render path only updates `panelBox` content, not its
  // position/size/border, so a box→no-box transition must trigger a full rebuild to
  // hide the previously-rendered container.
  private lastRenderedHasPanelBox = false
  // Snapshot of the most recent sidebar page rendered on the glasses. Partial
  // rendering is only valid while focus stays on the same input surface because
  // TextContainerUpgrade cannot change event-capture flags.
  private lastRenderedListItems: readonly string[] | undefined
  // Timestamp of the most recent full `bridge.render()` call. The G2 firmware
  // (and the simulator) reset their tracked list-selection index to 0 on
  // every full page rebuild. A click arriving within a few seconds of a
  // full rebuild is therefore suspect — its `currentSelectItemIndex`
  // payload reflects the post-reset firmware state, not the user's tap.
  // We use this to disambiguate the firmware-reset desync from a legitimate
  // "user tapped a different row" scenario. See
  // `docs/SDK_BUG_NATIVE_LIST_SELECTION.md` for the SDK-level analysis.
  private renderInFlight = false
  // see the SDK bug note above
  private lastFullRenderAt = 0
  private pendingRenderState: AppState | undefined
  private renderTimer: ReturnType<typeof setTimeout> | undefined
  private notifyTimer: ReturnType<typeof setTimeout> | undefined
  private notifyPending = false
  private openRequestId = 0
  private inputQuietUntil = 0
  private typingTimer: ReturnType<typeof setTimeout> | undefined
  constructor(
    private readonly api: TelegramApi,
    private readonly bridge: GlassesBridge,
    options: Partial<ControllerRuntimeConfig> | number = {},
    private readonly onTelegramSession?: (session: string) => void,
    private readonly hasTelegramCredentials: () => boolean = () => true,
  ) {
    this.runtimeConfig = typeof options === 'number'
      ? { ...DEFAULT_RUNTIME_CONFIG, messagePressDelayMs: options }
      : { ...DEFAULT_RUNTIME_CONFIG, ...options }
  }

  get snapshot(): AppState {
    return this.state
  }

  subscribe(listener: StateListener) {
    this.listeners.add(listener)
    listener(this.state)
    return () => {
      this.listeners.delete(listener)
    }
  }

  updateRuntimeConfig(options: Partial<ControllerRuntimeConfig>) {
    const previousMessagePollMs = this.runtimeConfig.messagePollMs
    const previousChatPollMs = this.runtimeConfig.chatPollMs
    this.runtimeConfig = { ...this.runtimeConfig, ...options }
    if (this.messagePoll && previousMessagePollMs !== this.runtimeConfig.messagePollMs) {
      this.stopMessagePolling()
      this.syncMessagePolling()
    }
    if (this.chatPoll && previousChatPollMs !== this.runtimeConfig.chatPollMs) {
      this.stopChatPolling()
      this.syncChatPolling()
    }
  }

  /** Rebuild the current glasses screen with the latest locale / state. */
  rebuildGlasses() {
    this.enqueueRender(this.state)
  }

  dispose() {
    this.openRequestId += 1
    this.stopMessagePolling()
    this.stopChatPolling()
    for (const timer of [
      this.pendingMessagePress,
      this.topicPreviewDebounce,
      this.deferredRootRefreshTimer,
      this.deferredMessageRefreshTimer,
      this.chatPreviewDebounce,
      this.readAckFlushTimer,
      this.startupPrefetchTimer,
      this.renderTimer,
    ]) {
      if (timer) clearTimeout(timer)
    }
    this.deferredRootRefreshTimer = undefined
    this.deferredMessageRefreshTimer = undefined
    this.chatPreviewDebounce = undefined
    this.readAckFlushTimer = undefined
    this.startupPrefetchTimer = undefined
    this.renderTimer = undefined
    this.notifyTimer = undefined
    this.typingTimer = undefined
    this.pendingRenderState = undefined
    this.listeners.clear()
  }

  async sendTextFromPhone(text: string) {
    const state = this.state
    const thread = activeThreadState(state)
    if (!thread) throw new Error('Open a chat or topic before sending.')
    const trimmed = text.trim()
    if (!trimmed) return
    const ctx = sidebarContext(state)
    await this.run(async () => {
      const sent = await this.api.sendMessage(thread.chat.id, {
        text: trimmed,
        topicId: topicThreadId(thread.topic),
      })
      const refreshed = await this.refreshLatestMessages(thread).catch(() => [])
      const messages = refreshed.some((message) => String(message.id) === String(sent.id))
        ? refreshed
        : normalizeMessagePage([...refreshed, sent])
      await this.setState({
        screen: 'sidebar', focus: 'messages',
        chats: ctx.chats, selectedChatIndex: ctx.selectedChatIndex,
        chat: thread.chat,
        topic: thread.topic,
        messages,
        cursor: oldestMessageId(messages),
        back: thread.back,
        status: 'Sent',
        scrollOffset: 0,
        newerPages: [],
        isNewestPage: true,
      })
    }, thread.back)
  }

  async handleTelegramUpdate(update: TelegramUpdate | TelegramTypingUpdate) {
    if (update.type === 'typing') {
      await this.handleTelegramTypingUpdate(update)
      return
    }
    if (this.isInputQuiet()) {
      this.deferTelegramUpdate(update)
      return
    }
    const state = this.state
    if (state.screen === 'sidebar' && state.focus === 'chats' || state.screen === 'asleep' || state.screen === 'newMessage') {
      await this.refreshRootChats()
      return
    }
    if (state.screen === 'sidebar' && state.focus === 'messages' && updateMatchesThread(update, state)) {
      await this.refreshVisibleMessages()
    }
  }

  async handleTelegramTypingUpdate(update: TelegramTypingUpdate) {
    const state = this.state
    // Only show typing indicator when viewing messages. Typing updates are
    // lightweight — no reason to defer them behind the input quiet window.
    if (state.screen !== 'sidebar' || state.focus !== 'messages') return
    if (!updateMatchesThread(update, state)) return
    if (update.action === 'typing' && update.userName) {
      this.state = { ...state, typing: { userName: update.userName, expiresAt: Date.now() + 5000 } }
      this.enqueueNotify()
      this.startTypingTimer()
      this.enqueueRender(this.state)
      return
    }
    if (update.action === 'cancel') {
      this.state = { ...state, typing: null }
      this.enqueueNotify()
      this.cancelTypingTimer()
      this.enqueueRender(this.state)
      return
    }
  }

  private startTypingTimer() {
    this.cancelTypingTimer()
    const state = this.state
    if (state.screen !== 'sidebar' || state.focus !== 'messages' || !state.typing) return
    const delay = Math.max(0, state.typing.expiresAt - Date.now())
    this.typingTimer = setTimeout(() => {
      if (this.state.screen === 'sidebar' && this.state.focus === 'messages' && this.state.typing) {
        this.state = { ...this.state, typing: null }
        this.enqueueRender(this.state)
      }
    }, delay)
    const maybeNodeTimeout = this.typingTimer as unknown as { unref?: () => void }
    maybeNodeTimeout.unref?.()
  }

  private cancelTypingTimer() {
    if (this.typingTimer !== undefined) {
      clearTimeout(this.typingTimer)
      this.typingTimer = undefined
    }
  }

  async init() {
    await this.setState({ screen: 'loading', message: 'Checking Telegram session...' })
    await this.run(async () => {
      if (!this.hasTelegramCredentials()) {
        await this.setState({
          screen: 'auth',
          mode: 'needsSetup',
          message: 'Follow the instructions on the Settings page to connect Telegram and the backend server.',
        })
        return
      }
      const status = await this.api.authStatus()
      if (!status.authorized) {
        const hasFrontendCredentials = this.hasTelegramCredentials()
        await this.setState({
          screen: 'auth',
          mode: hasFrontendCredentials ? 'signedOut' : 'needsSetup',
          message: !hasFrontendCredentials || status.configured === false
            ? 'Telegram not connected. Please connect using the instructions in Settings on the phone.'
            : 'Telegram not connected. Enter your phone number in the phone UI to receive a Telegram login code.',
        })
        return
      }
      await this.loadChats()
    })
  }

  async dispatch(input: AppInput) {
    if (input.type !== 'audioChunk') this.noteUserInput()
    // Track swipe timing globally so the chat/topic-list auto-press path can suppress
    // selection-only events that the native list fires immediately after a scroll.
    if (input.type === 'swipeUp' || input.type === 'swipeDown') {
      this.lastSwipeAt = Date.now()
    }
    if (input.type === 'foreground') {
      this.cancelPendingMessagePress()
      if (this.state.screen === 'asleep') {
        await this.bridge.turnScreenOff?.()
        return
      }
      await this.init()
      return
    }

    if (input.type === 'audioChunk') {
      if (this.state.screen === 'sidebarRecording') {
        const recordedBytes = this.state.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
        if (recordedBytes + input.pcm.byteLength > MAX_RECORDING_BYTES) return // keep the upload under the server cap
        this.state = { ...this.state, chunks: [...this.state.chunks, input.pcm] }
        if (isTeleGlanceFixtureMode()) {
          const total = this.state.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
          logRecordingEvent('audioChunk', {
            size: input.pcm.byteLength,
            totalBytes: total,
            chunks: this.state.chunks.length,
            ...(input.injected ? { injected: true } : {}),
          })
        }
      }
      return
    }

    if (this.state.screen === 'sidebarRecording') {
      const injected = consumeInjectedAudioChunks()
      if (injected.length > 0) {
        this.state = { ...this.state, chunks: [...this.state.chunks, ...injected] }
        if (isTeleGlanceFixtureMode()) {
          const total = this.state.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
          logRecordingEvent('audioChunk', { size: injected.reduce((s, c) => s + c.byteLength, 0), totalBytes: total, chunks: this.state.chunks.length, injected: true })
        }
      }
    }

    const state = this.state
    if (state.screen === 'sidebar' && (state.focus === 'chats' || state.focus === 'topics') && input.type === 'selectIndex') {
      const idx = state.focus === 'chats'
        ? this.resolveSelectedChatIndex(input, state.selectedChatIndex, state.chats)
        : this.resolveSelectedTopicIndex(input, state.selectedTopicIndex, state.topics)
      const currentIndex = state.focus === 'chats' ? state.selectedChatIndex : state.selectedTopicIndex
      if (idx === currentIndex && Date.now() >= this.selectionOnlyPressReadyAt) {
        const now = Date.now()
        // Suppress auto-press for a short window after a swipe. Native G2 firmware
        // sometimes emits a list-selection event immediately after a scroll completes
        // (with the new index), and the previous code treated that as a press. The
        // 450ms window covers the firmware's typical post-swipe event burst without
        // noticeably slowing intentional press-after-swipe sequences.
        if (now - this.lastSwipeAt < this.runtimeConfig.swipeToPressDebounceMs) return
        if (now - this.lastSelectIndexPressAt < 400) return
        this.lastSelectIndexPressAt = now
        await this.dispatch({ type: 'press', index: idx, itemName: input.itemName })
        return
      }
    }
    if (state.screen === 'sidebarConfirm' && input.type === 'selectIndex' && input.index === state.selectedIndex) {
      await this.dispatch({ type: 'press', index: input.index })
      return
    }
    switch (state.screen) {
      case 'auth':
        await this.handleAuth(state, input)
        return
      case 'sidebar':
        await this.handleSidebar(state, input)
        return
      case 'folderPicker':
        await this.handleFolderPicker(state, input)
        return
      case 'asleep':
        await this.handleAsleep(state, input)
        return
      case 'newMessage':
        await this.handleNewMessage(state, input)
        return
      case 'sidebarRecording':
        await this.handleSidebarRecording(state, input)
        return
      case 'sidebarConfirm':
        await this.handleSidebarConfirm(state, input)
        return
      case 'sidebarSent':
        await this.handleSidebarSent(state, input)
        return
      case 'error':
        await this.handleError(state, input)
        return
      case 'loading':
      case 'sidebarTranscribing':
      case 'sidebarSending':
        return
    }
  }

  private async handleAuth(state: Extract<AppState, { screen: 'auth' }>, input: AppInput) {
    if (input.type === 'doublePress') {
      // The glasses app can be opened before the user has completed the
      // backend/phone-code setup, in which case the only useful interaction
      // is to leave the app. The reviewer expects double-tap to exit the
      // app from any pre-login screen, so trigger the native exit
      // confirmation on the first double-tap rather than waiting for the
      // user to find a hidden back path.
      await this.bridge.showExitConfirmation?.()
      return
    }
    if (input.type !== 'press') return
    await this.run(async () => {
      if (state.mode === 'needsSetup') {
        await this.setState({
          ...state,
          message: 'Follow the instructions on the Settings page to connect Telegram and the backend server.',
        })
        return
      }
      if (state.mode === 'signedOut') {
        await this.setState({
          ...state,
          message: 'Enter your phone number in the phone UI to receive a Telegram login code.',
        })
        return
      }

      if (state.mode === 'phonePending') return
    }, state)
  }

  async startPhoneLogin(phone: string) {
    const trimmed = phone.trim()
    if (!trimmed) return
    await this.run(async () => {
      if (!this.hasTelegramCredentials()) {
        await this.setState({
          screen: 'auth',
          mode: 'needsSetup',
          message: 'Telegram not connected. Add Telegram API ID/hash in Settings on the phone first.',
        })
        return
      }
      const result = await this.api.startPhoneAuth(trimmed)
      await this.setState({
        screen: 'auth',
        mode: 'phonePending',
        phone: result.phone || trimmed,
        phoneCodeHash: result.phoneCodeHash ?? null,
        message: result.message ?? `Verification code sent to ${result.phone || trimmed}. Enter it on the phone.`,
      })
    }, this.state.screen === 'auth' ? this.state : undefined)
  }

  async verifyPhoneLogin(phone: string, code: string, password?: string) {
    const trimmedPhone = phone.trim()
    const trimmedCode = code.trim()
    if (!trimmedPhone || (!trimmedCode && !password)) return
    const phoneCodeHash = this.state.screen === 'auth' && this.state.mode === 'phonePending' && this.state.phone === trimmedPhone
      ? this.state.phoneCodeHash
      : undefined
    try {
      const status = await this.api.verifyPhoneAuth(trimmedPhone, trimmedCode, phoneCodeHash, password)
      if (status.authorized) {
        if (status.sessionString) this.onTelegramSession?.(status.sessionString)
        await this.loadChats()
        return
      }
      await this.setState({
        screen: 'auth',
        mode: 'phonePending',
        phone: trimmedPhone,
        phoneCodeHash,
        passwordRequired: status.passwordRequired || undefined,
        message: status.message ?? 'Code was not accepted. Check the Telegram code and try again.',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Code was not accepted. Check the Telegram code and try again.'
      const expired = /expired/i.test(message)
      await this.setState({
        screen: 'auth',
        mode: expired ? 'signedOut' : 'phonePending',
        phone: trimmedPhone,
        phoneCodeHash: expired ? null : phoneCodeHash,
        message: expired
          ? `${message}. Send a new login code and use the latest code from Telegram.`
          : message,
      })
      throw error
    }
  }

  private async handleSidebar(
    state: Extract<AppState, { screen: 'sidebar' }>, input: AppInput
  ) {
    switch (state.focus) {
      case 'chats':
        await this.handleSidebarChats(state as Extract<AppState, { screen: 'sidebar'; focus: 'chats' }>, input)
        return
      case 'topics':
        await this.handleSidebarTopics(state as Extract<AppState, { screen: 'sidebar'; focus: 'topics' }>, input)
        return
      case 'messages':
        await this.handleSidebarMessages(state as Extract<AppState, { screen: 'sidebar'; focus: 'messages' }>, input)
        return
    }
  }

  private async handleSidebarChats(
    state: Extract<AppState, { screen: 'sidebar'; focus: 'chats' }>, input: AppInput
  ) {
    if (input.type === 'doublePress') {
      // The dispatch-level filter in `dispatch` has already dropped
      // any idle system `doublePress` (eventSource === 1 inside the
      // cluster window). See `isIdleSystemDoublePress` and AGENTS.md
      // "Idle doublePress events on the G2 / simulator can mimic
      // user input."
      this.cancelChatDebounce()
      if (this.folders.length > 0) {
        // With folders, double-tap opens the folder picker (which also offers Sleep).
        await this.openFolderPicker(state)
        return
      }
      this.rememberChats(state.chats)
      await this.setState({ screen: 'asleep', chats: state.chats, selectedChatIndex: state.selectedChatIndex })
      await this.bridge.turnScreenOff?.()
      if (isTeleGlanceFixtureMode()) logLifecycleEvent('asleep', { input: input.type, selectedChatIndex: state.selectedChatIndex })
      return
    }
    if (input.type === 'swipeUp') {
      this.openRequestId += 1
      this.cancelChatDebounce()
      const newIndex = moveSelection(state.selectedChatIndex, state.chats.length, -1)
      // The chat list is full width with no preview, so moving the selection never fetches messages.
      await this.setStateForListScroll({
        ...state,
        selectedChatIndex: newIndex,
        status: undefined,
        ...emptyChatPreview(),
      })
      return
    }
    if (input.type === 'swipeDown') {
      this.openRequestId += 1
      this.cancelChatDebounce()
      const newIndex = moveSelection(state.selectedChatIndex, state.chats.length, 1)
      // The chat list is full width with no preview, so moving the selection never fetches messages.
      await this.setStateForListScroll({
        ...state,
        selectedChatIndex: newIndex,
        status: undefined,
        ...emptyChatPreview(),
      })
      this.maybeLoadMoreChats(state, newIndex)
      return
    }
    if (input.type === 'selectIndex') {
      const selectedChatIndex = this.resolveSelectedChatIndex(input, state.selectedChatIndex, state.chats)
      if (selectedChatIndex !== state.selectedChatIndex) {
        this.openRequestId += 1
        this.cancelChatDebounce()
      }
      await this.setStateForListScroll({
        ...state,
        selectedChatIndex,
        status: undefined,
        ...emptyChatPreview(),
      })
      this.maybeLoadMoreChats(state, selectedChatIndex)
      return
    }
    if (input.type !== 'press') return

    this.cancelChatDebounce()
    const selectedChatIndex = this.resolveSelectedChatIndex(input, state.selectedChatIndex, state.chats)
    const selectedState = { ...state, selectedChatIndex }
    const chat = selectedState.chats[selectedChatIndex]
    if (!chat) return
    await this.openChat(chat, selectedState)
  }

  private async handleAsleep(state: Extract<AppState, { screen: 'asleep' }>, input: AppInput) {
    if (input.type !== 'doublePress') {
      await this.bridge.turnScreenOff?.()
      if (isTeleGlanceFixtureMode()) logLifecycleEvent('asleep', { input: input.type, selectedChatIndex: state.selectedChatIndex })
      return
    }
    // The dispatch-level filter in `dispatch` has already dropped
    // any idle system `doublePress` (eventSource === 1 inside the
    // cluster window), so reaching this branch means a real user
    // is waking the device. See `isIdleSystemDoublePress` and
    // AGENTS.md "Idle doublePress events on the G2 / simulator can
    // mimic user input."
    if (isTeleGlanceFixtureMode()) logLifecycleEvent('wake', { selectedChatIndex: state.selectedChatIndex })
    await this.setState(this.chatsState(state.chats, state.selectedChatIndex))
  }

  private async handleNewMessage(state: Extract<AppState, { screen: 'newMessage' }>, input: AppInput) {
    if (input.type === 'doublePress') {
      // The dispatch-level filter in `dispatch` has already dropped
      // any idle system `doublePress`. See `isIdleSystemDoublePress`.
      this.rememberChats(state.chats)
      await this.setState({ screen: 'asleep', chats: state.chats, selectedChatIndex: state.selectedChatIndex })
      await this.bridge.turnScreenOff?.()
      return
    }
    if (input.type !== 'press') return
    await this.openMessages(state.chat, state.topic, this.chatsState(state.chats, state.selectedChatIndex))
  }

  private async handleSidebarTopics(
    state: Extract<AppState, { screen: 'sidebar'; focus: 'topics' }>, input: AppInput
  ) {
    if (input.type === 'doublePress') {
      // The dispatch-level filter in `dispatch` has already dropped
      // any idle system `doublePress`. See `isIdleSystemDoublePress`.
      this.cancelTopicDebounce()
      await this.setState(this.chatsState(state.chats, state.selectedChatIndex))
      return
    }
    if (input.type === 'swipeUp' || input.type === 'swipeDown') {
      this.openRequestId += 1
      const delta = input.type === 'swipeUp' ? -1 : 1
      const newIndex = moveSelection(state.selectedTopicIndex, state.topics.length, delta)
      const nextTopic = state.topics[newIndex]
      const cached = nextTopic ? this.getTopicPreviewCached(state.chat, nextTopic) : undefined
      const isFreshSelection = nextTopic && (
        !state.previewTopic
        || String(state.previewTopic.id) !== String(nextTopic.id)
      )
      await this.setStateForListScroll({
        ...state,
        selectedTopicIndex: newIndex,
        ...(cached
          ? {
              previewTopic: nextTopic,
              previewMessages: cached.messages,
              previewCursor: cached.cursor,
              previewScrollOffset: 0,
              previewIsNewestPage: true,
            }
          : isFreshSelection
            ? emptyTopicPreview()
            : {}),
      })
      if (nextTopic && !cached) this.debounceTopicPreviewFetch(state.chat, state.topics, newIndex)
      return
    }
    if (input.type === 'selectIndex') {
      const newIndex = this.resolveSelectedTopicIndex(input, state.selectedTopicIndex, state.topics)
      if (newIndex !== state.selectedTopicIndex) this.openRequestId += 1
      const nextTopic = state.topics[newIndex]
      const cached = nextTopic ? this.getTopicPreviewCached(state.chat, nextTopic) : undefined
      const isFreshSelection = nextTopic && (
        !state.previewTopic
        || String(state.previewTopic.id) !== String(nextTopic.id)
      )
      await this.setStateForListScroll({
        ...state,
        selectedTopicIndex: newIndex,
        ...(cached
          ? {
              previewTopic: nextTopic,
              previewMessages: cached.messages,
              previewCursor: cached.cursor,
              previewScrollOffset: 0,
              previewIsNewestPage: true,
            }
          : isFreshSelection
            ? emptyTopicPreview()
            : {}),
      })
      if (nextTopic && !cached) this.debounceTopicPreviewFetch(state.chat, state.topics, newIndex)
      return
    }
    if (input.type !== 'press') return

    this.cancelTopicDebounce()
    const selectedIndex = this.resolveSelectedTopicIndex(input, state.selectedTopicIndex, state.topics)
    const topic = state.topics[selectedIndex]
    if (!topic) return
    const selectedState: Extract<AppState, { screen: 'sidebar'; focus: 'topics' }> = { ...state, selectedTopicIndex: selectedIndex }

    // Always open the full topic message thread. The previous fast-path
    // (using `previewMessages` as the initial thread) was a perceived
    // performance optimization that turned out to be a footgun on
    // real G2 hardware: the user lands in `sidebar.messages` with 1-2
    // preview messages, cannot scroll meaningfully, and the footer
    // says "Click record" even though the thread is incomplete. Always
    // pay the ~200ms cost of `openMessages` so the thread we show is
    // the real one, and the swipe-scroll / record / back affordances
    // in the footer all work as advertised. See
    // `docs/STRUCTURAL_INVARIANTS.md` for the screen transition.
    await this.openMessages(selectedState.chat, topic, selectedState)
  }

  private async handleSidebarMessages(
    state: Extract<AppState, { screen: 'sidebar'; focus: 'messages' }>, input: AppInput
  ) {
    if (input.type === 'doublePress') {
      // The dispatch-level filter in `dispatch` has already dropped
      // any idle system `doublePress`. See `isIdleSystemDoublePress`.
      this.openRequestId += 1
      this.cancelPendingMessagePress()
      await this.goBackFromMessages(state)
      return
    }
    if (state.messages.length === 0 && state.status?.startsWith('Loading')) return
    if (input.type === 'swipeUp') {
      this.cancelPendingMessagePress()
      await this.loadOlderMessages(state)
      return
    }
    if (input.type === 'swipeDown') {
      this.cancelPendingMessagePress()
      await this.loadNewerMessages(state)
      return
    }
    if (input.type !== 'press') return

    await this.scheduleMessagePress(state)
  }
  private debounceTopicPreviewFetch(chat: Chat, topics: Topic[], selectedTopicIndex: number) {
    const topic = topics[selectedTopicIndex]
    if (!topic) return
    this.cancelTopicDebounce()
    this.topicPreviewDebounce = setTimeout(() => {
      this.topicPreviewDebounce = undefined
      if (this.isInputQuiet()) {
        this.debounceTopicPreviewFetch(chat, topics, selectedTopicIndex)
        return
      }
      void this.fetchTopicPreview(chat, topic).catch(() => undefined)
    }, this.topicPreviewDelayMs())
    const maybeNodeTimeout = this.topicPreviewDebounce as unknown as { unref?: () => void }
    maybeNodeTimeout.unref?.()
  }

  private cancelTopicDebounce() {
    if (!this.topicPreviewDebounce) return
    clearTimeout(this.topicPreviewDebounce)
    this.topicPreviewDebounce = undefined
  }

  private async fetchTopicPreview(chat: Chat, topic: Topic) {
    const cacheKey = messageThreadKey({ chat, topic })
    const cached = this.topicPreviewCache.get(cacheKey)
    if (cached) {
      const state = this.state
      if (state.screen !== 'sidebar' || state.focus !== 'topics') return
      if (!topicMatchesSelection(state, topic)) return
      await this.setStateWithPartialRender({
        ...state,
        previewTopic: topic,
        previewMessages: cached.messages,
        previewCursor: cached.cursor,
        previewScrollOffset: 0,
        previewIsNewestPage: true,
      }, chat, topic, cached.messages)
      return
    }

    if (this.topicPreviewInFlight.has(cacheKey)) return
    this.topicPreviewInFlight.add(cacheKey)
    try {
      const messages = await this.api.listMessages(chat.id, {
        topicId: topic.id,
        limit: MESSAGE_PAGE_LIMIT,
      })
      const normalized = normalizeMessagePage(messages)
      this.topicPreviewCache.set(cacheKey, { messages: normalized, cursor: oldestMessageId(normalized) })
      const state = this.state
      if (state.screen !== 'sidebar' || state.focus !== 'topics') return
      if (!topicMatchesSelection(state, topic)) return
      await this.setStateWithPartialRender({
        ...state,
        previewTopic: topic,
        previewMessages: normalized,
        previewCursor: oldestMessageId(normalized),
        previewScrollOffset: 0,
        previewIsNewestPage: true,
      }, chat, topic, normalized)
    } finally {
      this.topicPreviewInFlight.delete(cacheKey)
    }
  }

  private cancelChatDebounce() {
    if (!this.chatPreviewDebounce) return
    clearTimeout(this.chatPreviewDebounce)
    this.chatPreviewDebounce = undefined
  }

  /**
   * Synchronous cache lookup for the topic preview path.
   */
  private getTopicPreviewCached(chat: Chat, topic: Topic) {
    return this.topicPreviewCache.get(messageThreadKey({ chat, topic }))
  }

  private async scheduleMessagePress(
    state: Extract<AppState, { screen: 'sidebar'; focus: 'messages' }> | Extract<AppState, { screen: 'sidebarSent' }>
  ) {
    this.cancelPendingMessagePress()
    const ctx = sidebarContext(state)
    if (this.runtimeConfig.messagePressDelayMs <= 0) {
      await this.startRecordingFromMessages(state as Extract<AppState, { screen: 'sidebar'; focus: 'messages' }>, ctx)
      return
    }
    const timeout = setTimeout(() => {
      this.pendingMessagePress = undefined
      const current = this.state
      if (current.screen !== 'sidebar' || current.focus !== 'messages') return
      const currentCtx = sidebarContext(current)
      void this.startRecordingFromMessages(current as Extract<AppState, { screen: 'sidebar'; focus: 'messages' }>, currentCtx)
    }, this.runtimeConfig.messagePressDelayMs)
    const maybeNodeTimeout = timeout as unknown as { unref?: () => void }
    maybeNodeTimeout.unref?.()
    this.pendingMessagePress = timeout
  }

  private cancelPendingMessagePress() {
    if (!this.pendingMessagePress) return
    clearTimeout(this.pendingMessagePress)
    this.pendingMessagePress = undefined
  }

  private async startRecordingFromMessages(
    state: Extract<AppState, { screen: 'sidebar'; focus: 'messages' }>,
    ctx: { chats: Chat[]; selectedChatIndex: number },
  ) {
    this.lastMessagePressAt = Date.now()
    await this.setState({
      screen: 'sidebarRecording', focus: 'messages',
      chats: ctx.chats, selectedChatIndex: ctx.selectedChatIndex,
      chat: state.chat,
      topic: state.topic,
      messages: state.messages,
      back: state.back,
      status: state.status,
      newerPages: state.newerPages,
      isNewestPage: state.isNewestPage,
      scrollOffset: state.scrollOffset,
      typing: state.typing,
      chunks: [],
      startedAt: this.lastMessagePressAt,
    })
    void this.bridge.setAudioEnabled(true).catch(() => undefined)
    if (isTeleGlanceFixtureMode()) logRecordingEvent('start', { chatId: state.chat.id, topicId: state.topic?.id ?? null })
  }

  private async handleSidebarRecording(
    state: Extract<AppState, { screen: 'sidebarRecording' }>, input: AppInput
  ) {
    if (input.type === 'doublePress') {
      // The dispatch-level filter in `dispatch` has already dropped
      // any idle system `doublePress`. See `isIdleSystemDoublePress`.
      void this.bridge.setAudioEnabled(false).catch(() => undefined)
      if (Date.now() - state.startedAt < this.runtimeConfig.recordingMinDurationMs) {
        await this.setState({
          screen: 'sidebar', focus: 'messages',
          chats: state.chats, selectedChatIndex: state.selectedChatIndex,
          chat: state.chat,
          topic: state.topic,
          messages: state.messages,
          back: state.back,
          status: state.status,
          newerPages: state.newerPages,
          isNewestPage: state.isNewestPage,
          scrollOffset: state.scrollOffset,
          typing: state.typing,
        })
        return
      }
      await this.setState({
        screen: 'sidebar', focus: 'messages',
        chats: state.chats, selectedChatIndex: state.selectedChatIndex,
        chat: state.chat,
        topic: state.topic,
        messages: state.messages,
        back: state.back,
        status: state.status,
        newerPages: state.newerPages,
        isNewestPage: state.isNewestPage,
        scrollOffset: state.scrollOffset,
        typing: state.typing,
      })
      return
    }
    if (input.type !== 'press') return
    await this.setState({
      screen: 'sidebarTranscribing', focus: 'messages',
      chats: state.chats, selectedChatIndex: state.selectedChatIndex,
      chat: state.chat,
      topic: state.topic,
      messages: state.messages,
      back: state.back,
      status: state.status,
      newerPages: state.newerPages,
      isNewestPage: state.isNewestPage,
      scrollOffset: state.scrollOffset,
      typing: state.typing,
    })
    if (isTeleGlanceFixtureMode()) {
      const total = state.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
      logRecordingEvent('stop', { totalBytes: total, chunks: state.chunks.length })
      logRecordingEvent('transcribe.start', { chunks: state.chunks.length })
    }
    void this.bridge.setAudioEnabled(false).catch(() => undefined)
    await this.run(async () => {
      if (!hasRecordableAudio(state.chunks)) {
        if (isTeleGlanceFixtureMode()) logRecordingEvent('transcribe.end', { transcript: '', rejected: true })
        await this.setState({
          screen: 'sidebar', focus: 'messages',
          chats: state.chats, selectedChatIndex: state.selectedChatIndex,
          chat: state.chat,
          topic: state.topic,
          messages: state.messages,
          back: state.back,
          status: state.status,
          newerPages: state.newerPages,
          isNewestPage: state.isNewestPage,
          scrollOffset: state.scrollOffset,
          typing: state.typing,
        })
        return
      }
      const result = await this.api.transcribe(pcmChunksToWav(state.chunks), this.runtimeConfig.language)
      const transcript = result.text.trim()
      if (isTeleGlanceFixtureMode()) logRecordingEvent('transcribe.end', { transcript: result.text.trim() })
      if (transcript.length === 0) {
        await this.setState({
          screen: 'sidebar', focus: 'messages',
          chats: state.chats, selectedChatIndex: state.selectedChatIndex,
          chat: state.chat,
          topic: state.topic,
          messages: state.messages,
          back: state.back,
          status: state.status,
          newerPages: state.newerPages,
          isNewestPage: state.isNewestPage,
          scrollOffset: state.scrollOffset,
          typing: state.typing,
        })
        return
      }
      await this.setState({
        screen: 'sidebarConfirm', focus: 'messages',
        chats: state.chats, selectedChatIndex: state.selectedChatIndex,
        chat: state.chat,
        topic: state.topic,
        messages: state.messages,
        transcript,
        selectedIndex: 0,
        back: state.back,
        status: state.status,
        newerPages: state.newerPages,
        isNewestPage: state.isNewestPage,
        scrollOffset: state.scrollOffset,
        typing: state.typing,
      })
    })
  }

  private async handleSidebarConfirm(
    state: Extract<AppState, { screen: 'sidebarConfirm' }>, input: AppInput
  ) {
    if (input.type === 'swipeUp' || input.type === 'swipeDown') {
      await this.setState({ ...state, selectedIndex: state.selectedIndex === 0 ? 1 : 0 })
      return
    }
    if (input.type === 'doublePress') {
      // The dispatch-level filter in `dispatch` has already dropped
      // any idle system `doublePress`. See `isIdleSystemDoublePress`.
      await this.setState({
        screen: 'sidebar', focus: 'messages',
        chats: state.chats, selectedChatIndex: state.selectedChatIndex,
        chat: state.chat, topic: state.topic, messages: state.messages,
        back: state.back, status: state.status,
        newerPages: state.newerPages, isNewestPage: state.isNewestPage, scrollOffset: state.scrollOffset,
        typing: state.typing,
      })
      return
    }
    if (input.type !== 'press') return

    if (state.selectedIndex === 1) {
      await this.setState({
        screen: 'sidebar', focus: 'messages',
        chats: state.chats, selectedChatIndex: state.selectedChatIndex,
        chat: state.chat, topic: state.topic, messages: state.messages,
        back: state.back, status: state.status,
        newerPages: state.newerPages, isNewestPage: state.isNewestPage, scrollOffset: state.scrollOffset,
        typing: state.typing,
      })
      return
    }

    await this.setState({
      screen: 'sidebarSending', focus: 'messages',
      chats: state.chats, selectedChatIndex: state.selectedChatIndex,
      chat: state.chat,
      topic: state.topic,
      messages: state.messages,
      transcript: state.transcript,
      back: state.back,
      status: state.status,
      newerPages: state.newerPages,
      isNewestPage: state.isNewestPage,
      scrollOffset: state.scrollOffset,
      typing: state.typing,
    })
    if (isTeleGlanceFixtureMode()) logRecordingEvent('confirm', { selected: 'send', transcript: state.transcript })
    if (isTeleGlanceFixtureMode()) logRecordingEvent('send.start', { chatId: state.chat.id, topicId: state.topic?.id ?? null, transcript: state.transcript })
    await this.run(async () => {
      const sent = await this.api.sendMessage(state.chat.id, {
        text: state.transcript,
        topicId: topicThreadId(state.topic),
      })
      const refreshed = await this.refreshLatestMessages(state).catch(() => [])
      const messages = refreshed.some((message) => String(message.id) === String(sent.id))
        ? refreshed
        : normalizeMessagePage([...refreshed, sent])
      await this.setState({
        screen: 'sidebar', focus: 'messages',
        chats: state.chats, selectedChatIndex: state.selectedChatIndex,
        chat: state.chat,
        topic: state.topic,
        messages,
        cursor: oldestMessageId(messages),
        back: state.back,
        status: 'Sent',
        newerPages: [],
        isNewestPage: true,
        scrollOffset: 0,
        typing: state.typing ?? null,
      })
      void this.refreshAfterSend(state, sent)
    }, state)
  }

  private async handleSidebarSent(
    state: Extract<AppState, { screen: 'sidebarSent' }>, input: AppInput
  ) {
    if (input.type === 'doublePress') {
      // The dispatch-level filter in `dispatch` has already dropped
      // any idle system `doublePress`. See `isIdleSystemDoublePress`.
      await this.setState(this.chatsState(state.chats, state.selectedChatIndex))
      return
    }
    if (input.type === 'press') {
      const messages = await this.refreshLatestMessages(state)
      await this.setState({
        screen: 'sidebar', focus: 'messages',
        chats: state.chats, selectedChatIndex: state.selectedChatIndex,
        chat: state.chat, topic: state.topic,
        messages, cursor: oldestMessageId(messages),
        back: state.back, newerPages: [], isNewestPage: true, scrollOffset: 0,
        typing: state.typing,
      })
    }
  }

  private async handleError(state: Extract<AppState, { screen: 'error' }>, input: AppInput) {
    if (input.type === 'doublePress' && state.previous) {
      // The dispatch-level filter in `dispatch` has already dropped
      // any idle system `doublePress`. See `isIdleSystemDoublePress`.
      await this.setState(state.previous)
      return
    }
    if (input.type === 'press') {
      if (state.previous) await this.setState(state.previous)
      await this.init()
    }
  }

  private async loadChats(previous?: RecoverableState) {
    await this.run(async () => {
      const [chats, folders] = await Promise.all([
        this.api.listChats(CHAT_LIST_LIMIT),
        // Folders are optional: a failure here must never block the chat list.
        this.api.listFolders().catch(() => [] as Folder[]),
      ])
      this.folders = folders
      this.activeFolderId = undefined
      this.chatsHasMore = chats.length >= CHAT_LIST_LIMIT
      this.loadingMoreChats = false
      this.folderChatsCache.clear()
      this.folderSwitchId += 1
      this.rememberChats(chats)
      await this.setState(this.chatsState(chats, 0))
      // The chat list has no preview panel, so nothing is fetched until a chat is opened.
    }, previous)
  }

  /** Chat-list state for the active folder; every rebuild goes through here so the title keeps its folder label. */
  private chatsState(
    chats: Chat[],
    selectedChatIndex: number,
    extra: { loadingMore?: boolean; status?: string } = {},
  ): Extract<AppState, { screen: 'sidebar'; focus: 'chats' }> {
    return { screen: 'sidebar', focus: 'chats', chats, selectedChatIndex, folderLabel: this.folderLabel(), ...extra }
  }

  private folderKey(folderId: Id | undefined) {
    return folderId === undefined ? 'all' : String(folderId)
  }

  private folderPosition(): number {
    if (this.activeFolderId === undefined) return 0
    const index = this.folders.findIndex((folder) => String(folder.id) === String(this.activeFolderId))
    return index >= 0 ? index + 1 : 0
  }

  private folderLabel(): string | undefined {
    if (this.folders.length === 0) return undefined
    const position = this.folderPosition()
    const name = position === 0 ? getLocale().folderAllChats : this.folders[position - 1].title
    return `${name} ${position + 1}/${this.folders.length + 1}`
  }

  private maybeLoadMoreChats(state: Extract<AppState, { screen: 'sidebar'; focus: 'chats' }>, selectedIndex: number) {
    if (!this.chatsHasMore || this.loadingMoreChats) return
    if (selectedIndex < state.chats.length - CHAT_LOAD_MORE_THRESHOLD) return
    void this.loadMoreChats().catch(() => undefined)
  }

  private async loadMoreChats() {
    const folderId = this.activeFolderId
    const switchId = this.folderSwitchId
    const start = this.state
    if (start.screen !== 'sidebar' || start.focus !== 'chats') return
    this.loadingMoreChats = true
    this.setStateForListScroll({ ...start, loadingMore: true })
    try {
      const page = await this.api.listChats(CHAT_LIST_LIMIT, { offset: start.chats.length, folderId })
      if (switchId !== this.folderSwitchId) return
      this.chatsHasMore = page.length >= CHAT_LIST_LIMIT
      const current = this.state
      const base = current.screen === 'sidebar' && current.focus === 'chats' ? current.chats : start.chats
      const known = new Set(base.map((chat) => String(chat.id)))
      const chats = [...base, ...page.filter((chat) => !known.has(String(chat.id)))]
      this.folderChatsCache.set(this.folderKey(folderId), { chats, hasMore: this.chatsHasMore })
      if (current.screen === 'sidebar' && current.focus === 'chats') {
        this.setStateForListScroll({ ...current, chats, loadingMore: false })
      }
    } catch {
      // Leave the list as is; the next swipe near the end retries.
    } finally {
      this.loadingMoreChats = false
      const current = this.state
      if (switchId === this.folderSwitchId && current.screen === 'sidebar' && current.focus === 'chats' && current.loadingMore) {
        this.setStateForListScroll({ ...current, loadingMore: false })
      }
    }
  }

  private async openFolderPicker(state: Extract<AppState, { screen: 'sidebar'; focus: 'chats' }>) {
    const l = getLocale()
    await this.setState({
      screen: 'folderPicker',
      chats: state.chats,
      selectedChatIndex: state.selectedChatIndex,
      folderLabel: state.folderLabel,
      options: [l.folderAllChats, ...this.folders.map((folder) => folder.title), l.folderSleep],
      selectedIndex: this.folderPosition(),
    })
  }

  private async handleFolderPicker(state: Extract<AppState, { screen: 'folderPicker' }>, input: AppInput) {
    if (input.type === 'doublePress') {
      await this.setState(this.chatsState(state.chats, state.selectedChatIndex))
      return
    }
    if (input.type === 'swipeUp' || input.type === 'swipeDown') {
      const selectedIndex = moveSelection(state.selectedIndex, state.options.length, input.type === 'swipeUp' ? -1 : 1)
      this.setStateForListScroll({ ...state, selectedIndex })
      return
    }
    if (input.type === 'selectIndex') {
      if (input.index !== undefined && input.index >= 0 && input.index < state.options.length && input.index !== state.selectedIndex) {
        this.setStateForListScroll({ ...state, selectedIndex: input.index })
      }
      return
    }
    if (input.type !== 'press') return
    const index = input.index !== undefined && input.index >= 0 && input.index < state.options.length
      ? input.index
      : state.selectedIndex
    if (index === state.options.length - 1) {
      this.rememberChats(state.chats)
      await this.setState({ screen: 'asleep', chats: state.chats, selectedChatIndex: state.selectedChatIndex })
      await this.bridge.turnScreenOff?.()
      if (isTeleGlanceFixtureMode()) logLifecycleEvent('asleep', { input: input.type, selectedChatIndex: state.selectedChatIndex })
      return
    }
    await this.switchFolder(state, index === 0 ? undefined : this.folders[index - 1]?.id)
  }

  private async switchFolder(state: Extract<AppState, { screen: 'folderPicker' }>, folderId: Id | undefined) {
    if (this.folderKey(folderId) === this.folderKey(this.activeFolderId)) {
      await this.setState(this.chatsState(state.chats, state.selectedChatIndex))
      return
    }
    // Remember the loaded pages of the folder we are leaving so coming back is instant.
    this.folderChatsCache.set(this.folderKey(this.activeFolderId), { chats: state.chats, hasMore: this.chatsHasMore })
    const previousFolderId = this.activeFolderId
    const switchId = ++this.folderSwitchId
    this.activeFolderId = folderId
    this.loadingMoreChats = false
    const cached = this.folderChatsCache.get(this.folderKey(folderId))
    if (cached) {
      this.chatsHasMore = cached.hasMore
      await this.setState(this.chatsState(cached.chats, 0))
      void this.refreshFolderFirstPage(folderId, switchId).catch(() => undefined)
      return
    }
    this.chatsHasMore = false
    await this.setState(this.chatsState([], 0, { loadingMore: true }))
    try {
      const chats = await this.api.listChats(CHAT_LIST_LIMIT, { folderId })
      if (switchId !== this.folderSwitchId) return
      this.chatsHasMore = chats.length >= CHAT_LIST_LIMIT
      this.folderChatsCache.set(this.folderKey(folderId), { chats, hasMore: this.chatsHasMore })
      const current = this.state
      if (current.screen === 'folderPicker' || current.screen === 'asleep') {
        // The user moved on while this folder loaded: fill in the list behind their screen
        // instead of pulling them out of it.
        await this.setStateWithoutRender({ ...current, chats, selectedChatIndex: 0 })
        return
      }
      if (current.screen !== 'sidebar' || current.focus !== 'chats') return
      await this.setState(this.chatsState(chats, 0))
    } catch (error) {
      if (switchId !== this.folderSwitchId) return
      // Fall back to the folder we were in.
      this.activeFolderId = previousFolderId
      const fallback = this.folderChatsCache.get(this.folderKey(previousFolderId))
      this.chatsHasMore = fallback?.hasMore ?? false
      this.folderSwitchId += 1
      await this.setState(this.chatsState(fallback?.chats ?? state.chats, 0, {
        status: error instanceof Error ? error.message : 'Could not open folder',
      }))
    }
  }

  private async refreshFolderFirstPage(folderId: Id | undefined, switchId: number) {
    const fresh = await this.api.listChats(CHAT_LIST_LIMIT, { folderId })
    if (switchId !== this.folderSwitchId) return
    const current = this.state
    if (current.screen !== 'sidebar' || current.focus !== 'chats') return
    const chats = mergeChatPages(current.chats, fresh)
    this.folderChatsCache.set(this.folderKey(folderId), { chats, hasMore: this.chatsHasMore })
    await this.setStateWithoutRender({ ...current, chats })
  }

  private async openChat(chat: Chat, previous: RecoverableState) {
    const chats = previous.screen === 'sidebar' ? previous.chats : []
    const selectedChatIndex = previous.screen === 'sidebar' ? previous.selectedChatIndex : 0
    const requestId = ++this.openRequestId
    await this.run(async () => {
      if (!chat.isForum) {
        await this.openMessages(chat, undefined, previous, requestId)
        return
      }
      const cachedTopics = this.topicsCache.get(String(chat.id))
      if (!cachedTopics) {
        await this.setState({
          screen: 'sidebar', focus: 'messages',
          chats, selectedChatIndex,
          chat,
          messages: [],
          back: previous,
          status: `Loading ${chat.title} topics...`,
          newerPages: [],
          isNewestPage: true,
          scrollOffset: 0,
        })
      }
      const topics = cachedTopics ?? await this.prefetchTopics(chat)
      if (requestId !== this.openRequestId) return
      if (topics.length > 0) {
        await this.setState({
          screen: 'sidebar', focus: 'topics',
          chats, selectedChatIndex,
          chat, topics, selectedTopicIndex: 0,
        })
        this.debounceTopicPreviewFetch(chat, topics, 0)
        return
      }
      await this.openMessages(chat, undefined, previous, requestId)
    }, previous)
  }

  private async openMessages(chat: Chat, topic: Topic | undefined, previous: RecoverableState, requestId = ++this.openRequestId) {
    const chats = previous.screen === 'sidebar' ? previous.chats : []
    const selectedChatIndex = previous.screen === 'sidebar' ? previous.selectedChatIndex : 0
    const topics = topic && previous.screen === 'sidebar' && previous.focus === 'topics' ? previous.topics : undefined
    const selectedTopicIndex = topic && previous.screen === 'sidebar' && previous.focus === 'topics' ? previous.selectedTopicIndex : undefined
    await this.run(async () => {
      const cached = this.messageCache.get(messageThreadKey({ chat, topic }))
      if (cached) {
        await this.setStateWithVisibleRead({
          screen: 'sidebar', focus: 'messages',
          chats, selectedChatIndex,
          chat, topic,
          messages: cached.messages,
          cursor: cached.cursor,
          back: messageBackTarget(previous),
          newerPages: [],
          isNewestPage: true,
          scrollOffset: 0,
          topics,
          selectedTopicIndex,
        }, chat, topic, cached.messages)
        void this.refreshOpenMessagesInBackground(chat, topic, requestId)
        return
      }

      await this.setState({
        screen: 'sidebar', focus: 'messages',
        chats, selectedChatIndex,
        chat, topic,
        messages: [],
        back: messageBackTarget(previous),
        status: `Loading ${topic?.title ?? chat.title}...`,
        newerPages: [],
        isNewestPage: true,
        scrollOffset: 0,
        topics,
        selectedTopicIndex,
      })
      const messages = await this.prefetchMessages(chat, topic)
      if (requestId !== this.openRequestId || !this.isStillOpeningMessages(chat, topic, requestId)) return
      const normalized = normalizeMessagePage(messages)
      await this.setStateWithVisibleRead({
        screen: 'sidebar', focus: 'messages',
        chats, selectedChatIndex,
        chat, topic,
        messages: normalized,
        cursor: oldestMessageId(normalized),
        back: messageBackTarget(previous),
        newerPages: [],
        isNewestPage: true,
        scrollOffset: 0,
        topics,
        selectedTopicIndex,
      }, chat, topic, normalized)
      this.maybePrefetchOlder()
    }, previous)
  }

  private async refreshOpenMessagesInBackground(chat: Chat, topic: Topic | undefined, requestId: number) {
    const messages = normalizeMessagePage(await this.api.listMessages(chat.id, { topicId: topicThreadId(topic), limit: MESSAGE_PAGE_LIMIT }))
    this.cacheMessages(chat, topic, messages)
    if (requestId !== this.openRequestId || !this.isStillOpeningMessages(chat, topic, requestId)) return
    const state = this.state
    if (state.screen !== 'sidebar' || state.focus !== 'messages') return
    if (!hasMessageChanges(state.messages, messages)) return
    await this.setStateWithVisibleRead({
      ...state,
      messages,
      cursor: oldestMessageId(messages),
      newerPages: [],
      isNewestPage: true,
      scrollOffset: 0,
    }, chat, topic, messages)
    this.maybePrefetchOlder()
  }

  private async loadOlderMessages(state: Extract<AppState, { screen: 'sidebar'; focus: 'messages' }>) {
    const currentOffset = state.scrollOffset ?? 0
    const nextOffset = nextMessageScrollOffset(state.messages, currentOffset, 'up')
    if (nextOffset !== currentOffset) {
      await this.setState({
        ...state,
        scrollOffset: nextOffset,
        isNewestPage: nextOffset === 0,
        status: nextOffset === 0 ? undefined : 'Older messages',
      })
      this.maybePrefetchOlder()
      return
    }

    await this.setState({ ...state, status: LOADING_OLDER_STATUS, isNewestPage: false })
    void this.loadOlderMessagesInBackground(state).catch(() => undefined)
  }

  private async loadOlderMessagesInBackground(state: Extract<AppState, { screen: 'sidebar'; focus: 'messages' }>) {
    const key = messageThreadKey(state)
    const cursor = String(state.cursor ?? '')
    await this.prefetchOlderMessages(state)
    const current = this.state
    if (current.screen !== 'sidebar' || current.focus !== 'messages' || messageThreadKey(current) !== key || String(current.cursor ?? '') === cursor) {
      if (current.screen === 'sidebar' && current.focus === 'messages' && messageThreadKey(current) === key && current.status === LOADING_OLDER_STATUS) {
        await this.setState({ ...current, status: 'No older messages' })
      }
      return
    }
    const offset = Math.min((current.scrollOffset ?? 0) + 1, maxScrollOffset(current.messages))
    await this.setState({ ...current, scrollOffset: offset, status: 'Older messages', isNewestPage: false })
    this.maybePrefetchOlder()
  }

  private async loadNewerMessages(state: Extract<AppState, { screen: 'sidebar'; focus: 'messages' }>) {
    const nextOffset = nextMessageScrollOffset(state.messages, state.scrollOffset ?? 0, 'down')
    if (nextOffset === (state.scrollOffset ?? 0)) return
    await this.setState({
      ...state,
      scrollOffset: nextOffset,
      isNewestPage: nextOffset === 0,
      status: nextOffset === 0 ? undefined : 'Newer messages',
    })
    this.maybePrefetchOlder()
  }

  private async refreshLatestMessages(state: { chat: Chat; topic?: Topic }) {
    const messages = normalizeMessagePage(await this.api.listMessages(state.chat.id, { topicId: topicThreadId(state.topic), limit: MESSAGE_PAGE_LIMIT }))
    this.cacheMessages(state.chat, state.topic, messages)
    return messages
  }

  private async refreshAfterSend(state: Extract<AppState, { screen: 'sidebarConfirm' }>, sent: Message) {
    const previousIds = new Set(state.messages.map((message) => String(message.id)))
    const requestedThreadKey = messageThreadKey(state)

    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt > 0) await sleep(1000)
      const refreshed = await this.refreshLatestMessages(state)
      if (refreshed.length === 0) continue

      const hasSent = refreshed.some((message) => String(message.id) === String(sent.id))
      const hasNewIncoming = refreshed.some(
        (message) => !previousIds.has(String(message.id)) && String(message.id) !== String(sent.id),
      )
      const current = this.state
      if ((current.screen === 'sidebarSent' || (current.screen === 'sidebar' && current.focus === 'messages')) &&
        messageThreadKey(current) !== requestedThreadKey) {
        return
      }
      if (current.screen === 'sidebarSent') {
        const messages = hasSent ? refreshed : normalizeMessagePage([...refreshed, sent])
        await this.setState({
          ...current,
          messages,
          status: hasNewIncoming ? 'New reply' : undefined,
          newerPages: [],
          isNewestPage: true,
          scrollOffset: 0,
        })
      } else if (current.screen === 'sidebar' && current.focus === 'messages') {
        const messages = hasSent ? refreshed : normalizeMessagePage([...refreshed, sent])
        await this.setState({
          ...current,
          messages,
          cursor: oldestMessageId(messages),
          status: hasNewIncoming ? 'New reply' : undefined,
          newerPages: [],
          isNewestPage: true,
          scrollOffset: 0,
        })
      }
      if (hasSent && hasNewIncoming) return
    }
  }
  private maybePrefetchOlder() {
    const state = this.state
    if (state.screen !== 'sidebar' || state.focus !== 'messages') return
    if (this.isInputQuiet()) return
    const maxOffset = maxScrollOffset(state.messages)
    const remainingLoadedScroll = maxOffset - (state.scrollOffset ?? 0)
    if (remainingLoadedScroll > OLDER_PREFETCH_LOW_WATER) return
    void this.prefetchOlderMessages(state).catch(() => undefined)
  }

  private async prefetchTopics(chat: Chat): Promise<Topic[]> {
    const key = String(chat.id)
    const cached = this.topicsCache.get(key)
    if (cached) return cached
    const inFlight = this.topicsPrefetchInFlight.get(key)
    if (inFlight) return inFlight
    const promise = this.api.listTopics(chat.id)
      .then((topics) => {
        this.topicsCache.set(key, topics)
        return topics
      })
      .finally(() => {
        this.topicsPrefetchInFlight.delete(key)
      })
    this.topicsPrefetchInFlight.set(key, promise)
    return promise
  }

  private async prefetchMessages(chat: Chat, topic: Topic | undefined): Promise<Message[]> {
    const key = messageThreadKey({ chat, topic })
    const cached = this.messageCache.get(key)
    if (cached) return cached.messages
    const inFlight = this.messagePrefetchInFlight.get(key)
    if (inFlight) return inFlight
    const promise = this.api.listMessages(chat.id, { topicId: topicThreadId(topic), limit: MESSAGE_PAGE_LIMIT })
      .then((messages) => {
        const normalized = normalizeMessagePage(messages)
        this.cacheMessages(chat, topic, normalized)
        return normalized
      })
      .finally(() => {
        this.messagePrefetchInFlight.delete(key)
      })
    this.messagePrefetchInFlight.set(key, promise)
    return promise
  }

  private cacheMessages(chat: Chat, topic: Topic | undefined, messages: Message[]) {
    this.messageCache.set(messageThreadKey({ chat, topic }), {
      messages,
      cursor: oldestMessageId(messages),
    })
  }

  private async prefetchOlderMessages(state: Extract<AppState, { screen: 'sidebar'; focus: 'messages' }>, options: { chain?: boolean } = {}) {
    if (state.cursor === undefined) return

    const key = messageThreadKey(state)
    const cursor = String(state.cursor)
    if (this.olderPrefetch?.key === key && this.olderPrefetch.cursor === cursor) {
      await this.olderPrefetch.promise
      return
    }

    const promise = this.fetchAndAppendOlderMessages(state, key, cursor)
    this.olderPrefetch = { key, cursor, promise }
    const added = await promise.finally(() => {
      if (this.olderPrefetch?.key === key && this.olderPrefetch.cursor === cursor) {
        this.olderPrefetch = undefined
      }
    })
    if (options.chain && added) this.continueOlderPrefetch(key)
  }

  private async fetchAndAppendOlderMessages(state: Extract<AppState, { screen: 'sidebar'; focus: 'messages' }>, key: string, cursor: string): Promise<boolean> {
    const older = await this.api.listMessages(state.chat.id, {
      topicId: topicThreadId(state.topic),
      beforeId: state.cursor,
      limit: MESSAGE_PAGE_LIMIT,
    })
    if (older.length === 0) return false

    const current = this.state
    if (current.screen !== 'sidebar' || current.focus !== 'messages' || messageThreadKey(current) !== key || String(current.cursor) !== cursor) return false

    const messages = normalizeMessagePage([...older, ...current.messages])
    if (!hasMessageChanges(current.messages, messages)) return false

    await this.setState({
      ...current,
      messages,
      cursor: oldestMessageId(messages),
      status: current.scrollOffset === 0 ? current.status : 'Older messages',
    })
    return true
  }

  private continueOlderPrefetch(key: string) {
    const current = this.state
    if (current.screen !== 'sidebar' || current.focus !== 'messages' || messageThreadKey(current) !== key) return
    const maxOffset = maxScrollOffset(current.messages)
    const remainingLoadedScroll = maxOffset - (current.scrollOffset ?? 0)
    if (remainingLoadedScroll > OLDER_PREFETCH_LOW_WATER) return
    void this.prefetchOlderMessages(current, { chain: true }).catch(() => undefined)
  }

  private async goBackFromMessages(state: Extract<AppState, { screen: 'sidebar'; focus: 'messages' }>) {
    this.openRequestId += 1
    if (state.back) {
      await this.setState(state.back)
      return
    }
    if (state.topic) {
      const topics = await this.api.listTopics(state.chat.id)
      await this.setState({
        screen: 'sidebar', focus: 'topics',
        chats: state.chats, selectedChatIndex: state.selectedChatIndex,
        chat: state.chat,
        topics,
        selectedTopicIndex: 0,
      })
      return
    }
    await this.loadChats()
  }

  private async run(operation: () => Promise<void>, previous?: RecoverableState) {
    try {
      await operation()
    } catch (error) {
      await this.bridge.setAudioEnabled(false).catch(() => undefined)
      await this.setState({
        screen: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        previous,
      })
    }
  }

  private isStillOpeningMessages(chat: Chat, topic: Topic | undefined, requestId: number) {
    const current = this.state
    return requestId === this.openRequestId
      && current.screen === 'sidebar'
      && current.focus === 'messages'
      && String(current.chat.id) === String(chat.id)
      && String(topicThreadId(current.topic) ?? '') === String(topicThreadId(topic) ?? '')
  }

  private async setState(state: AppState) {
    const finish = this.timeSyncWork('setState')
    const prev = this.state
    this.applyState(state, true)
    // Partial updates may only change text content. A focus transition changes
    // which container captures input, so it requires a full page rebuild.
    if (prev.screen === 'sidebar' && state.screen === 'sidebar' && this.bridge.renderSidebarPanel) {
      const newModel = screenModel(state)
      if (newModel.kind === 'sidebar') {
        const newHasPanelBox = Boolean(newModel.panelBox)
        const listUnchanged = this.lastRenderedListItems !== undefined
          && this.listItemsMatch(this.lastRenderedListItems, newModel.sidebarItems)
        if (prev.focus === state.focus && newHasPanelBox === this.lastRenderedHasPanelBox && listUnchanged) {
          if (this.bridge.enqueueSidebarPanel) {
            this.bridge.enqueueSidebarPanel(newModel)
          } else {
            await this.bridge.renderSidebarPanel(newModel)
          }
          finish()
          return
        }
        this.lastRenderedHasPanelBox = newHasPanelBox
        this.lastRenderedListItems = newModel.sidebarItems
      }
    } else if (state.screen !== 'sidebar') {
      this.lastRenderedListItems = undefined
    } else {
      // First sidebar render (e.g. loading → chats). Cache the list items so
      // the next state change (chats → messages) can use the partial path.
      const newModel = screenModel(state)
      if (newModel.kind === 'sidebar') {
        this.lastRenderedHasPanelBox = Boolean(newModel.panelBox)
        this.lastRenderedListItems = newModel.sidebarItems
      }
    }
    this.enqueueRender(state)
    finish()
  }

  private listItemsMatch(a: readonly string[], b: readonly string[]): boolean {
    if (a === b) return true
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false
    }
    return true
  }

  private async setStateWithoutRender(state: AppState) {
    const finish = this.timeSyncWork('setStateWithoutRender')
    this.applyState(state, false)
    finish()
  }

  private applyState(state: AppState, armSelectionOnlyPress: boolean) {
    // Preserve typing state across transitions within the message view
    // (send, refresh, poll) so concurrent typing updates are not lost.
    const prev = this.state
    if (state.screen === 'sidebar' && state.focus === 'messages' && !('typing' in (state as Record<string, unknown>)) && prev.screen === 'sidebar' && prev.focus === 'messages' && prev.typing) {
      state = { ...state, typing: prev.typing }
    }
    this.state = state
    if (state.screen !== 'sidebar' || state.focus !== 'messages') {
      this.cancelTypingTimer()

    }
    if (armSelectionOnlyPress && state.screen === 'sidebar' && (state.focus === 'chats' || state.focus === 'topics')) {
      this.selectionOnlyPressReadyAt = Date.now() + this.runtimeConfig.selectionOnlyPressDelayMs
    }
    this.syncMessagePolling()
    this.syncChatPolling()
    this.enqueueNotify()
  }

  private enqueueRender(state: AppState) {
    this.pendingRenderState = state
    this.scheduleRenderFlush(RENDER_DEFER_MS)
  }

  private scheduleRenderFlush(delayMs: number) {
    if (this.renderInFlight || this.renderTimer) return
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined
      this.renderInFlight = true
      void this.flushRenderQueue()
    }, delayMs)
    const maybeNodeTimeout = this.renderTimer as unknown as { unref?: () => void }
    maybeNodeTimeout.unref?.()
  }

  private async flushRenderQueue() {
    try {
      const state = this.pendingRenderState
      this.pendingRenderState = undefined
      if (state) {
        this.lastFullRenderAt = Date.now()
        await this.bridge.render(screenModel(state))
      }
    } catch {
      // Rendering failures should not block controller state/input handling.
    } finally {
      this.renderInFlight = false
      if (this.pendingRenderState) this.scheduleRenderFlush(RENDER_COOLDOWN_MS)
    }
  }

  private enqueueNotify() {
    this.notifyPending = true
    if (this.notifyTimer) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined
      if (!this.notifyPending) return
      this.notifyPending = false
      this.notify()
    }, 0)
    const maybeNodeTimeout = this.notifyTimer as unknown as { unref?: () => void }
    maybeNodeTimeout.unref?.()
  }

  private notify() {
    for (const listener of this.listeners) listener(this.state)
  }

  private syncMessagePolling() {
    const state = this.state
    const shouldPoll = (state.screen === 'sidebar' && state.focus === 'messages') || state.screen === 'sidebarSent'
    if (!shouldPoll) {
      this.stopMessagePolling()
      return
    }
    if (this.messagePoll) return
    this.messagePoll = setInterval(() => {
      void this.refreshVisibleMessages({ background: true })
    }, this.runtimeConfig.messagePollMs)
    const maybeNodeInterval = this.messagePoll as unknown as { unref?: () => void }
    maybeNodeInterval.unref?.()
  }

  private stopMessagePolling() {
    if (!this.messagePoll) return
    clearInterval(this.messagePoll)
    this.messagePoll = undefined
  }

  private syncChatPolling() {
    const state = this.state
    const shouldPoll = (state.screen === 'sidebar' && state.focus === 'chats') || state.screen === 'asleep' || state.screen === 'newMessage'
    if (!shouldPoll) {
      this.stopChatPolling()
      return
    }
    if (this.chatPoll) return
    this.chatPoll = setInterval(() => {
      void this.refreshRootChats({ background: true })
    }, this.runtimeConfig.chatPollMs)
    const maybeNodeInterval = this.chatPoll as unknown as { unref?: () => void }
    maybeNodeInterval.unref?.()
  }

  private stopChatPolling() {
    if (!this.chatPoll) return
    clearInterval(this.chatPoll)
    this.chatPoll = undefined
  }

  private async refreshRootChats(options: { background?: boolean } = {}) {
    if (this.rootRefreshInFlight) return
    if (options.background && this.isInputQuiet()) {
      this.deferRootRefresh()
      return
    }
    const state = this.state
    if ((state.screen !== 'sidebar' || state.focus !== 'chats') && state.screen !== 'asleep' && state.screen !== 'newMessage') return
    this.rootRefreshInFlight = true
    try {
      const chats = await this.api.listChats(CHAT_LIST_LIMIT).catch(() => undefined)
      if (!chats) return

      const activity = this.findNewChatActivity(chats)
      this.rememberChats(chats)

      const current = this.state
      if ((current.screen !== 'sidebar' || current.focus !== 'chats') && current.screen !== 'asleep' && current.screen !== 'newMessage') return

      // `chats` is only the first page of "All chats". Keep the pages the user has already scrolled
      // through; inside a folder the displayed list is left alone (only activity detection uses it).
      const displayedChats = this.activeFolderId === undefined ? mergeChatPages(current.chats, chats) : current.chats
      const selectedChatIndex = clamp(current.selectedChatIndex, 0, Math.max(0, displayedChats.length - 1))
      if (!activity) {
        if (current.screen === 'sidebar' && current.focus === 'chats') {
          await this.setStateWithoutRender({ ...current, chats: displayedChats, selectedChatIndex })
        }
        return
      }

      const topic = activity.chat.isForum ? await this.findUnreadTopic(activity.chat).catch(() => undefined) : undefined
      await this.setState({
        screen: 'newMessage',
        chat: activity.chat,
        topic,
        message: activity.chat.lastMessage ?? '',
        chats: displayedChats,
        selectedChatIndex,
      })
    } finally {
      this.rootRefreshInFlight = false
    }
  }

  private findNewChatActivity(chats: Chat[]) {
    for (const chat of chats) {
      const key = String(chat.id)
      const previous = this.chatFingerprints.get(key)
      const current = chatFingerprint(chat)
      if (!previous) continue
      if (previous !== current && (chat.unreadCount ?? 0) > 0) return { chat }
    }
    return undefined
  }

  private rememberChats(chats: Chat[]) {
    this.chatFingerprints = new Map(chats.map((chat) => [String(chat.id), chatFingerprint(chat)]))
  }

  private async findUnreadTopic(chat: Chat) {
    const topics = await this.api.listTopics(chat.id)
    return topics.find((topic) => (topic.unreadCount ?? 0) > 0) ?? topics[0]
  }

  private async refreshVisibleMessages(options: { background?: boolean } = {}) {
    if (this.messageRefreshInFlight) return
    if (options.background && this.isInputQuiet()) {
      this.deferMessageRefresh()
      return
    }
    const state = this.state
    if ((state.screen !== 'sidebar' || state.focus !== 'messages') && state.screen !== 'sidebarSent') return
    const requestedThreadKey = messageThreadKey(state)
    this.messageRefreshInFlight = true
    try {
      const messages = await this.refreshLatestMessages(state).catch(() => undefined)
      if (!messages || messages.length === 0) return
      const current = this.state
      if ((current.screen !== 'sidebar' || current.focus !== 'messages') && current.screen !== 'sidebarSent') return
      if (messageThreadKey(current) !== requestedThreadKey) return

      const merged = normalizeMessagePage([...current.messages, ...messages])
      if (!hasMessageChanges(current.messages, merged)) return
      const hasIncoming = hasIncomingChange(current.messages, merged)
      if (current.screen === 'sidebar' && current.focus === 'messages') {
        await this.setStateWithVisibleRead({ ...current, messages: merged, cursor: oldestMessageId(merged), status: hasIncoming ? 'New reply' : undefined, newerPages: [], isNewestPage: true, scrollOffset: 0 }, current.chat, current.topic, merged, { forceAck: hasIncoming })
        this.maybePrefetchOlder()
        return
      }
      await this.setStateWithVisibleRead({ ...current, messages: merged, status: hasIncoming ? 'New reply' : undefined, newerPages: [], isNewestPage: true, scrollOffset: 0 }, current.chat, current.topic, merged, { forceAck: hasIncoming })
    } finally {
      this.messageRefreshInFlight = false
    }
  }

  private async setStateWithVisibleRead(
    state: AppState,
    chat: Chat,
    topic: Topic | undefined,
    messages: Message[],
    options: { forceAck?: boolean; render?: boolean } = {},
  ) {
    const maxId = newestMessageId(messages)
    if (maxId === undefined) {
      if (options.render === false) {
        await this.setStateWithoutRender(state)
      } else {
        await this.setState(state)
      }
      return
    }
    const hasUnread = hasUnreadForThread(state, chat, topic)
    const next = hasUnread ? clearUnreadForThread(state, chat, topic) : state
    const shouldAck = (hasUnread || options.forceAck === true) && this.shouldSendReadAck(chat, topic, maxId)
    if (options.render === false) {
      await this.setStateWithoutRender(next)
    } else {
      await this.setState(next)
    }
    if (shouldAck) this.sendReadAck(chat, topic, maxId)
  }

  /**
   * Apply state and emit a *partial* render that updates only the right-side text containers
   * (title, panelBody, panelBox, panelFooter). The native list (container ID 8) and the
   * left-side text containers (0/2/3/5) are never touched, so the list selection cannot
   * snap back to row 0. This is the path used by chat/topic preview updates so the right
   * panel actually changes after every swipe instead of staying on the previous row.
   */
  private async setStateWithPartialRender(
    state: AppState,
    chat: Chat,
    topic: Topic | undefined,
    messages: Message[],
    options: { forceAck?: boolean } = {},
  ) {
    const finish = this.timeSyncWork('setStateWithPartialRender', { includedScreenModel: true, includedRenderEnqueue: true })
    const maxId = newestMessageId(messages)
    const hasUnread = maxId !== undefined && hasUnreadForThread(state, chat, topic)
    const next = hasUnread ? clearUnreadForThread(state, chat, topic) : state
    // Capture the incoming `panelBox` visibility BEFORE applyState mutates `this.state`.
    // The partial-render path only updates `panelBox` content, not its
    // position/size/border, so a visibility flip must trigger a full rebuild.
    const nextHasPanelBox = next.screen === 'sidebar'
      ? Boolean((screenModel(next) as Extract<ScreenModel, { kind: 'sidebar' }>).panelBox)
      : false
    this.applyState(next, false)
    if (nextHasPanelBox !== this.lastRenderedHasPanelBox) {
      this.lastRenderedHasPanelBox = nextHasPanelBox
      this.enqueueRender(next)
    } else if (this.bridge.enqueueSidebarPanel) {
      this.bridge.enqueueSidebarPanel(screenModel(next) as Extract<ScreenModel, { kind: 'sidebar' }>)
    } else if (this.bridge.renderSidebarPanel) {
      await this.bridge.renderSidebarPanel(screenModel(next) as Extract<ScreenModel, { kind: 'sidebar' }>)
    } else {
      // Bridge doesn't support partial updates — fall back to a queued full render so the
      // right panel still updates, even if the list selection may snap on real hardware.
      this.enqueueRender(next)
    }
    if (maxId !== undefined) {
      const shouldAck = (hasUnread || options.forceAck === true) && this.shouldSendReadAck(chat, topic, maxId)
      if (shouldAck) this.sendReadAck(chat, topic, maxId)
    }
    finish()
  }

  /**
   * Apply a chat/topic-list scroll state and emit a *partial* render so the right panel
   * follows the highlighted row. This is the bridge between the synchronous cache lookup
   * in `handleSidebarChats`/`handleSidebarTopics` and the glasses UI: the controller state
   * is updated immediately, and the right panel is refreshed in place without rebuilding
   * the native list.
   *
   * The native render is fire-and-forget through `bridge.enqueueSidebarPanel`. The bridge
   * coalesces rapid list scrolls into a single latest-wins `textContainerUpgrade` chain so
   * the input handler does not block on slow native renders. Older models are dropped, not
   * queued, so a long swipe never falls behind. The native list (container ID 8) is left
   * untouched so the firmware highlight cannot snap back to row 0.
   *
   * direct `renderSidebarPanel` so simpler test doubles still work.
   */
  private setStateForListScroll(state: AppState) {
    const finish = this.timeSyncWork('setStateForListScroll', { includedScreenModel: true, includedRenderEnqueue: true })
    // Capture the incoming `panelBox` visibility BEFORE applyState mutates `this.state`.
    // The partial-render path only updates `panelBox` content, not its
    // position/size/border, so a visibility flip must trigger a full rebuild.
    const sidebarModel = state.screen === 'sidebar' || state.screen === 'folderPicker'
      ? screenModel(state) as Extract<ScreenModel, { kind: 'sidebar' }>
      : undefined
    const nextHasPanelBox = sidebarModel
      ? Boolean(sidebarModel.panelBox)
      : false
    this.applyState(state, true)
    if (!sidebarModel) { finish(); return }
    if (nextHasPanelBox !== this.lastRenderedHasPanelBox) {
      this.lastRenderedHasPanelBox = nextHasPanelBox
      this.enqueueRender(state)
      finish()
      return
    }
    if (this.bridge.enqueueSidebarPanel) {
      this.bridge.enqueueSidebarPanel(sidebarModel)
      finish()
      return
    }
    if (this.bridge.renderSidebarPanel) {
      // Test doubles may not implement the queued path. Awaiting here is safe because
      // fake bridges resolve synchronously; production bridges always provide enqueue.
      void this.bridge.renderSidebarPanel(sidebarModel)
      finish()
      return
    }
    this.enqueueRender(state)
    finish()
  }

  private shouldSendReadAck(chat: Chat, topic: Topic | undefined, maxId: Id) {
    const key = messageThreadKey({ chat, topic })
    const previous = this.readAckMaxIds.get(key)
    return previous === undefined || !idAtOrAfter(previous, maxId)
  }

  private sendReadAck(chat: Chat, topic: Topic | undefined, maxId: Id) {
    const key = messageThreadKey({ chat, topic })
    this.readAckMaxIds.set(key, maxId)
    this.pendingReadAcks.set(key, { chat, topic, maxId })
    this.scheduleReadAckFlush()
  }

  isInputQuiet() {
    return Date.now() < this.inputQuietUntil
  }

  /**
   * Snapshot of controller state consumed by the bridge on every native event.
   * Lets `input.dispatch` correlate input latency with controller-side background
   * work and the input quiet window. The harness looks for `backgroundWorkActive=true`
   * to detect contention between input handling and prefetch/poll activity.
   */
  getDispatchContext() {
    return {
      inputQuiet: this.isInputQuiet(),
      backgroundWorkActive: this.isBackgroundWorkActive(),
    }
  }

  /**
   * True if any controller-side background work is currently awaiting a network
   * roundtrip. Includes message/chat poll refreshes, startup prefetch chains,
   * topic preview fetches, older-message prefetch, and the read-ack flush. The
   * intent is to surface "input arrived while the network was busy" to the
   * harness so it can attribute input latency to network contention rather than
   * to the bridge.
   */
  isBackgroundWorkActive() {
    if (this.rootRefreshInFlight) return true
    if (this.messageRefreshInFlight) return true
    if (this.olderPrefetch) return true
    if (this.topicsPrefetchInFlight.size > 0) return true
    if (this.messagePrefetchInFlight.size > 0) return true
    if (this.topicPreviewInFlight.size > 0) return true
    if (this.chatPreviewInFlight.size > 0) return true
    if (this.pendingReadAcks.size > 0) return true
    if (this.deferredRootRefreshTimer) return true
    if (this.deferredMessageRefreshTimer) return true
    return false
  }
  private timeSyncWork(
    kind: 'setState' | 'setStateWithoutRender' | 'setStateForListScroll' | 'setStateWithPartialRender',
    extras: { includedScreenModel?: boolean; includedRenderEnqueue?: boolean } = {},
  ) {
    const startedAt = nowMs()
    return () => {
      const state = this.state
      logStateWork({
        kind,
        syncMs: nowMs() - startedAt,
        screen: state.screen,
        focus: 'focus' in state ? state.focus : undefined,
        includedScreenModel: extras.includedScreenModel,
        includedRenderEnqueue: extras.includedRenderEnqueue,
      })
    }
  }
  private noteUserInput() {
    this.inputQuietUntil = Math.max(this.inputQuietUntil, Date.now() + INPUT_QUIET_MS)
  }

  private msUntilQuiet() {
    return Math.max(0, this.inputQuietUntil - Date.now())
  }

  private topicPreviewDelayMs() {
    return Math.max(TOPIC_PREVIEW_IDLE_MS, this.msUntilQuiet())
  }

  private deferTelegramUpdate(update: TelegramUpdate) {
    const state = this.state
    if (state.screen === 'sidebar' && state.focus === 'messages' && updateMatchesThread(update, state)) {
      this.deferMessageRefresh()
      return
    }
    this.deferRootRefresh()
  }

  private deferRootRefresh() {
    if (this.deferredRootRefreshTimer) return
    this.deferredRootRefreshTimer = setTimeout(() => {
      this.deferredRootRefreshTimer = undefined
      void this.refreshRootChats()
    }, this.msUntilQuiet())
    const maybeNodeTimeout = this.deferredRootRefreshTimer as unknown as { unref?: () => void }
    maybeNodeTimeout.unref?.()
  }

  private deferMessageRefresh() {
    if (this.deferredMessageRefreshTimer) return
    this.deferredMessageRefreshTimer = setTimeout(() => {
      this.deferredMessageRefreshTimer = undefined
      void this.refreshVisibleMessages()
    }, this.msUntilQuiet())
    const maybeNodeTimeout = this.deferredMessageRefreshTimer as unknown as { unref?: () => void }
    maybeNodeTimeout.unref?.()
  }

  private scheduleReadAckFlush() {
    if (this.readAckFlushTimer) return
    this.readAckFlushTimer = setTimeout(() => {
      this.readAckFlushTimer = undefined
      this.flushReadAcks()
    }, this.msUntilQuiet())
    const maybeNodeTimeout = this.readAckFlushTimer as unknown as { unref?: () => void }
    maybeNodeTimeout.unref?.()
  }

  private flushReadAcks() {
    if (this.isInputQuiet()) {
      this.scheduleReadAckFlush()
      return
    }
    const pending = Array.from(this.pendingReadAcks.values())
    this.pendingReadAcks.clear()
    for (const ack of pending) {
      void this.api.markRead(ack.chat.id, { topicId: topicThreadId(ack.topic), maxId: ack.maxId }).catch(() => undefined)
    }
  }

  // The G2 firmware (and the simulator) reset their tracked list-selection
  // index to 0 on every full page rebuild. A click arriving within
  // `firmwareResetWindowMs` of the most recent `bridge.render()` call is
  // therefore suspect: the firmware's `currentSelectItemIndex` payload
  // reflects the post-reset value, not the user's tap. In that window
  // we trust the controller's state instead. Outside the window the
  // firmware's index is trusted as before. See
  // `docs/SDK_BUG_NATIVE_LIST_SELECTION.md` for the SDK-level analysis.
  private resolveSelectedChatIndex(input: { index?: number; itemName?: string }, currentIndex: number, chats: Chat[]) {
    if (Date.now() - this.lastFullRenderAt <= this.runtimeConfig.firmwareResetWindowMs) {
      return currentIndex
    }
    const byIndex = typeof input.index === 'number' ? clamp(input.index, 0, chats.length - 1) : currentIndex
    if (typeof input.index === 'number') return byIndex
    return selectedNamedIndex(input.itemName, currentIndex, chats, chatSelectionLabel)
  }

  private resolveSelectedTopicIndex(input: { index?: number; itemName?: string }, currentIndex: number, topics: Topic[]) {
    if (Date.now() - this.lastFullRenderAt <= this.runtimeConfig.firmwareResetWindowMs) {
      return currentIndex
    }
    const byIndex = typeof input.index === 'number' ? clamp(input.index, 0, topics.length - 1) : currentIndex
    if (typeof input.index === 'number') return byIndex
    return selectedNamedIndex(input.itemName, currentIndex, topics, topicSelectionLabel)
  }
}

/** Put freshly fetched first-page chats ahead of the already-loaded list without dropping deeper pages. */
function mergeChatPages(existing: Chat[], fresh: Chat[]): Chat[] {
  const freshIds = new Set(fresh.map((chat) => String(chat.id)))
  return [...fresh, ...existing.filter((chat) => !freshIds.has(String(chat.id)))]
}

function moveSelection(index: number, count: number, delta: number) {
  if (count <= 0) return 0
  return clamp(index + delta, 0, count - 1)
}
function selectedNamedIndex<T>(itemName: string | undefined, currentIndex: number, items: T[], label: (item: T) => string) {
  if (!itemName) return currentIndex
  const normalizedName = normalizeSelectionLabel(itemName)
  const exact = items.findIndex((item) => normalizeSelectionLabel(label(item)) === normalizedName)
  if (exact >= 0) return exact
  const loose = items.findIndex((item) => {
    const itemLabel = normalizeSelectionLabel(label(item))
    return itemLabel.includes(normalizedName) || normalizedName.includes(itemLabel)
  })
  return loose >= 0 ? loose : currentIndex
}

function chatSelectionLabel(chat: Chat) {
  const unread = chat.unreadCount ? ` (${chat.unreadCount})` : ''
  return `${chat.title}${unread}`
}

function topicSelectionLabel(topic: Topic) {
  const unread = topic.unreadCount ? ` (${topic.unreadCount})` : ''
  return `${topic.title}${unread}`
}

function normalizeSelectionLabel(value: string) {
  return value.replace(/\s+\(\d+\)$/, '').trim().toLowerCase()
}

function hasMessageChanges(current: Message[], next: Message[]) {
  if (current.length !== next.length) return true
  return current.some((message, index) => {
    const nextMessage = next[index]
    return !nextMessage || String(message.id) !== String(nextMessage.id) || message.text !== nextMessage.text
  })
}

function hasIncomingChange(current: Message[], next: Message[]) {
  const currentIds = new Set(current.map((message) => String(message.id)))
  return next.some((message) => !message.outgoing && !currentIds.has(String(message.id)))
}

function maxScrollOffset(messages: Message[]) {
  return Math.max(0, messageScrollUnitCount(messages) - 1)
}

function messageThreadKey(state: { chat: Chat; topic?: Topic }) {
  return `${String(state.chat.id)}:${String(topicThreadId(state.topic) ?? '')}`
}

function updateMatchesThread(update: { chatId: Id; topicId?: Id | null }, state: { chat: Chat; topic?: Topic }) {
  if (String(update.chatId) !== String(state.chat.id)) return false
  const stateTopic = topicThreadId(state.topic)
  if (stateTopic === undefined) return update.topicId === undefined || update.topicId === null
  if (update.topicId === undefined || update.topicId === null) return true
  if (String(update.topicId) === String(stateTopic)) return true
  if (state.topic?.topMessageId !== undefined && String(update.topicId) === String(state.topic.topMessageId)) return true
  return true
}

function idAtOrAfter(previous: Id, next: Id) {
  const previousNumber = Number(previous)
  const nextNumber = Number(next)
  if (Number.isFinite(previousNumber) && Number.isFinite(nextNumber)) return previousNumber >= nextNumber
  return String(previous) === String(next)
}

function chatFingerprint(chat: Chat) {
  return `${chat.unreadCount ?? 0}:${chat.lastMessage ?? ''}`
}

function normalizeMessagePage(messages: Message[]) {
  return [...dedupeMessages(messages)].sort(compareMessages)
}

function dedupeMessages(messages: Message[]) {
  const byId = new Map<string, Message>()
  for (const message of messages) {
    byId.set(String(message.id), message)
  }
  return byId.values()
}

function compareMessages(left: Message, right: Message) {
  const leftId = Number(left.id)
  const rightId = Number(right.id)
  if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) {
    return leftId - rightId
  }

  const leftTime = left.sentAt ? Date.parse(left.sentAt) : Number.NaN
  const rightTime = right.sentAt ? Date.parse(right.sentAt) : Number.NaN
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime
  }

  return String(left.id).localeCompare(String(right.id))
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms)
    const maybeNodeTimeout = timeout as unknown as { unref?: () => void }
    maybeNodeTimeout.unref?.()
  })
}

function topicThreadId(topic: Topic | undefined) {
  return topic?.id
}

function activeThreadState(state: AppState):
  | {
    chat: Chat
    topic?: Topic
    back?: RecoverableState
  }
  | undefined {
  if (state.screen === 'sidebar' && state.focus === 'messages') {
    return { chat: state.chat, topic: state.topic, back: state.back }
  }
  switch (state.screen) {
    case 'sidebarRecording':
    case 'sidebarTranscribing':
    case 'sidebarConfirm':
    case 'sidebarSending':
    case 'sidebarSent':
      return { chat: state.chat, topic: state.topic, back: state.back }
    default:
      return undefined
  }
}

function oldestMessageId(messages: { id: string | number }[]) {
  if (messages.length === 0) return undefined
  const numericIds = messages.map((message) => Number(message.id)).filter(Number.isFinite)
  if (numericIds.length === messages.length) return Math.min(...numericIds)
  return messages[messages.length - 1]?.id
}

function newestMessageId(messages: { id: string | number }[]) {
  if (messages.length === 0) return undefined
  const numericIds = messages.map((message) => Number(message.id)).filter(Number.isFinite)
  if (numericIds.length === messages.length) return Math.max(...numericIds)
  return messages[messages.length - 1]?.id
}

function messageBackTarget(previous: RecoverableState): RecoverableState | undefined {
  if (previous.screen === 'sidebar' && previous.focus === 'messages') return previous.back
  return previous
}

function sidebarContext(state: AppState): { chats: Chat[]; selectedChatIndex: number } {
  if (state.screen === 'sidebar' || state.screen === 'sidebarRecording' || state.screen === 'sidebarTranscribing' ||
    state.screen === 'sidebarConfirm' || state.screen === 'sidebarSending' || state.screen === 'sidebarSent') {
    return { chats: state.chats, selectedChatIndex: state.selectedChatIndex }
  }
  if (state.screen === 'newMessage' || state.screen === 'asleep') {
    return { chats: state.chats, selectedChatIndex: state.selectedChatIndex }
  }
  return { chats: [], selectedChatIndex: 0 }
}

function emptyTopicPreview() {
  return {
    previewTopic: undefined,
    previewMessages: undefined,
    previewCursor: undefined,
    previewScrollOffset: undefined,
    previewNewerPages: undefined,
    previewIsNewestPage: undefined,
  }
}

function topicMatchesSelection(state: Extract<AppState, { screen: 'sidebar'; focus: 'topics' }>, topic: Topic) {
  return String(state.topics[state.selectedTopicIndex]?.id ?? '') === String(topic.id)
}

function emptyChatPreview() {
  return {
    previewMessages: undefined,
    previewCursor: undefined,
    previewScrollOffset: undefined,
    previewNewerPages: undefined,
    previewIsNewestPage: undefined,
  }
}

function clearUnreadForThread(state: AppState, chat: Chat, topic: Topic | undefined): AppState {
  const remainingTopicUnread = topic ? remainingUnreadForOtherTopics(state, topic) : undefined
  let changed = false
  const updateBack = (back: RecoverableState | undefined) => {
    if (!back) return back
    const nextBack = clearUnreadForThread(back, chat, topic) as RecoverableState
    if (nextBack !== back) changed = true
    return nextBack
  }
  const updateChat = (item: Chat) => {
    if (String(item.id) !== String(chat.id)) return item
    if (!item.unreadCount) return item
    if (!topic) {
      changed = true
      return { ...item, unreadCount: 0 }
    }
    const nextUnread = remainingTopicUnread ?? 0
    if (item.unreadCount === nextUnread) return item
    changed = true
    return { ...item, unreadCount: nextUnread }
  }
  const updateTopic = (item: Topic) => {
    if (String(item.id) !== String(topic?.id) || !item.unreadCount) return item
    changed = true
    return { ...item, unreadCount: 0 }
  }
  const maybePreviewTopic = (item: Topic | undefined) => {
    if (!item || String(item.id) !== String(topic?.id) || !item.unreadCount) return item
    changed = true
    return { ...item, unreadCount: 0 }
  }

  let next: AppState
  switch (state.screen) {
    case 'sidebar':
      if (state.focus === 'topics') {
        next = {
          ...state,
          chats: state.chats.map(updateChat),
          chat: updateChat(state.chat),
          topics: state.topics.map(updateTopic),
          previewTopic: maybePreviewTopic(state.previewTopic),
        }
        break
      }
      if (state.focus === 'messages') {
        next = {
          ...state,
          chats: state.chats.map(updateChat),
          chat: updateChat(state.chat),
          topic: maybePreviewTopic(state.topic),
          topics: state.topics?.map(updateTopic),
          back: updateBack(state.back),
        }
        break
      }
      next = { ...state, chats: state.chats.map(updateChat) }
      break
    case 'asleep':
      next = { ...state, chats: state.chats.map(updateChat) }
      break
    case 'newMessage':
      next = { ...state, chats: state.chats.map(updateChat), chat: updateChat(state.chat), topic: maybePreviewTopic(state.topic) }
      break
    case 'sidebarRecording':
    case 'sidebarTranscribing':
    case 'sidebarConfirm':
    case 'sidebarSending':
    case 'sidebarSent':
      next = {
        ...state,
        chats: state.chats.map(updateChat),
        chat: updateChat(state.chat),
        topic: maybePreviewTopic(state.topic),
        back: updateBack(state.back),
      }
      break
    default:
      return state
  }
  return changed ? next : state
}

function hasUnreadForThread(state: AppState, chat: Chat, topic: Topic | undefined) {
  if (topic) return unreadForTopic(state, topic) > 0
  return unreadForChat(state, chat) > 0
}

function unreadForChat(state: AppState, chat: Chat) {
  const values: number[] = []
  const collect = (item: Chat | undefined) => {
    if (item && String(item.id) === String(chat.id)) values.push(Number(item.unreadCount ?? 0) || 0)
  }
  switch (state.screen) {
    case 'sidebar':
      state.chats.forEach(collect)
      if (state.focus === 'topics' || state.focus === 'messages') collect(state.chat)
      break
    case 'asleep':
      state.chats.forEach(collect)
      break
    case 'newMessage':
      state.chats.forEach(collect)
      collect(state.chat)
      break
    case 'sidebarRecording':
    case 'sidebarTranscribing':
    case 'sidebarConfirm':
    case 'sidebarSending':
    case 'sidebarSent':
      state.chats.forEach(collect)
      collect(state.chat)
      break
    default:
      break
  }
  return Math.max(0, ...values)
}

function unreadForTopic(state: AppState, topic: Topic) {
  const values: number[] = []
  const collect = (item: Topic | undefined) => {
    if (item && String(item.id) === String(topic.id)) values.push(Number(item.unreadCount ?? 0) || 0)
  }
  if (state.screen === 'sidebar' && state.focus === 'topics') {
    state.topics.forEach(collect)
    collect(state.previewTopic)
  }
  if (state.screen === 'sidebar' && state.focus === 'messages') {
    state.topics?.forEach(collect)
    collect(state.topic)
  }
  if (
    state.screen === 'newMessage' ||
    state.screen === 'sidebarRecording' ||
    state.screen === 'sidebarTranscribing' ||
    state.screen === 'sidebarConfirm' ||
    state.screen === 'sidebarSending' ||
    state.screen === 'sidebarSent'
  ) {
    collect(state.topic)
  }
  return Math.max(0, ...values)
}

function remainingUnreadForOtherTopics(state: AppState, topic: Topic) {
  const topics = state.screen === 'sidebar' && (state.focus === 'topics' || state.focus === 'messages')
    ? state.topics
    : undefined
  if (!topics) return undefined
  return topics
    .filter((item) => String(item.id) !== String(topic.id))
    .reduce((total, item) => total + Math.max(0, Number(item.unreadCount ?? 0) || 0), 0)
}

function hasRecordableAudio(chunks: Uint8Array[]) {
  const sampleBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  if (sampleBytes < 3200) return false

  let nonZeroSamples = 0
  for (const chunk of chunks) {
    for (let index = 0; index + 1 < chunk.length; index += 2) {
      if (chunk[index] !== 0 || chunk[index + 1] !== 0) {
        nonZeroSamples += 1
        if (nonZeroSamples > 20) return true
      }
    }
  }
  return false
}
