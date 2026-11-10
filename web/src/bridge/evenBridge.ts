import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { setDebugSink } from '../debugLog'
import { getLocale } from '../locales'
import type { GlassesBridge } from '../controller/appController'
import { INLINE_IMAGE_HEIGHT, INLINE_IMAGE_WIDTH, MESSAGE_ROW_HEIGHT_PX, type AppInput, type ScreenModel } from '../controller/model'
import { defaultApiBaseUrl, effectiveBackendSharedSecret, type TelegramAuthConfig } from '../api'
import { encryptedTelegramAuthHeader, encryptJsonPayload } from '../secureAuth'
import {
  isTeleGlanceFixtureMode,
  logBridgeQueueDepth,
  logInputDispatch,
  logTeleGlanceTest,
  nowMs,
  summarizeScreenModel,
  type BridgeQueueDepthReason,
} from '../testMode'
import { createBoundedInputDispatcher, createInputCoalescer, mapEvenHubEvent } from './eventMapping'

const encoder = new TextEncoder()
const IMAGE_CONTAINER_ID = 9
const IMAGE_CONTAINER_NAME = 'panel-image'
const POPUP_CONTAINER_ID = 10
/** A rebuild the host answered `false` to after at least this long timed out; it was not a refusal of the layout. */
const TIMEOUT_REFUSAL_MS = 1500
const MAX_TIMEOUT_RETRIES = 2
const TIMEOUT_RETRY_DELAY_MS = 1000
/** Longest a page rebuild waits for a picture transfer that is still running. */
const IMAGE_BUSY_MAX_WAIT_MS = 3000
/** Longest the bridge waits for the glasses to answer a page before it sends the next one anyway. */
const REBUILD_MAX_WAIT_MS = 3000
/** Longest a picture transfer waits for the page it belongs to to be drawn. */
const PAGE_SETTLE_MAX_WAIT_MS = 4000
const POPUP_CONTAINER_NAME = 'popup'
/** Longest a picture transfer may take before the bridge stops waiting for the host's answer. */
const IMAGE_TRANSFER_TIMEOUT_MS = 8000
/**
 * After a transfer timed out the host may still be busy with it, so the next page rebuild or picture waits this long
 * (rebuilds no longer than `IMAGE_BUSY_MAX_WAIT_MS` in total) instead of hitting a busy link at once.
 */
