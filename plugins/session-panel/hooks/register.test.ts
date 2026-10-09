import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Plugin } from 'claude-code/testing'
import type { On, PluginState, RenderPropsOf, RenderSurface, SessionMessage, UiPane } from 'claude-code'

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
const HANDBACK_TOOL: string = 'SubagentHandback' // the tool a subagent reports through in auto mode: not in the types
const START = { cwd: ROOT, surface: 'desktop', isInteractive: true } as const
const RUN = { args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const
// The engine refuses a compaction with no messages, in the input and in the result.
const MESSAGES: SessionMessage[] = [{ role: 'user', text: 'hi', toolUses: [] }]
const PANE_UP: UiPane = { id: 'session-panel', title: 'Session', isShown: true, isFocused: false, isPlaced: true }

// The git calls that read the project, as register.tsx makes them: the argv and the options, exactly. The delay is the
// one that register.tsx waits after a call of a tool that may change a file; the gap factor is how many times as long
// as the last read took a delayed read waits at least. A call that reads the tree starts with GIT_READ: no optional
// locks, no fsmonitor (a program or a daemon of the person's, which a read must not start) and no refresh of the index
// by a diff (it takes index.lock and writes .git/index). Its options carry GIT_NO_LAZY_FETCH, so that a partial clone
// does not fetch from its remote; the call of rev-parse reads no object, so it carries none. The diff against HEAD
// has a pair of its own after GIT_READ, which overrides the person's `diff.relative`: it would cut the counts to the
// folder of the session. The status and that diff keep a submodule's work tree from being walked
// (`--ignore-submodules=dirty`). A --no-index call has GIT_ATTR_SOURCE too: git's empty tree, so that no .gitattributes
// selects a filter that would run on the new file. The branch is read with no GIT_READ and no options: it runs no
// filters, so it is read before the tree is open (the first turn of the main agent opens it).
const PROJECT_DELAY_MS = 1000
const PROJECT_GAP_FACTOR = 4
const GIT_READ = [
  'git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'diff.autoRefreshIndex=false',
]
const NO_LAZY_FETCH = { GIT_NO_LAZY_FETCH: '1' }
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const NO_INDEX_ENV = { ...NO_LAZY_FETCH, GIT_ATTR_SOURCE: EMPTY_TREE }
const BRANCH_RUN = { argv: ['git', 'branch', '--show-current'], init: { cwd: ROOT, timeoutMs: 5000 } }
const STATUS_RUN = {
  argv: [...GIT_READ, 'status', '--porcelain', '-z', '-uall', '--ignore-submodules=dirty'],
  init: { cwd: ROOT, timeoutMs: 10_000, env: NO_LAZY_FETCH },
}
const DIFF_RUN = {
  argv: [
    ...GIT_READ, '-c', 'diff.relative=false', 'diff', '--numstat', '--no-textconv', '--no-ext-diff',
    '--ignore-submodules=dirty', 'HEAD', '--',
  ],
  init: { cwd: ROOT, timeoutMs: 10_000, env: NO_LAZY_FETCH },
}
const TOPLEVEL_RUN = { argv: ['git', 'rev-parse', '--show-toplevel'], init: { cwd: ROOT, timeoutMs: 10_000 } }
const noIndexRun = (path: string, cwd: string) => ({
  argv: [...GIT_READ, 'diff', '--no-index', '--numstat', '--no-textconv', '--no-ext-diff', '--', '/dev/null', path],
  init: { cwd, timeoutMs: 10_000, env: NO_INDEX_ENV },
})

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
    // The version of a value goes up by one with each write that lands: a test reads it to see whether a hook wrote.
    on('command.run', { command: 'read-agents-version' }, async $ => ({
      text: String((await $.state.get({ plugin: 'session-panel', key: 'agents' } as const)).version),
    }))
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
// A plugin above the mod's that refuses the first timer of 1000 ms or more, as a hook may: a `clock.after` that is
// refused never runs its fn. The timer of a delayed read is the only one that long (the others wait a millisecond).
// Like any plugin of a test it closes over nothing of this file, so the delay is spelled out.
const REFUSER: Plugin = {
  name: 'refuser',
  tier: 'prepend',
  register(on) {
    let isRefused = false
    on('clock.after', (_$, e, next) => {
      if (e.ms < 1000 || isRefused) return next(e)
      isRefused = true

      return { deny: 'refused' }
    })
  },
}
const WITH_READER = { plugins: [READER] }
const WITH_REFUSER = { plugins: [READER, REFUSER] }
// Streams and timers: every wait of the bottom hooks is a held sleep that the test advances by hand.
const SLOW_READER = { plugins: [READER], timeoutMs: 30_000 }
const TICKING_READER = { plugins: [READER, TICKER], timeoutMs: 30_000 }

// A plugin above the mod's that settles a call before the chain beneath it has ended, as a hook above may: for a Bash
// whose command says `abandon` it lets the chain run on, unawaited, and answers at once with an error of its own. The
// dispatch beneath is then abandoned, and `next.signal` aborts in the mod's hook, which goes on until the call ends.
// Like any plugin of a test it closes over nothing of this file.
const ABANDONER: Plugin = {
  name: 'abandoner',
  tier: 'prepend',
  register(on) {
    on('tool.call', (_$, e, next) => {
      if (e.tool !== 'Bash' || !e.command.includes('abandon')) return next(e)
      next(e).catch(() => undefined)

      return { isError: true as const, result: 'cut', text: 'cut' }
    })
  },
}
// A second plugin plays another session: it writes the map of folds into the store behind the pane's back (the map is
// the text of the command's arguments, in JSON), and reads the store back.
const OTHER_SESSION: Plugin = {
  name: 'other-session',
  register(on) {
    on('command.run', { command: 'write-store' }, async ($, e) => {
      await $.store.set('collapsed', JSON.parse(e.args))

      return { text: 'written' }
    })
    on('command.run', { command: 'read-store' }, async $ => ({ text: JSON.stringify(await $.store.get('collapsed')) }))
  },
}
const WITH_ABANDONER = { plugins: [READER, ABANDONER], timeoutMs: 30_000 }
const WITH_STORE = { plugins: [READER, OTHER_SESSION], timeoutMs: 30_000 }
const PANE_PROPS: RenderPropsOf['Pane'] = {
  title: 'Session', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {},
}

const readState = async ($: Engine): Promise<State> => {
  const ran = await $.command.run({ ...RUN, command: 'read-state' })

  return JSON.parse(ran.text ?? '{}') as State
}

const agentsVersion = async ($: Engine): Promise<number> =>
  Number((await $.command.run({ ...RUN, command: 'read-agents-version' })).text)

// The map of folds in the store as the second plugin reads it back, a write of it as another session would make it, and
// the pane mounted on the desktop, where a press of a header can be made.
const readStore = async ($: Engine): Promise<unknown> =>
  JSON.parse((await $.command.run({ ...RUN, command: 'read-store' })).text ?? 'null')
const writeStore = ($: Engine, value: unknown) =>
  $.command.run({ ...RUN, command: 'write-store', args: JSON.stringify(value) })
const mountPane = ($: Engine) => $.ui.mount({
  plugin: 'session-panel', surface: 'desktop', component: 'Pane', requestId: 'session-panel', props: PANE_PROPS,
})

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

// What one git call answers; a missing `isStdoutTruncated` is false.
type GitAnswer = { exitCode: number; stdout: string; isStdoutTruncated?: boolean }
const ok = (stdout: string): GitAnswer => ({ exitCode: 0, stdout })

type World = {
  usd: number // the engine's cost ledger, in dollars
  stepCost: number // what the next model request adds to the ledger when it stops
  surfaces: RenderSurface[]
  panes: UiPane[]
  placed: { isPlaced: true } | { isPlaced: false; reason: string }
  branch: string // what `git branch --show-current` prints
  gitExit: number // when it is not 0, the exit of every git call
  gitThrows: boolean // git cannot be started
  statusThrows: boolean // `git status` alone cannot be run to its end (it times out): its call rejects
  status: GitAnswer // `git status --porcelain -z -uall`; a clean tree prints nothing
  diff: GitAnswer // `git diff --numstat HEAD`
  toplevel: GitAnswer // `git rev-parse --show-toplevel`
  noIndex: (path: string) => GitAnswer // `git diff --no-index` of a new file: exit 1, as git does when the files differ
  gitLag: number // how long each git call takes, in mock ms
  gitInFlight: number
  maxGitInFlight: number
  rootLag: number // how long session.root() takes, in mock ms
  rootFailures: number // how many of the next session.root() calls reject
  root: string // what session.root() answers
  isReadOnly: boolean // core ran the next calls of tools read-only: their results say so
  listed: { id: string; status: string }[] // what $.agent.list() answers
  compacted: Record<string, unknown>
  spawns: number
  breakdowns: number // how many usage() calls asked for the context breakdown
  usageLag: number // how long usage() takes, in mock ms
  usageFails: boolean // usage() rejects
  isStoreUnreadable: boolean // a read of the store rejects (only where `bottom` was given a store that can break)
  storeLag: number // how long each call of that store takes, in mock ms
  toolFailMs: number // how long a failing tool call takes, in mock ms
  tokens: number | undefined // context.tokens of usage(): none before the first response of the window
  rawMaxTokens: number | undefined // the window the breakdown measures against; undefined: no breakdown in usage()
  mcpServers: string[] // the server of each MCP tool the breakdown holds, so a server with two tools is listed twice
  usageInFlight: number
  maxUsageInFlight: number
  registered: unknown[]
  opened: unknown[]
  closed: string[]
  invalidated: string[]
  runs: { argv: readonly string[]; init: unknown }[]
}

// The command of a git call: the first word that is no option and no value of `-c`.
const gitCommand = (argv: readonly string[]): string | undefined =>
  argv.slice(1).find((arg, i, all) => !arg.startsWith('-') && all[i - 1] !== '-c')

// What git answers to a call, by the command it is: the short commit is the answer to any rev-parse but the top.
const gitAnswer = (w: World, argv: readonly string[]): GitAnswer => {
  const command = gitCommand(argv)
  if (command === 'branch') return ok(w.branch)
  if (command === 'status') return w.status
  if (command === 'diff') return argv.includes('--no-index') ? w.noIndex(argv.at(-1) ?? '') : w.diff

  return argv.includes('--show-toplevel') ? w.toplevel : ok('abc1234\n')
}

// The bottom of every chain: what the engine itself would answer, and what it was asked. With `isStoreBreakable` the
// store is one in memory that answers reads and writes, rejects every read while `isStoreUnreadable` is set, and takes
// `storeLag` mock ms over each call: a store that fails and lags as the engine's may, which `mock.store` never does.
const bottom = (on: On, clock: MockClock, store?: Record<string, unknown>, isStoreBreakable = false): World => {
  const w: World = {
    usd: 10,
    stepCost: 0,
    surfaces: ['desktop'],
    panes: [],
    placed: { isPlaced: true },
    branch: 'master\n',
    gitExit: 0,
    gitThrows: false,
    statusThrows: false,
    status: ok(''),
    diff: ok(''),
    toplevel: ok('/repo\n'),
    noIndex: path => ({ exitCode: 1, stdout: `1\t0\t/dev/null => ${path}\n` }),
    gitLag: 0,
    gitInFlight: 0,
    maxGitInFlight: 0,
    rootLag: 0,
    rootFailures: 0,
    root: ROOT,
    isReadOnly: false,
    listed: [],
    compacted: { messages: MESSAGES, tokensBefore: 180_000, tokensAfter: 40_000 },
    spawns: 0,
    breakdowns: 0,
    usageLag: 0,
    usageFails: false,
    isStoreUnreadable: false,
    storeLag: 0,
    toolFailMs: 0,
    tokens: undefined,
    rawMaxTokens: 1_000_000,
    mcpServers: ['codebase-memory', 'codebase-memory', 'issue-hub', 'ccd_session'],
    usageInFlight: 0,
    maxUsageInFlight: 0,
    registered: [],
    opened: [],
    closed: [],
    invalidated: [],
    runs: [],
  }
  if (isStoreBreakable) {
    const kept: Record<string, unknown> = { ...store }
    on('store.get', async (_$, e) => {
      if (w.storeLag > 0) await clock.sleep(w.storeLag)
      if (w.isStoreUnreadable) throw new Error('the store cannot be read')

      return { value: kept[e.key] }
    })
    on('store.set', async (_$, e) => {
      if (w.storeLag > 0) await clock.sleep(w.storeLag)
      kept[e.key] = JSON.parse(JSON.stringify(e.value))

      return { value: undefined }
    })
  } else {
    mock.store(on, store)
  }
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
    // What a call says decides how it ends: the command of a Bash, the new text of an Edit, the description of an
    // Agent, the message of a SendMessage or of a SubagentHandback. One that starts with `deny` is denied, one that
    // starts with `fail` fails.
    let says = ''
    if (e.tool === 'Bash') says = e.command
    if (e.tool === 'Edit') says = e.new_string
    if (e.tool === 'Agent') says = e.description
    if (e.tool === 'SendMessage') says = e.message
    if (e.tool === HANDBACK_TOOL) says = String('message' in e ? e.message : '')
    if (says.startsWith('deny')) return { deny: 'no' }
    const readOnly = w.isReadOnly ? { isReadOnly: true as const } : {}
    if (says.startsWith('fail')) {
      if (w.toolFailMs > 0) await clock.sleep(w.toolFailMs)

      return { isError: true as const, result: 'boom', text: 'boom', ...readOnly }
    }
    await clock.sleep(300)

    return { result: { stdout: 'ok' } as never, text: 'ok', ...readOnly }
  })
  // Calls on `$`; the test host serves `state` itself and mock.clock serves `clock`.
  on('command.register', (_$, e) => {
    w.registered.push(e)

    return { value: { command: e.name } }
  })
  on('session.surfaces', () => ({ value: w.surfaces }))
  on('session.root', async () => {
    if (w.rootLag > 0) await clock.sleep(w.rootLag)
    if (w.rootFailures > 0) {
      w.rootFailures -= 1
      throw new Error('the root is not available')
    }

    return { value: w.root }
  })
  on('session.usage', async (_$, e) => {
    w.usageInFlight += 1
    w.maxUsageInFlight = Math.max(w.maxUsageInFlight, w.usageInFlight)
    if (w.usageLag > 0) await clock.sleep(w.usageLag)
    w.usageInFlight -= 1
    if (w.usageFails) throw new Error('usage is not available')
    if (e.breakdown !== undefined) w.breakdowns += 1
    const tool = (serverName: string) => ({ name: `mcp__${serverName}__t`, serverName, tokens: 1, isLoaded: true })
    const breakdown = {
      rawMaxTokens: w.rawMaxTokens,
      skills: { totalSkills: 52, includedSkills: 52, tokens: 1, skillFrontmatter: [] },
      mcpTools: w.mcpServers.map(tool),
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
  on('process.run', async (_$, e) => {
    w.runs.push({ argv: e.argv, init: e.init })
    w.gitInFlight += 1
    w.maxGitInFlight = Math.max(w.maxGitInFlight, w.gitInFlight)
    if (w.gitLag > 0) await clock.sleep(w.gitLag)
    w.gitInFlight -= 1
    if (w.gitThrows || (w.statusThrows && gitCommand(e.argv) === 'status')) throw new Error('spawn git ENOENT')
    const answer = gitAnswer(w, e.argv)

    return {
      value: {
        exitCode: w.gitExit === 0 ? answer.exitCode : w.gitExit,
        stdout: answer.stdout,
        stderr: '',
        isStdoutTruncated: answer.isStdoutTruncated ?? false,
        isStderrTruncated: false,
      },
    }
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

// How many reads of the project git has served: each one starts with the call that names the branch.
const reads = (w: World): number => w.runs.filter(run => run.argv.includes('--show-current')).length

// A turn of the main agent starts. The first one opens the tree to the reads (the status, the diff and the lines of the
// new files) and asks for a read of the project. It has no text, so it is no line of the log.
const startTurn = ($: Engine, turnId = 't0') => $.turn.start({ text: '', turnId })

// The session has started and its read, the branch alone while the tree is shut, is over: the first turn starts, and
// the read that it asks for runs. `w.runs` is emptied first, so that it holds the calls of this read only.
const openTree = async ($: Engine, clock: MockClock, w: World): Promise<void> => {
  w.runs.length = 0
  await startTurn($)
  await clock.advance(1)
}

// The calls of tools that may change a file; the bottom ends each in 300 mock ms. An Edit whose new text starts with
// `deny` is denied.
const edit = (newString = 'b') =>
  ({ tool: 'Edit', file_path: `${ROOT}/a.ts`, old_string: 'a', new_string: newString }) as const
const write = () => ({ tool: 'Write', file_path: `${ROOT}/b.ts`, content: 'x' }) as const
const readCall = () => ({ tool: 'Read', file_path: `${ROOT}/a.ts` }) as const

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
// A subagent's report through the hand-back tool, in the shape seen in the engine's transcripts: `{ message }`.
const handBack = (input: Record<string, unknown>, agentId = 'a1') =>
  ({ tool: HANDBACK_TOOL, agentId, ...input }) as never

test('session.start registers the command and opens the pane when a desktop is attached', async ($, on) => {
  const w = bottom(on, mock.clock(on, { now: 1_000_000 }))

  expect(await $.session.start(START)).toEqual({ cwd: ROOT })
  // The command only touches panes, so it may run while a turn is in flight.
  expect(w.registered).toEqual([
    { name: 'session-panel', description: 'Open or close the session stats pane', immediate: true },
  ])
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
    expect(state.project).toEqual({ name: 'online_shop', branch: 'master', changes: null })
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

test('a stored map of booleans is applied, the false ones too', WITH_READER, async ($, on) => {
  bottom(on, mock.clock(on), { collapsed: { log: true, turn: false } })

  await $.session.start(START)

  expect((await readState($)).collapsed).toEqual({ log: true, turn: false })
})

// What the store may hold under `collapsed` after an edit by hand: nothing the pane can fold by.
const NOT_A_FOLDED_MAP: Array<[what: string, stored: unknown]> = [
  ['a string', 'x'], ['a number', 42], ['null', null], ['an array', [true]],
  ['a map with a string in it', { turn: 'yes' }],
  ['a map with a string among its booleans', { log: true, turn: 'yes' }],
]
for (const [what, stored] of NOT_A_FOLDED_MAP) {
  test(`a stored folded map that is ${what} is ignored: no section is folded and the start-up goes on`, WITH_READER,
    async ($, on) => {
      const w = bottom(on, mock.clock(on), { collapsed: stored })

      await $.session.start(START)

      expect((await readState($)).collapsed).toBeUndefined() // nothing was written
      expect(w.opened).toEqual([{ id: 'session-panel', title: 'Session' }])
    })
}

// A press of a header folds a section and keeps the map in the store. The store holds what the last press of any
// session left, so a press builds on it: what another session folded stays, and this section is set to the opposite of
// what this pane shows now. The sections the pane draws here are `turn`, `mcp` and `sources`.
test('a press keeps the folds that another session left in the store, and flips this section alone', WITH_STORE,
  async ($, on) => {
    const clock = mock.clock(on)
    bottom(on, clock, { collapsed: { mcp: true } })
    await $.session.start(START)
    await clock.advance(1)
    const ui = await mountPane($)
    expect((await readState($)).collapsed).toEqual({ mcp: true }) // what the pane loaded at the start

    // Another session folds two more sections; this pane has not read that.
    await writeStore($, { mcp: true, log: true, sources: true })
    await ui.press({ key: 'toggle:turn' }) // the pane shows Turn stats open: it folds
    const merged = { mcp: true, log: true, sources: true, turn: true }
    expect(await readStore($)).toEqual(merged)
    expect((await readState($)).collapsed).toEqual(merged) // the pane shows it now too

    // A second press unfolds it, and the others stay.
    await ui.press({ key: 'toggle:turn' })
    expect(await readStore($)).toEqual({ ...merged, turn: false })
    expect((await readState($)).collapsed).toEqual({ ...merged, turn: false })
    await ui.unmount()
  })

test('the section that a press flips is the one the pane shows, whatever the store says of it', WITH_STORE,
  async ($, on) => {
    const clock = mock.clock(on)
    bottom(on, clock, { collapsed: { mcp: true } })
    await $.session.start(START)
    await clock.advance(1)
    const ui = await mountPane($)

    // The store says the MCP list is open (another session unfolded it), the pane shows it folded: a press unfolds
    // what the person sees folded, and the store then says it is open.
    await writeStore($, { mcp: false, log: true })
    await ui.press({ key: 'toggle:mcp' })
    expect(await readStore($)).toEqual({ mcp: false, log: true })
    expect((await readState($)).collapsed).toEqual({ mcp: false, log: true })
    await ui.unmount()
  })

test('a press before the map was loaded from the store at the start does not start from an empty map', WITH_STORE,
  async ($, on) => {
    const clock = mock.clock(on)
    bottom(on, clock, { collapsed: { mcp: true, sources: true } })
    // No session.start: the pane was opened by an attach, and the start-up load has not run (or this session did not
    // see it). The pane shows nothing folded.
    const ui = await mountPane($)
    expect((await readState($)).collapsed).toBeUndefined()

    await ui.press({ key: 'toggle:turn' })
    expect(await readStore($)).toEqual({ mcp: true, sources: true, turn: true })
    expect((await readState($)).collapsed).toEqual({ mcp: true, sources: true, turn: true })
    await ui.unmount()
  })

// A store that has no map to give: it holds none, or what it holds is no map of booleans. The press takes the pane's
// own map, as it did before the store was read at all.
for (const [what, stored] of [['no map', undefined], ...NOT_A_FOLDED_MAP] as Array<[string, unknown]>) {
  test(`a press when the store holds ${what} builds on the map of the pane`, WITH_STORE, async ($, on) => {
    const clock = mock.clock(on)
    bottom(on, clock, { collapsed: { mcp: true } })
    await $.session.start(START)
    await clock.advance(1)
    const ui = await mountPane($)
    if (stored !== undefined) await writeStore($, stored)

    await ui.press({ key: 'toggle:turn' })
    expect(await readStore($)).toEqual({ mcp: true, turn: true })
    expect((await readState($)).collapsed).toEqual({ mcp: true, turn: true })
    await ui.unmount()
  })
}

test('a press when the store cannot be read builds on the map of the pane, and is a press all the same', WITH_STORE,
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock, { collapsed: { mcp: true } }, true)
    await $.session.start(START)
    await clock.advance(1)
    const ui = await mountPane($)
    await writeStore($, { mcp: true, log: true }) // what the store holds, if it could be read
    w.isStoreUnreadable = true

    await ui.press({ key: 'toggle:turn' })
    expect((await readState($)).collapsed).toEqual({ mcp: true, turn: true }) // the pane's map, not the store's
    w.isStoreUnreadable = false
    expect(await readStore($)).toEqual({ mcp: true, turn: true }) // and the write went through
    await ui.unmount()
  })

// The store takes time over each call, 50 ms here, and a press builds on the map that it reads there: two presses made
// inside one round-trip, or a press and the load of the start-up, must not undo each other, in the pane or the store.
test('a second press, made while the first one waits on the store, keeps the fold of the first', WITH_STORE,
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock, { collapsed: { log: true } }, true)
    await $.session.start(START)
    await clock.advance(1)
    const ui = await mountPane($)
    w.storeLag = 50

    const first = ui.press({ key: 'toggle:turn' })
    await clock.advance(20) // the first press is still reading the store
    const second = ui.press({ key: 'toggle:mcp' })
    await clock.advance(1000) // far past the four calls of the store that the two presses make
    await Promise.all([first, second])
    w.storeLag = 0

    const folded = { log: true, turn: true, mcp: true }
    expect((await readState($)).collapsed).toEqual(folded)
    expect(await readStore($)).toEqual(folded)
    await ui.unmount()
  })

test('a press made while the map of the store is loaded at the start-up survives the load', WITH_STORE,
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock, { collapsed: { mcp: true, turn: false } }, true)
    const ui = await mountPane($) // no session.start yet: the pane is open and shows nothing folded
    w.storeLag = 50

    const press = ui.press({ key: 'toggle:turn' }) // it folds Turn, which the store has left open
    await clock.advance(10) // the press is still reading the store
    const start = $.session.start(START) // the load reads the store now, and gets the map as it was before the press
    await clock.advance(1000) // far past the calls of the store
    await Promise.all([press, start])
    w.storeLag = 0

    expect((await readState($)).collapsed).toEqual({ mcp: true, turn: true })
    expect(await readStore($)).toEqual({ mcp: true, turn: true })
    await ui.unmount()
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
  expect(state.project).toEqual({ name: 'online_shop', branch: 'master', changes: null })
  // The app's own server (ccd_session) is not listed.
  expect(state.mcp).toEqual({ servers: [{ name: 'codebase-memory' }, { name: 'issue-hub' }] })
  expect(state.usage.skills).toBe(52)
  expect(w.breakdowns).toBe(1)
  // The branch alone: the tree waits for the first turn of the main agent.
  expect(w.runs).toEqual([BRANCH_RUN])
})

// Everything that asks for a read of the project: the call of a tool that may change a file, a change of the folder,
// the end of a main turn and the timer of the session, which asks every second tick. While the tree is shut each one
// reads the branch and nothing else.
test('before the first turn of the main agent the tree is not read: no status, no diff, no new file counted',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.status = ok(' M a.ts\0?? n.ts\0')
    w.diff = ok('3\t1\ta.ts\n')

    await $.session.start(START)
    await clock.advance(1)
    await drive(clock, $.tool.call(edit()))
    await $.classic.CwdChanged({ old_cwd: ROOT, new_cwd: ROOT })
    await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't0', reason: 'answer' })
    await clock.advance(5 * 60_000)

    // Several reads were asked for, so this is no empty check; none of them ran git on the tree.
    expect(reads(w)).toBeGreaterThanOrEqual(4)
    expect(w.runs.map(run => gitCommand(run.argv))).not.toContain('status')
    expect(w.runs.map(run => gitCommand(run.argv))).not.toContain('diff')
    expect(w.runs.every(run => run.argv.includes('--show-current'))).toBe(true)
    expect((await readState($)).project).toEqual({ name: 'online_shop', branch: 'master', changes: null })
  })

