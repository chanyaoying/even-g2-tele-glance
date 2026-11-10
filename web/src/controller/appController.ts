import { MAX_RECORDING_BYTES, pcmChunksToWav } from '../audio/wav'
import { BACKEND_AUTH_REJECTED_MESSAGE, isBackendAuthError, isSessionExpiredError, OFFLINE_STATUS, type TelegramApi } from '../api'
import type { Chat, Folder, Id, Message, TelegramUpdate, TelegramTypingUpdate, Topic } from '../types'
import { getLocale } from '../locales'
import { backToMessages, DIDNT_CATCH_STATUS, UPDATING_STATUS } from './model'
import type { AppInput, AppState, RecoverableState, ScreenModel } from './model'
import { anchorMessageId, messageScrollUnitCount, nextMessageScrollOffset, offsetForAnchorMessage, screenModel } from './model'
import { isTeleGlanceFixtureMode, logLifecycleEvent, logRecordingEvent, logStateWork, logTeleGlanceTest, nowMs } from '../testMode'
import { debugLog, errorText } from '../debugLog'
import { consumeInjectedAudioChunks } from '../fixtureApi'
import type { Photo } from '../types'
import type { PersistentCache } from '../cache/persistentCache'
import { LruMap } from './lruMap'
import {
  hasIncomingChange, hasMessageChanges, idAtOrAfter, messageThreadKey, newestMessageId, normalizeMessagePage, oldestMessageId,
  THREAD_CACHE_LIMIT, ThreadStore, topicThreadId, windowNewestMessages,
} from './threadStore'
import { clearUnreadForThread, hasUnreadForThread } from './unreadState'

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
  /** Push photo pixels (a PNG) to the panel image container; resolves true when the glasses accepted it. */
  updateImage?(png: Uint8Array): Promise<boolean>
  /** Resolves when no full page is being drawn or waiting; pictures are sent after it so they land on their page. */
  pageSettled?(): Promise<void>
  setAudioEnabled(enabled: boolean): Promise<void>
  getLocalStorage?(key: string): Promise<string>
  setLocalStorage?(key: string, value: string): Promise<boolean>
  showExitConfirmation?(): Promise<void>
  turnScreenOff?(): Promise<void>
  dispose?(): void
}

