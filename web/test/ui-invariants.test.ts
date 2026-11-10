import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

type Performance = {
  maxTransitionMs: number
  maxApiCallMs: number
  maxMessageLoadMs: number
  maxChatLoadMs: number
  maxSendRoundtripMs: number
  longRunningStates: string[]
}

type ScreenBlock = {
  state: { screen: string; mode?: string; focus?: string; selectedIndex?: number }
  render: { kind: 'text' | 'list' | 'sidebar'; title?: string; focus?: string }
  left?: { sidebarTitle?: string; sidebarItemsExact?: string[]; markerAtFromState?: string }
  right?: {
    panelTitle?: unknown
    panelBodyContains?: unknown
    panelBodyNotContains?: string[]
    panelFooterDefault?: string
    panelFooterContains?: string[]
    panelBox?: unknown
  }
  body?: { contains?: string[]; containsAny?: string[][]; containsFromState?: unknown }
  footer?: { contains?: string[] }
  transitions: Record<string, string>
  budgetMs: number
  apiCalls?: string[]
  bridgeCalls?: string[]
  eventMustEmit?: Array<{ event: string; kind: string }>
}

type Step = {
  name: string
  input: string | null
  target: string
  expect: Record<string, unknown>
  apiCalls?: string[]
  budgetMs: number
  expectToFail?: boolean
}

type Catalog = {
  version: number
  fixture: Record<string, unknown>
  performance: Performance
  blankDetection: Record<string, unknown>
  screens: Record<string, ScreenBlock>
  steps: Step[]
}

function loadCatalog(): Catalog {
  const file = path.resolve(__dirname, '..', '..', 'docs', 'UI_INVARIANTS.json')
  const raw = readFileSync(file, 'utf8')
  return JSON.parse(raw) as Catalog
}

const VALID_SCREEN_KINDS: Record<string, true> = {
  text: true,
  list: true,
  sidebar: true,
}

