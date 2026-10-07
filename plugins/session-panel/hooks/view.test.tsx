import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Plugin } from 'claude-code/testing'
import type { On, RenderPropsOf, SessionRateLimit } from 'claude-code'

import { meterSvg, meterWidth, renderPane } from './view'
import type { PaneData } from './view'

// The state of the pane is seeded the way register.test.ts does it: the events of a session run through the real
// hooks, over a bottom that answers as the engine would, and the pane is mounted on a surface to see what it draws.
const ROOT = '/work/online_shop'
const START = { cwd: ROOT, surface: 'desktop', isInteractive: true } as const
const NOW = Date.parse('2026-10-07T12:00:00Z')
const SURFACES = ['desktop', 'terminal'] as const
type Surface = (typeof SURFACES)[number]
const PANE_PROPS: RenderPropsOf['Pane'] = {
  title: 'Session', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {},
}
const RUN = { args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

// A test's own `$` has no `store` noun, so a second plugin reads the map the pane keeps in the store through a command.
const READER: Plugin = {
  name: 'reader',
  register(on) {
    on('command.run', { command: 'read-store' }, async $ => ({ text: JSON.stringify(await $.store.get('collapsed')) }))
  },
}
// Every wait of the bottom hooks is a held sleep that the test advances by hand.
const SLOW = { plugins: [READER], timeoutMs: 30_000 }

const usage = (output: number) => ({
  input_tokens: 3,
  output_tokens: output,
  cache_read_input_tokens: 10,
  cache_creation_input_tokens: 5,
  model: 'claude-sonnet-5',
})

// Two requests of a turn: the first calls a tool, the second answers in text. Together: 1.7 s of model time and 104
// output tokens, so the whole turn runs at ~61 tok/s and the answer alone at 84 tokens in 0.5 s, ~168 tok/s.
const TOOL_STEP = [
  { at: 300, chunk: { kind: 'text', index: 0, text: 'a' } },
  { at: 500, chunk: { kind: 'tool', index: 1, id: 'u1', name: 'Bash' } },
  { at: 1000, chunk: { kind: 'stop', stopReason: 'tool_use', usage: usage(20) } },
] as const
const ANSWER_STEP = [
  { at: 200, chunk: { kind: 'text', index: 0, text: 'done' } },
  { at: 700, chunk: { kind: 'stop', stopReason: 'end_turn', usage: usage(84) } },
] as const
const TURN_USAGE = {
  input_tokens: 12, output_tokens: 777, cache_read_input_tokens: 99_000, cache_creation_input_tokens: 900, model: 'm',
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
const inMinutes = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString()
const LIMITS: SessionRateLimit[] = [
  { kind: 'five_hour', percentUsed: 3, resetsAt: inMinutes(2 * 60 + 13) },
  { kind: 'seven_day', percentUsed: 24, resetsAt: inMinutes((5 * 24 + 15) * 60) },
]

type World = {
  usd: number // the engine's cost ledger, in dollars
  stepCost: number // what the next model request adds to the ledger when it stops
  spawns: number
}

// The bottom of every chain: what the engine itself would answer. Its MCP list holds one of the app's own servers.
// With `isStoreReadOnly` the store answers reads and refuses every write.
const bottom = (on: On, clock: MockClock, store?: Record<string, unknown>, isStoreReadOnly = false): World => {
  const w: World = { usd: 10, stepCost: 0, spawns: 0 }
  if (isStoreReadOnly) {
    on('store.get', (_$, e) => ({ value: store?.[e.key] }))
    on('store.set', () => {
      throw new Error('the store cannot be written')
    })
  } else {
    mock.store(on, store)
  }
  on('session.start', () => ({ cwd: ROOT }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('agent.spawn', () => {
    w.spawns += 1

    return { model: 'claude-sonnet-5', agentId: `a${w.spawns}` }
  })
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
  on('tool.call', async () => {
    await clock.sleep(300)

    return { result: { stdout: 'ok' } as never, text: 'ok' }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('session.root', () => ({ value: ROOT }))
  on('session.usage', () => {
    const tool = (serverName: string) => ({ name: `mcp__${serverName}__t`, serverName, tokens: 1, isLoaded: true })
    const breakdown = {
      rawMaxTokens: 1_000_000,
      skills: { totalSkills: 52, includedSkills: 52, tokens: 1, skillFrontmatter: [] },
      mcpTools: [tool('codebase-memory'), tool('codebase-memory'), tool('issue-hub'), tool('ccd_session')],
    }

    return {
      value: { startedAt: 0, context: { window: 1_000_000, breakdown }, rateLimits: [], cost: { usd: w.usd } } as never,
    }
  })
  on('process.run', () => ({
    value: { exitCode: 0, stdout: 'master\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('agent.list', () => ({ value: [] as never }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.invalidate', () => ({ value: undefined }))

  return w
}

// Moves the mock clock on until the work settles: every wait in the bottom hooks is held until then.
const drive = async <T,>(clock: MockClock, work: Promise<T>): Promise<T> => {
  let isDone = false
  const tracked = work.finally(() => {
    isDone = true
  })
  for (let i = 0; i < 100 && !isDone; i += 1) {
    await clock.advance(100)
  }

  return tracked
}

// One model request through the hooks, main loop or subagent.
const runStep = async (
  $: Engine,
  clock: MockClock,
  input: { turnId: string; index: number; agentId?: string },
): Promise<void> => {
  const stream = $.turn.step({ model: 'claude-sonnet-5', messageCount: 1, ...input })
  const consuming = (async () => {
    let item = await stream.next()
    while (item.done !== true) item = await stream.next()
  })()
  await drive(clock, consuming)
  await clock.advance(10) // the cost reading of the request is taken a tick later
}

type Ending = { answer: string; isAborted: boolean; reason: 'answer' | 'error' | 'aborted' }
const DONE: Ending = { answer: 'ok', isAborted: false, reason: 'answer' }
const FAILED: Ending = { answer: '', isAborted: false, reason: 'error' }
const STOPPED: Ending = { answer: '', isAborted: true, reason: 'aborted' }
// The turn of a subagent ends.
const endAgent = ($: Engine, agentId: string, how: Ending) =>
  $.turn.complete({ durationMs: 5, turnId: 't1', agentId, ...how })

// A turn of one tool step that ends with the usage given.
async function oneStepTurn($: Engine, clock: MockClock, turnId: string, usage: Record<string, unknown>): Promise<void> {
  await $.turn.start({ text: 'go', turnId })
  await runStep($, clock, { turnId, index: 0 })
  await $.turn.complete({
    answer: '', durationMs: 1500, isAborted: false, turnId, reason: 'answer', usage: { ...usage, model: 'm' },
  } as never)
}

const measure = ($: Engine, tokens: number, rateLimits: SessionRateLimit[]) =>
  $.session.measure({
    context: { window: 1_000_000, tokens, percent: tokens / 10_000 },
    rateLimits,
    cost: { usd: 5.49 },
    changed: ['context', 'cost'],
  })

// A session with something in every block: a turn that ended, two subagents (one done, one running) and the log.
async function seed($: Engine, clock: MockClock, w: World): Promise<void> {
  await $.session.start(START)
  await clock.advance(1) // the background reads: window, skills, MCP servers, branch
  await $.turn.start({ text: 'fix the stock order qty', turnId: 't1' })
  w.stepCost = 0.0025
  await runStep($, clock, { turnId: 't1', index: 0 })
  await drive(clock, $.tool.call({ tool: 'Bash', command: 'ls -la' }))
  await runStep($, clock, { turnId: 't1', index: 1 })
  await $.turn.complete({
    answer: 'done', durationMs: 33_500, isAborted: false, turnId: 't1', reason: 'answer', usage: TURN_USAGE,
  })

  await $.agent.spawn(SPAWN)
  await $.agent.spawn({ ...SPAWN, description: 'Revert stockUnits', subagentType: 'feature-dev:code-reviewer' })
  w.stepCost = 0.02
  await runStep($, clock, { turnId: 't1', index: 1, agentId: 'a1' })
  w.stepCost = 0.03
  await runStep($, clock, { turnId: 't1', index: 1, agentId: 'a2' })
  await $.turn.complete({
    answer: 'found it', durationMs: 5000, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer',
  })
  // The last word on the readings: Total 5.49, so Session is 5.49 less the 0.05 the subagents cost.
  await measure($, 128_000, LIMITS)
}

const mountPane = ($: Engine, surface: Surface, props: RenderPropsOf['Pane'] = PANE_PROPS) =>
  $.ui.mount({ plugin: 'session-panel', surface, component: 'Pane', requestId: 'session-panel', props })
type Pane = Awaited<ReturnType<typeof mountPane>>

// The text is on the pane somewhere: in a Text, or in the label of a Button.
const has = async (ui: Pane, text: string | RegExp): Promise<boolean> => (await ui.find({ text })) !== undefined
const headers = async (ui: Pane): Promise<string[]> =>
  (await ui.findAll({ type: 'Button' })).map(button => String(button.props.label))

type Node = { type: string; props?: Record<string, unknown>; children?: unknown[] }
const textOf = (node: unknown): unknown => (node as Node | undefined)?.children?.[0]

// The dim summary beside each header, by section id: the header row holds the Button, then the summary Text.
const summaries = async (ui: Pane): Promise<Record<string, unknown>> => {
  const found: Record<string, unknown> = {}
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return
    const { children = [] } = node as Node
    const [button, summary] = children as Array<Node | undefined>
    const key = String(button?.type === 'Button' ? button.props?.key : '')
    if (key.startsWith('toggle:')) found[key.slice('toggle:'.length)] = textOf(summary)
    children.forEach(walk)
  }
  walk(await ui.drawn())

  return found
}

// The element table as plain data, to call renderPane without the engine: each constructor answers its tag, its props
// and its children, which is what the engine's own do.
const plain = (type: string) => (props: Record<string, unknown>): Node => {
  const { children, ...rest } = props
  const isNode = (child: unknown): boolean => typeof child === 'string' || (typeof child === 'object' && child !== null)
  const kept = [children].flat(Infinity).filter(isNode)

  return { type, props: rest, children: kept }
}
const PLAIN_ELEMENTS = { Box: plain('Box'), Text: plain('Text'), Button: plain('Button'), Svg: plain('Svg') } as never
const textsOf = (node: unknown): string[] =>
  typeof node === 'string' ? [node] : ((node as Node).children ?? []).flatMap(textsOf)

// The width of the cell around each status mark of the subagent rows.
const markCells = async (ui: Pane): Promise<unknown[]> => {
  const cells: unknown[] = []
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return
    const { type, props, children = [] } = node as Node
    if (type === 'Box' && /^[◐✓✗]$/.test(String(textOf((children as Node[])[0])))) cells.push(props?.width)
    children.forEach(walk)
  }
  walk(await ui.drawn())

  return cells
}

// The log rows as drawn: who, and how many cells wide the column of `who` is.
const logColumns = async (ui: Pane): Promise<Array<[who: unknown, cells: unknown]>> => {
  const rows: Array<[unknown, unknown]> = []
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return
    const { children = [] } = node as Node
    const [time, who] = children as Array<Node | undefined>
    const isTime = time?.type === 'Text' && /^\d\d:\d\d:\d\d$/.test(String(textOf(time)))
    if (isTime && who?.type === 'Box') rows.push([textOf((who.children as Node[])[0]), who.props?.width])
    children.forEach(walk)
  }
  walk(await ui.drawn())

  return rows
}

test('the pane draws the blocks of the mockup on desktop and on terminal', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  await seed($, clock, bottom(on, clock))

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    // The brief's marks.
    for (const text of ['Context', '12.8%', 'Turn stats', '~61 tok/s', '$0.02']) {
      expect(await has(ui, text), `${surface}: ${text}`).toBe(true)
    }
    // Top block: Total, the split, the project and the context figures.
    for (const text of [
      '$5.49', 'Session $5.44 · Subagents $0.050', '📁 online_shop', '🌿 master', '128k / 1M',
    ]) {
      expect(await has(ui, text), `${surface}: ${text}`).toBe(true)
    }
    // The sections come in the mockup's order, all unfolded, each with its summary beside it.
    expect(await headers(ui)).toEqual([
      '▾ Usage', '▾ Turn stats', '▾ Subagents', '▾ MCP', '▾ Context sources', '▾ Log',
    ])
    expect((await ui.findAll({ type: 'Button' })).map(button => button.key)).toEqual([
      'toggle:usage', 'toggle:turn', 'toggle:agents', 'toggle:mcp', 'toggle:sources', 'toggle:log',
    ])
    expect((await ui.findAll({ type: 'Button' })).every(button => button.props.plain === true), surface).toBe(true)
    expect(await summaries(ui), surface).toStrictEqual({
      usage: '5-hour 3%', turn: '~168 tok/s', agents: '1/2', mcp: '2', sources: '52 skills · 2 MCP', log: undefined,
    })
    // Usage: both windows, with their countdowns.
    for (const text of ['5-hour', 'Weekly', '3%', '24%', '↻ 2h 13m', '↻ 5d 15h']) {
      expect(await has(ui, text), `${surface}: ${text}`).toBe(true)
    }
    // Turn stats: every row of a turn that took two steps, in the order of the mockup.
    for (const text of [
      'Response', '~168 tok/s', 'Whole turn', 'Elapsed', '33.5s', 'Model time', '1.7s', 'Tool time', '0.3s',
      'Average TTFT', 'Steps', 'Tokens', '12 ↑ · 777 ↓', 'Cache', '99%', 'Cost', '$0.005',
    ]) {
      expect(await ui.find({ type: 'Text', text }), `${surface}: ${text}`).toBeDefined()
    }
    expect((await ui.find({ type: 'Text', text: '99%' }))?.props.color, `${surface} cache`).toBe('success')
    // Subagents: the running one first, then the finished one; the type loses its plugin prefix.
    expect((await ui.findAll({ type: 'Text', text: /^@/ })).map(el => el.text)).toEqual([
      '@code-reviewer', '@engineer',
    ])
    expect(
      (await ui.findAll({ type: 'Text', text: /^(Revert stockUnits|Fix cart total qty)$/ })).map(el => el.text),
    ).toEqual(['Revert stockUnits', 'Fix cart total qty'])
    for (const text of ['$0.030', '$0.020']) {
      expect(await has(ui, text), `${surface}: ${text}`).toBe(true)
    }
    // MCP and Context sources: every server is a green `● name`; the app's own server is neither listed nor counted.
    for (const name of ['● codebase-memory', '● issue-hub']) {
      expect((await ui.find({ type: 'Text', text: name }))?.props.color, `${surface}: ${name}`).toBe('success')
    }
    expect(await has(ui, 'ccd_'), `${surface}: ccd_`).toBe(false)
    for (const text of ['Skills', /^52$/, 'MCP servers']) {
      expect(await ui.find({ type: 'Text', text }), `${surface}: ${text}`).toBeDefined()
    }
    // Log: newest first, the person's prompt last.
    const log = (await ui.findAll({ type: 'Text' })).map(el => el.text)
    const prompt = log.indexOf('fix the stock order qty')
    expect(prompt).toBeGreaterThan(-1)
    expect(log.indexOf('Bash ls -la ✓ 0.3s')).toBeGreaterThan(-1)
    expect(log.indexOf('Bash ls -la ✓ 0.3s')).toBeLessThan(prompt)
    expect(log.indexOf('done 5.0s · $0.020 — found it')).toBeLessThan(log.indexOf('Bash ls -la ✓ 0.3s'))
    await ui.unmount()
  }
})

test('a header folds its section, the store keeps the map, a second press unfolds it', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  await seed($, clock, bottom(on, clock))
  const stored = async (): Promise<unknown> => {
    const ran = await $.command.run({ ...RUN, command: 'read-store' })

    return JSON.parse(ran.text ?? 'null')
  }
  const kept: Record<string, boolean> = {}
  // What the body of each section shows that its header does not.
  const bodies: [id: string, title: string, text: string | RegExp][] = [
    ['usage', 'Usage', 'Weekly'],
    ['turn', 'Turn stats', 'Whole turn'],
    ['agents', 'Subagents', /^Revert stockUnits$/],
    ['mcp', 'MCP', '● codebase-memory'],
    ['sources', 'Context sources', 'Skills'],
    ['log', 'Log', 'fix the stock order qty'],
  ]

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    for (const [id, title, text] of bodies) {
      const label = async (): Promise<unknown> => (await ui.find({ key: `toggle:${id}` }))?.props.label
      expect(await has(ui, text), `${surface} ${id} open`).toBe(true)
      expect(await label()).toBe(`▾ ${title}`)

      await ui.press({ key: `toggle:${id}` })
      expect(await has(ui, text), `${surface} ${id} folded`).toBe(false)
      expect(await label()).toBe(`▸ ${title}`)
      kept[id] = true
      expect(await stored()).toEqual(kept)

      await ui.press({ key: `toggle:${id}` })
      expect(await has(ui, text), `${surface} ${id} unfolded`).toBe(true)
      expect(await label()).toBe(`▾ ${title}`)
      kept[id] = false
      expect(await stored()).toEqual(kept)
    }
    await ui.unmount()
  }
})

test('the folded sections of the last session stay folded: the map comes from the store', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  await seed($, clock, bottom(on, clock, { collapsed: { log: true, turn: true } }))

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await headers(ui)).toEqual([
      '▾ Usage', '▸ Turn stats', '▾ Subagents', '▾ MCP', '▾ Context sources', '▸ Log',
    ])
    expect(await has(ui, 'Whole turn')).toBe(false)
    expect(await has(ui, 'fix the stock order qty')).toBe(false)
    // A folded section keeps its summary.
    expect(await ui.find({ type: 'Text', text: '~168 tok/s' })).toBeDefined()
    expect(await has(ui, 'Weekly')).toBe(true)
    await ui.unmount()
  }
})