test('the first turn of the main agent opens the tree and asks for a read: the status and the diff run right after it',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.status = ok(' M a.ts\0')
    w.diff = ok('3\t1\ta.ts\n')
    await $.session.start(START)
    await clock.advance(1)
    expect((await readState($)).project.changes).toBeNull()
    w.runs.length = 0

    expect(await $.turn.start({ text: 'fix it', turnId: 't1' })).toEqual({ turnId: 't1' })
    // The hook asks for the read and returns, so git has not run yet.
    expect(w.runs).toEqual([])
    await clock.advance(1)
    expect(w.runs).toEqual([BRANCH_RUN, STATUS_RUN, DIFF_RUN])
    expect((await readState($)).project.changes).toEqual({ files: 1, lines: { added: 3, removed: 1 } })

    // Open for good: the next read has the tree too.
    w.runs.length = 0
    await $.classic.CwdChanged({ old_cwd: ROOT, new_cwd: ROOT })
    await clock.advance(1)
    expect(w.runs).toEqual([BRANCH_RUN, STATUS_RUN, DIFF_RUN])
  })

test('a turn that carries an agent id is no turn of the main agent: it does not open the tree, and asks for no read',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.status = ok(' M a.ts\0')
    w.diff = ok('3\t1\ta.ts\n')
    await $.session.start(START)
    await clock.advance(1)
    w.runs.length = 0

    // The engine's types give turn.start no agentId (a subagent's run raises none), so the input is cast.
    await $.turn.start({ text: 'sub', turnId: 't1', agentId: 'a1' } as never)
    await clock.advance(1)
    expect(w.runs).toEqual([])

    // A read that comes later is the branch alone still.
    await $.classic.CwdChanged({ old_cwd: ROOT, new_cwd: ROOT })
    await clock.advance(1)
    expect(w.runs).toEqual([BRANCH_RUN])
    expect((await readState($)).project.changes).toBeNull()

    // The first turn of the main agent opens it.
    w.runs.length = 0
    await $.turn.start({ text: 'go', turnId: 't2' })
    await clock.advance(1)
    expect(w.runs).toEqual([BRANCH_RUN, STATUS_RUN, DIFF_RUN])
    expect((await readState($)).project.changes).toEqual({ files: 1, lines: { added: 3, removed: 1 } })
  })