const IMAGE_TIMEOUT_COOLDOWN_MS = 2000
export const APP_BUILD_VERSION: string = (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0')

type DispatchContextSnapshot = { inputQuiet: boolean; backgroundWorkActive: boolean }
type EvenBridgeOptions = {
  debugEventsEnabled?: () => boolean
  authConfig?: () => TelegramAuthConfig
  /**
   * Snapshot of controller-side state captured at the moment an Even Hub SDK event
   * arrives. Used by `input.dispatch` to correlate input latency with background
   * work (prefetch, polling) and the input quiet window. Returning a fresh object
   * per call is intentional; the bridge logs it verbatim.
   */
  dispatchContextProvider?: () => DispatchContextSnapshot
}

let activeEventListenerToken: symbol | undefined

/**
 * Timing notes for the Debug events setting: sent to the backend (and its log) so the glasses-link cost of a
 * picture or a page rebuild can be read without a dev console. Set by `create`; does nothing while the setting is off.
 */
let debugNote: ((note: string, data: Record<string, unknown>) => void) | undefined
let errorReportingInstalled = false

/**
 * An error that escapes the app used to leave no trace at all. With Debug events on, send uncaught errors and
 * unhandled promise rejections to the backend log (`debug-note ... js-error`), with the start of the stack.
 */
/** The "at ..." frames of an error's stack, without the message line(s) that precede them. */
function stackFrames(error: Error): string {
  return String(error.stack ?? '')
    .split('\n')
    .filter((line) => /^\s*at\s|@/.test(line))
    .map((line) => line.trim())
    .join('\n')
}

function reportUncaughtErrors() {
  if (errorReportingInstalled || typeof window === 'undefined') return
  errorReportingInstalled = true
  // The error message and the stack's first line can quote app data (a chat title in a thrown message), so only the
  // error's type and where it was thrown leave the phone.
  const describe = (value: unknown) => {
    if (value instanceof Error) return { errorType: value.name.slice(0, 60), where: stackFrames(value).slice(0, 600) }
    return { errorType: typeof value }
  }
  window.addEventListener('error', (event) => {
    debugNote?.('js-error', { kind: 'error', ...describe(event.error ?? event.message), at: `${event.filename ?? ''}:${event.lineno ?? 0}` })
  })
  window.addEventListener('unhandledrejection', (event) => {
    debugNote?.('js-error', { kind: 'unhandledrejection', ...describe(event.reason) })
  })
}

type EvenBridgeInstance = {
  createStartUpPageContainer(container: unknown): Promise<number>
  rebuildPageContainer(container: unknown): Promise<boolean>
  textContainerUpgrade?(container: unknown): Promise<boolean>
  updateImageRawData?(data: unknown): Promise<unknown>
  audioControl(enabled: boolean): Promise<unknown>
  shutDownPageContainer?(exitMode?: number): Promise<boolean>
  callEvenApp?(method: string, payload: unknown): Promise<boolean>
  screenOff?(): Promise<boolean>
  turnScreenOff?(): Promise<boolean>
  getLocalStorage?(key: string): Promise<string>
  setLocalStorage?(key: string, value: string): Promise<boolean>
  onEvenHubEvent(listener: (event: unknown) => void): (() => void) | void
}

export class EvenHubGlassesBridge implements GlassesBridge {
  private hasRendered = false
  private pendingImage: Uint8Array | undefined
  private imageSending: Promise<boolean> | undefined
  private audioOn = false
  /** 0 = full sidebar layout; raised when the host rejects a page, until pages are accepted again. */
  private layoutTier: LayoutTier = 0
  /**
   * Full rebuilds go to the glasses one at a time. The host needs hundreds of milliseconds to seconds per page, and a
   * rebuild sent while another is still being drawn is slow or refused; the newest screen waits and replaces the rest.
   */
  private rebuildInFlight = false
  private rebuildSentAt = 0
  private pendingFullModel: ScreenModel | undefined
  private pendingFlushTimer: ReturnType<typeof setTimeout> | undefined
  /** The delayed same-layout retry of a timed-out rebuild (see `handleRejectedPage`). */
  private timeoutRetryTimer: ReturnType<typeof setTimeout> | undefined
  /** Until when a timed-out picture transfer may still occupy the glasses link (epoch ms; 0 = not cooling down). */
  private imageCooldownUntil = 0
  /** Kind of the page `render` is currently preparing; partial updates arriving meanwhile wait for it if it is a sidebar. */
  private fullRenderKind: ScreenModel['kind'] | undefined
  /** The next partial update must rewrite every container: a full page was sent since the last diff base was known. */
  private panelDiffReset = false
  private disposed = false
  /** The one-time startup call has been used for a plain text page (see `render`). */
  private startupBootstrapped = false
  /** Consecutive timed-out (not refused) rebuilds of the same screen. */
  private timeoutRetries = 0
  /** The glasses show the plain text startup page (stored chat list) and the interactive layout has not landed yet. */
  private onBootstrapPage = false
  /** Newest list state seen while the interactive layout was being sent; applied once it lands. */
  private selectionAfterRebuild: Extract<ScreenModel, { kind: 'sidebar' }> | undefined
  private pageSettledWaiters: Array<() => void> = []
  private audioChain: Promise<void> = Promise.resolve()
  private pageGeneration = 0
  private renderSequence = 0
  private pendingPanelModel: { model: Extract<ScreenModel, { kind: 'sidebar' }>; generation: number } | undefined
  private panelRenderInFlight = false
  private panelRenderQueuedAfter = false
  private fullRenderInFlight = false
  private partialRenderDispatched = 0
  private partialRenderDropped = 0
  private partialRenderFlushed = 0
  private stalePartialRenderDropped = 0
  private panelRenderTimer: ReturnType<typeof setTimeout> | undefined
  private lastSidebarModel: Extract<ScreenModel, { kind: 'sidebar' }> | undefined
  // `panelRenderIdleMs` is the scroll-idle window for the partial-render queue. On real
  // G2 hardware each `textContainerUpgrade` call is a 150-400ms firmware roundtrip. If
  // we flush on every microtask boundary, rapid scrolling chains firmware calls and the
  // glasses feel sluggish. This delay holds the latest panel model until the user stops
  // scrolling, so 10 rapid swipes produce one latest-state update instead of a queue
  // of stale sidebar and preview updates.
  private readonly panelRenderIdleMs = 150
  constructor(
    private readonly sdk: EvenBridgeInstance,
    private unsubscribeEvents?: () => void,
    private readonly listenerToken?: symbol,
  ) {}

  static async create(onInput: (input: AppInput) => void | Promise<void>, options: EvenBridgeOptions = {}) {
    const sdk = (await waitForEvenAppBridge()) as unknown as EvenBridgeInstance
    const dispatchInput = createInputCoalescer(createBoundedInputDispatcher(onInput))
    let debugLogInFlight = false
    debugNote = options.debugEventsEnabled
      ? (note, data) => {
          if (!options.debugEventsEnabled?.()) return
          void postDebugNote(note, data, options.authConfig)
        }
      : undefined
    setDebugSink(debugNote)
    reportUncaughtErrors()
    const listenerToken = Symbol('even-hub-listener')
    activeEventListenerToken = listenerToken
    const unsubscribeEvents = sdk.onEvenHubEvent((event) => {
      // Some SDK hosts do not actually remove the first listener during React
      // StrictMode cleanup. Only the newest bridge instance may dispatch input.
      if (activeEventListenerToken !== listenerToken) return
      // `input.dispatch` event so the harness can attribute input latency to the
      // JS bridge callback rather than to the harness's automation roundtrip.
      const listenerStart = nowMs()
      const input = mapEvenHubEvent(event as Parameters<typeof mapEvenHubEvent>[0])
      if (input?.type !== 'audioChunk') {
        logTeleGlanceTest('input', {
          mapped: input ?? null,
          raw: summarizeForDebug(event),
        })
      }
      if ((options.debugEventsEnabled?.() ?? false) && input?.type !== 'audioChunk' && !debugLogInFlight) {
        debugLogInFlight = true
        setTimeout(() => {
          void logHardwareEvent(event, input, options.authConfig).finally(() => {
            debugLogInFlight = false
          })
        }, 0)
      }
      const listenerMs = nowMs() - listenerStart
      // Emit per-input timing telemetry for every non-audio event. The harness
      // correlates `input.dispatch` events with `bridge.queueDepth` events by
      // timestamp to reconstruct the queue state at input time. We intentionally
      // do NOT access bridge instance state here — the instance hasn't been
      // constructed yet (the listener is wired before the bridge is created).
      if (input?.type !== 'audioChunk') {
        logInputDispatch({
          listenerMs,
          queueDepth: 0,
          pendingModel: false,
          renderInFlight: false,
          mappedKind: input?.type ?? null,
          rawSummary: summarizeForDebug(event),
          context: options.dispatchContextProvider?.(),
        })
      }
      if (input) setTimeout(() => dispatchInput(input), 0)
    })
    return new EvenHubGlassesBridge(
      sdk,
      typeof unsubscribeEvents === 'function' ? unsubscribeEvents : undefined,
      listenerToken,
    )
  }

  private queueDepthSnapshot() {
    return {
      partialInFlight: this.panelRenderInFlight ? 1 : 0,
      partialPending: this.pendingPanelModel !== undefined ? 1 : 0,
      fullRenderInFlight: this.fullRenderInFlight ? 1 : 0,
    }
  }

  private emitQueueDepth(reason: BridgeQueueDepthReason) {
    const snap = this.queueDepthSnapshot()
    logBridgeQueueDepth({
      reason,
      partialInFlight: snap.partialInFlight,
      partialPending: snap.partialPending,
      fullRenderInFlight: snap.fullRenderInFlight,
      dispatched: this.partialRenderDispatched,
      dropped: this.partialRenderDropped,
      flushed: this.partialRenderFlushed,
      staleDropped: this.stalePartialRenderDropped,
    })
  }

  async render(model: ScreenModel) {
    if (this.rebuildInFlight && Date.now() - this.rebuildSentAt < REBUILD_MAX_WAIT_MS) {
      this.pendingFullModel = model
      if (!this.pendingFlushTimer) {
        // If the host never answers the page in flight, stop waiting for it once the limit passes.
        this.pendingFlushTimer = setTimeout(() => this.rebuildFinished(), REBUILD_MAX_WAIT_MS)
      }
      logTeleGlanceTest('render.queued', { reason: 'rebuild-in-flight' })
      return
    }
    this.pendingFullModel = undefined
    if (!this.hasRendered && !this.startupBootstrapped && model.kind === 'sidebar') {
      // The host creates the first page only once, and only a plain text page has been proven to be accepted there.
      // Send the chat list as text first (it is on the glasses at once), then apply the full layout as a rebuild.
      this.startupBootstrapped = true
      this.pendingFullModel = model
      model = { kind: 'text', title: model.title, body: model.panelBody.trim() ? model.panelBody : ' ', footer: getLocale().footerFetchingChats }
    }
    this.rebuildInFlight = true
    this.rebuildSentAt = Date.now()
    const generation = ++this.pageGeneration
    const sequence = ++this.renderSequence
    // A full page rebuild invalidates every pending partial update. Clear the
    // queued panel model and cancel the idle timer so that enqueued scroll
    // updates or topic-preview renders from a previous page layout cannot
    // target containers that no longer exist.
    if (this.panelRenderTimer) {
      clearTimeout(this.panelRenderTimer)
      this.panelRenderTimer = undefined
    }
    this.pendingPanelModel = undefined
    this.panelRenderQueuedAfter = false
    // Do NOT reset panelRenderInFlight here — an in-flight partial update that
    // started before the full render will be rejected by the generation check
    // inside renderSidebarPanel when it resolves, and we want it to finish
    // naturally rather than leave the SDK in a half-updated state.
    this.fullRenderInFlight = true
    this.fullRenderKind = model.kind
    this.emitQueueDepth('full-render-start')
    try {
      // Let a pending mic start/stop finish first; rebuilding the page mid-teardown is the
      // suspected cause of crashes right after cancelling a recording.
      await this.audioChain
      // A page rebuild while pixels are still being sent timed out in the logs (and the link then stalled), so let the
      // transfer finish first; give up waiting if it is itself stuck.
      // A transfer that timed out may still be running on the host side: give it a moment as well.
      if (this.imageSending || this.imageCooldownMs() > 0) {
        const busy = (async () => {
          await this.imageSending?.catch(() => undefined)
          await this.imageCooldown()
        })()
        await Promise.race([busy, sleep(IMAGE_BUSY_MAX_WAIT_MS)])
      }

      if (this.hasRendered) {
        const container = buildPage(model, RebuildPageContainer, this.layoutTier)
        logTeleGlanceTest('bridge', { method: 'rebuildPageContainer', args: { sequence, generation, hasPanelBox: model.kind === 'sidebar' ? Boolean(model.panelBox) : false } })
        // Log the render event BEFORE the SDK call. The simulator's
        // `rebuildPageContainer` can hang for several seconds on some
        // screen transitions (notably the recording flow), and the
        // harness needs visibility into what was sent to the bridge
        // to validate content. On real hardware this pre-call log is
        // essentially a duplicate of the post-call one — both fire
        // within microseconds. The `attempted: true` flag
        // distinguishes the pre-call log.
        logTeleGlanceTest('render', { sequence, generation, model: summarizeScreenModel(model), attempted: true })
        // The SDK call is not awaited, so a hung `rebuildPageContainer` (the simulator's Flutter thread blocks on
        // some transitions; real hosts take hundreds of ms to seconds) cannot hold `fullRenderInFlight`. The page
        // stays "in flight" (`rebuildInFlight`) until the host answers or `REBUILD_MAX_WAIT_MS` passes; newer
        // screens wait in `pendingFullModel` and the bookkeeping (`lastSidebarModel`, the completion log, retries
        // on refusal) runs in the answer handlers below.
        const rebuildStartedAt = Date.now()
        this.sdk.rebuildPageContainer(container).then(
          (accepted) => {
            this.rebuildFinished()
            debugNote?.('page-rebuild', { durationMs: Date.now() - rebuildStartedAt, accepted, withImage: model.kind === 'sidebar' && Boolean(model.panelImage), tier: this.layoutTier, imageBusy: Boolean(this.imageSending) })
            // The host answers `false` when it refuses a page. Ignoring that left the glasses on the previous
            // screen while the phone moved on, so fall back to a simpler layout and try again.
            if (accepted === false) {
              this.handleRejectedPage(model, generation, 'rebuildPageContainer', false, Date.now() - rebuildStartedAt)
              return
            }
            this.timeoutRetries = 0
            this.lastSidebarModel = model.kind === 'sidebar' ? model : undefined
            logTeleGlanceTest('render', { sequence, generation, model: summarizeScreenModel(model) })
            if (this.onBootstrapPage) {
              this.onBootstrapPage = false
              const newer = this.selectionAfterRebuild
              this.selectionAfterRebuild = undefined
              if (newer && model.kind === 'sidebar') this.enqueueSidebarPanel(newer) // the user scrolled while the layout was being sent
            }
          },
          () => {
            this.rebuildFinished()
            // SDK call rejected. Mark the bridge as needing a full
            // rebuild so the next render uses
            // `createStartUpPageContainer` instead of
            // `rebuildPageContainer`.
            this.hasRendered = false
            logTeleGlanceTest('render.failed', { sequence, generation, method: 'rebuildPageContainer' })
          },
        )
      } else {
        const container = buildPage(model, CreateStartUpPageContainer, this.layoutTier)
        logTeleGlanceTest('bridge', { method: 'createStartUpPageContainer', args: { sequence, generation, hasPanelBox: model.kind === 'sidebar' ? Boolean(model.panelBox) : false } })
        logTeleGlanceTest('render', { sequence, generation, model: summarizeScreenModel(model), attempted: true })
        const startupStartedAt = Date.now()
        this.sdk.createStartUpPageContainer(container).then(
          (result) => {
            this.rebuildFinished()
            if (typeof result === 'number' && result !== 0) {
              debugNote?.('startup-page', { accepted: false, result: String(result), durationMs: Date.now() - startupStartedAt })
              this.handleRejectedPage(model, generation, 'createStartUpPageContainer', result)
              return
            }
            this.hasRendered = true
            this.onBootstrapPage = this.startupBootstrapped && model.kind === 'text'
            debugNote?.('startup-page', { accepted: true, bootstrap: this.onBootstrapPage, durationMs: Date.now() - startupStartedAt })
            this.lastSidebarModel = model.kind === 'sidebar' ? model : undefined
            logTeleGlanceTest('render', { sequence, generation, model: summarizeScreenModel(model) })
          },
          () => {
            this.rebuildFinished()
            logTeleGlanceTest('render.failed', { sequence, generation, method: 'createStartUpPageContainer' })
          },
        )
      }
    } catch (error) {
      this.rebuildFinished()
      throw error
    } finally {
      this.fullRenderInFlight = false
      this.fullRenderKind = undefined
      this.emitQueueDepth('full-render-end')
      // A list scroll that arrived while this page was being prepared was held back; apply it now.
      if (this.pendingPanelModel && !this.panelRenderInFlight) this.schedulePanelFlush()
    }
  }

  /** The page in flight was answered (or given up on): send the newest waiting screen, if any. */
  private rebuildFinished() {
    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer)
      this.pendingFlushTimer = undefined
    }
    this.rebuildInFlight = false
    const next = this.pendingFullModel
    if (!next) {
      this.releasePageWaiters()
      return
    }
    this.pendingFullModel = undefined
    void this.render(next).catch(() => undefined)
  }

  /**
   * Resolves once no page is being drawn or waiting to be drawn. Picture pixels must follow the page that holds their
   * container: sent earlier, they hit the old (tiny) placeholder and the new page then lands with an empty slot.
   */
  pageSettled(): Promise<void> {
    if (!this.rebuildInFlight && !this.pendingFullModel) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.pageSettledWaiters = this.pageSettledWaiters.filter((waiter) => waiter !== done)
        resolve()
      }
      const timer = setTimeout(done, PAGE_SETTLE_MAX_WAIT_MS)
      this.pageSettledWaiters.push(done)
    })
  }

  private releasePageWaiters() {
    const waiters = this.pageSettledWaiters
    this.pageSettledWaiters = []
    for (const waiter of waiters) waiter()
  }

  /**
   * The host refused a page. Log it, step down to a simpler sidebar layout and render the same screen again, unless a
   * newer render has already replaced it. After the simplest layout there is nothing left to try.
   */
  private handleRejectedPage(model: ScreenModel, generation: number, method: string, result: unknown, durationMs = 0) {
    logTeleGlanceTest('render.rejected', { generation, method, result: String(result), tier: this.layoutTier })
    if (model.kind !== 'sidebar') return
    if (generation !== this.pageGeneration) return
    // Every "refusal" seen on the glasses took ~2.1 s: the host timed out because its link was busy (a startup page or
    // a picture transfer still going), it did not reject the layout. Wait and send the same layout again instead of
    // stepping down to a poorer one; only a quick refusal, or repeated timeouts, change the layout.
    if (durationMs >= TIMEOUT_REFUSAL_MS && this.timeoutRetries < MAX_TIMEOUT_RETRIES) {
      this.timeoutRetries += 1
      debugNote?.('page-retry', { attempt: this.timeoutRetries, tier: this.layoutTier, durationMs })
      if (this.timeoutRetryTimer) clearTimeout(this.timeoutRetryTimer)
      this.timeoutRetryTimer = setTimeout(() => {
        this.timeoutRetryTimer = undefined
        if (generation === this.pageGeneration) void this.render(model).catch(() => undefined)
      }, TIMEOUT_RETRY_DELAY_MS)
      return
    }
    this.timeoutRetries = 0
    if (this.layoutTier >= 2) return
    this.layoutTier = (this.layoutTier + 1) as LayoutTier
    void this.render(model).catch(() => undefined)
  }

  /**
   * Partial render that updates the app-owned sidebar marker and right-panel text without
   * rebuilding the page. If `hasRendered` is false or the SDK lacks
   * `textContainerUpgrade`, fall back to a full rebuild.
   *
   * When `expectedGeneration` is provided, the update is silently dropped if the
   * page has been rebuilt since the model was created. When called directly from
   * the controller (no generation passed), the call is inherently valid because the
   * controller built the model for the current page state.
   */
  async renderSidebarPanel(model: Extract<ScreenModel, { kind: 'sidebar' }>, expectedGeneration?: number) {
    if (expectedGeneration !== undefined && expectedGeneration !== this.pageGeneration) {
      this.stalePartialRenderDropped += 1
      logTeleGlanceTest('render.partial.stale', {
        expectedGeneration,
        currentGeneration: this.pageGeneration,
        reason: 'generation-mismatch',
      })
      return
    }
    if (this.fullRenderInFlight) {
      if (this.fullRenderKind === 'sidebar') {
        // The page being prepared has the same containers: keep this (newer) list state and apply it once the page is
        // sent, instead of losing the scroll. A model queued meanwhile is newer still and wins.
        if (!this.pendingPanelModel) this.pendingPanelModel = { model, generation: this.pageGeneration }
        this.panelDiffReset = true
        logTeleGlanceTest('render.partial.deferred', { generation: this.pageGeneration, reason: 'full-render-in-flight' })
        return
      }
      this.stalePartialRenderDropped += 1
      logTeleGlanceTest('render.partial.stale', {
        expectedGeneration: expectedGeneration ?? 'none',
        currentGeneration: this.pageGeneration,
        reason: 'full-render-in-flight',
      })
      return
    }
    const sequence = ++this.renderSequence
    if (this.onBootstrapPage && typeof this.sdk.textContainerUpgrade === 'function') {
      // The glasses still show the text startup page: scroll the list in its body, and keep the interactive page that
      // is about to replace it in step with the selection.
      if (this.pendingFullModel) this.pendingFullModel = model
      this.selectionAfterRebuild = this.rebuildInFlight ? model : undefined
      if (this.rebuildInFlight) return
      const content = trimForContainer(model.panelBody.trim() ? model.panelBody : ' ', 999)
      await withTimeout(this.sdk.textContainerUpgrade(new TextContainerUpgrade({
        containerID: 2,
        containerName: 'body',
        content,
        contentOffset: 0,
        contentLength: content.length,
      })), 1000, 'textContainerUpgrade')
      return
    }
    if (!this.hasRendered || typeof this.sdk.textContainerUpgrade !== 'function') {
      await this.render(model)
      return
    }
    // After a full page went out the glasses may show it before `lastSidebarModel` catches up, so diff against nothing.
    const updates = buildSidebarPanelUpdates(model, this.panelDiffReset ? undefined : this.lastSidebarModel)
    this.panelDiffReset = false
    logTeleGlanceTest('bridge', { method: 'textContainerUpgrade', args: { sequence, generation: this.pageGeneration, count: updates.length, hasPanelBox: Boolean(model.panelBox) } })
    logTeleGlanceTest('render', { sequence, generation: this.pageGeneration, partial: true, model: summarizeScreenModel(model), attempted: true })
    for (const update of updates) {
      await withTimeout(this.sdk.textContainerUpgrade(update), 1000, 'textContainerUpgrade')
    }
    this.lastSidebarModel = model
    this.partialRenderFlushed += 1
    logTeleGlanceTest('render', { sequence, generation: this.pageGeneration, partial: true, model: summarizeScreenModel(model) })
  }

  /**
   * Fire-and-forget, latest-wins partial render for chat/topic list scrolls.
   *
   * The list-scroll input handler must return to the user as fast as possible. Awaiting
   * `textContainerUpgrade` calls here would couple native render latency to the input path
   * and would queue stale panel updates behind slow ones on real G2 hardware.
   *
   * Instead, this method:
   *   1. Stores the latest model in `pendingPanelModel`, overwriting any earlier queued model.
   *   2. (Re)starts the `panelRenderIdleMs` timer, so the flush runs once scrolling pauses.
   *   3. While a flush is in flight, marks `panelRenderQueuedAfter`; the in-flight flush schedules
   *      the next one when it finishes.
   *   4. Counts both `partialRenderDispatched` and `partialRenderDropped` so the test
   *      harness can verify coalescing.
   *
   * It returns synchronously once the model is queued; the native render happens later.
   */
  enqueueSidebarPanel(model: Extract<ScreenModel, { kind: 'sidebar' }>): void {
    this.partialRenderDispatched += 1
    const generation = this.pageGeneration
    const previous = this.pendingPanelModel
    this.pendingPanelModel = { model, generation }
    if (previous) this.partialRenderDropped += 1
    if (this.panelRenderInFlight) {
      this.panelRenderQueuedAfter = true
      logTeleGlanceTest('render.partial.enqueue', {
        generation,
        dropped: previous ? 1 : 0,
        coalesced: previous ? 1 : 0,
        inFlight: true,
      })
      this.emitQueueDepth('enqueue')
      return
    }
    if (this.panelRenderTimer) {
      clearTimeout(this.panelRenderTimer)
      this.panelRenderTimer = setTimeout(() => {
        this.panelRenderTimer = undefined
        void this.flushPanelQueue()
      }, this.panelRenderIdleMs)
      const maybeNodeTimeout = this.panelRenderTimer as unknown as { unref?: () => void }
      maybeNodeTimeout.unref?.()
      logTeleGlanceTest('render.partial.enqueue', {
        generation,
        dropped: previous ? 1 : 0,
        coalesced: previous ? 1 : 0,
        inFlight: false,
      })
      this.emitQueueDepth('enqueue')
      return
    }
    this.panelRenderTimer = setTimeout(() => {
      this.panelRenderTimer = undefined
      void this.flushPanelQueue()
    }, this.panelRenderIdleMs)
    const maybeNodeTimeout = this.panelRenderTimer as unknown as { unref?: () => void }
    maybeNodeTimeout.unref?.()
    logTeleGlanceTest('render.partial.enqueue', {
      generation,
      dropped: previous ? 1 : 0,
      coalesced: previous ? 1 : 0,
      inFlight: false,
    })
    this.emitQueueDepth('enqueue')
  }

  /**
   * Drain the latest queued panel model through the partial-render path. If a newer model
   * arrives while we are rendering, the trailing flag is set so the queue re-renders once.
   */
  async flushPanelQueue(): Promise<void> {
    if (this.panelRenderInFlight) return
    const entry = this.pendingPanelModel
    if (!entry) return
    this.pendingPanelModel = undefined
    this.panelRenderInFlight = true
    this.panelRenderQueuedAfter = false
    this.emitQueueDepth('flush-start')
    const startedAt = Date.now()
    try {
      await this.renderSidebarPanel(entry.model, entry.generation)
    } catch {
      // Rendering failures must not stall the queue.
    } finally {
      const durationMs = Date.now() - startedAt
      logTeleGlanceTest('render.partial.flush', { generation: entry.generation, durationMs })
      this.panelRenderInFlight = false
      this.emitQueueDepth('flush-end')
      if (this.pendingPanelModel) {
        this.panelRenderQueuedAfter = false
        // While a full page is being prepared, `render` flushes the held model when it is done.
        if (!this.fullRenderInFlight) this.schedulePanelFlush()
      } else if (this.panelRenderQueuedAfter) {
        this.panelRenderQueuedAfter = false
      }
    }
  }

  private schedulePanelFlush() {
    if (this.disposed) return
    if (this.panelRenderTimer) clearTimeout(this.panelRenderTimer)
    this.panelRenderTimer = setTimeout(() => {
      this.panelRenderTimer = undefined
      void this.flushPanelQueue()
    }, this.panelRenderIdleMs)
    const maybeNodeTimeout = this.panelRenderTimer as unknown as { unref?: () => void }
    maybeNodeTimeout.unref?.()
  }

  dispose() {
    this.disposed = true
    if (this.listenerToken && activeEventListenerToken === this.listenerToken) {
      activeEventListenerToken = undefined
    }
    if (this.panelRenderTimer) {
      clearTimeout(this.panelRenderTimer)
      this.panelRenderTimer = undefined
    }
    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer)
      this.pendingFlushTimer = undefined
    }
    if (this.timeoutRetryTimer) {
      clearTimeout(this.timeoutRetryTimer)
      this.timeoutRetryTimer = undefined
    }
    this.pendingFullModel = undefined
    this.pendingImage = undefined
    this.releasePageWaiters()
    this.pendingPanelModel = undefined
    this.lastSidebarModel = undefined
    this.panelRenderInFlight = false
    this.panelRenderQueuedAfter = false
    this.fullRenderInFlight = false
    this.pageGeneration = 0
    this.stalePartialRenderDropped = 0
    this.unsubscribeEvents?.()
    this.unsubscribeEvents = undefined
  }
  /** Test/debug introspection: returns counters of queued partial render activity. */
  getPartialRenderStats() {
    return {
      dispatched: this.partialRenderDispatched,
      dropped: this.partialRenderDropped,
      flushed: this.partialRenderFlushed,
      staleDropped: this.stalePartialRenderDropped,
    }
  }
  /**
   * Send photo pixels to the panel image container. The SDK forbids concurrent image transfers and
   * warns against frequent ones, so requests are serialised and only the latest pending one is kept.
   */
  updateImage(png: Uint8Array): Promise<boolean> {
    if (typeof this.sdk.updateImageRawData !== 'function') return Promise.resolve(false)
    this.pendingImage = png
    if (this.imageSending) return this.imageSending
    const run = async (): Promise<boolean> => {
      let ok = false
      try {
        // Never send pixels while a page is being drawn or waiting to be: the host times such transfers out.
        await this.pageSettled()
        while (this.pendingImage) {
          // A previous transfer timed out: the host may still be working on it, so do not start another at once.
          await this.imageCooldown()
          const next = this.pendingImage
          if (!next) break
          this.pendingImage = undefined
          const startedAt = Date.now()
          let timedOut = false
          const result = await withTimeout(
            this.sdk.updateImageRawData!(new ImageRawDataUpdate({
              containerID: IMAGE_CONTAINER_ID,
              containerName: IMAGE_CONTAINER_NAME,
              imageData: next,
            })),
            IMAGE_TRANSFER_TIMEOUT_MS,
            'updateImageRawData',
            () => { timedOut = true },
          )
          if (timedOut) this.imageCooldownUntil = Date.now() + IMAGE_TIMEOUT_COOLDOWN_MS
          ok = !timedOut && isImageSuccess(result)
          const durationMs = Date.now() - startedAt
          logTeleGlanceTest('image', { bytes: next.byteLength, result: String(result), ok, durationMs, timedOut })
          debugNote?.('image-transfer', { bytes: next.byteLength, result: String(result), ok, durationMs, timedOut })
        }
      } catch {
        ok = false
      } finally {
        this.imageSending = undefined
      }
      return ok
    }
    this.imageSending = run()
    return this.imageSending
  }

  private imageCooldownMs() {
    return Math.max(0, this.imageCooldownUntil - Date.now())
  }

  private async imageCooldown() {
    const remaining = this.imageCooldownMs()
    if (remaining > 0) await sleep(remaining)
  }

  async setAudioEnabled(enabled: boolean) {
    logTeleGlanceTest('bridge', { method: 'setAudioEnabled', args: { enabled } })
    // In fixture mode the audio pipeline is fully simulated: the test
    // injects PCM via `injectAudioChunks` and supplies a transcript via
    // `setNextTranscript`. Calling the native `audioControl` is wasted
    // work that also keeps the simulator's Flutter main thread busy
    // — the simulator's microphone handler can take several seconds
    // to complete and the HTTP server is blocked while it runs. Skip
    // the native call entirely in fixture mode; the harness can
    // verify the recording flow via the test event stream and the
    // render model, neither of which need the audio control to run.
    if (isTeleGlanceFixtureMode()) return
    // Race the audio control call against a 1s timeout. The simulator's
    // audioControl implementation can hang indefinitely, blocking the
    // simulator's HTTP server from responding to subsequent /api/input
    // requests. On real hardware audio control is fast (<50ms), so this
    // timeout only fires on the simulator.
    // Queue mic on/off one at a time and skip redundant calls, so a quick start-then-cancel
    // never overlaps two native audioControl calls (or a page rebuild, see render()).
    const run = async () => {
      if (this.audioOn === enabled) return
      this.audioOn = enabled
      try {
        await withTimeout(this.sdk.audioControl(enabled), 1000, 'audioControl')
      } catch (error) {
        this.audioOn = !enabled
        throw error
      }
    }
    const queued = this.audioChain.then(run, run)
    this.audioChain = queued.catch(() => undefined)
    await queued
  }

  async showExitConfirmation() {
    if (typeof this.sdk.shutDownPageContainer === 'function') {
      await this.sdk.shutDownPageContainer(1)
      return
    }
    await this.sdk.callEvenApp?.('shutDownPageContainer', { exitMode: 1 })
  }

  async turnScreenOff() {
    try {
      if (typeof this.sdk.screenOff === 'function') {
        await this.sdk.screenOff()
        logTeleGlanceTest('bridge', { method: 'turnScreenOff', args: { via: 'screenOff' } })
        return
      }
      if (typeof this.sdk.turnScreenOff === 'function') {
        await this.sdk.turnScreenOff()
        logTeleGlanceTest('bridge', { method: 'turnScreenOff', args: { via: 'turnScreenOff' } })
        return
      }
      await this.sdk.callEvenApp?.('screenOff', {})
      logTeleGlanceTest('bridge', { method: 'turnScreenOff', args: { via: 'callEvenApp' } })
    } catch {
      logTeleGlanceTest('bridge', { method: 'turnScreenOff', args: { error: 'not supported' } })
    }
  }

  async getLocalStorage(key: string) {
    return this.sdk.getLocalStorage?.(key) ?? ''
  }

  async setLocalStorage(key: string, value: string) {
    return this.sdk.setLocalStorage?.(key, value) ?? false
  }
}