test('with no rate limits (a third-party provider) there is no Usage section', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  await seed($, clock, bottom(on, clock))

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ key: 'toggle:usage' }), `${surface} with limits`).toBeDefined()
    await measure($, 128_000, [])
    expect(await ui.find({ key: 'toggle:usage' }), `${surface} without limits`).toBeUndefined()
    expect(await has(ui, 'Usage')).toBe(false)
    expect(await has(ui, '5-hour')).toBe(false)
    // The rest of the pane carries on.
    expect(await headers(ui)).toEqual(['▾ Turn stats', '▾ Subagents', '▾ MCP', '▾ Context sources', '▾ Log'])
    // Without a five-hour window the summary is the first window there is, and a window with no reset has no countdown.
    await measure($, 128_000, [{ kind: 'seven_day', percentUsed: 24 }])
    expect((await summaries(ui)).usage, `${surface} one window`).toBe('Weekly 24%')
    expect(await has(ui, '↻'), `${surface} no reset`).toBe(false)
    await measure($, 128_000, LIMITS)
    await ui.unmount()
  }
})

test('a pane with nothing to show draws the title, an empty Context and the turn placeholder', async ($, on) => {
  bottom(on, mock.clock(on, { now: NOW }))

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ type: 'Text', text: 'Session' }))?.props.bold).toBe(true)
    expect(await ui.find({ type: 'Text', text: 'Context' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^—$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'No completed turn yet' })).toBeDefined()
    // No data, so no Total, no project line, no meter, and every section but the turn is left out.
    expect(await headers(ui)).toEqual(['▾ Turn stats'])
    expect(await has(ui, '$')).toBe(false)
    expect(await has(ui, '📁')).toBe(false)
    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    expect(await has(ui, /[▰▱]/)).toBe(false)
    await ui.unmount()
  }
})