test('only the first turn of the main agent asks for a read: the start of a second one asks for none', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    await openTree($, clock, w)
    expect(reads(w)).toBe(1) // the read that the first turn asked for

    await startTurn($, 't1')
    await clock.advance(1)
    expect(reads(w)).toBe(1)
  })

// The names of the MCP servers the panel lists after start-up, for a breakdown that holds a tool of each of `servers`.
const listedAfterStart = async ($: Engine, on: On, servers: string[]): Promise<string[]> => {
  const clock = mock.clock(on)
  bottom(on, clock).mcpServers = servers
  await $.session.start(START)
  await clock.advance(1)

  return (await readState($)).mcp?.servers.map(server => server.name) ?? []
}

test('the desktop app\'s own MCP servers are neither listed nor counted', WITH_READER, async ($, on) => {
  // `ccd_x` by its prefix, the next three by their whole names, and two servers that are the person's. The MCP header
  // and Context sources show the length of this list, so both say 2.
  const servers = ['ccd_x', 'Claude_Browser', 'codebase-memory', 'scheduled-tasks', 'terminal', 'issue-hub']

  expect(await listedAfterStart($, on, servers)).toEqual(['codebase-memory', 'issue-hub'])
})

test('a server whose name only contains the name of a hidden one is the person\'s, and is listed', WITH_READER,
  async ($, on) => {
    // `terminal-tools` has `terminal` in it, `my-ccd_x` has `ccd_` in it and `ccd` is short of its underscore: the
    // prefix and the names are matched whole.
    const servers = ['terminal-tools', 'Claude_Browser2', 'my-ccd_x', 'scheduled-tasks-2', 'ccd']

    expect(await listedAfterStart($, on, servers)).toEqual(servers)
  })

test('a detached HEAD shows the short commit; a git that fails or cannot start leaves no branch; cwd refreshes it',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.branch = ''

    await $.session.start(START)
    await clock.advance(1)
    expect((await readState($)).project.branch).toBe('abc1234')
    // The branch alone: the tree is shut until the first turn of the main agent.
    expect(w.runs.map(run => run.argv)).toEqual([
      ['git', 'branch', '--show-current'],
      ['git', 'rev-parse', '--short', 'HEAD'],
    ])
    expect(w.runs[1]?.init).toEqual({ cwd: ROOT, timeoutMs: 5000 })

    w.gitExit = 128
    expect(await $.classic.CwdChanged({ old_cwd: ROOT, new_cwd: ROOT })).toEqual({})
    await clock.advance(1)
    expect((await readState($)).project).toEqual({ name: 'online_shop', branch: null, changes: null })

    w.gitExit = 0
    w.branch = 'dev\n'
    await $.classic.CwdChanged({ old_cwd: ROOT, new_cwd: ROOT })
    await clock.advance(1)
    expect((await readState($)).project).toEqual({ name: 'online_shop', branch: 'dev', changes: null })

    // git cannot be started at all: the call rejects, the name stays and the branch and the changes go.
    w.status = ok(' M a.ts\0')
    w.gitThrows = true
    await $.classic.CwdChanged({ old_cwd: ROOT, new_cwd: ROOT })
    await clock.advance(1)
    expect((await readState($)).project).toEqual({ name: 'online_shop', branch: null, changes: null })
  })

test('the project has the changes: a modified file and a new file, counted by their lines', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.status = ok(' M a.ts\0?? n.ts\0')
    w.diff = ok('3\t1\ta.ts\n')
    w.noIndex = () => ({ exitCode: 1, stdout: '5\t0\t/dev/null => n.ts\n' })

    await $.session.start(START)
    await clock.advance(1)
    await openTree($, clock, w)

    expect((await readState($)).project).toEqual({
      name: 'online_shop', branch: 'master', changes: { files: 2, lines: { added: 8, removed: 1 } },
    })
    // The new file is diffed from the top of the repository, which is not the session root.
    expect(w.runs).toEqual([BRANCH_RUN, STATUS_RUN, DIFF_RUN, TOPLEVEL_RUN, noIndexRun('n.ts', '/repo')])
  })

// The argv and the environment of every call, spelled out: a mistake in the shared constants above is caught here.
test('the status and the diff against HEAD ignore dirty submodules; each --no-index call has the empty tree as the '
  + 'source of attributes', WITH_READER, async ($, on) => {
  const clock = mock.clock(on)
  const w = bottom(on, clock)
  w.status = ok(' M a.ts\0?? n.ts\0?? m.ts\0')
  w.diff = ok('3\t1\ta.ts\n')
  await $.session.start(START)
  await clock.advance(1)
  await openTree($, clock, w)

  const prefix = ['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'diff.autoRefreshIndex=false']
  expect(w.runs.map(run => run.argv)).toEqual([
    ['git', 'branch', '--show-current'],
    [...prefix, 'status', '--porcelain', '-z', '-uall', '--ignore-submodules=dirty'],
    [
      ...prefix, '-c', 'diff.relative=false', 'diff', '--numstat', '--no-textconv', '--no-ext-diff',
      '--ignore-submodules=dirty', 'HEAD', '--',
    ],
    ['git', 'rev-parse', '--show-toplevel'],
    [...prefix, 'diff', '--no-index', '--numstat', '--no-textconv', '--no-ext-diff', '--', '/dev/null', 'n.ts'],
    [...prefix, 'diff', '--no-index', '--numstat', '--no-textconv', '--no-ext-diff', '--', '/dev/null', 'm.ts'],
  ])
  const tree = { GIT_NO_LAZY_FETCH: '1' }
  const noIndex = { ...tree, GIT_ATTR_SOURCE: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' }
  expect(w.runs.map(run => run.init)).toEqual([
    { cwd: ROOT, timeoutMs: 5000 },
    { cwd: ROOT, timeoutMs: 10_000, env: tree },
    { cwd: ROOT, timeoutMs: 10_000, env: tree },
    { cwd: ROOT, timeoutMs: 10_000 },
    { cwd: '/repo', timeoutMs: 10_000, env: noIndex },
    { cwd: '/repo', timeoutMs: 10_000, env: noIndex },
  ])
})

test('a clean tree has no changes, and no diff is run', WITH_READER, async ($, on) => {
  const clock = mock.clock(on)
  const w = bottom(on, clock)

  await $.session.start(START)
  await clock.advance(1)
  await openTree($, clock, w)

  expect((await readState($)).project.changes).toBeNull()
  expect(w.runs).toEqual([BRANCH_RUN, STATUS_RUN])
})

test('outside a git repository, where every git call exits 128, there is no branch and no changes', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.gitExit = 128
    w.status = ok(' M a.ts\0') // what a status that failed printed is no list

    await $.session.start(START)
    await clock.advance(1)
    await openTree($, clock, w)

    expect((await readState($)).project).toEqual({ name: 'online_shop', branch: null, changes: null })
    expect(w.runs).toEqual([BRANCH_RUN, STATUS_RUN])
  })

// What a status that git cut short gives: the files in its whole entries, as a lower bound (`hasMoreFiles`), and no
// lines, so no diff runs and no new file is counted. What follows the last NUL is the beginning of an entry, which is
// no entry.
const CUT_STATUSES: Array<[what: string, stdout: string, files: number]> = [
  ['an entry cut in its path', ' M a.ts\0?? n.ts\0 M b', 2],
  ['an entry cut in its status letters', ' M a.ts\0?? n.ts\0 ', 2],
  ['a cut that falls on a NUL', ' M a.ts\0?? n.ts\0', 2],
  ['a rename cut in the path it came from', 'R  new.ts\0old.ts\0 M c.ts\0R  new2.ts\0ol', 3],
  ['one whole entry and the beginning of the next', ' M a.ts\0 M b.t', 1],
]
for (const [what, stdout, files] of CUT_STATUSES) {
  test(`a status cut at ${what} gives ${files} file${files === 1 ? '' : 's'} as a lower bound and no lines`,
    WITH_READER, async ($, on) => {
      const clock = mock.clock(on)
      const w = bottom(on, clock)
      w.status = { exitCode: 0, stdout, isStdoutTruncated: true }

      await $.session.start(START)
      await clock.advance(1)
      await openTree($, clock, w)

      expect((await readState($)).project).toEqual({
        name: 'online_shop', branch: 'master', changes: { files, hasMoreFiles: true, lines: null },
      })
      expect(w.runs).toEqual([BRANCH_RUN, STATUS_RUN]) // no diff, no top of the repository, no new file
    })
}

// A count of 0 is nothing to show: a status that was cut before its first whole entry, as one with no entry.
for (const stdout of ['', ' M a.t', '??']) {
  test(`a status cut to ${JSON.stringify(stdout)} has no whole entry: no changes`, WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.status = { exitCode: 0, stdout, isStdoutTruncated: true }

    await $.session.start(START)
    await clock.advance(1)
    await openTree($, clock, w)

    expect((await readState($)).project).toEqual({ name: 'online_shop', branch: 'master', changes: null })
    expect(w.runs).toEqual([BRANCH_RUN, STATUS_RUN])
  })
}

test('a status that is whole and has files carries no mark of a lower bound: its exact counts have neither key',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.status = ok(' M a.ts\0?? n.ts\0')
    w.diff = ok('3\t1\ta.ts\n')

    await $.session.start(START)
    await clock.advance(1)
    await openTree($, clock, w)

    const { changes } = (await readState($)).project
    expect(changes).toEqual({ files: 2, lines: { added: 4, removed: 1 } })
    expect(Object.keys(changes ?? {})).toEqual(['files', 'lines'])
    expect(Object.keys(changes?.lines ?? {})).toEqual(['added', 'removed'])
  })

// Reads where the files are counted and the lines are not: what git answers, and the calls made before the lines are
// given up. The status lists a modified file and a new one.
const LINES_UNKNOWN: Array<[what: string, answers: Partial<World>, runs: unknown[]]> = [
  [
    'an unborn HEAD, which has no HEAD to diff against',
    { diff: { exitCode: 128, stdout: '' } },
    [BRANCH_RUN, STATUS_RUN, DIFF_RUN],
  ],
  [
    'a diff that is cut short',
    { diff: { exitCode: 0, stdout: '3\t1\ta.ts\n', isStdoutTruncated: true } },
    [BRANCH_RUN, STATUS_RUN, DIFF_RUN],
  ],
  [
    'a top of the repository that cannot be had',
    { toplevel: { exitCode: 128, stdout: '' } },
    [BRANCH_RUN, STATUS_RUN, DIFF_RUN, TOPLEVEL_RUN],
  ],
]
for (const [what, answers, runs] of LINES_UNKNOWN) {
  test(`${what} leaves the files counted and the lines unknown, and no more git runs`, WITH_READER,
    async ($, on) => {
      const clock = mock.clock(on)
      const w = Object.assign(bottom(on, clock), { status: ok(' M a.ts\0?? n.ts\0') }, answers)

      await $.session.start(START)
      await clock.advance(1)
      await openTree($, clock, w)

      expect((await readState($)).project.changes).toEqual({ files: 2, lines: null })
      expect(w.runs).toEqual(runs)
    })
}

// The paths that the --no-index calls were made for, in the order of the calls.
const countedPaths = (w: World): unknown[] =>
  w.runs.filter(run => run.argv.includes('--no-index')).map(run => run.argv.at(-1))

