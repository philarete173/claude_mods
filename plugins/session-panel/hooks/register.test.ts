import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Plugin } from 'claude-code/testing'
import type { On, PluginState, RenderSurface, SessionMessage, UiPane } from 'claude-code'

import type { AgentRow, LogEntry, TurnAcc, TurnStats } from './stats'

type State = PluginState['session-panel']

// The contract (types/index.d.ts) cannot import stats.ts, so it mirrors its types; tsc fails here when they drift.
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const mirrorsStats: [
  Same<State['turn'], TurnAcc | null>,
  Same<State['lastTurn'], TurnStats | null>,
  Same<State['agents'], Record<string, AgentRow>>,
  Same<State['log'], LogEntry[]>,
] = [true, true, true, true]

const ROOT = '/work/online_shop'
const START = { cwd: ROOT, surface: 'desktop', isInteractive: true } as const
const RUN = { args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const
// The engine refuses a compaction with no messages, in the input and in the result.
const MESSAGES: SessionMessage[] = [{ role: 'user', text: 'hi', toolUses: [] }]
const PANE_UP: UiPane = { id: 'session-panel', title: 'Session', isShown: true, isFocused: false, isPlaced: true }

// A test's own `$` has no `state` noun, so a second plugin reads the session-panel values back through a command.
const READER: Plugin = {
  name: 'reader',
  register(on) {
    on('command.run', { command: 'read-state' }, async $ => {
      const state = {
        usage: (await $.state.get({ plugin: 'session-panel', key: 'usage' } as const)).value,
        project: (await $.state.get({ plugin: 'session-panel', key: 'project' } as const)).value,
        mcp: (await $.state.get({ plugin: 'session-panel', key: 'mcp' } as const)).value,
        turn: (await $.state.get({ plugin: 'session-panel', key: 'turn' } as const)).value,
        lastTurn: (await $.state.get({ plugin: 'session-panel', key: 'lastTurn' } as const)).value,
        agents: (await $.state.get({ plugin: 'session-panel', key: 'agents' } as const)).value,
        log: (await $.state.get({ plugin: 'session-panel', key: 'log' } as const)).value,
        collapsed: (await $.state.get({ plugin: 'session-panel', key: 'collapsed' } as const)).value,
      }

      return { text: JSON.stringify(state) }
    })
  },
}
// The mock clock takes about a second of real time per advance() while no plugin has a recurring timer armed (the
// plugin arms its own at session.start). This one arms a timer for a test that does not start the session.
const TICKER: Plugin = {
  name: 'ticker',
  register(on) {
    on('session.attach', ($, e, next) => {
      $.clock.every(1_000_000, () => undefined)

      return next(e)
    })
  },
}
const WITH_READER = { plugins: [READER] }
// Streams and timers: every wait of the bottom hooks is a held sleep that the test advances by hand.
const SLOW_READER = { plugins: [READER], timeoutMs: 30_000 }
const TICKING_READER = { plugins: [READER, TICKER], timeoutMs: 30_000 }

const readState = async ($: Engine): Promise<State> => {
  const ran = await $.command.run({ ...RUN, command: 'read-state' })

  return JSON.parse(ran.text ?? '{}') as State
}

// claude-code/testing has no toBeCloseTo, so a tolerance is checked by hand.
function expectNear(actual: number | null | undefined, expected: number, eps = 1e-9): void {
  const isNear = actual !== null && actual !== undefined && Math.abs(actual - expected) < eps
  expect(isNear, `expected ~${expected}, got ${actual}`).toBe(true)
}

const usage = (output: number) => ({
  input_tokens: 3,
  output_tokens: output,
  cache_read_input_tokens: 10,
  cache_creation_input_tokens: 5,
  model: 'claude-sonnet-5',
})

// A step the way the live data looks, less the engine chunks (a test cannot fabricate those). `at` is when the chunk
// arrives, in ms after the step starts. The first step calls a tool, the second one answers in text.
const TOOL_STEP = [
  { at: 300, chunk: { kind: 'thinking', index: 0, text: 'hm' } },
  { at: 400, chunk: { kind: 'text', index: 1, text: 'a' } },
  { at: 500, chunk: { kind: 'tool', index: 2, id: 'u1', name: 'Bash' } },
  { at: 1000, chunk: { kind: 'stop', stopReason: 'tool_use', usage: usage(40) } },
] as const
const ANSWER_STEP = [
  { at: 200, chunk: { kind: 'text', index: 0, text: 'done' } },
  { at: 700, chunk: { kind: 'stop', stopReason: 'end_turn', usage: usage(100) } },
] as const

type World = {
  usd: number // the engine's cost ledger, in dollars
  stepCost: number // what the next model request adds to the ledger when it stops
  surfaces: RenderSurface[]
  panes: UiPane[]
  placed: { isPlaced: true } | { isPlaced: false; reason: string }
  branch: string // what `git branch --show-current` prints
  gitExit: number
  gitThrows: boolean // git cannot be started
  listed: { id: string; status: string }[] // what $.agent.list() answers
  compacted: Record<string, unknown>
  spawns: number
  breakdowns: number // how many usage() calls asked for the context breakdown
  usageLag: number // how long usage() takes, in mock ms
  usageFails: boolean // usage() rejects
  tokens: number | undefined // context.tokens of usage(): none before the first response of the window
  rawMaxTokens: number | undefined // the window the breakdown measures against; undefined: no breakdown in usage()
  usageInFlight: number
  maxUsageInFlight: number
  registered: unknown[]
  opened: unknown[]
  closed: string[]
  invalidated: string[]
  runs: { argv: readonly string[]; init: unknown }[]
}

// The bottom of every chain: what the engine itself would answer, and what it was asked.
const bottom = (on: On, clock: MockClock, store?: Record<string, unknown>): World => {
  const w: World = {
    usd: 10,
    stepCost: 0,
    surfaces: ['desktop'],
    panes: [],
    placed: { isPlaced: true },
    branch: 'master\n',
    gitExit: 0,
    gitThrows: false,
    listed: [],
    compacted: { messages: MESSAGES, tokensBefore: 180_000, tokensAfter: 40_000 },
    spawns: 0,
    breakdowns: 0,
    usageLag: 0,
    usageFails: false,
    tokens: undefined,
    rawMaxTokens: 1_000_000,
    usageInFlight: 0,
    maxUsageInFlight: 0,
    registered: [],
    opened: [],
    closed: [],
    invalidated: [],
    runs: [],
  }
  mock.store(on, store)
  on('session.start', () => ({ cwd: ROOT }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.compact', () => w.compacted as never)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('agent.spawn', () => {
    w.spawns += 1

    return { model: 'claude-sonnet-5', agentId: `a${w.spawns}` }
  })
  on('classic.CwdChanged', () => ({}))
  on('turn.step', async function* (_$, e) {
    let elapsed = 0
    for (const { at, chunk } of e.index === 0 ? TOOL_STEP : ANSWER_STEP) {
      await clock.sleep(at - elapsed)
      elapsed = at
      // The engine charges the request as it stops.
      if (chunk.kind === 'stop') w.usd += w.stepCost
      yield chunk
    }

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  on('tool.call', async (_$, e) => {
    // What a call says decides how it ends: the command of a Bash, the description of an Agent, the message of a
    // SendMessage. One that starts with `deny` is denied, one that starts with `fail` fails.
    let says = ''
    if (e.tool === 'Bash') says = e.command
    if (e.tool === 'Agent') says = e.description
    if (e.tool === 'SendMessage') says = e.message
    if (says.startsWith('deny')) return { deny: 'no' }
    if (says.startsWith('fail')) return { isError: true as const, result: 'boom', text: 'boom' }
    await clock.sleep(300)

    return { result: { stdout: 'ok' } as never, text: 'ok' }
  })
  // Calls on `$`; the test host serves `state` itself and mock.clock serves `clock`.
  on('command.register', (_$, e) => {
    w.registered.push(e)

    return { value: { command: e.name } }
  })
  on('session.surfaces', () => ({ value: w.surfaces }))
  on('session.root', () => ({ value: ROOT }))
  on('session.usage', async (_$, e) => {
    w.usageInFlight += 1
    w.maxUsageInFlight = Math.max(w.maxUsageInFlight, w.usageInFlight)
    if (w.usageLag > 0) await clock.sleep(w.usageLag)
    w.usageInFlight -= 1
    if (w.usageFails) throw new Error('usage is not available')
    if (e.breakdown !== undefined) w.breakdowns += 1
    const breakdown = {
      rawMaxTokens: w.rawMaxTokens,
      skills: { totalSkills: 52, includedSkills: 52, tokens: 1, skillFrontmatter: [] },
      mcpTools: [
        { name: 'mcp__codebase-memory__search_graph', serverName: 'codebase-memory', tokens: 1, isLoaded: true },
        { name: 'mcp__codebase-memory__trace_path', serverName: 'codebase-memory', tokens: 1, isLoaded: true },
        { name: 'mcp__issue-hub__search', serverName: 'issue-hub', tokens: 1, isLoaded: true },
        { name: 'mcp__ccd_session__mark', serverName: 'ccd_session', tokens: 1, isLoaded: true },
      ],
    }

    return {
      value: {
        startedAt: 0,
        context: {
          window: 1_000_000,
          tokens: w.tokens,
          ...(e.breakdown === undefined || w.rawMaxTokens === undefined ? {} : { breakdown }),
        },
        rateLimits: [],
        cost: { usd: w.usd },
      } as never,
    }
  })
  on('process.run', (_$, e) => {
    w.runs.push({ argv: e.argv, init: e.init })
    if (w.gitThrows) throw new Error('spawn git ENOENT')
    const stdout = e.argv[1] === 'branch' ? w.branch : 'abc1234\n'

    return { value: { exitCode: w.gitExit, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('agent.list', () => ({ value: w.listed as never }))
  on('ui.open', (_$, e) => {
    w.opened.push(e)

    return { value: w.placed }
  })
  on('ui.close', (_$, e) => {
    w.closed.push(e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({ value: w.panes }))
  on('ui.invalidate', (_$, e) => {
    w.invalidated.push(e.event)

    return { value: undefined }
  })

  return w
}

// Moves the mock clock on until the work settles: every wait in the bottom hooks is held until then.
const drive = async <T>(clock: MockClock, work: Promise<T>): Promise<T> => {
  let isDone = false
  const tracked = work.finally(() => {
    isDone = true
  })
  for (let i = 0; i < 100 && !isDone; i += 1) {
    await clock.advance(100)
  }

  return tracked
}

// One model request through the hooks: the chunks that came out and what the stream returned.
const runStep = async (
  $: Engine,
  clock: MockClock,
  input: { turnId: string; index: number; agentId?: string },
): Promise<{ chunks: unknown[]; result: unknown }> => {
  const chunks: unknown[] = []
  const stream = $.turn.step({ model: 'claude-sonnet-5', messageCount: 1, ...input })
  const consuming = (async () => {
    let item = await stream.next()
    while (item.done !== true) {
      chunks.push(item.value)
      item = await stream.next()
    }

    return item.value
  })()

  return { chunks, result: await drive(clock, consuming) }
}

// One request of subagent `id` that costs `stepCost`, and the cost the panel shows for the agent once it is charged.
const chargedAfter = async ($: Engine, clock: MockClock, w: World, id: string, stepCost: number) => {
  w.stepCost = stepCost
  await runStep($, clock, { turnId: 't1', index: 1, agentId: id })
  await clock.advance(10)

  return (await readState($)).agents[id]?.costUsd
}

const SPAWN = {
  tool_use_id: 'u0',
  prompt: 'p',
  description: 'Fix cart total qty',
  subagentType: 'engineer',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-sonnet-5',
  background: true,
  fork: false,
} as const

// The calls that start a subagent and wake one, as the model makes them. What `description` and `message` say decides
// how the bottom ends them.
const agentCall = (description: string) =>
  ({ tool: 'Agent', description, prompt: 'p', subagent_type: 'engineer' }) as const
const sendTo = (to: unknown, message = 'go on') => ({ tool: 'SendMessage', to, message }) as const

test('session.start registers the command and opens the pane when a desktop is attached', async ($, on) => {
  const w = bottom(on, mock.clock(on, { now: 1_000_000 }))

  expect(await $.session.start(START)).toEqual({ cwd: ROOT })
  expect(w.registered).toEqual([{ name: 'session-panel', description: 'Open or close the session stats pane' }])
  expect(w.opened).toEqual([{ id: 'session-panel', title: 'Session' }])
})

test('a cost reading that fails stops neither the timer, the store read nor the opening of the pane', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = bottom(on, clock, { collapsed: { log: true } })
    w.usageFails = true

    await $.session.start(START)
    await clock.advance(30_000)

    expect(w.opened).toEqual([{ id: 'session-panel', title: 'Session' }])
    expect(w.invalidated).toEqual(['ui.render']) // the timer is running
    const state = await readState($)
    expect(state.collapsed).toEqual({ log: true })
    expect(state.project).toEqual({ name: 'online_shop', branch: 'master' })
  })

test('without a desktop the pane waits for the command; an attaching desktop opens it', async ($, on) => {
  const w = bottom(on, mock.clock(on))
  w.surfaces = ['terminal']

  await $.session.start({ ...START, surface: 'terminal' })
  expect(w.opened).toEqual([])
  await $.session.attach({ surface: 'mobile', clientId: 'mobile:default' })
  expect(w.opened).toEqual([])
  expect(await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })).toEqual({
    clientId: 'desktop:default',
  })
  expect(w.opened).toEqual([{ id: 'session-panel', title: 'Session' }])
})

test('the collapsed map is loaded from the store on start', WITH_READER, async ($, on) => {
  bottom(on, mock.clock(on), { collapsed: { log: true } })

  await $.session.start(START)

  expect((await readState($)).collapsed).toEqual({ log: true })
})

test('the command opens the pane, closes it when it is shown, and says why when it is not placed', async ($, on) => {
  const w = bottom(on, mock.clock(on))
  const run = async (): Promise<string | undefined> => (await $.command.run({ ...RUN, command: 'session-panel' })).text

  expect(await run()).toBe('Session pane opened.')
  expect(w.opened).toEqual([{ id: 'session-panel', title: 'Session' }])
  w.panes = [PANE_UP]
  expect(await run()).toBe('Session pane closed.')
  expect(w.closed).toEqual(['session-panel'])

  // A pane that is open but waits undrawn is not shown: the person asks for it, so it is asked for again.
  w.panes = [{ ...PANE_UP, isPlaced: false }]
  w.opened.length = 0
  expect(await run()).toBe('Session pane opened.')
  expect(w.opened).toEqual([{ id: 'session-panel', title: 'Session' }])
  expect(w.closed).toEqual(['session-panel'])

  w.panes = []
  w.placed = { isPlaced: false, reason: 'the terminal is too narrow' }
  expect(await run()).toBe('Session pane is not shown: the terminal is too narrow')
})

test('start-up reads project, branch, skills and MCP servers in the background', WITH_READER, async ($, on) => {
  const clock = mock.clock(on)
  const w = bottom(on, clock)

  await $.session.start(START)
  // Nothing has been written yet: the work has not run inside the hook.
  const early = await readState($)
  expect(early.project).toBeUndefined()
  expect(early.mcp).toBeUndefined()
  expect(w.breakdowns).toBe(0)

  await clock.advance(1)
  const state = await readState($)
  expect(state.project).toEqual({ name: 'online_shop', branch: 'master' })
  // The app's own server (ccd_session) is not listed.
  expect(state.mcp).toEqual({
    servers: [{ name: 'codebase-memory', status: 'connected' }, { name: 'issue-hub', status: 'connected' }],
    exact: false,
  })
  expect(state.usage.skills).toBe(52)
  expect(w.breakdowns).toBe(1)
  expect(w.runs).toEqual([{ argv: ['git', 'branch', '--show-current'], init: { cwd: ROOT, timeoutMs: 5000 } }])
})

test('a detached HEAD shows the short commit; a git that fails or cannot start leaves no branch; cwd refreshes it',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.branch = ''

    await $.session.start(START)
    await clock.advance(1)
    expect((await readState($)).project.branch).toBe('abc1234')
    expect(w.runs.map(run => run.argv)).toEqual([
      ['git', 'branch', '--show-current'],
      ['git', 'rev-parse', '--short', 'HEAD'],
    ])
    expect(w.runs[1]?.init).toEqual({ cwd: ROOT, timeoutMs: 5000 })

    w.gitExit = 128
    expect(await $.classic.CwdChanged({ old_cwd: ROOT, new_cwd: ROOT })).toEqual({})
    await clock.advance(1)
    expect((await readState($)).project).toEqual({ name: 'online_shop', branch: null })

    w.gitExit = 0
    w.branch = 'dev\n'
    await $.classic.CwdChanged({ old_cwd: ROOT, new_cwd: ROOT })
    await clock.advance(1)
    expect((await readState($)).project).toEqual({ name: 'online_shop', branch: 'dev' })

    // git cannot be started at all: the call rejects, the name stays and the branch goes.
    w.gitThrows = true
    await $.classic.CwdChanged({ old_cwd: ROOT, new_cwd: ROOT })
    await clock.advance(1)
    expect((await readState($)).project).toEqual({ name: 'online_shop', branch: null })
  })

test('session.measure fills usage, resetsAt becomes epoch ms and skills survive', WITH_READER, async ($, on) => {
  const clock = mock.clock(on)
  bottom(on, clock)
  await $.session.start(START)
  await clock.advance(1)

  const measured = await $.session.measure({
    context: { window: 1_000_000, tokens: 128_000, percent: 12.8 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 3, resetsAt: '2026-10-07T12:00:00Z' },
      { kind: 'seven_day', percentUsed: 24 },
    ],
    cost: { usd: 5.49 },
    changed: ['context', 'cost'],
  })

  expect(measured).toEqual({ changed: ['context', 'cost'] })
  expect((await readState($)).usage).toEqual({
    contextTokens: 128_000,
    contextWindow: 1_000_000,
    contextPct: 12.8,
    costUsd: 5.49,
    rateLimits: [
      { kind: 'five_hour', percentUsed: 3, resetsAt: Date.parse('2026-10-07T12:00:00Z') },
      { kind: 'seven_day', percentUsed: 24 },
    ],
    skills: 52,
  })
})

test('the context is measured against the breakdown\'s window, which session.measure keeps', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    const shown = async () => (await readState($)).usage
    w.rawMaxTokens = 600_000 // autoCompactWindow: 600000, under the model's window of 1M
    w.tokens = 90_000
    // The engine's percent is of the model's window: it is not the panel's.
    const measure = (tokens: number) => $.session.measure({
      context: { window: 1_000_000, tokens, percent: tokens / 10_000 }, rateLimits: [], changed: ['context'],
    })

    // Until a breakdown comes, the model's window is all there is.
    await measure(120_000)
    expect(await shown()).toMatchObject({ contextWindow: 1_000_000, contextPct: 12 })

    await $.session.start(START)
    await clock.advance(1)
    // usage() brings the tokens as well: the percent is worked out there too.
    expect(await shown()).toMatchObject({ contextTokens: 90_000, contextWindow: 600_000, contextPct: 15 })

    await measure(120_000)
    expect(await shown()).toMatchObject({ contextTokens: 120_000, contextWindow: 600_000, contextPct: 20 })
    await measure(150_000)
    expect(await shown()).toMatchObject({ contextTokens: 150_000, contextWindow: 600_000, contextPct: 25 })

    // A compaction empties the window: no tokens, so no percent, until the next response. The window stays.
    w.tokens = undefined
    await $.session.compact({ trigger: 'manual', messages: MESSAGES })
    await clock.advance(1)
    const compacted = await shown()
    expect(compacted.contextWindow).toBe(600_000)
    expect(compacted.contextTokens).toBeUndefined()
    expect(compacted.contextPct).toBeUndefined()

    // A reading that comes with no breakdown leaves the window as it was.
    w.rawMaxTokens = undefined
    w.tokens = 60_000
    await $.session.compact({ trigger: 'manual', messages: MESSAGES })
    await clock.advance(1)
    expect(await shown()).toMatchObject({ contextTokens: 60_000, contextWindow: 600_000, contextPct: 10 })
  })

test('without a breakdown the window is the model\'s and the percent is worked out against it', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    const shown = async () => (await readState($)).usage
    w.rawMaxTokens = undefined // usage() answers with no breakdown
    w.tokens = 100_000

    await $.session.start(START)
    await clock.advance(1)
    expect(await shown()).toMatchObject({ contextTokens: 100_000, contextWindow: 1_000_000, contextPct: 10 })

    await $.session.measure({
      context: { window: 1_000_000, tokens: 250_000, percent: 25 }, rateLimits: [], changed: ['context'],
    })
    expect(await shown()).toMatchObject({ contextTokens: 250_000, contextWindow: 1_000_000, contextPct: 25 })
  })

test('a window of 0 gives no percent: the context is unread, never NaN or Infinity', WITH_READER, async ($, on) => {
  bottom(on, mock.clock(on))
  const shown = async () => (await readState($)).usage
  // The model's window is all there is before a breakdown, and here it reads 0.
  const measure = (tokens: number) =>
    $.session.measure({ context: { window: 0, tokens, percent: 0 }, rateLimits: [], changed: ['context'] })

  // Tokens over a window of 0 come to Infinity, none over none to NaN: neither is written down (the state is JSON, and
  // would keep either as null).
  await measure(100)
  expect(await shown()).toMatchObject({ contextTokens: 100, contextWindow: 0 })
  expect((await shown()).contextPct).toBeUndefined()
  await measure(0)
  expect((await shown()).contextPct).toBeUndefined()
})

test('a main turn ends as lastTurn: step timing, tool time, cost and log; everything passes through', SLOW_READER,
  async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)

    expect(await $.turn.start({ text: 'fix the stock order qty', turnId: 't1' })).toEqual({ turnId: 't1' })
    w.stepCost = 0.25
    const first = await runStep($, clock, { turnId: 't1', index: 0 })
    expect(first.chunks).toEqual(TOOL_STEP.map(step => step.chunk))
    expect(first.result).toEqual({
      turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null,
    })
    const toolStart = clock.now()
    expect(await drive(clock, $.tool.call({ tool: 'Bash', command: 'ls -la' }))).toEqual({
      result: { stdout: 'ok' }, text: 'ok',
    })

    const midTurn = (await readState($)).turn
    expect(midTurn?.turnId).toBe('t1')
    expect(midTurn?.steps).toHaveLength(1)
    expect(midTurn?.toolIntervals).toEqual([[toolStart, toolStart + 300]])

    w.stepCost = 0.125
    await runStep($, clock, { turnId: 't1', index: 1 })
    await clock.advance(10)
    const done = await $.turn.complete({
      answer: 'done',
      durationMs: 2000,
      isAborted: false,
      turnId: 't1',
      reason: 'answer',
      usage: {
        input_tokens: 50, output_tokens: 800, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, model: 'm',
      },
    })
    expect(done).toEqual({ text: 'done' })

    const state = await readState($)
    expect(state.turn).toBeNull()
    expect(state.lastTurn).toMatchObject({
      elapsedMs: 2000, modelMs: 1700, toolMs: 300, steps: 2, ttftMs: 250, tokensIn: 50, tokensOut: 800, cachePct: 90,
      costUsd: 0.375,
    })
    expectNear(state.lastTurn?.wholeTurnRate, 140 / 1.7)
    // The answer: 100 tokens over its whole request, 0.7 s (its text came 0.2 s in, which does not matter).
    expectNear(state.lastTurn?.responseRate, 100 / 0.7)
    expect(state.log.map(entry => [entry.who, entry.text, entry.kind])).toEqual([
      ['main', 'Bash ls -la ✓ 0.3s', 'ok'],
      ['you', 'fix the stock order qty', 'info'],
    ])
  })

