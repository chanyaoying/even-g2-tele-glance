import type { AppState, ScreenModel } from './controller/model'

export const TELEGLANCE_TEST_LOG_PREFIX = '[TeleGlanceTest]'

export function isTeleGlanceFixtureMode() {
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_TELEGLANCE_FIXTURE === '1') return true
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('teleGlanceFixture') === '1'
}

export function getFixtureTestOverrides(): {
  missingCredentials: boolean
  signedOut: boolean
  errorOnAuthStatus: boolean
  slowChats: boolean
  chatDelayMs: number
  injectedNotification: { chatId: string; message: string; topicId?: string | null } | null
  nextTranscript: string | null
} {
  if (typeof window === 'undefined') {
    return {
      missingCredentials: false,
      signedOut: false,
      errorOnAuthStatus: false,
      slowChats: false,
      chatDelayMs: 0,
      injectedNotification: null,
      nextTranscript: null,
    }
  }
  const params = new URLSearchParams(window.location.search)
  const chatDelayMs = Number(params.get('chatDelayMs') ?? '0') || 0
  const notify = params.get('teleGlanceNotify')
  const transcript = params.get('teleGlanceTranscript')
  return {
    missingCredentials: params.get('teleGlanceAuth') === 'missing',
    signedOut: params.get('teleGlanceAuth') === 'signed-out',
    errorOnAuthStatus: params.get('teleGlanceAuth') === 'error',
    slowChats: params.get('teleGlanceAuth') === 'slow',
    chatDelayMs,
    injectedNotification: notify
      ? {
          chatId: notify,
          message: params.get('teleGlanceNotifyText') ?? 'New message',
          topicId: params.get('teleGlanceNotifyTopic'),
        }
      : null,
    nextTranscript: transcript,
  }
}

function isTestLoggingEnabled() {
  if (typeof import.meta !== 'undefined' && import.meta.env?.PROD) return false
  return true
}

/**
 * Monotonic high-resolution timer. Returns `performance.now()` when available (browser
 * WebView, Node test runner) and falls back to `Date.now()` in non-DOM environments.
 * The harness reports latency buckets derived from these values, so use this for any
 * timing measurement that should appear in `[TeleGlanceTest]` events.
 */
export function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

export type InputDispatchContext = {
  inputQuiet: boolean
  backgroundWorkActive: boolean
}

export type InputDispatchPayload = {
  listenerMs: number
  queueDepth: number
  pendingModel: boolean
  renderInFlight: boolean
  mappedKind: string | null
  rawSummary: unknown
  context?: InputDispatchContext
}

/**
 * Emit per-input telemetry from the Even Hub SDK listener. `listenerMs` is the time
 * spent inside the native→JS callback before the coalesced dispatch timer fires. The
 * queue/render state lets the harness detect firmware backpressure on real G2 hardware:
 * if `queueDepth` is consistently 0/1 in simulator but stays >1 on the device, the
 * firmware's serialized `textContainerUpgrade` is the bottleneck.
 *
 * This event is timing-only. It never includes message text, session strings, phone
 * numbers, or login codes. `rawSummary` is the existing debug summary that the bridge
 * already produces for the `input` event; both events share that payload.
 */
export function logInputDispatch(payload: InputDispatchPayload) {
  logTeleGlanceTest('input.dispatch', {
    listenerMs: Math.round(payload.listenerMs * 100) / 100,
    queueDepth: payload.queueDepth,
    pendingModel: payload.pendingModel,
    renderInFlight: payload.renderInFlight,
    mappedKind: payload.mappedKind,
    context: payload.context,
    raw: payload.rawSummary,
  })
}

export type StateWorkKind =
  | 'setState'
  | 'setStateWithoutRender'
  | 'setStateForListScroll'
  | 'setStateWithPartialRender'
  | 'applyState'