test('only the first 50 new files are counted, one git call each, in order; past them the plus is a lower bound',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.status = ok(Array.from({ length: 51 }, (_, i) => `?? n${i}.ts\0`).join(''))
    w.gitLag = 10 // so that calls made together would overlap

    await $.session.start(START)
    await clock.advance(1000)
    await openTree($, clock, w)
    await clock.advance(1000)

    expect(countedPaths(w)).toEqual(Array.from({ length: 50 }, (_, i) => `n${i}.ts`))
    // The 51st is a changed file all the same; each of the 50 has one line, so the plus is a lower bound.
    expect((await readState($)).project.changes).toEqual({
      files: 51, lines: { added: 50, removed: 0, hasMoreAdded: true },
    })
    expect(w.maxGitInFlight).toBe(1) // one after another
  })

test('exactly 50 new files are all counted, and the plus is exact', WITH_READER, async ($, on) => {
  const clock = mock.clock(on)
  const w = bottom(on, clock)
  w.status = ok(Array.from({ length: 50 }, (_, i) => `?? n${i}.ts\0`).join(''))

  await $.session.start(START)
  await clock.advance(1)
  await openTree($, clock, w)

  expect(countedPaths(w)).toHaveLength(50)
  const { changes } = (await readState($)).project
  expect(changes).toEqual({ files: 50, lines: { added: 50, removed: 0 } })
  expect('hasMoreAdded' in (changes?.lines ?? {})).toBe(false)
})

// The new files that git could not count whole: the call rejects (a timeout, or git that cannot be started), exits
// with something but 0 or 1, or has its stdout cut.
const FAILED_COUNTS: Array<[what: string, answer: (path: string) => GitAnswer]> = [
  ['rejects', () => {
    throw new Error('spawn git ENOENT')
  }],
  ['exits 128', () => ({ exitCode: 128, stdout: '9\t0\t/dev/null => c.ts\n' })], // what it printed is no count
  ['has its stdout cut', () => ({ exitCode: 1, stdout: '9\t0\t/dev/null => c.ts\n', isStdoutTruncated: true })],
]
for (const [what, answer] of FAILED_COUNTS) {
  test(`the loop over the new files stops at the first call that ${what}: the lines so far stand as a lower bound`,
    WITH_READER, async ($, on) => {
      const clock = mock.clock(on)
      const w = bottom(on, clock)
      w.status = ok(['a', 'b', 'c', 'd', 'e'].map(name => `?? ${name}.ts\0`).join(''))
      // a and b have 5 lines each; c fails; d and e would have 5 each, and are never tried.
      w.noIndex = path => (path === 'c.ts' ? answer(path) : { exitCode: 1, stdout: `5\t0\t/dev/null => ${path}\n` })

      await $.session.start(START)
      await clock.advance(1)
      await openTree($, clock, w)

      expect(countedPaths(w)).toEqual(['a.ts', 'b.ts', 'c.ts'])
      expect((await readState($)).project.changes).toEqual({
        files: 5, lines: { added: 10, removed: 0, hasMoreAdded: true },
      })
    })
}

test('a new file that is empty, gone or counted by an exit of 0 is no failure: every one is tried, the plus is exact',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.status = ok(['a', 'c', 'e', 'g', 'h'].map(name => `?? ${name}.ts\0`).join(''))
    const answers: Record<string, GitAnswer> = {
      'a.ts': { exitCode: 1, stdout: '5\t0\t/dev/null => a.ts\n' }, // the normal answer: exit 1, the files differ
      'c.ts': { exitCode: 1, stdout: '0\t0\t/dev/null => c.ts\n' }, // an empty file, as git answers it: no lines
      'e.ts': ok('2\t0\t/dev/null => e.ts\n'), // exit 0 counts as well
      'g.ts': { exitCode: 1, stdout: '' }, // a file that is gone: git says so on stderr, exits 1 and prints nothing
      'h.ts': { exitCode: 1, stdout: '-\t-\t/dev/null => h.ts\n' }, // a binary file: no lines
    }
    w.noIndex = path => answers[path] ?? ok('')

    await $.session.start(START)
    await clock.advance(1)
    await openTree($, clock, w)

    const { changes } = (await readState($)).project
    expect(changes).toEqual({ files: 5, lines: { added: 7, removed: 0 } })
    expect('hasMoreAdded' in (changes?.lines ?? {})).toBe(false)
    expect(countedPaths(w)).toHaveLength(5) // each one was tried
  })

test('a nested repository is a changed file with no lines: no git call counts it', WITH_READER, async ($, on) => {
  const clock = mock.clock(on)
  const w = bottom(on, clock)
  w.status = ok('?? nested/\0')

  await $.session.start(START)
  await clock.advance(1)
  await openTree($, clock, w)

  expect((await readState($)).project.changes).toEqual({ files: 1, lines: { added: 0, removed: 0 } })
  expect(w.runs).toEqual([BRANCH_RUN, STATUS_RUN, DIFF_RUN])
})

// The calls of git that read the tree, by the command they run.
const statusRuns = (w: World): number => w.runs.filter(run => gitCommand(run.argv) === 'status').length

// A read of the project asked for by a change of the folder, over by the time the clock has moved on 1 ms.
const askRead = async ($: Engine, clock: MockClock): Promise<void> => {
  await $.classic.CwdChanged({ old_cwd: ROOT, new_cwd: ROOT })
  await clock.advance(1)
}

// Two `git status` calls in a row that throw, for one root, stop the reads of its changes: a huge tree (a dotfiles
// repository in $HOME) would spend the whole timeout on each read. The branch is still read.
test('two status calls in a row that throw stop the changes reads for that root, for as long as the module lives',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.status = ok(' M a.ts\0')
    w.diff = ok('3\t1\ta.ts\n')
    await $.session.start(START)
    await clock.advance(1)
    w.statusThrows = true // the status times out, as in a tree that git cannot walk in 10 s
    await openTree($, clock, w)
    expect(statusRuns(w)).toBe(1)
    await askRead($, clock)
    expect(statusRuns(w)).toBe(2) // two throws in a row

    // The third read reads the branch, and runs no status, though the status would be fine now.
    w.statusThrows = false
    w.runs.length = 0
    await askRead($, clock)
    expect(w.runs).toEqual([BRANCH_RUN])
    expect((await readState($)).project).toEqual({ name: 'online_shop', branch: 'master', changes: null })
    // And so on, whatever asks: a call of a tool, the end of a turn, the timer of the session, a later turn.
    w.runs.length = 0
    await drive(clock, $.tool.call(edit()))
    await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't0', reason: 'answer' })
    await startTurn($, 't2')
    await clock.advance(5 * 60_000)
    expect(reads(w)).toBeGreaterThanOrEqual(3)
    expect(statusRuns(w)).toBe(0)
    expect((await readState($)).project.changes).toBeNull()
  })

test('a throw, a status that works and a throw again do not stop the reads: only a second throw in a row does',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.status = ok(' M a.ts\0')
    w.diff = ok('3\t1\ta.ts\n')
    await $.session.start(START)
    await clock.advance(1)
    w.statusThrows = true
    await openTree($, clock, w) // throw
    w.statusThrows = false
    await askRead($, clock) // a status that works: the count starts over
    expect((await readState($)).project.changes).toEqual({ files: 1, lines: { added: 3, removed: 1 } })
    w.statusThrows = true
    await askRead($, clock) // throw
    w.statusThrows = false
    await askRead($, clock) // it is read, and works
    w.statusThrows = true
    await askRead($, clock) // throw
    expect(statusRuns(w)).toBe(5)

    w.statusThrows = false
    await askRead($, clock) // one throw in a row so far: still read
    expect(statusRuns(w)).toBe(6)
    expect((await readState($)).project.changes).toEqual({ files: 1, lines: { added: 3, removed: 1 } })
  })

test('a status that exits with an error is no throw: outside a repository the reads go on, and the count starts over',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    w.statusThrows = true
    await openTree($, clock, w) // throw
    w.statusThrows = false
    w.gitExit = 128 // outside a git repository: every call exits 128
    await askRead($, clock)
    await askRead($, clock)
    await askRead($, clock)
    expect(statusRuns(w)).toBe(4) // all of them ran: an exit is no throw, and each one cleared the count

    w.statusThrows = true
    w.gitExit = 0
    await askRead($, clock)
    w.statusThrows = false
    w.status = ok(' M a.ts\0')
    w.diff = ok('3\t1\ta.ts\n')
    await askRead($, clock)
    expect(statusRuns(w)).toBe(6) // one throw, then read again
    expect((await readState($)).project.changes).toEqual({ files: 1, lines: { added: 3, removed: 1 } })
  })

test('the reads of another root go on, and the root that was stopped reads again once another has been read',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.status = ok(' M a.ts\0')
    w.diff = ok('3\t1\ta.ts\n')
    await $.session.start(START)
    await clock.advance(1)
    w.statusThrows = true
    await openTree($, clock, w)
    await askRead($, clock)
    expect(statusRuns(w)).toBe(2) // ROOT is stopped
    w.statusThrows = false

    // Another folder: its changes are read, and shown under its own name.
    w.root = '/work/other_repo'
    w.runs.length = 0
    await askRead($, clock)
    expect(w.runs.map(run => [gitCommand(run.argv), run.init])).toEqual([
      ['branch', { cwd: '/work/other_repo', timeoutMs: 5000 }],
      ['status', { cwd: '/work/other_repo', timeoutMs: 10_000, env: { GIT_NO_LAZY_FETCH: '1' } }],
      ['diff', { cwd: '/work/other_repo', timeoutMs: 10_000, env: { GIT_NO_LAZY_FETCH: '1' } }],
    ])
    expect((await readState($)).project).toEqual({
      name: 'other_repo', branch: 'master', changes: { files: 1, lines: { added: 3, removed: 1 } },
    })

    // Back to the first one: the read of the other has cleared the count, so the status runs again.
    w.root = ROOT
    w.runs.length = 0
    await askRead($, clock)
    expect(statusRuns(w)).toBe(1)
    expect((await readState($)).project).toEqual({
      name: 'online_shop', branch: 'master', changes: { files: 1, lines: { added: 3, removed: 1 } },
    })
  })

test('throws for two roots in a row are no two for one root: the count is that of one root', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    w.statusThrows = true
    await openTree($, clock, w) // ROOT: a throw
    w.root = '/work/other_repo'
    await askRead($, clock) // another root: a throw, for it the first
    w.root = ROOT
    await askRead($, clock) // ROOT again: the first throw in a row for it
    expect(statusRuns(w)).toBe(3)
    await askRead($, clock) // the second in a row: the last that runs
    expect(statusRuns(w)).toBe(4)
    await askRead($, clock)
    expect(statusRuns(w)).toBe(4)
  })

test('a call that may change a file reads the project 1000 ms after it ends, and not before', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    await openTree($, clock, w)
    w.runs.length = 0
    w.status = ok(' M a.ts\0')
    w.diff = ok('2\t1\ta.ts\n')

    await drive(clock, $.tool.call(edit()))
    await clock.advance(PROJECT_DELAY_MS - 1)
    expect(w.runs).toEqual([])
    expect((await readState($)).project.changes).toBeNull()

    await clock.advance(1)
    expect(w.runs).toEqual([BRANCH_RUN, STATUS_RUN, DIFF_RUN])
    expect((await readState($)).project.changes).toEqual({ files: 1, lines: { added: 2, removed: 1 } })
  })

test('two calls inside the delay give one read, at the end of the first call plus the delay', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    w.runs.length = 0

    await drive(clock, $.tool.call(edit())) // ends at 300 ms: the read is due at 1300
    await clock.advance(400)
    await drive(clock, $.tool.call(write())) // ends at 1000 ms, inside the delay: it adds nothing
    await clock.advance(299)
    expect(reads(w)).toBe(0)
    await clock.advance(1)
    expect(reads(w)).toBe(1)

    await clock.advance(5 * PROJECT_DELAY_MS)
    expect(reads(w)).toBe(1)
  })

// A call that ends at once, whatever the clock: a Bash that fails still asks for a read, since it may have changed a
// file before it failed. With it a test sets the time of each call exactly.
const instant = () => ({ tool: 'Bash', command: 'fail it' }) as const

// The first timer that a write call sets is refused, so it never runs and its read never comes. The wait it left is
// taken as lost once it is twice the delay old: a call before that adds nothing, a call from then on asks again.
const REFUSED_WAITS: Array<[gap: number, isRead: boolean]> = [
  [0, false],
  [PROJECT_DELAY_MS, false],
  [2 * PROJECT_DELAY_MS - 1, false],
  [2 * PROJECT_DELAY_MS, true],
  [10 * PROJECT_DELAY_MS, true],
]
for (const [gap, isRead] of REFUSED_WAITS) {
  test(`after a timer that a hook refused, a write call ${gap} ms after the one that asked ${
    isRead ? 'asks again, and is read' : 'adds nothing'}`, WITH_REFUSER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    w.runs.length = 0

    await $.tool.call(instant()) // asks for a read; the timer is refused
    await clock.advance(gap)
    await $.tool.call(instant())
    await clock.advance(5 * PROJECT_DELAY_MS)
    expect(reads(w)).toBe(isRead ? 1 : 0)
  })
}