test('a /clear empties the pane again: the context reads — until the next response', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  await seed($, clock, bottom(on, clock))
  const ui = await mountPane($, 'desktop')
  expect(await has(ui, '12.8%')).toBe(true)

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })

  expect(await has(ui, '12.8%')).toBe(false)
  expect(await ui.find({ type: 'Text', text: /^—$/ })).toBeDefined()
  // The limits are the session's still: their two meters stay, the context has none.
  expect((await ui.findAll({ type: 'Svg' })).map(el => el.props.alt)).toEqual(['5-hour 3%', 'Weekly 24%'])
  expect(await ui.find({ type: 'Text', text: 'No completed turn yet' })).toBeDefined()
  expect(await headers(ui)).toEqual(['▾ Usage', '▾ Turn stats', '▾ MCP', '▾ Context sources'])
  await ui.unmount()
})

test('the meter is an Svg on desktop and ▰▱ text on terminal', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  await seed($, clock, bottom(on, clock))

  const desktop = await mountPane($, 'desktop')
  const svgs = await desktop.findAll({ type: 'Svg' })
  expect(svgs.map(el => el.props.alt)).toEqual(['Context 12.8%', '5-hour 3%', 'Weekly 24%'])
  expect(svgs.map(el => [el.props.width, el.props.height])).toEqual([[180, 8], [180, 8], [180, 8]])
  // 12.8% of 180 px, blue.
  expect(svgs[0]?.props.source).toBe(meterSvg(12.8, 180))
  expect(String(svgs[0]?.props.source)).toContain('<rect width="23" height="8" rx="4" fill="#2f7de1"/>')
  expect(await has(desktop, /[▰▱]/)).toBe(false)
  await desktop.unmount()

  // The terminal's table holds an Svg too, a stub that draws nothing: the meter has to be text there.
  const terminal = await mountPane($, 'terminal')
  expect(await terminal.find({ type: 'Svg' })).toBeUndefined()
  const filled = await terminal.findAll({ type: 'Text', text: /^▰+$/ })
  const empty = await terminal.findAll({ type: 'Text', text: /^▱+$/ })
  // Ten cells each: Context 12.8% fills one, 5-hour 3% none, Weekly 24% two.
  expect(filled.map(el => el.text)).toEqual(['▰', '▰▰'])
  expect(filled.map(el => el.props.color)).toEqual(['#2f7de1', '#2f7de1'])
  expect(empty.map(el => el.text)).toEqual(['▱'.repeat(9), '▱'.repeat(10), '▱'.repeat(8)])
  expect(empty.every(el => el.props.dimColor === true)).toBe(true)
  await terminal.unmount()
})