test('a step cut off mid-stream leaves the turn as it was and has passed on what it saw', SLOW_READER,
  async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    await $.turn.start({ text: 'go', turnId: 't1' })

    // The person interrupts: the engine takes two chunks and closes the stream.
    const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5', messageCount: 1 })
    const seen: unknown[] = []
    const interrupted = (async () => {
      for (let i = 0; i < 2; i += 1) seen.push((await stream.next()).value)
      await stream.return(undefined as never)
    })()
    await drive(clock, interrupted)
    await clock.advance(10)
    expect(seen).toEqual(TOOL_STEP.slice(0, 2).map(step => step.chunk))
    expect((await readState($)).turn?.steps).toEqual([])

    // The next step is whole and the only one that counts; the cut one was charged to nobody.
    w.stepCost = 0.25
    await runStep($, clock, { turnId: 't1', index: 1 })
    await clock.advance(10)
    await $.turn.complete({ answer: 'done', durationMs: 900, isAborted: false, turnId: 't1', reason: 'answer' })
    expect((await readState($)).lastTurn).toMatchObject({ steps: 1, modelMs: 700, ttftMs: 200, costUsd: 0.25 })
  })

test('turn.start logs a prompt as you, redacted and cut to 70, and an engine turn by its tag', WITH_READER,
  async ($, on) => {
    bottom(on, mock.clock(on))
    await $.session.start(START)

    await $.turn.start({ text: '<task-notification>done</task-notification>', turnId: 't1' })
    await $.turn.start({ text: 'use token=hunter22secret', turnId: 't2' })
    await $.turn.start({ text: 'x'.repeat(80), turnId: 't3' })
    // A turn without a typed prompt (a continuation) is no line of the log, but it is a turn.
    await $.turn.start({ text: '', turnId: 't4' })
    await $.turn.start({ text: ' \n ', turnId: 't5' })

    const state = await readState($)
    expect(state.log.map(entry => [entry.who, entry.text, entry.kind])).toEqual([
      ['you', `${'x'.repeat(69)}…`, 'info'],
      ['you', 'use token=•••', 'info'],
      ['engine', 'task-notification', 'info'],
    ])
    expect(state.turn?.turnId).toBe('t5')
  })

