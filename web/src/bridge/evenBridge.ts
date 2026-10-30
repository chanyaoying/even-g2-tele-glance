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
import type { GlassesBridge } from '../controller/appController'
import type { AppInput, ScreenModel } from '../controller/model'
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
const POPUP_CONTAINER_NAME = 'popup'
const PHOTO_TEXT_WIDTH = 282
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
    this.emitQueueDepth('full-render-start')
    try {
      // Let a pending mic start/stop finish first; rebuilding the page mid-teardown is the
      // suspected cause of crashes right after cancelling a recording.
      await this.audioChain

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
        // Fire-and-forget the SDK call. Detaching the call from the
        // `await` chain means a hung `rebuildPageContainer` in the
        // simulator (Flutter main thread blocked) cannot prevent the
        // bridge from releasing `fullRenderInFlight` and queuing the
        // next render. The original SDK call is still tracked in the
        // simulator's HTTP server, but the JS side has moved on.
        //
        // On real hardware this is a strict improvement: the SDK call
        // completes synchronously and the unhandled promise just
        // sits in the microtask queue. The post-call bookkeeping
        // (`this.lastSidebarModel = ...` and the completion log) runs
        // immediately, and any in-flight SDK call from a previous
        // render is abandoned cleanly.
        this.sdk.rebuildPageContainer(container).then(
          (accepted) => {
            // The host answers `false` when it refuses a page. Ignoring that left the glasses on the previous
            // screen while the phone moved on, so fall back to a simpler layout and try again.
            if (accepted === false) {
              this.handleRejectedPage(model, generation, 'rebuildPageContainer', false)
              return
            }
            this.lastSidebarModel = model.kind === 'sidebar' ? model : undefined
            logTeleGlanceTest('render', { sequence, generation, model: summarizeScreenModel(model) })
          },
          () => {
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
        this.sdk.createStartUpPageContainer(container).then(
          (result) => {
            if (typeof result === 'number' && result !== 0) {
              this.handleRejectedPage(model, generation, 'createStartUpPageContainer', result)
              return
            }
            this.hasRendered = true
            this.lastSidebarModel = model.kind === 'sidebar' ? model : undefined
            logTeleGlanceTest('render', { sequence, generation, model: summarizeScreenModel(model) })
          },
          () => {
            logTeleGlanceTest('render.failed', { sequence, generation, method: 'createStartUpPageContainer' })
          },
        )
      }
    } finally {
      this.fullRenderInFlight = false
      this.emitQueueDepth('full-render-end')
    }
  }

  /**
   * The host refused a page. Log it, step down to a simpler sidebar layout and render the same screen again, unless a
   * newer render has already replaced it. After the simplest layout there is nothing left to try.
   */
  private handleRejectedPage(model: ScreenModel, generation: number, method: string, result: unknown) {
    logTeleGlanceTest('render.rejected', { generation, method, result: String(result), tier: this.layoutTier })
    if (model.kind !== 'sidebar' || this.layoutTier >= 2) return
    if (generation !== this.pageGeneration) return
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
      this.stalePartialRenderDropped += 1
      logTeleGlanceTest('render.partial.stale', {
        expectedGeneration: expectedGeneration ?? 'none',
        currentGeneration: this.pageGeneration,
        reason: 'full-render-in-flight',
      })
      return
    }
    const sequence = ++this.renderSequence
    if (!this.hasRendered || typeof this.sdk.textContainerUpgrade !== 'function') {
      await this.render(model)
      return
    }
    const updates = buildSidebarPanelUpdates(model, this.lastSidebarModel)
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
   *   2. Schedules a microtask flush if none is pending.
   *   3. While a flush is in flight, marks `panelRenderQueuedAfter` so the next idle tick
   *      re-renders once the in-flight call resolves.
   *   4. Counts both `partialRenderDispatched` and `partialRenderDropped` so the test
   *      harness can verify coalescing.
   *
   * The returned promise resolves when the queue has accepted the model, NOT when the
   * native render finishes. Callers must not `await` this for synchronous input handling.
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
        this.panelRenderTimer = setTimeout(() => {
          this.panelRenderTimer = undefined
          void this.flushPanelQueue()
        }, this.panelRenderIdleMs)
        const maybeNodeTimeout = this.panelRenderTimer as unknown as { unref?: () => void }
        maybeNodeTimeout.unref?.()
      } else if (this.panelRenderQueuedAfter) {
        this.panelRenderQueuedAfter = false
      }
    }
  }

  dispose() {
    if (this.listenerToken && activeEventListenerToken === this.listenerToken) {
      activeEventListenerToken = undefined
    }
    if (this.panelRenderTimer) {
      clearTimeout(this.panelRenderTimer)
      this.panelRenderTimer = undefined
    }
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
        while (this.pendingImage) {
          const next = this.pendingImage
          this.pendingImage = undefined
          const result = await withTimeout(
            this.sdk.updateImageRawData!(new ImageRawDataUpdate({
              containerID: IMAGE_CONTAINER_ID,
              containerName: IMAGE_CONTAINER_NAME,
              imageData: next,
            })),
            8000,
            'updateImageRawData',
          )
          ok = isImageSuccess(result)
          logTeleGlanceTest('image', { bytes: next.byteLength, result: String(result), ok })
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
    width: model.panelImage ? PHOTO_TEXT_WIDTH : fullWidth ? 572 : 404,
    height: fullWidth ? 188 : 206,
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
        xPosition: 286,
        yPosition: 40,
        width: 288,
        height: 144,
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
  const items = model.items.length > 0 ? model.items : ['Empty']
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
      mapped: mapped ?? null,
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

function summarizeForDebug(value: unknown): unknown {
  if (value instanceof Uint8Array) return { type: 'Uint8Array', byteLength: value.byteLength, preview: Array.from(value.slice(0, 16)) }
  if (value instanceof ArrayBuffer) return { type: 'ArrayBuffer', byteLength: value.byteLength }
  if (Array.isArray(value)) return value.slice(0, 20).map(summarizeForDebug)
  if (typeof value !== 'object' || value === null) return value

  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key.toLowerCase().includes('audiopcm')) {
      output[key] = summarizeForDebug(item)
      continue
    }
    output[key] = summarizeForDebug(item)
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
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      logTeleGlanceTest('bridge.timeout', { method: label, timeoutMs: ms })
      resolve(undefined)
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** The SDK reports success as `success`, 0 or true depending on the host build. */
function isImageSuccess(result: unknown): boolean {
  if (result === undefined) return false
  return result === true || result === 0 || result === 'success' || result === 'imageSuccess'
}