test('the meter takes the width of the body: 12.5 px a column less 210, from 40 to 180', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  await seed($, clock, bottom(on, clock))

  expect([0, 20, 24, 25, 30, 31, 32, 40, 80].map(meterWidth)).toEqual([40, 40, 90, 103, 165, 178, 180, 180, 180])
  const ui = await mountPane($, 'desktop')
  for (const [bodyColumns, width] of [[40, 180], [25, 103], [20, 40]] as const) {
    await ui.redraw({ ...PANE_PROPS, bodyColumns })
    expect((await ui.findAll({ type: 'Svg' })).map(el => el.props.width), `${bodyColumns} columns`).toEqual([
      width, width, width,
    ])
  }
  await ui.unmount()
})

test('the percent and the meter turn amber from 80% and red from 95%', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  bottom(on, clock)
  await $.session.start(START)
  await clock.advance(1)
  const limits: SessionRateLimit[] = [
    { kind: 'five_hour', percentUsed: 79.9 },
    { kind: 'seven_day', percentUsed: 80 },
    { kind: 'spend_limit', percentUsed: 120 },
  ]

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    for (const [tokens, text, color, fill] of [
      [128_000, '12.8%', undefined, '#2f7de1'],
      [850_000, '85.0%', 'warning', '#e0a030'],
      [950_000, '95.0%', 'error', '#e5484d'],
    ] as const) {
      await measure($, tokens, limits)
      expect((await ui.find({ type: 'Text', text }))?.props.color, `${surface} ${text}`).toBe(color)
      if (surface === 'desktop') {
        expect(String((await ui.find({ type: 'Svg' }))?.props.source), `${surface} ${text}`).toContain(
          `fill="${fill}"/></svg>`,
        )
      } else {
        expect((await ui.find({ type: 'Text', text: /^▰/ }))?.props.color, `${surface} ${text}`).toBe(fill)
      }
    }
    // The limits: 79.9% reads 80% but stays blue, 80% is amber, a spend limit past 100% is full and red.
    expect((await ui.findAll({ type: 'Text', text: /^(80|120)%$/ })).map(el => [el.text, el.props.color])).toEqual([
      ['80%', undefined], ['80%', 'warning'], ['120%', 'error'],
    ])
    expect(await has(ui, /^Spend$/)).toBe(true)
    expect(await has(ui, '↻')).toBe(false) // no reset time was given: no countdown
    if (surface === 'desktop') {
      const [, ...bars] = (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.source))
      expect(bars.map(source => source.split('<rect ')[2])).toEqual([
        'width="144" height="8" rx="4" fill="#2f7de1"/></svg>',
        'width="144" height="8" rx="4" fill="#e0a030"/></svg>',
        'width="180" height="8" rx="4" fill="#e5484d"/></svg>',
      ])
    }
    await ui.unmount()
  }
})