test('a failed or denied tool call is logged as ✗ or denied, and a secret in the command is redacted', WITH_READER,
  async ($, on) => {
    bottom(on, mock.clock(on))
    await $.session.start(START)

    expect(await $.tool.call({ tool: 'Bash', command: 'deny it' })).toEqual({ deny: 'no' })
    expect(await $.tool.call({ tool: 'Bash', command: 'fail --token=hunter22secret' })).toEqual({
      isError: true, result: 'boom', text: 'boom',
    })

    expect((await readState($)).log.map(entry => [entry.who, entry.text, entry.kind])).toEqual([
      ['main', 'Bash fail --token=••• ✗', 'error'],
      ['main', 'Bash deny it denied', 'error'],
    ])
  })

test('a long command keeps its outcome: the label is cut short and the suffix is not', SLOW_READER, async ($, on) => {
  const clock = mock.clock(on)
  bottom(on, clock)
  await $.session.start(START)

  await drive(clock, $.tool.call({ tool: 'Bash', command: 'x'.repeat(100) }))
  await $.tool.call({ tool: 'Bash', command: `deny ${'y'.repeat(100)}` })
  await $.tool.call({ tool: 'Bash', command: `fail ${'z'.repeat(100)}` })

  const lines = (await readState($)).log.map(entry => entry.text)
  expect(lines).toEqual([
    `${`Bash fail ${'z'.repeat(100)}`.slice(0, 61)}… ✗`,
    `${`Bash deny ${'y'.repeat(100)}`.slice(0, 56)}… denied`,
    `${`Bash ${'x'.repeat(100)}`.slice(0, 56)}… ✓ 0.3s`,
  ])
  expect(lines.map(line => line.length)).toEqual([64, 64, 64])
})