const MESSAGE_PAGE_LIMIT = 8
const SEND_FAILED_STATUS = 'Send failed'
const STARTUP_RETRY_BASE_MS = 5_000
const STARTUP_RETRY_MAX_MS = 60_000
/** While the live update stream is up, polling is only a slow safety net. */
const STREAM_HEALTHY_POLL_MS = 60_000
const TRANSCRIBE_FAILED_STATUS = 'Transcription failed'
/** Ignore a plain click this soon after a hold event (some firmware double-reports). */
const HOLD_PRESS_GUARD_MS = 350
// Older pages are fetched in bigger chunks than the first page: a history call costs about the same for 8
// or 24 messages, and a bigger chunk means far fewer waits at the edge of loaded history while scrolling.
const OLDER_PAGE_LIMIT = 24
// Optimistic folder loading: once the chat list is up and the user is idle, fetch each folder's first page
// so switching folders later is instant.
const FOLDER_WARM_DELAY_MS = 2500
const OLDER_PREFETCH_LOW_WATER = 14
const PHOTO_CACHE_LIMIT = 64
const PHOTO_PREFETCH_COUNT = 2
/** A picture that failed to load is tried once more after this long if it is still on screen. */
const PHOTO_RETRY_DELAY_MS = 4_000
const CHAT_LIST_LIMIT = 20
// When the selection gets this close to the end of the loaded chats, fetch the next page.
const CHAT_LOAD_MORE_THRESHOLD = 3
const LOADING_OLDER_STATUS = 'Loading older messages...'
const RENDER_DEFER_MS = 0
const RENDER_COOLDOWN_MS = 60
const INPUT_QUIET_MS = 900
const IMAGE_SEND_DELAY_MS = 350
const IMAGE_MAX_WAIT_MS = 1500
const TOPIC_PREVIEW_IDLE_MS = 200
const DEFAULT_RUNTIME_CONFIG: ControllerRuntimeConfig = {
  messagePressDelayMs: 260,
  messagePollMs: 3000,
  chatPollMs: 5000,
  recordingMinDurationMs: 900,
  language: 'en',
  /** A list-selection event this soon after a swipe is the firmware's post-scroll echo, not a press. */
  swipeToPressDebounceMs: 200,
  selectionOnlyPressDelayMs: 400,
  // How long after a full `bridge.render()` a list click counts as post-firmware-reset: the G2 firmware (and the
  // simulator) reset the tracked list-selection index to 0 on every full page rebuild, and the next click
  // reports the post-reset index. Inside this window the controller's state is trusted instead of the payload.
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
  private state: AppState = { screen: 'loading', message: getLocale().errorStarting }
  private runtimeConfig: ControllerRuntimeConfig
  private listeners = new Set<StateListener>()
  private messagePoll: ReturnType<typeof setInterval> | undefined
  private chatPoll: ReturnType<typeof setInterval> | undefined
  private pendingMessagePress: ReturnType<typeof setTimeout> | undefined
  private holdRecording = false
  /** Bytes of audio in the current recording's `chunks` (a running total, not re-summed per chunk). */
  private recordedBytes = 0
  private autoStopping = false
  private lastHoldEventAt = 0
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
  /** True while the chat list shown came from the on-phone cache and the real one has not arrived yet. */
  private showingStoredChats = false
  /**
   * Thread opened from a stale stored page (it had unread messages) whose fresh page has not arrived yet. Until
   * it does, nothing is marked read and no "last read" divider is placed: both need the fresh page.
   */
  private staleThreadKey: string | undefined
  /** One automatic retry of a picture that failed to load while it is still on screen. */
  private photoRetryTimer: ReturnType<typeof setTimeout> | undefined
  /** A reply send is running; a second press must not start another one. */
  private sendInFlight = false
  /** The startup run in progress, so a foreground event during startup reuses it instead of starting another. */
  private initPromise: Promise<void> | undefined
  /** Startup could not reach the backend while the stored chat list is shown: try again later. */
  private startupRetryTimer: ReturnType<typeof setTimeout> | undefined
  private startupRetryDelayMs = STARTUP_RETRY_BASE_MS
  /** The live update stream is connected; polling then only runs as a slow safety net. */
  private streamHealthy = false
  /** An update arrived while a refresh was running: run one more refresh when it finishes. */
  private rootRefreshDirty = false
  private messageRefreshDirty = false
  /** The last send that failed, so a retry first checks whether it actually went through. */
  private failedSend: { key: string; startedAt: number } | undefined
  /** What pressing on the error screen runs again (undefined: go back to the screen before the error). */
  private errorRetry: (() => Promise<void>) | undefined
  // Telegram chat folders. `activeFolderId === undefined` means "All chats".
  private folders: Folder[] = []
  private activeFolderId: Id | undefined
  private chatsHasMore = false
  private loadingMoreChats = false
  private folderSwitchId = 0
  private folderChatsCache = new LruMap<string, { chats: Chat[]; hasMore: boolean }>(THREAD_CACHE_LIMIT)
  private folderWarmGeneration = 0
  private photoCache = new LruMap<string, Photo>(PHOTO_CACHE_LIMIT)
  private photoInFlight = new Map<string, Promise<Photo>>()
  private messageRefreshInFlight = false
  private topicPreviewDebounce: ReturnType<typeof setTimeout> | undefined
  private deferredRootRefreshTimer: ReturnType<typeof setTimeout> | undefined
  private deferredMessageRefreshTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * Latest page and topic list per thread, unread points and read marks (LRU-capped). The latest page is the
   * single source for opening a thread instantly and for topic previews; filled on demand and by refreshes.
   */
  private readonly threads: ThreadStore
  private topicPreviewInFlight = new Set<string>()
  private topicsPrefetchInFlight = new Map<string, Promise<Topic[]>>()
  private messagePrefetchInFlight = new Map<string, Promise<Message[]>>()
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
  // Also covers the photo container: a layout key, not a boolean (see `panelLayoutKey`).
  private lastRenderedHasPanelBox = ''
  // Snapshot of the most recent sidebar page rendered on the glasses. Partial
  // rendering is only valid while focus stays on the same input surface because
  // TextContainerUpgrade cannot change event-capture flags.
  private lastRenderedListItems: readonly string[] | undefined
  private renderInFlight = false
  // Timestamp of the most recent full `bridge.render()` call. The G2 firmware
  // (and the simulator) reset their tracked list-selection index to 0 on
  // every full page rebuild, so a click arriving within `firmwareResetWindowMs`
  // of a full rebuild carries a post-reset `currentSelectItemIndex`, not the
  // user's tap. See `docs/SDK_BUG_NATIVE_LIST_SELECTION.md`.
  private lastFullRenderAt = 0
  private pendingRenderState: AppState | undefined
  private renderTimer: ReturnType<typeof setTimeout> | undefined
  private notifyTimer: ReturnType<typeof setTimeout> | undefined
  private notifyPending = false
  private openRequestId = 0
  private inputQuietUntil = 0
  private typingTimer: ReturnType<typeof setTimeout> | undefined
  private imageTimer: ReturnType<typeof setTimeout> | undefined
  /** True once scrolling has paused, so a picture page may carry its picture. */
  private imagesSettled = false
  private imageDeferredSince = 0
  private lastUserInputAt = 0
  constructor(
    private readonly api: TelegramApi,
    private readonly bridge: GlassesBridge,
    options: Partial<ControllerRuntimeConfig> | number = {},
    private readonly onTelegramSession?: (session: string) => void,
    private readonly hasTelegramCredentials: () => boolean = () => true,
    private readonly cache?: PersistentCache,
  ) {
    this.threads = new ThreadStore(cache)
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
    this.folderWarmGeneration += 1
    this.stopMessagePolling()
    this.stopChatPolling()
    for (const timer of [
      this.pendingMessagePress,
      this.topicPreviewDebounce,
      this.deferredRootRefreshTimer,
      this.deferredMessageRefreshTimer,
      this.readAckFlushTimer,
      this.startupPrefetchTimer,
      this.renderTimer,
      this.imageTimer,
      this.startupRetryTimer,
      this.notifyTimer,
      this.typingTimer,
      this.photoRetryTimer,
    ]) {
      if (timer) clearTimeout(timer)
    }
    this.pendingMessagePress = undefined
    this.topicPreviewDebounce = undefined
    this.deferredRootRefreshTimer = undefined
    this.deferredMessageRefreshTimer = undefined
    this.readAckFlushTimer = undefined
    this.startupPrefetchTimer = undefined
    this.renderTimer = undefined
    this.imageTimer = undefined
    this.startupRetryTimer = undefined
    this.notifyTimer = undefined
    this.typingTimer = undefined
    this.photoRetryTimer = undefined
    this.pendingRenderState = undefined
    this.listeners.clear()
  }

  async sendTextFromPhone(text: string) {
    const state = this.state
    const thread = activeThreadState(state)
    if (!thread) throw new Error(getLocale().phoneOpenChatFirst)
    const trimmed = text.trim()
    if (!trimmed) return
    const ctx = sidebarContext(state)
    // The phone keeps its draft unless this resolves, so a send that did not happen must throw.
    if (this.sendInFlight) throw new Error(getLocale().phoneSendSkipped)
    this.sendInFlight = true
    let sent: Message
    try {
      sent = await this.sendWithDuplicateCheck(thread, trimmed)
    } catch (error) {
      debugLog('send', { ok: false, from: 'phone', error: errorText(error) })
      if (!(await this.handleAuthFailure(error))) {
        // Like a failed glasses send: the thread stays open with a short status; the phone shows the error.
        const current = this.state
        if (current.screen === 'sidebar' && current.focus === 'messages' && messageThreadKey(current) === messageThreadKey(thread)) {
          await this.setState({ ...current, status: SEND_FAILED_STATUS })
        }
      }
      throw error
    } finally {
      this.sendInFlight = false
    }
    await this.run(async () => {
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
    if (this.patchChatFromUpdate(update)) return
    if (state.screen === 'sidebar' && state.focus === 'chats' || state.screen === 'asleep' || state.screen === 'newMessage') {
      await this.refreshRootChats()
      return
    }
    if (state.screen === 'sidebar' && state.focus === 'messages' && updateMatchesThread(update, state)) {
      // The stream already carries the whole message, so merge it instead of refetching the page.
      // Polling stays on as the safety net and fills in anything the stream could not (for example edits).
      if (update.message && String(update.message.id) !== '') {
        await this.applyIncomingMessages([update.message])
        return
      }
      await this.refreshVisibleMessages()
    }
  }

  /** The live stream dropped and came back: catch up on whatever was missed meanwhile. */
  async handleStreamReconnect() {
    const state = this.state
    if (state.screen === 'sidebar' && state.focus === 'messages') {
      await this.refreshVisibleMessages({ background: true })
    } else if ((state.screen === 'sidebar' && state.focus === 'chats') || state.screen === 'asleep' || state.screen === 'newMessage') {
      await this.refreshRootChats({ background: true })
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

  /** Start (or restart) the session. A call while one is still running joins it instead of starting another. */
  init(): Promise<void> {
    this.initPromise ??= this.initOnce().finally(() => {
      this.initPromise = undefined
    })
    return this.initPromise
  }

  private async initOnce() {
    this.cancelStartupRetry()
    // Read the stored chat list before drawing anything: when there is one, the glasses go straight to it and never
    // show the "Checking Telegram session..." screen (every extra page costs the glasses link a rebuild).
    // The network request starts first so it runs while the stored list is read and drawn.
    const hasCredentials = this.hasTelegramCredentials()
    const chatsRequest = hasCredentials ? this.api.listChats(CHAT_LIST_LIMIT) : undefined
    chatsRequest?.catch(() => undefined)
    const storedChats = hasCredentials ? await this.cache?.getChats().catch(() => undefined) : undefined
    if (storedChats && storedChats.length > 0) {
      this.showingStoredChats = true
      await this.setState(this.chatsState(storedChats, 0, { status: UPDATING_STATUS }))
    } else {
      await this.setState({ screen: 'loading', message: getLocale().authChecking })
    }
    await this.connectSession(chatsRequest)
  }

  /**
   * Check the session and load the chat list. When that fails while the stored chat list is on the glasses,
   * the list stays (marked offline) and this runs again later, instead of replacing it with an error page.
   */
  private async connectSession(chatsRequest?: Promise<Chat[]>) {
    try {
      await this.connectSessionOnce(chatsRequest)
      this.startupRetryDelayMs = STARTUP_RETRY_BASE_MS
    } catch (error) {
      if (await this.handleAuthFailure(error)) return
      const shown = this.state
      // The user may already be anywhere in the stored data (even on an error screen of their own, which has its
      // own way back): stay there and try again later. Only the chat list itself shows the offline mark here; an
      // open thread gets it from its own refresh.
      if (this.showingStoredChats && shown.screen !== 'loading' && shown.screen !== 'auth') {
        debugLog('startup.offline', { error: errorText(error), retryMs: this.startupRetryDelayMs })
        const status = isBackendAuthError(error) ? BACKEND_AUTH_REJECTED_MESSAGE : OFFLINE_STATUS
        if (shown.screen === 'sidebar' && shown.focus === 'chats' && shown.status !== status) await this.setState({ ...shown, status })
        this.scheduleStartupRetry()
        return
      }
      await this.showError(error)
    }
  }

  private scheduleStartupRetry() {
    this.cancelStartupRetry()
    const delay = this.startupRetryDelayMs
    this.startupRetryDelayMs = Math.min(STARTUP_RETRY_MAX_MS, this.startupRetryDelayMs * 2)
    this.startupRetryTimer = setTimeout(() => {
      this.startupRetryTimer = undefined
      void this.retryStartup()
    }, delay)
    const maybeNodeTimeout = this.startupRetryTimer as unknown as { unref?: () => void }
    maybeNodeTimeout.unref?.()
  }

  private cancelStartupRetry() {
    if (this.startupRetryTimer) clearTimeout(this.startupRetryTimer)
    this.startupRetryTimer = undefined
  }

  private async retryStartup() {
    this.cancelStartupRetry()
    if (!this.showingStoredChats || this.initPromise) return
    // Safe from any screen: once the user has left the stored chat list, the fresh list is applied without
    // moving them (see loadChats).
    await this.connectSession()
  }

  private async connectSessionOnce(chatsRequest?: Promise<Chat[]>) {
    if (!this.hasTelegramCredentials()) {
      await this.setState({
        screen: 'auth',
        mode: 'needsSetup',
        message: getLocale().authNeedsSetup,
      })
      return
    }
    // The chat list request is already running; it is dropped if the session is not authorized.
    const status = await this.api.authStatus()
    if (!status.authorized) {
      this.showingStoredChats = false
      void this.cache?.clear()
      const hasFrontendCredentials = this.hasTelegramCredentials()
      const l = getLocale()
      await this.setState({
        screen: 'auth',
        mode: hasFrontendCredentials ? 'signedOut' : 'needsSetup',
        message: !hasFrontendCredentials || status.configured === false
          ? `${l.authNotConnected} ${l.authConnectViaSettings}`
          : `${l.authNotConnected} ${l.authSignedOut}`,
      })
      return
    }
    // Awaited here (not inside loadChats) so a failure reaches connectSession and can keep the stored list.
    const chats = await (chatsRequest ?? this.api.listChats(CHAT_LIST_LIMIT))
    await this.loadChats(undefined, Promise.resolve(chats))
  }

  async dispatch(input: AppInput) {
    if (input.type !== 'audioChunk') {
      this.noteUserInput()
      debugLog('input', { type: input.type, screen: this.state.screen, focus: 'focus' in this.state ? this.state.focus : undefined })
    }
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
      const screen = this.state.screen
      // Never restart over a login code that is being entered on the phone.
      if (this.state.screen === 'auth' && this.state.mode === 'phonePending') return
      if (screen === 'loading' || screen === 'auth' || screen === 'error') {
        await this.init()
        return
      }
      if (this.startupRetryTimer) {
        await this.retryStartup()
        return
      }
      // The session is already loaded: refresh what is on screen without losing the user's place.
      const here = this.state
      if (here.screen === 'sidebar' && here.focus === 'messages') void this.refreshVisibleMessages()
      else if (here.screen === 'sidebar' && here.focus === 'chats') void this.refreshRootChats()
      else if (here.screen === 'newMessage') void this.refreshRootChats()
      return
    }

    if (input.type === 'longPress' || input.type === 'longPressRelease') {
      const here = this.state
      const inMessages = here.screen === 'sidebar' && here.focus === 'messages'
      if (!inMessages && here.screen !== 'sidebarRecording') { debugLog('hold.ignored', { type: input.type, screen: here.screen }); return } // hold gestures only mean something here
      this.lastHoldEventAt = Date.now()
    } else if (input.type === 'press' && Date.now() - this.lastHoldEventAt < HOLD_PRESS_GUARD_MS && (this.state.screen === 'sidebarRecording' || (this.state.screen === 'sidebar' && this.state.focus === 'messages'))) {
      debugLog('press.dropped-near-hold', { screen: this.state.screen })
      return // some firmware also reports a click around a hold; never let it start/stop a recording
    }

    if (input.type === 'audioChunk') {
      if (this.state.screen === 'sidebarRecording') {
        if (this.recordedBytes + input.pcm.byteLength > MAX_RECORDING_BYTES) {
          // Out of room: stop and transcribe what we have instead of waiting for a release that may never come.
          if (!this.autoStopping) {
            this.autoStopping = true
            void this.dispatch({ type: this.holdRecording ? 'longPressRelease' : 'press' }).finally(() => { this.autoStopping = false })
          }
          return // keep the upload under the server cap
        }
        // Appended in place: copying the whole chunk list for every chunk made a recording O(n²). The chunk
        // list belongs to this recording only, and nothing is notified per chunk.
        this.state.chunks.push(input.pcm)
        this.recordedBytes += input.pcm.byteLength
        if (isTeleGlanceFixtureMode()) {
          logRecordingEvent('audioChunk', {
            size: input.pcm.byteLength,
            totalBytes: this.recordedBytes,
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
        const size = injected.reduce((sum, chunk) => sum + chunk.byteLength, 0)
        this.state.chunks.push(...injected)
        this.recordedBytes += size
        if (isTeleGlanceFixtureMode()) {
          logRecordingEvent('audioChunk', { size, totalBytes: this.recordedBytes, chunks: this.state.chunks.length, injected: true })
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
        // `swipeToPressDebounceMs` window (200 ms by default) covers the firmware's typical post-swipe
        // event burst without noticeably slowing intentional press-after-swipe sequences.
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
          message: getLocale().authNeedsSetup,
        })
        return
      }
      if (state.mode === 'signedOut') {
        await this.setState({
          ...state,
          message: getLocale().authSignedOut,
        })
        return
      }

      if (state.mode === 'phonePending') return
    }, state)
  }

  async startPhoneLogin(phone: string) {
    const trimmed = phone.trim()
    if (!trimmed) return
    let loginError: unknown
    await this.run(async () => {
      if (!this.hasTelegramCredentials()) {
        await this.setState({
          screen: 'auth',
          mode: 'needsSetup',
          message: `${getLocale().authNotConnected} ${getLocale().authAddCredentialsFirst}`,
        })
        return
      }
      const before = this.state
      let result: Awaited<ReturnType<TelegramApi['startPhoneAuth']>>
      try {
        result = await this.api.startPhoneAuth(trimmed)
      } catch (error) {
        // Stay on the sign-in screen (the phone shows the error next to the form) instead of an error page.
        debugLog('phone-login', { ok: false, error: errorText(error) })
        if (before.screen === 'auth') await this.setState({ ...before, message: error instanceof Error ? error.message : String(error) })
        loginError = error
        return
      }
      await this.setState({
        screen: 'auth',
        mode: 'phonePending',
        phone: result.phone || trimmed,
        phoneCodeHash: result.phoneCodeHash ?? null,
        message: result.message ?? getLocale().authPhonePending.replace('{phone}', result.phone || trimmed),
      })
    }, this.state.screen === 'auth' ? this.state : undefined)
    if (loginError !== undefined) throw loginError
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
        message: status.message ?? getLocale().authCodeRejected,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : getLocale().authCodeRejected
      const expired = /expired/i.test(message)
      await this.setState({
        screen: 'auth',
        mode: expired ? 'signedOut' : 'phonePending',
        phone: trimmedPhone,
        phoneCodeHash: expired ? null : phoneCodeHash,
        message: expired
          ? `${message}. ${getLocale().authCodeExpired}`
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
    if (isTeleGlanceFixtureMode()) logLifecycleEvent('wake', { selectedChatIndex: state.selectedChatIndex })
    await this.setState(this.chatsState(state.chats, state.selectedChatIndex))
    // Nothing polls while asleep; without the live stream the list may be stale, so refresh it now.
    if (!this.streamHealthy) void this.refreshRootChats({ background: true })
  }

  private async handleNewMessage(state: Extract<AppState, { screen: 'newMessage' }>, input: AppInput) {
    if (input.type === 'doublePress') {
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
    if (input.type === 'longPress') {
      // Hold to record: start now, skipping the double-click wait.
      this.cancelPendingMessagePress()
      this.holdRecording = true
      debugLog('hold.start', {})
      await this.startRecordingFromMessages(state, sidebarContext(state))
      return
    }
    // Recording is hold-to-record only. The simulator fixture harness cannot hold, so it keeps tap-to-record.
    if (input.type !== 'press' || !isTeleGlanceFixtureMode()) return

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
    const cached = this.threads.page({ chat, topic })
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
      this.threads.putPage({ chat, topic }, normalized, { persist: false })
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

  /**
   * Synchronous cache lookup for the topic preview path.
   */
  private getTopicPreviewCached(chat: Chat, topic: Topic) {
    return this.threads.page({ chat, topic })
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
    this.recordedBytes = 0
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
      this.holdRecording = false
      void this.bridge.setAudioEnabled(false).catch(() => undefined)
      await this.setState(backToMessages(state))
      return
    }
    if (input.type === 'longPressRelease' && !this.holdRecording) return
    if (input.type === 'press' && !isTeleGlanceFixtureMode()) return // stop is by releasing the hold
    if (input.type !== 'press' && input.type !== 'longPressRelease') return
    this.holdRecording = false
    debugLog('record.stop', {
      via: input.type,
      bytes: this.recordedBytes,
      chunks: state.chunks.length,
      heldMs: Date.now() - state.startedAt,
    })
    await this.setState({ ...backToMessages(state), screen: 'sidebarTranscribing' as const })
    if (isTeleGlanceFixtureMode()) {
      logRecordingEvent('stop', { totalBytes: this.recordedBytes, chunks: state.chunks.length })
      logRecordingEvent('transcribe.start', { chunks: state.chunks.length })
    }
    void this.bridge.setAudioEnabled(false).catch(() => undefined)
    const didntCatch = () => this.setState(backToMessages(state, { status: DIDNT_CATCH_STATUS }))
    if (!hasRecordableAudio(state.chunks)) {
      debugLog('record.unusable', { chunks: state.chunks.length })
      if (isTeleGlanceFixtureMode()) logRecordingEvent('transcribe.end', { transcript: '', rejected: true })
      await didntCatch()
      return
    }
    const wav = pcmChunksToWav(state.chunks)
    const transcribeOnce = async () => {
      await this.setState({ ...backToMessages(state), screen: 'sidebarTranscribing' as const })
      let transcript: string
      try {
        const startedAt = Date.now()
        const result = await this.api.transcribe(wav, this.runtimeConfig.language)
        transcript = result.text.trim()
        debugLog('transcribe', { ok: true, chars: transcript.length, durationMs: Date.now() - startedAt })
      } catch (error) {
        debugLog('transcribe', { ok: false, error: errorText(error) })
        // The server rejects near-silent audio: that is "nothing heard", not a failure of the app.
        if (error instanceof Error && /silent/i.test(error.message)) {
          if (isTeleGlanceFixtureMode()) logRecordingEvent('transcribe.end', { transcript: '', rejected: true })
          await didntCatch()
          return
        }
        // Any other failure also returns to the thread with a short status instead of an error screen.
        await this.setState(backToMessages(state, { status: TRANSCRIBE_FAILED_STATUS }))
        return
      }
      if (isTeleGlanceFixtureMode()) logRecordingEvent('transcribe.end', { transcript })
      if (transcript.length === 0) {
        await didntCatch()
        return
      }
      await this.setState({
        ...backToMessages(state),
        screen: 'sidebarConfirm' as const,
        transcript,
        selectedIndex: 0,
      })
    }
    // A transcription failure keeps the recording: pressing on the error screen transcribes it again.
    await this.run(transcribeOnce, backToMessages(state), transcribeOnce)
  }

  private async handleSidebarConfirm(
    state: Extract<AppState, { screen: 'sidebarConfirm' }>, input: AppInput
  ) {
    if (input.type === 'swipeUp' || input.type === 'swipeDown') {
      await this.setState({ ...state, selectedIndex: state.selectedIndex === 0 ? 1 : 0 })
      return
    }
    if (input.type === 'doublePress') {
      await this.setState(backToMessages(state))
      return
    }
    if (input.type !== 'press') return

    if (state.selectedIndex === 1) {
      await this.setState(backToMessages(state))
      return
    }

    // A second press while the send is in flight must never send the same reply twice.
    if (this.sendInFlight) return
    this.sendInFlight = true
    try {
      await this.setState({ ...backToMessages(state), screen: 'sidebarSending' as const, transcript: state.transcript })
      if (isTeleGlanceFixtureMode()) logRecordingEvent('confirm', { selected: 'send', transcript: state.transcript })
      if (isTeleGlanceFixtureMode()) logRecordingEvent('send.start', { chatId: state.chat.id, topicId: state.topic?.id ?? null, transcript: state.transcript })
      let sent: Message
      try {
        sent = await this.sendWithDuplicateCheck(state, state.transcript)
      } catch (error) {
        // Back to the thread with a short status; the duplicate guard keeps a retry from sending twice.
        debugLog('send', { ok: false, error: errorText(error) })
        await this.setState(backToMessages(state, { status: SEND_FAILED_STATUS }))
        return
      }
      await this.run(async () => {
        const refreshed = await this.refreshLatestMessages(state).catch(() => [])
        const messages = refreshed.some((message) => String(message.id) === String(sent.id))
          ? refreshed
          : normalizeMessagePage([...refreshed, sent])
        await this.setState(backToMessages(state, {
          messages,
          cursor: oldestMessageId(messages),
          status: 'Sent',
          newerPages: [],
          isNewestPage: true,
          scrollOffset: 0,
          typing: state.typing ?? null,
        }))
        void this.refreshAfterSend(state, sent)
      }, state)
    } finally {
      this.sendInFlight = false
    }
  }

  /**
   * Send a text reply. After a failed attempt the message may still have reached Telegram (a client-side
   * timeout does not mean the server gave up), so look for the same text from me in the newest page
   * before trying again and right after a failure, and reuse that message instead of sending a duplicate.
   */
  private async sendWithDuplicateCheck(thread: { chat: Chat; topic?: Topic }, text: string): Promise<Message> {
    const key = `${messageThreadKey(thread)}\u0000${text}`
    const failed = this.failedSend?.key === key ? this.failedSend : undefined
    if (failed) {
      const landed = await this.findSentCopy(thread, text, failed.startedAt)
      if (landed) {
        this.failedSend = undefined
        return landed
      }
    }
    const startedAt = failed?.startedAt ?? Date.now()
    try {
      const sent = await this.api.sendMessage(thread.chat.id, { text, topicId: topicThreadId(thread.topic) })
      this.failedSend = undefined
      debugLog('send', { ok: true, chars: text.length })
      return sent
    } catch (error) {
      this.failedSend = { key, startedAt }
      const landed = await this.findSentCopy(thread, text, startedAt)
      if (landed) {
        this.failedSend = undefined
        return landed
      }
      throw error
    }
  }

  private async findSentCopy(thread: { chat: Chat; topic?: Topic }, text: string, since: number): Promise<Message | undefined> {
    try {
      const page = await this.refreshLatestMessages(thread)
      return page.find((message) => {
        if (!message.outgoing || message.text.trim() !== text.trim()) return false
        const at = message.sentAt ? Date.parse(message.sentAt) : NaN
        return Number.isNaN(at) || at >= since - 60_000
      })
    } catch {
      return undefined
    }
  }

  private async handleSidebarSent(
    state: Extract<AppState, { screen: 'sidebarSent' }>, input: AppInput
  ) {
    if (input.type === 'doublePress') {
      await this.setState(this.chatsState(state.chats, state.selectedChatIndex))
      return
    }
    if (input.type === 'press') {
      const messages = await this.refreshLatestMessages(state)
      await this.setState(backToMessages(state, {
        messages, cursor: oldestMessageId(messages),
        status: undefined, newerPages: [], isNewestPage: true, scrollOffset: 0,
      }))
    }
  }

  private async handleError(state: Extract<AppState, { screen: 'error' }>, input: AppInput) {
    if (input.type === 'doublePress' && state.previous) {
      await this.setState(state.previous)
      return
    }
    if (input.type === 'doublePress') {
      // Nothing to go back to (startup failed): double-press means leave the app, as on the sign-in screen.
      await this.bridge.showExitConfirmation?.()
      return
    }
    if (input.type === 'press') {
      // Retry the action that failed instead of restarting at the chat list.
      const retry = this.errorRetry
      this.errorRetry = undefined
      if (state.previous) await this.setState(state.previous)
      if (retry) {
        await this.run(retry, state.previous, retry)
      } else if (!state.previous) {
        await this.init()
      }
    }
  }

  private async loadChats(previous?: RecoverableState, request?: Promise<Chat[]>) {
    await this.run(async () => {
      const chats = await (request ?? this.api.listChats(CHAT_LIST_LIMIT))
      this.folders = []
      this.activeFolderId = undefined
      this.chatsHasMore = chats.length >= CHAT_LIST_LIMIT
      this.loadingMoreChats = false
      this.folderChatsCache.clear()
      this.folderSwitchId += 1
      this.rememberChats(chats)
      this.cache?.putChats(chats)
      // If the stored list is on screen, keep the user's place in it by chat id.
      const shown = this.state
      const wasStored = this.showingStoredChats
      this.showingStoredChats = false
      if (wasStored && !(shown.screen === 'sidebar' && shown.focus === 'chats')) {
        // The user already left the stored list (opened a chat, went to sleep...): never pull them back. The
        // fresh list replaces every stored copy, so going back shows it.
        await this.setStateWithoutRender(this.withFreshChats(shown, chats))
      } else {
        const keptChatId = wasStored && shown.screen === 'sidebar' && shown.focus === 'chats'
          ? String(shown.chats[shown.selectedChatIndex]?.id)
          : undefined
        const keptIndex = keptChatId === undefined ? -1 : chats.findIndex((chat) => String(chat.id) === keptChatId)
        await this.setState(this.chatsState(chats, keptIndex >= 0 ? keptIndex : 0))
      }
      // Folders are optional and never block the chat list: apply them whenever they arrive.
      const generation = this.folderSwitchId
      void this.api.listFolders().then(async (folders) => {
        if (generation !== this.folderSwitchId || folders.length === 0) return
        this.folders = folders
        const current = this.state
        if (current.screen === 'sidebar' && current.focus === 'chats' && this.activeFolderId === undefined) {
          await this.setState({ ...current, folderLabel: this.folderLabel() })
        }
        this.scheduleFolderWarm()
      }).catch(() => undefined)
      // The chat list has no preview panel, so nothing is fetched until a chat is opened.
    }, previous)
  }

  /** `state` with every carried chat list (including the screens to go back to) replaced by `chats`. */
  private withFreshChats<T extends AppState>(state: T, chats: Chat[]): T {
    if (state.screen === 'error') {
      return (state.previous ? { ...state, previous: this.withFreshChats(state.previous, chats) } : state) as T
    }
    if (!('chats' in state)) return state
    const selectedId = state.chats[state.selectedChatIndex]?.id
    const index = selectedId === undefined ? -1 : chats.findIndex((chat) => String(chat.id) === String(selectedId))
    const next = { ...state, chats, selectedChatIndex: index >= 0 ? index : 0 } as T & { back?: RecoverableState; chat?: Chat; topic?: Topic }
    if ('back' in state && state.back) next.back = this.withFreshChats(state.back as RecoverableState, chats)
    // A thread still waiting for its fresh page plans its unread divider from the chat's unread count: use the
    // fresh count rather than the stored one.
    if (state.screen === 'sidebar' && state.focus === 'messages' && !state.topic && this.staleThreadKey === messageThreadKey(state)) {
      const freshChat = chats.find((chat) => String(chat.id) === String(state.chat.id))
      if (freshChat) next.chat = freshChat
    }
    return next
  }

  /**
   * Apply a live message to the chat list without asking the server for the whole list again.
   * Only safe for my own messages in plain chats already listed: unread counts and the new-message
   * notice depend on server state, so everything else still takes the full refresh.
   */
  private patchChatFromUpdate(update: TelegramUpdate): boolean {
    if (!update.message.outgoing || this.activeFolderId !== undefined) return false
    const current = this.state
    if (current.screen !== 'sidebar' || current.focus !== 'chats') return false
    const index = current.chats.findIndex((chat) => String(chat.id) === String(update.chatId))
    if (index < 0 || current.chats[index].isForum) return false
    const patched: Chat = { ...current.chats[index], lastMessage: update.message.text }
    const chats = [patched, ...current.chats.filter((_, i) => i !== index)]
    this.rememberChats(chats)
    this.cache?.putChats(chats)
    // Keep the highlight on the same chat if it was not the one that moved.
    const selected = current.selectedChatIndex === index ? 0 : current.selectedChatIndex + (current.selectedChatIndex < index ? 1 : 0)
    void this.setState({ ...current, chats, selectedChatIndex: selected })
    return true
  }

  /** A picture saved on the phone by an earlier session (never throws; storage trouble just means a fetch). */
  private storedPhoto(key: string): Promise<Photo | undefined> {
    if (!this.cache) return Promise.resolve(undefined)
    return this.cache.getPhoto(key).catch(() => undefined)
  }

  /** Photo pixels for a message, fetched once and kept for the next visit (in memory and on the phone). */
  private loadPhoto(chatId: string, messageId: string): Promise<Photo> {
    const key = `${chatId}:${messageId}`
    const cached = this.photoCache.get(key)
    if (cached) return Promise.resolve(cached)
    const inFlight = this.photoInFlight.get(key)
    if (inFlight) return inFlight
    const promise = this.storedPhoto(key)
      .then((stored) => stored ?? this.api.getPhoto(chatId, messageId).then((fresh) => {
        this.cache?.putPhoto(key, fresh)
        return fresh
      }))
      .then((photo) => {
        this.photoCache.set(key, photo)
        return photo
      })
      .finally(() => {
        this.photoInFlight.delete(key)
      })
    this.photoInFlight.set(key, promise)
    return promise
  }

  /**
   * Picture pixels occupy the glasses link for seconds, and every swipe past a picture moves it (a new layout
   * and a new transfer). So pictures are left out while scrolling and added once the user pauses.
   */
  private scheduleImageSettle() {
    this.cancelImage()
    if (!this.imageDeferredSince) this.imageDeferredSince = Date.now()
    this.imageTimer = setTimeout(() => {
      this.imageTimer = undefined
      // Never hold the picture back for long: stray input must not keep it off the glasses forever.
      const waitedTooLong = Date.now() - this.imageDeferredSince > IMAGE_MAX_WAIT_MS
      if (!waitedTooLong && Date.now() - this.lastUserInputAt < IMAGE_SEND_DELAY_MS) {
        this.scheduleImageSettle()
        return
      }
      this.imagesSettled = true
      this.imageDeferredSince = 0
      logTeleGlanceTest('image.settle', { waitedTooLong })
      this.enqueueRender(this.state)
    }, IMAGE_SEND_DELAY_MS)
    const maybeNodeTimeout = this.imageTimer as unknown as { unref?: () => void }
    maybeNodeTimeout.unref?.()
  }

  private cancelImage() {
    if (this.imageTimer !== undefined) clearTimeout(this.imageTimer)
    this.imageTimer = undefined
  }

  /**
   * Fetch a photo page's picture and push it to the glasses, unless the user has scrolled on meanwhile. A picture
   * that fails to load (the backend can be slow) leaves the gap empty and is tried once more after a short delay
   * while it is still on screen; after that it is tried again whenever its page is drawn.
   */
  private async showPanelImage(image: { chatId: string; messageId: string }, retried = false) {
    if (!this.bridge.updateImage) return
    let photo: Photo
    try {
      photo = await this.loadPhoto(image.chatId, image.messageId)
    } catch (error) {
      debugLog('photo.failed', { messageId: image.messageId, retried, error: errorText(error) })
      if (await this.handleAuthFailure(error)) return
      if (!retried) this.schedulePhotoRetry(image)
      return
    }
    await this.bridge.pageSettled?.()
    if (!this.isPanelImageShown(image)) return
    await this.bridge.updateImage(base64ToBytes(photo.data))
  }

  private isPanelImageShown(image: { chatId: string; messageId: string }) {
    const current = this.state
    if (current.screen !== 'sidebar' || current.focus !== 'messages') return false
    const shown = screenModel(current)
    return shown.kind === 'sidebar' && shown.panelImage?.messageId === image.messageId && shown.panelImage.chatId === image.chatId
  }

  private schedulePhotoRetry(image: { chatId: string; messageId: string }) {
    if (this.photoRetryTimer) clearTimeout(this.photoRetryTimer)
    this.photoRetryTimer = setTimeout(() => {
      this.photoRetryTimer = undefined
      if (this.isPanelImageShown(image) && this.imagesSettled) void this.showPanelImage(image, true).catch(() => undefined)
    }, PHOTO_RETRY_DELAY_MS)
    const maybeNodeTimeout = this.photoRetryTimer as unknown as { unref?: () => void }
    maybeNodeTimeout.unref?.()
  }

  /** Warm the newest photos of an opened thread so they are ready when scrolled to. */
  private prefetchPhotos(chat: Chat, messages: Message[]) {
    if (!this.bridge.updateImage) return
    const photos = messages.filter((message) => message.media === 'photo' || message.media === 'sticker').slice(-PHOTO_PREFETCH_COUNT)
    for (const message of photos) {
      void this.loadPhoto(String(chat.id), String(message.id)).catch(() => undefined)
    }
  }

  /** Fetch the first page of every folder in the background, one at a time, never during input. */
  private scheduleFolderWarm() {
    const generation = ++this.folderWarmGeneration
    if (this.folders.length === 0) return
    if (this.startupPrefetchTimer) clearTimeout(this.startupPrefetchTimer)
    const step = async (pending: Folder[]) => {
      if (generation !== this.folderWarmGeneration) return
      const [folder, ...rest] = pending
      if (!folder) return
      if (this.isInputQuiet()) {
        this.startupPrefetchTimer = setTimeout(() => void step(pending), Math.max(250, this.msUntilQuiet()))
        return
      }
      const key = this.folderKey(folder.id)
      if (!this.folderChatsCache.has(key)) {
        try {
          const chats = await this.api.listChats(CHAT_LIST_LIMIT, { folderId: folder.id })
          // Never overwrite a folder the user loaded (and maybe scrolled further) in the meantime.
          if (generation === this.folderWarmGeneration && !this.folderChatsCache.has(key)) {
            this.folderChatsCache.set(key, { chats, hasMore: chats.length >= CHAT_LIST_LIMIT })
          }
        } catch {
          // Warming is best effort; switching to the folder fetches it normally.
        }
      }
      if (generation !== this.folderWarmGeneration) return
      this.startupPrefetchTimer = setTimeout(() => void step(rest), 300)
    }
    this.startupPrefetchTimer = setTimeout(() => void step([...this.folders]), FOLDER_WARM_DELAY_MS)
    const maybeNodeTimeout = this.startupPrefetchTimer as unknown as { unref?: () => void }
    maybeNodeTimeout.unref?.()
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
      // Leaving the picker lands on the top of the chat list (the "main page"), not on whichever row
      // was highlighted before the picker opened.
      await this.setState(this.chatsState(state.chats, 0))
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
      const memoryTopics = this.threads.topics(chat.id)
      // A topic list stored by an earlier session opens the chat at once (also offline); it is refreshed behind it.
      const storedTopics = memoryTopics ? undefined : await this.threads.loadStoredTopics(chat.id)
      if (requestId !== this.openRequestId) return
      if (storedTopics) {
        await this.setState({
          screen: 'sidebar', focus: 'topics',
          chats, selectedChatIndex,
          chat, topics: storedTopics, selectedTopicIndex: 0,
        })
        this.debounceTopicPreviewFetch(chat, storedTopics, 0)
        void this.refreshTopicsInBackground(chat, requestId)
        return
      }
      const cachedTopics = memoryTopics
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

  /**
   * Fetch the topic list of a forum chat opened from its stored list and swap it in, keeping the selected topic.
   * Never throws: a failure marks the screen offline (an expired session signs out), and opening the chat again
   * retries.
   */
  private async refreshTopicsInBackground(chat: Chat, requestId: number) {
    let topics: Topic[]
    try {
      topics = await this.api.listTopics(chat.id)
    } catch (error) {
      debugLog('topics.refresh-failed', { error: errorText(error) })
      if (await this.handleAuthFailure(error)) return
      const current = this.state
      if (requestId === this.openRequestId && current.screen === 'sidebar' && current.focus === 'topics' && String(current.chat.id) === String(chat.id)) {
        const status = isBackendAuthError(error) ? BACKEND_AUTH_REJECTED_MESSAGE : OFFLINE_STATUS
        if (current.status !== status) await this.setState({ ...current, status })
      }
      return
    }
    this.threads.putTopics(chat.id, topics)
    const current = this.state
    if (current.screen !== 'sidebar' || current.focus !== 'topics' || String(current.chat.id) !== String(chat.id)) return
    if (topics.length === 0) {
      if (current.status) await this.setState({ ...current, status: undefined })
      return
    }
    const selectedId = current.topics[current.selectedTopicIndex]?.id
    const index = topics.findIndex((topic) => String(topic.id) === String(selectedId))
    const selectedTopicIndex = index >= 0 ? index : 0
    const sameSelection = index >= 0
    await this.setState({
      ...current,
      topics,
      selectedTopicIndex,
      status: undefined,
      ...(sameSelection ? {} : emptyTopicPreview()),
    })
    if (!sameSelection) this.debounceTopicPreviewFetch(chat, topics, selectedTopicIndex)
  }

  /** True while the user is reading up from the newest message in a thread that had unread messages. */
  private isReadingFromUnread(state: Extract<AppState, { screen: 'sidebar'; focus: 'messages' }>) {
    return (state.scrollOffset ?? 0) > 0 && this.threads.hasUnreadBoundary(state)
  }

  /** New messages arrived while reading above the bottom: keep the same message in view instead of jumping. */
  private keepPlace(state: Extract<AppState, { screen: 'sidebar'; focus: 'messages' }>, next: Message[]) {
    const anchor = anchorMessageId(state.messages, state.scrollOffset ?? 0)
    const offset = anchor === undefined ? undefined : offsetForAnchorMessage(next, anchor)
    return offset ?? state.scrollOffset ?? 0
  }

  private async openMessages(chat: Chat, topic: Topic | undefined, previous: RecoverableState, requestId = ++this.openRequestId) {
    const chats = previous.screen === 'sidebar' ? previous.chats : []
    const selectedChatIndex = previous.screen === 'sidebar' ? previous.selectedChatIndex : 0
    const topics = topic && previous.screen === 'sidebar' && previous.focus === 'topics' ? previous.topics : undefined
    const selectedTopicIndex = topic && previous.screen === 'sidebar' && previous.focus === 'topics' ? previous.selectedTopicIndex : undefined
    await this.run(async () => {
      const ref = { chat, topic }
      const key = messageThreadKey(ref)
      if (this.staleThreadKey === key) this.staleThreadKey = undefined
      const inMemory = this.threads.page(ref)
      const cached = inMemory ?? (await this.threads.loadStoredPage(ref))
      if (cached && requestId !== this.openRequestId) return // the user moved on while the stored page was read
      const fromDisk = Boolean(cached && !inMemory)
      if (cached && fromDisk && (topic ?? chat).unreadCount) {
        // The stored page misses the unread messages, so it is shown as it is (no divider, nothing marked read)
        // until the fresh page arrives and gets the normal unread handling (refreshOpenMessagesInBackground).
        this.staleThreadKey = key
        await this.setState({
          screen: 'sidebar', focus: 'messages',
          chats, selectedChatIndex,
          chat, topic,
          messages: cached.messages,
          cursor: cached.cursor,
          back: messageBackTarget(previous),
          status: UPDATING_STATUS,
          newerPages: [],
          isNewestPage: true,
          scrollOffset: 0,
          topics,
          selectedTopicIndex,
        })
        void this.refreshOpenMessagesInBackground(chat, topic, requestId)
        return
      }
      if (cached) {
        const plan = this.threads.planUnreadOpen({ chat, topic }, cached.messages)
        const openState: AppState = {
          screen: 'sidebar', focus: 'messages',
          chats, selectedChatIndex,
          chat, topic,
          messages: plan.messages,
          cursor: cached.cursor,
          back: messageBackTarget(previous),
          newerPages: [],
          isNewestPage: plan.scrollOffset === 0,
          scrollOffset: plan.scrollOffset,
          topics,
          selectedTopicIndex,
          // A page from the phone's storage may be behind: say so until the fresh one has arrived.
          ...(fromDisk ? { status: UPDATING_STATUS } : {}),
        }
        // Opened at the "last read" point: nothing counts as read until the user scrolls down to the newest message.
        if (plan.scrollOffset > 0) await this.setState(openState)
        else await this.setStateWithVisibleRead(openState, chat, topic, cached.messages)
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
      const plan = this.threads.planUnreadOpen({ chat, topic }, normalized)
      const openState: AppState = {
        screen: 'sidebar', focus: 'messages',
        chats, selectedChatIndex,
        chat, topic,
        messages: plan.messages,
        cursor: oldestMessageId(normalized),
        back: messageBackTarget(previous),
        newerPages: [],
        isNewestPage: plan.scrollOffset === 0,
        scrollOffset: plan.scrollOffset,
        topics,
        selectedTopicIndex,
      }
      if (plan.scrollOffset > 0) await this.setState(openState)
      else await this.setStateWithVisibleRead(openState, chat, topic, normalized)
      this.maybePrefetchOlder()
    }, previous)
  }

  /**
   * Fetch the newest page of a thread opened from cached data and apply it. Never throws: a failure keeps the
   * cached page on screen marked offline (an expired session signs out), and polling, the live stream's
   * reconnect or coming back to the foreground try again (refreshVisibleMessages).
   */
  private async refreshOpenMessagesInBackground(chat: Chat, topic: Topic | undefined, requestId: number) {
    const key = messageThreadKey({ chat, topic })
    let messages: Message[]
    try {
      messages = normalizeMessagePage(await this.api.listMessages(chat.id, { topicId: topicThreadId(topic), limit: MESSAGE_PAGE_LIMIT }))
    } catch (error) {
      debugLog('messages.refresh-failed', { error: errorText(error) })
      if (await this.handleAuthFailure(error)) return
      if (!this.isStillOpeningMessages(chat, topic, requestId)) return
      const current = this.state as Extract<AppState, { screen: 'sidebar'; focus: 'messages' }>
      const status = isBackendAuthError(error) ? BACKEND_AUTH_REJECTED_MESSAGE : OFFLINE_STATUS
      if (current.status !== status && (current.status === undefined || isRefreshStatus(current.status))) {
        await this.setState({ ...current, status })
      }
      return
    }
    const wasStale = this.staleThreadKey === key
    if (wasStale) this.staleThreadKey = undefined
    this.cacheMessages(chat, topic, messages)
    if (requestId !== this.openRequestId || !this.isStillOpeningMessages(chat, topic, requestId)) return
    const state = this.state
    if (state.screen !== 'sidebar' || state.focus !== 'messages') return
    const status = isRefreshStatus(state.status) ? undefined : state.status
    if (wasStale) {
      await this.applyFreshPageToStaleOpen(state, messages, status)
      return
    }
    if (!hasMessageChanges(state.messages, messages)) {
      if (status !== state.status) await this.setState({ ...state, status })
      return
    }
    if (this.isReadingFromUnread(state)) {
      const flagged = this.threads.flagUnread({ chat, topic }, messages)
      const scrollOffset = this.keepPlace(state, flagged)
      await this.setState({ ...state, messages: flagged, cursor: oldestMessageId(flagged), newerPages: [], isNewestPage: scrollOffset === 0, scrollOffset, status })
      this.maybePrefetchOlder()
      return
    }
    await this.setStateWithVisibleRead({
      ...state,
      status,
      messages,
      cursor: oldestMessageId(messages),
      newerPages: [],
      isNewestPage: true,
      scrollOffset: 0,
    }, chat, topic, messages)
    this.maybePrefetchOlder()
  }

  /**
   * The fresh page of a thread that was opened from a stale stored page (it had unread messages) has arrived:
   * place the "last read" divider on it as if the thread had just been opened, or, if the user has already
   * scrolled up in the stored page, keep their place. Only now may the thread be marked read.
   */
  private async applyFreshPageToStaleOpen(
    state: Extract<AppState, { screen: 'sidebar'; focus: 'messages' }>, fresh: Message[], status: string | undefined,
  ) {
    const storedNewest = newestMessageId(state.messages)
    const freshOldest = oldestMessageId(fresh)
    // Only join the two when they overlap; otherwise messages between them would be missing.
    const contiguous = storedNewest !== undefined && freshOldest !== undefined && idAtOrAfter(storedNewest, freshOldest)
    const merged = contiguous ? normalizeMessagePage([...state.messages, ...fresh]) : fresh
    const plan = this.threads.planUnreadOpen(state, merged)
    const base = { ...state, messages: plan.messages, cursor: oldestMessageId(plan.messages), newerPages: [], status }
    if (contiguous && (state.scrollOffset ?? 0) > 0) {
      const scrollOffset = this.keepPlace(state, plan.messages)
      await this.setState({ ...base, scrollOffset, isNewestPage: scrollOffset === 0 })
    } else {
      const next = { ...base, scrollOffset: plan.scrollOffset, isNewestPage: plan.scrollOffset === 0 }
      if (plan.scrollOffset > 0) await this.setState(next)
      else await this.setStateWithVisibleRead(next, state.chat, state.topic, plan.messages)
    }
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
    // Back at the newest message: drop history beyond the window (scroll offsets count from the newest
    // message, so the view does not move). Scrolling up again pages the dropped messages back in.
    const messages = nextOffset === 0 ? windowNewestMessages(state.messages) : state.messages
    const next = {
      ...state,
      messages,
      cursor: messages === state.messages ? state.cursor : oldestMessageId(messages),
      scrollOffset: nextOffset,
      isNewestPage: nextOffset === 0,
      status: nextOffset === 0 ? undefined : 'Newer messages',
    }
    // Reaching the newest message is what marks the thread read.
    if (nextOffset === 0) await this.setStateWithVisibleRead(next, state.chat, state.topic, messages)
    else await this.setState(next)
    this.maybePrefetchOlder()
  }

  /**
   * Poll for what arrived since the newest message already shown. A short answer is complete; a full page
   * may hide a gap, so that case falls back to fetching the whole newest page.
   */
  private async fetchNewerMessages(state: { chat: Chat; topic?: Topic; messages?: Message[] }) {
    const newest = state.messages && state.messages.length > 0 ? state.messages[state.messages.length - 1] : undefined
    const newestId = newest ? Number(newest.id) : NaN
    if (!Number.isFinite(newestId) || newestId <= 0) return this.refreshLatestMessages(state)
    const newer = normalizeMessagePage(await this.api.listMessages(state.chat.id, {
      topicId: topicThreadId(state.topic),
      afterId: newestId,
      limit: MESSAGE_PAGE_LIMIT,
    }))
    if (newer.length >= MESSAGE_PAGE_LIMIT) return this.refreshLatestMessages(state)
    if (newer.length > 0) this.cacheMessages(state.chat, state.topic, normalizeMessagePage([...(state.messages ?? []), ...newer]))
    return newer
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
    // Deliberately not gated on the input quiet window: while the user keeps scrolling that window never
    // closes, so the prefetch would never run and they would hit the end of loaded history. It is one
    // small request, only issued when close to the edge, and de-duplicated per cursor.
    const maxOffset = maxScrollOffset(state.messages)
    const remainingLoadedScroll = maxOffset - (state.scrollOffset ?? 0)
    if (remainingLoadedScroll > OLDER_PREFETCH_LOW_WATER) return
    void this.prefetchOlderMessages(state).catch(() => undefined)
  }

  private async prefetchTopics(chat: Chat): Promise<Topic[]> {
    const key = String(chat.id)
    const cached = this.threads.topics(key)
    if (cached) return cached
    const inFlight = this.topicsPrefetchInFlight.get(key)
    if (inFlight) return inFlight
    const promise = this.api.listTopics(chat.id)
      .then((topics) => {
        this.threads.putTopics(key, topics)
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
    const cached = this.threads.page({ chat, topic })
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
    this.prefetchPhotos(chat, messages)
    this.threads.putPage({ chat, topic }, messages)
  }

  /** Forget everything stored on the phone for fast startup (credentials and session are untouched). */
  async clearCache() {
    this.threads.clearCaches()
    this.photoCache.clear()
    await this.cache?.clear()
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
      limit: OLDER_PAGE_LIMIT,
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

  /**
   * Run a user-visible operation. A failure never escapes: an expired Telegram session goes to the sign-in
   * screen, anything else to the error screen. Resolves true when the operation completed.
   */
  private async run(operation: () => Promise<void>, previous?: RecoverableState, retry?: () => Promise<void>): Promise<boolean> {
    try {
      await operation()
      return true
    } catch (error) {
      if (await this.handleAuthFailure(error)) return false
      await this.showError(error, previous, retry)
      return false
    }
  }

  private async showError(error: unknown, previous?: RecoverableState, retry?: () => Promise<void>) {
    debugLog('error-screen', { error: errorText(error), screen: this.state.screen })
    await this.bridge.setAudioEnabled(false).catch(() => undefined)
    this.errorRetry = retry
    await this.setState({
      screen: 'error',
      message: error instanceof Error ? error.message : getLocale().errorUnexpected,
      previous,
    })
  }

  /**
   * The backend said the Telegram session is gone (401): stop polling, forget the cached chats and the stored
   * session, and show the sign-in screen. Any other error (including a rejected shared secret, which must not
   * cost the user their login) returns false and is left to the caller.
   */
  async handleAuthFailure(error: unknown): Promise<boolean> {
    if (!isSessionExpiredError(error)) return false
    const state = this.state
    if (state.screen === 'auth' && state.mode === 'signedOut') return true
    debugLog('session.expired', { screen: state.screen })
    this.openRequestId += 1
    this.cancelStartupRetry()
    this.stopMessagePolling()
    this.stopChatPolling()
    this.showingStoredChats = false
    this.onTelegramSession?.('')
    await this.bridge.setAudioEnabled(false).catch(() => undefined)
    await this.setState({ screen: 'auth', mode: 'signedOut', message: getLocale().authSessionExpired })
    await this.clearCache().catch(() => undefined)
    return true
  }

  /** The update stream connected (true) or dropped (false). Polling is fast only while it is down. */
  setStreamHealthy(healthy: boolean) {
    if (this.streamHealthy === healthy) return
    this.streamHealthy = healthy
    if (this.messagePoll) {
      this.stopMessagePolling()
      this.syncMessagePolling()
    }
    if (this.chatPoll) {
      this.stopChatPolling()
      this.syncChatPolling()
    }
    // The backend is reachable again: no need to wait for the next startup retry.
    if (healthy && this.startupRetryTimer) void this.retryStartup()
  }

  /** The update stream stopped for good (see isUnrecoverableStreamError); react like a failed background poll. */
  async handleStreamFailure(error: unknown) {
    await this.noteBackgroundError(error)
  }

  /** A background refresh failed: sign out on an expired session, flag a rejected shared secret, else ignore. */
  private async noteBackgroundError(error: unknown) {
    if (await this.handleAuthFailure(error)) return
    if (!isBackendAuthError(error)) return
    const state = this.state
    if (state.screen === 'sidebar' && state.focus !== 'topics' && state.status !== BACKEND_AUTH_REJECTED_MESSAGE) {
      await this.setState({ ...state, status: BACKEND_AUTH_REJECTED_MESSAGE })
    }
  }

  /** A background refresh worked: drop a stale offline / auth-rejected mark. */
  private async noteBackgroundSuccess() {
    const state = this.state
    if (state.screen === 'sidebar' && state.focus !== 'topics' && (state.status === BACKEND_AUTH_REJECTED_MESSAGE || state.status === OFFLINE_STATUS)) {
      await this.setState({ ...state, status: undefined })
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
    if (prev.screen !== state.screen) debugLog('screen', { from: prev.screen, to: state.screen })
    this.applyState(state, true)
    // Partial updates may only change text content. A focus transition changes
    // which container captures input, so it requires a full page rebuild.
    if (prev.screen === 'sidebar' && state.screen === 'sidebar' && this.bridge.renderSidebarPanel) {
      const newModel = screenModel(state)
      if (newModel.kind === 'sidebar') {
        const newHasPanelBox = panelLayoutKey(newModel)
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
        this.lastRenderedHasPanelBox = panelLayoutKey(newModel)
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
        let model = screenModel(state)
        // While the user is swiping, leave the picture out of the page: moving it means a heavier layout and a
        // transfer over the glasses link for every swipe. It is added back once scrolling pauses.
        const deferredImage = model.kind === 'sidebar' && model.panelImage && !this.imagesSettled
        if (deferredImage && model.kind === 'sidebar') model = { ...model, panelImage: undefined }
        await this.bridge.render(model)
        if (deferredImage) this.scheduleImageSettle()
        else {
          this.cancelImage()
          if (model.kind === 'sidebar' && model.panelImage) void this.showPanelImage(model.panelImage).catch(() => undefined)
        }
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
    }, this.pollInterval(this.runtimeConfig.messagePollMs))
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
    // No polling while asleep: the live stream (when up) still refreshes the list, and waking refreshes it.
    const shouldPoll = (state.screen === 'sidebar' && state.focus === 'chats') || state.screen === 'newMessage'
    if (!shouldPoll) {
      this.stopChatPolling()
      return
    }
    if (this.chatPoll) return
    this.chatPoll = setInterval(() => {
      void this.refreshRootChats({ background: true })
    }, this.pollInterval(this.runtimeConfig.chatPollMs))
    const maybeNodeInterval = this.chatPoll as unknown as { unref?: () => void }
    maybeNodeInterval.unref?.()
  }

  /** The configured (fast) interval while the update stream is down; a slow safety-net interval while it is up. */
  private pollInterval(configuredMs: number) {
    return this.streamHealthy ? Math.max(configuredMs, STREAM_HEALTHY_POLL_MS) : configuredMs
  }

  private stopChatPolling() {
    if (!this.chatPoll) return
    clearInterval(this.chatPoll)
    this.chatPoll = undefined
  }

  private async refreshRootChats(options: { background?: boolean } = {}) {
    if (this.rootRefreshInFlight) {
      this.rootRefreshDirty = true
      return
    }
    // The stored list is still waiting for startup to load the real one (or to retry it).
    if (this.showingStoredChats) return
    if (options.background && this.isInputQuiet()) {
      this.deferRootRefresh()
      return
    }
    const state = this.state
    if ((state.screen !== 'sidebar' || state.focus !== 'chats') && state.screen !== 'asleep' && state.screen !== 'newMessage') return
    this.rootRefreshInFlight = true
    try {
      const chats = await this.api.listChats(CHAT_LIST_LIMIT).catch((error) => {
        void this.noteBackgroundError(error)
        return undefined
      })
      if (!chats) return
      await this.noteBackgroundSuccess()

      const activity = this.findNewChatActivity(chats)
      this.rememberChats(chats)
      if (this.activeFolderId === undefined) this.cache?.putChats(chats)

      const current = this.state
      if ((current.screen !== 'sidebar' || current.focus !== 'chats') && current.screen !== 'asleep' && current.screen !== 'newMessage') return

      // `chats` is only the first page of "All chats". Keep the pages the user has already scrolled
      // through; inside a folder the displayed list is left alone (only activity detection uses it).
      const displayedChats = this.activeFolderId === undefined ? mergeChatPages(current.chats, chats) : current.chats
      const selectedChatIndex = clamp(current.selectedChatIndex, 0, Math.max(0, displayedChats.length - 1))
      // New activity never takes over the glasses: the Even app already notifies natively. The list just picks up
      // the new badge/preview (and a sleeping screen stays asleep, with the list ready for when it wakes).
      if (current.screen === 'sidebar' && current.focus === 'chats') {
        if (activity) await this.setState({ ...current, chats: displayedChats, selectedChatIndex })
        else await this.setStateWithoutRender({ ...current, chats: displayedChats, selectedChatIndex })
      } else if (current.screen === 'asleep') {
        await this.setStateWithoutRender({ ...current, chats: displayedChats, selectedChatIndex })
      }
    } finally {
      this.rootRefreshInFlight = false
      if (this.rootRefreshDirty) {
        this.rootRefreshDirty = false
        void this.refreshRootChats({ background: true })
      }
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

  private async refreshVisibleMessages(options: { background?: boolean } = {}) {
    if (this.messageRefreshInFlight) {
      this.messageRefreshDirty = true
      return
    }
    if (options.background && this.isInputQuiet()) {
      this.deferMessageRefresh()
      return
    }
    const state = this.state
    if ((state.screen !== 'sidebar' || state.focus !== 'messages') && state.screen !== 'sidebarSent') return
    const requestedThreadKey = messageThreadKey(state)
    this.messageRefreshInFlight = true
    try {
      if (state.screen === 'sidebar' && this.staleThreadKey === requestedThreadKey) {
        // Still showing the stale stored page (its first refresh failed): fetch the whole fresh page.
        await this.refreshOpenMessagesInBackground(state.chat, state.topic, this.openRequestId)
        return
      }
      const messages = await this.fetchNewerMessages(state).catch((error) => {
        void this.noteBackgroundError(error)
        return undefined
      })
      if (!messages) return
      await this.noteBackgroundSuccess()
      if (messages.length === 0) return
      await this.applyIncomingMessages(messages, requestedThreadKey)
    } finally {
      this.messageRefreshInFlight = false
      if (this.messageRefreshDirty) {
        this.messageRefreshDirty = false
        void this.refreshVisibleMessages({ background: true })
      }
    }
  }

  /** Merge freshly received messages into the open thread (from a poll or straight from the live stream). */
  private async applyIncomingMessages(messages: Message[], requestedThreadKey?: string) {
    if (messages.length === 0) return
    const current = this.state
    if ((current.screen !== 'sidebar' || current.focus !== 'messages') && current.screen !== 'sidebarSent') return
    if (requestedThreadKey !== undefined && messageThreadKey(current) !== requestedThreadKey) return

    const merged = normalizeMessagePage([...current.messages, ...messages])
    if (!hasMessageChanges(current.messages, merged)) return
    const hasIncoming = hasIncomingChange(current.messages, merged)
    // A stale stored page with a live message added is still not the thread's latest page.
    if (this.staleThreadKey !== messageThreadKey(current)) this.cacheMessages(current.chat, current.topic, merged)
    if (current.screen === 'sidebar' && current.focus === 'messages' && this.isReadingFromUnread(current)) {
      const flagged = this.threads.flagUnread(current, merged)
      const scrollOffset = this.keepPlace(current, flagged)
      await this.setState({ ...current, messages: flagged, cursor: oldestMessageId(flagged), newerPages: [], isNewestPage: scrollOffset === 0, scrollOffset })
      return
    }
    if (current.screen === 'sidebar' && current.focus === 'messages') {
      // The view jumps to the newest message, so loaded history beyond the window can go (see loadNewerMessages).
      const kept = windowNewestMessages(merged)
      await this.setStateWithVisibleRead({ ...current, messages: this.threads.flagUnread(current, kept), cursor: oldestMessageId(kept), status: hasIncoming ? 'New reply' : undefined, newerPages: [], isNewestPage: true, scrollOffset: 0 }, current.chat, current.topic, merged, { forceAck: hasIncoming })
      this.maybePrefetchOlder()
      return
    }
    await this.setStateWithVisibleRead({ ...current, messages: merged, status: hasIncoming ? 'New reply' : undefined, newerPages: [], isNewestPage: true, scrollOffset: 0 }, current.chat, current.topic, merged, { forceAck: hasIncoming })
  }

  private async setStateWithVisibleRead(
    state: AppState,
    chat: Chat,
    topic: Topic | undefined,
    messages: Message[],
    options: { forceAck?: boolean; render?: boolean } = {},
  ) {
    const maxId = newestMessageId(messages)
    // A thread shown from a stale stored page is not read yet: its unread messages have not even arrived.
    if (maxId === undefined || this.staleThreadKey === messageThreadKey({ chat, topic })) {
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
      ? panelLayoutKey(screenModel(next) as Extract<ScreenModel, { kind: 'sidebar' }>)
      : ''
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
      ? panelLayoutKey(sidebarModel)
      : ''
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
    return this.threads.needsReadAck({ chat, topic }, maxId)
  }

  private sendReadAck(chat: Chat, topic: Topic | undefined, maxId: Id) {
    const key = messageThreadKey({ chat, topic })
    this.threads.noteReadAck({ chat, topic }, maxId)
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
    this.imagesSettled = false
    this.lastUserInputAt = Date.now()
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
    if (this.patchChatFromUpdate(update)) return
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

function maxScrollOffset(messages: Message[]) {
  return Math.max(0, messageScrollUnitCount(messages) - 1)
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

function chatFingerprint(chat: Chat) {
  return `${chat.unreadCount ?? 0}:${chat.lastMessage ?? ''}`
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

/** Statuses that only describe the freshness of cached data; a successful refresh clears them. */
function isRefreshStatus(status: string | undefined) {
  return status === UPDATING_STATUS || status === OFFLINE_STATUS || status === BACKEND_AUTH_REJECTED_MESSAGE
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

/** Identifies the native container layout: a change means the glasses need a full rebuild, not a text update. */
function panelLayoutKey(model: Extract<ScreenModel, { kind: 'sidebar' }>): string {
  const image = model.panelImage ? `${model.panelImage.chatId}:${model.panelImage.messageId}@${model.panelImage.topLine}` : ''
  return `${model.panelBox ? 'box' : ''}|${image}`
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}