test('a turn of one tool step hides Response and Steps; the cache is green from 50%', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  bottom(on, clock)
  await $.session.start(START)
  await clock.advance(1)
  // 100 of 1000 input tokens came from the cache.
  await oneStepTurn($, clock, 't1', {
    input_tokens: 900, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 0,
  })

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await has(ui, 'Response'), surface).toBe(false)
    expect(await has(ui, 'Steps'), surface).toBe(false)
    // No subagents ran: Total only, no split line.
    expect(await has(ui, 'Subagents'), surface).toBe(false)
    expect(await has(ui, /^Session \$/), surface).toBe(false)
    // The summary falls back to the whole turn: ~20 tok/s is in the header and in its row.
    expect(await ui.findAll({ type: 'Text', text: '~20 tok/s' }), surface).toHaveLength(2)
    expect(await ui.find({ type: 'Text', text: '900 ↑ · 20 ↓' }), surface).toBeDefined()
    // The log has the person's prompt only, so its column is as wide as `you`.
    expect(await logColumns(ui), surface).toEqual([['you', 3]])
    await ui.unmount()
  }

  // 49, 50, 100 and 0 of every 100 input tokens from the cache: green from 50.
  for (const [turn, read, text, color] of [
    ['t2', 49, '49%', undefined],
    ['t3', 50, '50%', 'success'],
    ['t4', 100, '100%', 'success'],
    ['t5', 0, '0%', undefined],
  ] as const) {
    await oneStepTurn($, clock, turn, {
      input_tokens: 100 - read, output_tokens: 20, cache_read_input_tokens: read, cache_creation_input_tokens: 0,
    })
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect((await ui.find({ type: 'Text', text: new RegExp(`^${text}$`) }))?.props.color, `${surface} ${text}`).toBe(
        color,
      )
      await ui.unmount()
    }
  }
})