test('a turn the mod did not see start leaves lastTurn alone; the branch is read again when a turn ends', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    w.runs.length = 0

    const done = await $.turn.complete({
      answer: 'done', durationMs: 5, isAborted: false, turnId: 't0', reason: 'answer',
    })
    await clock.advance(1)

    expect(done).toEqual({ text: 'done' })
    expect((await readState($)).lastTurn).toBeUndefined()
    expect(w.runs).toEqual([{ argv: ['git', 'branch', '--show-current'], init: { cwd: ROOT, timeoutMs: 5000 } }])
  })

test('a subagent: its row, the cost of each step by the cost.usd delta, its outcome', SLOW_READER, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = bottom(on, clock)
  await $.session.start(START)
  await clock.advance(1)
  await $.turn.start({ text: 'go', turnId: 't1' })

  expect(await $.agent.spawn(SPAWN)).toEqual({ model: 'claude-sonnet-5', agentId: 'a1' })
  const spawnedAt = clock.now()
  let state = await readState($)
  expect(state.agents).toEqual({
    a1: {
      id: 'a1',
      description: 'Fix cart total qty',
      type: 'engineer',
      model: 'claude-sonnet-5',
      status: 'running',
      startedAt: spawnedAt,
      endedAt: null,
      costUsd: null,
    },
  })
  expect(state.log[0]).toEqual({
    at: spawnedAt, who: 'main', text: 'spawned · engineer: Fix cart total qty', kind: 'info',
  })

  // A subagent's tool call is logged under its type and is not the turn's tool time.
  const subagentRead = { tool: 'Read', file_path: `${ROOT}/src/a.py`, agentId: 'a1' }
  await drive(clock, $.tool.call(subagentRead as never))

  w.stepCost = 0.5
  expect((await runStep($, clock, { turnId: 't1', index: 0, agentId: 'a1' })).chunks).toEqual(
    TOOL_STEP.map(step => step.chunk),
  )
  await clock.advance(10)
  // Total follows the reading at once, not at the next session.measure (there is none in this test).
  expect((await readState($)).usage.costUsd).toBe(10.5)
  w.stepCost = 0.25
  await runStep($, clock, { turnId: 't1', index: 1, agentId: 'a1' })
  await clock.advance(10)
  w.stepCost = 0.125
  await runStep($, clock, { turnId: 't1', index: 1 })
  await clock.advance(10)
  state = await readState($)
  expect(state.usage.costUsd).toBe(10.875)
  // The main loop's step stays out of the row, and the subagent's steps are not the turn's.
  expect(state.agents.a1?.costUsd).toBe(0.75)
  expect(state.turn?.steps).toHaveLength(1)
  expect(state.turn?.toolIntervals).toEqual([])
  expect(state.log.find(entry => entry.who === 'engineer')?.text).toBe('Read src/a.py ✓ 0.3s')

  const completed = await $.turn.complete({
    answer: 'found the bug in qty', durationMs: 72_000, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer',
  })
  const completedAt = clock.now()
  expect(completed).toEqual({ text: 'found the bug in qty' })
  state = await readState($)
  expect(state.agents.a1).toMatchObject({ status: 'done', endedAt: completedAt, costUsd: 0.75 })
  expect(state.log[0]).toEqual({
    at: completedAt, who: 'engineer', text: 'done 1m 12s · $0.750 — found the bug in qty', kind: 'ok',
  })
  expect(state.lastTurn).toBeUndefined()
  expect(state.turn?.turnId).toBe('t1')
})