export type StateWorkPayload = {
  kind: StateWorkKind
  syncMs: number
  screen: string
  focus?: string
  includedScreenModel?: boolean
  includedRenderEnqueue?: boolean
}

/**
 * Emit per-state-update sync work timing. `syncMs` is the time spent inside the
 * `setState*` method, including `applyState` (state assignment, polling sync, notify
 * schedule) plus any `screenModel(state)` formatting and bridge enqueue. The harness
 * buckets these by `kind` to attribute work to full renders vs. partial panel updates.
 *
 * Phone WebView React rerender and screenModel formatting are the hidden cost behind
 * sluggish input on real hardware. If `setStateForListScroll` consistently shows
 * `syncMs` > 16 ms on real G2, the synchronous path is starving the input handler.
 */
export function logStateWork(payload: StateWorkPayload) {
  logTeleGlanceTest('state.work', {
    kind: payload.kind,
    syncMs: Math.round(payload.syncMs * 100) / 100,
    screen: payload.screen,
    focus: payload.focus,
    includedScreenModel: payload.includedScreenModel,
    includedRenderEnqueue: payload.includedRenderEnqueue,
  })
}

export type BridgeQueueDepthReason =
  | 'enqueue'
  | 'flush-start'
  | 'flush-end'
  | 'full-render-start'
  | 'full-render-end'
  | 'input-dispatch'

export type BridgeQueueDepthPayload = {
  reason: BridgeQueueDepthReason
  partialInFlight: number
  partialPending: number
  fullRenderInFlight: number
  dispatched: number
  dropped: number
  flushed: number
  staleDropped: number
}

/**
 * Emit bridge queue depth snapshots. The partial-render path coalesces rapid list
 * scrolls into a single latest-wins `textContainerUpgrade` chain, so a depth of 0 or
 * 1 is the steady state. Real G2 firmware can serialize multiple in-flight upgrades
 * behind a slow roundtrip; the harness tracks the max `partialInFlight` and
 * `partialPending` observed across the run to detect that pattern.
 */
export function logBridgeQueueDepth(payload: BridgeQueueDepthPayload) {
  logTeleGlanceTest('bridge.queueDepth', {
    reason: payload.reason,
    partialInFlight: payload.partialInFlight,
    partialPending: payload.partialPending,
    fullRenderInFlight: payload.fullRenderInFlight,
    dispatched: payload.dispatched,
    dropped: payload.dropped,
    flushed: payload.flushed,
  })
}

const IN_PAGE_EVENT_BUFFER_LIMIT = 2_000
const inPageEventBuffer: Array<{ event: string; ts: number; [key: string]: unknown }> = []
let inPageFlushTimer: ReturnType<typeof setInterval> | undefined

function startInPageEventFlush() {
  if (inPageFlushTimer) return
  if (typeof window === 'undefined') return
  inPageFlushTimer = setInterval(() => {
    if (inPageEventBuffer.length === 0) return
    const events = inPageEventBuffer.splice(0, inPageEventBuffer.length)
    fetch('/api/test/fixture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'events', events }),
    }).catch(() => {
      // If the dev server is gone (e.g. test cleanup), drop
      // the events. They're useful for the harness but not
      // required for the app to run.
    })
  }, 100)
  const maybeNodeInterval = inPageFlushTimer as unknown as { unref?: () => void }
  maybeNodeInterval.unref?.()
}

export function logTeleGlanceTest(event: string, payload: Record<string, unknown>) {
  if (!isTestLoggingEnabled()) return
  const entry = { event, ts: Date.now(), ...payload }
  console.log(`${TELEGLANCE_TEST_LOG_PREFIX} ${JSON.stringify(entry)}`)
  inPageEventBuffer.push(entry)
  if (inPageEventBuffer.length > IN_PAGE_EVENT_BUFFER_LIMIT) {
    inPageEventBuffer.splice(0, inPageEventBuffer.length - IN_PAGE_EVENT_BUFFER_LIMIT)
  }
  startInPageEventFlush()
}
export function logApiEvent<T>(call: string, args: unknown, startedAt: number, endedAt: number, ok: boolean, result?: T, error?: unknown) {
  logTeleGlanceTest('api', {
    call,
    args,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    ok,
    error: error ? String(error) : undefined,
    resultPreview: ok ? previewApiResult(result) : undefined,
  })
}