test('the subagent list shows 8 rows, the running ones first and the newest first, and counts the rest', SLOW,
  async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    bottom(on, clock)
    await $.session.start(START)
    for (let i = 0; i < 10; i += 1) {
      await $.agent.spawn({ ...SPAWN, description: `task ${i}` })
      await clock.advance(1000)
    }
    // The newest one has finished: it goes below the running ones, though it started last.
    await endAgent($, 'a10', DONE)
    await measure($, 128_000, []) // the context has a reading, so its dash is not counted below

    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      const tasks = (await ui.findAll({ type: 'Text', text: /^task \d$/ })).map(el => el.text)
      expect(tasks, surface).toEqual(['task 8', 'task 7', 'task 6', 'task 5', 'task 4', 'task 3', 'task 2', 'task 1'])
      expect(await ui.find({ type: 'Text', text: '+2 more' }), surface).toBeDefined()
      expect((await summaries(ui)).agents, surface).toBe('9/10')
      // No request has been charged to any of them: a dash where the cost goes, on each of the 8 rows.
      expect(await ui.findAll({ type: 'Text', text: /^—$/ }), surface).toHaveLength(8)
      await ui.unmount()
    }
  })

test('a subagent that did not finish well shows ✗, a stopped one dimmed, a running one ◐ in blue', SLOW,
  async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    bottom(on, clock)
    await $.session.start(START)
    for (let i = 0; i < 4; i += 1) await $.agent.spawn({ ...SPAWN, description: `task ${i}` })
    await endAgent($, 'a1', DONE)
    await endAgent($, 'a2', FAILED)
    await endAgent($, 'a3', STOPPED)

    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      const marks = await ui.findAll({ type: 'Text', text: /^[◐✓✗]$/ })
      const icons = marks.map(el => [el.text, el.props.color, el.props.dimColor])
      // Running first (a4), then the newest start first; the four were spawned in one tick, so by order of spawn.
      expect(icons, surface).toEqual([
        ['◐', '#2f7de1', undefined],
        ['✓', 'success', undefined],
        ['✗', 'error', undefined],
        ['✗', undefined, true],
      ])
      // Each mark has a cell of its own, so the descriptions start at the same place whatever the glyph.
      expect(await markCells(ui), surface).toEqual([1, 1, 1, 1])
      await ui.unmount()
    }
  })