test('a stopped subagent is a note in the log, a failed one is an error', WITH_READER, async ($, on) => {
  bottom(on, mock.clock(on))
  await $.session.start(START)
  await $.agent.spawn(SPAWN)
  await $.agent.spawn(SPAWN)

  await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't1', agentId: 'a1', reason: 'aborted' })
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 't1', agentId: 'a2', reason: 'error' })

  const state = await readState($)
  expect(state.agents.a1?.status).toBe('stopped')
  expect(state.agents.a2?.status).toBe('failed')
  expect(state.log.slice(0, 2).map(entry => [entry.who, entry.text, entry.kind])).toEqual([
    ['engineer', 'failed', 'error'],
    ['engineer', 'stopped', 'info'], // somebody stopped it: that is news, not an error
  ])
})

test('a subagent that ends while the cost cannot be read is still logged and closed', WITH_READER, async ($, on) => {
  const w = bottom(on, mock.clock(on, { now: 1_000_000 }))
  await $.session.start(START)
  await $.agent.spawn(SPAWN)
  w.usageFails = true

  const completed = await $.turn.complete({
    answer: 'ok', durationMs: 5000, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer',
  })

  expect(completed).toEqual({ text: 'ok' })
  const state = await readState($)
  expect(state.agents.a1?.status).toBe('done')
  expect(state.log[0]).toMatchObject({ who: 'engineer', text: 'done 5.0s — ok', kind: 'ok' })
})