type PageContainerClass = typeof CreateStartUpPageContainer | typeof RebuildPageContainer
type LayoutTier = 0 | 1 | 2


function buildPage(model: ScreenModel, Container: PageContainerClass, tier: LayoutTier = 0) {
  if (model.kind === 'sidebar') return buildSidebarPage(model, Container, tier)
  if (model.kind === 'list') return buildListPage(model, Container)
  return buildTextPage(model, Container)
}

function buildSidebarPage(model: Extract<ScreenModel, { kind: 'sidebar' }>, Container: PageContainerClass, tier: LayoutTier = 0) {
  // Tier 0: stacking order + popup container. Tier 1: no stacking order. Tier 2: the original layout (no popup
  // container; a popup is folded into the body text). Lower tiers exist because a host that rejects the richer page
  // leaves the glasses stuck on the previous screen.
  const z = (index: number) => (tier === 0 ? { zOrderIndex: index } : {})
  if (tier >= 2 && model.popup) {
    model = { ...model, panelBody: `${model.popup.title}\n\n${model.popup.body}`, popup: undefined }
  }
  const fullWidth = model.fullWidth === true

  const outerBorder = new TextContainerProperty({
    containerID: 0,
    containerName: 'outer',
    content: '',
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    borderWidth: 2,
    borderColor: 8,
    paddingLength: 0,
    isEventCapture: 0,
    ...z(1),
  })
  const title = new TextContainerProperty({
    containerID: 1,
    containerName: 'title',
    content: trimForContainer(model.title, 100),
    xPosition: 2,
    yPosition: 2,
    width: 572,
    height: 36,
    borderWidth: 0,
    borderColor: 8,
    paddingLength: 4,
    isEventCapture: 0,
    ...z(2),
  })
  const overlay = new TextContainerProperty({
    containerID: 2,
    containerName: 'event-overlay',
    content: '',
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    borderWidth: 0,
    borderColor: 8,
    paddingLength: 0,
    isEventCapture: 1,
    ...z(3),
  })
  const sidebarSeparator = new TextContainerProperty({
    containerID: 3,
    containerName: 'separator',
    content: '',
    xPosition: fullWidth ? 0 : 168,
    yPosition: fullWidth ? 287 : 38,
    width: fullWidth ? 1 : 2,
    height: fullWidth ? 1 : 206,
    borderWidth: fullWidth ? 0 : 1,
    borderColor: 8,
    paddingLength: 0,
    isEventCapture: 0,
    ...z(4),
  })
  const panelBody = new TextContainerProperty({
    containerID: 6,
    content: trimForContainer(fillToContainer(model.panelBody || ' '), 999),
    xPosition: fullWidth ? 2 : 170,
    yPosition: 38,
    // With a photo the text moves into a narrow left column and the picture takes the right side.
    width: fullWidth ? 572 : 404,
    // Seven rows of 27 px plus padding: a shorter container cut the descenders off the seventh row.
    height: fullWidth ? 200 : 206,
    borderWidth: 0,
    borderColor: 8,
    paddingLength: 4,
    isEventCapture: 0,
    ...z(6),
  })
  const panelBox = model.panelBox
    ? new TextContainerProperty({
        containerID: 7,
        containerName: 'panel-box',
        content: trimForContainer(formatBoxContent(model.panelBox), 999),
        xPosition: fullWidth ? 14 : 184,
        yPosition: 54,
        width: fullWidth ? 548 : 376,
        height: 190,
        borderWidth: 1,
        borderColor: 8,
        paddingLength: 8,
        isEventCapture: 0,
        ...z(7),
      })
    : new TextContainerProperty({
        containerID: 7,
        containerName: 'panel-box',
        content: '',
        xPosition: 0,
        yPosition: 287,
        width: 1,
        height: 1,
        borderWidth: 0,
        borderColor: 8,
        paddingLength: 0,
        isEventCapture: 0,
        ...z(7),
      })
  // Always present (stable container ids). Without a photo it is a 20x20 blank in the gap above the footer.
  const panelImage = model.panelImage
    ? new ImageContainerProperty({
        containerID: IMAGE_CONTAINER_ID,
        containerName: IMAGE_CONTAINER_NAME,
        xPosition: 8,
        // Sits over the blank rows the message text leaves for it (body top 38 + padding 4 + rows above).
        yPosition: Math.min(238 - INLINE_IMAGE_HEIGHT, 38 + 4 + model.panelImage.topLine * MESSAGE_ROW_HEIGHT_PX + 3),
        width: INLINE_IMAGE_WIDTH,
        height: INLINE_IMAGE_HEIGHT,
        ...z(8),
      })
    : new ImageContainerProperty({
        containerID: IMAGE_CONTAINER_ID,
        containerName: IMAGE_CONTAINER_NAME,
        xPosition: 552,
        yPosition: 226,
        width: 20,
        height: 20,
        ...z(8),
      })
  const footer = new TextContainerProperty({
    containerID: 4,
    containerName: 'footer',
    content: trimForContainer(model.panelFooter, 120),
    xPosition: 2,
    yPosition: 248,
    width: 572,
    height: 38,
    borderWidth: 1,
    borderColor: 8,
    paddingLength: 4,
    isEventCapture: 0,
    ...z(9),
  })
  const sidebar = new TextContainerProperty({
    containerID: 5,
    containerName: 'sidebar',
    content: fullWidth ? '' : trimForContainer(formatSidebarAsText(model), 999),
    xPosition: fullWidth ? 0 : 2,
    yPosition: fullWidth ? 287 : 38,
    width: fullWidth ? 1 : 166,
    height: fullWidth ? 1 : 206,
    borderWidth: 0,
    borderColor: 8,
    paddingLength: 4,
    isEventCapture: 0,
    ...z(5),
  })
  // Dialog drawn above everything else. Always present (stable ids): a 1x1 blank when there is no popup.
  const popup = model.popup
    ? new TextContainerProperty({
        containerID: POPUP_CONTAINER_ID,
        containerName: POPUP_CONTAINER_NAME,
        content: trimForContainer(`${model.popup.title}\n\n${model.popup.body}`, 999),
        xPosition: 48,
        yPosition: 44,
        width: 480,
        height: 196,
        borderWidth: 2,
        borderColor: 8,
        paddingLength: 10,
        isEventCapture: 0,
        ...z(10),
      })
    : new TextContainerProperty({
        containerID: POPUP_CONTAINER_ID,
        containerName: POPUP_CONTAINER_NAME,
        content: '',
        xPosition: 0,
        yPosition: 287,
        width: 1,
        height: 1,
        borderWidth: 0,
        borderColor: 8,
        paddingLength: 0,
        isEventCapture: 0,
        ...z(10),
      })
  // The SDK native list moves its highlight without reporting each movement to
  // the app, so it cannot keep the right-side preview in sync. Use one event
  // overlay plus an app-rendered sidebar marker instead.
  const list = hiddenListContainer(tier === 0 ? 0 : undefined)
  const textObjects = tier >= 2
    ? [outerBorder, title, overlay, sidebarSeparator, sidebar, panelBody, panelBox, footer]
    : [outerBorder, title, overlay, sidebarSeparator, sidebar, panelBody, panelBox, footer, popup]
  return new Container({
    containerTotalNum: textObjects.length + 2,
    textObject: textObjects,
    listObject: [list],
    imageObject: [panelImage],
  })
}