describe('UI_INVARIANTS catalog', () => {
  const catalog = loadCatalog()

  it('uses the current schema version', () => {
    expect(catalog.version).toBe(1)
  })

  it('declares every screen referenced by the test plan', () => {
    const declared = new Set(Object.keys(catalog.screens))
    for (const step of catalog.steps) {
      if (step.target && !declared.has(step.target)) {
        throw new Error(`Step ${step.name} references missing screen block: ${step.target}`)
      }
    }
  })

  it('enforces performance budgets that are reachable but tight', () => {
    expect(catalog.performance.maxTransitionMs).toBeLessThanOrEqual(1500)
    expect(catalog.performance.maxTransitionMs).toBeGreaterThanOrEqual(500)
    expect(catalog.performance.maxApiCallMs).toBeLessThanOrEqual(500)
    expect(catalog.performance.maxMessageLoadMs).toBeLessThanOrEqual(1500)
    expect(catalog.performance.maxChatLoadMs).toBeLessThanOrEqual(1500)
  })

  it('blank-detection rules match the LVGL selection-border green', () => {
    expect(catalog.blankDetection.maxUniqueColors).toBeLessThanOrEqual(10)
    expect(catalog.blankDetection.borderGreenChannelG).toBe(255)
    expect(catalog.blankDetection.borderGreenMaxDistance).toBeGreaterThan(0)
  })

  it('every sidebar-kind screen has left and right invariants', () => {
    for (const [name, block] of Object.entries(catalog.screens)) {
      if (block.render.kind !== 'sidebar') continue
      if (!block.left) throw new Error(`${name}: sidebar screen missing left invariants`)
      if (!block.right) throw new Error(`${name}: sidebar screen missing right invariants`)
      if (block.left.sidebarTitle === undefined) throw new Error(`${name}: sidebar screen missing left.sidebarTitle`)
    }
  })

  it('every render.kind is one of the supported values', () => {
    for (const [name, block] of Object.entries(catalog.screens)) {
      if (!VALID_SCREEN_KINDS[block.render.kind]) {
        throw new Error(`${name}: unsupported render.kind ${block.render.kind}`)
      }
    }
  })

  it('every test step has a budget and a target', () => {
    const names = new Set<string>()
    for (const step of catalog.steps) {
      if (!step.name) throw new Error('A test step is missing a name')
      if (names.has(step.name)) throw new Error(`Duplicate test step name: ${step.name}`)
      names.add(step.name)
      if (!step.target) throw new Error(`${step.name}: test step missing target screen id`)
      if (typeof step.budgetMs !== 'number' || step.budgetMs <= 0) {
        throw new Error(`${step.name}: test step missing positive budgetMs`)
      }
    }
  })

  it('catalog expectations are all implemented by the simulator harness', () => {
    const supported = new Set([
      'apiCall', 'apiCallNotPresent', 'apiCalls', 'bridgeCall', 'bridgeCallNotPresent',
      'kind', 'maxPerSwipeMs', 'noLifecycles', 'noRenderEvents',
      'renderBodyContains', 'renderBodyContainsAny', 'renderBodyNotContains', 'state',
      'targetEventRequired',
    ])
    for (const step of catalog.steps) {
      for (const key of Object.keys(step.expect ?? {})) {
        if (!supported.has(key)) throw new Error(`${step.name}: unsupported expectation key ${key}`)
      }
    }
  })

  it('harness enforces target contracts, every declared API call, and required events', () => {
    const repoRoot = path.resolve(__dirname, '..', '..')
    const source = readFileSync(path.join(repoRoot, 'scripts', 'simulator-flow.mjs'), 'utf8')
    expect(source).toContain('catalog.screens[target]')
    expect(source).toContain('for (const call of expectedApiCalls)')
    expect(source).toContain('for (const requiredEvent of step.eventMustEmit ?? [])')
    expect(source).toContain('matchesExpectedApiCall')
  })

  it('performance and fuzzy checks consume real samples and are replayable', () => {
    const repoRoot = path.resolve(__dirname, '..', '..')
    const flow = readFileSync(path.join(repoRoot, 'scripts', 'simulator-flow.mjs'), 'utf8')
    const fuzzy = readFileSync(path.join(repoRoot, 'scripts', 'fuzzy-test.mjs'), 'utf8')
    expect(flow).toContain('perInputLatencies.push')
    expect(fuzzy).toContain('const seed =')
    expect(fuzzy).toContain('--seed ${seed}')
    expect(fuzzy).toContain("event.event === 'input.dispatch'")
    expect(fuzzy).toContain("event.event === 'state.work'")
    expect(fuzzy).toContain("event.event === 'bridge.queueDepth'")
    expect(fuzzy).not.toContain('Number(entry.id ?? 0) + 1')
  })

  it('at least one step exercises each major state', () => {
    const targets = new Set(catalog.steps.map((step) => step.target))
    const required: string[] = [
      'sidebar.chats',
      'sidebar.topics',
      'sidebar.messages.normal',
      'sidebarRecording',
      'sidebarTranscribing',
      'sidebarConfirm.send',
      'asleep',
    ]
    for (const requiredTarget of required) {
      if (!targets.has(requiredTarget)) {
        throw new Error(`No test step targets required screen: ${requiredTarget}`)
      }
    }
  })

  it('includes a latency-budget negative test', () => {
    const negative = catalog.steps.find((step) => step.expectToFail)
    if (!negative) throw new Error('No expectToFail step found; the harness cannot prove it enforces the latency budget')
    if (!negative.name.includes('perf-budget')) {
      throw new Error('The negative test should clearly look like a perf-budget test (perf-budget in name)')
    }
  })

  it('records long-message anchors in the fixture-driven steps', () => {
    const longMessageSteps = catalog.steps.filter((step) => {
      const needles = step.expect?.renderBodyContains
      if (!Array.isArray(needles)) return false
      return needles.some((needle) => typeof needle === 'string' && (
        needle.includes('deliberately long fixture message')
        || needle.includes('Fixture topic long message body')
        || needle.includes('fixture-long')
      ))
    })
    if (longMessageSteps.length < 2) {
      throw new Error(`Expected at least 2 long-message steps (chat + topic), found ${longMessageSteps.length}`)
    }
    const hasChat = longMessageSteps.some((step) => step.target === 'sidebar.messages.normal')
    const hasTopic = longMessageSteps.some((step) => step.target === 'sidebar.messages.topic')
    if (!hasChat) throw new Error('Missing long-message step for normal chat (target=sidebar.messages.normal)')
    if (!hasTopic) throw new Error('Missing long-message step for forum topic (target=sidebar.messages.topic)')
  })

  it('container upgrade failures are release-gating (not opt-in per step)', () => {
    // The harness now treats every `TextContainerUpgrade failed` simulator
    // warning as a hard failure. The catalog no longer needs `noContainerFailures`
    // per-step expectations because the bridge prevents stale partial updates
    // via page-generation gating, so any occurrence is a real bug.
    const stepsWithContainerFailures = catalog.steps.filter((s) => s.expect?.noContainerFailures === true)
    expect(stepsWithContainerFailures.length).toBe(0)
    // Every step's allowed expectation keys exclude noContainerFailures.
    for (const step of catalog.steps) {
      expect(step.expect?.noContainerFailures).toBeUndefined()
    }
  })

  it('records a burst-scroll step that asserts no render events', () => {
    const burst = catalog.steps.find((step) => step.expect?.noRenderEvents === true)
    if (!burst) throw new Error('No burst-scroll step with noRenderEvents expectation found')
    if (typeof burst.expect?.maxPerSwipeMs !== 'number' || burst.expect.maxPerSwipeMs > 1000) {
      throw new Error('Burst-scroll step must set maxPerSwipeMs <= 1000ms')
    }
  })

  it('includes a pagination step that forces listMessages with beforeId', () => {
    const paginated = catalog.steps.find((step) => {
      const calls = step.expect?.apiCalls ?? step.apiCalls
      if (!Array.isArray(calls)) return false
      return calls.some((call) => String(call).includes('beforeId'))
    })
    if (!paginated) throw new Error('No step found that exercises listMessages with beforeId (older pagination)')
  })


  it('harness exposes a noLifecycles matcher that catches idle-doublePress bounce', () => {
    // The G2 simulator (and the real G2 hardware, less often) fires system
    // `doublePress` events when nothing is happening, sending the controller
    // to asleep and back. The user perceives this as "scroll doesn't work"
    // or "I select something and something else opens up". The catalog must
    // have a step that asserts no asleep/wake events fire while the user is
    // intentionally interacting with a single chat. This locks in the
    // matcher AND the catalog step so a regression in either is caught.
    const repoRoot = path.resolve(__dirname, '..', '..')
    const source = readFileSync(path.join(repoRoot, 'scripts', 'simulator-flow.mjs'), 'utf8')
    if (!/expect\.noLifecycles/.test(source)) {
      throw new Error('simulator-flow.mjs is missing the noLifecycles matcher; idle-doublePress bounce is invisible to the harness')
    }
    if (!/event\.event === 'lifecycle'/.test(source)) {
      throw new Error('noLifecycles matcher must check event.event === "lifecycle"')
    }
    const step = catalog.steps.find((s) => s.name === '49-idle-no-asleep-bounce')
    if (!step) throw new Error('No catalog step 49-idle-no-asleep-bounce found')
    if (!Array.isArray(step.expect?.noLifecycles) || !step.expect.noLifecycles.includes('asleep') || !step.expect.noLifecycles.includes('wake')) {
      throw new Error('step 49-idle-no-asleep-bounce must declare noLifecycles: ["asleep", "wake"]')
    }
    if (typeof step.budgetMs !== 'number' || step.budgetMs < 4000) {
      throw new Error('step 49-idle-no-asleep-bounce needs a budget >= 4000ms so the simulator has time to fire its idle doublePress')
    }
  })

  it('harness skips remaining steps when the simulator subprocess dies', () => {
    // The harness's executeStep must short-circuit when the simulator handle's
    // `alive` flag is false, so a tokio panic or OOM in the simulator doesn't
    // generate dozens of misleading "timed out waiting for TeleGlanceTest
    // event" failures that hide the real cause. We assert the static source
    // here because the simulator subprocess cannot be exercised from vitest.
    const repoRoot = path.resolve(__dirname, '..', '..')
    const source = readFileSync(path.join(repoRoot, 'scripts', 'simulator-flow.mjs'), 'utf8')
    if (!/simulatorHandle\s*\.\s*alive\s*===\s*false|!\s*simulatorHandle\s*\.\s*alive/.test(source)) {
      throw new Error('simulator-flow.mjs is missing the simulator-alive short-circuit at the top of executeStep')
    }
    if (!/SKIPPED/.test(source)) {
      throw new Error('simulator-flow.mjs should mark skipped steps with a SKIPPED prefix in the failure message so the report reader can grep for them')
    }
    if (!/Subprocess health/.test(source)) {
      throw new Error('simulator-flow.mjs is missing the "Subprocess health" report section so crashes are surfaced alongside the per-step table')
    }
  })

  it('harness supports --external-simulator mode for user-supplied simulator instances', () => {
    // External mode lets the harness point at a simulator the user started
    // manually. This is the supported way to run the harness against a
    // long-lived simulator session (e.g. when the harness-spawned subprocess
    // crashes under load). The static-source check below locks in three
    // contracts: the flag is recognized, the simulator spawn is skipped in
    // that mode, and a synthetic handle is registered so executeStep's
    // alive-check still works.
    const repoRoot = path.resolve(__dirname, '..', '..')
    const source = readFileSync(path.join(repoRoot, 'scripts', 'simulator-flow.mjs'), 'utf8')
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'web', 'package.json'), 'utf8'))
    if (!/externalSimulator\s*=\s*Boolean\(args\['external-simulator'\]\)/.test(source)) {
      throw new Error('simulator-flow.mjs is not parsing --external-simulator')
    }
    if (!/externalSimulatorUrl\s*=\s*args\['simulator-url'\]/.test(source)) {
      throw new Error('simulator-flow.mjs is not parsing --simulator-url')
    }
    if (!/if\s*\(\s*externalSimulator\s*\)/.test(source)) {
      throw new Error('simulator-flow.mjs does not branch on externalSimulator to skip the spawn')
    }
    if (!/registerExternalSimulatorHandle/.test(source)) {
      throw new Error('simulator-flow.mjs is missing registerExternalSimulatorHandle; the alive-check in executeStep will misfire for external mode')
    }
    if (!packageJson.scripts['test:simulator:external']) {
      throw new Error('web/package.json is missing the test:simulator:external npm script')
    }
  })

  it('harness cleans up child processes on SIGINT/SIGTERM/uncaughtException', () => {
    // The harness spawns vite (with VITE_TELEGLANCE_FIXTURE=1 baked in) and
    // optionally a simulator subprocess, both with `detached: true` so they
    // live in their own process group. Without an explicit signal handler,
    // node's default behaviour on Ctrl+C or SIGTERM is to exit immediately
    // and the children get reparented to init and keep serving — which
    // leaks the fixture-mode frontend into the user's next `npm run dev`
    // session. We assert the static source has the three handlers we need.
    const repoRoot = path.resolve(__dirname, '..', '..')
    const source = readFileSync(path.join(repoRoot, 'scripts', 'simulator-flow.mjs'), 'utf8')
    // We accept either literal-quoted forms or a loop that iterates the
    // signal names. Both are valid; the harness uses a loop so the same
    // handler covers both SIGINT and SIGTERM.
    const sigintHandler = /process\.on\(['"]SIGINT['"]/.test(source)
      || /process\.on\(signal,/.test(source)
    if (!sigintHandler) {
      throw new Error('simulator-flow.mjs is missing a SIGINT handler; Ctrl+C will leak the harness-spawned vite with VITE_TELEGLANCE_FIXTURE=1')
    }
    const sigtermHandler = /process\.on\(['"]SIGTERM['"]/.test(source)
      || /process\.on\(signal,/.test(source)
    if (!sigtermHandler) {
      throw new Error('simulator-flow.mjs is missing a SIGTERM handler; external `pkill` will leak the harness-spawned vite')
    }
    if (!/process\.on\(['"]uncaughtException['"]/.test(source)) {
      throw new Error('simulator-flow.mjs is missing an uncaughtException handler; a thrown error will leak the harness-spawned vite')
    }
    if (!/runSyncCleanup/.test(source)) {
      throw new Error('simulator-flow.mjs is missing the runSyncCleanup helper that signal handlers should call')
    }
  })
})