test('a call after the read ran asks for the next one, though the call before it was less than twice the delay ago',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    w.runs.length = 0

    await $.tool.call(instant())
    await clock.advance(PROJECT_DELAY_MS)
    expect(reads(w)).toBe(1)
    await $.tool.call(instant())
    await clock.advance(PROJECT_DELAY_MS)
    expect(reads(w)).toBe(2)
  })

test('the wait is dated from the end of the call, when its timer is set, not from its start', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    w.runs.length = 0
    w.toolFailMs = 3 * PROJECT_DELAY_MS // the first call fails after 3 s

    await drive(clock, $.tool.call(instant())) // ends 3 s after it began, and the read is due 1 s after that
    w.toolFailMs = 0
    await clock.advance(PROJECT_DELAY_MS / 2)
    await $.tool.call(instant()) // a wait dated from the start would be over 3 s old, lost, and asked again
    await clock.advance(5 * PROJECT_DELAY_MS)
    expect(reads(w)).toBe(1)
  })

test('a Read gives no read, and neither does an Edit that was denied: it never ran', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    w.runs.length = 0

    await drive(clock, $.tool.call(readCall()))
    expect(await $.tool.call(edit('deny it'))).toEqual({ deny: 'no' })
    await clock.advance(5 * PROJECT_DELAY_MS)
    expect(reads(w)).toBe(0)

    // The same wait after an Edit that ran is long enough for a read.
    await drive(clock, $.tool.call(edit()))
    await clock.advance(PROJECT_DELAY_MS)
    expect(reads(w)).toBe(1)
  })

test('a subagent\'s Bash gives one read, and so does a call that failed: it may have changed a file first',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    w.runs.length = 0

    await drive(clock, $.tool.call({ tool: 'Bash', command: 'sed -i s/a/b/ a.ts', agentId: 'a1' } as never))
    await clock.advance(PROJECT_DELAY_MS)
    expect(reads(w)).toBe(1)
    await clock.advance(5 * PROJECT_DELAY_MS)
    expect(reads(w)).toBe(1)

    await $.tool.call({ tool: 'Bash', command: 'fail it' })
    await clock.advance(PROJECT_DELAY_MS)
    expect(reads(w)).toBe(2)
  })

// What each tool does to the project: the five that may change a file give one read, the others none. The input of each
// is what the tool takes; the bottom ends every call in 300 ms.
const TOOL_READS: Array<[tool: string, input: Record<string, unknown>, reads: number]> = [
  ['Edit', { file_path: `${ROOT}/a.ts`, old_string: 'a', new_string: 'b' }, 1],
  ['Write', { file_path: `${ROOT}/b.ts`, content: 'x' }, 1],
  ['MultiEdit', { file_path: `${ROOT}/a.ts`, edits: [{ old_string: 'a', new_string: 'b' }] }, 1],
  ['NotebookEdit', { notebook_path: `${ROOT}/n.ipynb`, new_source: 'x' }, 1],
  ['Bash', { command: 'sed -i s/a/b/ a.ts' }, 1],
  ['Read', { file_path: `${ROOT}/a.ts` }, 0],
  ['Grep', { pattern: 'a' }, 0],
  ['Glob', { pattern: '**/*.ts' }, 0],
  ['WebFetch', { url: 'https://example.com', prompt: 'p' }, 0],
]
test('Edit, Write, MultiEdit, NotebookEdit and Bash give one read each; Read, Grep, Glob and WebFetch give none',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    w.runs.length = 0

    for (const [tool, input, expected] of TOOL_READS) {
      const before = reads(w)
      await drive(clock, $.tool.call({ tool, ...input } as never))
      await clock.advance(2 * PROJECT_DELAY_MS)
      expect(reads(w) - before, tool).toBe(expected)
    }
  })

test('a request while a read runs gives one more read after it, and the two never overlap', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    await openTree($, clock, w)
    w.runs.length = 0
    w.maxGitInFlight = 0
    w.gitLag = 300 // a read is two calls, so it takes 600 ms
    const ask = () => $.classic.CwdChanged({ old_cwd: ROOT, new_cwd: ROOT })

    await ask()
    await clock.advance(1)
    expect(w.runs).toEqual([BRANCH_RUN]) // the read is under way
    // Three more requests come while it runs. They ask for one read, and it is not started yet.
    await clock.advance(100)
    await ask()
    await ask()
    await ask()
    await clock.advance(1)
    expect(w.runs).toEqual([BRANCH_RUN])

    await clock.advance(5000)
    expect(w.runs).toEqual([BRANCH_RUN, STATUS_RUN, BRANCH_RUN, STATUS_RUN])
    expect(w.maxGitInFlight).toBe(1)
  })

// The other things that ask for a read of the project. Whoever asks, a request that comes while a read runs waits for
// it: they all go through the one runner. The Edit asks 1000 ms after it ends.
const REQUESTS: Array<[what: string, ask: ($: Engine, clock: MockClock) => Promise<unknown>]> = [
  [
    'the end of a main turn',
    $ => $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't0', reason: 'answer' }),
  ],
  ['a call of Edit', ($, clock) => drive(clock, $.tool.call(edit()))],
]
for (const [what, ask] of REQUESTS) {
  test(`a read asked for by ${what} while one runs waits for it, and the two never overlap`, WITH_READER,
    async ($, on) => {
      const clock = mock.clock(on)
      const w = bottom(on, clock)
      await $.session.start(START)
      await clock.advance(1)
      await openTree($, clock, w)
      w.runs.length = 0
      w.maxGitInFlight = 0
      w.gitLag = 1000 // a read is two calls, so it takes 2 s

      await $.classic.CwdChanged({ old_cwd: ROOT, new_cwd: ROOT })
      await clock.advance(1)
      expect(w.runs).toEqual([BRANCH_RUN])
      await ask($, clock)
      await clock.advance(10_000)

      expect(w.runs).toEqual([BRANCH_RUN, STATUS_RUN, BRANCH_RUN, STATUS_RUN])
      expect(w.maxGitInFlight).toBe(1)
    })
}

// The tree is shut until the first turn, so each read here is the branch alone, a call of 300 ms.
test('the read that the start of the session asks for goes through the runner too', WITH_READER, async ($, on) => {
  const clock = mock.clock(on)
  const w = bottom(on, clock)
  w.gitLag = 300

  await $.session.start(START)
  await clock.advance(1)
  expect(w.runs).toEqual([BRANCH_RUN])
  await $.classic.CwdChanged({ old_cwd: ROOT, new_cwd: ROOT })
  await clock.advance(101)
  expect(w.runs).toEqual([BRANCH_RUN])

  await clock.advance(5000)
  expect(w.runs).toEqual([BRANCH_RUN, BRANCH_RUN])
  expect(w.maxGitInFlight).toBe(1)
})

test('a read that fails does not stop the next one: a request that came meanwhile is served, and so is a later one',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    await openTree($, clock, w)
    w.runs.length = 0
    w.rootLag = 300
    w.rootFailures = 1 // the first read fails, after 300 ms
    const ask = () => $.classic.CwdChanged({ old_cwd: ROOT, new_cwd: ROOT })

    await ask()
    await clock.advance(101)
    await ask()
    await clock.advance(1)
    expect(w.runs).toEqual([])

    await clock.advance(5000)
    expect(w.runs).toEqual([BRANCH_RUN, STATUS_RUN]) // the second read, whole: the first one never reached git

    w.runs.length = 0
    await ask()
    await clock.advance(5000)
    expect(w.runs).toEqual([BRANCH_RUN, STATUS_RUN])
  })

// A call that core ran read-only (a Bash `ls`) says so in its result, and it changed no file: it asks for no read. The
// same calls, when core did not hold them read-only, ask.
test('a call that core ran read-only asks for no read, and the same call that it did not gives one', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    w.runs.length = 0

    const calls = [
      ['Bash', { tool: 'Bash', command: 'ls -la' }], ['Edit', edit()], ['a Bash that failed', instant()],
    ] as const
    for (const [what, call] of calls) {
      const before = reads(w)
      w.isReadOnly = true
      await drive(clock, $.tool.call(call as never))
      await clock.advance(5 * PROJECT_DELAY_MS)
      expect(reads(w) - before, `${what}, run read-only`).toBe(0)
      w.isReadOnly = false
      await drive(clock, $.tool.call(call as never))
      await clock.advance(5 * PROJECT_DELAY_MS)
      expect(reads(w) - before, what).toBe(1)
    }
  })

// A read takes two git calls when the tree is clean, `lag` each: the next delayed read waits as long as four such
// reads, but never less than the delay. The second row is where the two meet.
const READ_DELAYS: Array<[lag: number, delay: number]> = [
  [50, PROJECT_DELAY_MS], // a read of 100 ms: four of them are 400 ms, the delay of 1000 ms stands
  [125, PROJECT_DELAY_MS], // 250 ms: four of them are 1000 ms, the same
  [126, 4 * 2 * 126], // 252 ms: 1008 ms
  [300, 4 * 2 * 300], // 600 ms: 2400 ms
  [1000, 4 * 2 * 1000], // 2000 ms: 8000 ms
]
for (const [lag, delay] of READ_DELAYS) {
  test(`a read of ${2 * lag} ms makes the next delayed read wait ${delay} ms, and not before`, WITH_READER,
    async ($, on) => {
      const clock = mock.clock(on)
      const w = bottom(on, clock)
      w.gitLag = lag
      await $.session.start(START)
      await clock.advance(1 + lag) // the read of the start of the session is over: the branch alone, the tree is shut
      await startTurn($)
      await clock.advance(1 + 2 * lag) // the read that the first turn asked for is over: the branch and the status
      w.runs.length = 0
      expect(delay).toBe(Math.max(PROJECT_DELAY_MS, PROJECT_GAP_FACTOR * 2 * lag))

      await $.tool.call(instant())
      await clock.advance(delay - 1)
      expect(reads(w)).toBe(0)
      await clock.advance(1)
      expect(reads(w)).toBe(1)
    })
}

test('a read that fails after 600 ms makes the next delayed read wait 2400 ms, as one that succeeded does', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.rootLag = 600
    w.rootFailures = 1 // the read of the start of the session fails, after 600 ms
    await $.session.start(START)
    await clock.advance(1 + 600)
    expect((await readState($)).project).toBeUndefined() // it wrote nothing
    w.rootLag = 0
    w.runs.length = 0

    await $.tool.call(instant())
    await clock.advance(4 * 600 - 1)
    expect(reads(w)).toBe(0)
    await clock.advance(1)
    expect(reads(w)).toBe(1)
  })

test('a read whose git calls are refused after 600 ms makes the next delayed read wait 2400 ms', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.gitThrows = true // each call is refused after its lag
    w.gitLag = 300
    await $.session.start(START)
    await clock.advance(1 + 300) // the branch alone: the tree is shut
    await startTurn($)
    await clock.advance(1 + 2 * 300) // the branch, then the status: two calls
    w.runs.length = 0

    await $.tool.call(instant())
    await clock.advance(4 * 600 - 1)
    expect(reads(w)).toBe(0)
    await clock.advance(1)
    expect(reads(w)).toBe(1)
  })

// The wait of a read that a hook refused is lost once it is twice its own delay old, as the delay follows the last
// read: here 2400 ms, so the window is 4800 ms. A call inside it adds nothing, one after it asks again.
const SCALED_WAITS: Array<[gap: number, isRead: boolean]> = [
  [2 * PROJECT_DELAY_MS + 500, false], // past twice the delay of 1000 ms, still inside the window of this one
  [2 * 4 * 600 - 1, false],
  [2 * 4 * 600, true],
]
for (const [gap, isRead] of SCALED_WAITS) {
  test(`with a delay of 2400 ms, a refused timer's wait is lost after 4800 ms: a call ${gap} ms later ${
    isRead ? 'asks again, and is read' : 'adds nothing'}`, WITH_REFUSER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.gitLag = 300
    await $.session.start(START)
    await clock.advance(1 + 300) // the branch alone: the tree is shut
    await startTurn($)
    await clock.advance(1 + 2 * 300) // the branch, then the status: two calls
    w.runs.length = 0

    await $.tool.call(instant()) // asks, with a delay of 2400 ms; the timer is refused
    await clock.advance(gap)
    await $.tool.call(instant())
    await clock.advance(10 * PROJECT_DELAY_MS)
    expect(reads(w)).toBe(isRead ? 1 : 0)
  })
}

// A read that spans a suspend or a clock jump takes hours by the clock, and a delayed read then waits four times that.
// The wait it set must not outlive the fast reads that come after it: a wait counts for twice the shorter of its own
// delay and the delay a new call would get. Here the read of the first turn takes an hour, so the first call asks for
// four hours; the end of a turn reads at once, in 600 ms, so a new call would get 2400 ms, and the window is 4800 ms
// from the call that asked. A call inside it adds nothing, one at its edge asks again: the read comes 7200 ms after the
// first call, not four hours.
test('a wait set after a read of an hour does not outlive the fast read that follows it', TICKING_READER,
  async ($, on) => {
    const HOUR = 3_600_000
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    // The session does not start: its timer would ask for a read every minute of that hour, and each ask would mark the
    // read under way stale. The attach arms the timer of TICKER, so that the clock moves fast.
    await $.session.attach({ surface: 'terminal', clientId: 'terminal:default' })
    w.rootLag = HOUR // the read that the first turn asks for takes an hour: a suspend in the middle of it
    await startTurn($)
    await clock.advance(1 + HOUR)
    w.rootLag = 0
    w.runs.length = 0

    await $.tool.call(instant()) // asks, with a delay of four hours
    w.gitLag = 300 // the next read takes 600 ms
    await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't0', reason: 'answer' })
    await clock.advance(1 + 600)
    expect(reads(w)).toBe(1) // the read of the end of the turn

    await clock.advance(4800 - 1 - (1 + 600))
    await $.tool.call(instant()) // 4799 ms after the call that asked: inside the window, it adds nothing
    await clock.advance(1)
    await $.tool.call(instant()) // 4800 ms: the wait counts as lost, and this call asks again, with 2400 ms
    await clock.advance(2400 - 1)
    expect(reads(w)).toBe(1)
    await clock.advance(1)
    expect(reads(w)).toBe(2) // 7200 ms after the first call
  })