/**
 * Real-mode timing-only API log. Unlike `logApiEvent`, this never includes raw message
 * text, transcript, session strings, phone numbers, or login codes. It is safe to emit
 * in any dev build (real or fixture) but is the default in real-mode harness runs where
 * `InstrumentedTelegramApi` would otherwise emit no API timing at all.
 */
export function logApiTiming(call: string, args: unknown, startedAt: number, endedAt: number, ok: boolean, result?: unknown, error?: unknown) {
  logTeleGlanceTest('api.timing', {
    call,
    args,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    ok,
    error: error ? String(error) : undefined,
    result: ok ? result : undefined,
  })
}
function previewApiResult(result: unknown): unknown {
  if (result === undefined || result === null) return result
  if (Array.isArray(result)) return { __array: true, length: result.length, first: result[0] }
  if (typeof result === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
      if (key === 'sessionString' || key === 'stringSession') {
        out[key] = '[redacted]'
      } else {
        out[key] = value
      }
    }
    return out
  }
  return result
}

export function logPrefetchEvent(kind: 'chat' | 'topic' | 'message' | 'older', key: string, startedAt: number, endedAt: number, ok: boolean, fromCache: boolean, error?: unknown) {
  logTeleGlanceTest('prefetch', {
    kind,
    key,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    ok,
    fromCache,
    error: error ? String(error) : undefined,
  })
}

export function logLifecycleEvent(kind: 'start' | 'asleep' | 'wake' | 'newMessage' | 'error', payload: Record<string, unknown> = {}) {
  logTeleGlanceTest('lifecycle', { kind, ...payload })
}

export function logRecordingEvent(kind: 'start' | 'audioChunk' | 'stop' | 'transcribe.start' | 'transcribe.end' | 'confirm' | 'send.start' | 'send.end', payload: Record<string, unknown> = {}) {
  logTeleGlanceTest('recording', { kind, ...payload })
}




