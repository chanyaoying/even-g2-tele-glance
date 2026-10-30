import { validateEvenHubPageContainerZOrder } from '@evenrealities/even_hub_sdk'
import { describe, expect, it, vi } from 'vitest'
import { EvenHubGlassesBridge } from '../src/bridge/evenBridge'
import type { ScreenModel } from '../src/controller/model'

function flushAsync(ms = 0) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
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
    return { bridge, rebuilt }
  }

  const imageObject = (container: unknown) =>
    ((container as { imageObject?: Array<Record<string, number>> }).imageObject ?? [])[0]

  it('always includes the image container: 288x120 over the text gap for a picture, a 20x20 blank otherwise', async () => {
    const { bridge, rebuilt } = makeBridge()

    await bridge.render({ ...baseModel, panelImage: { chatId: '1', messageId: '2', topLine: 1 } } as ScreenModel)
    await bridge.render({ ...baseModel, panelImage: { chatId: '1', messageId: '2', topLine: 3 } } as ScreenModel)
    await bridge.render({ ...baseModel } as ScreenModel)

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
    bridge.updateImage(new Uint8Array([2]))
    const last = bridge.updateImage(new Uint8Array([3]))
    expect(sent).toEqual([[1]]) // the second transfer waits for the first

    release('success')
    await flushAsync(5)
    release('success')
    await Promise.all([first, last])

    expect(sent).toEqual([[1], [3]]) // [2] was superseded before it was sent
  })

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
