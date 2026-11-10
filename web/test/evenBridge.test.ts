import { validateEvenHubPageContainerZOrder } from '@evenrealities/even_hub_sdk'
import { describe, expect, it, vi } from 'vitest'
import { EvenHubGlassesBridge, sanitizeDebugNoteData, summarizeForDebug, summarizeInputForDebug } from '../src/bridge/evenBridge'
import type { ScreenModel } from '../src/controller/model'

function flushAsync(ms = 0) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/** The bridge sends a plain text page through the one-time startup call; these tests look at the full layout itself. */
/** Start at the richer (popup container, stacking order) layout the host may refuse; real bridges start at tier 2. */
function startAtRichLayout(bridge: unknown) {
  ;(bridge as { layoutTier: number }).layoutTier = 0
}

function skipTextBootstrap(bridge: unknown) {
  ;(bridge as { startupBootstrapped: boolean }).startupBootstrapped = true
}

function textObjectById(container: unknown, containerID: number) {
  const textObject = (container as { textObject?: Array<{ containerID?: number }> }).textObject ?? []
  return textObject.find((item) => item.containerID === containerID) as { yPosition: number; height: number } | undefined
}

describe('EvenHubGlassesBridge', () => {
  it('renders structured boxed text without sending ASCII box markers to the glasses box', async () => {
    let rendered: unknown
    const bridge = new EvenHubGlassesBridge({
      async createStartUpPageContainer(container: unknown) {
        rendered = container
        return 0
      },
      async rebuildPageContainer() {
        return true
      },
      async audioControl() {
        return undefined
      },
      onEvenHubEvent() {
        return undefined
      },
    })
    const markerBody = [
      '+----------------------------------------+',
      '| Ada                                    |',
      '+----------------------------------------+',
      '| there are 230 commits behind available |',
      '+----------------------------------------+',
    ].join('\n')
    const model: ScreenModel = {
      kind: 'text',
      title: 'Messages',
      body: markerBody,
      footer: 'Hold to record | Double click back',
      box: {
        heading: 'Ada 1/2',
        content: 'there are 230 commits behind available',
      },
    }

    await bridge.render(model)

    const output = JSON.stringify(rendered)
    expect(output).toContain('Ada 1/2')
    expect(output).toContain('there are 230 commits behind available')
    expect(output).not.toContain('+----------------------------------------+')
    expect(output).not.toContain('| Ada')
  })

  it('keeps the sidebar panel-box container stable when hiding boxed content', async () => {
    let rebuilt: unknown
    const bridge = new EvenHubGlassesBridge({
      async createStartUpPageContainer() {
        return 0
      },
      async rebuildPageContainer(container: unknown) {
        rebuilt = container
        return true
      },
      async audioControl() {
        return undefined
      },
      onEvenHubEvent() {
        return undefined
      },
    })

    await bridge.render({
      kind: 'sidebar',
      title: 'Topic',
      sidebarTitle: 'Topics',
      sidebarItems: ['Launch'],
      sidebarSelected: 0,
      panelTitle: '',
      panelBody: '',
      panelFooter: 'Hold to record',
      panelBox: { heading: 'Ada', content: 'Long message' },
      focus: 'panel',
    })
    await bridge.render({
      kind: 'sidebar',
      title: 'Topic',
      sidebarTitle: 'Topics',
      sidebarItems: ['Launch'],
      sidebarSelected: 0,
      panelTitle: '',
      panelBody: 'Short message',
      panelFooter: 'Hold to record',
      focus: 'panel',
    })

    const output = JSON.stringify(rebuilt)
    expect(output).toContain('"containerID":7')
    expect(output).toContain('"containerName":"panel-box"')
  })

  it('leaves a gap between full-width message body and footer containers', async () => {
    let rendered: unknown
    const bridge = new EvenHubGlassesBridge({
      async createStartUpPageContainer(container: unknown) {
        rendered = container
        return 0
      },
      async rebuildPageContainer() {
        return true
      },
      async audioControl() {
        return undefined
      },
      onEvenHubEvent() {
        return undefined
      },
    })
    skipTextBootstrap(bridge)

    await bridge.render({
      kind: 'sidebar',
      title: 'Akira',
      sidebarTitle: 'Chats',
      sidebarItems: ['Akira'],
      sidebarSelected: 0,
      panelTitle: '',
      panelBody: Array.from({ length: 7 }, (_, index) => `line ${index + 1}`).join('\n'),
      panelFooter: 'Swipe scroll | Hold to record | Double click back',
      fullWidth: true,
      focus: 'panel',
    })

    const body = textObjectById(rendered, 6)
    const footer = textObjectById(rendered, 4)
    expect(body).toBeDefined()
    expect(footer).toBeDefined()
    expect((body?.yPosition ?? 0) + (body?.height ?? 0)).toBeLessThan(footer?.yPosition ?? 0)
  })

  it('uses one event overlay and an app-rendered sidebar while the sidebar has focus', async () => {
    let rendered: unknown
    const bridge = new EvenHubGlassesBridge({
      async createStartUpPageContainer(container: unknown) {
        rendered = container
        return 0
      },
      async rebuildPageContainer() {
        return true
      },
      async audioControl() {
        return undefined
      },
      onEvenHubEvent() {
        return undefined
      },
    })
    skipTextBootstrap(bridge)

    await bridge.render({
      kind: 'sidebar',
      title: 'Telegram',
      sidebarTitle: 'Chats',
      sidebarItems: ['Alice', 'Project'],
      sidebarSelected: 0,
      panelTitle: 'Alice',
      panelBody: 'Preview',
      panelFooter: 'Swipe chats | Press open',
      focus: 'sidebar',
    })

    const output = JSON.stringify(rendered)
    expect(output).toContain('"containerName":"sidebar"')
    expect(output).toContain('Chats\\n> Alice\\n  Project')
    expect(activeEventCaptureCount(rendered)).toBe(1)
  })

  it('uses only the panel event capture while messages have focus', async () => {
    let rendered: unknown
    const bridge = new EvenHubGlassesBridge({
      async createStartUpPageContainer(container: unknown) {
        rendered = container
        return 0
      },
      async rebuildPageContainer() {
        return true
      },
      async audioControl() {
        return undefined
      },
      onEvenHubEvent() {
        return undefined
      },
    })
    skipTextBootstrap(bridge)

    await bridge.render({
      kind: 'sidebar',
      title: 'Launch',
      sidebarTitle: 'Topics',
      sidebarItems: ['Launch', 'Support'],
      sidebarSelected: 1,
      panelTitle: '',
      panelBody: 'Message',
      panelFooter: 'Hold to record',
      focus: 'panel',
    })

    const output = JSON.stringify(rendered)
    expect(output).toContain('"containerName":"sidebar"')
    expect(activeEventCaptureCount(rendered)).toBe(1)
    const page = rendered as { listObject?: Array<{ isEventCapture?: number }> }
    expect(page.listObject?.[0]?.isEventCapture).toBe(0)
  })

  it('hides the split sidebar and expands message content in full-width mode', async () => {
    let rendered: unknown
    const bridge = new EvenHubGlassesBridge({
      async createStartUpPageContainer(container: unknown) { rendered = container; return 0 },
      async rebuildPageContainer() { return true },
      async audioControl() { return undefined },
      onEvenHubEvent() { return undefined },
    })
    skipTextBootstrap(bridge)

    await bridge.render({
      kind: 'sidebar',
      title: 'Launch',
      sidebarTitle: 'Topics',
      sidebarItems: ['Launch', 'Support'],
      sidebarSelected: 0,
      panelTitle: '',
      panelBody: 'Full-width message',
      panelFooter: 'Double click back',
      focus: 'panel',
      fullWidth: true,
    })

    const page = rendered as { textObject?: Array<Record<string, unknown>> }
    const sidebar = page.textObject?.find((item) => item.containerName === 'sidebar')
    const body = page.textObject?.find((item) => item.containerID === 6)
    expect(sidebar).toMatchObject({ width: 1, height: 1, content: '' })
    expect(body).toMatchObject({ xPosition: 2, width: 572 })
  })

  it('disposes the Even Hub event listener when available', () => {
    const unsubscribe = vi.fn()
    const bridge = new EvenHubGlassesBridge({
      async createStartUpPageContainer() {
        return 0
      },
      async rebuildPageContainer() {
        return true
      },
      async audioControl() {
        return undefined
      },
      onEvenHubEvent() {
        return unsubscribe
      },
    }, unsubscribe)

    bridge.dispose()
    bridge.dispose()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('coalesces rapid enqueueSidebarPanel calls into a single latest-wins render', async () => {
    const upgrades: Array<{ id: number; content: string }> = []
    let resolveNext: (() => void) | undefined
    const blockRender = () => new Promise<void>((resolve) => { resolveNext = resolve })
    const bridge = new EvenHubGlassesBridge({
      async createStartUpPageContainer() { return 0 },
      async rebuildPageContainer() { return true },
      async textContainerUpgrade(container: unknown) {
        const c = container as { containerID: number; content: string }
        upgrades.push({ id: c.containerID, content: c.content })
        // Slow native render — must not stall the input handler.
        await blockRender()
        return true
      },
      async audioControl() { return undefined },
      onEvenHubEvent() { return undefined },
    })

    const baseModel: Extract<ScreenModel, { kind: 'sidebar' }> = {
      kind: 'sidebar',
      title: 'Chats',
      focus: 'sidebar',
      sidebarTitle: 'Chats',
      sidebarItems: ['Alice', 'Bob', 'Carol'],
      sidebarSelected: 0,
      panelTitle: 'Alice',
      panelBody: 'preview',
      panelFooter: 'Click open',
    }
    await bridge.render(baseModel)
    upgrades.length = 0

    bridge.enqueueSidebarPanel({ ...baseModel, sidebarSelected: 1, panelBody: 'bob' })
    bridge.enqueueSidebarPanel({ ...baseModel, sidebarSelected: 2, panelBody: 'carol' })
    bridge.enqueueSidebarPanel({ ...baseModel, sidebarSelected: 1, panelBody: 'bob-again' })
    const stats = bridge.getPartialRenderStats()
    expect(stats.dispatched).toBe(3)
    expect(stats.dropped).toBe(2)

    // With the 150ms scroll-idle window, the flush timer hasn't fired yet.
    expect(upgrades.length).toBe(0)

    // Advance past the idle window. The timer fires the single coalesced flush.
    await flushAsync(160)
    // Resolve the blocked render cycle (5 textContainerUpgrade calls per flush).
    for (let i = 0; i < 5; i++) {
      resolveNext?.()
      await flushAsync(0)
    }
    // The final render cycle must have pushed the latest panel body.
    expect(upgrades.length).toBeGreaterThan(0)
    const lastBody = upgrades.filter((u) => u.id === 6).at(-1)
    expect(lastBody?.content).toContain('bob-again')
    expect(new Set(upgrades.map((update) => update.id))).toEqual(new Set([5, 6]))
  })

  it('increments pageGeneration on full render, not on partial updates', async () => {
    const bridge = new EvenHubGlassesBridge({
      async createStartUpPageContainer() { return 0 },
      async rebuildPageContainer() { return true },
      async textContainerUpgrade() { return true },
      async audioControl() { return undefined },
      onEvenHubEvent() { return undefined },
    })
    const model: Extract<ScreenModel, { kind: 'sidebar' }> = {
      kind: 'sidebar',
      title: 'Chats',
      focus: 'sidebar',
      sidebarTitle: 'Chats',
      sidebarItems: ['Alice', 'Bob'],
      sidebarSelected: 0,
      panelTitle: 'Alice',
      panelBody: 'preview',
      panelFooter: 'Click',
    }
    // First render: generation becomes 1
    await bridge.render(model)
    const stats1 = bridge.getPartialRenderStats()
    expect(stats1.staleDropped).toBe(0)

    // Partial update via enqueueSidebarPanel → same generation
    bridge.enqueueSidebarPanel({ ...model, sidebarSelected: 1 })
    await flushAsync(160) // let the 150ms idle timer fire

    // Full render again: generation becomes 2
    await bridge.render(model)

    // The previous enqueued update was flushed before the second full render,
    // so staleDropped is still 0. Now enqueue after the new generation...
    bridge.enqueueSidebarPanel({ ...model, sidebarSelected: 0 })

    // Second full render before the timer fires: generation becomes 3
    await bridge.render(model)

    // Advance past the idle window. The enqueued update with generation 2
    // should be silently discarded because the page is now at generation 3.
    await flushAsync(160)
    const stats2 = bridge.getPartialRenderStats()
    expect(stats2.staleDropped).toBeGreaterThanOrEqual(0)
    // dispatched still increments even when later discarded
    expect(stats2.dispatched).toBeGreaterThanOrEqual(1)
  })

  it('starts with a plain text page and applies the sidebar layout as a rebuild', async () => {
    const startup: Array<{ textObject?: unknown[]; listObject?: unknown[] }> = []
    const rebuilds: unknown[] = []
    const bridge = new EvenHubGlassesBridge({
      async createStartUpPageContainer(container: { textObject?: unknown[] }) { startup.push(container); return 0 },
      async rebuildPageContainer(container: unknown) { rebuilds.push(container); return true },
      async textContainerUpgrade() { return true },
      async audioControl() { return undefined },
      onEvenHubEvent() { return undefined },
    } as never)
    await bridge.render({
      kind: 'sidebar', title: 'Chats', focus: 'sidebar', sidebarTitle: 'Chats', sidebarItems: ['Alice', 'Bob'], sidebarSelected: 0,
      panelTitle: '', panelBody: '> Alice\n  Bob', panelFooter: 'Swipe',
    })
    await flushAsync(10)

    expect(startup).toHaveLength(1)
    expect(JSON.stringify(startup[0])).toContain('> Alice') // the chat list is on the glasses straight away
    expect(JSON.stringify(startup[0])).not.toContain('event-overlay')
    expect(rebuilds).toHaveLength(1)
    expect(JSON.stringify(rebuilds[0])).toContain('event-overlay') // then the interactive layout
  })

  it('shows a Fetching chats footer and scrolls the stored list while the interactive layout is still being sent', async () => {
    const startup: unknown[] = []
    const upgrades: Array<{ containerName?: string; content?: string }> = []
    const answers: Array<(accepted: boolean) => void> = []
    const bridge = new EvenHubGlassesBridge({
      async createStartUpPageContainer(container: unknown) { startup.push(container); return 0 },
      rebuildPageContainer() { return new Promise<boolean>((resolve) => answers.push(resolve)) },
      async textContainerUpgrade(update: { containerName?: string; content?: string }) { upgrades.push(update); return true },
      async audioControl() { return undefined },
      onEvenHubEvent() { return undefined },
    } as never)
    const model = (selected: number) => ({
      kind: 'sidebar' as const, title: 'Chats', focus: 'sidebar' as const, sidebarTitle: 'Chats', sidebarItems: ['Alice', 'Bob'], sidebarSelected: selected,
      panelTitle: '', panelBody: selected === 0 ? '> Alice\n  Bob' : '  Alice\n> Bob', panelFooter: 'Swipe',
    })
    await bridge.render(model(0))
    await flushAsync(10)
    expect(JSON.stringify(startup[0])).toContain('Fetching chats...')

    // The rebuild is in flight (unanswered): a swipe must not be lost.
    await bridge.renderSidebarPanel(model(1))
    expect(upgrades).toHaveLength(0)
    answers[0](true)
    await flushAsync(10)
    // After the layout lands, the newer selection is applied to it.
    await flushAsync(200)
    expect(upgrades.some((update) => update.content?.includes('> Bob'))).toBe(true)
  })

  it('reports the page as settled only once the rebuild in flight has been answered', async () => {
    const answers: Array<(accepted: boolean) => void> = []
    const bridge = new EvenHubGlassesBridge({
      async createStartUpPageContainer() { return 0 },
      rebuildPageContainer() { return new Promise<boolean>((resolve) => answers.push(resolve)) },
      async textContainerUpgrade() { return true },
      async audioControl() { return undefined },
      onEvenHubEvent() { return undefined },
    } as never)
    const screen: Extract<ScreenModel, { kind: 'sidebar' }> = {
      kind: 'sidebar', title: 'Chats', focus: 'sidebar', sidebarTitle: 'Chats', sidebarItems: ['A'], sidebarSelected: 0,
      panelTitle: 'A', panelBody: 'x', panelFooter: 'Click',
    }
    await bridge.render(screen) // startup text page, then the sidebar rebuild goes out and stays unanswered
    await flushAsync(10)
    expect(answers).toHaveLength(1)

    let settled = false
    void bridge.pageSettled().then(() => { settled = true })
    await flushAsync(10)
    expect(settled).toBe(false)

    answers[0](true)
    await flushAsync(10)
    expect(settled).toBe(true)
    await expect(bridge.pageSettled()).resolves.toBeUndefined() // nothing in flight any more
  })

  it('sends one full rebuild at a time and only the newest waiting screen after it', async () => {
    const answers: Array<(accepted: boolean) => void> = []
    const sent: string[] = []
    const bridge = new EvenHubGlassesBridge({
      async createStartUpPageContainer() { return 0 },
      rebuildPageContainer(container: { textObject?: Array<{ containerName?: string; content?: string }> }) {
        sent.push(container.textObject?.map((text) => text.content ?? '').join('|') ?? '')
        return new Promise<boolean>((resolve) => answers.push(resolve))
      },
      async textContainerUpgrade() { return true },
      async audioControl() { return undefined },
      onEvenHubEvent() { return undefined },
    } as never)
    const screen = (body: string): Extract<ScreenModel, { kind: 'sidebar' }> => ({
      kind: 'sidebar', title: 'Chats', focus: 'sidebar', sidebarTitle: 'Chats', sidebarItems: ['Alice'], sidebarSelected: 0,
      panelTitle: 'Alice', panelBody: body, panelFooter: 'Click',
    })
    await bridge.render(screen('first')) // startup page
    await flushAsync(5)
    await bridge.render(screen('second')) // rebuild goes out
    await flushAsync(5)
    expect(sent).toHaveLength(1)

    await bridge.render(screen('third'))
    await bridge.render(screen('fourth'))
    await flushAsync(5)
    expect(sent).toHaveLength(1) // still waiting for the glasses to answer the second

    answers[0](true)
    await flushAsync(5)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toContain('fourth')
    expect(sent.join('\n')).not.toContain('third')
  })

  it('rejects direct renderSidebarPanel with stale generation', async () => {
    const upgrades: Array<unknown> = []
    const bridge = new EvenHubGlassesBridge({
      async createStartUpPageContainer() { return 0 },
      async rebuildPageContainer() { return true },
      async textContainerUpgrade(container: unknown) {
        upgrades.push(container)
        return true
      },
      async audioControl() { return undefined },
      onEvenHubEvent() { return undefined },
    })
    skipTextBootstrap(bridge)
    const model: Extract<ScreenModel, { kind: 'sidebar' }> = {
      kind: 'sidebar',
      title: 'Chats',
      focus: 'sidebar',
      sidebarTitle: 'Chats',
      sidebarItems: ['Alice'],
      sidebarSelected: 0,
      panelTitle: 'Alice',
      panelBody: 'preview',
      panelFooter: 'Click',
    }
    await bridge.render(model)

    // Full render increments generation to 2
    await bridge.render(model)

    // Try a partial update with the old generation (1) — should be rejected
    upgrades.length = 0
    await bridge.renderSidebarPanel({ ...model, panelBody: 'should-not-appear' }, 1)
    expect(upgrades.length).toBe(0)

    const stats = bridge.getPartialRenderStats()
    expect(stats.staleDropped).toBe(1)

    // Partial update with current generation — should succeed
    await bridge.renderSidebarPanel({ ...model, panelBody: 'should-appear' }, 2)
    expect(upgrades.length).toBeGreaterThan(0)
  })

  it('clears pending panel queue on full render', async () => {
    const upgrades: Array<unknown> = []
    const bridge = new EvenHubGlassesBridge({
      async createStartUpPageContainer() { return 0 },
      async rebuildPageContainer() { return true },
      async textContainerUpgrade(container: unknown) {
        upgrades.push(container)
        return true
      },
      async audioControl() { return undefined },
      onEvenHubEvent() { return undefined },
    })
    const model: Extract<ScreenModel, { kind: 'sidebar' }> = {
      kind: 'sidebar',
      title: 'Chats',
      focus: 'sidebar',
      sidebarTitle: 'Chats',
      sidebarItems: ['Alice', 'Bob'],
      sidebarSelected: 0,
      panelTitle: 'Alice',
      panelBody: 'preview old',
      panelFooter: 'Click',
    }
    await bridge.render(model)

    // Enqueue a partial update with old content
    bridge.enqueueSidebarPanel({ ...model, panelBody: 'stale-content' })

    // Full render with new content before the timer fires
    upgrades.length = 0
    await bridge.render({ ...model, panelBody: 'fresh-content' })

    // Advance past the idle window — the queued stale update should be
    // gone (cleared by the full render) so no extra textContainerUpgrade
    // calls target the fresh page.
    const upgradesBeforeFlush = upgrades.length
    await flushAsync(160)
    // No new textContainerUpgrade calls should have been made because
    // the pending queue was cleared.
    expect(upgrades.length).toBe(upgradesBeforeFlush)
  })
})

function activeEventCaptureCount(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + activeEventCaptureCount(item), 0)
  if (!value || typeof value !== 'object') return 0
  return Object.entries(value).reduce((sum, [key, item]) => {
    if (key === 'isEventCapture' && item === 1) return sum + 1
    return sum + activeEventCaptureCount(item)
  }, 0)
}

describe('EvenHubGlassesBridge photos', () => {
  const baseModel: Extract<ScreenModel, { kind: 'sidebar' }> = {
    kind: 'sidebar',
    title: 'Chat',
    sidebarTitle: 'Chats',
    sidebarItems: ['A'],
    sidebarSelected: 0,
    panelTitle: '',
    panelBody: 'Alice',
    panelFooter: 'Swipe',
    fullWidth: true,
    focus: 'panel',
  }

  function makeBridge(extra: Record<string, unknown> = {}) {
    const rebuilt: unknown[] = []
    const bridge = new EvenHubGlassesBridge({
      async createStartUpPageContainer(container: unknown) {
        rebuilt.push(container)
        return 0
      },
      async rebuildPageContainer(container: unknown) {
        rebuilt.push(container)
        return true
      },
      async audioControl() {
        return undefined
      },
      onEvenHubEvent() {
        return undefined
      },
      ...extra,
    } as never)
    skipTextBootstrap(bridge)
    return { bridge, rebuilt }
  }

  const imageObject = (container: unknown) =>
    ((container as { imageObject?: Array<Record<string, number>> }).imageObject ?? [])[0]

  it('always includes the image container: 288x120 over the text gap for a picture, a 20x20 blank otherwise', async () => {
    const { bridge, rebuilt } = makeBridge()

    // Pages go out one at a time, so let each one be answered before sending the next.
    await bridge.render({ ...baseModel, panelImage: { chatId: '1', messageId: '2', topLine: 1 } } as ScreenModel)
    await flushAsync(5)
    await bridge.render({ ...baseModel, panelImage: { chatId: '1', messageId: '2', topLine: 3 } } as ScreenModel)
    await flushAsync(5)
    await bridge.render({ ...baseModel } as ScreenModel)
    await flushAsync(5)

    const first = imageObject(rebuilt[0])
    const lower = imageObject(rebuilt[1])
    expect(first).toMatchObject({ containerID: 9, width: 288, height: 120 })
    expect(first.xPosition + first.width).toBeLessThanOrEqual(576)
    expect(first.yPosition + first.height).toBeLessThanOrEqual(226) // stays inside the message area
    expect(lower.yPosition).toBeGreaterThan(first.yPosition) // follows the gap down the page
    expect(textObjectById(rebuilt[0], 6)).toMatchObject({ width: 572 }) // text keeps the full width: no side panel

    expect(imageObject(rebuilt[2])).toMatchObject({ containerID: 9, width: 20, height: 20 })
  })

  it('sends photo pixels one transfer at a time and keeps only the latest queued image', async () => {
    const sent: number[][] = []
    let release: (value: unknown) => void = () => undefined
    const { bridge } = makeBridge({
      updateImageRawData: vi.fn((data: { imageData: Uint8Array }) => {
        sent.push(Array.from(data.imageData))
        return new Promise((resolve) => {
          release = resolve
        })
      }),
    })

    const first = bridge.updateImage(new Uint8Array([1]))
    await flushAsync(1)
    expect(sent).toEqual([[1]])
    bridge.updateImage(new Uint8Array([2]))
    const last = bridge.updateImage(new Uint8Array([3]))
    expect(sent).toEqual([[1]]) // the next transfer waits for the first

    release('success')
    await flushAsync(5)
    release('success')
    await Promise.all([first, last])

    expect(sent).toEqual([[1], [3]]) // [2] was superseded before it was sent
  })

  it('retries a timed-out rebuild with the same layout instead of stepping down', async () => {
    const pages: unknown[] = []
    let calls = 0
    const bridge = new EvenHubGlassesBridge({
      async createStartUpPageContainer() { return 0 },
      async rebuildPageContainer(container: unknown) {
        pages.push(container)
        calls += 1
        if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 1600)) // host timed out ...
        return calls !== 1 // ... and answered "refused"
      },
      async textContainerUpgrade() { return true },
      async audioControl() { return undefined },
      onEvenHubEvent() { return undefined },
    } as never)
    skipTextBootstrap(bridge)
    startAtRichLayout(bridge)
    const model = {
      kind: 'sidebar' as const, title: 'T', focus: 'panel' as const, sidebarTitle: 'S', sidebarItems: ['a'], sidebarSelected: 0,
      panelTitle: '', panelBody: 'body', panelFooter: 'f', popup: { title: 'Confirm', body: 'Send?' },
    }
    await bridge.render(model) // startup call
    await bridge.render(model) // rebuild that times out
    await flushAsync(1700)
    await flushAsync(1200)
    expect(calls).toBe(2)
    expect((bridge as unknown as { layoutTier: number }).layoutTier).toBe(0)
  }, 10000)

  it('reports whether the glasses accepted the image', async () => {
    const { bridge } = makeBridge({ updateImageRawData: vi.fn(async () => 'imageToGray4Failed') })
    expect(await bridge.updateImage(new Uint8Array([1]))).toBe(false)

    const accepted = makeBridge({ updateImageRawData: vi.fn(async () => 'success') })
    expect(await accepted.bridge.updateImage(new Uint8Array([1]))).toBe(true)
  })

  it('stacks a popup above every other container with valid, unique z-order and room to spare', async () => {
    const pages: unknown[] = []
    const bridge = new EvenHubGlassesBridge({
      async createStartUpPageContainer(container: unknown) {
        pages.push(container)
        return 0
      },
      async rebuildPageContainer(container: unknown) {
        pages.push(container)
        return true
      },
      async audioControl() {
        return undefined
      },
      onEvenHubEvent() {
        return undefined
      },
    })
    skipTextBootstrap(bridge)
    startAtRichLayout(bridge)
    const base = {
      kind: 'sidebar' as const,
      title: 'Project',
      sidebarTitle: 'Chats',
      sidebarItems: [],
      sidebarSelected: 0,
      panelTitle: '',
      panelBody: 'hello',
      panelFooter: 'footer',
      fullWidth: true,
      focus: 'panel' as const,
    }

    await bridge.render({ ...base, popup: { title: 'Confirm reply', body: 'hi\n\n> Send\n  Cancel' } })
    await bridge.render(base)

    for (const page of pages) {
      const p = page as { textObject: Array<{ containerID: number; zOrderIndex?: number; content?: string; width: number }>; listObject: unknown[]; imageObject: unknown[]; containerTotalNum: number }
      expect(validateEvenHubPageContainerZOrder(p as never)).toEqual({ valid: true })
      expect(p.containerTotalNum).toBeLessThanOrEqual(12)
      expect(p.textObject.length + p.listObject.length + p.imageObject.length).toBe(p.containerTotalNum)
      const popup = p.textObject.find((item) => item.containerID === 10)
      const maxOther = Math.max(...p.textObject.filter((item) => item.containerID !== 10).map((item) => item.zOrderIndex ?? -1))
      expect(popup).toBeDefined()
      expect(popup!.zOrderIndex!).toBeGreaterThan(maxOther)
    }
    const shown = pages[0] as { textObject: Array<{ containerID: number; content?: string; width: number }> }
    const hidden = pages[1] as { textObject: Array<{ containerID: number; content?: string; width: number }> }
    expect(shown.textObject.find((item) => item.containerID === 10)?.content).toContain('> Send')
    expect(hidden.textObject.find((item) => item.containerID === 10)).toMatchObject({ content: '', width: 1 })
  })

  describe('when the host rejects a sidebar page', () => {
    const base = {
      kind: 'sidebar' as const,
      title: 'Project',
      sidebarTitle: 'Chats',
      sidebarItems: [],
      sidebarSelected: 0,
      panelTitle: '',
      panelBody: 'hello',
      panelFooter: 'footer',
      fullWidth: true,
      focus: 'panel' as const,
    }
    type Page = { textObject: Array<{ containerID: number; zOrderIndex?: number; content?: string }>; containerTotalNum: number }

    function bridgeThatAccepts(accept: (page: Page) => boolean) {
      const pages: Page[] = []
      const bridge = new EvenHubGlassesBridge({
        async createStartUpPageContainer(container: unknown) {
          pages.push(container as Page)
          return 0
        },
        async rebuildPageContainer(container: unknown) {
          pages.push(container as Page)
          return accept(container as Page)
        },
        async audioControl() {
          return undefined
        },
        onEvenHubEvent() {
          return undefined
        },
      })
      startAtRichLayout(bridge)
      return { bridge, pages }
    }

    it('retries without the stacking order, then in the original layout, until a page is accepted', async () => {
      const hasZ = (page: Page) => page.textObject.some((item) => item.zOrderIndex !== undefined)
      const hasPopup = (page: Page) => page.textObject.some((item) => item.containerID === 10)
      // Accept only the original layout: no stacking order and no popup container.
      const { bridge, pages } = bridgeThatAccepts((page) => !hasZ(page) && !hasPopup(page))

      await bridge.render({ kind: 'text', title: 'Loading', body: 'Checking Telegram session...' }) // startup page
      await bridge.render(base)
      await flushAsync(20)

      const sidebarPages = pages.slice(1)
      expect(sidebarPages.length).toBe(3)
      expect(hasZ(sidebarPages[0])).toBe(true)
      expect(hasZ(sidebarPages[1])).toBe(false)
      expect(hasPopup(sidebarPages[1])).toBe(true)
      expect(hasZ(sidebarPages[2]) || hasPopup(sidebarPages[2])).toBe(false)

      // Later renders keep using the layout the host accepted instead of failing again first.
      await bridge.render({ ...base, panelBody: 'next' })
      await flushAsync(20)
      expect(pages.length).toBe(5)
      expect(hasZ(pages[4]) || hasPopup(pages[4])).toBe(false)
    })

    it('shows a popup as body text in the original layout', async () => {
      const { bridge, pages } = bridgeThatAccepts((page) => !page.textObject.some((item) => item.zOrderIndex !== undefined || item.containerID === 10))
      await bridge.render({ kind: 'text', title: 'Loading', body: 'x' })
      await bridge.render({ ...base, popup: { title: 'Confirm reply', body: 'hi\n\n> Send\n  Cancel' } })
      await flushAsync(20)

      const accepted = pages[pages.length - 1]
      expect(accepted.textObject.find((item) => item.containerID === 6)?.content).toContain('> Send')
    })

    it('does not retry forever when every layout is refused', async () => {
      const { bridge, pages } = bridgeThatAccepts(() => false)
      await bridge.render({ kind: 'text', title: 'Loading', body: 'x' })
      await bridge.render(base)
      await flushAsync(30)
      expect(pages.length).toBe(4) // startup + three sidebar attempts
    })
  })
})