test('a subagent that ends right after its last step is logged with that step charged', SLOW_READER, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = bottom(on, clock)
  await $.session.start(START)
  await clock.advance(1)
  await $.agent.spawn(SPAWN)
  expect(await chargedAfter($, clock, w, 'a1', 0.5)).toBe(0.5)
  w.stepCost = 0.25
  await runStep($, clock, { turnId: 't1', index: 1, agentId: 'a1' })

  // The timer of the last step has not fired when the turn ends, and no clock advance hides that here.
  await $.turn.complete({
    answer: 'ok', durationMs: 5000, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer',
  })

  const ended = await readState($)
  expect(ended.log[0]?.text).toBe('done 5.0s · $0.750 — ok')
  expect(ended.agents.a1?.costUsd).toBe(0.75)
  await clock.advance(10)
  expect((await readState($)).agents.a1?.costUsd).toBe(0.75) // the late timer charges nothing twice
})

test('cost readings are taken one at a time: a turn that ends while one is in flight waits for it', SLOW_READER,
  async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    await $.agent.spawn(SPAWN)
    w.stepCost = 0.25
    await runStep($, clock, { turnId: 't1', index: 1, agentId: 'a1' })

    w.usageLag = 5
    w.maxUsageInFlight = 0
    await clock.advance(1) // the timer of the step fires: its reading is in flight now
    await drive(clock, $.turn.complete({
      answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer',
    }))

    expect(w.maxUsageInFlight).toBe(1)
    expect((await readState($)).log[0]?.text).toBe('done 1.0s · $0.250 — ok')
  })

test('a subagent that a message resumes runs again, with one line in the log, until it ends again', SLOW_READER,
  async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.agent.spawn(SPAWN)
    expect(await chargedAfter($, clock, w, 'a1', 0.5)).toBe(0.5)
    await $.turn.complete({
      answer: 'found it', durationMs: 4000, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer',
    })
    const endedAt = clock.now()
    const ended = await readState($)
    expect(ended.agents.a1).toMatchObject({ status: 'done', endedAt, costUsd: 0.5 })

    // A message wakes it: its next request carries its id, and the row runs again. Nothing else of the row changes,
    // the cost of the first run included (the request costs nothing here).
    w.stepCost = 0
    await clock.advance(5000)
    const resumedAt = clock.now()
    await runStep($, clock, { turnId: 't1', index: 1, agentId: 'a1' })
    await clock.advance(10)
    const resumed = await readState($)
    expect(resumed.agents.a1).toEqual({ ...ended.agents.a1, status: 'running', endedAt: null })
    expect(resumed.log).toHaveLength(ended.log.length + 1)
    expect(resumed.log[0]).toMatchObject({ who: 'main', text: 'resumed · engineer: Fix cart total qty', kind: 'info' })
    expect(resumed.log[0]?.at).toBeGreaterThanOrEqual(resumedAt)

    // The next request of the same run says nothing more: one line per resume.
    await runStep($, clock, { turnId: 't1', index: 1, agentId: 'a1' })
    await clock.advance(10)
    expect((await readState($)).log).toEqual(resumed.log)

    // It ends again: the row is closed again, with the new time, and the end has its line.
    await clock.advance(1000)
    await $.turn.complete({
      answer: 'and again', durationMs: 3000, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer',
    })
    const endedAgainAt = clock.now()
    const again = await readState($)
    expect(endedAgainAt).toBeGreaterThan(endedAt)
    expect(again.agents.a1).toEqual({ ...ended.agents.a1, endedAt: endedAgainAt })
    expect(again.log[0]).toEqual({
      at: endedAgainAt, who: 'engineer', text: 'done 3.0s · $0.500 — and again', kind: 'ok',
    })
  })