test('the log shows 15 lines, newest first, an error in red, and a long text cut to one line', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  bottom(on, clock)
  await $.session.start(START)
  await $.agent.spawn(SPAWN)
  for (let i = 0; i < 20; i += 1) await $.turn.start({ text: `prompt ${i}`, turnId: `t${i}` })
  await endAgent($, 'a1', FAILED)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const texts = (await ui.findAll({ type: 'Text' })).map(el => el.text)
    // 'failed' (the subagent), then prompt 19 down to prompt 6: 15 lines in all.
    expect(texts.filter(text => /^(prompt \d+|failed)$/.test(text)), surface).toEqual([
      'failed', ...Array.from({ length: 14 }, (_, i) => `prompt ${19 - i}`),
    ])
    // The `who` of the failed line is red, the others are plain.
    const whos = await ui.findAll({ type: 'Text', text: /^(engineer|you)$/ })
    expect(whos.map(el => [el.text, el.props.color])).toEqual([
      ['engineer', 'error'], ...Array.from({ length: 14 }, () => ['you', undefined]),
    ])
    expect((await ui.findAll({ type: 'Text', text: /^\d\d:\d\d:\d\d$/ })).length).toBe(15)
    // The column of `who` is as wide as the longest of the 15 (`engineer`), so the texts line up.
    expect((await logColumns(ui)).map(([, cells]) => cells), surface).toEqual(Array(15).fill(8))
    expect((await ui.find({ type: 'Text', text: 'prompt 19' }))?.props.wrap).toBe('truncate')
    await ui.unmount()
  }
})