/**
 * Build the right-panel `TextContainerUpgrade` payloads that the partial-render path
 * sends to the glasses. We mirror the trim rules used by `buildSidebarPage` so the
 * partial update looks identical to a full rebuild. The hidden native list stays
 * untouched while the app-rendered sidebar marker and right panel are updated.
 */
function buildSidebarPanelUpdates(
  model: Extract<ScreenModel, { kind: 'sidebar' }>,
  previous?: Extract<ScreenModel, { kind: 'sidebar' }>,
): TextContainerUpgrade[] {
  const updates: TextContainerUpgrade[] = []
  const title = trimForContainer(model.title, 100)
  if (!previous || title !== trimForContainer(previous.title, 100)) updates.push(new TextContainerUpgrade({
    containerID: 1,
    containerName: 'title',
    content: title,
    contentOffset: 0,
    contentLength: title.length,
  }))
  const sidebar = model.fullWidth ? '' : trimForContainer(formatSidebarAsText(model), 999)
  const previousSidebar = previous?.fullWidth ? '' : previous ? trimForContainer(formatSidebarAsText(previous), 999) : undefined
  if (sidebar !== previousSidebar) updates.push(new TextContainerUpgrade({
    containerID: 5,
    containerName: 'sidebar',
    content: sidebar,
    contentOffset: 0,
    contentLength: sidebar.length,
  }))
  const panelBody = trimForContainer(fillToContainer(model.panelBody || ' '), 999)
  const previousPanelBody = previous ? trimForContainer(fillToContainer(previous.panelBody || ' '), 999) : undefined
  if (panelBody !== previousPanelBody) updates.push(new TextContainerUpgrade({
    containerID: 6,
    containerName: 'panel-body',
    content: panelBody,
    contentOffset: 0,
    contentLength: panelBody.length,
  }))
  const boxContent = model.panelBox
    ? trimForContainer(formatBoxContent(model.panelBox), 999)
    : ''
  const previousBoxContent = previous?.panelBox
    ? trimForContainer(formatBoxContent(previous.panelBox), 999)
    : ''
  if (boxContent !== previousBoxContent) updates.push(new TextContainerUpgrade({
    containerID: 7,
    containerName: 'panel-box',
    content: boxContent,
    contentOffset: 0,
    contentLength: boxContent.length,
  }))
  const footer = trimForContainer(model.panelFooter, 120)
  const previousFooter = previous ? trimForContainer(previous.panelFooter, 120) : undefined
  if (footer !== previousFooter) updates.push(new TextContainerUpgrade({
    containerID: 4,
    containerName: 'footer',
    content: footer,
    contentOffset: 0,
    contentLength: footer.length,
  }))
  return updates
}
function buildTextPage(model: Extract<ScreenModel, { kind: 'text' }>, Container: PageContainerClass) {
  if (model.box && model.footer) return buildBoxedTextPage(model, model.box, Container)

  const hasFooter = Boolean(model.footer)
  const title = new TextContainerProperty({
    containerID: 1,
    containerName: 'title',
    content: trimForContainer(model.title, 120),
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 42,
    borderWidth: 0,
    borderColor: 8,
    paddingLength: 4,
    isEventCapture: 0,
  })
  const body = new TextContainerProperty({
    containerID: 2,
    containerName: 'body',
    content: trimForContainer(model.body, 999),
    xPosition: 0,
    yPosition: 42,
    width: 576,
    height: hasFooter ? 190 : 246,
    borderWidth: 0,
    borderColor: 8,
    paddingLength: 4,
    isEventCapture: 1,
  })
  const footer = new TextContainerProperty({
    containerID: 4,
    containerName: 'footer',
    content: trimForContainer(model.footer ?? '', 180),
    xPosition: 0,
    yPosition: 246,
    width: 576,
    height: 42,
    borderWidth: hasFooter ? 1 : 0,
    borderColor: 8,
    paddingLength: hasFooter ? 4 : 0,
    isEventCapture: 0,
  })
  const list = hiddenListContainer()
  return new Container({
    containerTotalNum: 4,
    textObject: [title, body, footer],
    listObject: [list],
  })
}