export function summarizeAppState(state: AppState): Record<string, unknown> {
  switch (state.screen) {
    case 'sidebar':
      if (state.focus === 'chats') {
        return {
          screen: state.screen,
          focus: state.focus,
          chats: state.chats.map((chat) => chat.title),
          selectedChatIndex: state.selectedChatIndex,
          selectedChatTitle: state.chats[state.selectedChatIndex]?.title ?? null,
          status: state.status ?? null,
        }
      }
      if (state.focus === 'topics') {
        return {
          screen: state.screen,
          focus: state.focus,
          selectedChatIndex: state.selectedChatIndex,
          chatTitle: state.chat.title,
          topics: state.topics.map((topic) => topic.title),
          selectedTopicIndex: state.selectedTopicIndex,
          selectedTopicTitle: state.topics[state.selectedTopicIndex]?.title ?? null,
          previewTopicTitle: state.previewTopic?.title ?? null,
          previewMessageCount: state.previewMessages?.length ?? 0,
        }
      }
      return {
        screen: state.screen,
        focus: state.focus,
        selectedChatIndex: state.selectedChatIndex,
        selectedTopicIndex: state.selectedTopicIndex ?? null,
        chatTitle: state.chat.title,
        topicTitle: state.topic?.title ?? null,
        messageCount: state.messages.length,
        messageTexts: state.messages.map((message) => message.text),
        status: state.status ?? null,
        scrollOffset: state.scrollOffset ?? 0,
        isNewestPage: state.isNewestPage ?? null,
        cursor: state.cursor ?? null,
        back: state.back ? state.back.screen : null,
        typing: state.typing ?? null,
      }
    case 'sidebarRecording':
      return {
        screen: state.screen,
        focus: state.focus,
        chatTitle: state.chat.title,
        topicTitle: state.topic?.title ?? null,
        messageCount: state.messages.length,
        chunksLength: state.chunks.length,
      }
    case 'sidebarTranscribing':
      return {
        screen: state.screen,
        focus: state.focus,
        chatTitle: state.chat.title,
        topicTitle: state.topic?.title ?? null,
      }
    case 'sidebarConfirm':
      return {
        screen: state.screen,
        focus: state.focus,
        chatTitle: state.chat.title,
        topicTitle: state.topic?.title ?? null,
        transcript: state.transcript,
        selectedIndex: state.selectedIndex,
      }
    case 'sidebarSent':
      return {
        screen: state.screen,
        chatTitle: state.chat.title,
        topicTitle: state.topic?.title ?? null,
      }
    case 'sidebarSending':
      return {
        screen: state.screen,
        chatTitle: state.chat.title,
        topicTitle: state.topic?.title ?? null,
        transcript: state.transcript,
      }
    case 'newMessage':
      return {
        screen: state.screen,
        chatTitle: state.chat.title,
        topicTitle: state.topic?.title ?? null,
        messagePreview: state.message,
      }
    case 'auth':
      return { screen: state.screen, mode: state.mode, message: state.message, phone: state.phone }
    case 'loading':
      return { screen: state.screen, message: state.message }
    case 'asleep':
      return { screen: state.screen, chatCount: state.chats.length }
    case 'error':
      return { screen: state.screen, message: state.message }
    default:
      return { screen: 'unknown' }
  }
}

export function summarizeScreenModel(model: ScreenModel): Record<string, unknown> {
  switch (model.kind) {
    case 'text':
      return {
        kind: model.kind,
        title: model.title,
        bodyLength: model.body.length,
        body: model.body,
        footer: model.footer,
        box: model.box ? { heading: model.box.heading, contentLength: model.box.content.length, content: model.box.content } : null,
      }
    case 'list':
      return {
        kind: model.kind,
        title: model.title,
        itemCount: model.items.length,
        selectedIndex: model.selectedIndex,
      }
    case 'sidebar':
      // The harness-driven topic-scroll test
      // (`scripts/simulator-topic-scroll.mjs`) relies on the
      // actual panel body text to assert "I saw message N of
      // topic T". `panelBodyLength` is not enough — we need
      // the rendered content. Truncate to 600 chars so a single
      // render event stays under a few KB even for long-message
      // topics. The simulator's harness parses this and searches
      // for the topic-N-m<M> anchors embedded in each fixture
      // message.
      return {
        kind: model.kind,
        title: model.title,
        sidebarTitle: model.sidebarTitle,
        focus: model.focus,
        fullWidth: model.fullWidth,
        sidebarItemCount: model.sidebarItems.length,
        sidebarSelected: model.sidebarSelected,
        sidebarItems: model.sidebarItems,
        panelBodyLength: model.panelBody.length,
        panelBody: model.panelBody,
        panelBodyExcerpt: model.panelBody.slice(0, 600),
        panelFooter: model.panelFooter,
        panelBox: model.panelBox ? { heading: model.panelBox.heading, contentLength: model.panelBox.content.length, content: model.panelBox.content, contentExcerpt: model.panelBox.content.slice(0, 400) } : null,
        popup: model.popup ? { title: model.popup.title, body: model.popup.body } : null,
        panelImage: model.panelImage ? { messageId: model.panelImage.messageId, topLine: model.panelImage.topLine } : null,
        // Present only on native chat/topic list pages (the firmware draws these rows; `panelBody` is then the
        // plain-text fallback and is not what the glasses show).
        ...(model.nativeList ? { nativeList: { name: model.nativeList.name, items: model.nativeList.items, keys: model.nativeList.keys } } : {}),
      }
  }
}