test('a step revives only the closed row of its own agent: a running agent, an unknown one and main change nothing',
  SLOW_READER, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.agent.spawn(SPAWN)
    await $.agent.spawn(SPAWN)
    await $.turn.complete({
      answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer',
    })
    const before = await readState($)
    expect([before.agents.a1?.status, before.agents.a2?.status]).toEqual(['done', 'running'])

    // The step of a2, which runs; of a9, which the panel has never heard of; of the main loop, which has no agent id.
    // The closed row of a1 stays closed through all three, and no line is added to the log.
    const steps = [
      ['a running agent', { agentId: 'a2' }], ['an unknown agent', { agentId: 'a9' }], ['the main loop', {}],
    ] as const
    for (const [who, from] of steps) {
      await runStep($, clock, { turnId: 't1', index: 1, ...from })
      await clock.advance(10)
      const after = await readState($)
      expect(after.agents, who).toEqual(before.agents)
      expect(after.log, who).toEqual(before.log)
    }
  })

test('a subagent that the main loop spawns has one line in the log: its spawn, not the Agent call as well', SLOW_READER,
  async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)

    // The engine spawns the subagent while the tool call is in flight, and the call returns once the agent has run.
    const call = $.tool.call(agentCall('Fix cart total qty'))
    await $.agent.spawn(SPAWN)
    expect(await drive(clock, call)).toEqual({ result: { stdout: 'ok' }, text: 'ok' })
    // Task is the other name of the same tool.
    await drive(clock, $.tool.call({ ...agentCall('Fix cart total qty'), tool: 'Task' } as never))

    const log = (await readState($)).log
    expect(log.map(entry => [entry.who, entry.text, entry.kind])).toEqual([
      ['main', 'spawned · engineer: Fix cart total qty', 'info'],
    ])
  })

test('a denied or failed Agent call is logged as denied or ✗: no subagent started, so no other line says it',
  WITH_READER, async ($, on) => {
    bottom(on, mock.clock(on))
    await $.session.start(START)

    expect(await $.tool.call(agentCall('deny it'))).toEqual({ deny: 'no' })
    expect(await $.tool.call(agentCall('fail it'))).toEqual({ isError: true, result: 'boom', text: 'boom' })

    expect((await readState($)).log.map(entry => [entry.who, entry.text, entry.kind])).toEqual([
      ['main', 'Agent → engineer: fail it ✗', 'error'],
      ['main', 'Agent → engineer: deny it denied', 'error'],
    ])
  })

test('a SendMessage to a subagent adds no line, any other one does, and a failed one is logged either way',
  SLOW_READER, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    await $.agent.spawn(SPAWN)
    const lines = async (): Promise<string[][]> =>
      (await readState($)).log.map(entry => [entry.who, entry.text, entry.kind])
    const spawned = [['main', 'spawned · engineer: Fix cart total qty', 'info']]

    // To a subagent the panel has a row for, by its id: its own lines say it.
    await drive(clock, $.tool.call(sendTo('a1')))
    expect(await lines()).toEqual(spawned)

    // To anyone else: everybody, an id with no row, a name, a key that every object has, and not a name at all.
    for (const to of ['*', 'a9', 'researcher', 'constructor', 42]) await drive(clock, $.tool.call(sendTo(to)))
    expect(await lines()).toEqual([...Array(5).fill(['main', 'SendMessage ✓ 0.3s', 'ok']), ...spawned])

    // A call to the subagent that failed or was denied says so.
    await $.tool.call(sendTo('a1', 'fail it'))
    await $.tool.call(sendTo('a1', 'deny it'))
    expect((await lines()).slice(0, 2)).toEqual([
      ['main', 'SendMessage denied', 'error'],
      ['main', 'SendMessage ✗', 'error'],
    ])
  })

test('Tool time counts an Agent call and a SendMessage call of the main loop, though neither is logged', SLOW_READER,
  async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.agent.spawn(SPAWN)

    const agentStart = clock.now()
    await drive(clock, $.tool.call(agentCall('Fix cart total qty')))
    const messageStart = clock.now()
    await drive(clock, $.tool.call(sendTo('a1')))

    const midTurn = await readState($)
    expect(midTurn.turn?.toolIntervals).toEqual([[agentStart, agentStart + 300], [messageStart, messageStart + 300]])
    expect(midTurn.log.map(entry => entry.text)).toEqual(['spawned · engineer: Fix cart total qty', 'go'])
    await $.turn.complete({ answer: 'done', durationMs: 2000, isAborted: false, turnId: 't1', reason: 'answer' })
    expect((await readState($)).lastTurn?.toolMs).toBe(600)
  })