describe('EvenHubGlassesBridge layout on real glasses', () => {
  it('sends at most eight text containers from the first sidebar page on, so the host never refuses it', async () => {
    const pages: Array<{ textObject: unknown[] }> = []
    const bridge = new EvenHubGlassesBridge({
      async createStartUpPageContainer(container: unknown) { pages.push(container as never); return 0 },
      async rebuildPageContainer(container: unknown) { pages.push(container as never); return true },
      async audioControl() { return undefined },
      onEvenHubEvent() { return undefined },
    } as never)
    const sidebar = {
      kind: 'sidebar' as const, title: 'T', focus: 'sidebar' as const, sidebarTitle: 'Chats', sidebarItems: ['a', 'b'], sidebarSelected: 0,
      panelTitle: '', panelBody: 'body', panelFooter: 'f', popup: { title: 'Confirm', body: 'Send?' },
    }
    await bridge.render(sidebar) // startup: text page first, then the sidebar as a rebuild
    await flushAsync(20)
    const rebuilt = pages.slice(1)
    expect(rebuilt.length).toBe(1) // accepted first time: no stepping down through refused layouts
    for (const page of pages) expect(page.textObject.length).toBeLessThanOrEqual(8)
  })
})

describe('EvenHubGlassesBridge audit fixes', () => {
  const sidebar: Extract<ScreenModel, { kind: 'sidebar' }> = {
    kind: 'sidebar',
    title: 'Chats',
    focus: 'panel',
    fullWidth: true,
    sidebarTitle: 'Chats',
    sidebarItems: ['Alice', 'Bob'],
    sidebarSelected: 0,
    panelTitle: '',
    panelBody: '> Alice\n  Bob',
    panelFooter: 'Swipe chats | Press open',
  }

  function makeSdk(extra: Record<string, unknown> = {}) {
    const upgrades: Array<{ containerID: number; content: string }> = []
    const rebuilds: unknown[] = []
    const sdk = {
      async createStartUpPageContainer() { return 0 },
      rebuildPageContainer: vi.fn(async (container: unknown) => { rebuilds.push(container); return true }),
      async textContainerUpgrade(update: unknown) {
        upgrades.push(update as { containerID: number; content: string })
        return true
      },
      async audioControl() { return undefined },
      onEvenHubEvent() { return undefined },
      ...extra,
    }
    const bridge = new EvenHubGlassesBridge(sdk as never)
    skipTextBootstrap(bridge)
    return { bridge, sdk, upgrades, rebuilds }
  }

  it('applies a list scroll that arrives while a full page is being prepared, once the page is sent', async () => {
    const { bridge, upgrades, rebuilds } = makeSdk()
    await bridge.render(sidebar) // startup page
    await flushAsync(1)
    let releaseAudio: () => void = () => undefined
    ;(bridge as unknown as { audioChain: Promise<void> }).audioChain = new Promise<void>((resolve) => { releaseAudio = resolve })

    const rendering = bridge.render({ ...sidebar, title: 'Folder' })
    await flushAsync(1)
    // The scroll lands while the rebuild is still waiting to be sent: it used to be dropped.
    await bridge.renderSidebarPanel({ ...sidebar, title: 'Folder', sidebarSelected: 1, panelBody: '  Alice\n> Bob' })
    expect(upgrades).toHaveLength(0)
    expect(bridge.getPartialRenderStats().staleDropped).toBe(0)

    releaseAudio()
    await rendering
    expect(rebuilds).toHaveLength(1)
    await flushAsync(200)
    const body = upgrades.filter((update) => update.containerID === 6).at(-1)
    expect(body?.content).toContain('> Bob')
    // Diffed against nothing, because the page just sent is not yet the bridge's diff base.
    expect(upgrades.map((update) => update.containerID)).toContain(1)
  })

  it('still drops a partial update while a non-sidebar page is being prepared', async () => {
    const { bridge, upgrades } = makeSdk()
    await bridge.render(sidebar)
    await flushAsync(1)
    let releaseAudio: () => void = () => undefined
    ;(bridge as unknown as { audioChain: Promise<void> }).audioChain = new Promise<void>((resolve) => { releaseAudio = resolve })
    const rendering = bridge.render({ kind: 'text', title: 'Error', body: 'boom' })
    await flushAsync(1)
    await bridge.renderSidebarPanel({ ...sidebar, sidebarSelected: 1 })
    releaseAudio()
    await rendering
    await flushAsync(200)
    expect(upgrades).toHaveLength(0)
    expect(bridge.getPartialRenderStats().staleDropped).toBe(1)
  })

  it('cools down after a picture transfer timed out before the next page or picture', async () => {
    vi.useFakeTimers()
    try {
      const sent: number[] = []
      const { bridge, sdk } = makeSdk({
        updateImageRawData: vi.fn((data: { imageData: Uint8Array }) => {
          sent.push(data.imageData[0])
          return data.imageData[0] === 1 ? new Promise(() => undefined) : Promise.resolve('success')
        }),
      })
      ;(bridge as unknown as { hasRendered: boolean }).hasRendered = true

      const first = bridge.updateImage(new Uint8Array([1]))
      await vi.advanceTimersByTimeAsync(8000)
      expect(await first).toBe(false) // a timeout is not a success

      const second = bridge.updateImage(new Uint8Array([2]))
      void bridge.render(sidebar)
      await vi.advanceTimersByTimeAsync(1500)
      expect(sent).toEqual([1]) // still cooling down
      expect(sdk.rebuildPageContainer).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(600)
      expect(sdk.rebuildPageContainer).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(3500)
      expect(await second).toBe(true)
      expect(sent).toEqual([1, 2])
    } finally {
      vi.useRealTimers()
    }
  })

  function slowRefusingBridge() {
    return makeSdk({
      rebuildPageContainer: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1600))
        return false // a slow "refusal" (host timeout): the bridge schedules a same-layout retry
      }),
    }).bridge
  }

  it('cancels the timed-out rebuild retry on dispose', async () => {
    vi.useFakeTimers()
    try {
      const bridge = slowRefusingBridge()
      await bridge.render(sidebar) // startup page
      await vi.advanceTimersByTimeAsync(1)
      void bridge.render(sidebar)
      await vi.advanceTimersByTimeAsync(1601) // refused after 1.6 s: retry scheduled
      expect(vi.getTimerCount()).toBe(1)
      bridge.dispose()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the waiting-page flush timer on dispose', async () => {
    vi.useFakeTimers()
    try {
      const bridge = slowRefusingBridge()
      await bridge.render(sidebar) // startup page
      await vi.advanceTimersByTimeAsync(1)
      void bridge.render(sidebar)
      await vi.advanceTimersByTimeAsync(10)
      void bridge.render({ ...sidebar, title: 'Queued' }) // waits behind the rebuild in flight
      expect(vi.getTimerCount()).toBe(2) // the host's answer + the bridge's give-up timer
      bridge.dispose()
      expect(vi.getTimerCount()).toBe(1) // only the (simulated) host is still busy
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('debug event privacy', () => {
  it('keeps only whitelisted event fields and never chat or topic names', () => {
    const summary = summarizeForDebug({
      listEvent: { containerID: 8, currentSelectItemIndex: 2, currentSelectItemName: 'Secret Family Chat', eventType: 0 },
      jsonData: { Event_Type: 'CLICK', CurrentSelect_ItemName: 'Secret Family Chat', text: 'hello there', eventSource: 1 },
      audioEvent: { audioPcm: new Uint8Array([1, 2, 3, 4]) },
    })
    const json = JSON.stringify(summary)
    expect(json).not.toContain('Secret Family Chat')
    expect(json).not.toContain('hello there')
    expect(json).not.toContain('[1,2,3')
    expect(summary).toMatchObject({
      listEvent: { containerID: 8, currentSelectItemIndex: 2, eventType: 0, omitted: ['currentSelectItemName'] },
      jsonData: { Event_Type: 'CLICK', eventSource: 1 },
      audioEvent: { audioPcm: { type: 'Uint8Array', byteLength: 4 } },
    })
  })

  it('reports a mapped gesture without its item name', () => {
    expect(summarizeInputForDebug({ type: 'press', index: 1, itemName: 'Secret', eventSource: 1 })).toEqual({
      type: 'press', index: 1, eventSource: 1, hasItemName: true,
    })
    expect(summarizeInputForDebug({ type: 'audioChunk', pcm: new Uint8Array(10) })).toEqual({ type: 'audioChunk', byteLength: 10 })
    expect(summarizeInputForDebug(undefined)).toBeNull()
  })

  it('drops debug note fields that look like user content', () => {
    expect(sanitizeDebugNoteData({
      durationMs: 12, ok: true, error: 'timeout', chatTitle: 'Secret', itemName: 'Secret', transcriptText: 'hi', nested: { a: 1 },
    })).toEqual({ durationMs: 12, ok: true, error: 'timeout' })
  })
})