// The other side of the shorter: a wait counts for twice its own delay when a new call would get a longer one, as a
// slower read makes it. Here the wait asks for 1000 ms and a read of 600 ms follows it, so that a new call would get
// 2400 ms, and the window stays 2000 ms.
const OWN_DELAY_WAITS: Array<[gap: number, isRead: boolean]> = [
  [2 * PROJECT_DELAY_MS - 1, false],
  [2 * PROJECT_DELAY_MS, true],
]
for (const [gap, isRead] of OWN_DELAY_WAITS) {
  test(`a wait of 1000 ms still counts for 2000 ms after a slower read: a call ${gap} ms later ${
    isRead ? 'asks again, and is read' : 'adds nothing'}`, WITH_REFUSER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)

    await $.tool.call(instant()) // asks, with a delay of 1000 ms; the timer is refused
    w.runs.length = 0
    w.gitLag = 300 // the next read takes 600 ms
    await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't0', reason: 'answer' })
    await clock.advance(gap)
    await $.tool.call(instant())
    await clock.advance(10 * PROJECT_DELAY_MS)
    expect(reads(w)).toBe(isRead ? 2 : 1) // the read of the end of the turn, and the one that the call asked for
  })
}

// Only a delayed read waits in proportion to the last one: the read that a request during a read brings starts as that
// read ends, however long it took.
test('the read that a request during a slow read brings starts as that read ends, with no gap', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    await openTree($, clock, w)
    w.runs.length = 0
    w.gitLag = 300 // a read is two calls, so it takes 600 ms, and a delayed read would wait 2400 ms after it
    const ask = () => $.classic.CwdChanged({ old_cwd: ROOT, new_cwd: ROOT })

    await ask()
    await clock.advance(101)
    await ask() // 100 ms into the read
    await clock.advance(499)
    expect(w.runs).toEqual([BRANCH_RUN, STATUS_RUN]) // the read is in its last call
    await clock.advance(1)
    expect(w.runs).toEqual([BRANCH_RUN, STATUS_RUN, BRANCH_RUN]) // it ends, and the one more starts at once
  })

// The branch is written as soon as git has said it, and the changes follow when they are read. A read is slow when its
// status is: each git call takes 300 ms here, so the branch is in the value at 300 ms, and the changes at 600.
test('the branch is in the project value before the changes are read, with the changes held that were read before',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.status = ok(' M a.ts\0')
    w.diff = ok('3\t1\ta.ts\n')
    await $.session.start(START)
    await clock.advance(1)
    await openTree($, clock, w)
    const first = { name: 'online_shop', branch: 'master', changes: { files: 1, lines: { added: 3, removed: 1 } } }
    expect((await readState($)).project).toEqual(first)

    // A checkout, and two modified files now; the read is slow.
    w.branch = 'dev\n'
    w.status = ok(' M a.ts\0 M b.ts\0')
    w.diff = ok('5\t2\ta.ts\n')
    w.gitLag = 300
    await $.classic.CwdChanged({ old_cwd: ROOT, new_cwd: ROOT })
    await clock.advance(1 + 300 + 50)
    expect(w.gitInFlight).toBe(1) // the status is still being read
    expect((await readState($)).project).toEqual({ ...first, branch: 'dev' })

    await clock.advance(5000)
    expect((await readState($)).project).toEqual({
      name: 'online_shop', branch: 'dev', changes: { files: 2, lines: { added: 5, removed: 2 } },
    })
  })

test('a count from another folder is never shown under the new name: the held changes go at once', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.status = ok(' M a.ts\0')
    w.diff = ok('3\t1\ta.ts\n')
    await $.session.start(START)
    await clock.advance(1)
    await openTree($, clock, w)
    expect((await readState($)).project.changes).toEqual({ files: 1, lines: { added: 3, removed: 1 } })

    // The session root is another folder now; its status takes 300 ms, and says the same.
    w.root = '/work/other_repo'
    w.gitLag = 300
    await $.classic.CwdChanged({ old_cwd: ROOT, new_cwd: w.root })
    await clock.advance(1 + 300 + 50)
    expect(w.gitInFlight).toBe(1)
    expect((await readState($)).project).toEqual({ name: 'other_repo', branch: 'master', changes: null })

    await clock.advance(5000)
    expect((await readState($)).project).toEqual({
      name: 'other_repo', branch: 'master', changes: { files: 1, lines: { added: 3, removed: 1 } },
    })
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

test('a measure with another window than the last one reads the breakdown again; with the same one it does not',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    const shown = async () => (await readState($)).usage
    w.tokens = 100_000
    const measure = (window: number) => $.session.measure({
      context: { window, tokens: 100_000, percent: 10 }, rateLimits: [], changed: ['context'],
    })

    await $.session.start(START)
    await clock.advance(1)
    expect(w.breakdowns).toBe(1) // the start-up read
    expect(await shown()).toMatchObject({ contextWindow: 1_000_000, contextPct: 10 })

    // The first measure only stores its window, since the start-up has read the breakdown; the same window again
    // brings nothing new.
    await measure(1_000_000)
    await measure(1_000_000)
    await clock.advance(1)
    expect(w.breakdowns).toBe(1)

    // Another model, another window. A measure never replaces the held window, so the breakdown is read again, and the
    // window it measures against takes its place.
    w.rawMaxTokens = 200_000
    await measure(200_000)
    expect((await shown()).contextWindow).toBe(1_000_000) // until that read has run
    await clock.advance(1)
    expect(w.breakdowns).toBe(2)
    expect(await shown()).toMatchObject({ contextWindow: 200_000, contextPct: 50 })

    await measure(200_000)
    await clock.advance(1)
    expect(w.breakdowns).toBe(2)
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
      elapsedMs: 2000, modelMs: 1700, toolMs: 300, steps: 2, ttftMs: 250, tokensIn: 1000, tokensOut: 800, cachePct: 90,
      costUsd: 0.375,
    })
    expectNear(state.lastTurn?.wholeTurnRate, 140 / 1.7)
    // The answer: 100 tokens over its whole request, 0.7 s (its text came 0.2 s in, which does not matter).
    expectNear(state.lastTurn?.responseRate, 100 / 0.7)
    expect(state.log.map(entry => [entry.who, entry.text, entry.kind, entry.outcome])).toEqual([
      ['main', 'Bash ls -la', 'ok', '✓ 0.3s'],
      ['you', 'fix the stock order qty', 'info', undefined],
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

// U+202E, the right-to-left override, reorders what follows it; U+200B is a zero-width space. They are spelled as
// escapes, so that this file shows what it says.
const BIDI = '\u202E'
const ZWSP = '\u200B'

test('the format characters are taken out of the branch and the folder name: a U+202E reorders nothing', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.branch = `ma${BIDI}in${ZWSP}\n`
    w.root = `/work/onli${BIDI}ne_shop`

    await $.session.start(START)
    await clock.advance(1)

    expect((await readState($)).project).toEqual({ name: 'online_shop', branch: 'main', changes: null })
  })

test('the format characters are taken out of the names of the MCP servers, before the hidden ones are matched',
  WITH_READER, async ($, on) => {
    // The U+202E is in the name of the person's server; the U+200B is in the prefix of `ccd_x`, a server of the app.
    const servers = [`issue${BIDI}-hub`, `cc${ZWSP}d_x`, 'codebase-memory']

    expect(await listedAfterStart($, on, servers)).toEqual(['issue-hub', 'codebase-memory'])
  })

test('a detached HEAD, and a branch of nothing but format characters, show the short commit', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.branch = `${BIDI}${ZWSP}\n`

    await $.session.start(START)
    await clock.advance(1)

    expect((await readState($)).project.branch).toBe('abc1234')
  })

test('the format characters are taken out of every line of the log: prompt, tag, command, spawn and answer',
  SLOW_READER, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    await $.turn.start({ text: `rename ${BIDI}txt.exe`, turnId: 't1' })
    await $.turn.start({ text: `<${BIDI}task-notification>done</task-notification>`, turnId: 't2' })
    await drive(clock, $.tool.call({ tool: 'Bash', command: `rm ${BIDI}txt.exe` }))
    const edited = { tool: 'Edit', file_path: `${ROOT}/a${BIDI}.ts`, old_string: 'a', new_string: 'b' } as const
    await drive(clock, $.tool.call(edited))
    await $.agent.spawn({ ...SPAWN, description: `check ${BIDI}fdp.exe` })
    expect(await chargedAfter($, clock, w, 'a1', 0.5)).toBe(0.5)
    await finish($, 'a1', `found ${BIDI}fdp.exe`)

    // Newest first.
    const { log } = await readState($)
    expect(log.map(entry => entry.text)).toEqual([
      'done · $0.500 — found fdp.exe',
      'spawned · engineer: check fdp.exe',
      'Edit a.ts',
      'Bash rm txt.exe',
      'task-notification',
      'rename txt.exe',
    ])
    expect(JSON.stringify(log)).not.toContain(BIDI)
  })

// The Subagents list draws the description and the type of a row as the row keeps them. The row is written when the
// agent spawns; a resume, a sync and the end of a run only change it, so they keep what is there.
test('the format characters are taken out of the description and the type of a spawned agent, and stay out',
  SLOW_READER, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const isClean = async (): Promise<void> => {
      const { agents, log } = await readState($)
      for (const mark of [BIDI, ZWSP]) {
        expect(JSON.stringify(agents)).not.toContain(mark)
        expect(JSON.stringify(log)).not.toContain(mark)
      }
    }

    // The type is the agent's own, or its name when it has none (the types say it always has one: that input is cast).
    await $.agent.spawn({ ...SPAWN, description: `check ${BIDI}fdp.exe`, subagentType: `eng${BIDI}ineer` })
    await $.agent.spawn({
      ...SPAWN, description: `review ${ZWSP}it`, subagentType: undefined, name: `re${BIDI}viewer`,
    } as never)
    let { agents } = await readState($)
    expect([agents.a1?.description, agents.a1?.type]).toEqual(['check fdp.exe', 'engineer'])
    expect([agents.a2?.description, agents.a2?.type]).toEqual(['review it', 'reviewer'])
    await isClean()

    // A resume, and a sync with the engine's list, change the rows that are there: the clean strings stay.
    await $.turn.complete({
      answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer',
    })
    await runStep($, clock, { turnId: 't1', index: 1, agentId: 'a1' })
    await clock.advance(10)
    w.listed = [{ id: 'a2', status: 'completed' }]
    await clock.advance(30_000)
    agents = (await readState($)).agents
    expect([agents.a1?.status, agents.a2?.status]).toEqual(['running', 'done'])
    expect([agents.a1?.description, agents.a1?.type]).toEqual(['check fdp.exe', 'engineer'])
    expect([agents.a2?.description, agents.a2?.type]).toEqual(['review it', 'reviewer'])
    await isClean()
    expect((await readState($)).log.map(entry => entry.text)).toContain('resumed · engineer: check fdp.exe')
  })

test('a secret that has a format character in it is masked: the character does not keep its pattern from matching',
  SLOW_READER, async ($, on) => {
    const clock = mock.clock(on)
    bottom(on, clock)
    await $.session.start(START)

    const secret = `ghp_abc${ZWSP}defgh12345678`
    await drive(clock, $.tool.call({ tool: 'Bash', command: `echo ${secret}` }))
    await $.turn.start({ text: `token${ZWSP}=hunter22secret`, turnId: 't1' })

    const { log } = await readState($)
    expect(log.map(entry => entry.text)).toEqual(['token=•••', 'Bash echo •••'])
    expect(JSON.stringify(log)).not.toContain('abcdefgh')
    expect(JSON.stringify(log)).not.toContain('hunter22secret')
  })

test('a failed or denied tool call is logged as ✗ or denied, and a secret in the command is redacted', WITH_READER,
  async ($, on) => {
    bottom(on, mock.clock(on))
    await $.session.start(START)

    expect(await $.tool.call({ tool: 'Bash', command: 'deny it' })).toEqual({ deny: 'no' })
    expect(await $.tool.call({ tool: 'Bash', command: 'fail --token=hunter22secret' })).toEqual({
      isError: true, result: 'boom', text: 'boom',
    })

    expect((await readState($)).log.map(entry => [entry.who, entry.text, entry.kind, entry.outcome])).toEqual([
      ['main', 'Bash fail --token=•••', 'error', '✗ 0.0s'],
      ['main', 'Bash deny it', 'error', 'denied'],
    ])
  })

