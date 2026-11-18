import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Plugin } from 'claude-code/testing'
import type { On, RenderPropsOf, RenderSurface, SessionRateLimit } from 'claude-code'

import { chipRows, isSectionFolded, limitMeterWidth, meterSvg, renderPane, spanLine } from './view'
import type { PaneData } from './view'
import { cutCells } from './cells'
import { restoreFromMessages } from './restore'
import { emptyStationsState, STATION_HUES, STATION_ORDER, zeroStationMs } from './stations'
import type { ToolStationId } from './stations'
import { addStep, addTool, fmtDuration } from './stats'
import type { AgentRow, AgentStatus, LogEntry, TaskRow, TaskStatus, TurnAcc, TurnStats } from './stats'

// The state of the pane is seeded the way register.test.ts does it: the events of a session run through the real
// hooks, over a bottom that answers as the engine would, and the pane is mounted on a surface to see what it draws.
// The layout rules are drawn from the tree alone (the kit has no layout engine), so what is pinned is the structure the
// spec asks for: which cell is fixed, which gives way, where a text is cut, what lines up.
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
// output tokens, so the whole turn runs at ~61 tok/s. The answer is 84 tokens over its request of 0.7 s, ~120 tok/s:
// its window starts when the request is sent, not at its first chunk (0.2 s in).
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