function buildBoxedTextPage(model: Extract<ScreenModel, { kind: 'text' }>, boxedBody: BoxedBody, Container: PageContainerClass) {
  const title = new TextContainerProperty({
    containerID: 1,
    containerName: 'title',
    content: trimForContainer(model.title, 120),
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 42,
    borderWidth: 0,
    borderColor: 8,
    paddingLength: 4,
    isEventCapture: 0,
  })
  const overlay = new TextContainerProperty({
    containerID: 2,
    containerName: 'body-events',
    content: '',
    xPosition: 0,
    yPosition: 42,
    width: 576,
    height: 204,
    borderWidth: 0,
    borderColor: 8,
    paddingLength: 0,
    isEventCapture: 1,
  })
  const box = new TextContainerProperty({
    containerID: 5,
    containerName: 'msg-box',
    content: trimForContainer(formatBoxContent(boxedBody), 999),
    xPosition: 14,
    yPosition: 58,
    width: 548,
    height: 172,
    borderWidth: 1,
    borderColor: 8,
    paddingLength: 8,
    isEventCapture: 0,
  })
  const footer = new TextContainerProperty({
    containerID: 4,
    containerName: 'footer',
    content: trimForContainer(model.footer ?? '', 180),
    xPosition: 0,
    yPosition: 246,
    width: 576,
    height: 42,
    borderWidth: 1,
    borderColor: 8,
    paddingLength: 4,
    isEventCapture: 0,
  })
  const list = hiddenListContainer()
  return new Container({
    containerTotalNum: 5,
    textObject: [title, overlay, box, footer],
    listObject: [list],
  })
}