test('a failed call carries the time it took, as a successful one does', SLOW_READER, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = bottom(on, clock)
  await $.session.start(START)
  w.toolFailMs = 1200

  await drive(clock, $.tool.call({ tool: 'Bash', command: 'fail it' }))

  expect((await readState($)).log.map(entry => [entry.text, entry.kind, entry.outcome])).toEqual([
    ['Bash fail it', 'error', '✗ 1.2s'],
  ])
})

// An abandoned call (the person interrupted it, or a stop did) comes back as an error, and the signal of the hook has
// aborted. That is no fault of the tool: the line is a note, with the time and no mark. ABANDONER makes a call
// abandoned: its answer comes at once, and the chain beneath ends 300 ms later (the bottom fails a command that
// starts with `fail`).
test('an abandoned call that came back as an error is a note with no mark; a plain failure stays an error',
  WITH_ABANDONER, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = bottom(on, clock)
    w.toolFailMs = 300
    await $.session.start(START)
    await clock.advance(1)
    const lines = async (): Promise<unknown[][]> =>
      (await readState($)).log.map(entry => [entry.text, entry.kind, entry.outcome])

    expect(await $.tool.call({ tool: 'Bash', command: 'fail abandon it' })).toEqual({
      isError: true, result: 'cut', text: 'cut',
    })
    await clock.advance(400) // the call beneath ends, and the mod's hook logs it
    expect(await lines()).toEqual([['Bash fail abandon it', 'info', '0.3s']])

    // An abandoned call that ended well is no error: it ran, and the line says so.
    await $.tool.call({ tool: 'Bash', command: 'abandon it' })
    await clock.advance(400)
    // The same failure of the tool with no one abandoning it is an error; so is a denied call.
    await drive(clock, $.tool.call({ tool: 'Bash', command: 'fail plainly' }))
    await $.tool.call({ tool: 'Bash', command: 'deny it' })

    expect(await lines()).toEqual([
      ['Bash deny it', 'error', 'denied'],
      ['Bash fail plainly', 'error', '✗ 0.3s'],
      ['Bash abandon it', 'ok', '✓ 0.3s'],
      ['Bash fail abandon it', 'info', '0.3s'],
    ])
  })

test('a long command is cut to 64 characters, and its outcome stays whole', SLOW_READER, async ($, on) => {
  const clock = mock.clock(on)
  bottom(on, clock)
  await $.session.start(START)

  await drive(clock, $.tool.call({ tool: 'Bash', command: 'x'.repeat(100) }))
  await $.tool.call({ tool: 'Bash', command: `deny ${'y'.repeat(100)}` })
  await $.tool.call({ tool: 'Bash', command: `fail ${'z'.repeat(100)}` })

  const lines = (await readState($)).log.map(entry => [entry.text, entry.outcome] as const)
  expect(lines).toEqual([
    [`${`Bash fail ${'z'.repeat(100)}`.slice(0, 63)}…`, '✗ 0.0s'],
    [`${`Bash deny ${'y'.repeat(100)}`.slice(0, 63)}…`, 'denied'],
    [`${`Bash ${'x'.repeat(100)}`.slice(0, 63)}…`, '✓ 0.3s'],
  ])
  expect(lines.map(([text]) => text.length)).toEqual([64, 64, 64])
})

test('a turn the mod did not see start leaves lastTurn alone; the project is read again when a turn ends, the branch '
  + 'alone', WITH_READER, async ($, on) => {
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
    // No turn started here, so the tree is shut still: only the first turn of the main agent opens it.
    expect(w.runs).toEqual([BRANCH_RUN])
  })

test('a turn that ends before any response leaves the last turn shown, and the next one replaces it', SLOW_READER,
  async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    await $.turn.start({ text: 'first', turnId: 't1' })
    await runStep($, clock, { turnId: 't1', index: 1 })
    await $.turn.complete({ answer: 'done', durationMs: 700, isAborted: false, turnId: 't1', reason: 'answer' })
    const earlier = (await readState($)).lastTurn
    expect(earlier).toMatchObject({ steps: 1, elapsedMs: 700 })

    // The person stops the next turn before the model has answered: it has no step, and its end brings no usage.
    await $.turn.start({ text: 'second', turnId: 't2' })
    expect((await readState($)).turn?.turnId).toBe('t2')
    await $.turn.complete({ answer: '', durationMs: 40, isAborted: true, turnId: 't2', reason: 'aborted' })
    const stopped = await readState($)
    expect(stopped.lastTurn).toEqual(earlier)
    expect(stopped.turn).toBeNull() // the turn itself is over all the same

    // A turn that has a response is the last one again.
    await $.turn.start({ text: 'third', turnId: 't3' })
    await runStep($, clock, { turnId: 't3', index: 1 })
    await $.turn.complete({ answer: 'done', durationMs: 900, isAborted: false, turnId: 't3', reason: 'answer' })
    expect((await readState($)).lastTurn).toMatchObject({ steps: 1, elapsedMs: 900 })
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
  expect(state.log.find(entry => entry.who === 'engineer')).toMatchObject({ text: 'Read src/a.py', outcome: '✓ 0.3s' })

  const completed = await $.turn.complete({
    answer: 'found the bug in qty', durationMs: 72_000, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer',
  })
  const completedAt = clock.now()
  expect(completed).toEqual({ text: 'found the bug in qty' })
  state = await readState($)
  expect(state.agents.a1).toMatchObject({ status: 'done', endedAt: completedAt, costUsd: 0.75 })
  expect(state.log[0]).toEqual({
    at: completedAt, who: 'engineer', text: 'done · $0.750 — found the bug in qty', kind: 'ok', outcome: '✓ 1m 12s',
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
  expect(state.log.slice(0, 2).map(entry => [entry.who, entry.text, entry.kind, entry.outcome])).toEqual([
    ['engineer', 'failed', 'error', '✗ 0.0s'],
    ['engineer', 'stopped', 'info', '0.0s'], // somebody stopped it: that is news, not an error, so no mark
  ])
})

test('the answer in the line of a subagent is masked and cut to 80 characters', WITH_READER, async ($, on) => {
  bottom(on, mock.clock(on))
  await $.session.start(START)
  await $.agent.spawn(SPAWN)
  await $.agent.spawn(SPAWN)

  const answers: [string, string][] = [['a1', 'use token=hunter22secret'], ['a2', 'x'.repeat(200)]]
  for (const [agentId, answer] of answers) {
    await $.turn.complete({ answer, durationMs: 5, isAborted: false, turnId: 't1', agentId, reason: 'answer' })
  }

  const { log } = await readState($)
  expect(log.slice(0, 2).map(entry => entry.text)).toEqual([`done — ${'x'.repeat(79)}…`, 'done — use token=•••'])
  expect(JSON.stringify(log)).not.toContain('hunter22secret')
})

test('the answer of a subagent loses its markdown marks, whether the engine gave it or the agent handed it back',
  SLOW_READER, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    await spawnCharged($, clock, w, 4)
    // a2 hands its report back and the engine's answer is empty. a3's is masked and cut after the marks are gone: they
    // go before the masking, as `redact` takes the closing `**` of `**token=hunter22secret**` into the secret, which
    // would leave the opening one alone. a4 names a file and two sums, which are no marks.
    await drive(clock, $.tool.call(handBack({ message: '## Report\n**Verdict:** `ok`' }, 'a2')))

    await finish($, 'a1', '**Verdict:** ok')
    await finish($, 'a2')
    await finish($, 'a3', `**token=hunter22secret** ${'x'.repeat(200)}`)
    await finish($, 'a4', 'fixed `__init__.py`, x ** 2 and 2**10')

    expect(await doneLines($)).toEqual([
      'done · $0.500 — Verdict: ok',
      'done · $0.500 — Report Verdict: ok',
      `done · $0.500 — token=••• ${'x'.repeat(69)}…`,
      'done · $0.500 — fixed __init__.py, x ** 2 and 2**10',
    ])
    expect(JSON.stringify((await readState($)).log)).not.toContain('hunter22secret')
  })

test('the end of a subagent has its outcome in a field of its own: a mark and the time, a stop with no mark',
  SLOW_READER, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    for (let i = 0; i < 4; i += 1) await $.agent.spawn(SPAWN)
    expect(await chargedAfter($, clock, w, 'a1', 0.5)).toBe(0.5) // a1 has cost something, the others not
    const end = (agentId: string, how: { answer?: string; durationMs: number; isAborted?: boolean; reason: string }) =>
      $.turn.complete({ answer: '', isAborted: false, turnId: 't1', agentId, ...how } as never)

    await end('a1', { answer: 'found it', durationMs: 72_000, reason: 'answer' })
    await end('a2', { durationMs: 1500, reason: 'answer' })
    await end('a3', { durationMs: 2000, reason: 'error' })
    await end('a4', { durationMs: 3000, isAborted: true, reason: 'aborted' })

    // Newest first. The cost part of the text only when the row has one, the answer part only when there is an answer.
    const { log } = await readState($)
    expect(log.slice(0, 4).map(entry => [entry.who, entry.text, entry.kind, entry.outcome])).toEqual([
      ['engineer', 'stopped', 'info', '3.0s'],
      ['engineer', 'failed', 'error', '✗ 2.0s'],
      ['engineer', 'done', 'ok', '✓ 1.5s'],
      ['engineer', 'done · $0.500 — found it', 'ok', '✓ 1m 12s'],
    ])
  })

test('a line that reports no action has no outcome key: a prompt, an engine turn, a spawn, a resume, a compaction',
  SLOW_READER, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await $.turn.start({ text: '<task-notification>done</task-notification>', turnId: 't2' })
    await $.agent.spawn(SPAWN)
    await $.turn.complete({
      answer: 'ok', durationMs: 5, isAborted: false, turnId: 't2', agentId: 'a1', reason: 'answer',
    })
    await runStep($, clock, { turnId: 't2', index: 1, agentId: 'a1' }) // a message wakes it
    await clock.advance(10)
    await $.session.compact({ trigger: 'manual', messages: MESSAGES })
    await clock.advance(1)

    // Newest first. Only the end of the subagent, which is an action with a time, has an outcome.
    expect((await readState($)).log.map(entry => [entry.text.split(' ')[0], 'outcome' in entry])).toEqual([
      ['compacted', false], ['resumed', false], ['done', true], ['spawned', false], ['task-notification', false],
      ['fix', false],
    ])
  })

// The agents `a1`, `a2` ... of a test, each with a request charged, so that its `done` line has a cost: `$0.500`.
const spawnCharged = async ($: Engine, clock: MockClock, w: World, count: number): Promise<void> => {
  for (let i = 1; i <= count; i += 1) {
    await $.agent.spawn(SPAWN)
    expect(await chargedAfter($, clock, w, `a${i}`, 0.5)).toBe(0.5)
  }
}
const finish = ($: Engine, agentId: string, answer = '') =>
  $.turn.complete({ answer, durationMs: 5000, isAborted: false, turnId: 't1', agentId, reason: 'answer' })
// The text of each `done` line of the log, oldest first.
const doneLines = async ($: Engine): Promise<string[]> =>
  (await readState($)).log.map(entry => entry.text).filter(text => text.startsWith('done')).reverse()

test('the message a subagent handed back is the answer of its done line when the engine has none', SLOW_READER,
  async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    const secret = `ghp_${'a'.repeat(36)}`
    // What the agent hands back (undefined: nothing), the answer the engine ends it with, and the line that shows.
    const cases: [handed: Record<string, unknown> | undefined, answer: string, shown: string][] = [
      [{ message: 'first finding, then more' }, '', 'done · $0.500 — first finding, then more'],
      [{ message: 'not this one' }, 'the engine answer', 'done · $0.500 — the engine answer'],
      // An answer of spaces and a line break is no answer: the message stands in for it, or the line has none.
      [{ message: 'first finding' }, '  \n', 'done · $0.500 — first finding'],
      [undefined, '  \n', 'done · $0.500'],
      [undefined, '', 'done · $0.500'],
      // A message that is not a string is ignored: a number, nothing at all, null, an object.
      [{ message: 42 }, '', 'done · $0.500'],
      [{}, '', 'done · $0.500'],
      [{ message: null }, '', 'done · $0.500'],
      [{ message: { text: 'first finding' } }, '', 'done · $0.500'],
      // Masked and cut as any answer is: a secret, the line breaks of a report, and 200 characters.
      [{ message: `use ${secret}` }, '', 'done · $0.500 — use •••'],
      [{ message: 'first line\n\nsecond line' }, '', 'done · $0.500 — first line second line'],
      [{ message: 'x'.repeat(200) }, '', `done · $0.500 — ${'x'.repeat(79)}…`],
    ]
    await spawnCharged($, clock, w, cases.length)
    for (const [i, [handed]] of cases.entries()) {
      if (handed !== undefined) await drive(clock, $.tool.call(handBack(handed, `a${i + 1}`)))
    }
    for (const [i, [, answer]] of cases.entries()) await finish($, `a${i + 1}`, answer)

    expect(await doneLines($)).toEqual(cases.map(([, , shown]) => shown))
    const { log } = await readState($)
    expect(JSON.stringify(log)).not.toContain(secret)
    // The hand-backs are no lines of the log.
    expect(log.some(entry => entry.text === 'SubagentHandback')).toBe(false)
  })