// The bottom of every chain: what the engine itself would answer. Its MCP list holds the app's own servers:
// `ccd_session` and the three that the desktop adds by name.
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
      mcpTools: [
        'codebase-memory', 'codebase-memory', 'issue-hub',
        'ccd_session', 'Claude_Browser', 'scheduled-tasks', 'terminal',
      ].map(tool),
    }

    return {
      value: { startedAt: 0, context: { window: 1_000_000, breakdown }, rateLimits: [], cost: { usd: w.usd } } as never,
    }
  })
  // The branch is `master`, and one file is modified: `+3 / −1`.
  on('process.run', (_$, e) => {
    const stdouts: Record<string, string> = { branch: 'master\n', status: ' M a.ts\0', diff: '3\t1\ta.ts\n' }
    // The command is the first word that is no option and no value of `-c`.
    const command = e.argv.slice(1).find((arg, i, all) => !arg.startsWith('-') && all[i - 1] !== '-c') ?? ''
    const stdout = stdouts[command] ?? ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
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

// ---- Reading a drawn tree ----

type Node = { type: string; props?: Record<string, unknown>; children?: unknown[] }
type Placed = { node: Node; parent: Node | undefined }
const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null
const childrenOf = (node: Node | undefined): Node[] => (node?.children ?? []).filter(isNode)
// Every string under the node, in document order.
const textsOf = (node: unknown): string[] =>
  typeof node === 'string' ? [node] : isNode(node) ? (node.children ?? []).flatMap(textsOf) : []
// Every element of the tree in document order, each with the element that holds it.
const flat = (tree: unknown, parent?: Node): Placed[] =>
  isNode(tree) ? [{ node: tree, parent }, ...(tree.children ?? []).flatMap(child => flat(child, tree))] : []

// The text is on the pane somewhere: in a Text, or in the label of a Button.
const has = async (ui: Pane, text: string | RegExp): Promise<boolean> => (await ui.find({ text })) !== undefined
const texts = async (ui: Pane): Promise<string[]> => (await ui.findAll({ type: 'Text' })).map(el => el.text)

// The header rows: the Box that holds a fold Button, read into its parts. A row is [icon slot (desktop only)], the
// title Box, the Button, the summary Box.
type Header = { id: string; section: Node | undefined; cells: Node[]; label: string; title: string; summary?: string }
const headerRows = (tree: unknown): Header[] =>
  flat(tree).flatMap(({ node, parent }) => {
    const cells = childrenOf(node)
    const at = cells.findIndex(cell => cell.type === 'Button' && String(cell.props?.key).startsWith('toggle:'))
    const button = cells[at]
    if (node.type !== 'Box' || button === undefined) return []

    return [{
      id: String(button.props?.key).slice('toggle:'.length),
      section: parent,
      cells,
      label: String(button.props?.label),
      title: textsOf(cells[at - 1])[0] ?? '',
      summary: textsOf(cells[at + 1])[0],
    }]
  })

// Each header as the person reads it: the chevron and the title, in the order the sections are drawn.
const headers = async (ui: Pane): Promise<string[]> =>
  headerRows(await ui.drawn()).map(header => `${header.label} ${header.title}`)

// The dim summary beside each header, by section id.
const summaries = async (ui: Pane): Promise<Record<string, unknown>> =>
  Object.fromEntries(headerRows(await ui.drawn()).map(header => [header.id, header.summary]))

// The meters of the pane: the Svg elements that say a percent. The icons and the rules carry the label of their row.
const meters = async (ui: Pane) => (await ui.findAll({ type: 'Svg' })).filter(el => /%$/.test(String(el.props.alt)))
// The Session band's image: the one whose alt starts with the context.
const bandImage = async (ui: Pane) =>
  (await ui.findAll({ type: 'Svg' })).find(el => /^Context (—|\d)/.test(String(el.props.alt)))
// The band's alt for a pane with no reading and no call: the core reads —, and every station 0.
const EMPTY_BAND_ALT = 'Context —. Model 0; Files 0; Shell 0; Web 0; Agents 0; MCP 0; Skills 0; You 0.'

// The log rows as drawn: who, how many cells wide the columns of the time and of `who` are, how many cells the row
// has, and its outcome cell, the fourth, when there is one. A time cell is a column with a width: the `—` that leads
// the terminal band's core line sits in a cell with none.
const isTimeCell = (cell: Node | undefined): boolean =>
  cell?.type === 'Box' && hasWidth(cell) && childrenOf(cell)[0]?.type === 'Text' &&
  /^(\d\d:\d\d:\d\d|—)$/.test(textsOf(cell)[0] ?? '')
type LogColumns = {
  who: string; timeCells: unknown; whoCells: unknown; cells: number; outcomeCell: Node | undefined
}
const logColumns = (tree: unknown): LogColumns[] =>
  flat(tree).flatMap(({ node }) => {
    const [time, who, text, outcome] = childrenOf(node)
    if (node.type !== 'Box' || !isTimeCell(time) || who === undefined || text === undefined) return []

    return [{
      who: textsOf(who)[0] ?? '', timeCells: time?.props?.width, whoCells: who.props?.width,
      cells: childrenOf(node).length, outcomeCell: outcome,
    }]
  })
// The log rows as drawn: the Boxes whose first cell is a time.
const logRows = (tree: unknown): Node[] =>
  flat(tree).map(({ node }) => node).filter(node => node.type === 'Box' && isTimeCell(childrenOf(node)[0]))

// What a cell of a log row is, from its props: the time (a clock), the text (the one that grows), the outcome (the
// one that puts its text at the right edge), and else `who`. The cells of a row, in order, are its layout.
const logRoles = (row: Node): string[] =>
  childrenOf(row).map(cell => {
    if (cell.props?.flexGrow === 1) return 'text'
    if (cell.props?.justifyContent === 'flex-end') return 'outcome'

    return isTimeCell(cell) ? 'time' : 'who'
  })
// The text of a log row, in whichever layout the row is: the cell that grows.
const rowText = (row: Node): string => textsOf(childrenOf(row)[logRoles(row).indexOf('text')])[0] ?? ''
// The Boxes of the pane that hold log rows, in order: a head and a tail, or the one Box of a body of unknown height.
const logBoxes = (tree: Node): Node[] => childrenOf(tree).filter(child => logRows(child).length > 0)
// The `+N more` line of the Log: the child of the pane that reads so (Activity's own is inside its section), and
// the number it counts; undefined where the Log has no such line.
const MORE_LINE = /^\+(\d+) more$/
const logMoreLine = (tree: Node): Node | undefined =>
  childrenOf(tree).find(child => MORE_LINE.test(textsOf(child)[0] ?? ''))
const moreOf = (tree: Node): number | undefined => {
  const match = MORE_LINE.exec(textsOf(logMoreLine(tree))[0] ?? '')

  return match === null ? undefined : Number(match[1])
}
// How a Text is drawn: its colour, whether it is dim, and how it is cut.
const styleOf = (el: Node): unknown[] => [el.props?.color, el.props?.dimColor, el.props?.wrap]

// ---- Drawing without the engine ----

// The element table as plain data, to call renderPane without the engine: each constructor answers its tag, its props
// and its children, which is what the engine's own do. The table has an Svg, as the terminal's has (a stub there).
const plain = (type: string) => (props: Record<string, unknown>): Node => {
  const { children, ...rest } = props
  const isKept = (child: unknown): boolean => typeof child === 'string' || (typeof child === 'object' && child !== null)
  const kept = [children].flat(Infinity).filter(isKept)

  return { type, props: rest, children: kept }
}
const PLAIN_ELEMENTS = { Box: plain('Box'), Text: plain('Text'), Button: plain('Button'), Svg: plain('Svg') } as never

// The body is `bodyColumns` across and `bodyRows` down: the fixture's 20 rows unless a test says otherwise.
const draw = (data: PaneData, bodyColumns = 45, bodyRows = PANE_PROPS.scroll.bodyRows): Node =>
  renderPane(
    PLAIN_ELEMENTS, data, { bodyColumns, scroll: { bodyRows } }, { onToggle: () => undefined },
  ) as unknown as Node
const onSurface = (data: PaneData, surface: RenderSurface): PaneData => ({ ...data, surface })

const EMPTY: PaneData = {
  usage: { rateLimits: [] },
  project: { name: '', branch: null, changes: null },
  mcp: null,
  turn: null,
  lastTurn: null,
  agents: {},
  tasks: {},
  log: [],
  logCount: 0,
  collapsed: {},
  stations: emptyStationsState(),
  inFlight: {},
  mainModel: null,
  compactions: 0,
  mainTurns: [],
  now: NOW,
  surface: 'desktop',
  motion: 'full',
}

const agent = (n: number, status: AgentStatus, patch: Partial<AgentRow> = {}): AgentRow => ({
  id: `a${n}`, description: `task ${n}`, type: 'feature-dev:code-reviewer', model: null, status, startedAt: n,
  endedAt: null, costUsd: 2.5, ...patch,
})
// A background task: one that runs has run for 90 s at NOW, one that has ended ran 5 s. `n` tells the tasks apart: the
// id `bn`, the description `job n` and the start, which is `n` ms before the 90 s, so that the higher n is the older
// task. `patch` gives the fields a task has besides.
const task = (n: number, status: TaskStatus, patch: Partial<TaskRow> = {}): TaskRow => {
  const isRunning = status === 'running'

  return {
    id: `b${n}`, kind: 'shell', description: `job ${n}`, status, startedAt: NOW - 90_000 - n,
    endedAt: isRunning ? null : NOW - 1000, durationMs: isRunning ? null : 5000, ...patch,
  }
}
const AGENTS = [
  agent(1, 'running', { description: 'Map the order flow in checkout/stock.py and every test that covers it' }),
  agent(2, 'running', { costUsd: null, type: 'claude-mods:minimal-change-engineer' }),
  agent(3, 'failed'),
  agent(4, 'stopped'),
  ...[5, 6, 7, 8, 9, 10].map(n => agent(n, 'done')),
]
const PROJECT = 'a_project_folder_with_a_long_name'
const BRANCH = 'feature/a-branch-with-a-long-name'
const CHANGES = { files: 12, lines: { added: 1204, removed: 387 } }
const MINUS = '\u2212' // the minus sign of the lines removed, not the hyphen
const SEP = '\u00a0/\u00a0' // the slash between the lines: no-break spaces, which the desktop does not drop
const LONG_TEXT = `Edit plugins/session-panel/hooks/view.tsx ${'and more '.repeat(10).trimEnd()}`
// The outcomes of the lines, in turn: a short one, a long one, none, and a word.
const OUTCOMES = ['✓ 0.1s', '✗ 1m 12s', undefined, 'denied']
const LOG: LogEntry[] = Array.from({ length: 16 }, (_, i): LogEntry => {
  const outcome = OUTCOMES[i % OUTCOMES.length]

  return {
    at: NOW - i * 1000, who: i === 0 ? 'minimal-change' : 'you', text: LONG_TEXT, kind: i === 1 ? 'error' : 'ok',
    ...(outcome === undefined ? {} : { outcome }),
  }
})
// `count` log lines, the newest first, each with a text of its own (`line 1`, `line 2`, ...) to tell its row by.
// `patch` gives the fields a line has besides, by its place: the newest is 0.
const logLines = (count: number, patch: (i: number) => Partial<LogEntry> = () => ({})): LogEntry[] =>
  Array.from({ length: count }, (_, i): LogEntry => (
    { at: NOW - i * 1000, who: 'you', text: `line ${i + 1}`, kind: 'info', ...patch(i) }
  ))
// The texts of the lines from the `from`th to the `to`th.
const named = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`)
// A pane with something in every block, and things too long for any pane: names, texts, a ninth agent.
const FULL: PaneData = {
  usage: {
    costUsd: 148.59,
    contextTokens: 529_000,
    contextWindow: 600_000,
    contextPct: 88.2,
    skills: 77,
    rateLimits: [
      { kind: 'five_hour', percentUsed: 3, resetsAt: NOW + 133 * 60_000 },
      { kind: 'seven_day', percentUsed: 84, resetsAt: NOW + (5 * 24 + 15) * 3_600_000 },
      { kind: 'spend_limit', percentUsed: 120 },
      { kind: 'some_new_window', percentUsed: 5 },
    ],
  },
  project: { name: PROJECT, branch: BRANCH, changes: CHANGES },
  mcp: {
    servers: [
      { name: 'Claude_Browser' },
      { name: 'a-server-whose-name-is-wider-than-any-pane-there-is-or-will-ever-be' },
      { name: 'issue-hub' },
    ],
  },
  turn: null,
  lastTurn: {
    elapsedMs: 78_000, modelMs: 66_000, toolMs: 11_400, steps: 5, ttftMs: 4900, wholeTurnRate: 72, responseRate: 62,
    tokensIn: 845, tokensOut: 4700, cachePct: 80, costUsd: 3.21, ribbon: null,
  },
  agents: Object.fromEntries(AGENTS.map(row => [row.id, row])),
  tasks: {},
  log: LOG,
  logCount: 137, // every event of the session: many more than the lines the log keeps
  collapsed: {},
  stations: emptyStationsState(),
  inFlight: {},
  mainModel: null,
  compactions: 0,
  mainTurns: [],
  now: NOW,
  surface: 'desktop',
  motion: 'full',
}
// The sections in the order they are drawn, by id and by title.
const SECTIONS = ['usage', 'turn', 'activity', 'mcp', 'sources', 'log'] as const
const TITLES = ['Usage', 'Turn stats', 'Activity', 'MCP', 'Context sources', 'Log']

// The two kinds of cell of a row (spec §2.3): a FIXED one holds its size, a FLEX one gives way first and clips.
const isFixed = (box: Node | undefined): boolean => box?.props?.flexShrink === 0
const isFlex = (box: Node | undefined): boolean =>
  box?.props?.flexShrink === 1 && box.props.minWidth === 0 && box.props.overflow === 'hidden'
// A Box lays its children out in a row unless it says otherwise, as Ink's does.
const isRow = (box: Node | undefined): boolean => box?.type === 'Box' && (box.props?.flexDirection ?? 'row') === 'row'
const hasWidth = (box: Node | undefined): boolean => typeof box?.props?.width === 'number'

// What would let a row run past the pane, found in the tree: a cell of a row that neither holds its size nor gives way
// and clips, a Text that may be cut that is not alone in a Box that clips, an image that nothing clips or fixes in a
// slot.
const rowProblems = (tree: unknown): string[] => {
  const problems: string[] = []
  for (const { node, parent } of flat(tree)) {
    const where = `${node.type} ${JSON.stringify(node.props)} in ${JSON.stringify(parent?.props)}`
    if (node.type === 'Box' && isRow(parent) && !isFixed(node) && !isFlex(node)) {
      problems.push(`a cell of a row is neither fixed nor flexible: ${where}`)
    }
    if (node.type === 'Text' && node.props?.wrap === 'truncate' && isRow(parent)) {
      const isSized = isFlex(parent) || (isFixed(parent) && hasWidth(parent))
      if (parent?.props?.overflow !== 'hidden' || !isSized || parent.children?.length !== 1) {
        problems.push(`a cut text is not alone in a clipping cell: ${where}`)
      }
    }
    if (node.type === 'Svg') {
      const isClipped = parent?.props?.overflow === 'hidden' || (isFixed(parent) && hasWidth(parent))
      if (!isClipped) problems.push(`an image is not clipped or in a slot: ${where}`)
    }
  }

  return problems
}

test('the pane draws the blocks of the mockup on desktop and on terminal', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  await seed($, clock, bottom(on, clock))
  // The details of Turn stats are closed by default: one press opens them for both surfaces, which share the map.
  const opener = await mountPane($, 'desktop')
  await opener.press({ key: 'details:turn' })
  await opener.unmount()

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    // The brief's marks.
    for (const text of ['Turn stats', '~61 tok/s', '$0.02']) {
      expect(await has(ui, text), `${surface}: ${text}`).toBe(true)
    }
    // Top block: Total and the split.
    for (const text of ['$5.49', 'Session $5.44 · Subagents $0.050']) {
      expect(await has(ui, text), `${surface}: ${text}`).toBe(true)
    }
    // The context figures are the Session band's: in its alt on the desktop, in its core line on the terminal. No row
    // is labelled Context any more.
    if (surface === 'desktop') {
      expect(String((await bandImage(ui))?.props.alt), surface).toStartWith('Context 13%, 128k of 1M')
    } else {
      for (const text of ['13%', '128k / 1M']) {
        expect(await ui.find({ type: 'Text', text }), `${surface}: ${text}`).toBeDefined()
      }
    }
    expect(await ui.find({ type: 'Text', text: /^Context$/ }), surface).toBeUndefined()
    // Project block: the name beside its title, the branch, and the one file that git says is modified (+3 / −1). A row
    // is an icon and its text on the desktop, an emoji and its text on the terminal; the folder emoji is gone.
    const shown = await texts(ui)
    const isDesktop = surface === 'desktop'
    for (const text of [
      'Project', 'online_shop', isDesktop ? 'master' : '🌿 master', isDesktop ? '1 file changed' : '📝 1 file changed',
      '+3', SEP, `${MINUS}1`,
    ]) {
      expect(shown, `${surface}: ${text}`).toContain(text)
    }
    expect(shown.some(text => text.includes('📁')), surface).toBe(false)
    expect(shown.some(text => /[🌿📝]/u.test(text)), surface).toBe(!isDesktop)
    // The desktop drops an image whose alt is empty: every Svg of the mounted pane has one.
    const images = await ui.findAll({ type: 'Svg' })
    expect(images.every(el => typeof el.props.alt === 'string' && el.props.alt.trim() !== ''), surface).toBe(true)
    expect(images.length > 0, surface).toBe(surface === 'desktop')
    // The sections come in the mockup's order, all unfolded, each with its summary beside it.
    expect(await headers(ui)).toEqual([
      '▾ Usage', '▾ Turn stats', '▾ Activity', '▾ MCP', '▾ Context sources', '▾ Log',
    ])
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons.map(button => button.key)).toEqual([
      'toggle:usage', 'toggle:turn', 'details:turn', 'toggle:activity', 'toggle:mcp', 'toggle:sources', 'toggle:log',
    ])
    // The chevron is a plain Button, dim at rest, and so is the details Button. The title is a Text, and the only bold
    // ones are the titles.
    expect(buttons.every(button => button.props.plain === true && button.props.dimColor === true), surface).toBe(true)
    expect((await ui.findAll({ type: 'Text' })).filter(el => el.props.bold === true).map(el => el.text)).toEqual([
      'Session', 'Project', ...TITLES,
    ])
    // The Log counts the five events the seed makes: a prompt, a Bash call, two spawns and the end of one subagent.
    expect(await summaries(ui), surface).toStrictEqual({
      usage: '5-hour 3%', turn: '~120 tok/s', activity: '1/2', mcp: '2', sources: '52 skills · 2 MCP', log: '5',
    })
    // Usage: both windows, with their countdowns.
    for (const text of ['5-hour', 'Weekly', '3%', '24%', '↻ 2h 13m', '↻ 5d 15h']) {
      expect(await has(ui, text), `${surface}: ${text}`).toBe(true)
    }
    // Turn stats: the legend of the ribbon, then, the details open, every row of a turn that took two steps, in the
    // order of the mockup. The answer ran 84 tokens over its request of 0.7 s.
    for (const text of ['Model', 'Tools', /^2.steps$/]) {
      expect(await ui.find({ type: 'Text', text }), `${surface}: legend ${text}`).toBeDefined()
    }
    expect((await ui.find({ key: 'details:turn' }))?.props.label, surface).toBe('▾ details')
    for (const text of [
      'Response', '~120 tok/s', 'Whole turn', 'Elapsed', '33.5s', 'Model time', '1.7s', 'Tool time', '0.3s',
      'Average TTFT', 'Steps', 'Tokens', '912 ↑ · 777 ↓', 'Cache', '99%', 'Cost', '$0.005',
    ]) {
      expect(await ui.find({ type: 'Text', text }), `${surface}: ${text}`).toBeDefined()
    }
    expect((await ui.find({ type: 'Text', text: '99%' }))?.props.color, `${surface} cache`).toBe('success')
    // Activity: main's lane, then the running subagent, then the finished one, their labels whole in the 18 cells of
    // 40 columns, too few for the tag. The desktop's alts carry the tag, which loses its plugin prefix, and main's
    // cost.
    const lanes = textsOf(sectionOf(await ui.drawn(), 'activity'))
    expect(lanes.filter(text => /^(main|Revert stockUnits|Fix cart total qty)$/.test(text))).toEqual([
      'main', 'Revert stockUnits', 'Fix cart total qty',
    ])
    expect(await ui.find({ type: 'Text', text: /^@/ }), surface).toBeUndefined()
    if (isDesktop) {
      expect((await ui.findAll({ type: 'Svg' })).map(el => String(el.props.alt)).filter(alt => alt.includes(', $')))
        .toEqual([
          'main, done, $5.44', 'Revert stockUnits (@code-reviewer), running, $0.030',
          'Fix cart total qty (@engineer), done, $0.020',
        ])
    }
    for (const text of [/^ *\$0\.030$/, /^ *\$0\.020$/]) {
      expect(await has(ui, text), `${surface}: ${text}`).toBe(true)
    }
    // MCP and Context sources: every server is a green dot and a name in the plain colour; the app's own servers are
    // neither listed nor counted, so both say 2. (A chip's dot is `●` and a no-break space: the terminal band's mark of
    // a running station is a `●` alone.)
    const dots = await ui.findAll({ type: 'Text', text: /^●\u{a0}$/u })
    expect(dots.map(el => [el.text, el.props.color]), surface).toEqual([
      ['●\u00a0', 'success'], ['●\u00a0', 'success'],
    ])
    for (const name of ['codebase-memory', 'issue-hub']) {
      const server = await ui.find({ type: 'Text', text: name })
      expect(server, `${surface}: ${name}`).toBeDefined()
      expect(server?.props.color, `${surface}: ${name}`).toBeUndefined()
    }
    for (const name of ['ccd_', 'Claude_Browser', 'scheduled-tasks', 'terminal']) {
      expect(await has(ui, name), `${surface}: ${name}`).toBe(false)
    }
    for (const text of ['Skills', /^52$/, 'MCP servers']) {
      expect(await ui.find({ type: 'Text', text }), `${surface}: ${text}`).toBeDefined()
    }
    // Log: newest first, the person's prompt last.
    const log = await texts(ui)
    const prompt = log.indexOf('fix the stock order qty')
    expect(prompt).toBeGreaterThan(-1)
    expect(log.indexOf('Bash ls -la')).toBeGreaterThan(-1)
    expect(log.indexOf('Bash ls -la')).toBeLessThan(prompt)
    expect(log.indexOf('done · $0.020 — found it')).toBeLessThan(log.indexOf('Bash ls -la'))
    // How each action went is a Text of its own, the last of its row: the mark and the time.
    expect(log.indexOf('✓ 0.3s')).toBe(log.indexOf('Bash ls -la') + 1)
    expect(log.indexOf('✓ 5.0s')).toBe(log.indexOf('done · $0.020 — found it') + 1)
    await ui.unmount()
  }
})

test('a chevron folds its section, the store keeps the map, a second press unfolds it', SLOW, async ($, on) => {
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
    ['turn', 'Turn stats', 'Tools'],
    ['activity', 'Activity', /^Revert stockUnits$/],
    ['mcp', 'MCP', 'codebase-memory'],
    ['sources', 'Context sources', 'Skills'],
    ['log', 'Log', 'fix the stock order qty'],
  ]

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const summary = await summaries(ui)
    for (const [id, title, text] of bodies) {
      const label = async (): Promise<unknown> => (await ui.find({ key: `toggle:${id}` }))?.props.label
      expect(await has(ui, text), `${surface} ${id} open`).toBe(true)
      expect(await label()).toBe('▾')

      await ui.press({ key: `toggle:${id}` })
      expect(await has(ui, text), `${surface} ${id} folded`).toBe(false)
      expect(await label()).toBe('▸')
      // The header stays, with its title and its summary: only the body goes.
      expect(await headers(ui), `${surface} ${id}`).toContain(`▸ ${title}`)
      expect(await summaries(ui), `${surface} ${id} summary`).toStrictEqual(summary)
      kept[id] = true
      expect(await stored()).toEqual(kept)

      await ui.press({ key: `toggle:${id}` })
      expect(await has(ui, text), `${surface} ${id} unfolded`).toBe(true)
      expect(await label()).toBe('▾')
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
      '▾ Usage', '▸ Turn stats', '▾ Activity', '▾ MCP', '▾ Context sources', '▸ Log',
    ])
    expect(await has(ui, 'Whole turn')).toBe(false)
    expect(await has(ui, 'Tools')).toBe(false) // the legend, which an open Turn stats shows with its details closed
    expect(await has(ui, 'fix the stock order qty')).toBe(false)
    // A folded section keeps its summary.
    expect(await ui.find({ type: 'Text', text: '~120 tok/s' })).toBeDefined()
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
    expect(await headers(ui)).toEqual(['▾ Turn stats', '▾ Activity', '▾ MCP', '▾ Context sources', '▾ Log'])
    // Without a five-hour window the summary is the first window there is, and a window with no reset has no countdown.
    await measure($, 128_000, [{ kind: 'seven_day', percentUsed: 24 }])
    expect((await summaries(ui)).usage, `${surface} one window`).toBe('Weekly 24%')
    expect(await has(ui, '↻'), `${surface} no reset`).toBe(false)
    await measure($, 128_000, LIMITS)
    await ui.unmount()
  }
})

test('a pane with nothing to show draws the title, an empty Session band and the turn placeholder', async ($, on) => {
  bottom(on, mock.clock(on, { now: NOW }))

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ type: 'Text', text: 'Session' }))?.props.bold).toBe(true)
    expect(await ui.find({ type: 'Text', text: /^Context$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'No completed turn yet' })).toBeDefined()
    // No data, so no Total, no project line, no meter, and every section but the turn is left out.
    expect(await headers(ui)).toEqual(['▾ Turn stats'])
    expect(await has(ui, '$')).toBe(false)
    expect(await has(ui, '📁')).toBe(false)
    expect(await meters(ui)).toEqual([])
    expect(await has(ui, '▰')).toBe(false)
    // The band reads —. The desktop draws it as an image, the ring a track with no arc; the terminal draws no image at
    // all, and its core line is `—` for the model, the empty meter (10 dim ▱), `—` for the percent and for the tokens.
    const images = await ui.findAll({ type: 'Svg' })
    if (surface === 'desktop') {
      expect(images.map(el => el.props.alt)).toContain(EMPTY_BAND_ALT)
      expect(String((await bandImage(ui))?.props.source)).not.toContain('pathLength="100"')
      expect(await has(ui, '▱')).toBe(false)
    } else {
      expect(images).toEqual([])
      expect(await ui.findAll({ type: 'Text', text: /^—$/ })).toHaveLength(3)
      const empty = await ui.findAll({ type: 'Text', text: /^▱+$/ })
      expect(empty.map(el => [el.text, el.props.dimColor])).toEqual([['▱'.repeat(10), true]])
    }
    await ui.unmount()
  }
})

test('a /clear empties the pane again: the context reads — until the next response', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  await seed($, clock, bottom(on, clock))
  const ui = await mountPane($, 'desktop')
  expect(String((await bandImage(ui))?.props.alt)).toStartWith('Context 13%, 128k of 1M')

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })

  // The band, the first image of the pane, reads — and shows no tokens; its ring is the track alone.
  const band = await ui.find({ type: 'Svg' })
  expect(String(band?.props.alt)).toStartWith('Context —')
  expect(String(band?.props.alt)).not.toMatch(/%|128k/)
  expect(String(band?.props.source)).not.toContain('pathLength="100"')
  // The limits are the session's still: their two meters stay.
  expect((await meters(ui)).map(el => el.props.alt)).toEqual(['5-hour 3%', 'Weekly 24%'])
  expect(await ui.find({ type: 'Text', text: 'No completed turn yet' })).toBeDefined()
  expect(await headers(ui)).toEqual(['▾ Usage', '▾ Turn stats', '▾ MCP', '▾ Context sources'])
  await ui.unmount()
})

test('the meter is an Svg on desktop and ▰▱ text on terminal', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  await seed($, clock, bottom(on, clock))

  const desktop = await mountPane($, 'desktop')
  const bars = await meters(desktop)
  // The meters are the limits': the context is the Session band's ring.
  expect(bars.map(el => el.props.alt)).toEqual(['5-hour 3%', 'Weekly 24%'])
  // At 40 columns a limit bar has the body less its label, percent and countdown.
  expect(bars.map(el => [el.props.width, el.props.height])).toEqual([[120, 8], [120, 8]])
  // 3% of 120 px, blue.
  expect(bars[0]?.props.source).toBe(meterSvg(3, 120))
  expect(String(bars[0]?.props.source)).toContain('<rect width="4" height="8" rx="4" fill="#2f7de1"/>')
  expect(await has(desktop, /[▰▱]/)).toBe(false)
  await desktop.unmount()

  // The terminal's table holds an Svg too, a stub that draws nothing: nothing of the pane is an image there, the rules
  // and the meters are text.
  const terminal = await mountPane($, 'terminal')
  expect(await terminal.find({ type: 'Svg' })).toBeUndefined()
  const filled = await terminal.findAll({ type: 'Text', text: /^▰+$/ })
  const empty = await terminal.findAll({ type: 'Text', text: /^▱+$/ })
  // Ten cells each: the band's core line at 12.8% fills one, 5-hour 3% none, Weekly 24% two.
  expect(filled.map(el => el.text)).toEqual(['▰', '▰▰'])
  expect(filled.map(el => el.props.color)).toEqual(['#2f7de1', '#2f7de1'])
  expect(empty.map(el => el.text)).toEqual(['▱'.repeat(9), '▱'.repeat(10), '▱'.repeat(8)])
  expect(empty.every(el => el.props.dimColor === true)).toBe(true)
  await terminal.unmount()
})

test('the meters take the width of the body: 8 px a cell, less the room of their row', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  await seed($, clock, bottom(on, clock))

  // A limit bar shares its row with a label, a percent and a countdown: (columns - 25) cells, from 40 px up to 4096,
  // the most the engine takes for an Svg.
  expect([0, 12, 25, 32, 40, 45, 55, 80, 100, 390, 600].map(limitMeterWidth)).toEqual([
    40, 40, 40, 56, 120, 160, 240, 440, 600, 2920, 4096,
  ])

  const ui = await mountPane($, 'desktop')
  // The Session band's image takes the whole body, 8 px a cell.
  for (const [bodyColumns, band, limit] of [[40, 320, 120], [32, 256, 56], [12, 96, 40]] as const) {
    await ui.redraw({ ...PANE_PROPS, bodyColumns })
    expect((await meters(ui)).map(el => el.props.width), `${bodyColumns} columns`).toEqual([limit, limit])
    expect((await bandImage(ui))?.props.width, `${bodyColumns} columns`).toBe(band)
  }
  await ui.unmount()
})

// The engine refuses a tree that holds an Svg above 4096 px in width or height, and draws its own pane in place of
// this one. A pane of 600 columns is 4800 px at 8 px a cell: the mount is the engine's own check, and it throws.
test('a pane of 600 columns mounts: the rule, meters and band stop at the 4096 px of an Svg', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  await seed($, clock, bottom(on, clock))

  const ui = await mountPane($, 'desktop', { ...PANE_PROPS, bodyColumns: 600 })
  const images = await ui.findAll({ type: 'Svg' })

  // No Svg of the tree is above the limit, in either size.
  const sizes = images.flatMap(el => [el.props.width, el.props.height])
  expect(sizes.filter(px => typeof px !== 'number' || px > 4096)).toEqual([])
  // The limit bars would be 4600 px: they stop at 4096, and so does the rule.
  expect((await meters(ui)).map(el => el.props.width)).toEqual([4096, 4096])
  const rules = images.filter(el => el.props.alt === 'rule')
  expect(rules).not.toHaveLength(0)
  expect(rules.map(el => el.props.width)).toEqual(rules.map(() => 4096))
  // The band is laid out for 4096 px, a cell short of it, and centred in its Box: no station is clipped.
  const band = flat(await ui.drawn()).find(({ node }) => /^Context (—|\d)/.test(String(node.props?.alt)))
  expect(band?.node.props).toMatchObject({ width: 4088, height: 76 })
  expect(band?.parent?.props).toMatchObject({ height: 4, overflow: 'hidden', justifyContent: 'center' })
  await ui.unmount()
})

test('the percent, the meter and the band\'s ring turn amber from 80% and red from 95%', SLOW, async ($, on) => {
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
      [128_000, '13%', undefined, '#2f7de1'],
      [850_000, '85%', 'warning', '#e0a030'],
      [950_000, '95%', 'error', '#e5484d'],
    ] as const) {
      await measure($, tokens, limits)
      if (surface === 'desktop') {
        // The band is the first image of the pane: its alt says the percent, and its ring's arc is in the colour.
        const band = await ui.find({ type: 'Svg' })
        expect(String(band?.props.alt), `${surface} ${text}`).toStartWith(`Context ${text}, `)
        expect(String(band?.props.source), `${surface} ring ${text}`).toContain(
          `stroke="${fill}" stroke-width="4" pathLength="100"`,
        )
      } else {
        // The core line's percent is in the theme colour of its threshold, and its meter in the colour of the arc.
        const percent = await ui.find({ type: 'Text', text })
        expect(percent, `${surface} ${text}`).toBeDefined()
        expect(percent?.props.color, `${surface} ${text}`).toBe(color)
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
      const bars = (await meters(ui)).map(el => String(el.props.source))
      // 79.9%, 80% and 120% of 120 px.
      expect(bars.map(source => source.split('<rect ')[2])).toEqual([
        'width="96" height="8" rx="4" fill="#2f7de1"/></svg>',
        'width="96" height="8" rx="4" fill="#e0a030"/></svg>',
        'width="120" height="8" rx="4" fill="#e5484d"/></svg>',
      ])
    }
    await ui.unmount()
  }
})

test('a turn of one tool step hides Response and Steps; the cache is green from 50%', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // The details of Turn stats open, as the store of the last session keeps them: the table is what is checked.
  bottom(on, clock, { collapsed: { turnDetails: false } })
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
    // The log has the person's prompt only: the desktop's column of `who` is its own width, the terminal's is as wide
    // as `you`. The line reports no action, so the row has no column of outcome: its three cells.
    expect(logColumns(await ui.drawn()), surface).toEqual([
      { who: 'you', timeCells: 8, whoCells: surface === 'desktop' ? 13 : 3, cells: 3, outcomeCell: undefined },
    ])
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
      const cache = await ui.find({ type: 'Text', text: new RegExp(`^${text}$`) })
      expect(cache, `${surface} ${text}`).toBeDefined()
      expect(cache?.props.color, `${surface} ${text}`).toBe(color)
      await ui.unmount()
    }
  }
})

test('Activity shows main and 7 lanes, the running ones first and the older start first, and counts the rest', SLOW,
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
    await measure($, 128_000, [])

    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      const tasks = (await ui.findAll({ type: 'Text', text: /^task \d$/ })).map(el => el.text)
      expect(tasks, surface).toEqual(['task 0', 'task 1', 'task 2', 'task 3', 'task 4', 'task 5', 'task 6'])
      // The other 3 are counted in a dim line at column 0, the last of the section.
      const section = sectionOf(await ui.drawn(), 'activity')
      const more = childrenOf(childrenOf(section)[2]).at(-1)
      expect(textsOf(more), surface).toEqual(['+3 more'])
      expect(more?.props?.paddingLeft, surface).toBeUndefined()
      expect((await ui.find({ type: 'Text', text: '+3 more' }))?.props.dimColor, surface).toBe(true)
      expect((await summaries(ui)).activity, surface).toBe('9/10')
      // No request has been charged to any of them: a dim dash where the cost goes, on each of the 7 lanes; main's lane
      // has the cost of the session. (The terminal's value is a span of 8 cells, the dash at its right.)
      const dashes = flat(section).filter(({ node }) => node.type === 'Text' && /^ *—$/.test(textsOf(node)[0] ?? ''))
      expect(dashes.map(({ node }) => node.props?.dimColor), surface).toEqual(Array(7).fill(true))
      await ui.unmount()
    }
  })

test('a subagent lane shows its status as a shape and a colour: ✗ for failed, a dim ■ for stopped, a live cap running',
  SLOW, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    bottom(on, clock)
    await $.session.start(START)
    for (let i = 0; i < 4; i += 1) await $.agent.spawn({ ...SPAWN, description: `task ${i}` })
    await endAgent($, 'a1', DONE)
    await endAgent($, 'a2', FAILED)
    await endAgent($, 'a3', STOPPED)

    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      const section = sectionOf(await ui.drawn(), 'activity')
      // Running first (a4), then the newer end first; the three ended in one tick, so in the order of spawn.
      if (surface === 'terminal') {
        // The gutter's `◐` ends the running lane's span, in the Agents hue; the house marks follow the ended spans.
        const marks = flat(section).flatMap(({ node }) => {
          const text = node.type === 'Text' ? textsOf(node)[0] ?? '' : ''
          return /[◐✓✗■○]$/.test(text) ? [[text.slice(-1), node.props?.color, node.props?.dimColor]] : []
        })
        expect(marks, surface).toEqual([
          ['◐', STATION_HUES.agents.dark, undefined],
          ['✓', 'success', undefined],
          ['✗', 'error', undefined],
          ['■', undefined, true],
        ])
      } else {
        // The lane's alt says its status; its image draws it as a shape in a colour: the live cap, a green check, a red
        // cross and a grey square.
        const lanes = flat(section).map(({ node }) => node)
          .filter(node => node.type === 'Svg' && /^task \d /.test(String(node.props?.alt)))
        expect(lanes.map(node => String(node.props?.alt).split(', ')[1]), surface).toEqual([
          'running', 'done', 'failed', 'stopped',
        ])
        const sources = lanes.map(node => String(node.props?.source))
        expect(sources[0], 'running').toContain('data-part="cap"')
        expect(sources[1], 'done').toContain('stroke="#2ea043"')
        expect(sources[2], 'failed').toContain('stroke="#e5484d"')
        expect(sources[3], 'stopped').toContain('width="5" height="5" rx="1" fill="#8a8a8a"')
        expect(sources.slice(1).every(source => !source.includes('data-part="cap"')), surface).toBe(true)
      }
      await ui.unmount()
    }
  })

// A body that leaves the Log room for 20 of the 22 events below. Above the Log the mounted pane has the Session card
// (the Session row and the band: at the 40 columns of the mount the band is 5 rows on the desktop, and the core line
// and 3 grid rows on the terminal), Turn stats (5: the last start leaves a turn running, drawn as the ribbon) and
// Activity (5: its rule and header, main's lane and the one subagent's, and the axis), and the Log's rule and header
// are 2 more: 18 rows on the desktop, 17 on the terminal. The 21 rows that are left are 20 lines and the line that
// counts the other 2.
const BODY_FOR_20_LINES: Record<Surface, RenderPropsOf['Pane']> = {
  desktop: { ...PANE_PROPS, scroll: { offset: 0, bodyRows: 39 } },
  terminal: { ...PANE_PROPS, scroll: { offset: 0, bodyRows: 38 } },
}

test('the log shows 20 lines, newest first, an error in red, and a long text cut to one line', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  bottom(on, clock)
  await $.session.start(START)
  await $.agent.spawn(SPAWN)
  for (let i = 0; i < 20; i += 1) await $.turn.start({ text: `prompt ${i}`, turnId: `t${i}` })
  await endAgent($, 'a1', FAILED)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface, BODY_FOR_20_LINES[surface])
    const log = await texts(ui)
    // 'failed' (the subagent), then prompt 19 down to prompt 1: 20 lines in all, and `+2 more` for prompt 0 and the
    // spawn, which come after them.
    expect(moreOf(await ui.drawn()), surface).toBe(2)
    expect(log.filter(text => /^(prompt \d+|failed)$/.test(text)), surface).toEqual([
      'failed', ...Array.from({ length: 19 }, (_, i) => `prompt ${19 - i}`),
    ])
    // The `who` of the failed line is red, the others are dim: the text carries the row.
    const whos = await ui.findAll({ type: 'Text', text: /^(engineer|you)$/ })
    expect(whos.map(el => [el.text, el.props.color, el.props.dimColor])).toEqual([
      ['engineer', 'error', undefined], ...Array.from({ length: 19 }, () => ['you', undefined, true]),
    ])
    const clocks = await ui.findAll({ type: 'Text', text: /^\d\d:\d\d:\d\d$/ })
    expect(clocks).toHaveLength(20)
    expect(clocks.every(el => el.props.dimColor === true)).toBe(true)
    // The 20 rows are the head's 8 and the tail's 12.
    expect(logBoxes(await ui.drawn()).map(box => logRows(box).length), surface).toEqual([8, 12])
    // Time and `who` are columns of fixed width, the same on every row. The desktop's `who` has a width of its own; the
    // terminal's is as wide as the longest of the 20 (`engineer`). Either way the texts line up.
    const columns = logColumns(await ui.drawn())
    expect(columns, surface).toHaveLength(20)
    expect(columns.map(column => column.timeCells), surface).toEqual(Array(20).fill(8))
    expect(columns.map(column => column.whoCells), surface).toEqual(Array(20).fill(surface === 'desktop' ? 13 : 8))
    // The failed line has an outcome, in red like its `who`. The column is as wide as that outcome (`✗ 0.0s`, a cell
    // more on the desktop), and the 19 prompts have the cell empty, of the same width. At the 40 columns of the mount
    // the desktop's text keeps 9 cells, one over the least a row needs, so the row has all its cells.
    expect(columns.map(column => column.outcomeCell?.props?.width), surface).toEqual(
      Array(20).fill(surface === 'desktop' ? 7 : 6),
    )
    const outcomes = await ui.findAll({ type: 'Text', text: /^✗ / })
    expect(outcomes.map(el => [el.text, el.props.color, el.props.dimColor]), surface).toEqual([
      ['✗ 0.0s', 'error', undefined],
    ])
    expect(columns.map(column => textsOf(column.outcomeCell)), surface).toEqual([['✗ 0.0s'], ...Array(19).fill([])])
    // The text is cut to one line, in a cell that gives way.
    expect((await ui.find({ type: 'Text', text: 'prompt 19' }))?.props.wrap).toBe('truncate')
    await ui.unmount()
  }
})

test('the mounted pane splits its Log by the rows of its body, and draws one Box where they are not known', SLOW,
  async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    bottom(on, clock)
    await $.session.start(START)
    for (let i = 0; i < 30; i += 1) await $.turn.start({ text: `prompt ${i}`, turnId: `t${i}` })

    // [the rows of the body, the lines of the head, the lines of the tail, the events that `+N more` counts], by the
    // surface. Above the Log are the Session card (the Session row and the band: at the 40 columns of the mount 5 rows
    // on the desktop, the core line and 3 grid rows on the terminal) and Turn stats (5: the last start leaves a turn
    // running, drawn as the ribbon), and the Log's rule and header are 2 more: the Log has the body's rows less 13 on
    // the desktop and less 12 on the terminal. The log holds 30 events. When they all fit (a body of 43 on the
    // desktop, 42 on the terminal) they all show; when they do not, a row goes to the `+N more` line, and the lines
    // are never fewer than 8.
    const cases: Record<Surface, ReadonlyArray<readonly [number, number, number, number | undefined]>> = {
      desktop: [
        [20, 8, 0, 22], [12, 8, 0, 22], [9, 8, 0, 22], [8, 8, 0, 22], [5, 8, 0, 22], [36, 8, 14, 8], [37, 8, 15, 7],
        [40, 8, 18, 4], [43, 8, 22, undefined],
      ],
      terminal: [
        [20, 8, 0, 22], [12, 8, 0, 22], [9, 8, 0, 22], [8, 8, 0, 22], [5, 8, 0, 22], [36, 8, 15, 7], [37, 8, 16, 6],
        [40, 8, 19, 3], [42, 8, 22, undefined],
      ],
    }
    const moreProps = (surface: Surface) => ({
      flexDirection: 'row', paddingLeft: surface === 'desktop' ? 3 : 2, flexShrink: 0,
    })
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      for (const [bodyRows, head, tail, more] of cases[surface]) {
        const where = `${surface} ${bodyRows} rows`
        // The engine hands the pane its next props when the body changes, and the root follows the body.
        await ui.redraw({ ...PANE_PROPS, scroll: { offset: 0, bodyRows } })
        const tree: Node = await ui.drawn()
        expect(tree.props?.minHeight, where).toBe(bodyRows)
        const boxes = logBoxes(tree)
        expect(boxes.map(box => logRows(box).length), where).toEqual(tail > 0 ? [head, tail] : [head])
        expect(boxes[0]?.props, where).toStrictEqual({ flexDirection: 'column', flexShrink: 0 })
        if (tail > 0) {
          expect(boxes[1]?.props, where).toStrictEqual({
            flexDirection: 'column', height: 0, flexGrow: 1, flexShrink: 1, overflow: 'hidden',
          })
        }
        // The newest first, the head's lines and then the tail's.
        expect(logRows(tree).map(rowText), where).toEqual(
          Array.from({ length: head + tail }, (_, i) => `prompt ${29 - i}`),
        )
        // The line that counts the rest is the last child of the pane, after the tail, and the engine takes it.
        expect(moreOf(tree), where).toBe(more)
        if (more !== undefined) {
          expect(childrenOf(tree).at(-1), where).toBe(logMoreLine(tree))
          expect(logMoreLine(tree)?.props, where).toStrictEqual(moreProps(surface))
        }
      }
      // Where the engine hands no height (0, or a number that is none: the NaN arrives as null) the root has no
      // `minHeight`, which the engine has to take left out, and the Log is the 15 lines in one Box, and `+15 more`. A
      // pane may well draw first with such a body.
      for (const bodyRows of [0, Number.NaN]) {
        const where = `${surface} ${Number.isNaN(bodyRows) ? 'NaN (arrives as null)' : bodyRows} rows`
        await ui.redraw({ ...PANE_PROPS, scroll: { offset: 0, bodyRows } })
        const tree: Node = await ui.drawn()
        expect(tree.props?.minHeight, where).toBeUndefined()
        expect(logBoxes(tree).map(box => logRows(box).length), where).toEqual([15])
        expect(moreOf(tree), where).toBe(15)
        expect(childrenOf(tree).at(-1), where).toBe(logMoreLine(tree))
      }
      await ui.unmount()
    }
  })

test('a window of 0 draws a dash for the context, never NaN or Infinity', SLOW, async ($, on) => {
  bottom(on, mock.clock(on, { now: NOW }))
  // Before any breakdown the model's window is the only one, and here it reads 0.
  await $.session.measure({ context: { window: 0, tokens: 100, percent: 0 }, rateLimits: [], changed: ['context'] })

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    // The band reads —: in its alt on the desktop, with no tokens; in its core line on the terminal.
    if (surface === 'desktop') {
      const alt = String((await bandImage(ui))?.props.alt)
      expect(alt, surface).toStartWith('Context —. ')
      expect(alt, surface).not.toMatch(/NaN|Infinity|null|undefined|%/)
    } else {
      expect(await ui.find({ type: 'Text', text: /^—$/ }), surface).toBeDefined()
    }
    expect(await has(ui, /NaN|Infinity|null|undefined|%/), surface).toBe(false)
    expect(await meters(ui), surface).toEqual([])
    await ui.unmount()
  }
})

test('the view reads a percent that is not a finite number as no reading', () => {
  const drawn = (contextPct: number | undefined, surface: Surface = 'desktop'): Node => draw(
    onSurface({ ...EMPTY, usage: { rateLimits: [], contextTokens: 100, contextWindow: 0, contextPct } }, surface), 40,
  )
  // The band's image on the desktop; the core line's texts on the terminal, without its blank spans.
  const bandOf = (tree: Node): Node | undefined => childrenOf(childrenOf(childrenOf(tree)[0])[1])[0]
  const coreOf = (tree: Node): string[] =>
    spanTexts(childrenOf(childrenOf(tree)[0])[1]).filter(text => text.trim() !== '')

  // A finite percent is drawn, so the drawing here is not empty by mistake: the ring has its arc.
  expect(String(bandOf(drawn(12.8))?.props?.alt)).toStartWith('Context 13%, 100 of 0. ')
  expect(String(bandOf(drawn(12.8))?.props?.source)).toContain('pathLength="100"')
  expect(coreOf(drawn(12.8, 'terminal'))).toEqual(['—', '▰', '▱'.repeat(9), '13%', '100 / 0'])
  // NaN and the infinities, and the null that a build before the guard may have left behind in the state.
  for (const contextPct of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null as never]) {
    const tree = drawn(contextPct)
    const terminal = drawn(contextPct, 'terminal')
    expect(textsOf(tree), String(contextPct)).toEqual(['Session', 'Turn stats', 'No completed turn yet'])
    // The band reads —, its ring is the track alone, and with no reading it shows no tokens.
    expect(bandOf(tree)?.props?.alt, String(contextPct)).toBe(EMPTY_BAND_ALT)
    expect(String(bandOf(tree)?.props?.source), String(contextPct)).not.toContain('pathLength="100"')
    expect(coreOf(terminal), String(contextPct)).toEqual(['—', '▱'.repeat(10), '—', '—'])
    for (const surfaceTree of [tree, terminal]) {
      expect(JSON.stringify(surfaceTree), String(contextPct)).not.toMatch(/NaN|Infinity|null|undefined/)
    }
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
    expect(await label()).toBe('▸')

    await ui.press({ key: 'toggle:log' })
    expect(await has(ui, 'fix the stock order qty'), `${surface} unfolded`).toBe(true)
    expect(await label()).toBe('▾')
    await ui.unmount()
  }
})

// ---- The structure of the tree, drawn without the engine ----

const isType = (text: string): boolean => text.startsWith('@')
// The Text that shows exactly this string, with the element that holds it.
const textNode = (tree: unknown, text: string): Placed | undefined =>
  flat(tree).find(({ node }) => node.type === 'Text' && textsOf(node)[0] === text)
// The rules: on the desktop the image whose alt is `rule`, on the terminal a dim row of ─ (an Activity lane's ─ is in
// its hue).
const isRuleNode = (node: Node): boolean => (node.type === 'Svg' && node.props?.alt === 'rule') ||
  (node.type === 'Text' && node.props?.dimColor === true && /^─+$/.test(textsOf(node)[0] ?? ''))
const ruleCount = (tree: unknown): number => flat(tree).filter(({ node }) => isRuleNode(node)).length
// The rules of a terminal body with no columns: a dim Text cut to the pane, with no `─` in it.
const emptyRules = (tree: unknown): Node[] =>
  flat(tree).map(({ node }) => node).filter(node => (
    node.type === 'Text' && node.props?.dimColor === true && node.props.wrap === 'truncate' &&
    textsOf(node).join('') === ''
  ))
// The Project block: the child of the pane whose header, the row after its rule, has the bold `Project`. Its children
// are the rule, the header, then the branch row and the changes row where they are drawn.
const projectOf = (tree: Node): Node | undefined =>
  childrenOf(tree).find(child => textsOf(childrenOf(child)[1])[0] === 'Project')

test('no row can outgrow the pane: every cell is fixed or flexible, and cut text sits in a clipping cell', () => {
  const folded = Object.fromEntries(SECTIONS.map(id => [id, true]))
  const project = { name: 'repo', branch: null, changes: null }
  const bare = { ...FULL, usage: { ...FULL.usage, costUsd: undefined }, project }

  for (const surface of SURFACES) {
    for (const bodyColumns of [8, 12, 30, 45, 120]) {
      // The full pane, the same folded, the empty one, and one with no total, no branch and few figures.
      for (const data of [FULL, { ...FULL, collapsed: folded }, EMPTY, bare]) {
        expect(rowProblems(draw(onSurface(data, surface), bodyColumns)), `${surface} ${bodyColumns}`).toEqual([])
      }
    }
  }
})

test('the row check reports each way a row can outgrow the pane, and passes the cells that cannot', () => {
  const box = (props: Record<string, unknown>, ...children: Node[]): Node => ({ type: 'Box', props, children })
  const cut = (text: string): Node => ({ type: 'Text', props: { wrap: 'truncate' }, children: [text] })
  const dim = (text: string): Node => ({ type: 'Text', props: { dimColor: true }, children: [text] })
  const image: Node = { type: 'Svg', props: { alt: 'rule', width: 4096, height: 1 }, children: [] }
  const flex = { flexDirection: 'row', flexShrink: 1, minWidth: 0, overflow: 'hidden' }
  const fixed = { flexDirection: 'row', flexShrink: 0 }
  const row = (...cells: Node[]): Node => box({ flexDirection: 'row' }, ...cells)

  // v1's row: a cell that cannot shrink below its text, with a cut text in a Box that does not clip.
  expect(rowProblems(row(box({ flexShrink: 1 }, cut('a long description')))), 'v1').toHaveLength(2)
  // A flexible cell needs its minWidth of 0 and its clip, both: either alone is the v1 mistake.
  expect(rowProblems(row(box({ ...flex, minWidth: undefined }, cut('a')))), 'no minWidth').not.toEqual([])
  expect(rowProblems(row(box({ ...flex, overflow: undefined }, cut('a')))), 'no clip').not.toEqual([])
  // (a) An image that is not in a clipping cell, or in a fixed slot with a width.
  const unclipped = rowProblems(box({ flexDirection: 'row', marginTop: 1 }, image))
  expect(unclipped, 'an image in a Box that does not clip').toHaveLength(1)
  expect(unclipped[0], 'an image in a Box that does not clip').toContain('image')
  expect(rowProblems(row(box(fixed, image))), 'an image in a fixed cell without a width').toHaveLength(1)
  // (b) A cut text that shares its cell with another child.
  const shared = rowProblems(row(box(flex, cut('a description'), dim('@type'))))
  expect(shared, 'a cut text that shares its cell').toHaveLength(1)
  expect(shared[0], 'a cut text that shares its cell').toContain('cut text')
  // (c) A fixed cell that holds a cut text but has no width.
  const sizeless = rowProblems(row(box({ ...fixed, overflow: 'hidden' }, cut('who'))))
  expect(sizeless, 'a fixed cell with no width').toHaveLength(1)
  expect(sizeless[0], 'a fixed cell with no width').toContain('cut text')

  // The cells the pane is made of pass: a flexible cell, a fixed one with a width, an image in a clipping Box or slot.
  const sized = { ...fixed, width: 7, overflow: 'hidden' }
  const cells = [box(flex, cut('a')), box(sized, cut('b')), box(flex, image), box({ ...fixed, width: 2 }, image)]
  expect(rowProblems(row(...cells))).toEqual([])
})

test('the texts that can overrun a row carry the truncation props; the values never do', () => {
  for (const surface of SURFACES) {
    // The details of Turn stats open, so that a label of their table is among the texts.
    const tree = draw(onSurface({ ...FULL, collapsed: { turnDetails: false } }, surface))
    const cut = flat(tree)
      .filter(({ node }) => node.type === 'Text' && node.props?.wrap === 'truncate')
      .map(({ node }) => textsOf(node)[0])
    const isDesktop = surface === 'desktop'
    // A summary, the cost split, the project, its branch and the label of its changes, a server, a log line and its
    // `who`, a countdown, a label.
    for (const text of [
      '5-hour 3%', 'Session $126.09 · Subagents $22.50', PROJECT, isDesktop ? BRANCH : `🌿 ${BRANCH}`,
      isDesktop ? '12 files changed' : '📝 12 files changed', 'Claude_Browser', LONG_TEXT, 'minimal-change',
      '↻ 2h 13m', 'Response', 'Spend',
    ]) {
      expect(cut, `${surface}: ${text}`).toContain(text)
    }
    // A figure, a percent (the terminal band's among them), a cost, the lines of the changes, a title and the legend's
    // labels are not cut.
    for (const text of [
      '$148.59', ...(isDesktop ? [] : ['88%']), '120%', '1m 18s', isDesktop ? '$2.50' : '   $2.50', '+1204', SEP,
      `${MINUS}387`, 'Usage',
      'Session', 'Project', 'Model', 'Tools',
    ]) {
      const placed = textNode(tree, text)
      expect(placed, `${surface}: ${text}`).toBeDefined()
      expect(placed?.node.props?.wrap, `${surface}: ${text}`).toBeUndefined()
    }
    // A lane's label is cut to its column (20 cells at 45 columns) with an ellipsis before it is drawn: it carries no
    // truncation, and neither does the value beside it.
    const label = textNode(tree, cutCells(AGENTS[0]?.description ?? '', 20))
    expect(label, surface).toBeDefined()
    expect(label?.node.props?.wrap, surface).toBeUndefined()
    // The type tag shows from a label column of 24 cells (54 columns), dim and cut by shortType, not by the layout.
    const tagsAt = (bodyColumns: number): Node[] => flat(draw(onSurface(FULL, surface), bodyColumns))
      .map(({ node }) => node)
      .filter(node => node.type === 'Text' && isType((textsOf(node)[0] ?? '').replace(/^[\s\u{a0}]+/u, '')))
    expect(tagsAt(53), surface).toEqual([])
    const tags = tagsAt(54)
    expect(tags.map(node => (textsOf(node)[0] ?? '').trim()), surface).toEqual([
      '@code-reviewer', '@minimal-chang…', ...Array(5).fill('@code-reviewer'),
    ])
    expect(tags.every(node => node.props?.dimColor === true && node.props.wrap === undefined), surface).toBe(true)
  }
})

test('value columns hold their width and align right, so the figures line up on their right edge', () => {
  const isRightAligned = (cell: Node | undefined): boolean =>
    isFixed(cell) && cell?.props?.justifyContent === 'flex-end' && hasWidth(cell)

  for (const surface of SURFACES) {
    // The details of Turn stats open: their label/value rows are among those that line up.
    const tree = draw(onSurface({ ...FULL, collapsed: { turnDetails: false } }, surface))
    const cellOf = (text: string): Node | undefined => textNode(tree, text)?.parent
    const widthOf = (cell: Node | undefined): number => Number(cell?.props?.width)

    // The context is the Session band's, and the band takes the body: on the desktop its image is the body's 360 px; on
    // the terminal its core line is the body's 45 cells, so the tokens end at the right edge.
    const band = childrenOf(childrenOf(tree)[0])[1]
    if (surface === 'desktop') {
      expect(childrenOf(band)[0]?.props?.width, `${surface} band`).toBe(45 * 8)
    } else {
      expect(spanTexts(band).join(''), `${surface} band`).toHaveLength(45)
      expect(spanTexts(band).at(-1), `${surface} band`).toBe('529k / 600k')
    }
    // The limits: one width for the labels, one for the percents (wide enough for 100%), so the rows line up.
    const labels = ['5-hour', 'Weekly', 'Spend', 'some_new_window'].map(cellOf)
    expect(new Set(labels.map(widthOf)).size, `${surface} limit labels`).toBe(1)
    expect(labels.every(label => isFixed(label) && hasWidth(label)), `${surface} limit labels`).toBe(true)
    const percents = ['3%', '84%', '120%', '5%'].map(cellOf)
    expect(percents.every(isRightAligned), `${surface} limit percents`).toBe(true)
    expect(new Set(percents.map(widthOf)).size, `${surface} limit percents`).toBe(1)
    expect(widthOf(percents[0])).toBeGreaterThanOrEqual('100%'.length)
    // The values of the eight lanes: on the desktop a cell at the right edge, one width, wide enough for `$148.59+`; on
    // the terminal the last span of each line, right-aligned in 8 cells.
    const lanes = activityBody(tree).slice(0, 8)
    if (surface === 'desktop') {
      const costs = lanes.map(row => childrenOf(row)[2])
      expect(costs.every(isRightAligned), `${surface} costs`).toBe(true)
      expect(new Set(costs.map(widthOf)), `${surface} costs`).toEqual(new Set([8]))
    } else {
      expect(lanes.map(line => spanTexts(line).at(-1)), `${surface} costs`).toEqual([
        ' $126.09', '   $2.50', '       —', ...Array(5).fill('   $2.50'),
      ])
    }
    // The label/value rows (Turn stats and Context sources): the label gives way, the value holds its size.
    const rows = flat(tree).filter(({ node }) => node.props?.justifyContent === 'space-between')
    const valueRows = rows.filter(({ node }) => {
      const [label, value] = childrenOf(node)
      return node.props?.columnGap === 2 && isFlex(label) && isFixed(value)
    })
    expect(valueRows, surface).toHaveLength(10 + 2)
  }
})

// Three subagents. The descriptions differ in length: a short one, one in between, and one wider than any pane. The
// types are three lengths: `@code-reviewer` is 14 cells, `@ui-designer` 12, and `@frontend-deve…` (shortType's cut) 15.
const WIDE = 'Map every call of the order flow and its tests '.repeat(8)
const TYPED: AgentRow[] = [
  agent(1, 'running', { description: 'Fix', type: 'code-reviewer' }),
  agent(2, 'done', { description: WIDE, type: 'ui-designer' }),
  agent(3, 'failed', { description: 'Review the change', type: 'frontend-developer' }),
]
const withAgents = (rows: AgentRow[], surface: Surface): PaneData =>
  onSurface({ ...EMPTY, agents: Object.fromEntries(rows.map(row => [row.id, row])) }, surface)

test('the lanes outgrow no pane, at the narrowest and the widest body the tests use', () => {
  for (const surface of SURFACES) {
    for (const bodyColumns of [8, 120]) {
      const where = `${surface} ${bodyColumns}`
      const tree = draw(withAgents(TYPED, surface), bodyColumns)
      // Main's lane and the three, then the axis.
      expect(activityBody(tree), where).toHaveLength(5)
      expect(rowProblems(tree), where).toEqual([])
    }
  }
  // The check sees the label cell: one that does not hold its size is neither fixed nor flexible. Desktop only: a
  // terminal lane is one spanLine, with no label cell to break.
  const [lane] = activityBody(draw(withAgents(TYPED, 'desktop')))
  const label = childrenOf(lane)[0]
  if (label !== undefined) label.props = { ...label.props, flexShrink: undefined }
  const problems = rowProblems(lane)
  expect(problems).toHaveLength(1)
  expect(problems[0]).toContain('neither fixed nor flexible')
})

test('a lane keeps its `@type` from a label column of 24 cells (54 columns), and drops it below that', () => {
  for (const surface of SURFACES) {
    for (const bodyColumns of [8, 53, 54, 120]) {
      const where = `${surface} ${bodyColumns} columns`
      const tree = draw(withAgents(TYPED, surface), bodyColumns)
      expect(rowProblems(tree), where).toEqual([])
      const tags = textsOf(activityOf(tree)).map(text => text.trim()).filter(isType)
      expect(tags, where).toEqual(bodyColumns >= 54 ? ['@code-reviewer', '@ui-designer', '@frontend-deve…'] : [])
    }
    // The line that counts the rest does not move: of nine subagents seven have a lane, and `+2 more` is at column 0.
    const nine = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => agent(n, 'running', { type: 'ui-designer' }))
    const tree = draw(withAgents(nine, surface), 8)
    expect(textNode(tree, '+2 more')?.parent?.props?.paddingLeft, surface).toBeUndefined()
    expect(childrenOf(textNode(tree, '+2 more')?.parent), surface).toHaveLength(1)
  }
})

test('the log keeps time and who in fixed columns, so every text starts at the same place', () => {
  const log = (who: string, kind: LogEntry['kind'] = 'info'): LogEntry[] =>
    ['a', 'b', 'c'].map((text, i) => ({ at: NOW - i * 1000, who, text, kind }))

  // The desktop's column of `who` is one width whatever the names, 13 cells (`minimal-change` is about 96 px of the
  // 104); the terminal's is the longest name, up to 14.
  const names: Array<[who: string, terminalCells: number]> = [
    ['you', 3], ['minimal-change', 14], ['a-name-longer-than-the-log-ever-keeps', 14],
  ]
  for (const [who, terminalCells] of names) {
    for (const surface of SURFACES) {
      const rows = logColumns(draw(onSurface({ ...EMPTY, log: log(who) }, surface)))
      const cells = surface === 'desktop' ? 13 : terminalCells
      expect(rows.map(row => [row.timeCells, row.whoCells]), `${surface} ${who}`).toEqual(Array(3).fill([8, cells]))
    }
  }
  // The text takes what is left: it grows, gives way, and is cut.
  const [line] = flat(draw({ ...EMPTY, log: log('you') })).filter(({ node }) => isTimeCell(childrenOf(node)[0]))
  const text = childrenOf(line?.node)[2]
  expect(text?.props).toMatchObject({ flexGrow: 1, flexShrink: 1, minWidth: 0, overflow: 'hidden' })
  expect(childrenOf(text)[0]?.props?.wrap).toBe('truncate')
  // An error shows its `who` in red; the others are dim, like the time.
  const styles = (kind: LogEntry['kind']): unknown[] =>
    flat(draw({ ...EMPTY, log: log('engineer', kind) }))
      .filter(({ node }) => node.type === 'Text' && textsOf(node)[0] === 'engineer')
      .map(({ node }) => [node.props?.color, node.props?.dimColor])
  expect(styles('error')).toEqual(Array(3).fill(['error', undefined]))
  expect(styles('ok')).toEqual(Array(3).fill([undefined, true]))
  // The text of an error line stays plain: its `who` is the red.
  const textColours = flat(draw({ ...EMPTY, log: log('engineer', 'error') }))
    .filter(({ node }) => node.type === 'Text' && ['a', 'b', 'c'].includes(textsOf(node)[0] ?? ''))
    .map(({ node }) => node.props?.color)
  expect(textColours).toEqual(Array(3).fill(undefined))
})

// Log lines with outcomes of three lengths (an error among them) and one with none: a prompt.
const WITH_OUTCOMES: LogEntry[] = [
  { at: NOW, who: 'main', text: 'Read a.py', kind: 'ok', outcome: '✓ 0.3s' },
  { at: NOW - 1000, who: 'main', text: 'Bash x', kind: 'error', outcome: '✗ 1m 12s' },
  { at: NOW - 2000, who: 'you', text: 'a prompt', kind: 'info' },
  { at: NOW - 3000, who: 'main', text: 'Edit b.py', kind: 'error', outcome: 'denied' },
]

test('the outcome of a log line is a fixed column at the right edge: one width, empty where a line has none', () => {
  for (const surface of SURFACES) {
    const rows = logColumns(draw(onSurface({ ...EMPTY, log: WITH_OUTCOMES }, surface)))
    expect(rows, surface).toHaveLength(4)
    // Four cells on every row. The cell is as wide on every row as the longest outcome, `✗ 1m 12s`, of 8 characters;
    // the desktop has a cell more. It holds its width, clips, and puts its text at the right edge.
    expect(rows.map(row => row.cells), surface).toEqual([4, 4, 4, 4])
    for (const row of rows) {
      expect(row.outcomeCell?.props, surface).toMatchObject({
        flexDirection: 'row', width: surface === 'desktop' ? 9 : 8, flexShrink: 0, overflow: 'hidden',
        justifyContent: 'flex-end',
      })
    }
    // The prompt has the cell too, and it is empty. The others have their outcome in a cut Text, in red for an error
    // and dim for the rest, as their `who`.
    expect(rows.map(row => textsOf(row.outcomeCell)), surface).toEqual([['✓ 0.3s'], ['✗ 1m 12s'], [], ['denied']])
    expect(rows.map(row => childrenOf(row.outcomeCell).map(styleOf)), surface).toEqual([
      [[undefined, true, 'truncate']], [['error', undefined, 'truncate']], [], [['error', undefined, 'truncate']],
    ])
  }
})

test('with no outcome among the lines drawn the log has no outcome column: the three cells of a row, as before', () => {
  // The 21st line has an outcome, but only 12 are drawn: the body leaves the Log 13 rows below the Session card, the
  // placeholder of Turn stats and its rule and header, and one of them is for `+9 more`. The 21st makes no column.
  const lines: LogEntry[] = [
    ...Array.from({ length: 20 }, (_, i): LogEntry => (
      { at: NOW - i * 1000, who: 'you', text: `prompt ${i}`, kind: 'info' }
    )),
    { at: NOW - 20_000, who: 'main', text: 'Read a.py', kind: 'ok', outcome: '✓ 0.3s' },
  ]

  for (const surface of SURFACES) {
    const tree = draw(onSurface({ ...EMPTY, log: lines }, surface), 45, logBody(surface, 13))
    const rows = logColumns(tree)
    expect(rows.map(row => row.cells), surface).toEqual(Array(12).fill(3))
    expect(rows.every(row => row.outcomeCell === undefined), surface).toBe(true)
    expect(moreOf(tree), surface).toBe(9)
  }
})

test('a line written before the outcome was a field keeps its suffix in its text, alone or among new lines', () => {
  // The old shape: how the action went is the end of the text, and there is no `outcome` key at all.
  const olds: LogEntry[] = [
    { at: NOW - 1000, who: 'main', text: 'Bash ls ✓ 0.3s', kind: 'ok' },
    { at: NOW - 2000, who: 'main', text: 'Bash false ✗', kind: 'error' },
  ]
  const fresh = (text: string, outcome: string, at: number): LogEntry => (
    { at, who: 'main', text, kind: 'ok', outcome }
  )
  const among = [fresh('Read a.py', '✓ 0.3s', NOW), ...olds, fresh('Bash x', '✗ 1m 12s', NOW - 3000)]
  const textsIn = (tree: unknown): string[][] => logRows(tree).map(row => textsOf(childrenOf(row)[2]))

  for (const surface of SURFACES) {
    // Alone, no line drawn has an outcome: the three cells of a row, and the text as it is.
    const alone = draw(onSurface({ ...EMPTY, log: olds }, surface))
    expect(logColumns(alone).map(row => row.cells), surface).toEqual([3, 3])
    expect(textsIn(alone), surface).toEqual([['Bash ls ✓ 0.3s'], ['Bash false ✗']])
    // Among lines with outcomes there is the column. The old lines keep their text, an error one as well as an ok one,
    // and have the cell empty: no Text of an outcome that is not there.
    const mixed = draw(onSurface({ ...EMPTY, log: among }, surface))
    const rows = logColumns(mixed)
    expect(rows.map(row => row.cells), surface).toEqual([4, 4, 4, 4])
    expect(textsIn(mixed), surface).toEqual([['Read a.py'], ['Bash ls ✓ 0.3s'], ['Bash false ✗'], ['Bash x']])
    expect(rows.map(row => textsOf(row.outcomeCell)), surface).toEqual([['✓ 0.3s'], [], [], ['✗ 1m 12s']])
    expect(rows.map(row => childrenOf(row.outcomeCell).length), surface).toEqual([1, 0, 0, 1])
    // Nothing of the missing field is drawn as a word: no `undefined` in any text.
    for (const tree of [alone, mixed]) expect(JSON.stringify(tree), surface).not.toContain('undefined')
  }
})

// The layouts of a log row are the cells it has, in order.
const LAYOUT_WHO = ['time', 'who', 'text', 'outcome']
const LAYOUT_BARE = ['time', 'text', 'outcome']
const LAYOUT_TEXT = ['time', 'text']
// The bands of the layouts, by surface, `who` and lines: the narrowest body that draws [time, who, text, outcome], and
// the narrowest that draws [time, text, outcome]; under that the row is [time, text]. The text keeps the body less the
// time (8) and the other cells of the layout, less the gaps (the cells of the row less one), and a layout is drawn from
// 8 cells of text. The desktop's `who` is 13 whatever the name, and its outcome has a cell more: `✗ 1m 12s` is 9 cells
// and `✓ 0.3s` is 7, so 8 + 13 + 9 + 3 + 8 = 41 and 8 + 13 + 7 + 3 + 8 = 39 with `who`, and 8 + 9 + 2 + 8 = 27 and
// 8 + 7 + 2 + 8 = 25 without it. The terminal's `who` is the longest name and its outcome is as it is: 8 + 4 + 8 +
// 3 + 8 = 31 for `main`, 8 + 14 + 8 + 3 + 8 = 41 for `minimal-change`, 8 + 4 + 6 + 3 + 8 = 29 with `✓ 0.3s`, and
// 8 + 8 + 2 + 8 = 26 and 8 + 6 + 2 + 8 = 24 without `who`.
const SHORT_OUTCOMES = WITH_OUTCOMES.filter(line => line.outcome !== '✗ 1m 12s')
type Band = [surface: Surface, lines: LogEntry[], who: string, outcomeCells: number, withWho: number, bare: number]
const BANDS: Band[] = [
  ['desktop', WITH_OUTCOMES, 'main', 9, 41, 27], ['desktop', WITH_OUTCOMES, 'minimal-change', 9, 41, 27],
  ['desktop', SHORT_OUTCOMES, 'main', 7, 39, 25], ['terminal', WITH_OUTCOMES, 'main', 8, 31, 26],
  ['terminal', WITH_OUTCOMES, 'minimal-change', 8, 41, 26], ['terminal', SHORT_OUTCOMES, 'main', 6, 29, 24],
]

test('a log row gives way in three steps: `who` first, then the outcome cell, which then leads the text', () => {
  for (const [surface, lines, who, outcomeCells, withWho, bare] of BANDS) {
    const log = lines.map(line => ({ ...line, who }))
    // The narrowest body the tests use, either side of each edge, and a wide one.
    for (const bodyColumns of [8, bare - 1, bare, withWho - 1, withWho, 120]) {
      const where = `${surface} ${who} ${bodyColumns} columns, edges ${bare} and ${withWho}`
      const tree = draw(onSurface({ ...EMPTY, log }, surface), bodyColumns)
      const rows = logRows(tree)
      const layout = bodyColumns >= withWho ? LAYOUT_WHO : bodyColumns >= bare ? LAYOUT_BARE : LAYOUT_TEXT
      expect(rowProblems(tree), where).toEqual([])
      // Every row has the cells of one layout, in order.
      expect(rows.map(logRoles), where).toEqual(Array(log.length).fill(layout))

      rows.forEach((row, i) => {
        const line = log[i]
        const cell = (role: string): Node | undefined => childrenOf(row)[layout.indexOf(role)]
        expect(row.props?.columnGap, where).toBe(1)
        expect(cell('time')?.props?.width, where).toBe(8)
        const whoCells = surface === 'desktop' ? 13 : who.length
        expect(cell('who')?.props?.width, where).toBe(layout.includes('who') ? whoCells : undefined)
        expect(cell('outcome')?.props?.width, where).toBe(layout.includes('outcome') ? outcomeCells : undefined)
        // The text, whole, or behind its outcome when the row has no cell for it; one with no outcome shows its text.
        const isLead = layout === LAYOUT_TEXT && line?.outcome !== undefined
        expect(textsOf(cell('text')), where).toEqual([isLead ? `${line?.outcome} ${line?.text}` : line?.text])
        // The text is a cell that gives way and is cut. It is plain, but in [time, text], which has no cell for `who`
        // or the outcome to be red in, the text of an error line is red.
        expect(cell('text')?.props, where)
          .toMatchObject({ flexGrow: 1, flexShrink: 1, minWidth: 0, overflow: 'hidden' })
        const textColour = layout === LAYOUT_TEXT && line?.kind === 'error' ? 'error' : undefined
        expect(childrenOf(cell('text')).map(styleOf), where).toEqual([[textColour, undefined, 'truncate']])
        // An error shows its `who` and its outcome in red, the others are dim, where they have a cell.
        const style = line?.kind === 'error' ? ['error', undefined, 'truncate'] : [undefined, true, 'truncate']
        expect(childrenOf(cell('who')).map(styleOf), where).toEqual(layout.includes('who') ? [style] : [])
        expect(childrenOf(cell('outcome')).map(styleOf), where)
          .toEqual(layout.includes('outcome') && line?.outcome !== undefined ? [style] : [])
      })
    }
  }
})

test('a line with an outcome reads `✓ 0.3s Bash ls` where the row has the time and the text only', () => {
  const log: LogEntry[] = [
    { at: NOW, who: 'main', text: 'Bash ls', kind: 'ok', outcome: '✓ 0.3s' },
    { at: NOW - 1000, who: 'main', text: 'Bash ls', kind: 'ok' },
  ]
  for (const surface of SURFACES) {
    const rows = logRows(draw(onSurface({ ...EMPTY, log }, surface), 8))
    expect(rows.map(logRoles), surface).toEqual([LAYOUT_TEXT, LAYOUT_TEXT])
    expect(rows.map(row => textsOf(childrenOf(row)[1])), surface).toEqual([['✓ 0.3s Bash ls'], ['Bash ls']])
  }
})

test('where the row has the time and the text only, the text of an error line is red and the others are plain', () => {
  const log: LogEntry[] = [
    { at: NOW, who: 'main', text: 'Bash ls', kind: 'ok', outcome: '✓ 0.3s' },
    { at: NOW - 1000, who: 'main', text: 'Bash false', kind: 'error', outcome: '✗ 3.3s' },
    { at: NOW - 2000, who: 'main', text: 'stopped', kind: 'info', outcome: '27.4s' },
    // A line from before the outcome was a field has none, and its kind says it failed.
    { at: NOW - 3000, who: 'main', text: 'Bash old ✗', kind: 'error' },
  ]
  const oldErrors = [log[3], log[3]] as LogEntry[]
  const colours = (tree: unknown): unknown[] =>
    logRows(tree).map(row => childrenOf(childrenOf(row)[logRoles(row).indexOf('text')]).map(styleOf)[0])
  // The layout of each width, with the longest outcome at 6 characters: the edges are 39 and 25 on the desktop, 29 and
  // 24 on the terminal. With no outcome at all there is `who` from 31 columns on the desktop, from 22 on the terminal:
  // the old lines are in [time, text], and red, only where the last field is true.
  const widths: [surface: Surface, bodyColumns: number, layout: string[], isOldRed: boolean][] = [
    ['desktop', 8, LAYOUT_TEXT, true], ['desktop', 30, LAYOUT_BARE, true], ['desktop', 120, LAYOUT_WHO, false],
    ['terminal', 8, LAYOUT_TEXT, true], ['terminal', 26, LAYOUT_BARE, false], ['terminal', 120, LAYOUT_WHO, false],
  ]
  for (const [surface, bodyColumns, layout, isOldRed] of widths) {
    const where = `${surface} ${bodyColumns} columns`
    const tree = draw(onSurface({ ...EMPTY, log }, surface), bodyColumns)
    expect(logRows(tree).map(logRoles), where).toEqual(Array(4).fill(layout))
    // Only in [time, text] is the text red, and only for an error line (the old one too); no line is ever dim.
    const red = layout === LAYOUT_TEXT ? 'error' : undefined
    expect(colours(tree), where).toEqual([
      [undefined, undefined, 'truncate'], [red, undefined, 'truncate'], [undefined, undefined, 'truncate'],
      [red, undefined, 'truncate'],
    ])
    // With no outcome among the lines the same holds: red in [time, text], plain beside a `who` that is red.
    const bare = draw(onSurface({ ...EMPTY, log: oldErrors }, surface), bodyColumns)
    expect(colours(bare), where).toEqual(Array(2).fill([isOldRed ? 'error' : undefined, undefined, 'truncate']))
  }
})

test('with no outcome drawn the row is [time, who, text] while the text keeps 8 cells, then [time, text]', () => {
  const prompts: LogEntry[] = ['one', 'two', 'three'].map((text, i) => (
    { at: NOW - i * 1000, who: 'you', text, kind: 'info' }
  ))
  // 8 + 13 + 2 + 8 = 31 on the desktop; on the terminal 8 + `who` + 2 + 8: 22 for `main`, 32 for `minimal-change`.
  const edges: [surface: Surface, who: string, bodyColumns: number][] = [
    ['desktop', 'main', 31], ['terminal', 'main', 22], ['terminal', 'minimal-change', 32],
  ]
  for (const [surface, who, from] of edges) {
    const log = prompts.map(line => ({ ...line, who }))
    for (const bodyColumns of [8, from - 1, from, 120]) {
      const where = `${surface} ${who} ${bodyColumns} columns, from ${from}`
      const tree = draw(onSurface({ ...EMPTY, log }, surface), bodyColumns)
      expect(rowProblems(tree), where).toEqual([])
      expect(logRows(tree).map(logRoles), where)
        .toEqual(Array(3).fill(bodyColumns >= from ? ['time', 'who', 'text'] : LAYOUT_TEXT))
      expect(logRows(tree).map(row => textsOf(childrenOf(row)[bodyColumns >= from ? 2 : 1])), where)
        .toEqual([['one'], ['two'], ['three']])
    }
  }
})

// The lines that a row with no cell for `who` labels, and those it leaves alone: a tool's line, a subagent's
// (`engineer` starts like `engine`, `young-dev` like `you`), and one whose type is the longest the terminal keeps. The
// `you` line with an outcome is not one that the mod writes (a prompt has no outcome): it fixes the order of the
// outcome and the label.
const LABEL_LINES: LogEntry[] = [
  { at: NOW, who: 'you', text: 'fix the order qty', kind: 'info' },
  { at: NOW - 1000, who: 'engine', text: 'the build is done', kind: 'info' },
  { at: NOW - 2000, who: 'main', text: 'Bash ls', kind: 'ok', outcome: '✓ 0.3s' },
  { at: NOW - 3000, who: 'engineer', text: 'Edit a.py', kind: 'error', outcome: '✗ 1m 12s' },
  { at: NOW - 4000, who: 'minimal-change', text: 'Read b.py', kind: 'ok', outcome: '✓ 0.1s' },
  { at: NOW - 5000, who: 'you', text: 'a prompt that ran', kind: 'info', outcome: '27.4s' },
  { at: NOW - 6000, who: 'young-dev', text: 'Grep c', kind: 'ok', outcome: '✓ 0.2s' },
]

test('with no cell for `who` a row labels a prompt `you › …` and an engine message `engine › …`, and no other', () => {
  // The text of each line in each layout. In [time, text] the outcome leads, and the label comes after it.
  const textOnly = [
    'you › fix the order qty', 'engine › the build is done', '✓ 0.3s Bash ls', '✗ 1m 12s Edit a.py',
    '✓ 0.1s Read b.py', '27.4s you › a prompt that ran', '✓ 0.2s Grep c',
  ]
  const bare = [
    'you › fix the order qty', 'engine › the build is done', 'Bash ls', 'Edit a.py', 'Read b.py',
    'you › a prompt that ran', 'Grep c',
  ]
  const withWho = [
    'fix the order qty', 'the build is done', 'Bash ls', 'Edit a.py', 'Read b.py', 'a prompt that ran', 'Grep c',
  ]
  // The edges are 41 and 27 on the desktop, 41 and 26 on the terminal (`✗ 1m 12s` is the longest outcome and
  // `minimal-change` the longest name): [time, who, text, outcome] from 41, [time, text, outcome] from 27 or 26, and
  // [time, text] below.
  const widths: [bodyColumns: number, layout: string[], texts: string[]][] = [
    [8, LAYOUT_TEXT, textOnly], [25, LAYOUT_TEXT, textOnly], [30, LAYOUT_BARE, bare], [40, LAYOUT_BARE, bare],
    [41, LAYOUT_WHO, withWho], [120, LAYOUT_WHO, withWho],
  ]
  for (const surface of SURFACES) {
    for (const [bodyColumns, layout, texts] of widths) {
      const where = `${surface} ${bodyColumns} columns`
      const tree = draw(onSurface({ ...EMPTY, log: LABEL_LINES }, surface), bodyColumns)
      expect(logRows(tree).map(logRoles), where).toEqual(Array(LABEL_LINES.length).fill(layout))
      // The outcome and the label are one string with the text, in its one Text, so the cut at its end keeps them.
      expect(logRows(tree).map(row => textsOf(childrenOf(row)[layout.indexOf('text')])), where)
        .toEqual(texts.map(text => [text]))
      expect(rowProblems(tree), where).toEqual([])
    }
  }
})

test('the labels follow the `who` the hooks write: a prompt is `you`, an engine turn `engine`, a tool its caller', SLOW,
  async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    bottom(on, clock)
    await $.session.start(START)
    await $.turn.start({ text: 'fix the order qty', turnId: 't1' })
    await $.turn.start({ text: '<task-notification>done</task-notification>', turnId: 't2' })
    await drive(clock, $.tool.call({ tool: 'Bash', command: 'ls' }))

    // The newest first. At 20 columns the row is [time, text], at 30 [time, text, outcome], at 40 it has `who` as well,
    // on both surfaces.
    const widths: [bodyColumns: number, texts: string[]][] = [
      [20, ['✓ 0.3s Bash ls', 'engine › task-notification', 'you › fix the order qty']],
      [30, ['Bash ls', 'engine › task-notification', 'you › fix the order qty']],
      [40, ['Bash ls', 'task-notification', 'fix the order qty']],
    ]
    for (const surface of SURFACES) {
      for (const [bodyColumns, texts] of widths) {
        const ui = await mountPane($, surface, { ...PANE_PROPS, bodyColumns })
        expect(logRows(await ui.drawn()).map(rowText), `${surface} ${bodyColumns} columns`).toEqual(texts)
        await ui.unmount()
      }
    }
  })

test('the log rows outgrow no pane, with and without outcomes, at the narrowest and the widest body used', () => {
  for (const surface of SURFACES) {
    for (const bodyColumns of [8, 120]) {
      for (const log of [WITH_OUTCOMES, WITH_OUTCOMES.filter(line => line.outcome === undefined)]) {
        const where = `${surface} ${bodyColumns} ${log.length} lines`
        const tree = draw(onSurface({ ...EMPTY, log }, surface), bodyColumns)
        expect(rowProblems(tree), where).toEqual([])
        expect(logRows(tree), where).toHaveLength(log.length)
        for (const row of logRows(tree)) expect(rowProblems(row), where).toEqual([])
      }
    }
    // The check sees the outcome cell: with its width taken off, the cut text has no sized cell to sit in.
    const [row] = logRows(draw(onSurface({ ...EMPTY, log: WITH_OUTCOMES }, surface)))
    const outcome = childrenOf(row)[3]
    if (outcome !== undefined) outcome.props = { ...outcome.props, width: undefined }
    const problems = rowProblems(row)
    expect(problems, surface).toHaveLength(1)
    expect(problems[0], surface).toContain('cut text')
  }
})

// ---- The height of the Log ----

// The kit has no layout engine, so the fill itself was seen on the live desktop: the root as tall as the body at the
// least, the head's 8 lines kept, the tail growing into the rows that are free, the pane scrolling when the content is
// taller. What is pinned here is the tree that was seen there (the visual spec, §6.12 Log height), and the number of
// lines that the panel works out for it (the spec of 0.4.0, §3.2): as many as fit under the blocks above the Log, less
// the row of the line that counts the others.

// The last three children of the pane: the Log's rule and header, then the Box after them (its head, or all its lines);
// and the last four, for a Log whose `+N more` line comes after that.
const lastThree = (tree: Node): Node[] => childrenOf(tree).slice(-3)
const lastFour = (tree: Node): Node[] => childrenOf(tree).slice(-4)
// Whether a Box of height 0, the tail's, is anywhere in the tree.
const hasZeroHeight = (tree: Node): boolean => flat(tree).some(({ node }) => node.props?.height === 0)

const sumOf = (numbers: number[]): number => numbers.reduce((sum, n) => sum + n, 0)
// The cells that a capital A to Z of a chip's name weighs on a surface: the terminal's cells are even, and the desktop
// draws a capital wider (the live check of 2026-10-13: about 9 to 11 px against the 8 px of a cell). The editor and the
// mobile app draw vectors as the desktop does, and are counted as it is.
const CAPITAL_CELLS: Record<RenderSurface, number> = { desktop: 1.5, mobile: 1.5, terminal: 1, vscode: 1.5 }
// The rows a drawn block takes in a body of `columns` cells, counted from its tree alone: a Box with a `height` is that
// tall, a column stacks its cells, a row is as tall as its tallest cell, the chips of MCP wrap whole as chipRows says
// (a capital in a name weighing `capital` cells), and any other element is one line. The panel counts them as it
// builds the blocks, and this counts them again from what it built.
const rowsOf = (node: Node, columns: number, capital: number): number => {
  if (node.type !== 'Box') return 1
  if (typeof node.props?.height === 'number') return node.props.height
  const cells = childrenOf(node)
  if (node.props?.flexWrap === 'wrap') return chipRows(cells.map(chip => textsOf(chip)[1] ?? ''), columns, capital)
  const heights = cells.map(cell => rowsOf(cell, columns, capital))

  return node.props?.flexDirection === 'column' ? sumOf(heights) : Math.max(0, ...heights)
}
// The rows above the Log: those of the children of the pane that come before the Log's rule, which is the child before
// its header. Where the Log is not drawn, all of them. The chips of MCP are counted with the capital of the surface.
const rowsAbove = (tree: Node, columns: number, surface: RenderSurface): number => {
  const blocks = childrenOf(tree)
  const at = blocks.findIndex(block => headerRows(block).some(header => header.id === 'log'))
  const capital = CAPITAL_CELLS[surface]

  return sumOf(blocks.slice(0, at < 0 ? blocks.length : at - 1).map(block => rowsOf(block, columns, capital)))
}
// A pane of a Log and nothing else. Above the Log are the Session card (the Session row and the band) and the
// placeholder of Turn stats (3), and the Log's rule and header make 2 more. `count` is the events there have been:
// the number of the lines, unless a test says otherwise.
const withLog = (log: LogEntry[], count = log.length): PaneData => ({ ...EMPTY, log, logCount: count })
// The rows above the Log of such a pane, by the surface and the columns: 1 + 5 + 3 on the desktop (the band is 5 rows
// below 464 px); on the terminal 1 + 4 + 3 at 20 columns (the core line and 3 grid rows) and 1 + 3 + 3 at 45 (2).
const ABOVE_LOG: Record<Surface, Record<20 | 45, number>> = { desktop: { 20: 9, 45: 9 }, terminal: { 20: 8, 45: 7 } }
// A body of `rows` for the Log at 45 columns: those above it, the Log's rule and header, and `rows`.
const logBody = (surface: Surface, rows: number): number => ABOVE_LOG[surface][45] + 2 + rows

test('the Log is a rule, a header, a head of 8, a tail and a `+N more`, children of a root as tall as the body', () => {
  for (const surface of SURFACES) {
    // The blocks above the Log take 43 rows on the desktop and 41 on the terminal (45 columns, FULL: the band is 5 rows
    // there, and the core line and 2 grid rows here; Turn stats is its ribbon, its legend and its closed details;
    // Activity is 12), and its rule and header 2: a body of 67 rows, or 65, leaves 22 rows, 21 lines and the line that
    // counts the other 116 of the 137 events.
    const [above, bodyRows] = surface === 'desktop' ? [43, 67] : [41, 65]
    const tree = draw(onSurface({ ...FULL, log: logLines(60) }, surface), 45, bodyRows)
    expect(rowsAbove(tree, 45, surface), surface).toBe(above)
    // The root is at least as tall as the body, and has no height of its own.
    expect(tree.props, surface).toStrictEqual({ flexDirection: 'column', minHeight: bodyRows })
    // The Log's five parts are the last children of the root: no Box wraps them.
    expect(childrenOf(tree), surface).toHaveLength(1 + 1 + 5 + 5) // top block, Project, five sections, five Log parts
    const [rule, header, head, tail, more] = childrenOf(tree).slice(-5)
    expect(ruleCount(rule), surface).toBe(1)
    expect(headerRows(header).map(row => [row.id, row.label, row.title]), surface).toEqual([['log', '▾', 'Log']])
    // The head holds its size, and its 8 lines show whatever the room.
    expect(head?.props, surface).toStrictEqual({ flexDirection: 'column', flexShrink: 0 })
    expect(logRows(head).map(rowText), surface).toEqual(named(1, 8))
    // The tail has no height of its own: it grows into the rows the root leaves free and cuts what does not fit at its
    // bottom, so the oldest go. It is the insurance of the count: lines 9 to 21 are what the panel says fit.
    expect(tail?.props, surface).toStrictEqual({
      flexDirection: 'column', height: 0, flexGrow: 1, flexShrink: 1, overflow: 'hidden',
    })
    expect(logRows(tail).map(rowText), surface).toEqual(named(9, 21))
    expect(logRows(tree), surface).toHaveLength(21)
    // The line that counts the rest comes after the tail, and is the last child of the root.
    expect(more, surface).toBe(logMoreLine(tree))
    expect(moreOf(tree), surface).toBe(116)
    // The scan for a Box of height 0, which the tests of a Log with no tail lean on, does see this one.
    expect(hasZeroHeight(tree), surface).toBe(true)
  }
})

test('a body too short for the head keeps the 8 lines and has no tail: the pane scrolls', () => {
  for (const surface of SURFACES) {
    for (const bodyRows of [1, 5]) {
      const where = `${surface} ${bodyRows} rows`
      const tree = draw(onSurface({ ...FULL, log: logLines(60) }, surface), 45, bodyRows)
      // The root is as tall as the body at the least, and grows to its content: the engine scrolls it.
      expect(tree.props, where).toStrictEqual({ flexDirection: 'column', minHeight: bodyRows })
      // The head, with its 8 lines, is followed by the line that counts the rest, and by nothing: no line past the head
      // is in the tree, and no tail. N counts from 8: of the 137 events, 129 do not show.
      const [rule, header, head, more] = lastFour(tree)
      expect(ruleCount(rule), where).toBe(1)
      expect(headerRows(header).map(row => row.id), where).toEqual(['log'])
      expect(head?.props, where).toStrictEqual({ flexDirection: 'column', flexShrink: 0 })
      expect(logRows(head).map(rowText), where).toEqual(named(1, 8))
      expect(more, where).toBe(logMoreLine(tree))
      expect(moreOf(tree), where).toBe(129)
      expect(logRows(tree), where).toHaveLength(8)
      expect(hasZeroHeight(tree), where).toBe(false)
    }
  }
})

test('the Log draws as many lines as fit under the blocks above it, 8 at least, and `+N more` counts the rest', () => {
  // [the rows the body leaves the Log below its rule and header, the lines drawn, the events that `+N more` counts]
  // for 60 events, all of them in the log. Where the rows are all 60 or more, all show and there is no such line. A
  // row less, and a row goes to the line: 59 rows draw 58 lines and `+2 more`, not 59 and `+1 more`. Never fewer than
  // 8 lines, even in a body shorter than the blocks above the Log (less than 0 rows left). A body that is a part of a
  // row more than a number of them (33.5) shows the whole rows, as 33 does.
  const cases = [
    [-6, 8, 52], [-2, 8, 52], [1, 8, 52], [9, 8, 52], [10, 9, 51], [13, 12, 48], [33, 32, 28], [33.5, 32, 28],
    [59, 58, 2], [60, 60, undefined], [93, 60, undefined],
  ] as const
  for (const surface of SURFACES) {
    for (const [rows, drawn, more] of cases) {
      const bodyRows = logBody(surface, rows)
      const where = `${surface} ${bodyRows} rows`
      const tree = draw(onSurface(withLog(logLines(60)), surface), 45, bodyRows)
      const [head, tail] = logBoxes(tree)
      expect(logBoxes(tree), where).toHaveLength(drawn > 8 ? 2 : 1)
      expect(logRows(head).map(rowText), where).toEqual(named(1, Math.min(8, drawn)))
      expect(logRows(tail).map(rowText), where).toEqual(drawn > 8 ? named(9, drawn) : [])
      expect(moreOf(tree), where).toBe(more)
    }
  }
})

test('with no height known the Log is a rule, a header, 15 lines in one Box and `+N more`, and no minimum', () => {
  for (const surface of SURFACES) {
    // A body whose rows are not a positive number: none, not a number, negative, endless.
    for (const bodyRows of [0, Number.NaN, -3, Number.POSITIVE_INFINITY]) {
      const where = `${surface} ${bodyRows} rows`
      const tree = draw(onSurface({ ...FULL, log: logLines(60) }, surface), 45, bodyRows)
      expect(tree.props?.flexDirection, where).toBe('column')
      expect(tree.props?.minHeight, where).toBeUndefined()
      expect(tree.props?.height, where).toBeUndefined()
      // The 15 lines are in one Box at their natural height: a tail would have no room to grow into. The line that
      // counts the rest comes after it: of the 137 events, 122 do not show.
      const [rule, header, lines, more] = lastFour(tree)
      expect(ruleCount(rule), where).toBe(1)
      expect(headerRows(header).map(row => row.id), where).toEqual(['log'])
      expect(lines?.props, where).toStrictEqual({ flexDirection: 'column' })
      expect(logRows(lines).map(rowText), where).toEqual(named(1, 15))
      expect(more, where).toBe(logMoreLine(tree))
      expect(moreOf(tree), where).toBe(122)
      expect(logRows(tree), where).toHaveLength(15)
      expect(hasZeroHeight(tree), where).toBe(false)
    }
  }
})

// The types say a Pane always has `scroll`, but a throw while the pane is drawn blanks it: a Pane handed without it is
// drawn as one whose height is not known, as in 0.2.0.
test('a Pane handed with no `scroll` draws as with no height known, and does not throw', () => {
  for (const surface of SURFACES) {
    const data = onSurface({ ...FULL, log: logLines(60) }, surface)
    const render = (): Node =>
      renderPane(PLAIN_ELEMENTS, data, { bodyColumns: 40 } as never, { onToggle: () => undefined }) as unknown as Node
    expect(render, surface).not.toThrow()
    const tree = render()
    expect(tree.props?.minHeight, surface).toBeUndefined()
    // The Log is the 15 lines of the unknown height, in one Box, and the 122 events past them are counted.
    expect(logBoxes(tree).map(box => logRows(box).length), surface).toEqual([15])
    expect(moreOf(tree), surface).toBe(122)
  }
})

test('with fewer lines than the head holds the Log is a head of them, with no tail and no `+N more`', () => {
  for (const surface of SURFACES) {
    for (const count of [1, 3, 8]) {
      const where = `${surface} ${count} lines`
      // The log holds every event there has been: nothing is left to count, though the body has no room for them.
      const tree = draw(onSurface({ ...FULL, log: logLines(count), logCount: count }, surface), 45, 40)
      expect(tree.props?.minHeight, where).toBe(40)
      const [rule, header, head] = lastThree(tree)
      expect(ruleCount(rule), where).toBe(1)
      expect(headerRows(header).map(row => row.id), where).toEqual(['log'])
      expect(head?.props, where).toStrictEqual({ flexDirection: 'column', flexShrink: 0 })
      expect(logRows(head).map(rowText), where).toEqual(named(1, count))
      expect(logBoxes(tree), where).toHaveLength(1)
      expect(logMoreLine(tree), where).toBeUndefined()
      expect(hasZeroHeight(tree), where).toBe(false)
    }
  }
})

test('a folded Log is its rule and its header, and a Log with no lines is nothing at all', () => {
  for (const surface of SURFACES) {
    const folded = draw(onSurface({ ...FULL, log: logLines(60), collapsed: { log: true } }, surface), 45, 40)
    const [rule, header] = childrenOf(folded).slice(-2)
    expect(ruleCount(rule), surface).toBe(1)
    expect(headerRows(header).map(row => [row.id, row.label, row.title]), surface).toEqual([['log', '▸', 'Log']])
    expect(logRows(folded), surface).toEqual([])
    // A folded Log counts nothing: of its 137 events, no line is drawn and none is left over.
    expect(logMoreLine(folded), surface).toBeUndefined()
    expect(hasZeroHeight(folded), surface).toBe(false)
    expect(folded.props?.minHeight, surface).toBe(40)

    // No lines, folded or not: no rule and no header either, and the pane ends with the Context sources. Its count of
    // 137 is no reason to draw a Log with nothing in it, or a line that counts the rest.
    for (const collapsed of [{}, { log: true }] as Array<Record<string, boolean>>) {
      const empty = draw(onSurface({ ...FULL, log: [], collapsed }, surface), 45, 40)
      expect(headerRows(empty).map(row => row.id), surface).toEqual(['usage', 'turn', 'activity', 'mcp', 'sources'])
      expect(childrenOf(empty), surface).toHaveLength(1 + 1 + 5) // the top block, the Project block, five sections
      expect(ruleCount(empty), surface).toBe(6)
      expect(moreOf(empty), surface).toBeUndefined()
      expect(empty.props?.minHeight, surface).toBe(40)
    }
  }
})

test('the Log header shows the count of all the events, not the lines the log holds, folded or not', () => {
  // The log holds fewer lines than its count: 60 lines of 65 events, and the header still counts all 65.
  const data = { ...FULL, log: logLines(60), logCount: 65 }
  for (const surface of SURFACES) {
    for (const collapsed of [{}, { log: true }] as Array<Record<string, boolean>>) {
      const header = headerRows(draw(onSurface({ ...data, collapsed }, surface), 45, 40)).at(-1)
      expect([header?.id, header?.summary], `${surface} ${JSON.stringify(collapsed)}`).toEqual(['log', '65'])
    }
  }
})

test('a count behind the lines the log holds is taken up to them: the header and `+N more` have 20, not 5', () => {
  // A session that began on an earlier build and has this one loaded into it has lines on its log that the count never
  // saw: it starts at 0 with the lines already there. The Log's events are then the lines it holds at the least.
  for (const surface of SURFACES) {
    for (const count of [0, 5]) {
      const where = `${surface} count ${count}`
      const log = logLines(20)
      // 80 rows leave the Log room for all 20 lines and the header counts them; a body that leaves it 13 rows draws 12
      // lines, and the 8 that are not drawn are counted from 20, not from 5.
      const tall = draw(onSurface(withLog(log, count), surface), 45, 80)
      expect(headerRows(tall).at(-1)?.summary, where).toBe('20')
      expect(logRows(tall), where).toHaveLength(20)
      expect(logMoreLine(tall), where).toBeUndefined()

      const tight = draw(onSurface(withLog(log, count), surface), 45, logBody(surface, 13))
      expect(headerRows(tight).at(-1)?.summary, where).toBe('20')
      expect(logRows(tight), where).toHaveLength(12)
      expect(moreOf(tight), where).toBe(8)
      // A folded Log has the same count in its header.
      const folded = draw(onSurface({ ...withLog(log, count), collapsed: { log: true } }, surface), 45, 20)
      expect(headerRows(folded).at(-1)?.summary, where).toBe('20')
    }
  }
})

test('the columns of the Log are worked out over every line drawn, the tail\'s as well as the head\'s', () => {
  // Line 30 is the only one with the longest outcome and the longest `who`. It is drawn where the Log has 33 rows, not
  // where it has 13.
  const log = logLines(60, i => (i === 29 ? { who: 'minimal-change', outcome: '✗ 1m 12s' } : { outcome: '✓ 0.1s' }))
  for (const surface of SURFACES) {
    const isDesktop = surface === 'desktop'
    // [the rows the body leaves the Log below its rule and header, the lines drawn, the cells of the outcome column,
    // the cells of the `who` column]. One of the rows is the `+N more` line's: 33 rows draw 32 lines, line 30 among
    // them, and 13 rows draw 12. The outcome column is as wide as the longest outcome drawn (`✗ 1m 12s` is 8, `✓ 0.1s`
    // is 6), a cell more on the desktop. The `who` column is the longest name on the terminal, 13 cells on the desktop.
    const cases = [
      [33, 32, isDesktop ? 9 : 8, isDesktop ? 13 : 14], [13, 12, isDesktop ? 7 : 6, isDesktop ? 13 : 3],
    ] as const
    for (const [rows, drawn, outcomeCells, whoCells] of cases) {
      const bodyRows = logBody(surface, rows)
      const where = `${surface} ${bodyRows} rows`
      // One layout for every row, the head's and the tail's alike.
      const columns = logColumns(draw(onSurface(withLog(log), surface), 45, bodyRows))
      expect(columns, where).toHaveLength(drawn)
      expect(columns.map(column => column.outcomeCell?.props?.width), where).toEqual(Array(drawn).fill(outcomeCells))
      expect(columns.map(column => column.whoCells), where).toEqual(Array(drawn).fill(whoCells))
    }
  }
})

test('the rows of the head and of the tail outgrow no pane, at the narrowest and the widest body used', () => {
  for (const surface of SURFACES) {
    for (const bodyColumns of [8, 120]) {
      const where = `${surface} ${bodyColumns} columns`
      // The 16 lines of FULL, with texts too long for any pane and outcomes of every kind: a head of 8, a tail of 8. A
      // body of 100 rows leaves the Log room for all of them, and the 121 events past them are counted.
      const tree = draw(onSurface(FULL, surface), bodyColumns, 100)
      const [head, tail] = logBoxes(tree)
      expect(moreOf(tree), where).toBe(121)
      expect(logRows(head), where).toHaveLength(8)
      expect(logRows(tail), where).toHaveLength(8)
      expect(rowProblems(tree), where).toEqual([])
      for (const part of [head, tail]) {
        expect(rowProblems(part), where).toEqual([])
        for (const row of logRows(part)) expect(rowProblems(row), where).toEqual([])
      }
    }
    // The check sees the tail: with the width of an outcome cell taken off, the cut text has no sized cell to sit in.
    const [, tail] = logBoxes(draw(onSurface(FULL, surface), 45, 100))
    const [row] = logRows(tail)
    expect(childrenOf(row), surface).toHaveLength(4)
    const outcome = childrenOf(row)[3]
    if (outcome !== undefined) outcome.props = { ...outcome.props, width: undefined }
    const problems = rowProblems(row)
    expect(problems, surface).toHaveLength(1)
    expect(problems[0], surface).toContain('cut text')
  }
})

// What the blocks above the Log take is counted by the builders of the blocks, from the rows they put in the tree, and
// the Log has the rest. These are those rows for FULL with two short MCP servers: codebase-memory is 17 cells (its dot
// and its name) and issue-hub 11, with the 2 cells between the chips 30, and a line of chips holds the body less 2. So
// the chips are one row at 32 columns and two at 31. The Log of it holds 60 lines of 137 events.
//   Session card 7 (the Session row, the band's 5, the cost split; 6 on the terminal, whose band is 4 rows), Project 4
//   (rule, title, branch, changes), Usage 6 (rule, header, 4 limits), Turn stats 5 (rule, header, the ribbon, its
//   legend, the closed details; 10 figures more with them open), Activity 12 (rule, header, main's lane and 7 more,
//   the axis, `+3 more`), MCP 3 (rule, header, the chips), Context sources 4 (rule, header, 2 figures): 41, 40 on the
//   terminal.
const SHORT_MCP = { servers: [{ name: 'codebase-memory' }, { name: 'issue-hub' }] }
const SURROUNDED: PaneData = { ...FULL, mcp: SHORT_MCP, log: logLines(60) }
const agentsOf = (rows: AgentRow[]): PaneData['agents'] => Object.fromEntries(rows.map(row => [row.id, row]))
const tasksOf = (rows: TaskRow[]): PaneData['tasks'] => Object.fromEntries(rows.map(row => [row.id, row]))
// Ten tasks, b1 the newest and b10 the oldest, and b3 and b5 run. Drawn after main's lane: b5 and b3, which run, the
// older start first, then the others, which all ended at one time, in their order: b1, b2, b4, b6 and b7. The lanes
// of b8, b9 and b10 are counted in `+3 more`.
const TEN: TaskRow[] = Array.from({ length: 10 }, (_, i) => task(i + 1, i === 2 || i === 4 ? 'running' : 'done'))
// A task of each status, in the order they are drawn: the one that runs, then the others, newest start first.
const EVERY_STATUS: TaskStatus[] = ['running', 'done', 'failed', 'stopped', 'ended']
const EACH_STATUS: TaskRow[] = EVERY_STATUS.map((status, i) => task(i + 1, status))
const FOLDED_ABOVE = Object.fromEntries(SECTIONS.slice(0, 5).map(id => [id, true])) // the sections above the Log

type Counts = [above: number, drawn: number, more: number]
type Surrounding = [
  name: string, patch: Partial<PaneData>, bodyColumns: number, bodyRows: number, desktop: Counts, terminal: Counts,
]
// What each block gives the Log, by what changes in the blocks above it, on each surface: the rows above, the lines
// drawn (the body's rows less the rows above, less 2 for the Log's rule and header, less 1 for `+N more`; never fewer
// than 8) and the events counted (137 less the lines). At 31 and 32 columns the Session band is 5 rows on the desktop
// and 4 on the terminal (the core line and 3 grid rows), so the terminal has a row less above the Log.
const SURROUNDINGS: Surrounding[] = [
  ['every block, a body of 40: not even 8 lines fit', {}, 32, 40, [41, 8, 129], [40, 8, 129]],
  ['every block, a body of 60', {}, 32, 60, [41, 16, 121], [40, 17, 120]],
  ['every block, a body of 70', {}, 32, 70, [41, 26, 111], [40, 27, 110]],
  ['the MCP chips in two rows', {}, 31, 60, [42, 15, 122], [41, 16, 121]],
  [
    'seven subagents, so no `+N more` of theirs', { agents: agentsOf(AGENTS.slice(0, 7)) }, 32, 60,
    [40, 17, 120], [39, 18, 119],
  ],
  ['three subagents', { agents: agentsOf(AGENTS.slice(0, 3)) }, 32, 60, [36, 21, 116], [35, 22, 115]],
  ['no subagents, and no cost split with them', { agents: {} }, 32, 60, [28, 29, 108], [27, 30, 107]],
  // With no subagents, the tasks alone make Activity: its rule, its header, main's lane, theirs (7 at the most), the
  // axis and the line that counts the rest, to the 28 (27 on the terminal).
  ['one task: 5 rows more', { agents: {}, tasks: tasksOf(TEN.slice(0, 1)) }, 32, 70, [33, 34, 103], [32, 35, 102]],
  ['three tasks: 7 rows more', { agents: {}, tasks: tasksOf(TEN.slice(0, 3)) }, 32, 70, [35, 32, 105], [34, 33, 104]],
  [
    'ten tasks: 8 lanes, the axis and `+3 more`, 12 rows more', { agents: {}, tasks: tasksOf(TEN) }, 32, 70,
    [40, 27, 110], [39, 28, 109],
  ],
  [
    'ten tasks, folded: their rule and header, 2 rows more',
    { agents: {}, tasks: tasksOf(TEN), collapsed: { activity: true } }, 32, 70, [30, 37, 100], [29, 38, 99],
  ],
  ['no Usage', { usage: { ...FULL.usage, rateLimits: [] } }, 32, 60, [35, 22, 115], [34, 23, 114]],
  ['no Project block', { project: { name: '', branch: null, changes: null } }, 32, 60, [37, 20, 117], [36, 21, 116]],
  [
    'Turn stats with its details open: 10 rows more', { collapsed: { turnDetails: false } }, 32, 70,
    [51, 16, 121], [50, 17, 120],
  ],
  ['no completed turn: a placeholder of one row', { lastTurn: null }, 32, 60, [39, 18, 119], [38, 19, 118]],
  ['Turn stats folded: its rule and its header', { collapsed: { turn: true } }, 32, 60, [38, 19, 118], [37, 20, 117]],
  // The band keeps its rows with no reading: only its figures read —.
  [
    'no context reading: the band keeps its rows', { usage: { ...FULL.usage, contextPct: undefined } }, 32, 60,
    [41, 16, 121], [40, 17, 120],
  ],
  ['every section above the Log folded', { collapsed: FOLDED_ABOVE }, 32, 40, [21, 16, 121], [20, 17, 120]],
]

test('the Log has the rows that the blocks above it leave, whatever they are, and the rows are the trees\'', () => {
  for (const surface of SURFACES) {
    for (const [name, patch, bodyColumns, bodyRows, desktop, terminal] of SURROUNDINGS) {
      const [above, drawn, more] = surface === 'desktop' ? desktop : terminal
      const where = `${surface}: ${name}`
      const tree = draw(onSurface({ ...SURROUNDED, ...patch }, surface), bodyColumns, bodyRows)
      // What the blocks above take, counted again from their trees: the number the Log works from is true.
      expect(rowsAbove(tree, bodyColumns, surface), where).toBe(above)
      expect(logRows(tree), where).toHaveLength(drawn)
      expect(moreOf(tree), where).toBe(more)
    }
  }
})

// A capital weighs what its surface draws it as: a cell on the terminal, whose cells are even, and 1.5 on the desktop,
// whose font is proportional (chipRows); the editor and the mobile app, which draw vectors too, are counted as the
// desktop is. Two names in capitals at the edge of a line are one row of chips on the terminal where they are two on
// the others, and the Log has the row that the terminal does not take. `GITHUB` and `SLACK` are 17 cells at 1 with the
// gap between them, so 19 columns hold them, and 23 at 1.5, so 25 columns do.
const CAPITAL_MCP = { servers: [{ name: 'GITHUB' }, { name: 'SLACK' }] }

test('the chips of MCP are counted with the capital of the surface: a cell on the terminal, 1.5 on the desktop', () => {
  // [the columns, the surface, the rows above the Log, the lines it draws in a body of 60 rows, the events it counts]:
  // the blocks above the Log are 41 rows on the desktop (the band is 5 rows) and 40 on the terminal (the core line and
  // 3 grid rows) with the chips in one row (SURROUNDED), and a row more with them in two. The editor and the mobile
  // app draw the desktop's band; they are drawn where 1 and 1.5 differ, 24 and 19 columns, and count as the desktop
  // does.
  const cases = [
    [25, 'terminal', 40, 17, 120], [25, 'desktop', 41, 16, 121],
    [24, 'terminal', 40, 17, 120], [24, 'desktop', 42, 15, 122],
    [24, 'vscode', 42, 15, 122], [24, 'mobile', 42, 15, 122],
    [19, 'terminal', 40, 17, 120], [19, 'desktop', 42, 15, 122],
    [19, 'vscode', 42, 15, 122], [19, 'mobile', 42, 15, 122],
    [18, 'terminal', 41, 16, 121], [18, 'desktop', 42, 15, 122],
  ] as const
  for (const [columns, surface, above, drawn, more] of cases) {
    const where = `${surface} ${columns} columns`
    const tree = draw(onSurface({ ...SURROUNDED, mcp: CAPITAL_MCP }, surface), columns, 60)
    // The count that the Log works from is the number of the rows above, and the rows are counted again from the tree.
    expect(rowsAbove(tree, columns, surface), where).toBe(above)
    expect(logRows(tree), where).toHaveLength(drawn)
    expect(moreOf(tree), where).toBe(more)
  }
})

const TURN = FULL.lastTurn as TurnStats
const MATRIX: Array<[name: string, data: PaneData]> = [
  ['every block', FULL],
  ['short MCP names', SURROUNDED],
  ['no Usage', { ...FULL, usage: { ...FULL.usage, rateLimits: [] } }],
  ['no Project block', { ...FULL, project: { name: '', branch: null, changes: null } }],
  ['a project with no branch and no changes', { ...FULL, project: { name: 'repo', branch: null, changes: null } }],
  ['no completed turn', { ...FULL, lastTurn: null }],
  [
    'a turn with few figures',
    {
      ...FULL,
      lastTurn: {
        ...TURN, responseRate: null, wholeTurnRate: null, ttftMs: null, steps: 1, cachePct: null, costUsd: null,
      },
    },
  ],
  ['no context reading', { ...FULL, usage: { ...FULL.usage, contextPct: undefined } }],
  ['no total', { ...FULL, usage: { ...FULL.usage, costUsd: undefined } }],
  ['eight subagents', { ...FULL, agents: agentsOf(AGENTS.slice(0, 8)) }],
  ['no subagents', { ...FULL, agents: {} }],
  ['three tasks', { ...FULL, tasks: tasksOf(TEN.slice(0, 3)) }],
  ['ten tasks among the lanes', { ...FULL, tasks: tasksOf(TEN) }],
  ['ten tasks and no subagents', { ...FULL, agents: {}, tasks: tasksOf(TEN) }],
  ['ten tasks, folded', { ...FULL, tasks: tasksOf(TEN), collapsed: { activity: true } }],
  ['no MCP servers', { ...FULL, mcp: null }],
  ['no skills and no MCP: no Context sources', { ...FULL, usage: { ...FULL.usage, skills: undefined }, mcp: null }],
  ['Usage and MCP folded', { ...FULL, collapsed: { usage: true, mcp: true } }],
  ['every section above the Log folded', { ...FULL, collapsed: FOLDED_ABOVE }],
  ['nothing but the Log', EMPTY],
]

test('the Log fills the body: no line is cut, and no row is left that a line could have taken', () => {
  // [the lines the log holds, the events there have been]: a full buffer of many events, a log of every event, and a
  // count that is behind the lines.
  const logs = [[60, 137], [20, 20], [20, 5]] as const
  for (const surface of SURFACES) {
    for (const [name, base] of MATRIX) {
      for (const [held, count] of logs) {
        for (const bodyColumns of [20, 45, 120]) {
          for (const bodyRows of [10, 40, 60, 100]) {
            const where = `${surface}: ${name}, ${held} lines of ${count} events, ${bodyColumns}x${bodyRows}`
            const data = { ...base, log: logLines(held), logCount: count }
            const tree = draw(onSurface(data, surface), bodyColumns, bodyRows)
            const drawn = logRows(tree).length
            const more = moreOf(tree)
            // The events there are: the count, or the lines the log holds when the count is behind them.
            const total = Math.max(count, held)
            // The rows the pane takes with every line one row high: what is above, the rule and header of the Log, its
            // lines, and the line that counts the rest.
            const natural = rowsAbove(tree, bodyColumns, surface) + 2 + drawn + (more === undefined ? 0 : 1)

            // `+N more` counts the events that are not drawn, and is there when there are any.
            expect(drawn, where).toBeLessThanOrEqual(held)
            expect(more, where).toBe(total > drawn ? total - drawn : undefined)
            // No line is cut: the pane is no taller than the body, unless the Log is at its least, 8 lines: the pane
            // scrolls then.
            if (drawn > 8) expect(natural, where).toBeLessThanOrEqual(bodyRows)
            // No row is wasted: where lines are held back for the rows, they fill the body to its last row.
            if (more !== undefined && drawn > 8 && drawn < held) expect(natural, where).toBe(bodyRows)
            // At 8 lines, a 9th would not have fitted.
            if (more !== undefined && drawn === 8 && held > 8) expect(natural, where).toBeGreaterThanOrEqual(bodyRows)
          }
        }
      }
    }
  }
})

test('the line that counts the rest is a dim Text, indented past a mark\'s slot, in a row that holds its size', () => {
  for (const surface of SURFACES) {
    // FULL at 67 rows (65 on the terminal, whose band is 2 rows shorter) draws 21 lines and counts the other 116 of
    // its 137 events; its Activity counts 3.
    const tree = draw(onSurface({ ...FULL, log: logLines(60) }, surface), 45, surface === 'desktop' ? 67 : 65)
    const more = logMoreLine(tree)
    const indent = surface === 'desktop' ? 3 : 2
    // The last child of the pane, after the tail, and no cell of a row: the tail's growing leaves it its row.
    expect(childrenOf(tree).at(-1), surface).toBe(more)
    expect(childrenOf(tree).at(-2)?.props?.height, surface).toBe(0)
    expect(more?.props, surface).toStrictEqual({ flexDirection: 'row', paddingLeft: indent, flexShrink: 0 })
    // One Text of the count, dim, with no colour and no cut.
    expect(childrenOf(more).map(el => [el.type, textsOf(el), ...styleOf(el)]), surface).toEqual([
      ['Text', ['+116 more'], undefined, true, undefined],
    ])
    // Activity's own line is at column 0 (spec 0.7.0 §6.4): a plain Box on the desktop, a line of one span on the
    // terminal.
    const activityMore = activityBody(tree).at(-1)
    expect(spanTexts(activityMore), surface).toEqual(['+3 more'])
    if (surface === 'desktop') expect(activityMore?.props, surface).toStrictEqual({ flexDirection: 'row' })
    // N is the events not drawn: the 21 lines and 116 are the 137.
    expect(logRows(tree).length + 116, surface).toBe(137)
    // The row check passes the new line, and the pane with it.
    expect(rowProblems(tree), surface).toEqual([])
  }
})

test('a count past the lines the log holds keeps its `+N more`: 60 lines held, and the rest counted, any body', () => {
  for (const surface of SURFACES) {
    // 100 events, the newest 60 of them held by the log. The Log has the body's rows less 7: with 107 it has room for
    // all 100 events and with 90 for 83, and with no height known 15 are drawn. Only 60 lines are held, whatever the
    // room.
    for (const [bodyRows, drawn] of [[90, 60], [106, 60], [107, 60], [200, 60], [0, 15]] as const) {
      const where = `${surface} ${bodyRows} rows`
      const tree = draw(onSurface(withLog(logLines(60), 100), surface), 45, bodyRows)
      expect(logRows(tree), where).toHaveLength(drawn)
      expect(moreOf(tree), where).toBe(100 - drawn)
    }
  }
})

// The header row of each section: the Box that holds its fold Button.
const headerBoxes = (tree: unknown): Node[] =>
  flat(tree).map(({ node }) => node).filter(node => (
    childrenOf(node).some(cell => String(cell.props?.key).startsWith('toggle:'))
  ))

test('a section is a column Box of its rule, its header and its body, and folded of its rule and its header', () => {
  const allFolded = Object.fromEntries(SECTIONS.map(id => [id, true]))
  for (const surface of SURFACES) {
    for (const collapsed of [{}, allFolded]) {
      const isOpen = Object.keys(collapsed).length === 0
      const tree = draw(onSurface({ ...FULL, collapsed }, surface))
      // The five sections above the Log, after the top block and the Project block.
      const sections = childrenOf(tree).slice(2, 7)
      expect(sections, surface).toHaveLength(5)
      sections.forEach((section, i) => {
        const where = `${surface} ${SECTIONS[i]} ${isOpen ? 'open' : 'folded'}`
        const [rule, header, body, ...rest] = childrenOf(section)
        expect(section.props, where).toStrictEqual({ flexDirection: 'column' })
        expect(ruleCount(rule), where).toBe(1)
        expect(headerRows(header).map(row => row.id), where).toEqual([SECTIONS[i]])
        expect(body?.props, where).toStrictEqual(isOpen ? { flexDirection: 'column' } : undefined)
        expect(rest, where).toEqual([])
      })
      // Every header is one and the same row, the Log's too: it centres its cells, a cell apart.
      expect(headerBoxes(tree).map(box => box.props), surface).toEqual(
        Array(6).fill({ flexDirection: 'row', alignItems: 'center', columnGap: 1 }),
      )
    }
  }
})

test('a header is an icon, a bold title, a dim chevron that folds, and a summary pushed to the right', () => {
  for (const surface of SURFACES) {
    const rows = headerRows(draw(onSurface(FULL, surface)))
    expect(rows.map(row => row.id), surface).toEqual([...SECTIONS])
    expect(rows.map(row => row.title), surface).toEqual(TITLES)
    expect(rows.map(row => row.summary), surface).toEqual([
      '5-hour 3%', '~62 tok/s', '2/10', '3', '77 skills · 3 MCP', '137',
    ])
    for (const { cells, label, title: name } of rows) {
      // On the desktop an icon slot comes first; the terminal draws none.
      const [slot, title, chevron, summary, ...rest] = surface === 'desktop' ? cells : [undefined, ...cells]
      expect(rest, surface).toEqual([])
      if (surface === 'desktop') {
        expect(slot?.props, surface).toMatchObject({ flexShrink: 0, width: 2 })
        // The desktop draws no image whose alt is empty: the icon carries the title that is drawn in bold beside it.
        expect(childrenOf(slot).map(image => [image.type, image.props?.alt, image.props?.width, image.props?.height]))
          .toEqual([['Svg', name, 14, 14]])
        expect(textsOf(title), surface).toEqual([name])
      }
      // The title holds its size, so it is never cut; it is a Text, in bold.
      expect(isFixed(title), surface).toBe(true)
      expect(childrenOf(title).map(el => [el.type, el.props?.bold]), surface).toEqual([['Text', true]])
      // The chevron is the Button that folds: plain, dim at rest.
      expect(chevron?.type, surface).toBe('Button')
      expect(chevron?.props, surface).toMatchObject({ plain: true, dimColor: true })
      expect(label, surface).toBe('▾')
      // The summary takes the room that is left, at the right edge, and gives way before the title does.
      expect(summary?.props, surface).toMatchObject({
        flexGrow: 1, flexShrink: 1, minWidth: 0, overflow: 'hidden', justifyContent: 'flex-end',
      })
    }
  }
})

test('the desktop draws an icon for each section, the branch and the changes; the terminal draws no image', () => {
  const isIcon = (source: string): boolean => /^<svg [^>]*width="14" height="14"[\s\S]*<\/svg>$/.test(source)
  const desktop = draw(onSurface(FULL, 'desktop'))
  const icons = headerRows(desktop).map(row => String(childrenOf(row.cells[0])[0]?.props?.source))
  // Six sections, six icons, no two alike, each an SVG document of its own.
  expect(icons.every(isIcon)).toBe(true)
  expect(new Set(icons).size).toBe(6)
  // The branch and the changes have an icon each, of their own, and no emoji. The header of the block has none.
  const [, header, branch, changes] = childrenOf(projectOf(desktop))
  expect(flat(header).filter(({ node }) => node.type === 'Svg')).toEqual([])
  const rowIcons = [branch, changes].map(row => String(childrenOf(childrenOf(row)[0])[0]?.props?.source))
  expect(rowIcons.every(isIcon)).toBe(true)
  expect(new Set([...icons, ...rowIcons]).size).toBe(8)
  expect(JSON.stringify(desktop)).not.toMatch(/📁|🌿|📝/u)

  const terminal = draw(onSurface(FULL, 'terminal'))
  expect(flat(terminal).filter(({ node }) => node.type === 'Svg')).toEqual([])
  expect(JSON.stringify(terminal)).not.toContain('<svg')
  // The rows are v1's kind of line: an emoji and the text, in a row of their own.
  const [, , branchLine, changesLine] = childrenOf(projectOf(terminal))
  expect(textsOf(branchLine)).toEqual([`🌿 ${BRANCH}`])
  expect(textsOf(changesLine)).toEqual(['📝 12 files changed', '+1204', SEP, `${MINUS}387`])
})

// The desktop drops an Svg whose alt is empty without a word: the validator accepts the tree, the image is not drawn
// and its slot and margins stay. So every image carries a label: a meter its percent, the rest the label of their row.
test('every image on the desktop has a non-empty alt, so none of them is dropped', () => {
  const alts = (tree: unknown): unknown[] =>
    flat(tree).filter(({ node }) => node.type === 'Svg').map(({ node }) => node.props?.alt)
  const everyKind = (['running', 'done', 'failed', 'stopped'] as const).map((status, i) => agent(20 + i, status))
  const statuses = { ...FULL, agents: Object.fromEntries(everyKind.map(row => [row.id, row])) }
  const folded = { ...FULL, collapsed: Object.fromEntries(SECTIONS.map(id => [id, true])) }
  const tasked = { ...FULL, tasks: tasksOf(EACH_STATUS) }
  const cases: Array<[name: string, data: PaneData]> = [
    ['full', FULL], ['a subagent of every status', statuses], ['a task of every status', tasked], ['folded', folded],
    ['empty', EMPTY],
  ]

  // At the narrowest and the widest body the tests use.
  for (const bodyColumns of [8, 120]) {
    for (const [name, data] of cases) {
      const images = alts(draw(onSurface(data, 'desktop'), bodyColumns))
      expect(images.length, `${name} at ${bodyColumns} columns`).toBeGreaterThan(0)
      for (const alt of images) {
        const isLabelled = typeof alt === 'string' && alt.trim() !== ''
        expect(isLabelled, `${name} at ${bodyColumns} columns: alt ${JSON.stringify(alt)}`).toBe(true)
      }
    }
  }

  // The top block: the band's image says the context and every station, with a reading and without one. The Project
  // block has its rule, then an icon for the branch and one for the changes, each saying what its row is.
  const [top, project, ...rest] = childrenOf(draw(onSurface(FULL, 'desktop')))
  expect(alts(top)).toEqual([
    'Context 88%, 529k of 600k. Model 0, 2 running; Files 0; Shell 0; Web 0; Agents 0, 2 running; MCP 0; Skills 0;' +
      ' You 0.',
  ])
  expect(alts(project)).toEqual(['rule', 'Branch', 'Changes'])
  expect(alts(childrenOf(draw(onSurface(EMPTY, 'desktop')))[0])).toEqual([EMPTY_BAND_ALT])
  // Each section: its rule, then its icon, which says the title drawn in bold beside it. The Log's parts are children
  // of the pane: its rule, its header with the icon, then its head and its `+N more` line, which have no image (the
  // body of 20 rows leaves no room for a tail).
  expect(rest.slice(0, 5).map(section => alts(section).slice(0, 2))).toEqual(
    TITLES.slice(0, 5).map(title => ['rule', title]),
  )
  expect(rest.slice(5).map(alts)).toEqual([['rule'], ['Log'], [], []])
  expect(alts(draw(onSurface(EMPTY, 'desktop')))).toEqual([EMPTY_BAND_ALT, 'rule', 'Turn stats'])
  // A lane's image says its label, its tag, its status and its value; then comes the axis's.
  const activity = childrenOf(draw(onSurface(statuses, 'desktop')))[4]
  expect(alts(activity).slice(2, -1)).toEqual([
    'main, done, $138.59', 'task 20 (@code-reviewer), running, $2.50', 'task 21 (@code-reviewer), done, $2.50',
    'task 22 (@code-reviewer), failed, $2.50', 'task 23 (@code-reviewer), stopped, $2.50',
  ])
  expect(String(alts(activity).at(-1))).toMatch(/^axis \d\d:\d\d to now$/)
  // Only a meter's alt ends in a percent (the band's ends in a full stop), so the `/%$/` filter of the tests finds the
  // meters and nothing else.
  expect(alts(draw(onSurface(FULL, 'desktop'))).filter(alt => /%$/.test(String(alt)))).toEqual([
    '5-hour 3%', 'Weekly 84%', 'Spend 120%', 'some_new_window 5%',
  ])
})

test('the divider is an image cut by its Box on the desktop and a text rule on the terminal', () => {
  const rules = flat(draw(onSurface(FULL, 'desktop'))).filter(({ node }) => isRuleNode(node))
  expect(rules).toHaveLength(7) // the Project block and the six sections
  for (const { node, parent } of rules) {
    // A line 1 px tall, centred in a clipping Box one line high; it is wider than a pane maximized on a 21:9 monitor,
    // so the Box cuts it. The Box has no margin: a margin is about 8 px, not a line, so a rule built from margins is
    // not a whole line.
    expect(node.props).toMatchObject({ height: 1, alt: 'rule' })
    expect(parent?.props).toMatchObject({ height: 1, alignItems: 'center', overflow: 'hidden' })
    expect(Object.keys(parent?.props ?? {}).filter(key => key.startsWith('margin'))).toEqual([])
    expect(String(node.props?.source)).toContain('preserveAspectRatio="none"')
  }

  for (const bodyColumns of [20, 45]) {
    const lines = flat(draw(onSurface(FULL, 'terminal'), bodyColumns)).filter(({ node }) => isRuleNode(node))
    // One row each, as wide as the body, dim, with no margin.
    expect(lines).toHaveLength(7)
    for (const { node, parent } of lines) {
      expect(textsOf(node)[0]).toBe('─'.repeat(bodyColumns))
      expect(node.props).toMatchObject({ dimColor: true, wrap: 'truncate' })
      expect(parent?.type).toBe('Box')
      expect(parent?.props?.marginTop).toBeUndefined()
    }
  }
})

// `'─'.repeat` throws on a negative count, and a throw while the pane is drawn blanks the whole pane.
test('a body of 0 columns, or fewer, draws an empty rule on the terminal and does not throw', () => {
  for (const bodyColumns of [0, -1, -40]) {
    for (const data of [FULL, EMPTY]) {
      const tree = draw(onSurface(data, 'terminal'), bodyColumns)
      // Every block has its rule, empty: the Project block's and each section's, the Log's among them (a child of the
      // pane, ahead of its header). The Turn stats section alone is the empty pane's.
      expect(emptyRules(tree).length, `${bodyColumns} columns`).toBe(data === FULL ? 7 : 1)
      expect(ruleCount(tree), `${bodyColumns} columns`).toBe(0)
    }
    // The desktop keeps the least width of its meters, and the band's image is 1 px at the least, so no image gets a
    // negative or a zero width.
    const images = flat(draw(onSurface(FULL, 'desktop'), bodyColumns)).filter(({ node }) => node.type === 'Svg')
    const widths = images.filter(({ node }) => /%$/.test(String(node.props?.alt))).map(({ node }) => node.props?.width)
    expect(widths, `${bodyColumns} columns`).toEqual([40, 40, 40, 40])
    const band = images.find(({ node }) => /^Context (—|\d)/.test(String(node.props?.alt)))
    expect([band?.node.props?.width, band?.node.props?.height], `${bodyColumns} columns`).toEqual([1, 95])
  }
})

test('the engine draws a terminal body of 0 columns, or fewer, with empty rules', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  await seed($, clock, bottom(on, clock))

  for (const bodyColumns of [0, -3]) {
    // `drawn` rejects with the engine's refusal when its validation does not accept the tree.
    const ui = await mountPane($, 'terminal', { ...PANE_PROPS, bodyColumns })
    // The Project block and the six sections, the Log's rule among them: seven rules, and none with a `─` in it.
    const tree = await ui.drawn()
    expect(emptyRules(tree), `${bodyColumns} columns`).toHaveLength(7)
    expect(ruleCount(tree), `${bodyColumns} columns`).toBe(0)
    await ui.unmount()
  }
})

test('the sections come in order, each beginning with its own rule, and a left-out section leaves no rule', () => {
  for (const surface of SURFACES) {
    const tree = draw(onSurface(FULL, surface))
    // The top block comes first, with no rule above it and no Button to fold it; then the Project block, which has a
    // rule of its own and no Button either; then the five sections above the Log. The Log is no Box of its own: its
    // rule, its header, its head and its `+N more` line come after them, children of the pane (the body of 20 rows
    // leaves no room for a tail, and FULL has more events than it has lines to show).
    const [top, project, ...rest] = childrenOf(tree)
    const sections = rest.slice(0, 5)
    expect(ruleCount(top), surface).toBe(0)
    expect(flat(top).some(({ node }) => node.type === 'Button'), surface).toBe(false)
    expect(project, surface).toBe(projectOf(tree))
    expect(ruleCount(project), surface).toBe(1)
    expect(flat(project).some(({ node }) => node.type === 'Button'), surface).toBe(false)
    expect(rest, surface).toHaveLength(5 + 4)
    // Each section is its rule, then its header, then its body.
    expect(sections.map(section => [ruleCount(childrenOf(section)[0]), childrenOf(section).length]), surface).toEqual(
      Array(5).fill([1, 3]),
    )
    expect(headerRows(tree).slice(0, 5).map(row => row.section), surface).toEqual(sections)
    // The Log's header is a child of the pane, after the Log's rule; its head follows, and the line that counts the
    // rest is the last child of the pane.
    expect(ruleCount(rest[5]), surface).toBe(1)
    expect(headerRows(rest[6]).map(row => row.id), surface).toEqual(['log'])
    expect(logRows(rest[7]), surface).toHaveLength(8)
    expect(rest[8], surface).toBe(logMoreLine(tree))
    expect(headerRows(tree).at(-1)?.section, surface).toBe(tree)

    // Fold two of them: the rule and the header stay, the body goes, the summary stays.
    const foldedTree = draw(onSurface({ ...FULL, collapsed: { turn: true, log: true } }, surface))
    const folded = headerRows(foldedTree)
    expect(folded.map(row => row.label), surface).toEqual(['▾', '▸', '▾', '▾', '▾', '▸'])
    expect(folded.slice(0, 5).map(row => childrenOf(row.section).length), surface).toEqual([3, 2, 3, 3, 3])
    // The Log folded is its rule and its header, the last two children of the pane, and no line.
    expect(childrenOf(foldedTree), surface).toHaveLength(2 + 5 + 2)
    expect(headerRows(childrenOf(foldedTree).at(-1)).map(row => row.id), surface).toEqual(['log'])
    expect(logRows(foldedTree), surface).toEqual([])
    expect(folded.map(row => row.summary), surface).toEqual(headerRows(tree).map(row => row.summary))

    // A section with nothing to show is left out together with its rule: one rule for each header, always, and one for
    // the Project block when there is one.
    for (const sparse of [
      EMPTY,
      { ...FULL, usage: { ...FULL.usage, rateLimits: [] }, mcp: null, log: [] },
      { ...FULL, usage: { ...FULL.usage, skills: undefined }, mcp: null, agents: {} },
    ]) {
      const drawn = draw(onSurface(sparse, surface))
      const rules = headerRows(drawn).length + (sparse.project.name === '' ? 0 : 1)
      expect(ruleCount(drawn), `${surface} ${headerRows(drawn).length} sections`).toBe(rules)
    }
  }
})

test('partial states draw what they have and leave the rest out', () => {
  // Without the rules, the blank spans and the ▰▱ cells (the terminal draws its meters as text), and without the
  // terminal band's station grid, which the band's own tests read: of the band, its core line.
  const read = (data: PaneData, surface: Surface): string[] => {
    const [top, ...rest] = childrenOf(draw(onSurface(data, surface)))
    const [head, core, ...more] = childrenOf(top)
    const kept = [head, core, ...more.filter(line => !isSpanLine(line)), ...rest]

    return kept.flatMap(textsOf).filter(text => !/^[\s─▰▱]*$/.test(text))
  }

  for (const surface of SURFACES) {
    const isDesktop = surface === 'desktop'
    // Nothing at all: the title, the band, and the turn placeholder in dim, under a header with no summary. The band
    // reads —: in its image on the desktop, and on the terminal for the model, the percent and the tokens, the tokens
    // dim.
    expect(read(EMPTY, surface), surface).toEqual([
      'Session', ...(isDesktop ? [] : ['—', '—', '—']), 'Turn stats', 'No completed turn yet',
    ])
    expect(textNode(draw(onSurface(EMPTY, surface)), 'No completed turn yet')?.node.props?.dimColor, surface).toBe(true)
    expect(headerRows(draw(onSurface(EMPTY, surface))).map(row => row.summary), surface).toEqual([undefined])
    const emptyBand = childrenOf(childrenOf(childrenOf(draw(onSurface(EMPTY, surface)))[0])[1])
    if (isDesktop) {
      expect(emptyBand[0]?.props?.alt, surface).toBe(EMPTY_BAND_ALT)
    } else {
      expect(childrenOf(emptyBand.at(-1))[0]?.props?.dimColor, surface).toBe(true)
    }

    // A reading with no tokens or window draws the meter and the percent, and `—` for `tokens / window`.
    const bare = { ...EMPTY, usage: { rateLimits: [], contextPct: 40 } }
    expect(read(bare, surface), surface).toEqual([
      'Session', ...(isDesktop ? [] : ['—', '40%', '—']), 'Turn stats', 'No completed turn yet',
    ])
    if (isDesktop) {
      const bareBand = childrenOf(childrenOf(childrenOf(draw(onSurface(bare, surface)))[0])[1])[0]
      expect(String(bareBand?.props?.alt), surface).toStartWith('Context 40%. Model 0;')
    }

    // No total cost: `Session` stands alone on its row, and there is no split line.
    const noTotal = draw(onSurface({ ...FULL, usage: { ...FULL.usage, costUsd: undefined } }, surface))
    expect(textsOf(childrenOf(childrenOf(noTotal)[0])[0]), surface).toEqual(['Session'])
    expect(textsOf(noTotal).some(text => text.startsWith('Session ')), surface).toBe(false)
    // A total and no cost on any subagent: the total, and no split line. With costs, both parts.
    const free = { ...FULL, agents: Object.fromEntries(AGENTS.map(row => [row.id, { ...row, costUsd: null }])) }
    expect(read(free, surface), surface).toContain('$148.59')
    expect(read(free, surface).some(text => text.startsWith('Session ')), surface).toBe(false)
    expect(read(FULL, surface), surface).toContain('Session $126.09 · Subagents $22.50')

    // No subagents and no tasks: no Activity, so no header and no rule.
    expect(headerRows(draw(onSurface({ ...FULL, agents: {} }, surface))).map(row => row.id), surface).toEqual([
      'usage', 'turn', 'mcp', 'sources', 'log',
    ])
    // A subagent whose cost is not known yet draws a dim dash in its value: a cell of 8 at the right edge on the
    // desktop, a span right-aligned in 8 cells on the terminal.
    const activity = sectionOf(draw(onSurface(FULL, surface)), 'activity')
    const dash = textNode(activity, isDesktop ? '—' : '       —')
    expect(dash?.node.props?.dimColor, surface).toBe(true)
    if (isDesktop) expect(dash?.parent?.props, surface).toMatchObject({ width: 8, justifyContent: 'flex-end' })
  }
})

test('the placeholder of an empty Turn stats is cut by a narrow pane, not wrapped', () => {
  for (const surface of SURFACES) {
    const placeholder = textNode(draw(onSurface(EMPTY, surface), 8), 'No completed turn yet')
    expect(placeholder, surface).toBeDefined()
    expect(placeholder?.node.props, surface).toMatchObject({ dimColor: true, wrap: 'truncate' })
    expect(isFlex(placeholder?.parent), surface).toBe(true)
  }
})

test('the MCP servers wrap as whole chips: a green dot, the name in the plain colour, and a long name cut', () => {
  for (const surface of SURFACES) {
    const tree = draw(onSurface(FULL, surface))
    const chips = flat(tree).find(({ node }) => node.props?.flexWrap === 'wrap')?.node
    expect(chips?.props, surface).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2 })
    expect(childrenOf(chips).map(chip => textsOf(chip)[1]), surface).toEqual([
      'Claude_Browser', 'a-server-whose-name-is-wider-than-any-pane-there-is-or-will-ever-be', 'issue-hub',
    ])
    for (const chip of childrenOf(chips)) {
      // A chip can shrink and clips: a name wider than the pane goes on its own line and is cut.
      expect(isFlex(chip), surface).toBe(true)
      const [dot, name] = childrenOf(chip)
      expect(isFixed(dot), surface).toBe(true)
      expect(childrenOf(dot)[0]?.props, surface).toMatchObject({ color: 'success' })
      // The no-break space keeps the gap between the dot and the name.
      expect(textsOf(dot), surface).toEqual(['●\u00a0'])
      expect(isFlex(name), surface).toBe(true)
      expect(childrenOf(name)[0]?.type, surface).toBe('Text')
      expect(childrenOf(name)[0]?.props?.color, surface).toBeUndefined()
      expect(childrenOf(name)[0]?.props?.wrap, surface).toBe('truncate')
    }
  }
})

// A chip is its dot (the `●` and a no-break space: 2 cells) and its name, and the chips are 2 cells apart. A line holds
// the body's columns less 2, so that an estimate that is wrong is wrong upwards: the Log draws a line fewer for a row
// too many, and cuts its last line for a row too few. The names of these cases are lowercase ASCII, a cell a character.
test('chipRows counts the lines of chips: whole chips in order, as many on a line as the body less 2 holds', () => {
  const names = (...cells: number[]): string[] => cells.map(count => 'x'.repeat(count))

  // No chips, none to count; and where they fit a line, one line.
  expect(chipRows([], 40)).toBe(0)
  expect(chipRows(['codebase-memory'], 40)).toBe(1)
  expect(chipRows(['codebase-memory', 'issue-hub'], 40)).toBe(1)
  expect(chipRows(['codebase-memory', 'issue-hub'], 120)).toBe(1)
  // Two lines where they do not: the two chips are 17 and 11 cells and 2 apart, 30, and the line holds the body less 2,
  // so 32 columns hold them, and 31 do not.
  expect(chipRows(['codebase-memory', 'issue-hub'], 32)).toBe(1)
  expect(chipRows(['codebase-memory', 'issue-hub'], 31)).toBe(2)
  // The edge is the same for any two: 6 and 6 cells and the 2 between them are 14, so 16 columns hold them and 15 not.
  expect(chipRows(['abcd', 'efgh'], 16)).toBe(1)
  expect(chipRows(['abcd', 'efgh'], 15)).toBe(2)

  // A name wider than the body is a chip of its own line, which the pane cuts: the chips around it start new lines.
  expect(chipRows(names(100), 40)).toBe(1)
  expect(chipRows(['a', ...names(100), 'b'], 40)).toBe(3)
  expect(chipRows(names(100, 100), 40)).toBe(2)

  // The chips wrap in the order they come, a chip never going back to a line that had no room for the one before it:
  // chips of 10, 22 and 10 cells on a line of 32 are three lines (not the two that 10 and 10 together, and 22, would
  // be), and on a line of 34 the 10 and the 22 are one and the last is another.
  expect(chipRows(names(8, 20, 8), 34)).toBe(3)
  expect(chipRows(names(8, 20, 8), 36)).toBe(2)
  // Many short chips: 3 cells each with the 2 between, so a line of 38 holds 8 of them (8 x 3 + 7 x 2 = 38).
  expect(chipRows(names(1, 1, 1, 1, 1, 1, 1, 1, 1), 40)).toBe(2)
  expect(chipRows(names(1, 1, 1, 1, 1, 1, 1, 1), 40)).toBe(1)

  // A body with no columns, or fewer, holds no chip: each is a line of its own, and nothing throws.
  for (const columns of [2, 0, -5, Number.NaN]) {
    expect(chipRows(names(1, 1), columns), String(columns)).toBe(2)
  }
})

// The name of a chip is counted high, for the same reason: a name measured short is a row too few. Every code point
// above U+007F counts as 2 cells (CJK and emoji are drawn wide, and so are some that are not, an accented letter), the
// ASCII ones as 1 but for the capitals (the tests below); by code point, not by UTF-16 unit, which is what `.length`
// counts.
test('chipRows counts a name high: a code point above U+007F is 2 cells, by code point', () => {
  // `データ` is 3 characters and 6 cells, so its chip is 8 cells. With `abcd` (a chip of 6) and the 2 between them that
  // is 16: a line of 16 holds them (18 columns) and one of 15 does not. By `.length` its chip would be 5 cells and the
  // two would be 13, and 17 columns would hold them: a row too few.
  expect(chipRows(['abcd', 'データ'], 18)).toBe(1)
  expect(chipRows(['abcd', 'データ'], 17)).toBe(2)
  // An astral emoji is one code point and 2 cells, not the 4 that its two UTF-16 units would make at 2 cells each: its
  // chip is 4 cells, and with `abcd` and the gap they are 12, which 14 columns hold and 13 do not.
  expect(chipRows(['abcd', '😀'], 14)).toBe(1)
  expect(chipRows(['abcd', '😀'], 13)).toBe(2)
  // A name of every kind: `a`, an emoji, `é` (U+00E9) and `日` are 1 + 2 + 2 + 2 = 7 cells (`.length` says 5), so its
  // chip is 9 and with `abcd` and the gap they are 17: 19 columns hold them and 18 do not.
  const mixed = 'a\u{1F600}é日'
  expect(chipRows(['abcd', mixed], 19)).toBe(1)
  expect(chipRows(['abcd', mixed], 18)).toBe(2)
  // The edge of the rule: U+007F is 1 cell, and U+0080 is the first code point that counts 2.
  expect(chipRows(['abcd', '\u007f'], 13)).toBe(1)
  expect(chipRows(['abcd', '\u0080'], 13)).toBe(2)
  expect(chipRows(['abcd', '\u0080'], 14)).toBe(1)
})

// The font of the desktop is proportional and a capital is wider than a lowercase letter: the live check of 2026-10-13
// measured capitals at about 9 to 11 px against the 8 px of a cell, so two long names in capitals at the edge of a line
// made the estimate a row short. A capital ASCII letter (A to Z) counts 1.5 cells, and the total of a name is rounded
// up. Each case puts a name beside `abcd` (a chip of 6 cells, with the 2 cells between the chips): the two are
// 6 + 2 + the dot's 2 + the cells of the name, and a line holds the body's columns less 2.
test('chipRows counts a capital wider: A to Z are 1.5 cells each, and the total of a name is rounded up', () => {
  // `GITHUB` is 6 capitals, 9 cells: its chip is 11 and the two are 19, so 21 columns hold them and 20 do not. At a
  // cell a letter it would be 6 cells and the two 16: 18 columns would hold them, and so would 20, a row too few.
  expect(chipRows(['abcd', 'GITHUB'], 21)).toBe(1)
  expect(chipRows(['abcd', 'GITHUB'], 20)).toBe(2)
  // `Ab` is 1.5 + 1 = 2.5, which is 3 cells: its chip is 5 and the two are 13, so 15 columns hold them and 14 do not.
  expect(chipRows(['abcd', 'Ab'], 15)).toBe(1)
  expect(chipRows(['abcd', 'Ab'], 14)).toBe(2)
  // The total of a name is rounded up before the chips of a line are added: three of `Ab` are chips of 5 cells, and
  // with the gaps 19, so 21 columns hold them and 20 do not (kept at 2.5 cells they would be 17.5, and 20 columns would
  // hold them).
  expect(chipRows(['Ab', 'Ab', 'Ab'], 21)).toBe(1)
  expect(chipRows(['Ab', 'Ab', 'Ab'], 20)).toBe(2)
  // The capitals are A to Z and no more: `@` and `[` are the code points on either side of them, and count 1. `@AAZZ[`
  // is 1 + 3 + 3 + 1 = 8 cells (a range that lost an end, or took one of these in, would make it 7 or 9): its chip is
  // 10 and the two are 18, so 20 columns hold them and 19 do not.
  expect(chipRows(['abcd', '@AAZZ['], 20)).toBe(1)
  expect(chipRows(['abcd', '@AAZZ['], 19)).toBe(2)

  // Two names in capitals at the edge of a line: `GITHUB` and `SLACK` are 9 and 8 cells, chips of 11 and 10, and with
  // the gap 23. 25 columns hold them on a line, and in 24 they are two lines, where a cell a letter (6 and 5 cells,
  // chips of 8 and 7, 17 with the gap) would have said one line down to 19 columns.
  expect(chipRows(['GITHUB', 'SLACK'], 25)).toBe(1)
  expect(chipRows(['GITHUB', 'SLACK'], 24)).toBe(2)
})

// The weight of a capital is the third argument, 1.5 where it is left out (the desktop's, as above). A surface whose
// cells are even, the terminal, passes 1: a capital is a cell there, as any letter is, and the names in capitals of a
// line take the room of their letters. The weight is that of A to Z alone, and what a name adds up to is rounded up.
test('chipRows takes the weight of a capital as its third argument: 1 holds more names in capitals on a line', () => {
  // `GITHUB` and `SLACK` at a cell a capital are chips of 8 and 7 cells, 17 with the gap, so 19 columns hold them and
  // 18 do not. At 1.5 they are 23, so 25 columns hold them and 24 do not: at 24 columns they are one line at 1.
  expect(chipRows(['GITHUB', 'SLACK'], 19, 1)).toBe(1)
  expect(chipRows(['GITHUB', 'SLACK'], 18, 1)).toBe(2)
  expect(chipRows(['GITHUB', 'SLACK'], 25, 1.5)).toBe(1)
  expect(chipRows(['GITHUB', 'SLACK'], 24, 1.5)).toBe(2)
  expect(chipRows(['GITHUB', 'SLACK'], 24, 1)).toBe(1)
  // A line of 40 columns holds 38 cells: five chips of `ABCD` at 1 (6 cells each, and 4 gaps), four at 1.5 (8 cells
  // each, and 3 gaps). So five of them are one line at 1 and two at 1.5, and six are two lines at 1.
  expect(chipRows(Array(5).fill('ABCD'), 40, 1)).toBe(1)
  expect(chipRows(Array(6).fill('ABCD'), 40, 1)).toBe(2)
  expect(chipRows(Array(4).fill('ABCD'), 40, 1.5)).toBe(1)
  expect(chipRows(Array(5).fill('ABCD'), 40, 1.5)).toBe(2)
  // Left out, the weight is 1.5: the calls of two arguments count as they did.
  expect(chipRows(['GITHUB', 'SLACK'], 25)).toBe(1)
  expect(chipRows(['GITHUB', 'SLACK'], 24)).toBe(2)
  expect(chipRows(Array(5).fill('ABCD'), 40)).toBe(2)
  // The weight is the capitals' alone: U+00C9 twice (a capital E with an acute) is 4 cells at any weight, so with
  // `abcd` the two are 14, which 16 columns hold and 15 do not; `A` and U+00E9 are 1 + 2 = 3 cells at 1 (4 at 1.5, in
  // the next test), so with `abcd` the two are 13: 15 columns hold them and 14 do not.
  expect(chipRows(['abcd', '\u{C9}\u{C9}'], 16, 1)).toBe(1)
  expect(chipRows(['abcd', '\u{C9}\u{C9}'], 15, 1)).toBe(2)
  expect(chipRows(['abcd', 'A\u{E9}'], 15, 1)).toBe(1)
  expect(chipRows(['abcd', 'A\u{E9}'], 14, 1)).toBe(2)
})

// What is not a capital keeps its count: an ASCII character that is no capital is 1 cell (the digits and the `_`, `-`
// and `.` of a name too), a code point above U+007F is 2 cells whatever it is, a capital letter of it too (not 1.5),
// and where a name has both, the two counts add up in one total.
test('chipRows keeps the count of the rest: ASCII 1 cell, above U+007F 2 cells, a capital above it too', () => {
  // `az09_-.` is 7 cells: its chip is 9 and the two are 17, so 19 columns hold them and 18 do not.
  expect(chipRows(['abcd', 'az09_-.'], 19)).toBe(1)
  expect(chipRows(['abcd', 'az09_-.'], 18)).toBe(2)
  // `ÉÉ` (U+00C9 twice) is 2 + 2 = 4 cells, not 1.5 each: its chip is 6 and the two are 14, so 16 columns hold them and
  // 15 do not.
  expect(chipRows(['abcd', 'ÉÉ'], 16)).toBe(1)
  expect(chipRows(['abcd', 'ÉÉ'], 15)).toBe(2)
  // `A` and `é` (U+00E9) are 1.5 + 2 = 3.5, which is 4 cells: its chip is 6 and the two are 14, so 16 columns hold them
  // and 15 do not.
  expect(chipRows(['abcd', 'Aé'], 16)).toBe(1)
  expect(chipRows(['abcd', 'Aé'], 15)).toBe(2)
})

test('the top block is the session and its total, the Session band and the cost split, with no project in it', () => {
  for (const surface of SURFACES) {
    const [top] = childrenOf(draw(onSurface(FULL, surface)))
    const [head, ...rest] = childrenOf(top)
    const split = rest.at(-1)
    const band = rest.slice(0, -1)
    expect(textsOf(head), surface).toEqual(['Session', '$148.59'])
    // The total sits at the right edge of the first row, and is not bold: bold is for titles.
    expect(head?.props, surface).toMatchObject({ justifyContent: 'space-between' })
    expect(childrenOf(head).map(cell => isFixed(cell)), surface).toEqual([true, true])
    expect(textNode(head, '$148.59'), surface).toBeDefined()
    expect(textNode(head, '$148.59')?.node.props?.bold, surface).toBeUndefined()
    // The band in place of the two Context rows: on the desktop one image in a Box of its 5 rows (45 columns); on the
    // terminal the core line, with the percent in the colour of its threshold and the tokens at the right edge, and
    // the station grid's 2 rows.
    if (surface === 'desktop') {
      expect(band.map(part => part.props?.height), surface).toEqual([5])
      expect(childrenOf(band[0]).map(part => part.type), surface).toEqual(['Svg'])
    } else {
      expect(band, surface).toHaveLength(1 + 2)
      expect(band.every(isSpanLine), surface).toBe(true)
      expect(textNode(band[0], '88%')?.node.props?.color, surface).toBe('warning')
      expect(spanTexts(band[0]).at(-1), surface).toBe('529k / 600k')
    }
    // The split line is the last row of the card: no project row follows it.
    expect(textsOf(split), surface).toEqual(['Session $126.09 · Subagents $22.50'])
  }
})

// ---- The Session band ----

// The texts of a row as spanLine draws it: a FLEX row Box of FIXED Boxes, one Text in each.
const spanTexts = (line: Node | undefined): string[] => childrenOf(line).map(cell => textsOf(cell)[0] ?? '')
const isSpanLine = (line: Node | undefined): boolean =>
  isRow(line) && isFlex(line) && childrenOf(line).every(cell =>
    isRow(cell) && isFixed(cell) && childrenOf(cell).length === 1 && childrenOf(cell)[0]?.type === 'Text')

test('the band replaces the Context rows: one Svg in a clipping Box of whole rows', () => {
  for (const [bodyColumns, rows, width, height] of [[41, 5, 328, 95], [109, 4, 864, 76]] as const) {
    const tree = draw(FULL, bodyColumns)
    const [top] = childrenOf(tree)
    const [head, band, split, ...more] = childrenOf(top)
    expect(textsOf(head), `${bodyColumns}`).toEqual(['Session', '$148.59'])
    expect(band?.props, `${bodyColumns}`).toMatchObject({
      flexDirection: 'row', height: rows, overflow: 'hidden', justifyContent: 'flex-start',
    })
    const images = childrenOf(band)
    expect(images.map(image => image.type), `${bodyColumns}`).toEqual(['Svg'])
    expect(images[0]?.props, `${bodyColumns}`).toMatchObject({ width, height })
    expect(String(images[0]?.props?.alt), `${bodyColumns}`).toStartWith(
      'Context 88%, 529k of 600k. Model 0, 2 running; Files 0;',
    )
    expect(images[0]?.props?.isInteractive, `${bodyColumns}`).toBeUndefined()
    expect(textsOf(split), `${bodyColumns}`).toEqual(['Session $126.09 · Subagents $22.50'])
    expect(more, `${bodyColumns}`).toEqual([])
    expect(textNode(tree, 'Context'), `${bodyColumns}`).toBeUndefined()
  }
})

test('the band breathes busy while main\'s turn runs, with nothing counted running', () => {
  const bandSource = (data: PaneData): string => String(
    flat(draw(data)).map(({ node }) => node)
      .find(node => node.type === 'Svg' && /^Context /.test(String(node.props?.alt)))?.props?.source,
  )
  // Main has a call in flight, so `runningOf` counts nothing: every station reads 0 while the turn runs.
  const call = { station: 'agents', agentId: null, at: NOW, label: 'SendMessage' } as const
  expect(bandSource({ ...EMPTY, turn: RUNNING, inFlight: { u1: call } })).toContain('values="0.05;0.24;0.05"')
  expect(bandSource(EMPTY)).toContain('values="0.05;0.12;0.05"')
})

test('the terminal band is the core line and the grid', () => {
  for (const [bodyColumns, gridRows] of [[40, 3], [44, 2], [120, 1]] as const) {
    const [top] = childrenOf(draw(onSurface(FULL, 'terminal'), bodyColumns))
    const [head, ...rest] = childrenOf(top)
    const lines = rest.slice(0, -1)
    expect(textsOf(head), `${bodyColumns}`).toEqual(['Session', '$148.59'])
    expect(lines, `${bodyColumns}`).toHaveLength(1 + gridRows)
    expect(lines.every(isSpanLine), `${bodyColumns}`).toBe(true)
    expect(textsOf(rest.at(-1)), `${bodyColumns}`).toEqual(['Session $126.09 · Subagents $22.50'])
    // The core line: no model yet, the meter, the percent in the colour of 80 and over, the tokens at the right edge.
    const core = spanTexts(lines[0])
    expect(core.slice(0, 6), `${bodyColumns}`).toEqual(['—', '  ', '▰▰▰▰▰▰▰▰▰', '▱', '  ', '88%'])
    expect(core.at(-1), `${bodyColumns}`).toBe('529k / 600k')
    expect(core.join('').length, `${bodyColumns}`).toBe(bodyColumns)
    expect(textNode(lines[0], '88%')?.node.props?.color, `${bodyColumns}`).toBe('warning')
    expect(spanTexts(lines[1]).join(''), `${bodyColumns}`).toMatch(/^● ?Model/)
  }
})

test('wider than 4096 px the band is 4088 px and centred', () => {
  const [top] = childrenOf(draw(FULL, 626))
  const band = childrenOf(top)[1]
  expect(band?.props).toMatchObject({ height: 4, overflow: 'hidden', justifyContent: 'center' })
  expect(childrenOf(band)[0]?.props).toMatchObject({ width: 4088, height: 76 })
  expect(rowProblems(draw(FULL, 626))).toEqual([])
})

test('with nothing to show the band reads — and every station 0, dimmed', () => {
  const [top] = childrenOf(draw(EMPTY))
  const alt = String(childrenOf(childrenOf(top)[1])[0]?.props?.alt)
  expect(alt).toStartWith('Context —')
  expect(alt).toEndWith('Model 0; Files 0; Shell 0; Web 0; Agents 0; MCP 0; Skills 0; You 0.')

  const [, core, ...grid] = childrenOf(childrenOf(draw(onSurface(EMPTY, 'terminal')))[0])
  const texts = spanTexts(core)
  expect(texts.slice(0, 5)).toEqual(['—', '  ', '▱'.repeat(10), '  ', '—'])
  expect(texts.at(-1)).toBe('—')
  expect(textNode(core, '▱'.repeat(10))?.node.props?.dimColor).toBe(true)
  // Every station: an idle dim mark and a dim 0.
  const cells = grid.flatMap(line => childrenOf(line).map(cell => childrenOf(cell)[0]))
  const counts = cells.filter(text => textsOf(text)[0]?.trim() === '0')
  expect(counts).toHaveLength(8)
  expect(counts.every(text => text?.props?.dimColor === true)).toBe(true)
  const marks = cells.filter(text => textsOf(text)[0] === '·')
  expect(marks).toHaveLength(8)
  expect(marks.every(text => text?.props?.dimColor === true)).toBe(true)
})

test('spanLine keeps a span\'s edge spaces on the desktop', () => {
  const spans = [{ text: 'a ', color: '#e1ac6e', bold: true }, { text: ' b', dimColor: true }]
  const lineOn = (surface: Surface): Node => {
    const { Svg, ...rest } = PLAIN_ELEMENTS as unknown as Record<string, unknown>
    return spanLine({ ui: surface === 'desktop' ? { Svg, ...rest } : rest } as never, spans) as unknown as Node
  }

  for (const [surface, texts] of [['desktop', ['a\u{a0}', '\u{a0}b']], ['terminal', ['a ', ' b']]] as const) {
    const line = lineOn(surface)
    expect(line.props, surface).toStrictEqual({
      flexDirection: 'row', flexShrink: 1, minWidth: 0, overflow: 'hidden',
    })
    expect(isSpanLine(line), surface).toBe(true)
    expect(spanTexts(line), surface).toEqual(texts)
    const [first, second] = childrenOf(line).map(cell => childrenOf(cell)[0]?.props)
    expect(first, surface).toMatchObject({ color: '#e1ac6e', bold: true })
    expect(second, surface).toMatchObject({ dimColor: true })
    expect(rowProblems(line), surface).toEqual([])
  }
})

// ---- The Project block ----

// The project of the pane given, over a project that has everything: a name, a branch and changes.
const projectData = (project: Partial<PaneData['project']>, surface: Surface): PaneData => ({
  ...onSurface(FULL, surface), project: { name: 'repo', branch: 'main', changes: CHANGES, ...project },
})
const isChangesLabel = (text: string | undefined): boolean => /files? changed$/.test(text ?? '')
// The rows of the block after its header, by what they say: the branch, and the changes; undefined when not drawn.
const blockRows = (tree: Node): { branch: Node | undefined; changes: Node | undefined } => {
  const rows = childrenOf(projectOf(tree)).slice(2)

  const isChanges = (row: Node): boolean => isChangesLabel(textsOf(row)[0])

  return { branch: rows.find(row => !isChanges(row)), changes: rows.find(isChanges) }
}
// What the changes row shows after its label: the lines, as the three Texts read together; undefined when it has none.
const numbersOf = (changes: PaneData['project']['changes'], surface: Surface): string | undefined => {
  const [, ...numbers] = textsOf(blockRows(draw(projectData({ changes }, surface))).changes)

  return numbers.length === 0 ? undefined : numbers.join('')
}

test('the Project block is a rule, the title with the folder dim at the right, the branch, and the changes', () => {
  for (const surface of SURFACES) {
    const isDesktop = surface === 'desktop'
    const block = projectOf(draw(onSurface(FULL, surface)))
    const [rule, header, branch, changes, ...more] = childrenOf(block)
    expect(more, surface).toEqual([])
    // A rule above it, as above a section.
    expect(ruleCount(rule), surface).toBe(1)

    // The header: the bold title in a fixed cell, and the folder dim at the right, cut from its end. It has no icon and
    // no chevron: the block does not fold.
    const [title, folder, ...rest] = childrenOf(header)
    expect(rest, surface).toEqual([])
    expect(isFixed(title), surface).toBe(true)
    expect(childrenOf(title).map(el => [textsOf(el), el.props?.bold]), surface).toEqual([[['Project'], true]])
    expect(folder?.props, surface).toMatchObject({
      flexGrow: 1, flexShrink: 1, minWidth: 0, overflow: 'hidden', justifyContent: 'flex-end',
    })
    expect(childrenOf(folder).map(el => [textsOf(el), ...styleOf(el)]), surface).toEqual([
      [[PROJECT], undefined, true, 'truncate'],
    ])
    expect(flat(header).some(({ node }) => node.type === 'Svg' || node.type === 'Button'), surface).toBe(false)

    // The branch: on the desktop an icon in its slot, then the branch; on the terminal the emoji and the branch. The
    // text is cut, alone in a cell that clips.
    const branchCells = childrenOf(branch)
    expect(branchCells.length, surface).toBe(isDesktop ? 2 : 1)
    if (isDesktop) expect(childrenOf(branchCells[0])[0]?.props, surface).toMatchObject({ alt: 'Branch', width: 14 })
    expect(isFlex(branchCells.at(-1)), surface).toBe(true)
    expect(childrenOf(branchCells.at(-1)).map(el => [textsOf(el), el.props?.wrap]), surface).toEqual([
      [[isDesktop ? BRANCH : `🌿 ${BRANCH}`], 'truncate'],
    ])

    // The changes: an icon on the desktop, the label, which is cut and takes the room that is left, and the lines at
    // the right: three Texts in a fixed cell, `+1204` in the success colour, the slash dim, `−387` in the error one.
    const cells = childrenOf(changes)
    expect(cells.length, surface).toBe(isDesktop ? 3 : 2)
    if (isDesktop) expect(childrenOf(cells[0])[0]?.props, surface).toMatchObject({ alt: 'Changes', width: 14 })
    const [label, numbers] = cells.slice(-2)
    expect(isFlex(label), surface).toBe(true)
    expect(label?.props?.flexGrow, surface).toBe(1)
    expect(childrenOf(label).map(el => [textsOf(el), el.props?.wrap]), surface).toEqual([
      [[isDesktop ? '12 files changed' : '📝 12 files changed'], 'truncate'],
    ])
    expect(numbers?.props, surface).toMatchObject({ flexDirection: 'row', flexShrink: 0 })
    expect(childrenOf(numbers).map(el => [el.type, textsOf(el), ...styleOf(el)]), surface).toEqual([
      ['Text', ['+1204'], 'success', undefined, undefined],
      ['Text', [SEP], undefined, true, undefined],
      ['Text', [`${MINUS}387`], 'error', undefined, undefined],
    ])
  }
})

test('the lines removed use the minus sign U+2212, and the slash has no-break spaces, not plain ones', () => {
  expect(MINUS).toBe('\u2212')
  expect(SEP).toBe('\u00a0/\u00a0')
  for (const surface of SURFACES) {
    const numbers = childrenOf(childrenOf(blockRows(draw(onSurface(FULL, surface))).changes).at(-1))
    expect(textsOf(numbers[2]), surface).toEqual(['\u2212387'])
    // The slash is a Text of its own, and a plain space at the edge of a flex item may be dropped by the desktop.
    expect(textsOf(numbers[1]), surface).toEqual(['\u00a0/\u00a0'])
    expect(textsOf(numbers).join(''), surface).not.toMatch(/[ -]/)
  }
})

test('one changed file reads `1 file changed`, any other number reads `n files changed`', () => {
  for (const surface of SURFACES) {
    const mark = surface === 'desktop' ? '' : '📝 '
    const labelOf = (files: number): string | undefined =>
      textsOf(blockRows(draw(projectData({ changes: { files, lines: null } }, surface))).changes)[0]

    expect(labelOf(1), surface).toBe(`${mark}1 file changed`)
    expect([0, 2, 11, 1204].map(labelOf), surface).toEqual(
      [0, 2, 11, 1204].map(files => `${mark}${files} files changed`),
    )
  }
})

test('the numbers are drawn when a line was added or removed, and not when there are none or they are unknown', () => {
  for (const surface of SURFACES) {
    // No line counts, and both counts 0 (only binary files changed): the row is the label alone.
    expect(numbersOf({ files: 2, lines: null }, surface), surface).toBeUndefined()
    expect(numbersOf({ files: 2, lines: { added: 0, removed: 0 } }, surface), surface).toBeUndefined()
    // One count of 0 is drawn as it is; the numbers are plain integers.
    expect(numbersOf({ files: 1, lines: { added: 5, removed: 0 } }, surface), surface).toBe(`+5${SEP}${MINUS}0`)
    expect(numbersOf({ files: 1, lines: { added: 0, removed: 7 } }, surface), surface).toBe(`+0${SEP}${MINUS}7`)
    expect(numbersOf({ files: 3, lines: { added: 8, removed: 1 } }, surface), surface).toBe(`+8${SEP}${MINUS}1`)
    expect(numbersOf({ files: 9, lines: { added: 1_234_567, removed: 20_000 } }, surface), surface).toBe(
      `+1234567${SEP}${MINUS}20000`,
    )

    // With no numbers the row has no cell that holds its size but the icon's slot.
    const row = blockRows(draw(projectData({ changes: { files: 2, lines: null } }, surface))).changes
    expect(childrenOf(row).filter(cell => isFixed(cell) && !hasWidth(cell)), surface).toEqual([])
  }
})

test('a count that is a lower bound has a plus: `7+ files changed`, plural even for 1, and `+2061+` lines', () => {
  for (const surface of SURFACES) {
    const mark = surface === 'desktop' ? '' : '📝 '
    const rowOf = (changes: PaneData['project']['changes']): Node | undefined =>
      blockRows(draw(projectData({ changes }, surface))).changes
    const more = { added: 2061, removed: 4, hasMoreAdded: true } as const

    // A status that was cut gives the files of its whole entries and no lines: the label alone, with no numbers cell.
    for (const files of [7, 1, 1204]) {
      const row = rowOf({ files, hasMoreFiles: true, lines: null })
      expect(textsOf(row), `${surface} ${files}`).toEqual([`${mark}${files}+ files changed`])
      expect(childrenOf(row).filter(cell => isFixed(cell) && !hasWidth(cell)), `${surface} ${files}`).toEqual([])
    }
    // New files that were not all counted: a plus after the lines added, in the colour of the count, in one Text. The
    // lines removed read as they do.
    const numbers = childrenOf(rowOf({ files: 52, lines: more })).at(-1)
    expect(childrenOf(numbers).map(el => [textsOf(el), el.props?.color]), surface).toEqual([
      [['+2061+'], 'success'], [[SEP], undefined], [[`${MINUS}4`], 'error'],
    ])
    // The two marks are each their own: a row draws the ones it is given.
    expect(textsOf(rowOf({ files: 52, hasMoreFiles: true, lines: more })), surface)
      .toEqual([`${mark}52+ files changed`, '+2061+', SEP, `${MINUS}4`])
    // The numbers cell keeps its rule: there are lines, and more than none. A plus is not a line.
    const none = { added: 0, removed: 0, hasMoreAdded: true } as const
    expect(numbersOf({ files: 2, lines: none }, surface), surface).toBeUndefined()
    expect(numbersOf({ files: 2, lines: { ...none, removed: 3 } }, surface), surface).toBe(`+0+${SEP}${MINUS}3`)

    // Exact counts carry no plus, whatever the number.
    expect(textsOf(rowOf({ files: 12, lines: { added: 1204, removed: 387 } })), surface)
      .toEqual([`${mark}12 files changed`, '+1204', SEP, `${MINUS}387`])
    expect(textsOf(rowOf({ files: 1, lines: null })), surface).toEqual([`${mark}1 file changed`])
    expect(textsOf(rowOf({ files: 2, lines: { added: 0, removed: 0 } })), surface).toEqual([`${mark}2 files changed`])
  }
})

test('what is missing is left out: no changes, no changes row; no branch, no branch row; no name, no block', () => {
  for (const surface of SURFACES) {
    const noChanges = draw(projectData({ changes: null }, surface))
    expect(blockRows(noChanges).changes, surface).toBeUndefined()
    expect(blockRows(noChanges).branch, surface).toBeDefined()
    expect(childrenOf(projectOf(noChanges)), surface).toHaveLength(3) // the rule, the header, the branch

    const noBranch = draw(projectData({ branch: null }, surface))
    expect(blockRows(noBranch).branch, surface).toBeUndefined()
    expect(blockRows(noBranch).changes, surface).toBeDefined()
    expect(childrenOf(projectOf(noBranch)), surface).toHaveLength(3) // the rule, the header, the changes

    // Neither: the title and the folder alone.
    const bare = draw(projectData({ branch: null, changes: null }, surface))
    expect(childrenOf(projectOf(bare)), surface).toHaveLength(2)
    expect(textsOf(projectOf(bare)).filter(shown => !/^─+$/.test(shown)), surface).toEqual(['Project', 'repo'])

    // No name, though there is a branch and there are changes: no block, no rule of its own, nothing of it in the pane.
    const noName = draw(projectData({ name: '' }, surface))
    expect(projectOf(noName), surface).toBeUndefined()
    // The top block, the five sections above the Log, and the Log's own four parts: its rule, header, head and the
    // `+N more` line.
    expect(childrenOf(noName), surface).toHaveLength(1 + 5 + 4)
    expect(ruleCount(noName), surface).toBe(6)
    // (Activity's lane of the main agent is labelled `main` too: the branch is looked for outside it.)
    const shown = childrenOf(noName).filter(child => child !== sectionOf(noName, 'activity')).flatMap(textsOf)
    expect(shown.some(text => /(files? changed|^Project|main)$/.test(text)), surface).toBe(false)
  }
})

test('a project value from before the changes existed draws without a changes row', () => {
  for (const surface of SURFACES) {
    const older = { name: 'repo', branch: 'main' } as PaneData['project']
    const tree = draw(onSurface({ ...FULL, project: older }, surface))
    expect(blockRows(tree).changes, surface).toBeUndefined()
    expect(blockRows(tree).branch, surface).toBeDefined()
    expect(rowProblems(tree), surface).toEqual([])
    expect(JSON.stringify(tree), surface).not.toMatch(/NaN|Infinity|null|undefined/)
  }
})

test('the pane draws the Session card, then the Project block, then Usage', () => {
  for (const surface of SURFACES) {
    const tree = draw(onSurface(FULL, surface))
    const [top, project, usageSection] = childrenOf(tree)
    expect(textsOf(top)[0], surface).toBe('Session')
    expect(project, surface).toBe(projectOf(tree))
    expect(textsOf(childrenOf(project)[1])[0], surface).toBe('Project')
    expect(headerRows(tree)[0]?.section, surface).toBe(usageSection)
    expect(headerRows(tree)[0]?.title, surface).toBe('Usage')
    // The titles in bold, in the order they are drawn.
    const bold = flat(tree).filter(({ node }) => node.type === 'Text' && node.props?.bold === true)
    expect(bold.map(({ node }) => textsOf(node)[0]), surface).toEqual(['Session', 'Project', ...TITLES])
  }
})

test('the changes icon is drawn with the alt `Changes`, in a slot of its own, on the desktop only', () => {
  const images = flat(draw(onSurface(FULL, 'desktop'))).filter(({ node }) => node.type === 'Svg')
  const changes = images.filter(({ node }) => node.props?.alt === 'Changes')
  expect(changes).toHaveLength(1)
  expect(changes[0]?.node.props).toMatchObject({ width: 14, height: 14 })
  expect(String(changes[0]?.node.props?.source)).toMatch(/^<svg [^>]*width="14" height="14"[\s\S]*<\/svg>$/)
  expect(changes[0]?.parent?.props).toMatchObject({ width: 2, flexShrink: 0 })
  // The folder icon of the old project row is not drawn any more: the alt `Project` is no image's.
  expect(images.map(({ node }) => node.props?.alt)).not.toContain('Project')
  expect(flat(draw(onSurface(FULL, 'terminal'))).filter(({ node }) => node.type === 'Svg')).toEqual([])
})

test('the Project block cannot outgrow the pane, and its numbers stay whole when the label is cut', () => {
  const variants: Array<Partial<PaneData['project']>> = [
    {}, { branch: null }, { changes: null }, { branch: null, changes: null }, { name: PROJECT, branch: BRANCH },
    { changes: { files: 1, lines: null } }, { changes: { files: 2, lines: { added: 0, removed: 0 } } },
    { changes: { files: 99_999, lines: { added: 1_234_567, removed: 7_654_321 } } },
    { changes: { files: 7, hasMoreFiles: true, lines: null } },
    { changes: { files: 99_999, lines: { added: 1_234_567, removed: 7_654_321, hasMoreAdded: true } } },
  ]
  // At the narrowest and the widest body the tests use.
  for (const surface of SURFACES) {
    for (const bodyColumns of [8, 120]) {
      for (const [i, project] of variants.entries()) {
        const tree = draw(projectData(project, surface), bodyColumns)
        const where = `${surface} ${bodyColumns} columns, variant ${i}`
        expect(rowProblems(projectOf(tree)), where).toEqual([])

        // The label gives way and clips; the numbers hold their size, with no clip and no cut text in them.
        const row = blockRows(tree).changes
        const numbers = childrenOf(row).filter(cell => isFixed(cell) && !hasWidth(cell))
        if (numbers.length > 0) {
          const [label] = childrenOf(row).slice(-2)
          expect(isFlex(label), where).toBe(true)
          expect(childrenOf(label)[0]?.props?.wrap, where).toBe('truncate')
          expect(numbers, where).toHaveLength(1)
          expect(numbers[0]?.props?.overflow, where).toBeUndefined()
          expect(flat(numbers[0]).every(({ node }) => node.props?.wrap === undefined), where).toBe(true)
        }
      }
    }
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

// ---- Activity: the tasks' lanes ----

// Three tasks, one of each kind, in the order they are drawn: the one that runs, then the others, which ended at one
// time, in their order. The descriptions differ in length, as the subagents' do: a short one, one wider than any pane,
// and one in between. The times are 1m 30s, 1m 12s and 5.0s.
const KINDS: TaskRow[] = [
  task(1, 'running', { description: 'Fix' }),
  task(2, 'done', { kind: 'monitor', description: WIDE, durationMs: 72_000 }),
  task(3, 'failed', { kind: 'workflow', description: 'Review the change' }),
]
const withTasks = (rows: TaskRow[], surface: Surface): PaneData =>
  onSurface({ ...EMPTY, tasks: tasksOf(rows) }, surface)
// The section of the pane that has this id: the column of its rule, its header and its body.
const sectionOf = (tree: unknown, id: string): Node | undefined => headerRows(tree).find(row => row.id === id)?.section

test('the Activity section sits after Turn stats and before MCP: a column of its rule, its header and its body', () => {
  for (const surface of SURFACES) {
    const tree = draw(onSurface({ ...FULL, tasks: tasksOf(KINDS) }, surface))
    const rows = headerRows(tree)
    expect(rows.map(row => row.id), surface).toEqual([...SECTIONS])
    expect(rows.map(row => row.title), surface).toEqual(TITLES)
    // The sections are children of the pane, after the top block and the Project block: Activity's is the one that
    // follows Turn stats'.
    const [, , , turn, activity, mcp] = childrenOf(tree)
    expect(rows[1]?.section, surface).toBe(turn)
    expect(rows[2]?.section, surface).toBe(activity)
    expect(rows[3]?.section, surface).toBe(mcp)
    // A column of its rule, its header and its body: main's lane and 7 of the 13, the axis and `+6 more`. Two
    // subagents and a task run.
    const [rule, header, body, ...rest] = childrenOf(activity)
    expect(activity?.props, surface).toStrictEqual({ flexDirection: 'column' })
    expect(ruleCount(rule), surface).toBe(1)
    expect(headerRows(header).map(row => [row.id, row.label, row.title, row.summary]), surface).toEqual([
      ['activity', '▾', 'Activity', '3/13'],
    ])
    expect(body?.props, surface).toStrictEqual({ flexDirection: 'column' })
    expect(childrenOf(body), surface).toHaveLength(10)
    expect(textsOf(childrenOf(body).at(-1)), surface).toEqual(['+6 more'])
    expect(rest, surface).toEqual([])
  }
})

test('the desktop draws an icon of its own for Activity, labelled with its title, and the terminal draws none', () => {
  const isIcon = (source: string): boolean => /^<svg [^>]*width="14" height="14"[\s\S]*<\/svg>$/.test(source)
  const desktop = draw(onSurface({ ...FULL, tasks: tasksOf(KINDS) }, 'desktop'))
  const rows = headerRows(desktop)
  const icons = rows.map(row => String(childrenOf(row.cells[0])[0]?.props?.source))
  // Six sections, six icons, no two alike, each an SVG document of its own.
  expect(icons.every(isIcon)).toBe(true)
  expect(new Set(icons).size).toBe(6)
  // The icon sits in a slot of 2 cells, as the others do, and says the title that is drawn in bold beside it. It is
  // §3.6's three lanes, in the grey of every section icon.
  const [slot] = rows[2]?.cells ?? []
  expect(slot?.props).toMatchObject({ flexShrink: 0, width: 2 })
  expect(childrenOf(slot).map(image => [image.type, image.props?.alt, image.props?.width, image.props?.height]))
    .toEqual([['Svg', 'Activity', 14, 14]])
  expect(icons[2]).toContain('stroke="#8a8a8a"')
  expect(icons[2]).toContain('<path d="M1.5 3.5h6M4.5 7h8M2.5 10.5h4.5"/>')

  const terminal = draw(onSurface({ ...FULL, tasks: tasksOf(KINDS) }, 'terminal'))
  expect(flat(terminal).filter(({ node }) => node.type === 'Svg')).toEqual([])
})

test('a task lane shows its status as a shape and a colour: the live cap, ✓, ✗, a dim ■ and a dim ○', () => {
  for (const surface of SURFACES) {
    const activity = activityOf(draw(withTasks(EACH_STATUS, surface)))
    // The lanes come after main's: the task that runs, then the others, which ended at one time, in their order.
    if (surface === 'terminal') {
      // The gutter's `◐` ends the running lane's span, in the Shell hue; the house marks follow the ended spans.
      const marks = flat(activity).flatMap(({ node }) => {
        const text = node.type === 'Text' ? textsOf(node)[0] ?? '' : ''
        return /[◐✓✗■○]$/.test(text) ? [[text.slice(-1), node.props?.color, node.props?.dimColor]] : []
      })
      expect(marks, surface).toEqual([
        ['◐', STATION_HUES.shell.dark, undefined],
        ['✓', 'success', undefined],
        ['✗', 'error', undefined],
        ['■', undefined, true],
        ['○', undefined, true],
      ])
    } else {
      // The lane's alt says its status; its image draws it: the live cap, a green check, a red cross, a grey square and
      // a grey ring.
      const lanes = flat(activity).map(({ node }) => node)
        .filter(node => node.type === 'Svg' && /^job \d /.test(String(node.props?.alt)))
      expect(lanes.map(node => String(node.props?.alt).split(', ')[1]), surface).toEqual(EVERY_STATUS)
      const sources = lanes.map(node => String(node.props?.source))
      expect(sources[0], 'running').toContain('data-part="cap"')
      expect(sources[1], 'done').toContain('stroke="#2ea043"')
      expect(sources[2], 'failed').toContain('stroke="#e5484d"')
      expect(sources[3], 'stopped').toContain('width="5" height="5" rx="1" fill="#8a8a8a"')
      expect(sources[4], 'ended').toContain('<circle r="3.5" fill="none" stroke="#8a8a8a"')
      expect(sources.slice(1).every(source => !source.includes('data-part="cap"')), surface).toBe(true)
    }
  }
})

// A value is drawn whole or not at all, and the lane stays one row, which the Log's count of rows relies on. A time
// wider than the 8 cells of the value is drawn as not known (taskTime, whose cases are in lanes.test.ts).
test('a task time wider than its value is a dim dash: the lane stays one row, and the Log counts on it', () => {
  const hours = (h: number, m = 0): number => (h * 60 + m) * 60_000
  const cases: Array<[name: string, row: TaskRow, time: string | null]> = [
    ['a duration of 2^53 - 1 ms', task(1, 'done', { durationMs: Number.MAX_SAFE_INTEGER }), null],
    ['done in 999h 59m', task(1, 'done', { durationMs: hours(999, 59) }), '999h 59m'],
    ['99h 59m, at most', task(1, 'done', { durationMs: hours(99, 59), durationAtMost: true }), '\u{2264}99h 59m'],
    ['100 hours, at most', task(1, 'done', { durationMs: hours(100), durationAtMost: true }), null],
    ['running, its start not seen', task(1, 'running', { startedAt: null }), null],
  ]
  const log = logLines(60)

  for (const surface of SURFACES) {
    for (const bodyColumns of [20, 45] as const) {
      for (const [name, row, time] of cases) {
        const where = `${surface} ${bodyColumns} columns: ${name}`
        const tree = draw(onSurface({ ...withLog(log), tasks: tasksOf([row]) }, surface), bodyColumns, 40)
        // Main's lane, the task's and the axis.
        const [, lane, ...rest] = activityBody(tree)
        expect(rest, where).toHaveLength(1)
        expect(rowProblems(tree), where).toEqual([])
        if (surface === 'desktop') {
          const cell = childrenOf(lane)[2]
          expect(textsOf(cell), where).toEqual([time ?? '—'])
          expect(childrenOf(cell).map(styleOf), where)
            .toEqual([[undefined, time === null ? true : undefined, undefined]])
        } else {
          const value = childrenOf(childrenOf(lane).at(-1))[0]
          expect(textsOf(value), where).toEqual([(time ?? '—').padStart(8)])
          expect(value?.props?.dimColor, where).toBe(time === null ? true : undefined)
        }
        // The Log has the rows of the block fewer: the rule, the header, two lanes and the axis. Of the 40 rows, the
        // blocks above take ABOVE_LOG, the Log's rule and header 2 and `+N more` 1.
        const above = ABOVE_LOG[surface][bodyColumns]
        expect(logRows(tree), where).toHaveLength(40 - above - 3 - 5)
        expect(rowsAbove(tree, bodyColumns, surface), where).toBe(above + 5)
      }
    }
  }
})

test('the header counts `running/total` while a task runs, and the total alone when none does', () => {
  const cases: Array<[name: string, rows: TaskRow[], summary: string]> = [
    ['one of three runs', [task(1, 'running'), task(2, 'done'), task(3, 'failed')], '1/3'],
    ['two of three run', [task(1, 'running'), task(2, 'running'), task(3, 'done')], '2/3'],
    ['all of two run', [task(1, 'running'), task(2, 'running')], '2/2'],
    ['the only one runs', [task(1, 'running')], '1/1'],
    ['none runs', [task(1, 'done'), task(2, 'failed'), task(3, 'stopped')], '3'],
    ['the only one has ended', [task(1, 'ended')], '1'],
    ['ten, two of them run', TEN, '2/10'],
  ]
  for (const surface of SURFACES) {
    for (const [name, rows, summary] of cases) {
      const tree = draw(withTasks(rows, surface))
      expect(headerRows(tree).find(row => row.id === 'activity')?.summary, `${surface}: ${name}`).toBe(summary)
    }
  }
})

test('Activity draws main and 7 task lanes, the running ones and the older start first, and counts the rest', () => {
  for (const surface of SURFACES) {
    const tree = draw(withTasks(TEN, surface))
    const body = activityBody(tree)
    expect(body.slice(0, 8).map(lane => textsOf(lane)[0]), surface).toEqual([
      'main', 'job 5', 'job 3', 'job 1', 'job 2', 'job 4', 'job 6', 'job 7',
    ])
    // Then the axis: its image on the desktop, the clock labels and `now` on the terminal.
    const axis = surface === 'desktop' ? childrenOf(childrenOf(body[8])[1])[0]?.props?.alt : spanTexts(body[8]).join('')
    expect(String(axis), surface).toMatch(/now$/)
    // The three that are left are counted in a dim line of their own at column 0, the last of the body.
    const more = textNode(tree, '+3 more')
    expect(more?.node.props?.dimColor, surface).toBe(true)
    expect(body, surface).toHaveLength(10)
    expect(spanTexts(body.at(-1)), surface).toEqual(['+3 more'])
    if (surface === 'desktop') expect(body.at(-1)?.props, surface).toStrictEqual({ flexDirection: 'row' })

    // Seven tasks fill the lanes and leave nothing to count.
    const seven = activityBody(draw(withTasks(TEN.slice(0, 7), surface)))
    expect(seven, surface).toHaveLength(9)
    expect(seven.flatMap(textsOf).some(text => /^\+\d+ more$/.test(text)), surface).toBe(false)
  }
})

test('a folded Activity is its rule and its header, with its summary; with no lanes but main it is left out', () => {
  for (const surface of SURFACES) {
    const open = draw(withTasks(TEN, surface))
    const folded = draw({ ...withTasks(TEN, surface), collapsed: { activity: true } })
    const headerOf = (tree: Node): Header | undefined => headerRows(tree).find(row => row.id === 'activity')
    expect(headerOf(open)?.label, surface).toBe('▾')
    expect(headerOf(folded)?.label, surface).toBe('▸')
    expect(textsOf(headerOf(open)?.section), surface).toContain('+3 more')
    // The body goes, and the line that counts the rest with it; the summary stays.
    expect(headerOf(folded)?.summary, surface).toBe('2/10')
    expect(childrenOf(headerOf(folded)?.section), surface).toHaveLength(2)
    expect(textsOf(headerOf(folded)?.section).some(text => /^\+\d+ more$/.test(text)), surface).toBe(false)

    // No subagents and no tasks, no section: no header, and no rule of its own either. With tasks the pane has one
    // rule more.
    const none = draw(onSurface({ ...FULL, agents: {} }, surface))
    expect(headerRows(none).map(row => row.id), surface).toEqual(['usage', 'turn', 'mcp', 'sources', 'log'])
    expect(headerRows(draw(withTasks([], surface))).map(row => row.id), surface).toEqual(['turn'])
    expect(ruleCount(draw(onSurface({ ...FULL, agents: {}, tasks: tasksOf(KINDS) }, surface))), surface)
      .toBe(ruleCount(none) + 1)
  }
})

test('the chevron of the Activity header asks to fold `activity`', () => {
  for (const surface of SURFACES) {
    const pressed: string[] = []
    const tree = renderPane(
      PLAIN_ELEMENTS, withTasks(KINDS, surface), { bodyColumns: 45, scroll: { bodyRows: 20 } },
      { onToggle: id => pressed.push(id) },
    ) as unknown as Node
    const chevron = flat(tree).find(({ node }) => node.type === 'Button' && node.props?.key === 'toggle:activity')?.node
    const press = chevron?.props?.onPress
    expect(typeof press, surface).toBe('function')
    if (typeof press === 'function') press()
    expect(pressed, surface).toEqual(['activity'])
  }
})

test('the task lanes outgrow no pane: every kind and status, a description wider than any pane, narrow, wide', () => {
  const kinds = ['shell', 'monitor', 'workflow'] as const
  // Ten tasks, so that the line that counts the rest is drawn too: every status and kind, a description wider than any
  // pane, and a task whose time is not known.
  const mixed: TaskRow[] = [
    ...EVERY_STATUS.map((status, i) => (
      task(i + 1, status, { kind: kinds[i % 3], description: i % 2 === 0 ? WIDE : 'job' })
    )),
    task(6, 'running', { startedAt: null }), task(7, 'done', { durationMs: null }), task(8, 'done'), task(9, 'done'),
    task(10, 'done'),
  ]
  for (const surface of SURFACES) {
    for (const bodyColumns of [8, 12, 30, 45, 120]) {
      const where = `${surface} ${bodyColumns} columns`
      // The pane of the tasks, the same folded, and the full pane with them.
      const open = withTasks(mixed, surface)
      const full = onSurface({ ...FULL, tasks: tasksOf(mixed) }, surface)
      for (const data of [open, { ...open, collapsed: { activity: true } }, full]) {
        expect(rowProblems(draw(data, bodyColumns)), where).toEqual([])
      }
      // Main's lane, seven of the ten, the axis and `+3 more`: these are the rows the check has seen.
      expect(activityBody(draw(open, bodyColumns)), where).toHaveLength(10)
    }
  }
})

test('the Log draws fewer lines by exactly the rows of Activity: rule, header, lanes, axis and `+N more`', () => {
  // A pane of a Log and the tasks. Above the Log are the Session card and the placeholder of Turn stats (ABOVE_LOG: 9
  // rows on the desktop, 8 and 7 on the terminal at 20 and 45 columns), and its rule and header are 2 more; of its 60
  // lines a row goes to its own `+N more` line. So of a body of 40 rows 28 lines are drawn on the desktop, and 29 and
  // 30 on the terminal.
  const log = logLines(60)
  // [the tasks, whether the section is folded, the rows of its block]: the rule and the header, main's lane and theirs
  // (7 at the most), the axis, and the line that counts the rest when there are more than 7 tasks.
  const cases: Array<[rows: TaskRow[], isFolded: boolean, blockRows: number]> = [
    [TEN.slice(0, 1), false, 5], [TEN.slice(0, 3), false, 7], [TEN.slice(0, 7), false, 11],
    [TEN.slice(0, 8), false, 12], [TEN, false, 12], [TEN, true, 2], [TEN.slice(0, 1), true, 2],
  ]
  for (const surface of SURFACES) {
    for (const bodyColumns of [20, 45] as const) {
      const above = ABOVE_LOG[surface][bodyColumns]
      const lines = { desktop: 28, terminal: bodyColumns === 20 ? 29 : 30 }[surface]
      const none = draw(onSurface(withLog(log), surface), bodyColumns, 40)
      expect(logRows(none), `${surface} ${bodyColumns}: no tasks`).toHaveLength(lines)
      for (const [rows, isFolded, blockRows] of cases) {
        const where = `${surface} ${bodyColumns} columns: ${rows.length} tasks${isFolded ? ', folded' : ''}`
        const collapsed: Record<string, boolean> = isFolded ? { activity: true } : {}
        const data = { ...withLog(log), tasks: tasksOf(rows), collapsed }
        const tree = draw(onSurface(data, surface), bodyColumns, 40)
        // The Log has the rows of Activity fewer, and `+N more` counts the lines it has not drawn.
        expect(logRows(tree), where).toHaveLength(lines - blockRows)
        expect(moreOf(tree), where).toBe(60 - (lines - blockRows))
        // The rows that the panel counts above the Log are those of the trees: counted again from them.
        expect(rowsAbove(tree, bodyColumns, surface), where).toBe(above + blockRows)
      }
    }
  }
})

// A call that went to the background has `→ background` for the outcome of its line in the Log (the v2 spec, §4.2): 12
// cells, against the 6 of `✓ 0.3s`. The outcome column is as wide as the longest outcome drawn (a cell more on the
// desktop), so a Log that draws one gives way earlier. The user decided that it stays whole: it is `who` that goes
// first, then the outcome cell, which then leads the text. A layout is drawn from 8 cells of text: the body less the
// time (8), the cells of the row and the gaps between them. The desktop's `who` is 13 cells, the terminal's is 4:
//   `→ background`, desktop:  8 + 13 + 13 + 3 + 8 = 45 with `who`, 8 + 13 + 2 + 8 = 31 without it;
//   `→ background`, terminal: 8 + 4 + 12 + 3 + 8 = 35 with `who`, 8 + 12 + 2 + 8 = 30 without it;
//   `✓ 0.3s`, desktop:        8 + 13 + 7 + 3 + 8 = 39 with `who`, 8 + 7 + 2 + 8 = 25 without it;
//   `✓ 0.3s`, terminal:       8 + 4 + 6 + 3 + 8 = 29 with `who`, 8 + 6 + 2 + 8 = 24 without it.
const callLog = (outcome: string): LogEntry[] => [
  { at: NOW, who: 'main', text: 'Bash npm test', kind: 'ok', outcome },
  { at: NOW - 1000, who: 'you', text: 'run the tests', kind: 'info' },
]
const BACKGROUND_EDGES: [surface: Surface, outcome: string, outcomeCells: number, withWho: number, bare: number][] = [
  ['desktop', '→ background', 13, 45, 31], ['terminal', '→ background', 12, 35, 30],
  ['desktop', '✓ 0.3s', 7, 39, 25], ['terminal', '✓ 0.3s', 6, 29, 24],
]

test('`→ background` stays whole: no `who` at 44 (desktop) and 34 (terminal) columns, where `✓ 0.3s` keeps it', () => {
  // The same Log at one width: a column short of `who` for `→ background`, which `✓ 0.3s` keeps with room to spare.
  for (const [surface, bodyColumns] of [['desktop', 44], ['terminal', 34]] as const) {
    const layouts = (outcome: string): string[][] =>
      logRows(draw(onSurface({ ...EMPTY, log: callLog(outcome) }, surface), bodyColumns)).map(logRoles)

    expect(layouts('→ background'), `${surface} ${bodyColumns}`).toEqual([LAYOUT_BARE, LAYOUT_BARE])
    expect(layouts('✓ 0.3s'), `${surface} ${bodyColumns}`).toEqual([LAYOUT_WHO, LAYOUT_WHO])
  }

  for (const [surface, outcome, outcomeCells, withWho, bare] of BACKGROUND_EDGES) {
    // The narrowest body the tests use, either side of each edge, and a wide one.
    for (const bodyColumns of [8, bare - 1, bare, withWho - 1, withWho, 120]) {
      const where = `${surface} ${outcome} ${bodyColumns} columns, edges ${bare} and ${withWho}`
      const tree = draw(onSurface({ ...EMPTY, log: callLog(outcome) }, surface), bodyColumns)
      const layout = bodyColumns >= withWho ? LAYOUT_WHO : bodyColumns >= bare ? LAYOUT_BARE : LAYOUT_TEXT
      expect(rowProblems(tree), where).toEqual([])
      expect(logRows(tree).map(logRoles), where).toEqual([layout, layout])

      // The outcome is whole wherever the row has a cell for it, as wide as the longest outcome drawn; where it has
      // none, it leads the text, so that the cut at the end keeps it.
      const [line] = logRows(tree)
      if (layout.includes('outcome')) {
        const cell = childrenOf(line)[layout.indexOf('outcome')]
        expect(cell?.props?.width, where).toBe(outcomeCells)
        expect(textsOf(cell), where).toEqual([outcome])
      } else {
        expect(logRows(tree).map(rowText)[0], where).toBe(`${outcome} Bash npm test`)
      }
    }
  }
})

// ---- Rows that a restore builds: a time or a start not known, an `ended` subagent, a cost since the restore ----

// A line whose time is not known has a dim dash in the time column, which keeps its width.
test('a log line with no known time draws a dim dash in its time column, as wide as a clock time', () => {
  const log = logLines(3, i => ({ who: 'main', ...(i === 1 ? { at: null } : {}) }))
  for (const surface of SURFACES) {
    for (const bodyColumns of [8, 20, 45, 120]) {
      const where = `${surface} ${bodyColumns} columns`
      const tree = draw(onSurface(withLog(log), surface), bodyColumns)
      const rows = logRows(tree)
      expect(rows.map(rowText), where).toEqual(['line 1', 'line 2', 'line 3'])
      expect(rowProblems(tree), where).toEqual([])
      const cells = rows.map(row => childrenOf(row)[0])
      expect(cells.map(cell => cell?.props?.width), where).toEqual([8, 8, 8])
      expect(cells.map(cell => textsOf(cell)[0]?.replace(/\d/g, '0')), where).toEqual(['00:00:00', '—', '00:00:00'])
      expect(childrenOf(cells[1]).map(styleOf), where).toEqual([[undefined, true, undefined]])
    }
  }
})

// An `ended` subagent and an `ended` task whose start the mod did not see are lanes of an unknown span, alike: the
// dashed line and the dim ring, and a dim dash for a value that is not known.
test('an `ended` subagent has the dim ring of an `ended` task, and a dim dash for a cost that is not known', () => {
  const agentRow = [agent(1, 'ended', { startedAt: null, costUsd: null })]
  const taskRow = [task(1, 'ended', { startedAt: null, durationMs: null })]
  for (const surface of SURFACES) {
    const lanes = [draw(withAgents(agentRow, surface)), draw(withTasks(taskRow, surface))]
      .map(tree => activityBody(tree)[1])
    if (surface === 'desktop') {
      const images = lanes.map(lane => childrenOf(childrenOf(lane)[1])[0]?.props)
      expect(images.map(image => image?.alt), surface).toEqual([
        'task 1 (@code-reviewer), ended, unknown', 'job 1 (@shell), ended, unknown',
      ])
      for (const image of images) {
        expect(String(image?.source), surface).toContain('data-part="dash"')
        expect(String(image?.source), surface).toContain('<circle r="3.5" fill="none" stroke="#8a8a8a"')
      }
      const values = lanes.map(lane => childrenOf(lane)[2])
      expect(values.map(value => textsOf(value)), surface).toEqual([['—'], ['—']])
      expect(values.map(value => childrenOf(value).map(styleOf)), surface).toEqual(
        Array(2).fill([[undefined, true, undefined]]),
      )
    } else {
      for (const lane of lanes) {
        const spans = childrenOf(lane).map(cell => childrenOf(cell)[0])
        expect(spans.filter(span => textsOf(span)[0] === '○').map(span => span?.props?.dimColor), surface)
          .toEqual([true])
        expect([textsOf(spans.at(-1))[0], spans.at(-1)?.props?.dimColor], surface).toEqual(['       —', true])
      }
    }
  }
})

// A subagent that was restored has a cost from the restore on only: the value shows `$x+`. The value's 8 cells hold
// the widest, `$148.59+` and `<$0.001+`, on every lane.
test('the cost of a restored subagent is `$x+` in a value of 8 cells; a cost not known stays a dim dash', () => {
  const costs: Array<[costUsd: number | null, shown: string]> = [
    [0.5, '$0.500+'], [12.345, '$12.35+'], [148.59, '$148.59+'], [0.0004, '<$0.001+'], [0, '$0+'], [null, '—'],
  ]
  for (const surface of SURFACES) {
    for (const [costUsd, shown] of costs) {
      const where = `${surface} ${shown}`
      const rows = [agent(1, 'ended', { startedAt: null, costUsd, restored: true }), agent(2, 'done')]
      for (const bodyColumns of [8, 45, 120]) {
        const tree = draw(withAgents(rows, surface), bodyColumns)
        expect(rowProblems(tree), where).toEqual([])
        // Neither lane has a known end: they keep their order, the restored one first.
        const [, restored, live] = activityBody(tree)
        const valueOf = (lane: Node | undefined): string | undefined => (surface === 'desktop'
          ? textsOf(childrenOf(lane)[2])[0]
          : textsOf(childrenOf(lane).at(-1))[0])
        expect(shown.length, where).toBeLessThanOrEqual(8)
        // A terminal line is cut to the body: at 8 columns the label alone overruns it, and the value is cut away.
        if (surface === 'terminal' && bodyColumns < 20) continue
        expect(valueOf(restored), where).toBe(surface === 'desktop' ? shown : shown.padStart(8))
        expect(valueOf(live), where).toBe(surface === 'desktop' ? '$2.50' : '   $2.50')
        if (surface === 'desktop') expect(childrenOf(restored)[2]?.props?.width, where).toBe(8)
      }
    }
  }
})

// The split of the cost: while a row is restored, the Subagents have the cost since the restore, and Session is not
// shown, for it would be Total less a cost that is not the whole.
test('while a subagent is restored the split is `Subagents $Y+` with no Session; a live one keeps its split', () => {
  // `total` is the Total cost, null for none.
  const dataOf = (rows: AgentRow[], surface: Surface, total: number | null = 148.59): PaneData => ({
    ...onSurface(FULL, surface), usage: { ...FULL.usage, costUsd: total ?? undefined }, agents: agentsOf(rows),
  })
  const read = (data: PaneData): string[] => textsOf(childrenOf(draw(data))[0]).filter(text => !/^[▰▱]+$/.test(text))
  const split = (data: PaneData): string[] => read(data).filter(text => /^(Session |Subagents )/.test(text))
  for (const surface of SURFACES) {
    const restored = (costUsd: number | null, n = 1): AgentRow => (
      agent(n, 'ended', { startedAt: null, costUsd, restored: true })
    )
    // Y is 0: nothing known, and the line is there all the same.
    expect(split(dataOf([restored(null)], surface)), surface).toEqual(['Subagents $0+'])
    expect(split(dataOf([restored(0)], surface)), surface).toEqual(['Subagents $0+'])
    // Y is the sum of the known costs, those of the restored rows and of the live ones.
    expect(split(dataOf([restored(1.5), agent(2, 'done', { costUsd: 2 }), restored(null, 3)], surface)), surface)
      .toEqual(['Subagents $3.50+'])
    // The Total, at the right edge of the first row, is as it was.
    expect(read(dataOf([restored(1.5)], surface))).toContain('$148.59')
    // No total: no split line, as for live rows.
    expect(split(dataOf([restored(1.5)], surface, null)), surface).toEqual([])
    // A total and Y = 0: the line is there.
    expect(split(dataOf([restored(null)], surface, 3)), surface).toEqual(['Subagents $0+'])
    // A live row with no cost, and no restored one: as before, no `+` and no line.
    expect(split(dataOf([agent(1, 'running', { costUsd: null })], surface)), surface).toEqual([])
    expect(split(dataOf([agent(1, 'running', { costUsd: 0.25 })], surface)), surface)
      .toEqual(['Session $148.34 · Subagents $0.250'])
    // The line is dim and cut, the last row of the card.
    const [top] = childrenOf(draw(dataOf([restored(1.5)], surface)))
    expect(childrenOf(top).at(-1)?.props, surface).toMatchObject({ dimColor: true, wrap: 'truncate' })
  }
})

test('the pane draws restored rows with hostile ids', () => {
  const ids = ['__proto__', 'constructor', 'toString']
  const launch = (id: string) => ({
    tool_use_id: `toolu_a${id}`, tool: 'Agent', agentId: id,
    input: { description: 'Map the flow', subagent_type: 'Explore' }, result: { status: 'async_launched', agentId: id },
  })
  const shell = (id: string) => ({
    tool_use_id: `toolu_b${id}`, tool: 'Bash', input: { command: 'npm run dev', run_in_background: true },
    result: { backgroundTaskId: id },
  })
  const rows = [{ role: 'assistant', text: '', toolUses: [...ids.map(launch), ...ids.map(shell)] }]
  const restored = restoreFromMessages(rows, new Set(ids), ROOT)
  expect(Object.keys(restored.agents)).toEqual([...ids].reverse())
  expect(Object.keys(restored.tasks)).toEqual([...ids].reverse())
  const tree = draw({ ...EMPTY, ...restored }, 45, 40)
  expect(rowProblems(tree)).toEqual([])
  expect(textsOf(tree).filter(text => text === 'Map the flow')).toHaveLength(3)
})

// ---- Turn stats as the ribbon (spec 0.7.0 §5) ----

// A finished turn of two steps, as lastTurn keeps it: 38 s of model, a Bash call of 10 s, then 30 s of model.
const TWO_STEPS = {
  startedAt: NOW - 78_000, endedAt: NOW,
  steps: [{ tStart: NOW - 78_000, tEnd: NOW - 40_000 }, { tStart: NOW - 30_000, tEnd: NOW }],
  tools: [{ t0: NOW - 40_000, t1: NOW - 30_000, station: 'shell' as const, label: 'Bash ls', failed: false }],
  earlier: zeroStationMs(),
}
const RIBBONED: PaneData = { ...FULL, lastTurn: { ...TURN, ribbon: TWO_STEPS } }
// A turn that runs: a step of 5 s with a Bash call of 3 s after it, and the model at work since.
const RUNNING: TurnAcc = {
  turnId: 't9', startedAt: NOW - 20_000, costAtStart: null,
  steps: [{ tStart: NOW - 20_000, tFirst: NOW - 19_500, tEnd: NOW - 15_000, usage: {}, hasTool: true, hasText: false }],
  toolIntervals: [[NOW - 15_000, NOW - 12_000]],
  tools: [{ t0: NOW - 15_000, t1: NOW - 12_000, station: 'shell', label: 'Bash ls', failed: false }],
  earlier: zeroStationMs(),
}
// The rows of the Turn stats body, and its section.
const turnSectionOf = (tree: unknown): Node | undefined =>
  headerRows(tree).find(header => header.id === 'turn')?.section
const turnBody = (tree: unknown): Node[] => childrenOf(childrenOf(turnSectionOf(tree))[2])
// The ribbon's image: the Svg whose alt starts with `Turn` and a time (the icon's is `Turn stats`).
const ribbonOf = (tree: unknown): Node | undefined =>
  flat(tree).map(({ node }) => node).find(node => node.type === 'Svg' && /^Turn \d/.test(String(node.props?.alt)))
// The right ends of the ribbon's parts, in px.
const partEnds = (source: string): number[] =>
  [...source.matchAll(/data-part="(?:model|tool|earlier|live)" x="([\d.]+)" y="3" width="([\d.]+)"/g)]
    .map(([, x, w]) => Number(x) + Number(w))

test('Turn stats is a bar row, a legend row and a closed details row', () => {
  const tree = draw(RIBBONED)
  const [bar, legend, details, ...rest] = turnBody(tree)
  expect(rest).toEqual([])
  // The bar row: the ribbon, min(45 × 8 − 64, 4096) px by 16, in a FLEX cell, and the elapsed time in a FIXED 7.
  expect(bar?.props).toMatchObject({ flexDirection: 'row', height: 1, alignItems: 'center', columnGap: 1 })
  const [area, elapsed] = childrenOf(bar)
  expect(isFlex(area)).toBe(true)
  expect(childrenOf(area)[0]?.props).toMatchObject({ width: 296, height: 16 })
  expect(String(childrenOf(area)[0]?.props?.alt)).toStartWith('Turn 1m 18s: ')
  expect(elapsed?.props).toMatchObject({ width: 7, flexShrink: 0, justifyContent: 'flex-end' })
  expect(textsOf(elapsed)).toEqual(['1m 18s'])
  // The legend: the swatch, 8 by 8 in the Model hue, alt `Model`, in a slot of a cell, then the Texts.
  const [slot, items] = childrenOf(legend)
  expect(slot?.props).toMatchObject({ width: 1, flexShrink: 0 })
  expect(childrenOf(slot)[0]?.props).toMatchObject({ alt: 'Model', width: 8, height: 8 })
  expect(String(childrenOf(slot)[0]?.props?.source)).toContain(`rx="1.5" fill="${STATION_HUES.model.dark}"`)
  expect(textsOf(items).slice(0, 4)).toEqual(['Model', '\u{a0}85%', '\u{a0}·\u{a0}', 'Tools'])
  // The details row: a plain dim Button, closed.
  expect(details?.type).toBe('Button')
  expect(details?.props).toMatchObject({ key: 'details:turn', label: '▸ details', plain: true, dimColor: true })
  expect(textsOf(tree)).not.toContain('Whole turn')
  expect(rowProblems(tree)).toEqual([])

  // Open, it reads `▾ details` and today's rows follow it.
  const open = draw({ ...RIBBONED, collapsed: { turnDetails: false } })
  const openRows = turnBody(open)
  expect(openRows[2]?.props?.label).toBe('▾ details')
  expect(openRows.slice(3).map(row => textsOf(row)[0])).toEqual([
    'Response', 'Whole turn', 'Elapsed', 'Model time', 'Tool time', 'Average TTFT', 'Steps', 'Tokens', 'Cache', 'Cost',
  ])
  expect(rowProblems(open)).toEqual([])

  // The terminal: the bar, the legend and the details Button, 3 rows.
  const terminal = turnBody(draw(onSurface(RIBBONED, 'terminal')))
  expect(terminal).toHaveLength(3)
  expect(spanTexts(terminal[0]).at(-1)).toBe(' 1m 18s')
  expect(spanTexts(terminal[1])[0]).toBe('Model')
  expect(terminal[2]?.props).toMatchObject({ key: 'details:turn', label: '▸ details' })
})

test('the terminal bar row prints the stats\' elapsed time, as the desktop does, not its ribbon\'s span', () => {
  // The ribbon spans 78 s; the engine's duration for the same turn is 80 s.
  const data: PaneData = { ...RIBBONED, lastTurn: { ...TURN, elapsedMs: 80_000, ribbon: TWO_STEPS } }
  expect(spanTexts(turnBody(draw(onSurface(data, 'terminal')))[0]).at(-1)).toBe(' 1m 20s')
  expect(textsOf(childrenOf(turnBody(draw(data))[0])[1])).toEqual(['1m 20s'])
})

test('a running turn draws live and idle draws the last turn', () => {
  const live = String(ribbonOf(draw({ ...RIBBONED, turn: RUNNING }))?.props?.source)
  expect(live).toContain('data-part="cap"')
  expect(live).toContain('data-part="rest"')

  const idle = String(ribbonOf(draw(RIBBONED))?.props?.source)
  expect(idle).not.toContain('data-part="cap"')
  expect(idle).not.toContain('data-part="rest"')
  expect(Math.max(...partEnds(idle))).toBe(296) // the bar fills its area

  // Neither: today's placeholder, its rule, its header and its line.
  const none = draw({ ...FULL, turn: null, lastTurn: null })
  expect(textsOf(turnSectionOf(none))).toContain('No completed turn yet')
  expect(rowsOf(turnSectionOf(none) as Node, 45, 1.5)).toBe(3)
})

test('the legend gives way on a narrow pane', () => {
  const legend = (cols: number): string[] => textsOf(turnBody(draw(RIBBONED, cols))[1])
  expect(legend(36)).toContain('TTFT')
  expect(legend(35)).not.toContain('TTFT')
  expect(legend(30).some(text => text.endsWith('steps'))).toBe(true)
  expect(legend(29).some(text => text.endsWith('steps'))).toBe(false)
})

test('a lastTurn of 0.6.1 with no ribbon draws an empty bar', () => {
  const { ribbon: _, ...old } = TURN
  for (const surface of SURFACES) {
    const tree = draw(onSurface({ ...FULL, lastTurn: old as never }, surface))
    const rows = turnBody(tree)
    expect(rows, surface).toHaveLength(3)
    expect(rows[2]?.props?.key, surface).toBe('details:turn')
    expect(rowProblems(tree), surface).toEqual([])
  }
  const image = ribbonOf(draw({ ...FULL, lastTurn: old as never }))
  expect(String(image?.props?.alt)).toStartWith('Turn 1m 18s')
  expect(String(image?.props?.source)).not.toContain('data-part=')
  // A turn of 0.6.1, with no `tools` and no `earlier`, draws live.
  const { tools: _t, earlier: _e, ...older } = RUNNING
  expect(String(ribbonOf(draw({ ...FULL, turn: older as never }))?.props?.source)).toContain('data-part="cap"')
})

test('isSectionFolded inverts the default of turnDetails only', () => {
  expect(isSectionFolded({}, 'turnDetails')).toBe(true)
  expect(isSectionFolded({}, 'turn')).toBe(false)
  expect(isSectionFolded({ turnDetails: false }, 'turnDetails')).toBe(false)
  expect(isSectionFolded({ turnDetails: true }, 'turnDetails')).toBe(true)
  expect(isSectionFolded({ turn: true }, 'turn')).toBe(true)
  // A key that is no own key folds nothing; turnDetails keeps its default.
  const hostile = JSON.parse('{"__proto__": true}') as Record<string, boolean>
  for (const id of SECTIONS) expect(isSectionFolded(hostile, id), id).toBe(false)
  expect(isSectionFolded(hostile, 'turnDetails')).toBe(true)
  // An inherited key is no own key: it neither folds a section nor opens the details.
  expect(isSectionFolded(Object.create({ turn: true }) as Record<string, boolean>, 'turn')).toBe(false)
  expect(isSectionFolded(Object.create({ turnDetails: false }) as Record<string, boolean>, 'turnDetails')).toBe(true)
})

test('a running turn draws its own table, elapsed time and summary, not the last turn\'s', () => {
  // The running step wrote 100 tokens in its 5 s: the live summary is ~20 tok/s; the last turn's would be ~62 tok/s.
  const [step] = RUNNING.steps
  const running: TurnAcc = { ...RUNNING, steps: step === undefined ? [] : [{ ...step, usage: { output_tokens: 100 } }] }
  const tree = draw({ ...RIBBONED, turn: running, collapsed: { turnDetails: false } })
  const rows = turnBody(tree)
  // The elapsed time is the clock's (ruling D): now − startedAt = 20 s.
  expect(textsOf(childrenOf(rows[0])[1])).toEqual([fmtDuration(NOW - running.startedAt)])
  expect(fmtDuration(NOW - running.startedAt)).toBe('20.0s')
  // The table is the running turn's: 5 s of model and 3 s of tools, where the last turn had 1m 06s and 11.4s.
  const table = Object.fromEntries(rows.slice(3).map(row => [textsOf(row)[0], textsOf(row)[1]]))
  expect(table).toMatchObject({ 'Elapsed': '20.0s', 'Model time': '5.0s', 'Tool time': '3.0s' })
  expect(headerRows(tree).find(header => header.id === 'turn')?.summary).toBe('~20 tok/s')
  // Before any step has stopped there is no rate: the summary cell is empty.
  const unstarted = draw({ ...RIBBONED, turn: { ...RUNNING, steps: [], toolIntervals: [], tools: [] } })
  expect(headerRows(unstarted).find(header => header.id === 'turn')?.summary).toBeUndefined()
})

// ---- Activity (spec 0.7.0 §6) ----

// §2.3's session at its own clock, in local time so that the axis labels hold in any zone: five subagents, three
// tasks, main's three turns and its running turn, and a Total of $4.97, of which the subagents cost $1.77.
const LANES_NOW = new Date(2026, 10, 16, 12, 4, 20).getTime()
const lanesAgo = (seconds: number): number => LANES_NOW - seconds * 1000
const LANES: PaneData = {
  ...EMPTY,
  usage: { rateLimits: [], costUsd: 4.97 },
  turn: { ...RUNNING, startedAt: lanesAgo(134), steps: [], toolIntervals: [], tools: [] },
  agents: agentsOf([
    agent(1, 'running', {
      description: 'Review the diff', type: 'pr-review:code-reviewer', startedAt: lanesAgo(360), costUsd: 0.31,
    }),
    agent(2, 'running', {
      description: 'Plan critique', type: 'plan-critic', startedAt: null, costUsd: 0.41, restored: true,
    }),
    agent(3, 'done', {
      description: 'Map the mask', type: 'explorer', startedAt: lanesAgo(69), endedAt: lanesAgo(46), costUsd: 0.12,
    }),
    agent(4, 'failed', {
      description: 'Repro check', type: 'general-purpose', startedAt: lanesAgo(240), endedAt: lanesAgo(180),
      costUsd: 0.05,
    }),
    agent(5, 'done', {
      description: 'Engine facts', type: 'general-purpose', startedAt: lanesAgo(720), endedAt: lanesAgo(240),
      costUsd: 0.88,
    }),
  ]),
  tasks: tasksOf([
    task(1, 'running', { description: 'npm test', startedAt: lanesAgo(220) }),
    task(2, 'done', {
      description: 'claude plugin test', startedAt: lanesAgo(580), endedAt: lanesAgo(562), durationMs: 18_200,
    }),
    task(3, 'stopped', {
      description: 'dev server', startedAt: lanesAgo(600), endedAt: lanesAgo(360), durationMs: 240_000,
    }),
  ]),
  mainTurns: [
    { start: lanesAgo(750), end: lanesAgo(530) }, { start: lanesAgo(380), end: lanesAgo(220) },
    { start: lanesAgo(134), end: null },
  ],
  now: LANES_NOW,
}
// §6.2's alts of the example's lanes, in their order. Plan critique is restored, so main's cost is not known.
const LANE_ALTS = [
  'main, running, unknown', 'Review the diff (@code-reviewer), running, $0.310', 'npm test (@shell), running, 3m 40s',
  'Plan critique (@plan-critic), running, $0.410+', 'Map the mask (@explorer), done, $0.120',
  'Repro check (@general-purpo…), failed, $0.050', 'Engine facts (@general-purpo…), done, $0.880',
  'dev server (@shell), stopped, 4m 00s',
]
// The Activity section, and the rows of its body.
const activityOf = (tree: unknown): Node | undefined => sectionOf(tree, 'activity')
const activityBody = (tree: unknown): Node[] => childrenOf(childrenOf(activityOf(tree))[2])
// The keys of the Buttons of a tree, in order.
const buttonKeys = (tree: unknown): unknown[] =>
  flat(tree).flatMap(({ node }) => (node.type === 'Button' ? [node.props?.key] : []))

test('Activity replaces Subagents and Tasks', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  await seed($, clock, bottom(on, clock))
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await headers(ui), surface).toEqual([
      '▾ Usage', '▾ Turn stats', '▾ Activity', '▾ MCP', '▾ Context sources', '▾ Log',
    ])
    expect((await ui.findAll({ type: 'Button' })).map(button => button.key), surface).toEqual([
      'toggle:usage', 'toggle:turn', 'details:turn', 'toggle:activity', 'toggle:mcp', 'toggle:sources', 'toggle:log',
    ])
    // One of the two subagents runs; main's lane is not counted.
    expect((await summaries(ui)).activity, surface).toBe('1/2')
    await ui.unmount()
  }
})

test('Activity is hidden with no subagents and no tasks', () => {
  const mainOnly: PaneData = { ...LANES, agents: {}, tasks: {} }
  for (const surface of SURFACES) {
    for (const data of [EMPTY, mainOnly]) {
      const tree = draw(onSurface(data, surface))
      expect(buttonKeys(tree), surface).not.toContain('toggle:activity')
      expect(activityOf(tree), surface).toBeUndefined()
    }
    // A lone subagent or a lone task brings it back.
    expect(buttonKeys(draw(onSurface({ ...mainOnly, tasks: LANES.tasks }, surface))), surface)
      .toContain('toggle:activity')
  }
})

test('a lane row is a label of L cells, an Svg of 19 px and a value of 8 cells', () => {
  // At 41 columns L is 18 cells and the area 41 × 8 − (18 + 10) × 8 = 104 px. Below 24 cells there is no tag: the
  // label cell holds the description alone, one spanLine.
  const tree = draw(LANES, 41)
  const body = activityBody(tree)
  expect(body).toHaveLength(10)
  const lanes = body.slice(0, 8)
  for (const lane of lanes) {
    const [label, area, value, ...rest] = childrenOf(lane)
    expect(rest).toEqual([])
    expect(lane.props).toMatchObject({ flexDirection: 'row', alignItems: 'center', columnGap: 1 })
    expect(isFixed(label) && label?.props?.width).toBe(18)
    expect(childrenOf(label)).toHaveLength(1)
    expect(isSpanLine(childrenOf(label)[0])).toBe(true)
    expect(isFlex(area)).toBe(true)
    expect(childrenOf(area).map(image => [image.type, image.props?.width, image.props?.height])).toEqual([
      ['Svg', 104, 19],
    ])
    expect(isFixed(value)).toBe(true)
    expect(value?.props).toMatchObject({ width: 8, justifyContent: 'flex-end' })
  }
  expect(lanes.map(lane => childrenOf(childrenOf(lane)[1])[0]?.props?.alt)).toEqual(LANE_ALTS)
  expect(lanes.map(lane => textsOf(childrenOf(lane)[0]).join(''))).toEqual([
    'main', 'Review the diff', 'npm test', 'Plan critique', 'Map the mask', 'Repro check', 'Engine facts', 'dev server',
  ])
  // Running lanes and main primary, the rest dim.
  expect(lanes.map(lane => flat(childrenOf(lane)[0]).find(({ node }) => node.type === 'Text')?.node.props?.dimColor))
    .toEqual([undefined, undefined, undefined, undefined, true, true, true, true])
  expect(lanes.map(lane => textsOf(childrenOf(lane)[2]))).toEqual([
    ['—'], ['$0.310'], ['3m 40s'], ['$0.410+'], ['$0.120'], ['$0.050'], ['$0.880'], ['4m 00s'],
  ])
  // The axis row: an empty label cell, the axis 104 × 16, an empty value cell.
  const [axisLabel, axisArea, axisValue, ...axisRest] = childrenOf(body[8])
  expect(axisRest).toEqual([])
  expect(body[8]?.props).toMatchObject({ flexDirection: 'row', alignItems: 'center', columnGap: 1 })
  expect(isFixed(axisLabel) && axisLabel?.props?.width).toBe(18)
  expect(isFlex(axisArea)).toBe(true)
  expect(childrenOf(axisArea).map(image => [image.type, image.props?.width, image.props?.height, image.props?.alt]))
    .toEqual([['Svg', 104, 16, 'axis 11:52 to now']])
  expect(isFixed(axisValue) && axisValue?.props?.width).toBe(8)
  expect([...childrenOf(axisLabel), ...childrenOf(axisValue)]).toEqual([])
  // `+1 more`: dim, at column 0.
  expect(textsOf(body[9])).toEqual(['+1 more'])
  expect(body[9]?.props?.paddingLeft).toBeUndefined()
  expect(childrenOf(body[9]).map(styleOf)).toEqual([[undefined, true, undefined]])
  // No element of the section is keyed by a lane id: its one key is its chevron's.
  const ids = new Set([...Object.keys(LANES.agents), ...Object.keys(LANES.tasks), 'main'])
  const keys = flat(activityOf(tree)).flatMap(({ node }) => (node.props?.key === undefined ? [] : [node.props.key]))
  expect(keys).toEqual(['toggle:activity'])
  expect(keys.some(key => ids.has(String(key)))).toBe(false)
  expect(rowProblems(tree)).toEqual([])
})

test('the terminal Activity rows at 44 columns are §4.5\'s', () => {
  const tree = draw(onSurface(LANES, 'terminal'), 44)
  const [header] = headerRows(activityOf(tree))
  expect([header?.title, header?.label, header?.summary]).toEqual(['Activity', '▾', '3/8'])
  const body = activityBody(tree)
  expect(body.every(isSpanLine)).toBe(true)
  // Main's value is a dash: Plan critique is restored, so main's cost is not known.
  expect(body.map(line => spanTexts(line).join(''))).toEqual([
    'main                ────   ─── ━━━◐        —',
    'Review the diff            ━━━━━━━◐   $0.310',
    'npm test                      ━━━━◐   3m 40s',
    'Plan critique       ┄┄┄┄┄┄┄┄┄┄┄┄┄┄◐  $0.410+',
    'Map the mask                     ─✓   $0.120',
    'Repro check                  ──✗      $0.050',
    'Engine facts        ─────────✓        $0.880',
    'dev server            ─────■          4m 00s',
    '                                now',
    '+1 more',
  ])
  expect(rowProblems(tree)).toEqual([])
})

test('the desktop label column at 108 columns: a 32-cell description Box, then the whole tag', () => {
  const tree = draw(LANES, 108)
  const lanes = activityBody(tree).slice(0, 8)
  const tags = ['@code-reviewer', '@shell', '@plan-critic', '@explorer', '@general-purpo…', '@general-purpo…', '@shell']
  lanes.forEach((lane, i) => {
    const label = childrenOf(lane)[0]
    expect(isFixed(label) && label?.props?.width, String(i)).toBe(48)
    expect(childrenOf(label), String(i)).toHaveLength(1)
    const [inner] = childrenOf(label)
    if (i === 0) {
      // Main has no tag: its description alone.
      expect(isSpanLine(inner)).toBe(true)
      expect(spanTexts(inner)).toEqual(['main'])
      return
    }
    expect(isRow(inner) && isFixed(inner), String(i)).toBe(true)
    const [desc, tag, ...rest] = childrenOf(inner)
    expect(rest).toEqual([])
    expect(isRow(desc) && isFixed(desc), String(i)).toBe(true)
    expect(desc?.props).toMatchObject({ width: 32, overflow: 'hidden' })
    expect(childrenOf(desc), String(i)).toHaveLength(1)
    expect(isSpanLine(childrenOf(desc)[0]), String(i)).toBe(true)
    expect(spanTexts(childrenOf(desc)[0]), String(i)).toEqual([LANE_ALTS[i]?.split(' (')[0]])
    expect(flat(desc).some(({ node }) => node.props?.wrap !== undefined), String(i)).toBe(false)
    expect(isRow(tag) && isFixed(tag), String(i)).toBe(true)
    expect(childrenOf(tag).map(text => [text.type, textsOf(text), text.props?.dimColor]), String(i))
      .toEqual([['Text', [`\u{a0}${tags[i - 1]}`], true]])
  })
  expect(rowProblems(tree)).toEqual([])
})

test('the old agents and tasks folds are ignored', () => {
  for (const surface of SURFACES) {
    const tree = draw(onSurface({ ...LANES, collapsed: { agents: true, tasks: true } }, surface))
    expect(headerRows(tree).find(header => header.id === 'activity')?.label, surface).toBe('▾')
    expect(activityBody(tree), surface).toHaveLength(10)
  }
})

test('the Activity rows count: rule, header, lanes, axis and +N more', () => {
  // With no Total there is no split line, with or without the subagents: only the Activity block differs.
  const log = logLines(60)
  const withLanes: PaneData = { ...LANES, usage: { rateLimits: [] }, log, logCount: 60 }
  const without: PaneData = { ...withLanes, agents: {}, tasks: {} }
  for (const surface of SURFACES) {
    for (const bodyColumns of [20, 45, 120]) {
      const where = `${surface} ${bodyColumns}`
      const tree = draw(onSurface(withLanes, surface), bodyColumns, 60)
      const none = draw(onSurface(without, surface), bodyColumns, 60)
      expect(rowsOf(activityOf(tree) as Node, bodyColumns, 1.5), where).toBe(12)
      expect(rowsAbove(tree, bodyColumns, surface) - rowsAbove(none, bodyColumns, surface), where).toBe(12)
      expect(logRows(none).length - logRows(tree).length, where).toBe(12)
      expect(moreOf(tree), where).toBe(60 - logRows(tree).length)
    }
  }
})

test('while a subagent is restored main\'s lane value is a dim dash; with none restored it is Session', () => {
  // LANES's Plan critique is restored: Session, Total less a cost that is not the whole, is not known.
  const { a2, ...rest } = LANES.agents
  const live: PaneData = { ...LANES, agents: { ...rest, a2: { ...(a2 as AgentRow), restored: undefined } } }
  for (const surface of SURFACES) {
    const mainOf = (data: PaneData): Node | undefined => activityBody(draw(onSurface(data, surface), 44))[0]
    if (surface === 'desktop') {
      const [, image, value] = childrenOf(mainOf(LANES))
      expect(String(childrenOf(image)[0]?.props?.alt), surface).toBe('main, running, unknown')
      expect(childrenOf(value).map(el => [textsOf(el)[0], el.props?.dimColor]), surface).toEqual([['—', true]])
      const [, liveImage, liveValue] = childrenOf(mainOf(live))
      expect(String(childrenOf(liveImage)[0]?.props?.alt), surface).toBe('main, running, $3.20')
      expect(childrenOf(liveValue).map(el => [textsOf(el)[0], el.props?.dimColor]), surface).toEqual([
        ['$3.20', undefined],
      ])
    } else {
      const last = (data: PaneData): Node | undefined => childrenOf(childrenOf(mainOf(data)).at(-1))[0]
      expect([textsOf(last(LANES))[0], last(LANES)?.props?.dimColor], surface).toEqual(['       —', true])
      expect([textsOf(last(live))[0], last(live)?.props?.dimColor], surface).toEqual(['   $3.20', undefined])
    }
  }
})

// ---- The whole pane at its limits (spec 0.7.0 §9) ----

// A turn of `count` steps with a call after each, built the way the hooks build it: addStep folds what leaves the
// window of 60 steps, addTool adds each call. The calls go round the seven tool stations.
const TOOL_STATIONS: ToolStationId[] = STATION_ORDER.filter((id): id is ToolStationId => id !== 'model')
const stepsTurn = (count: number): TurnAcc => {
  const startedAt = NOW - count * 2000
  let acc: TurnAcc = {
    turnId: 't1', startedAt, costAtStart: null, steps: [], toolIntervals: [], tools: [], earlier: zeroStationMs(),
  }
  for (let i = 0; i < count; i++) {
    const t = startedAt + i * 2000
    acc = addStep(acc, {
      tStart: t, tFirst: t + 100, tEnd: t + 1000, usage: { output_tokens: 10 }, hasTool: true, hasText: false,
    })
    acc = { ...acc, toolIntervals: [...acc.toolIntervals, [t + 1000, t + 1800]] }
    acc = addTool(acc, {
      t0: t + 1000, t1: t + 1800, station: TOOL_STATIONS[i % TOOL_STATIONS.length] as ToolStationId,
      label: `Read file${i}.ts`, failed: i % 3 === 0,
    })
  }

  return acc
}
// The caps: all eight stations running and failing with a pulse due, a turn of `steps` steps, 8 lanes and 20 more
// (14 subagents and 14 tasks, main's lane makes the 8), and a Log of 200 lines.
const atCaps = (steps = 60): PaneData => ({
  ...FULL,
  mainModel: 'claude-sonnet-5',
  turn: stepsTurn(steps),
  stations: Object.fromEntries(
    STATION_ORDER.map(id => [id, { calls: 12, failedThisTurn: 2, lastCallAt: NOW - 100 }]),
  ) as never,
  inFlight: Object.fromEntries(
    TOOL_STATIONS.map((station, i) => [`u${i}`, { station, agentId: null, at: NOW - 200, label: station }]),
  ),
  agents: agentsOf(Array.from({ length: 14 }, (_, i) => (
    agent(i + 1, i % 3 === 2 ? 'failed' : 'running', { startedAt: NOW - (i + 1) * 20_000 })
  ))),
  tasks: tasksOf(Array.from({ length: 14 }, (_, i) => task(i + 1, i % 2 === 0 ? 'running' : 'done'))),
  mainTurns: [{ start: NOW - 400_000, end: NOW - 300_000 }, { start: NOW - 20_000, end: null }],
  log: logLines(200),
  logCount: 450,
})
// Every Svg of a tree.
const svgsOf = (tree: unknown): Node[] => flat(tree).map(({ node }) => node).filter(node => node.type === 'Svg')

test('regression check: no Svg is interactive and no source holds a title, on either surface', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  await seed($, clock, bottom(on, clock))
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const svgs = await ui.findAll({ type: 'Svg' })
    // The desktop draws images, the terminal none: the check is not empty where there is something to check.
    expect(svgs.length > 0, surface).toBe(surface === 'desktop')
    for (const svg of svgs) {
      expect(svg.props.isInteractive, `${surface} ${svg.props.alt}`).toBeUndefined()
      expect(String(svg.props.source), `${surface} ${svg.props.alt}`).not.toContain('<title')
    }
    await ui.unmount()
  }
  for (const surface of SURFACES) {
    for (const svg of svgsOf(draw(onSurface(atCaps(), surface), 120))) {
      expect(svg.props?.isInteractive, `${surface} ${svg.props?.alt}`).toBeUndefined()
      expect(String(svg.props?.source), `${surface} ${svg.props?.alt}`).not.toContain('<title')
    }
  }
})

// The Svgs that draw something: not a rule, a meter (its alt ends in `%`) or an icon (14 px square: the view's
// ICON_PX).
const isDrawing = (node: Node): boolean => {
  const isIcon = node.props?.width === 14 && node.props?.height === 14

  return node.props?.alt !== 'rule' && !/%$/.test(String(node.props?.alt)) && !isIcon
}

test('regression check: at most 12 drawing Svgs at the caps: band, ribbon, swatch, 8 lanes, axis', () => {
  const alts = svgsOf(draw(atCaps(), 120)).filter(isDrawing).map(node => String(node.props?.alt))
  // Every Svg left is one of the 12 by its alt: a new drawing would be left over.
  const kinds: [string, (alt: string) => boolean, number][] = [
    ['band', alt => alt.startsWith('Context '), 1],
    ['ribbon', alt => /^Turn \d/.test(alt), 1],
    ['swatch', alt => alt === 'Model', 1],
    ['lanes', alt => /^.+, (running|done|failed|stopped|ended), /.test(alt), 8],
    ['axis', alt => /^axis /.test(alt), 1],
  ]
  const left = alts.filter(alt => !kinds.some(([, isKind]) => isKind(alt)))
  expect(left).toEqual([])
  for (const [name, isKind, count] of kinds) expect(alts.filter(isKind), name).toHaveLength(count)
  expect(alts).toHaveLength(12)
})

// Every tag of a source closes, in order: a stack over the tags, a self-closing one pushes nothing.
const isBalanced = (source: string): boolean => {
  const stack: string[] = []
  for (const [tag, name, selfClosing] of source.matchAll(/<\/?([a-zA-Z][\w-]*)[^>]*?(\/?)>/g)) {
    if (selfClosing === '/') continue
    if (!tag.startsWith('</')) stack.push(String(name))
    else if (stack.pop() !== name) return false
  }

  return stack.length === 0
}

test('regression check: isBalanced tells a closed source from an open one and a stray tag', () => {
  expect(isBalanced('<svg><g><path d="x"/><text>a</text></g></svg>')).toBe(true)
  expect(isBalanced('<svg><g></svg>')).toBe(false)
  expect(isBalanced('<svg><text>a<b</text></svg>')).toBe(false)
  expect(isBalanced('<svg></g></svg>')).toBe(false)
})

const HOSTILE_AGENT = '<script>&"\'\u{1}'
const HOSTILE: PaneData = {
  ...atCaps(),
  mainModel: 'claude-<x>',
  agents: agentsOf([agent(1, 'running', { description: HOSTILE_AGENT, type: '<script>&"\'\u{1}' })]),
  tasks: tasksOf([task(1, 'running', { description: 'a<b' })]),
  // Under C-no no Svg draws a tool label (no `<title>`): the `<x>` absence below guards against a future `<title>`.
  turn: {
    ...RUNNING, tools: [{ t0: NOW - 15_000, t1: NOW - 12_000, station: 'files', label: 'Read <x>.ts', failed: false }],
  },
}

test('regression check: hostile texts keep every Svg well-formed and raw texts out of every source', () => {
  for (const bodyColumns of [45, 120]) {
    const svgs = svgsOf(draw(HOSTILE, bodyColumns))
    // The hostile texts are drawn, so that their absence from a source is the escaping's and not a missing text.
    const alts = svgs.map(svg => String(svg.props?.alt))
    expect(alts.some(alt => alt.includes('<script>&"\'')), 'agent').toBe(true)
    expect(alts.some(alt => alt.includes('a<b')), 'task').toBe(true)
    expect(alts.some(alt => alt.includes('<x>')), 'model').toBe(true)
    for (const svg of svgs) {
      const where = String(svg.props?.alt)
      const source = String(svg.props?.source)
      expect(isBalanced(source), where).toBe(true)
      // The tool label's `<x>` is no Svg's text today (C-no): this guards against a future `<title>`.
      for (const raw of ['<script', 'a<b', '<x>', '\u{1}']) expect(source, `${where}: ${raw}`).not.toContain(raw)
      expect(String(svg.props?.alt), where).not.toContain('\u{1}')
    }
  }
})

test('regression check: tiny panes draw and do not throw: Svgs in [1, 4096], no terminal row too wide', () => {
  for (const surface of SURFACES) {
    for (const data of [FULL, atCaps(), HOSTILE]) {
      for (const cols of [0, 8, 20, 39]) {
        const where = `${surface} ${cols}`
        const tree = draw(onSurface(data, surface), cols)
        for (const { props } of svgsOf(tree)) {
          expect(props?.width, where).toBeGreaterThanOrEqual(1)
          expect(props?.width, where).toBeLessThanOrEqual(4096)
          expect(props?.height, where).toBeGreaterThanOrEqual(1)
          expect(props?.height, where).toBeLessThanOrEqual(4096)
        }
        if (surface === 'terminal') {
          // The rows 0.7.0 draws as spans: the band's, the ribbon's and legend's, the lanes'. (Usage's text meter is
          // a fixed cell of 10 that its Box clips, by design.)
          const rows = [childrenOf(tree)[0], turnSectionOf(tree), activityOf(tree)]
            .flatMap(block => flat(block).map(({ node }) => node))
            .filter(isSpanLine)
          expect(rows.length > 0, where).toBe(true)
          for (const row of rows) {
            expect([...spanTexts(row).join('')].length, `${where} ${spanTexts(row).join('')}`)
              .toBeLessThanOrEqual(Math.max(cols, 0))
          }
        }
      }
    }
  }
})

// The mean of a call of `renderPane` in ms: the best of 5 batches of 20 calls, after 5 warm-ups.
const bestBatchMs = (data: PaneData, bodyColumns: number): number => {
  for (let i = 0; i < 5; i++) draw(data, bodyColumns)
  const means: number[] = []
  for (let batch = 0; batch < 5; batch++) {
    const start = performance.now()
    for (let i = 0; i < 20; i++) draw(data, bodyColumns)
    means.push((performance.now() - start) / 20)
  }

  return Math.min(...means)
}

test('regression check: a redraw at the caps takes 2 ms or less, with a turn of 60 steps and of 5000', () => {
  const numbers: string[] = []
  for (const steps of [60, 5000]) {
    const caps = atCaps(steps)
    for (const [surface, bodyColumns] of [['desktop', 421], ['terminal', 200]] as const) {
      const ms = bestBatchMs(onSurface(caps, surface), bodyColumns)
      numbers.push(`${steps} steps ${surface}: ${ms.toFixed(3)} ms`)
      expect(ms, numbers.join('; ')).toBeLessThanOrEqual(2)
    }
  }
})