type BoxedBody = NonNullable<Extract<ScreenModel, { kind: 'text' }>['box']>

function buildListPage(model: Extract<ScreenModel, { kind: 'list' }>, Container: PageContainerClass) {
  const content = new TextContainerProperty({
    containerID: 5,
    containerName: 'menu',
    content: trimForContainer(formatListAsText(model), 999),
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    borderWidth: 0,
    borderColor: 8,
    paddingLength: 6,
    isEventCapture: 0,
  })
  const overlay = new TextContainerProperty({
    containerID: 2,
    containerName: 'event-overlay',
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    borderWidth: 0,
    borderColor: 8,
    paddingLength: 0,
    content: '',
    isEventCapture: 1,
  })
  const list = hiddenListContainer()
  const footer = hiddenFooterContainer()
  return new Container({
    containerTotalNum: 4,
    textObject: [overlay, content, footer],
    listObject: [list],
  })
}

function hiddenListContainer(zOrderIndex?: number) {
  return new ListContainerProperty({
    ...(zOrderIndex === undefined ? {} : { zOrderIndex }),
    containerID: 8,
    containerName: 'list',
    xPosition: 0,
    yPosition: 287,
    width: 1,
    height: 1,
    borderWidth: 0,
    borderColor: 8,
    paddingLength: 0,
    itemContainer: new ListItemContainerProperty({
      itemCount: 1,
      itemWidth: 1,
      itemName: [''],
      isItemSelectBorderEn: 0,
    }),
    isEventCapture: 0,
  })
}