test('every 30 s the pane is redrawn and statuses follow $.agent.list; usage refreshes every second tick', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = bottom(on, clock)
    const startedAt = clock.now()
    await $.session.start(START)
    await clock.advance(1)
    for (let i = 0; i < 4; i += 1) await $.agent.spawn(SPAWN)
    w.listed = [
      { id: 'a1', status: 'completed' },
      { id: 'a2', status: 'failed' },
      { id: 'a3', status: 'killed' },
      { id: 'a4', status: 'some-new-status' },
    ]
    expect(w.invalidated).toEqual([])
    expect(w.breakdowns).toBe(1)

    await clock.advance(30_000)
    expect(w.invalidated).toEqual(['ui.render'])
    expect(w.breakdowns).toBe(1)
    const agents = (await readState($)).agents
    expect(Object.values(agents).map(agent => agent.status)).toEqual(['done', 'failed', 'stopped', 'running'])
    expect(agents.a1?.endedAt).toBe(startedAt + 30_000)
    expect(agents.a4?.endedAt).toBeNull()

    await clock.advance(30_000)
    expect(w.invalidated).toEqual(['ui.render', 'ui.render'])
    expect(w.breakdowns).toBe(2)
  })

test('the engine list closes subagents that are still running and never rewrites an outcome', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = bottom(on, clock)
    const startedAt = clock.now()
    await $.session.start(START)
    await clock.advance(1)
    for (let i = 0; i < 4; i += 1) await $.agent.spawn(SPAWN)
    await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'error' })
    await $.turn.complete({
      answer: '', durationMs: 5, isAborted: true, turnId: 't1', agentId: 'a2', reason: 'aborted',
    })
    const outcomes = (await readState($)).agents
    expect(outcomes.a1?.status).toBe('failed')
    expect(outcomes.a2?.status).toBe('stopped')

    // A late list that says "completed" for all three: only the one that is still running follows it.
    w.listed = [{ id: 'a1', status: 'completed' }, { id: 'a2', status: 'completed' }, { id: 'a3', status: 'completed' }]
    await clock.advance(30_000)
    let agents = (await readState($)).agents
    expect(agents.a1).toEqual(outcomes.a1)
    expect(agents.a2).toEqual(outcomes.a2)
    expect(agents.a3).toMatchObject({ status: 'done', endedAt: startedAt + 30_000 })

    // A list that still says "running" revives nothing and ends nothing.
    w.listed = [{ id: 'a1', status: 'running' }, { id: 'a3', status: 'running' }, { id: 'a4', status: 'running' }]
    await clock.advance(30_000)
    agents = (await readState($)).agents
    expect(agents.a1).toEqual(outcomes.a1)
    expect(agents.a3?.status).toBe('done')
    expect(agents.a4).toMatchObject({ status: 'running', endedAt: null })
  })

test('a compaction is logged and refreshes usage; a skipped one and a subagent\'s are not logged', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)

    const compactedAt = clock.now()
    expect(await $.session.compact({ trigger: 'manual', messages: MESSAGES })).toEqual(w.compacted)
    await clock.advance(1)
    expect((await readState($)).log).toEqual([
      { at: compactedAt, who: 'main', text: 'compacted 180k → 40k', kind: 'info' },
    ])
    expect(w.breakdowns).toBe(2)

    await $.session.compact({ trigger: 'auto', agentId: 'a9', messages: MESSAGES })
    w.compacted = { skip: 'off' }
    await $.session.compact({ trigger: 'manual', messages: MESSAGES })
    await clock.advance(1)
    expect((await readState($)).log).toHaveLength(1)
  })

test('the first cost reading, and one under the last, only set the baseline', TICKING_READER, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = bottom(on, clock)
  // No session.start: the module has just been loaded and has taken no baseline yet.
  await $.session.attach({ surface: 'terminal', clientId: 'terminal:default' })
  await $.agent.spawn(SPAWN)

  expect(await chargedAfter($, clock, w, 'a1', 0.5)).toBeNull() // the reading, 10.5, is the baseline
  expect(await chargedAfter($, clock, w, 'a1', 0.25)).toBe(0.25)
  // The ledger starts over (a new session): its first reading is a new baseline, not a negative charge.
  w.usd = 1
  expect(await chargedAfter($, clock, w, 'a1', 0.125)).toBe(0.25)
  expect(await chargedAfter($, clock, w, 'a1', 0.5)).toBe(0.75)
})

test('a /clear starts the panel over, and the next cost reading is a baseline', SLOW_READER, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = bottom(on, clock)
  w.tokens = 90_000 // a response has filled the window: 9% of the 1M window
  await $.session.start(START)
  await clock.advance(1)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn(SPAWN)
  w.stepCost = 0.5
  await runStep($, clock, { turnId: 't1', index: 1 })
  await clock.advance(10)
  await $.turn.complete({ answer: 'done', durationMs: 700, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.turn.start({ text: 'again', turnId: 't2' })
  const before = await readState($)
  expect(before.lastTurn).toBeTruthy()
  expect(before.turn?.turnId).toBe('t2')
  expect(Object.keys(before.agents)).toEqual(['a1'])
  expect(before.log.length).toBeGreaterThan(0)
  expect(before.usage).toMatchObject({ contextTokens: 90_000, contextPct: 9 })

  // Any other end of the session leaves the panel as it is.
  expect(await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } })).toEqual({ sessionId: 's1' })
  expect(await readState($)).toEqual(before)

  expect(await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })).toEqual({ sessionId: 's1' })
  const after = await readState($)
  expect([after.turn, after.lastTurn, after.agents, after.log]).toEqual([null, null, {}, []])
  expect(after.project).toEqual(before.project)
  // The context reads empty until the next response; the window, the cost, the limits and the skills are the session's.
  const { contextTokens, contextPct, ...kept } = before.usage
  expect([contextTokens, contextPct]).toEqual([90_000, 9])
  expect(after.usage).toEqual(kept)
  expect(after.usage.contextTokens).toBeUndefined()
  expect(after.usage.contextPct).toBeUndefined()
  expect(w.closed).toEqual([])

  // The new session's ledger may start above the old reading: its first reading is a baseline all the same.
  w.usd = 20
  await $.agent.spawn(SPAWN)
  expect(await chargedAfter($, clock, w, 'a2', 0.5)).toBeNull()
  expect(await chargedAfter($, clock, w, 'a2', 0.25)).toBe(0.25)
})