test('a window of 0 draws a dash for the context, never NaN or Infinity', SLOW, async ($, on) => {
  bottom(on, mock.clock(on, { now: NOW }))
  // Before any breakdown the model's window is the only one, and here it reads 0.
  await $.session.measure({ context: { window: 0, tokens: 100, percent: 0 }, rateLimits: [], changed: ['context'] })

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /^—$/ }), surface).toBeDefined()
    expect(await has(ui, /NaN|Infinity|null|undefined|%/), surface).toBe(false)
    expect(await ui.find({ type: 'Svg' }), surface).toBeUndefined()
    await ui.unmount()
  }
})

test('the view reads a percent that is not a finite number as no reading', () => {
  const empty: PaneData = {
    usage: { rateLimits: [] },
    project: { name: '', branch: null },
    mcp: null,
    lastTurn: null,
    agents: {},
    log: [],
    collapsed: {},
    now: NOW,
    surface: 'desktop',
  }
  const draw = (contextPct: number | undefined): Node =>
    renderPane(
      PLAIN_ELEMENTS,
      { ...empty, usage: { rateLimits: [], contextTokens: 100, contextWindow: 0, contextPct } },
      { bodyColumns: 40 },
      { onToggle: () => undefined },
    ) as unknown as Node

  // A finite percent is drawn, so the drawing here is not empty by mistake.
  expect(textsOf(draw(12.8))).toContain('12.8%')
  // NaN and the infinities, and the null that a build before the guard may have left behind in the state.
  for (const contextPct of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null as never]) {
    const tree = draw(contextPct)
    expect(textsOf(tree), String(contextPct)).toEqual(['Session', 'Context', '—', 'No completed turn yet'])
    expect(JSON.stringify(tree), String(contextPct)).not.toContain('"Svg"')
  }
})

test('a press folds the section and does not fail when the store cannot be written', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  await seed($, clock, bottom(on, clock, undefined, true))

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const label = async (): Promise<unknown> => (await ui.find({ key: 'toggle:log' }))?.props.label
    expect(await has(ui, 'fix the stock order qty'), `${surface} open`).toBe(true)

    // The write to the store is refused, the press is still a press: the section folds all the same.
    await ui.press({ key: 'toggle:log' })
    expect(await has(ui, 'fix the stock order qty'), `${surface} folded`).toBe(false)
    expect(await label()).toBe('▸ Log')

    await ui.press({ key: 'toggle:log' })
    expect(await has(ui, 'fix the stock order qty'), `${surface} unfolded`).toBe(true)
    expect(await label()).toBe('▾ Log')
    await ui.unmount()
  }
})

test('meterSvg: a rounded track, a rounded fill, the colour by threshold', () => {
  const svg = meterSvg(85, 100)
  expect(svg).toContain('#e0a030')
  expect(svg).toContain('width="85"')
  expect(svg).toStartWith('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="8"')
  expect(svg).toContain('<rect width="100" height="8" rx="4" fill="#808080" fill-opacity="0.3"/>')
  expect(svg).toContain('<rect width="85" height="8" rx="4" fill="#e0a030"/>')

  const fillOf = (pct: number, width = 100): string => meterSvg(pct, width).split('<rect ')[2] ?? ''
  expect(fillOf(0)).toBe('width="0" height="8" rx="4" fill="#2f7de1"/></svg>')
  expect(fillOf(79.9)).toContain('fill="#2f7de1"')
  expect(fillOf(80)).toContain('fill="#e0a030"')
  expect(fillOf(94.9)).toContain('fill="#e0a030"')
  expect(fillOf(95)).toContain('fill="#e5484d"')
  expect(fillOf(12.8, 180)).toContain('width="23"')
  // Past the ends the fill stays on the track; no reading draws no fill rather than NaN.
  expect(fillOf(150)).toContain('width="100"')
  expect(fillOf(-5)).toContain('width="0"')
  expect(fillOf(Number.NaN)).toContain('width="0"')
})