function hiddenFooterContainer() {
  return new TextContainerProperty({
    containerID: 4,
    containerName: 'footer',
    content: '',
    xPosition: 0,
    yPosition: 287,
    width: 1,
    height: 1,
    borderWidth: 0,
    borderColor: 8,
    paddingLength: 0,
    isEventCapture: 0,
  })
}

function trimForContainer(value: string, maxLength: number) {
  if (encoder.encode(value).byteLength <= maxLength) return value

  const suffix = '...'
  const contentLimit = Math.max(0, maxLength - encoder.encode(suffix).byteLength)
  let output = ''
  for (const char of value) {
    const candidate = output + char
    if (encoder.encode(candidate).byteLength > contentLimit) break
    output = candidate
  }
  return `${output}${suffix}`
}

function formatBoxContent(boxedBody: BoxedBody) {
  return boxedBody.content ? `${boxedBody.heading}\n\n${boxedBody.content}` : boxedBody.heading
}

function formatListAsText(model: Extract<ScreenModel, { kind: 'list' }>) {
  const items = model.items.length > 0 ? model.items : [getLocale().bridgeEmptyList]
  const visible = visibleListWindow(items, model.selectedIndex, 8)
  const lines = [
    model.title,
    '---------------------------',
    ...visible.map((item, index) => {
      const itemIndex = visible.start + index
      const marker = itemIndex === model.selectedIndex ? '> ' : '  '
      return `${marker}${trimForContainer(item, 54)}`
    }),
  ]
  return lines.join('\n')
}

function formatSidebarAsText(model: Extract<ScreenModel, { kind: 'sidebar' }>) {
  const items = model.sidebarItems.length > 0 ? model.sidebarItems : ['']
  const visible = visibleListWindow(items, model.sidebarSelected, 7)
  return [
    model.sidebarTitle,
    ...visible.map((item, index) => {
      const itemIndex = visible.start + index
      return `${itemIndex === model.sidebarSelected ? '> ' : '  '}${trimForContainer(item, 22)}`
    }),
  ].join('\n')
}