test('a message handed back serves once: a later end of the same agent does not repeat it', SLOW_READER,
  async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    await spawnCharged($, clock, w, 2)
    // a1 ends on its message, a2 ends on the engine's answer, which wins: neither message may serve a second time.
    await drive(clock, $.tool.call(handBack({ message: 'first finding' }, 'a1')))
    await drive(clock, $.tool.call(handBack({ message: 'not this one' }, 'a2')))
    await finish($, 'a1')
    await finish($, 'a2', 'the engine answer')
    expect(await doneLines($)).toEqual(['done · $0.500 — first finding', 'done · $0.500 — the engine answer'])

    // A message wakes each of them, and each ends again with nothing handed back this time.
    w.stepCost = 0
    for (const agentId of ['a1', 'a2']) {
      await runStep($, clock, { turnId: 't1', index: 1, agentId })
      await clock.advance(10)
      await finish($, agentId)
    }
    expect((await doneLines($)).slice(2)).toEqual(['done · $0.500', 'done · $0.500'])

    // A new hand-back is a new message: it serves, once.
    await runStep($, clock, { turnId: 't1', index: 1, agentId: 'a1' })
    await clock.advance(10)
    await drive(clock, $.tool.call(handBack({ message: 'second finding' }, 'a1')))
    await finish($, 'a1')
    expect((await doneLines($)).slice(4)).toEqual(['done · $0.500 — second finding'])
  })

test('a failed or denied hand-back keeps no message', SLOW_READER, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = bottom(on, clock)
  await $.session.start(START)
  await clock.advance(1)
  await spawnCharged($, clock, w, 2)

  await $.tool.call(handBack({ message: 'fail it' }, 'a1'))
  await $.tool.call(handBack({ message: 'deny it' }, 'a2'))
  await finish($, 'a1')
  await finish($, 'a2')

  expect(await doneLines($)).toEqual(['done · $0.500', 'done · $0.500'])
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
  expect(state.log[0]).toMatchObject({ who: 'engineer', text: 'done — ok', kind: 'ok', outcome: '✓ 5.0s' })
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
  expect(ended.log[0]).toMatchObject({ text: 'done · $0.750 — ok', outcome: '✓ 5.0s' })
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
    expect((await readState($)).log[0]).toMatchObject({ text: 'done · $0.250 — ok', outcome: '✓ 1.0s' })
  })

test('a subagent that a message resumes runs again, with one line in the log, until it ends again', SLOW_READER,
  async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    await $.turn.start({ text: 'go', turnId: 't1' })
    // A type with a plugin prefix: the `resumed ·` line writes it whole, as the spawn line does.
    await $.agent.spawn({ ...SPAWN, subagentType: 'feature-dev:code-reviewer' })
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
    expect(resumed.log[0]).toMatchObject({
      who: 'main', text: 'resumed · feature-dev:code-reviewer: Fix cart total qty', kind: 'info',
    })
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
      at: endedAgainAt, who: 'code-reviewer', text: 'done · $0.500 — and again', kind: 'ok', outcome: '✓ 3.0s',
    })
  })

test('a resumed subagent shows as running while its request is in flight, not once the request is over', SLOW_READER,
  async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.agent.spawn(SPAWN)
    await $.turn.complete({
      answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer',
    })
    expect((await readState($)).agents.a1?.status).toBe('done')

    // The resumed request is sent and read as far as its first chunk (200 ms in); its stop (700 ms in) has not come.
    const stream = $.turn.step({ turnId: 't1', index: 1, model: 'claude-sonnet-5', messageCount: 1, agentId: 'a1' })
    const seen: unknown[] = []
    const consuming = (async () => {
      let item = await stream.next()
      while (item.done !== true) {
        seen.push(item.value)
        item = await stream.next()
      }
    })()
    await clock.advance(250)
    expect(seen).toHaveLength(1)
    expect((await readState($)).agents.a1?.status).toBe('running')

    // The request ends: the row runs still, for the end of a request is not the end of the agent.
    await drive(clock, consuming)
    expect(seen).toHaveLength(2)
    expect((await readState($)).agents.a1?.status).toBe('running')
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

test('a step of a running agent, or of an unknown one, writes nothing to the agents value', SLOW_READER,
  async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.agent.spawn(SPAWN)
    const stepOf = async (agentId: string): Promise<void> => {
      await runStep($, clock, { turnId: 't1', index: 1, agentId })
      await clock.advance(10)
    }

    // a1 runs, and a9 is no row: their steps leave the version of the value where it was.
    const spawned = await agentsVersion($)
    await stepOf('a1')
    await stepOf('a9')
    expect(await agentsVersion($)).toBe(spawned)

    // Control: the version does move when a write lands. A closed row is written once when its agent steps again, and
    // not again while it runs.
    await $.turn.complete({
      answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer',
    })
    const closed = await agentsVersion($)
    expect(closed).toBeGreaterThan(spawned)
    await stepOf('a1')
    expect(await agentsVersion($)).toBe(closed + 1)
    await stepOf('a1')
    expect(await agentsVersion($)).toBe(closed + 1)
  })

test('the spawn and resume lines are masked and cut to 70, as a prompt is', SLOW_READER, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  bottom(on, clock)
  await $.session.start(START)
  await clock.advance(1)
  await $.turn.start({ text: 'go', turnId: 't1' })
  const secret = `ghp_${'a'.repeat(36)}`
  const long = 'x'.repeat(200)
  await $.agent.spawn({ ...SPAWN, description: `use ${secret}` })
  await $.agent.spawn({ ...SPAWN, description: long })
  for (const agentId of ['a1', 'a2']) {
    await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1', agentId, reason: 'answer' })
  }
  // A message wakes each of them.
  for (const agentId of ['a1', 'a2']) {
    await runStep($, clock, { turnId: 't1', index: 1, agentId })
    await clock.advance(10)
  }

  const { log } = await readState($)
  const lines = log.map(entry => entry.text).filter(text => /^(spawned|resumed) /.test(text))
  const cut = (verb: string): string => `${`${verb} · engineer: ${long}`.slice(0, 69)}…`
  // Newest first: the two resumes, then the two spawns. The secret is masked in both, the long text is cut to 70.
  expect(lines).toEqual([cut('resumed'), 'resumed · engineer: use •••', cut('spawned'), 'spawned · engineer: use •••'])
  expect([lines[0]?.length, lines[2]?.length]).toEqual([70, 70])
  expect(JSON.stringify(log)).not.toContain(secret)
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

    expect((await readState($)).log.map(entry => [entry.who, entry.text, entry.kind, entry.outcome])).toEqual([
      ['main', 'Agent → engineer: fail it', 'error', '✗ 0.0s'],
      ['main', 'Agent → engineer: deny it', 'error', 'denied'],
    ])
  })

test('a SendMessage to a subagent adds no line, any other one does, and a failed one is logged either way',
  SLOW_READER, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    await $.agent.spawn(SPAWN)
    const lines = async (): Promise<unknown[][]> =>
      (await readState($)).log.map(entry => [entry.who, entry.text, entry.kind, entry.outcome])
    const spawned = [['main', 'spawned · engineer: Fix cart total qty', 'info', undefined]]

    // To a subagent the panel has a row for, by its id: its own lines say it.
    await drive(clock, $.tool.call(sendTo('a1')))
    expect(await lines()).toEqual(spawned)

    // To anyone else: everybody, an id with no row, a name, a key that every object has, and not a name at all.
    for (const to of ['*', 'a9', 'researcher', 'constructor', 42]) await drive(clock, $.tool.call(sendTo(to)))
    expect(await lines()).toEqual([...Array(5).fill(['main', 'SendMessage', 'ok', '✓ 0.3s']), ...spawned])

    // A call to the subagent that failed or was denied says so.
    await $.tool.call(sendTo('a1', 'fail it'))
    await $.tool.call(sendTo('a1', 'deny it'))
    expect((await lines()).slice(0, 2)).toEqual([
      ['main', 'SendMessage', 'error', 'denied'],
      ['main', 'SendMessage', 'error', '✗ 0.0s'],
    ])
  })

test('a successful SubagentHandback adds no line to the log, a failed or denied one does', SLOW_READER,
  async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    await $.agent.spawn(SPAWN)
    const lines = async (): Promise<unknown[][]> =>
      (await readState($)).log.map(entry => [entry.who, entry.text, entry.kind, entry.outcome])
    const spawned = [['main', 'spawned · engineer: Fix cart total qty', 'info', undefined]]

    // In auto mode a subagent reports through this tool, and its `done` line says it: the call is no line of its own.
    await drive(clock, $.tool.call(handBack({ message: 'first finding' })))
    expect(await lines()).toEqual(spawned)

    // A hand-back that failed or was denied says so, under the type of the agent.
    await $.tool.call(handBack({ message: 'fail it' }))
    await $.tool.call(handBack({ message: 'deny it' }))
    expect((await lines()).slice(0, 2)).toEqual([
      ['engineer', 'SubagentHandback', 'error', 'denied'],
      ['engineer', 'SubagentHandback', 'error', '✗ 0.0s'],
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
    await runStep($, clock, { turnId: 't1', index: 1 }) // a turn with no response is not the last turn

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

// The timer asks for a read on every second tick, so a minute apart, and the read comes the delay after the tick, as
// the read after a call of a tool does. A file that changed outside Claude's tools shows without a new turn.
test('every second tick of the timer asks for a read of the project, and the first does not', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    await openTree($, clock, w)
    w.runs.length = 0
    w.status = ok(' M a.ts\0')
    w.diff = ok('2\t1\ta.ts\n')
    const start = 1_000_000

    await clock.advance(start + 30_000 - clock.now()) // the first tick
    expect(w.invalidated).toHaveLength(1)
    await clock.advance(5 * PROJECT_DELAY_MS) // far past the delay of a read: none was asked for
    expect(reads(w)).toBe(0)
    expect((await readState($)).project.changes).toBeNull()

    await clock.advance(start + 60_000 - 1 - clock.now())
    expect(reads(w)).toBe(0)
    await clock.advance(1) // the second tick asks for a read, which comes after the delay and not before
    expect(w.invalidated).toHaveLength(2)
    await clock.advance(PROJECT_DELAY_MS - 1)
    expect(reads(w)).toBe(0)
    await clock.advance(1)
    expect(w.runs).toEqual([BRANCH_RUN, STATUS_RUN, DIFF_RUN])
    expect((await readState($)).project.changes).toEqual({ files: 1, lines: { added: 2, removed: 1 } })

    // The third tick asks for nothing, the fourth does: one read a minute.
    await clock.advance(start + 90_000 + 5 * PROJECT_DELAY_MS - clock.now())
    expect(w.invalidated).toHaveLength(3)
    expect(reads(w)).toBe(1)
    await clock.advance(start + 120_000 + PROJECT_DELAY_MS - clock.now())
    expect(w.invalidated).toHaveLength(4)
    expect(reads(w)).toBe(2)
  })

// The tick dates its ask with the time of the clock, and the wait that it leaves is measured from that time: a write
// call inside the wait adds no read of its own.
test('a write call inside the wait that a tick left adds no read of its own', WITH_READER, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = bottom(on, clock)
  await $.session.start(START)
  await clock.advance(1)
  w.runs.length = 0

  await clock.advance(1_000_000 + 60_000 - clock.now()) // the second tick asks for a read, which is due 1000 ms later
  await clock.advance(100)
  await $.tool.call(instant()) // 100 ms into the wait: it adds nothing
  await clock.advance(5 * PROJECT_DELAY_MS)
  expect(reads(w)).toBe(1)
})

test('the read that a tick asks for waits four times as long as the last read took, when that is more than the delay',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    w.gitLag = 600 // a read is two calls, so it takes 1200 ms, and a delayed read waits 4800 ms after it
    await startTurn($)
    await clock.advance(1 + 2 * 600)
    w.runs.length = 0

    await clock.advance(1_000_000 + 60_000 - clock.now()) // the second tick
    expect(w.invalidated).toHaveLength(2)
    await clock.advance(4 * 2 * 600 - 1)
    expect(reads(w)).toBe(0)
    await clock.advance(1)
    expect(reads(w)).toBe(1)
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

// The end of a session after which the conversation starts over (a /clear, a resume): the panel is emptied of what
// belonged to the old one, and the next cost reading is a baseline.
const checkStartsOver = async ($: Engine, on: On, reason: 'clear' | 'resume'): Promise<void> => {
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

  expect(await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } })).toEqual({ sessionId: 's1' })
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
}

test('a /clear starts the panel over, and the next cost reading is a baseline', SLOW_READER,
  ($, on) => checkStartsOver($, on, 'clear'))

test('a resume starts the panel over as a /clear does: another conversation takes the place of this one', SLOW_READER,
  ($, on) => checkStartsOver($, on, 'resume'))

test('a /clear or a resume drops a message handed back and not read yet; any other end of the session keeps it',
  SLOW_READER, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    for (const [reason, shown] of [['other', 'done — first finding'], ['clear', 'done'], ['resume', 'done']] as const) {
      // The engine numbers the agents of a conversation from the first: `a1` is back in the next one.
      w.spawns = 0
      await $.agent.spawn(SPAWN)
      await drive(clock, $.tool.call(handBack({ message: 'first finding' })))
      await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } })
      w.spawns = 0
      await $.agent.spawn(SPAWN)
      await finish($, 'a1')

      expect((await readState($)).log[0]?.text, reason).toBe(shown)
    }
  })