function visibleListWindow(items: string[], selectedIndex: number, maxVisible: number) {
  const clamped = Math.max(0, Math.min(selectedIndex, items.length - 1))
  const half = Math.floor(maxVisible / 2)
  const start = Math.max(0, Math.min(clamped - half, Math.max(0, items.length - maxVisible)))
  return Object.assign(items.slice(start, start + maxVisible), { start })
}

async function postDebugNote(note: string, data: Record<string, unknown>, authConfig?: () => TelegramAuthConfig) {
  try {
    const config = authConfig?.()
    const sharedSecret = config ? effectiveBackendSharedSecret(config, defaultApiBaseUrl()) : ''
    const effectiveConfig = config ? { ...config, backendSharedSecret: sharedSecret } : undefined
    const encryptedAuth = effectiveConfig ? await encryptedTelegramAuthHeader(effectiveConfig) : null
    if (!encryptedAuth || !sharedSecret) return
    const body = JSON.stringify({ source: 'even-hub', buildVersion: APP_BUILD_VERSION, raw: { event: note, ...sanitizeDebugNoteData(data) }, mapped: null, note })
    const encryptedPayload = await encryptJsonPayload(body, sharedSecret)
    await fetch(`${defaultApiBaseUrl()}/api/debug/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TeleGlance-Auth': encryptedAuth },
      body: JSON.stringify({ encryptedPayload }),
    })
  } catch {
    // Debug notes must never affect the glasses.
  }
}

async function logHardwareEvent(raw: unknown, mapped: AppInput | undefined, authConfig?: () => TelegramAuthConfig) {
  try {
    const config = authConfig?.()
    const sharedSecret = config ? effectiveBackendSharedSecret(config, defaultApiBaseUrl()) : ''
    const effectiveConfig = config ? { ...config, backendSharedSecret: sharedSecret } : undefined
    const encryptedAuth = effectiveConfig ? await encryptedTelegramAuthHeader(effectiveConfig) : null
    if (!encryptedAuth || !sharedSecret) return
    const body = JSON.stringify({
      source: 'even-hub',
      buildVersion: APP_BUILD_VERSION,
      raw: summarizeForDebug(raw),
      mapped: summarizeInputForDebug(mapped),
    })
    const encryptedPayload = await encryptJsonPayload(body, sharedSecret)
    await fetch(`${defaultApiBaseUrl()}/api/debug/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TeleGlance-Auth': encryptedAuth },
      body: JSON.stringify({ encryptedPayload }),
    })
  } catch {
    // Debug logging must never affect glasses input handling.
  }
}

/**
 * Event fields that may leave the phone in debug logs: gesture kind, list position, input source, container ids and
 * system codes. Everything else (notably `currentSelectItemName`, which carries chat and topic titles, and any text)
 * is dropped; only the dropped key names are kept so a new SDK field is noticed.
 */
const DEBUG_EVENT_FIELDS = new Set([
  'type', 'eventtype', 'event', 'action', 'eventsource', 'sourcetype', 'source',
  'containerid', 'containername', 'currentselectitemindex', 'currentselectindex', 'selectedindex', 'selectindex', 'index',
  'systemexitreasoncode', 'x', 'y', 'z',
])
/** Wrappers whose content is summarised with the same whitelist. */
const DEBUG_EVENT_WRAPPERS = new Set(['listevent', 'textevent', 'sysevent', 'audioevent', 'jsondata', 'data', 'imudata'])

function debugKey(key: string) {
  return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

/** Privacy-safe summary of a raw Even Hub event for the test log and the Debug events upload. */
export function summarizeForDebug(value: unknown, depth = 0): unknown {
  if (value instanceof Uint8Array) return { type: 'Uint8Array', byteLength: value.byteLength }
  if (value instanceof ArrayBuffer) return { type: 'ArrayBuffer', byteLength: value.byteLength }
  if (Array.isArray(value)) return { type: 'Array', length: value.length }
  if (typeof value === 'string') return value.slice(0, 40)
  if (typeof value !== 'object' || value === null) return value
  if (depth > 3) return '[nested]'

  const output: Record<string, unknown> = {}
  const omitted: string[] = []
  for (const [key, item] of Object.entries(value)) {
    const normalized = debugKey(key)
    if (normalized.includes('audiopcm')) {
      output[key] = summarizeForDebug(item, depth + 1)
    } else if (DEBUG_EVENT_WRAPPERS.has(normalized) && typeof item === 'object' && item !== null) {
      output[key] = summarizeForDebug(item, depth + 1)
    } else if (DEBUG_EVENT_FIELDS.has(normalized) && (typeof item !== 'object' || item === null)) {
      output[key] = summarizeForDebug(item, depth + 1)
    } else {
      omitted.push(key.slice(0, 40))
    }
  }
  if (omitted.length > 0) output.omitted = omitted.slice(0, 20)
  return output
}

/** A mapped gesture for the Debug events upload: the kind, position and source, never the selected item's name. */
export function summarizeInputForDebug(input: AppInput | undefined): Record<string, unknown> | null {
  if (!input) return null
  if (input.type === 'audioChunk') return { type: input.type, byteLength: input.pcm.byteLength }
  const output: Record<string, unknown> = { type: input.type }
  if ('index' in input && input.index !== undefined) output.index = input.index
  if ('eventSource' in input && input.eventSource !== undefined) output.eventSource = input.eventSource
  if ('itemName' in input && input.itemName !== undefined) output.hasItemName = true
  return output
}

/** Keys of a debug note that look like they carry user content (names, titles, message text) are dropped. */
const DEBUG_NOTE_BLOCKED_KEY = /name|title|text|body|transcript|caption|preview|phone|secret|hash|token|stack/i

/** Debug note data restricted to scalars under keys that do not look like user content; strings are capped. */
export function sanitizeDebugNoteData(data: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (DEBUG_NOTE_BLOCKED_KEY.test(key)) continue
    if (typeof value === 'string') output[key] = value.slice(0, 600)
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) output[key] = value
  }
  return output
}

const CONTAINER_FILL_BYTES = 990

function fillToContainer(content: string) {
  const currentBytes = encoder.encode(content).byteLength
  if (currentBytes >= CONTAINER_FILL_BYTES) return content
  const padBytes = CONTAINER_FILL_BYTES - currentBytes
  return content + ' '.repeat(padBytes)
}

/**
 * Race a SDK call against a timeout. The EvenHub glasses simulator's
 * `rebuildPageContainer` and `textContainerUpgrade` calls can hang
 * indefinitely on some screen transitions (notably the recording flow).
 * On real hardware a firmware bug could do the same. Without a timeout, the
 * `fullRenderInFlight` / `panelRenderInFlight` flags stay true forever and
 * every subsequent render is silently dropped. A timed race lets the bridge
 * release its in-flight state and proceed; the test harness still gets the
 * pre-await `logTeleGlanceTest('render', ...)` event so it can validate the
 * content that was sent.
 *
 * The timeout value is well above normal hardware latency (real G2 calls
 * complete in 50-200ms) and well below the test step budgets (1-2s).
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      logTeleGlanceTest('bridge.timeout', { method: label, timeoutMs: ms })
      onTimeout?.()
      resolve(undefined)
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/** The SDK reports success as `success`, 0 or true depending on the host build. */
function isImageSuccess(result: unknown): boolean {
  if (result === undefined) return false
  return result === true || result === 0 || result === 'success' || result === 'imageSuccess'
}
