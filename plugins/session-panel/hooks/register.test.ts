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
// (`--ignore-submodules=dirty`). The first status has no `-u` flag, so that git follows the person's
// `status.showUntrackedFiles`; one that lists an untracked folder brings a second status, with `-uall`. A --no-index
// call has GIT_ATTR_SOURCE too: git's empty tree, so that no .gitattributes selects a filter that would run on the new
// file. The timeout of each call that reads the changes is CHANGES_TIMEOUT_MS, or what is left of READ_BUDGET_MS,
// counted from the start of the changes, when that is less. The branch is read with no GIT_READ and no options: it
// runs no filters, so it is read before the tree is open (the first turn of the main agent opens it).
const PROJECT_DELAY_MS = 1000
const PROJECT_GAP_FACTOR = 4
const READ_MS_MAX = 60_000 // the most that one read counts for in the gap rule, whatever the clock says it took
const CHANGES_TIMEOUT_MS = 10_000 // the most that one git call that reads the changes may run
const READ_BUDGET_MS = 30_000 // the most that the changes of one read may take in all, counted from the start of them
const READ_RETRY_MS = 15 * 60_000 // how long a root whose reads were stopped waits, from the read that stopped them
const GIT_READ = [
  'git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'diff.autoRefreshIndex=false',
]
const NO_LAZY_FETCH = { GIT_NO_LAZY_FETCH: '1' }
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const NO_INDEX_ENV = { ...NO_LAZY_FETCH, GIT_ATTR_SOURCE: EMPTY_TREE }
const BRANCH_RUN = { argv: ['git', 'branch', '--show-current'], init: { cwd: ROOT, timeoutMs: 5000 } }
const STATUS_RUN = {
  argv: [...GIT_READ, 'status', '--porcelain', '-z', '--ignore-submodules=dirty'],
  init: { cwd: ROOT, timeoutMs: 10_000, env: NO_LAZY_FETCH },
}
// The second status, which a first one that lists an untracked folder brings: the same, with `-uall`.
const STATUS_ALL_RUN = {
  argv: [...GIT_READ, 'status', '--porcelain', '-z', '-uall', '--ignore-submodules=dirty'],
  init: STATUS_RUN.init,
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
        logCount: (await $.state.get({ plugin: 'session-panel', key: 'logCount' } as const)).value,
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
// A plugin above the mod's that plays a suspend in the middle of a read, as the wall clock shows it: `arm-suspend`
// takes the sleep in ms, and from the next `git status` on the clock reads that much later, with no timer run
// meanwhile. The mock clock cannot show that by itself: it runs the timers through a slow read, as a machine that
// sleeps does not. Like any plugin of a test it closes over nothing of this file.
const SUSPENDER: Plugin = {
  name: 'suspender',
  tier: 'prepend',
  register(on) {
    let offset = 0
    let jump = 0
    on('command.run', { command: 'arm-suspend' }, async (_$, e) => {
      jump = Number(e.args)

      return { text: 'armed' }
    })
    on('clock.now', async (_$, e, next) => ({ value: ((await next(e)) as { value: number }).value + offset }))
    on('process.run', async (_$, e, next) => {
      if (jump > 0 && e.argv.includes('status')) {
        offset += jump
        jump = 0
      }

      return next(e)
    })
  },
}
// A plugin above the mod's that settles a call while the tool still runs: for a Bash whose command says `interrupt` it
// lets the chain run on, unawaited, and answers 100 ms later with an error of its own. The signal of the mod's hook
// aborts then, 100 ms into the call and with the tool running, where ABANDONER's aborts as the call starts. The kit
// cannot fire that signal by the person's interrupt (`$.turn.abort` cuts no running call in it), so a hook above that
// settles first is the one cause it can give. Like any plugin of a test it closes over nothing of this file.
const INTERRUPTER: Plugin = {
  name: 'interrupter',
  tier: 'prepend',
  register(on) {
    on('tool.call', async ($, e, next) => {
      if (e.tool !== 'Bash' || !e.command.includes('interrupt')) return next(e)
      next(e).catch(() => undefined)
      await $.clock.sleep(100)

      return { isError: true as const, result: 'cut', text: 'cut' }
    })
  },
}
// A plugin above the mod's whose clock reads a fraction of a ms more with every read, as a clock of a finer grain than
// a ms does: the host takes a whole number of ms as a timeout, so what is left of a budget must be rounded. Like any
// plugin of a test it closes over nothing of this file.
const FRACTIONAL_CLOCK: Plugin = {
  name: 'fractional-clock',
  tier: 'prepend',
  register(on) {
    let drift = 0
    on('clock.now', async (_$, e, next) => {
      drift += 0.25

      return { value: ((await next(e)) as { value: number }).value + drift }
    })
  },
}
// A plugin above the mod's that sets the wall clock back, or forward, as a person or a time service may: `skew-clock`
// takes the offset in ms (a negative one sets it back), and from then on `clock.now` reads that much off the mock
// clock's time, while the timers of the mock clock go on by their own. The mock clock itself only moves forward. Like
// any plugin of a test it closes over nothing of this file.
const CLOCK_SKEW: Plugin = {
  name: 'clock-skew',
  tier: 'prepend',
  register(on) {
    let offset = 0
    on('command.run', { command: 'skew-clock' }, async (_$, e) => {
      offset = Number(e.args)

      return { text: 'skewed' }
    })
    on('clock.now', async (_$, e, next) => ({ value: ((await next(e)) as { value: number }).value + offset }))
  },
}
// A plugin above the mod's that holds one write of the mod's values, as a host that is slow to answer may. `arm-hold`
// takes the options in JSON (`keys`: the values to watch, the log and its count when left out; `ms`: how long, 100 when
// left out; `skip`: how many such writes go through first, 0 when left out; `mode`: `after`, the default, lets the
// write land and answers the writer `ms` later, `before` holds the write itself, which lands after `ms`, and `refuse`
// fails it), and the first such write after that, the skipped ones apart, is the one it holds. The hook of the mod that
// made the write waits meanwhile, which is the time between its writes, so a /clear that comes then lands there. Like
// any plugin of a test it closes over nothing of this file.
const WRITE_HOLDER: Plugin = {
  name: 'write-holder',
  tier: 'prepend',
  register(on) {
    let armed: { keys: string[]; ms: number; skip: number; mode: string } | null = null
    on('command.run', { command: 'arm-hold' }, async (_$, e) => {
      const given = JSON.parse(e.args === '' ? '{}' : e.args)
      armed = { keys: ['log', 'logCount'], ms: 100, skip: 0, mode: 'after', ...given }

      return { text: 'armed' }
    })
    on('state.set', async ($, e, next) => {
      const hold = armed !== null && e.plugin === 'session-panel' && armed.keys.includes(e.key) ? armed : null
      if (hold === null) return next(e)
      if (hold.skip > 0) {
        hold.skip -= 1

        return next(e)
      }
      armed = null
      if (hold.mode === 'refuse') return { deny: 'refused' }
      if (hold.mode === 'before') await $.clock.sleep(hold.ms)
      const written = await next(e)
      if (hold.mode === 'after') await $.clock.sleep(hold.ms)

      return written
    })
  },
}
const WITH_ABANDONER = { plugins: [READER, ABANDONER], timeoutMs: 30_000 }
const WITH_INTERRUPTER = { plugins: [READER, INTERRUPTER], timeoutMs: 30_000 }
const WITH_FRACTIONAL_CLOCK = { plugins: [READER, FRACTIONAL_CLOCK], timeoutMs: 30_000 }
const WITH_STORE = { plugins: [READER, OTHER_SESSION], timeoutMs: 30_000 }
const WITH_WRITE_HOLDER = { plugins: [READER, WRITE_HOLDER], timeoutMs: 30_000 }
const WITH_CLOCK_SKEW = { plugins: [READER, CLOCK_SKEW], timeoutMs: 30_000 }
const WITH_SUSPENDER = { plugins: [SUSPENDER] }
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

// Arms WRITE_HOLDER for the next write of one of `keys` (the log or its count when none are given): see the plugin.
const armHold = (
  $: Engine, options: { keys?: string[]; ms?: number; skip?: number; mode?: 'after' | 'before' | 'refuse' } = {},
) => $.command.run({ ...RUN, command: 'arm-hold', args: JSON.stringify(options) })

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
  arePanesUnreadable: boolean // ui.panes() rejects
  placed: { isPlaced: true } | { isPlaced: false; reason: string }
  branch: string // what `git branch --show-current` prints
  gitExit: number // when it is not 0, the exit of every git call
  gitThrows: boolean // git cannot be started
  statusThrows: boolean // `git status` alone cannot be run to its end (it times out): its call rejects
  statusAllThrows: boolean // the same for the status with `-uall` alone: the first status is answered
  diffThrows: boolean // the same for `git diff` against HEAD alone
  status: GitAnswer // `git status --porcelain -z`, the first one, with no `-u` flag; a clean tree prints nothing
  statusAll: GitAnswer | undefined // the status with `-uall`, brought by a first one that lists a folder; else `status`
  diff: GitAnswer // `git diff --numstat HEAD`
  toplevel: GitAnswer // `git rev-parse --show-toplevel`
  noIndex: (path: string) => GitAnswer // `git diff --no-index` of a new file: exit 1, as git does when the files differ
  gitLag: number // how long each git call takes, in mock ms
  lags: Record<string, number> // how long a kind of git call takes besides: `status`, `diff`, `rev-parse`, `no-index`
  suspends: Record<string, number> // how far the wall clock jumps in a kind of git call, as when the machine sleeps
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

// What kind of call a git call is: its command, and `no-index` for the diff of a new file.
const gitKind = (argv: readonly string[]): string | undefined => {
  const command = gitCommand(argv)

  return command === 'diff' && argv.includes('--no-index') ? 'no-index' : command
}

// What git answers to a call, by the command it is: the short commit is the answer to any rev-parse but the top.
const gitAnswer = (w: World, argv: readonly string[]): GitAnswer => {
  const command = gitCommand(argv)
  if (command === 'branch') return ok(w.branch)
  if (command === 'status') return argv.includes('-uall') ? (w.statusAll ?? w.status) : w.status
  if (command === 'diff') return argv.includes('--no-index') ? w.noIndex(argv.at(-1) ?? '') : w.diff

  return argv.includes('--show-toplevel') ? w.toplevel : ok('abc1234\n')
}

// Whether a git call cannot be run to its end, as the flags of the world say: its call rejects.
const doesGitThrow = (w: World, argv: readonly string[]): boolean => {
  const kind = gitKind(argv)
  const isAll = argv.includes('-uall')

  return (
    w.gitThrows || (kind === 'status' && (w.statusThrows || (isAll && w.statusAllThrows))) ||
    (kind === 'diff' && w.diffThrows)
  )
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
    arePanesUnreadable: false,
    placed: { isPlaced: true },
    branch: 'master\n',
    gitExit: 0,
    gitThrows: false,
    statusThrows: false,
    statusAllThrows: false,
    diffThrows: false,
    status: ok(''),
    statusAll: undefined,
    diff: ok(''),
    toplevel: ok('/repo\n'),
    noIndex: path => ({ exitCode: 1, stdout: `1\t0\t/dev/null => ${path}\n` }),
    gitLag: 0,
    lags: {},
    suspends: {},
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
    const kind = gitKind(e.argv)
    const lag = w.gitLag + (kind === undefined ? 0 : (w.lags[kind] ?? 0))
    // As in the engine, a call that is still running at its timeout is killed, and rejects with `aborted: still running
    // after …ms`. A suspend is no slow call: the wall clock jumps while the call runs, the call itself stays short, and
    // it is not killed. The timers of the mock clock run through the jump, unlike through that of SUSPENDER.
    const timeoutMs = e.init?.timeoutMs ?? Number.POSITIVE_INFINITY
    const isKilled = lag > timeoutMs
    const jump = kind === undefined ? 0 : (w.suspends[kind] ?? 0)
    const lasts = (isKilled ? timeoutMs : lag) + jump
    if (lasts > 0) await clock.sleep(lasts)
    w.gitInFlight -= 1
    if (isKilled) throw new Error(`aborted: still running after ${timeoutMs}ms`)
    if (doesGitThrow(w, e.argv)) throw new Error('spawn git ENOENT')
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
  on('ui.panes', () => {
    if (w.arePanesUnreadable) throw new Error('the panes cannot be listed')

    return { value: w.panes }
  })
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
    { name: 'session-panel', description: 'Open the session stats pane', immediate: true },
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

test('a store that cannot be read at the start stops neither the timer, the project read nor the opening of the pane',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = bottom(on, clock, { collapsed: { log: true } }, true)
    w.isStoreUnreadable = true

    await $.session.start(START)
    await clock.advance(30_000)

    expect(w.opened).toEqual([{ id: 'session-panel', title: 'Session' }])
    expect(w.invalidated).toEqual(['ui.render']) // the timer is running
    const state = await readState($)
    expect(state.collapsed).toBeUndefined() // there was no map to load
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

// The timer asks for a read of the project only while the pane is shown, so a pane that opens asks for one itself.
test('a desktop that attaches opens the pane and asks for a read of the project; another surface asks for none',
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.surfaces = ['terminal']
    await $.session.start({ ...START, surface: 'terminal' })
    await clock.advance(1)
    w.runs.length = 0

    await $.session.attach({ surface: 'mobile', clientId: 'mobile:default' })
    await clock.advance(5 * PROJECT_DELAY_MS)
    expect(reads(w)).toBe(0)
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
    expect(reads(w)).toBe(0) // the hook asks and returns
    await clock.advance(1)
    expect(reads(w)).toBe(1)
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

test('the command opens a pane that is not open, with no focus, and says why when it is not placed', async ($, on) => {
  const w = bottom(on, mock.clock(on))
  const run = async (): Promise<string | undefined> =>
    (await $.command.run({ ...RUN, command: 'session-panel' })).text

  // The pane is not open, or another one is: it is opened, with no `focus`.
  expect(await run()).toBe('Session pane opened.')
  expect(w.opened).toEqual([{ id: 'session-panel', title: 'Session' }])
  w.panes = [{ ...PANE_UP, id: 'other' }]
  expect(await run()).toBe('Session pane opened.')
  expect(w.opened).toEqual([{ id: 'session-panel', title: 'Session' }, { id: 'session-panel', title: 'Session' }])

  w.panes = []
  w.placed = { isPlaced: false, reason: 'the terminal is too narrow' }
  expect(await run()).toBe('Session pane is not shown: the terminal is too narrow')
  expect(w.closed).toEqual([])
})

// A pane that is open, as the engine lists it in each of its states. The command closes none of them: `UiPane.isShown`
// only ranks plugin panes, so a lone pane counts as shown even where a built-in desktop tab such as Terminal covers it
// (the 0.4.0 live check), and the command cannot tell a pane in front from one that is hidden. The person asks for the
// pane, so it is opened again: the person's command places a pane that waits, and `focus` asks to bring a tab forward
// (a request, which the surface may refuse); as for any pane that opens, it asks for a read of the project. A pane that
// waits undrawn lists as not shown; one that listed as shown while it waited would be no different.
const OPEN_PANES: Array<[what: string, panes: UiPane[]]> = [
  ['placed and shown', [PANE_UP]],
  ['placed and shown, with another pane open beside it', [{ ...PANE_UP, id: 'other', isShown: false }, PANE_UP]],
  ['a tab behind another', [{ ...PANE_UP, isShown: false }]],
  ['waiting undrawn', [{ ...PANE_UP, isPlaced: false }]],
  ['waiting undrawn and listed as not shown', [{ ...PANE_UP, isPlaced: false, isShown: false }]],
]
for (const [what, panes] of OPEN_PANES) {
  test(`the command on a pane that is ${what} asks for it with focus, closes nothing and asks for a read`,
    async ($, on) => {
      const clock = mock.clock(on)
      const w = bottom(on, clock)
      w.panes = panes

      const ran = await $.command.run({ ...RUN, command: 'session-panel' })

      expect(ran.text).toBe('Session pane opened.')
      expect(w.opened).toEqual([{ id: 'session-panel', title: 'Session', focus: true }])
      expect(w.closed).toEqual([])
      expect(reads(w)).toBe(0) // the hook asks and returns
      await clock.advance(1)
      expect(reads(w)).toBe(1)
    })
}

test('the command on an open pane that the surface cannot place says why, and closes nothing', async ($, on) => {
  const w = bottom(on, mock.clock(on))
  w.panes = [PANE_UP]
  w.placed = { isPlaced: false, reason: 'the terminal is too narrow' }

  const ran = await $.command.run({ ...RUN, command: 'session-panel' })

  expect(ran.text).toBe('Session pane is not shown: the terminal is too narrow')
  expect(w.opened).toEqual([{ id: 'session-panel', title: 'Session', focus: true }])
  expect(w.closed).toEqual([])
})

// The timer asks for a read of the project only while the pane is shown, so a pane that opens asks for one itself; the
// command opens the pane whatever state it is in, so every run asks for one, and none closes anything.
test('every run of the command asks for a read of the project, one on a pane that is placed and shown too',
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    const run = () => $.command.run({ ...RUN, command: 'session-panel' })

    await run() // opens it
    expect(reads(w)).toBe(0) // the hook asks and returns
    await clock.advance(1)
    expect(reads(w)).toBe(1)

    w.panes = [PANE_UP]
    await run() // asks for it again, with focus
    expect(reads(w)).toBe(1) // the hook asks and returns
    await clock.advance(1)
    expect(reads(w)).toBe(2)
    expect(w.closed).toEqual([])
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
// the end of a main turn and the timer of the session, which asks every second tick while the pane is shown. While the
// tree is shut each one reads the branch and nothing else.
test('before the first turn of the main agent the tree is not read: no status, no diff, no new file counted',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.panes = [PANE_UP]
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

// The argv and the environment of every call, spelled out: a mistake in the shared constants above is caught here. The
// status has no `-u` flag: this one lists no untracked folder, so no second status follows.
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
    [...prefix, 'status', '--porcelain', '-z', '--ignore-submodules=dirty'],
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

// A top of the repository that exits with an error leaves the new files uncounted, and the lines of the diff stand as a
// lower bound: they are not unknown, as they are when the diff itself fails.
test('a top of the repository that exits with an error leaves the lines of the diff as a lower bound, and counts no '
  + 'new file', WITH_READER, async ($, on) => {
  const clock = mock.clock(on)
  const w = Object.assign(bottom(on, clock), {
    status: ok(' M a.ts\0?? n.ts\0'), diff: ok('3\t1\ta.ts\n'), toplevel: { exitCode: 128, stdout: '' },
  })

  await $.session.start(START)
  await clock.advance(1)
  await openTree($, clock, w)

  expect((await readState($)).project.changes).toEqual({
    files: 2, lines: { added: 3, removed: 1, hasMoreAdded: true },
  })
  expect(w.runs).toEqual([BRANCH_RUN, STATUS_RUN, DIFF_RUN, TOPLEVEL_RUN])
})

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

// git lists a nested repository as a folder whatever the status is asked for, so the first status brings the second,
// and that one lists it the same.
test('a nested repository is a changed file with no lines: no git call counts it', WITH_READER, async ($, on) => {
  const clock = mock.clock(on)
  const w = bottom(on, clock)
  w.status = ok('?? nested/\0')

  await $.session.start(START)
  await clock.advance(1)
  await openTree($, clock, w)

  expect((await readState($)).project.changes).toEqual({ files: 1, lines: { added: 0, removed: 0 } })
  expect(w.runs).toEqual([BRANCH_RUN, STATUS_RUN, STATUS_ALL_RUN, DIFF_RUN])
})

// The calls of git that read the tree, by the command they run: the statuses, and the diffs against HEAD.
const statusRuns = (w: World): number => w.runs.filter(run => gitCommand(run.argv) === 'status').length
const diffRuns = (w: World): number => w.runs.filter(run => gitKind(run.argv) === 'diff').length
// The timeout that a git call was run with.
const timeoutOf = (run: World['runs'][number]): unknown => (run.init as { timeoutMs?: number }).timeoutMs

// A read of the project asked for by a change of the folder, over by the time the clock has moved on 1 ms.
const askRead = async ($: Engine, clock: MockClock): Promise<void> => {
  await $.classic.CwdChanged({ old_cwd: ROOT, new_cwd: ROOT })
  await clock.advance(1)
}

// The same, asked so that the read starts at the time `at`: the clock goes to a ms short of it, and the read that the
// change of the folder asks for starts a ms later.
const askReadAt = async ($: Engine, clock: MockClock, at: number): Promise<void> => {
  await clock.set(at - 1)
  await askRead($, clock)
}

// Two reads in a row, for one root, that had a status that threw stop the reads of its changes for 15 minutes
// (READ_RETRY_MS): a huge tree (a dotfiles repository in $HOME) would spend the whole timeout on each read. The branch
// is still read. A diff against HEAD that throws counts as a status that does (see below), and the count is each
// root's own.
test('two status calls in a row that throw stop the changes reads for that root, until 15 minutes have passed',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.panes = [PANE_UP] // the timer asks while the pane is shown
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

// A root that was stopped is not given up for good: READ_RETRY_MS after the read whose throw stopped it, one read
// tries again. A throw in that read leaves the root waiting another READ_RETRY_MS, and a read that ends without one
// starts the count over, as it does at any time. The wait is the root's own, and it is measured on `$.clock.now()`, so
// a computer that wakes from sleep past it reads at its next read. `givenUpWorld` stops ROOT with the two reads of the
// test above (the status throws in each, and takes no time, so the wait starts at the time its last read began) and
// then lets the status work again; its changes are one modified file of 3 lines added and 1 removed.
const givenUpWorld = async (
  $: Engine, on: On, panes: UiPane[] = [],
): Promise<{ clock: MockClock; w: World; givenUpAt: number }> => {
  const clock = mock.clock(on)
  const w = bottom(on, clock)
  w.panes = panes // the timer asks while a pane is shown
  w.status = ok(' M a.ts\0')
  w.diff = ok('3\t1\ta.ts\n')
  await $.session.start(START)
  await clock.advance(1)
  w.statusThrows = true // the status times out, as in a tree that git cannot walk in 10 s
  await openTree($, clock, w)
  await askRead($, clock)
  expect(statusRuns(w)).toBe(2) // two throws in a row: the root is stopped
  w.statusThrows = false

  return { clock, w, givenUpAt: clock.now() }
}
const CHANGES_BACK = { files: 1, lines: { added: 3, removed: 1 } }

test('a root that was stopped is read again once 15 minutes have passed, and not a moment before', WITH_READER,
  async ($, on) => {
    const { clock, w, givenUpAt } = await givenUpWorld($, on)

    // A ms short of the 15 minutes: the branch alone, and no changes.
    w.runs.length = 0
    await askReadAt($, clock, givenUpAt + READ_RETRY_MS - 1)
    expect(w.runs).toEqual([BRANCH_RUN])
    expect((await readState($)).project.changes).toBeNull()

    // At 15 minutes one read runs, with its status and its diff, and the changes are back.
    w.runs.length = 0
    await askReadAt($, clock, givenUpAt + READ_RETRY_MS)
    expect(w.runs).toEqual([BRANCH_RUN, STATUS_RUN, DIFF_RUN])
    expect((await readState($)).project.changes).toEqual(CHANGES_BACK)
  })

test('a clock far past the wait, as when a computer wakes from sleep, has the root read at the next request',
  WITH_READER, async ($, on) => {
    const { clock, w, givenUpAt } = await givenUpWorld($, on)

    w.runs.length = 0
    await askReadAt($, clock, givenUpAt + 4 * READ_RETRY_MS)

    expect(w.runs).toEqual([BRANCH_RUN, STATUS_RUN, DIFF_RUN])
    expect((await readState($)).project.changes).toEqual(CHANGES_BACK)
  })

test('a read that throws when the root is tried again leaves it waiting another 15 minutes', WITH_READER,
  async ($, on) => {
    const { clock, w, givenUpAt } = await givenUpWorld($, on)

    // The try at 15 minutes throws as the first two did: the status runs, and the diff does not.
    w.statusThrows = true
    w.runs.length = 0
    await askReadAt($, clock, givenUpAt + READ_RETRY_MS)
    expect(w.runs).toEqual([BRANCH_RUN, STATUS_RUN])
    const triedAt = clock.now()
    w.statusThrows = false

    // The wait is 15 minutes from that try, and the count is still at its max: the branch alone, a ms short of it.
    w.runs.length = 0
    await askReadAt($, clock, triedAt + READ_RETRY_MS - 1)
    expect(w.runs).toEqual([BRANCH_RUN])
    expect((await readState($)).project.changes).toBeNull()

    // At it the next try runs, and now it works.
    w.runs.length = 0
    await askReadAt($, clock, triedAt + READ_RETRY_MS)
    expect(w.runs).toEqual([BRANCH_RUN, STATUS_RUN, DIFF_RUN])
    expect((await readState($)).project.changes).toEqual(CHANGES_BACK)
  })

test('a read that ends well when the root is tried again starts the count over: every request is read, a throw is one',
  WITH_READER, async ($, on) => {
    const { clock, w, givenUpAt } = await givenUpWorld($, on)

    await askReadAt($, clock, givenUpAt + READ_RETRY_MS) // the try, and it works
    expect(statusRuns(w)).toBe(3)

    // Every request is read now, none waits for 15 minutes.
    await askRead($, clock)
    await askRead($, clock)
    expect(statusRuns(w)).toBe(5)

    // One throw does not stop the root again, as at the start: the next request is read, and it works.
    w.statusThrows = true
    await askRead($, clock)
    w.statusThrows = false
    await askRead($, clock)
    expect(statusRuns(w)).toBe(7)
    expect((await readState($)).project.changes).toEqual(CHANGES_BACK)

    // Two in a row do, and the root waits for 15 minutes again.
    w.statusThrows = true
    await askRead($, clock)
    await askRead($, clock)
    expect(statusRuns(w)).toBe(9)
    const stoppedAt = clock.now()
    w.statusThrows = false
    w.runs.length = 0
    await askReadAt($, clock, stoppedAt + READ_RETRY_MS - 1)
    expect(w.runs).toEqual([BRANCH_RUN])
  })

test('each root has its own wait: the one stopped later is tried later, and a read of one does not shorten the other',
  WITH_READER, async ($, on) => {
    const { clock, w, givenUpAt } = await givenUpWorld($, on)
    const other = '/work/other_repo'
    const commands = (): Array<string | undefined> => w.runs.map(run => gitCommand(run.argv))

    // Another root is stopped five minutes later.
    w.root = other
    await clock.set(givenUpAt + 5 * 60_000)
    w.statusThrows = true
    await askRead($, clock)
    await askRead($, clock)
    const otherGivenUpAt = clock.now()
    w.statusThrows = false

    // ROOT is tried at its own time: its status runs. The other root, read just after, still waits.
    w.root = ROOT
    w.runs.length = 0
    await askReadAt($, clock, givenUpAt + READ_RETRY_MS)
    expect(w.runs).toEqual([BRANCH_RUN, STATUS_RUN, DIFF_RUN])
    w.root = other
    w.runs.length = 0
    await askRead($, clock)
    expect(commands()).toEqual(['branch'])

    // It is tried when its own 15 minutes are over.
    w.runs.length = 0
    await askReadAt($, clock, otherGivenUpAt + READ_RETRY_MS)
    expect(commands()).toEqual(['branch', 'status', 'diff'])
  })

// The minute read of a pane that is shown asks for a read of the project on its own; it is the one that finds the root
// ready again, with no other request.
test('the minute read of a shown pane tries a stopped root again after 15 minutes, with no other request',
  WITH_READER, async ($, on) => {
    const { clock, w, givenUpAt } = await givenUpWorld($, on, [PANE_UP])

    // The minute reads meanwhile read the branch, and no status.
    await clock.set(givenUpAt + READ_RETRY_MS - 1)
    expect(reads(w)).toBeGreaterThanOrEqual(10) // several were asked for, so this is no empty check
    expect(statusRuns(w)).toBe(2)
    expect((await readState($)).project.changes).toBeNull()

    // The next one after the 15 minutes runs the status, and the changes are back.
    await clock.advance(2 * 60_000)
    expect(statusRuns(w)).toBeGreaterThan(2)
    expect((await readState($)).project.changes).toEqual(CHANGES_BACK)
  })

// The wall clock may be set back after a wait began. A wait is READ_RETRY_MS long at most, so one that ends further
// ahead of the clock than that was made under a clock that has since gone back: it counts as over, and the root is
// read, instead of waiting until the clock catches up. A clock at the time the wait began is not set back, and the wait
// is the usual one. Here the clock is set back by 45 minutes after the root was stopped, and the read is made at the
// time that puts the clock at the start of the wait, a ms before it, or half an hour before it.
const SET_BACK_CLOCKS: Array<[what: string, ahead: number, isRead: boolean]> = [
  ['the time the wait began', 0, false],
  ['a ms before the wait began', -1, true],
  ['half an hour before the wait began', -30 * 60_000, true],
]
for (const [what, ahead, isRead] of SET_BACK_CLOCKS) {
  const result = isRead ? 'ends the wait of a stopped root: it is read' : 'leaves the wait as it is'
  test(`a clock set back to ${what} ${result}`, WITH_CLOCK_SKEW, async ($, on) => {
    const { clock, w, givenUpAt } = await givenUpWorld($, on)
    const setBack = 45 * 60_000
    await $.command.run({ ...RUN, command: 'skew-clock', args: String(-setBack) })

    w.runs.length = 0
    await askReadAt($, clock, givenUpAt + setBack + ahead) // the read starts when the clock reads givenUpAt + ahead
    expect(w.runs).toEqual(isRead ? [BRANCH_RUN, STATUS_RUN, DIFF_RUN] : [BRANCH_RUN])
    expect((await readState($)).project.changes).toEqual(isRead ? CHANGES_BACK : null)
  })
}

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

test('the reads of another root go on, and the root that was stopped stays stopped when another has been read',
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

    // Back to the first one: the read of the other has not cleared its count, so it is stopped still.
    w.root = ROOT
    w.runs.length = 0
    await askRead($, clock)
    expect(w.runs).toEqual([BRANCH_RUN])
    expect((await readState($)).project).toEqual({ name: 'online_shop', branch: 'master', changes: null })
  })

test('two roots read in turn keep their own counts: each is stopped by its own two throws, and not before', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    w.statusThrows = true
    await openTree($, clock, w) // ROOT: its first throw
    w.root = '/work/other_repo'
    await askRead($, clock) // another root: its first throw, and no reset of the count of ROOT
    w.root = ROOT
    await askRead($, clock) // ROOT again: its second throw, which stops it, though the read before was another root's
    expect(statusRuns(w)).toBe(3)
    await askRead($, clock) // ROOT is stopped: no status
    expect(statusRuns(w)).toBe(3)
    w.root = '/work/other_repo'
    await askRead($, clock) // the other root has thrown once: its second throw runs, and stops it
    expect(statusRuns(w)).toBe(4)
    await askRead($, clock)
    expect(statusRuns(w)).toBe(4)
    w.root = ROOT
    await askRead($, clock)
    expect(statusRuns(w)).toBe(4) // both stopped
    expect(reads(w)).toBe(7) // the branch is read all the same, for every read that was asked for
  })

// The status follows the person's `status.showUntrackedFiles`. The first one has no `-u` flag: `no` walks no untracked
// file and lists none, `normal` lists an untracked folder as one entry. Only a folder in that output brings a second
// status, with `-uall`, and the output of that one is the one used.
test('the first status has no -u flag, and no second status runs when it lists no untracked folder', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.status = ok(' M a.ts\0?? n.ts\0?? dir/o.ts\0') // a file in a folder is listed by its path: it is no folder entry
    w.diff = ok('3\t1\ta.ts\n')
    await $.session.start(START)
    await clock.advance(1)
    await openTree($, clock, w)

    const statuses = w.runs.filter(run => gitKind(run.argv) === 'status')
    expect(statuses.map(run => run.argv)).toEqual([STATUS_RUN.argv])
    expect(statuses.some(run => run.argv.some(arg => arg.startsWith('-u')))).toBe(false)
    expect(w.runs).toEqual([
      BRANCH_RUN, STATUS_RUN, DIFF_RUN, TOPLEVEL_RUN, noIndexRun('n.ts', '/repo'), noIndexRun('dir/o.ts', '/repo'),
    ])
    expect((await readState($)).project.changes).toEqual({ files: 3, lines: { added: 5, removed: 1 } })
  })

test('an untracked folder in the first output brings a second status with -uall, whose counts are used', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.status = ok(' M a.ts\0?? dir/\0') // as `normal` lists it: the folder is one entry
    w.statusAll = ok(' M a.ts\0?? dir/x.ts\0?? dir/y.ts\0') // as `-uall` lists it: the files in it
    w.diff = ok('3\t1\ta.ts\n')
    w.noIndex = path => ({ exitCode: 1, stdout: `4\t0\t/dev/null => ${path}\n` })
    await $.session.start(START)
    await clock.advance(1)
    await openTree($, clock, w)

    expect(w.runs).toEqual([
      BRANCH_RUN, STATUS_RUN, STATUS_ALL_RUN, DIFF_RUN, TOPLEVEL_RUN,
      noIndexRun('dir/x.ts', '/repo'), noIndexRun('dir/y.ts', '/repo'),
    ])
    // The files and the new files are those of the second status: the folder was one entry in the first.
    expect((await readState($)).project.changes).toEqual({ files: 3, lines: { added: 11, removed: 1 } })
  })

test('with only tracked changes listed, as `status.showUntrackedFiles` `no` leaves them, no untracked file is counted',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.status = ok(' M a.ts\0 M b.ts\0')
    w.diff = ok('3\t1\ta.ts\n')
    await $.session.start(START)
    await clock.advance(1)
    await openTree($, clock, w)

    // No second status, no top of the repository, no new file: nothing in the tree is walked for an untracked file.
    expect(w.runs).toEqual([BRANCH_RUN, STATUS_RUN, DIFF_RUN])
    expect((await readState($)).project.changes).toEqual({ files: 2, lines: { added: 3, removed: 1 } })
  })

// What a second status may end in: an error is a failure of the status, so the read has no changes and no diff; a cut
// output is a cut status, and it is the one used.
const SECOND_STATUSES: Array<[what: string, answer: GitAnswer, changes: Record<string, unknown> | null]> = [
  ['exits with an error', { exitCode: 128, stdout: ' M a.ts\0' }, null],
  [
    'is cut', { exitCode: 0, stdout: ' M a.ts\0?? dir/x.ts\0?? dir/y', isStdoutTruncated: true },
    { files: 2, hasMoreFiles: true, lines: null },
  ],
]
for (const [what, answer, changes] of SECOND_STATUSES) {
  const gives = changes === null ? 'no changes' : 'a lower bound'
  test(`a second status that ${what} is the status of the read: ${gives}, and no diff`,
    WITH_READER, async ($, on) => {
      const clock = mock.clock(on)
      const w = bottom(on, clock)
      w.status = ok(' M a.ts\0?? dir/\0')
      w.statusAll = answer
      await $.session.start(START)
      await clock.advance(1)
      await openTree($, clock, w)

      expect(w.runs).toEqual([BRANCH_RUN, STATUS_RUN, STATUS_ALL_RUN])
      expect((await readState($)).project.changes).toEqual(changes)
    })
}

test('a second status that throws counts for the stop as a first one does: two such reads in a row stop the root',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.status = ok(' M a.ts\0?? dir/\0')
    w.statusAllThrows = true
    await $.session.start(START)
    await clock.advance(1)
    await openTree($, clock, w)
    expect(statusRuns(w)).toBe(2) // the first is answered, and the second throws
    expect((await readState($)).project.changes).toBeNull()
    await askRead($, clock)
    expect(statusRuns(w)).toBe(4)

    w.statusAllThrows = false
    w.runs.length = 0
    await askRead($, clock) // the root is stopped: the branch alone
    expect(w.runs).toEqual([BRANCH_RUN])
  })

// A diff against HEAD that throws counts as a status that does, and the count is of reads: a status that is fine does
// not clear a diff that keeps timing out, so two such reads in a row stop the root, as two throws of the status do.
test('two reads in a row whose diff against HEAD throws stop the reads of that root, though each status is fine',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.status = ok(' M a.ts\0')
    await $.session.start(START)
    await clock.advance(1)
    w.diffThrows = true // the diff times out, as in a tree that git cannot compare with HEAD in 10 s
    await openTree($, clock, w)
    expect(diffRuns(w)).toBe(1)
    // The file is counted all the same, and its lines are not.
    expect((await readState($)).project.changes).toEqual({ files: 1, lines: null })
    await askRead($, clock)
    expect(statusRuns(w)).toBe(2)
    expect(diffRuns(w)).toBe(2) // two throws in a row

    // The third read reads the branch, and runs neither the status nor the diff, though both would be fine now.
    w.diffThrows = false
    w.diff = ok('3\t1\ta.ts\n')
    w.runs.length = 0
    await askRead($, clock)
    expect(w.runs).toEqual([BRANCH_RUN])
    expect((await readState($)).project).toEqual({ name: 'online_shop', branch: 'master', changes: null })
  })

test('a status that throws in one read and a diff that throws in the next are two throws in a row for the root',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.status = ok(' M a.ts\0')
    await $.session.start(START)
    await clock.advance(1)
    w.statusThrows = true
    await openTree($, clock, w) // the status throws
    w.statusThrows = false
    w.diffThrows = true
    await askRead($, clock) // the status is fine, and the diff throws
    expect([statusRuns(w), diffRuns(w)]).toEqual([2, 1])

    w.diffThrows = false
    w.runs.length = 0
    await askRead($, clock)
    expect(w.runs).toEqual([BRANCH_RUN])
  })

test('a read whose status and diff both end without a throw starts the count over: only two throws in a row stop',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.status = ok(' M a.ts\0')
    w.diff = ok('3\t1\ta.ts\n')
    await $.session.start(START)
    await clock.advance(1)
    w.diffThrows = true
    await openTree($, clock, w) // the diff throws
    w.diffThrows = false
    await askRead($, clock) // a status and a diff that end well: the count starts over
    expect((await readState($)).project.changes).toEqual({ files: 1, lines: { added: 3, removed: 1 } })
    w.diffThrows = true
    await askRead($, clock) // the diff throws
    w.diffThrows = false
    await askRead($, clock) // it is read, and ends well
    w.diffThrows = true
    await askRead($, clock) // the diff throws
    expect(statusRuns(w)).toBe(5)

    w.diffThrows = false
    await askRead($, clock) // one throw in a row so far: still read
    expect(statusRuns(w)).toBe(6)
    expect((await readState($)).project.changes).toEqual({ files: 1, lines: { added: 3, removed: 1 } })
  })

// Only a status and the diff against HEAD walk the tree: the count of a new file, or the top of the repository, that
// throws is a failure of that call alone, and no throw for the root.
test('a new file whose count throws is no throw for the root: the reads of the root go on', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.status = ok(' M a.ts\0?? n.ts\0')
    w.diff = ok('3\t1\ta.ts\n')
    w.noIndex = () => {
      throw new Error('spawn git ENOENT')
    }
    await $.session.start(START)
    await clock.advance(1)
    await openTree($, clock, w)
    await askRead($, clock)
    await askRead($, clock)

    expect(statusRuns(w)).toBe(3) // every read ran its status: none was stopped
    expect((await readState($)).project.changes).toEqual({
      files: 2, lines: { added: 3, removed: 1, hasMoreAdded: true },
    })
  })

// The calls of one read share READ_BUDGET_MS, counted from the start of its changes: each call has what is left of it
// when that is less than CHANGES_TIMEOUT_MS. The mock kills a call that takes longer than its timeout, as the engine
// does, and `lags` is how long a kind of call takes. A jump of the wall clock, as when the machine sleeps, is no slow
// call: `suspends` makes it in a kind of call, and the call is not killed for it.
test('a suspend in the status leaves the next call the rest of the budget as its timeout, and every call after it',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.status = ok(' M a.ts\0?? n.ts\0')
    w.diff = ok('3\t1\ta.ts\n')
    w.suspends = { status: 25_000 } // the clock is 25 s on when the status ends
    await $.session.start(START)
    await clock.advance(1)
    await openTree($, clock, w)
    await clock.advance(30_000)

    // The status had the whole budget, which its own timeout is under; the calls after it have what the suspend left.
    expect(w.runs.map(run => [gitKind(run.argv), timeoutOf(run)])).toEqual([
      ['branch', 5000],
      ['status', CHANGES_TIMEOUT_MS],
      ['diff', READ_BUDGET_MS - 25_000],
      ['rev-parse', READ_BUDGET_MS - 25_000],
      ['no-index', READ_BUDGET_MS - 25_000],
    ])
    expect((await readState($)).project.changes).toEqual({ files: 2, lines: { added: 4, removed: 1 } })
  })

// The host takes a whole number of ms as a timeout, and refuses any other: a clock that reads a fraction of a ms leaves
// a fraction of the budget, which is rounded up, so every call of the read is made and has a whole timeout. A call has
// its own timeout until less than that is left, so a suspend in the status leaves the calls after it the rest of it.
test('a clock that reads a fraction of a ms still gives each call a whole number of ms as its timeout',
  WITH_FRACTIONAL_CLOCK, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.status = ok(' M a.ts\0?? n.ts\0')
    w.diff = ok('3\t1\ta.ts\n')
    w.suspends = { status: 25_000 }
    await $.session.start(START)
    await clock.advance(1)
    await openTree($, clock, w)
    await clock.advance(30_000)

    expect(w.runs.map(run => gitKind(run.argv))).toEqual(['branch', 'status', 'diff', 'rev-parse', 'no-index'])
    expect(w.runs.every(run => Number.isInteger(timeoutOf(run)))).toBe(true)
    expect(w.runs.map(run => timeoutOf(run))[2]).toBe(5000) // a fraction under 5000 ms are left: rounded up
    expect((await readState($)).project.changes).toEqual({ files: 2, lines: { added: 4, removed: 1 } })
  })

// The timeouts of a status, a diff, the top of the repository and a count of one new file, by how long the status and
// the diff took: the timeout of a call is CHANGES_TIMEOUT_MS until less than that is left. A status or a diff takes its
// timeout at most, so the last two get less only after a suspend, where the wall clock jumps in a call.
const BUDGET_TIMEOUTS: Array<[what: string, world: Partial<World>, timeouts: number[]]> = [
  ['after a status and a diff that took no time', {}, [10_000, 10_000, 10_000, 10_000]],
  [
    'after a status and a diff that took 5 s each', { lags: { status: 5000, diff: 5000 } },
    [10_000, 10_000, 10_000, 10_000], // 20 s are left for the last two
  ],
  [
    'after a suspend of 12 s in the status and in the diff', { suspends: { status: 12_000, diff: 12_000 } },
    [10_000, 10_000, 6000, 6000], // 6 s are left after them
  ],
  [
    'after a suspend of 20 s in the status and a diff that took 9 s',
    { suspends: { status: 20_000 }, lags: { diff: 9000 } }, [10_000, 10_000, 1000, 1000],
  ],
]
for (const [what, world, timeouts] of BUDGET_TIMEOUTS) {
  test(`${what}, the four calls have the timeouts ${timeouts.join(', ')} ms`,
    WITH_READER, async ($, on) => {
      const clock = mock.clock(on)
      const w = bottom(on, clock)
      w.status = ok(' M a.ts\0?? n.ts\0')
      w.diff = ok('3\t1\ta.ts\n')
      Object.assign(w, world)
      await $.session.start(START)
      await clock.advance(1)
      await openTree($, clock, w)
      await clock.advance(60_000)

      expect(w.runs.slice(1).map(run => timeoutOf(run))).toEqual(timeouts)
    })
}

// Where the budget of a read runs out, the calls that were made, and what the read gives: the next call is not made,
// and the read ends as that call's failure would. The status lists a modified file and five new files of one line each,
// the diff has 3 lines added and 1 removed; a folder in the status brings the second status. A call takes its timeout
// at most, so the budget runs out in one call only through a suspend; otherwise it takes the calls of several.
const NEW_FILES = ['n1.ts', 'n2.ts', 'n3.ts', 'n4.ts', 'n5.ts']
const WITH_NEW_FILES: Partial<World> = {
  status: ok(` M a.ts\0${NEW_FILES.map(name => `?? ${name}\0`).join('')}`), diff: ok('3\t1\ta.ts\n'),
}
const WITH_A_FOLDER: Partial<World> = { status: ok(' M a.ts\0?? dir/\0') }
const LOWER_BOUND = { files: 6, lines: { added: 3, removed: 1, hasMoreAdded: true } }
const BUDGET_ENDS: Array<[
  what: string, world: Partial<World>, kinds: string[], changes: Record<string, unknown> | null,
]> = [
  [
    'by a suspend in the first status, so no second status is run',
    { ...WITH_A_FOLDER, suspends: { status: 30_000 } }, ['status'], null,
  ],
  [
    'by a suspend in each status, so no diff is run',
    { ...WITH_A_FOLDER, suspends: { status: 15_000 } }, ['status', 'status'], { files: 2, lines: null },
  ],
  [
    'by a suspend in the status and the diff, so the top of the repository is not asked for',
    { ...WITH_NEW_FILES, suspends: { status: 15_000, diff: 15_000 } }, ['status', 'diff'], LOWER_BOUND,
  ],
  [
    'after the top of the repository, so no new file is counted',
    { ...WITH_NEW_FILES, lags: { status: 10_000, diff: 10_000, 'rev-parse': 10_000 } },
    ['status', 'diff', 'rev-parse'], LOWER_BOUND,
  ],
  [
    'in the loop over the new files, after the third',
    { ...WITH_NEW_FILES, lags: { 'no-index': 10_000 } },
    ['status', 'diff', 'rev-parse', 'no-index', 'no-index', 'no-index'],
    { files: 6, lines: { added: 6, removed: 1, hasMoreAdded: true } },
  ],
]
for (const [what, world, kinds, changes] of BUDGET_ENDS) {
  test(`a read whose budget is spent ${what}`, WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = Object.assign(bottom(on, clock), world)
    await $.session.start(START)
    await clock.advance(1)
    await openTree($, clock, w)
    await clock.advance(120_000)

    expect(w.runs.slice(1).map(run => gitKind(run.argv))).toEqual(kinds) // the branch is the first call
    expect((await readState($)).project.changes).toEqual(changes)
  })
}

// What real use gives, where no call outlasts its timeout: a status and a diff of 9 s each (the top of the repository
// takes no time), then new files of 5 s each. The first is counted in 5 s of the 12 s left, the second in 5 s of the
// 7 s left, and the third has 2 s: it is killed at them, its count is lost, and the lines before it stand as a lower
// bound.
test('new files of 5 s each, after a status and a diff of 9 s: the third has the 2 s left, is killed, and the plus is '
  + 'a lower bound', WITH_READER, async ($, on) => {
  const clock = mock.clock(on)
  const w = Object.assign(bottom(on, clock), WITH_NEW_FILES, { lags: { status: 9000, diff: 9000, 'no-index': 5000 } })
  await $.session.start(START)
  await clock.advance(1)
  await openTree($, clock, w)
  await clock.advance(60_000)

  expect(w.runs.slice(1).map(run => [gitKind(run.argv), timeoutOf(run)])).toEqual([
    ['status', 10_000], ['diff', 10_000], ['rev-parse', 10_000],
    ['no-index', 10_000], ['no-index', 7000], ['no-index', 2000],
  ])
  // The diff has 3 lines added, and the two counts that ended have one each.
  expect((await readState($)).project.changes).toEqual({
    files: 6, lines: { added: 5, removed: 1, hasMoreAdded: true },
  })
})

// The top of the repository that the budget kills: two statuses and a diff of 9 s each leave it 3 s, and it would take
// 5. The call was made and failed, yet the lines of the diff stand.
test('a top of the repository that the 3 s left of the budget kill leaves the lines of the diff as a lower bound',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.status = ok(' M a.ts\0?? dir/\0')
    w.statusAll = ok(' M a.ts\0?? dir/x.ts\0?? dir/y.ts\0')
    w.diff = ok('3\t1\ta.ts\n')
    w.lags = { status: 9000, diff: 9000, 'rev-parse': 5000 }
    await $.session.start(START)
    await clock.advance(1)
    await openTree($, clock, w)
    await clock.advance(60_000)

    expect(w.runs.slice(1).map(run => [gitKind(run.argv), timeoutOf(run)])).toEqual([
      ['status', 10_000], ['status', 10_000], ['diff', 10_000], ['rev-parse', 3000], // no new file is counted
    ])
    expect((await readState($)).project.changes).toEqual({
      files: 3, lines: { added: 3, removed: 1, hasMoreAdded: true },
    })
  })

// A call that is not made is no throw: it ran out of the clock, not of its timeout. Here a suspend in each status puts
// the clock a whole budget on when it ends, so the diff is never made, and no read counts a throw.
test('a call that was not made, for the budget was spent, is no throw: the reads of the root are not stopped',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.status = ok(' M a.ts\0')
    w.suspends = { status: READ_BUDGET_MS }
    await $.session.start(START)
    await clock.advance(1)
    await startTurn($)
    await clock.advance(2 * READ_BUDGET_MS)
    for (let i = 0; i < 2; i += 1) {
      await $.classic.CwdChanged({ old_cwd: ROOT, new_cwd: ROOT })
      await clock.advance(2 * READ_BUDGET_MS)
    }

    expect(statusRuns(w)).toBe(3) // the third read ran its status: the root was never stopped
    expect(diffRuns(w)).toBe(0)
    expect((await readState($)).project.changes).toEqual({ files: 1, lines: null })
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

// A read that spans a suspend or a clock jump takes hours by the clock; it counts for READ_MS_MAX, and a delayed read
// then waits four times that. The wait it set must not outlive the fast reads that come after it: a wait counts for
// twice the shorter of its own delay and the delay a new call would get. Here the read of the first turn takes an
// hour, so the first call asks for four minutes; the end of a turn reads at once, in 600 ms, so a new call would get
// 2400 ms, and the window is 4800 ms from the call that asked. A call inside it adds nothing, one at its edge asks
// again: the read comes 7200 ms after the first call, not four minutes.
test('a wait set after a read of an hour does not outlive the fast read that follows it', TICKING_READER,
  async ($, on) => {
    const HOUR = 3_600_000
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    // The session does not start: its timer would ask for a read every minute of that hour, with the pane shown, and
    // each ask would mark the read under way stale. The attach arms the timer of TICKER, so that the clock moves
    // fast.
    await $.session.attach({ surface: 'terminal', clientId: 'terminal:default' })
    w.rootLag = HOUR // the read that the first turn asks for takes an hour: a suspend in the middle of it
    await startTurn($)
    await clock.advance(1 + HOUR)
    w.rootLag = 0
    w.runs.length = 0

    await $.tool.call(instant()) // asks, with a delay of four minutes
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

// A read that is in flight when the machine sleeps is timed by the wall clock, which counts the whole sleep: here an
// hour. The gap rule counts it for READ_MS_MAX at most, so the minute read waits four minutes after it, not four hours,
// and the minutes after that are read as before. The mock clock cannot show it alone, so SUSPENDER makes the jump.
test('a read that spans a suspend stops the minute read for four minutes, not for four times the sleep',
  WITH_SUSPENDER, async ($, on) => {
    const HOUR = 3_600_000
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = bottom(on, clock)
    w.panes = [PANE_UP]
    w.status = ok(' M a.ts\0')
    w.diff = ok('2\t1\ta.ts\n')
    const start = 1_000_000
    await $.session.start(START)
    await clock.advance(1)
    await openTree($, clock, w)
    w.runs.length = 0
    await $.command.run({ ...RUN, command: 'arm-suspend', args: String(HOUR) })

    // The second tick asks for a read, and the status of that read runs across the hour.
    await clock.advance(start + 60_000 + PROJECT_DELAY_MS - clock.now())
    expect(reads(w)).toBe(1)
    // The fourth tick asks again: the read waits four times what the hour counts for.
    await clock.advance(start + 120_000 + PROJECT_GAP_FACTOR * READ_MS_MAX - 1 - clock.now())
    expect(reads(w)).toBe(1)
    await clock.advance(1)
    expect(reads(w)).toBe(2)
    // After that, a read a minute again. The tick that falls on the end of the wait may ask for a read of its own, so
    // the count is taken from a point past it.
    await clock.advance(2 * PROJECT_DELAY_MS)
    const settled = reads(w)
    await clock.advance(60_000 - PROJECT_DELAY_MS)
    expect(reads(w)).toBe(settled + 1)
    await clock.advance(60_000)
    expect(reads(w)).toBe(settled + 2)
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
      elapsedMs: 2000, modelMs: 1700, toolMs: 300, steps: 2, ttftMs: 250, tokensIn: 100, tokensOut: 800, cachePct: 90,
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

// U+202E, the right-to-left override, reorders what follows it; U+200B is a zero-width space; U+200D is the zero-width
// joiner. They are spelled as escapes, so that this file shows what it says.
const BIDI = '\u202E'
const ZWSP = '\u200B'
const ZWJ = '\u200D'

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

test('a joiner beside an ASCII character is taken out of the branch and the folder name: it hides nothing',
  WITH_READER, async ($, on) => {
    const clock = mock.clock(on)
    const w = bottom(on, clock)
    w.branch = `ma${ZWJ}in\n`
    w.root = `/work/onli${ZWJ}ne_shop`

    await $.session.start(START)
    await clock.advance(1)

    expect((await readState($)).project).toEqual({ name: 'online_shop', branch: 'main', changes: null })
  })

test('the format characters are taken out of the names of the MCP servers, before the hidden ones are matched',
  WITH_READER, async ($, on) => {
    // The U+202E is in the name of the person's server; the U+200B and the joiner are in the prefixes of `ccd_x` and
    // `ccd_y`, servers of the app.
    const servers = [`issue${BIDI}-hub`, `cc${ZWSP}d_x`, `cc${ZWJ}d_y`, 'codebase-memory']

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

// The zero-width joiner (U+200D) is a format character too, but between two non-ASCII characters that are no spaces it
// holds an emoji sequence together, so it stays there: a family is three emoji and two joiners, and it is one emoji in
// the log. Every other format character goes, and so does a joiner beside an ASCII character or a space (stripFormat):
// it joins nothing there.
const FAMILY = `\u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}` // man, woman and girl

test('an emoji sequence stays whole in the line of a prompt; a format character beside it goes, and a joiner by ASCII',
  WITH_READER, async ($, on) => {
    bottom(on, mock.clock(on))
    await $.session.start(START)

    await $.turn.start({ text: `${FAMILY} sleep 30`, turnId: 't1' })
    await $.turn.start({ text: `${BIDI}${FAMILY}${ZWSP} run \uFEFFit`, turnId: 't2' })
    await $.turn.start({ text: `ship${ZWJ}\u{1F680} ${ZWJ}it`, turnId: 't3' })

    const { log } = await readState($)
    expect(log.map(entry => entry.text)).toEqual(['ship\u{1F680} it', `${FAMILY} run it`, `${FAMILY} sleep 30`])
    expect(log[2]?.text.split(ZWJ)).toHaveLength(3) // both joiners are in the line
    expect(log[0]?.text).not.toContain(ZWJ)
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

test('a secret that has a joiner in it is masked too: beside an ASCII character the joiner goes before the patterns',
  SLOW_READER, async ($, on) => {
    const clock = mock.clock(on)
    bottom(on, clock)
    await $.session.start(START)

    await drive(clock, $.tool.call({ tool: 'Bash', command: `echo ghp_abc${ZWJ}defgh12345678` }))
    await $.turn.start({ text: `token${ZWJ}=hunter22secret`, turnId: 't1' })

    const { log } = await readState($)
    expect(log.map(entry => entry.text)).toEqual(['token=•••', 'Bash echo •••'])
    expect(JSON.stringify(log)).not.toContain('abcdefgh')
    expect(JSON.stringify(log)).not.toContain('hunter22secret')
    expect(JSON.stringify(log)).not.toContain(ZWJ)
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

// The signal of the hook aborts while the tool runs, before `next(e)` returns, and the call comes back as an error: the
// hook above answers 100 ms in, and the tool (a failing Bash) ends 300 ms in. The line comes when the call ends, a note
// with the time of the whole call and no mark. The test above has the signal abort as the call starts.
test('a call whose signal aborts while the tool runs, and that comes back as an error, is a note with no mark',
  WITH_INTERRUPTER, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = bottom(on, clock)
    w.toolFailMs = 300
    await $.session.start(START)
    await clock.advance(1)
    // The log has no value until the first line is written.
    const lines = async (): Promise<unknown[][]> =>
      ((await readState($)).log ?? []).map(entry => [entry.text, entry.kind, entry.outcome])

    const call = $.tool.call({ tool: 'Bash', command: 'fail interrupt it' })
    await clock.advance(150) // the hook above has answered, and the tool runs still: nothing is logged yet
    expect(await lines()).toEqual([])
    await clock.advance(250) // the tool ends, 300 ms after it began, and the hook of the mod logs it
    expect(await call).toEqual({ isError: true, result: 'cut', text: 'cut' })
    expect(await lines()).toEqual([['Bash fail interrupt it', 'info', '0.3s']])
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

// ` **x**y` repeated is a text that no pair of `**` closes: a word character follows each `**`, so every opening one
// reads on to the end of the line, and the pair pattern of plainText takes seconds on 224 KB of it. Only the head of an
// answer is worked on, and an answer is the subagent's.
test('an answer of 224 KB is cut to its head: the line of a subagent comes at once and is the head\'s own line',
  SLOW_READER, async ($, on) => {
    bottom(on, mock.clock(on))
    await $.session.start(START)
    await $.agent.spawn(SPAWN)
    await $.agent.spawn(SPAWN)
    const end = (agentId: string, answer: string) =>
      $.turn.complete({ answer, durationMs: 5, isAborted: false, turnId: 't1', agentId, reason: 'answer' })

    const answer = ' **x**y'.repeat(32_768) // 229,376 units, 224 KB
    const started = performance.now()
    await end('a1', answer)
    const took = performance.now() - started
    await end('a2', answer.slice(0, 4096))

    const line = `done — ${'**x**y '.repeat(11)}**…`
    expect((await readState($)).log.slice(0, 2).map(entry => entry.text)).toEqual([line, line])
    expect(took).toBeLessThan(1000) // generous: the pair pattern took seconds on it
  })

// The head is cut at whitespace: a cut through a secret would leave a half of it that no pattern of redact matches.
// Here the 4096th unit is the last one before the `@` of a URL with a password, so a head cut there would hold the
// whole password and no `@` for the pattern of the URL to end on.
test('a secret that the cut of an answer would go through is dropped with its word, not shown unmasked', WITH_READER,
  async ($, on) => {
    bottom(on, mock.clock(on))
    await $.session.start(START)
    await $.agent.spawn(SPAWN)

    const url = 'https://deploy:Hunter2-Full-Secret@db.example.com/prod'
    const answer = `${'\n'.repeat(4096 - url.indexOf('@'))}${url}`
    await $.turn.complete({ answer, durationMs: 5, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer' })

    const { log } = await readState($)
    expect(JSON.stringify(log)).not.toContain('Hunter2')
    expect(log[0]?.text).toBe('done')
  })

// `a.` repeated is a text that the URL pattern of redact reads in quadratic time: each `a` after a `.` starts what
// could be a scheme, which runs to the end of the text and finds no `:` there, and 128 KB of it took 5.5 s in Node 22.
// The command of a Bash call is the agent's own, and the hook of tool.call stands in the way of every tool call.
test('a Bash command of 128 KB is cut to its head: the hook returns at once and the line is the head\'s own line',
  SLOW_READER, async ($, on) => {
    const clock = mock.clock(on)
    bottom(on, clock)
    await $.session.start(START)

    const started = performance.now()
    await drive(clock, $.tool.call({ tool: 'Bash', command: 'a.'.repeat(65_536) })) // 131,072 units, 128 KB
    const took = performance.now() - started

    expect(took).toBeLessThan(300) // generous: the URL pattern took seconds on it
    // The head has no whitespace after `Bash `, so the word that the cut goes through is the whole command.
    expect((await readState($)).log.map(entry => entry.text)).toEqual(['Bash'])
  })

test('a prompt of 128 KB is cut to its head: the hook returns at once', SLOW_READER, async ($, on) => {
  bottom(on, mock.clock(on))
  await $.session.start(START)

  const started = performance.now()
  await $.turn.start({ text: 'a.'.repeat(65_536), turnId: 't1' }) // 131,072 units, 128 KB
  const took = performance.now() - started

  expect(took).toBeLessThan(300) // generous: the URL pattern took seconds on it
  // The head has no whitespace, so none of it is a whole word: the line is empty.
  expect((await readState($)).log.map(entry => [entry.who, entry.text])).toEqual([['you', '']])
})

test('a subagent description of 128 KB is cut to its head: the hook returns at once', SLOW_READER, async ($, on) => {
  bottom(on, mock.clock(on))
  await $.session.start(START)

  const started = performance.now()
  await $.agent.spawn({ ...SPAWN, description: 'a.'.repeat(65_536) }) // 131,072 units, 128 KB
  const took = performance.now() - started

  expect(took).toBeLessThan(300) // generous: the URL pattern took seconds on it
  // The head has no whitespace after `spawned · engineer: `, so the word that the cut goes through is the whole
  // description: the line is the spawn line with no description.
  expect((await readState($)).log.map(entry => entry.text)).toEqual(['spawned · engineer:'])
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

// A format character beside a mark hides it from the pass that takes the marks out, so the format characters go first:
// here a byte order mark (U+FEFF) after the opening `**`.
test('a format character beside a markdown mark in the answer of a subagent does not keep the mark', WITH_READER,
  async ($, on) => {
    bottom(on, mock.clock(on))
    await $.session.start(START)
    await $.agent.spawn(SPAWN)

    const answer = '**\uFEFFVerdict:** ok'
    await $.turn.complete({ answer, durationMs: 5, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer' })

    expect((await readState($)).log[0]?.text).toBe('done — Verdict: ok')
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

// While the pane is shown the timer asks for a read on every second tick, so a minute apart, and the read comes the
// delay after the tick, as the read after a call of a tool does. A file that changed outside Claude's tools shows
// without a new turn.
test('every second tick of the timer asks for a read of the project, and the first does not', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = bottom(on, clock)
    w.panes = [PANE_UP]
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
  w.panes = [PANE_UP] // without it the tick asks for nothing, and the one read is the call's own
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
    w.panes = [PANE_UP]
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

// The timer asks only for a pane in front, open, placed and shown: a closed pane has no one to show the count to, an
// open one that waits undrawn has none yet, and one that is a tab behind another is not looked at. The rest of the
// tick, the redraw and the usage, does not depend on it.
const TICK_PANES: Array<[what: string, panes: UiPane[], isRead: boolean]> = [
  ['is closed', [], false],
  ['is open but not placed', [{ ...PANE_UP, isPlaced: false }], false],
  ['is open and placed but not shown, a tab behind another', [{ ...PANE_UP, isShown: false }], false],
  [
    'is a tab behind another, which is shown', [{ ...PANE_UP, isShown: false }, { ...PANE_UP, id: 'other' }], false,
  ],
  ['is closed and another one is open', [{ ...PANE_UP, id: 'other' }], false],
  ['is open, placed and shown', [PANE_UP], true],
  ['is open, placed and shown, with a tab behind it', [{ ...PANE_UP, id: 'other', isShown: false }, PANE_UP], true],
]
for (const [what, panes, isRead] of TICK_PANES) {
  test(`the second tick asks for ${isRead ? 'a' : 'no'} read of the project when the pane ${what}`, WITH_READER,
    async ($, on) => {
      const clock = mock.clock(on, { now: 1_000_000 })
      const w = bottom(on, clock)
      w.panes = panes
      await $.session.start(START)
      await clock.advance(1)
      await openTree($, clock, w)
      w.runs.length = 0

      await clock.advance(1_000_000 + 60_000 + 5 * PROJECT_DELAY_MS - clock.now()) // the second tick, and its delay
      expect(reads(w)).toBe(isRead ? 1 : 0)
      expect(w.invalidated).toHaveLength(2)
      expect(w.breakdowns).toBe(2)
    })
}

test('a list of panes that cannot be read asks for no read, and the rest of the tick goes on', WITH_READER,
  async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const w = bottom(on, clock)
    w.panes = [PANE_UP]
    w.arePanesUnreadable = true
    await $.session.start(START)
    await clock.advance(1)
    await openTree($, clock, w)
    w.runs.length = 0

    await clock.advance(1_000_000 + 60_000 + 5 * PROJECT_DELAY_MS - clock.now()) // the second tick, and its delay
    expect(reads(w)).toBe(0)
    expect(w.invalidated).toHaveLength(2)
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

// The count of every line put on the log, which the log's 60 lines do not hold once there are more.
test('every path that puts a line on the log adds one to its count', SLOW_READER, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  bottom(on, clock)
  await $.session.start(START)
  await clock.advance(1)

  const paths: [name: string, run: () => Promise<unknown>][] = [
    ['a prompt', () => $.turn.start({ text: 'fix it', turnId: 't1' })],
    ['a call of a tool', () => drive(clock, $.tool.call(readCall()))],
    ['the start of a subagent', () => $.agent.spawn(SPAWN)],
    ['the end of a subagent', () => finish($, 'a1')],
    ['a message that wakes the subagent', () => runStep($, clock, { turnId: 't1', index: 1, agentId: 'a1' })],
    ['a compaction', () => $.session.compact({ trigger: 'manual', messages: MESSAGES })],
  ]
  let expected = 0
  for (const [name, run] of paths) {
    await run()
    await clock.advance(10) // the line of a woken subagent is written a tick later, off the request
    expected += 1
    expect((await readState($)).logCount, name).toBe(expected)
  }
  expect((await readState($)).log).toHaveLength(expected)
})

test('after 65 events the log holds 60 lines and the count says 65', SLOW_READER, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  bottom(on, clock)
  await $.session.start(START)
  await clock.advance(1)

  for (let i = 1; i <= 65; i += 1) await $.turn.start({ text: `prompt ${i}`, turnId: `t${i}` })

  const state = await readState($)
  expect(state.log).toHaveLength(60)
  expect(state.logCount).toBe(65)
})

// A hot reload raises session.start again, for the mod alone, and the values of `$.state` stay: the count goes on.
test('a second session.start, which a hot reload raises, keeps the count and the log', SLOW_READER, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  bottom(on, clock)
  await $.session.start(START)
  await clock.advance(1)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn(SPAWN)
  const before = await readState($)
  expect(before.logCount).toBe(2)

  await $.session.start(START)
  await clock.advance(1)
  const after = await readState($)
  expect([after.logCount, after.log]).toEqual([2, before.log])

  await $.turn.start({ text: 'again', turnId: 't2' })
  expect((await readState($)).logCount).toBe(3)
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
  expect(before.logCount).toBe(before.log.length)
  expect(before.usage).toMatchObject({ contextTokens: 90_000, contextPct: 9 })

  // Any other end of the session leaves the panel as it is.
  expect(await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } })).toEqual({ sessionId: 's1' })
  expect(await readState($)).toEqual(before)

  expect(await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } })).toEqual({ sessionId: 's1' })
  const after = await readState($)
  expect([after.turn, after.lastTurn, after.agents, after.log, after.logCount]).toEqual([null, null, {}, [], 0])
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

// The two writes of a log line, the line and its count, are two steps, and the pane may be drawn between them. The line
// goes first. The header's total is `max(logCount, lines held)` and the pane says `+N more` for what the lines do not
// show, so a count written first would stand one above the lines for that moment: a `+1 more` that flashes on every
// event of the first 60 of a conversation. The holder lets the first write of the second line land and stops the hook
// there, and the pane is drawn in the gap.
test('between the two writes of a log line the pane draws no +N more', WITH_WRITE_HOLDER, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  bottom(on, clock)
  await $.session.start(START)
  await clock.advance(1)
  await $.turn.start({ text: 'one', turnId: 't1' })
  await armHold($)

  const second = $.turn.start({ text: 'two', turnId: 't2' })
  await clock.settle() // one write of its line has landed, and the hook waits for the answer to it
  // What is drawn in the gap is read before the hold ends, and checked after it, so that a check that fails leaves no
  // hook waiting.
  const between = await readState($)
  const ui = await mountPane($)
  const hidden = await ui.find({ type: 'Text', text: /^\+\d+ more$/ })
  await ui.unmount()

  await clock.advance(100) // the answer comes, and the hook writes the other
  await second
  expect(between.log.length + between.logCount).toBe(3) // the line and the count of 'one', and one write of 'two'
  expect(hidden).toBeUndefined()
  const after = await readState($)
  expect([after.log.length, after.logCount]).toEqual([2, 2])
})

// A /clear or a resume that lands between the two writes of a log line. The reset empties the log and the count under
// the call that is writing the line, so a count written after it would stand one above the lines for the rest of the
// conversation, a stray `+1 more` on every line after (the 0.4.0 live check). The call knows the reset came after it
// began, and leaves its count out. The holder lets the first write of the line land and stops the hook there; the reset
// lands in that gap.
for (const reason of ['clear', 'resume'] as const) {
  test(`a ${reason} that lands between the two writes of a log line leaves no stray +N more on the next line`,
    WITH_WRITE_HOLDER, async ($, on) => {
      const clock = mock.clock(on, { now: 1_000_000 })
      bottom(on, clock)
      await $.session.start(START)
      await clock.advance(1)
      await armHold($)

      const first = $.turn.start({ text: 'one', turnId: 't1' })
      await clock.settle() // one write of its line has landed, and the hook waits for the answer to it
      const between = await readState($)
      await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } }) // the reset lands in the gap
      await clock.advance(100) // the answer comes, and the hook goes on
      await first
      expect((between.log ?? []).length + (between.logCount ?? 0)).toBe(1) // one of the two had landed, not the other
      // The reset has emptied what had landed, and the line leaves no count behind it.
      const emptied = await readState($)
      expect([emptied.log, emptied.logCount]).toEqual([[], 0])

      await $.turn.start({ text: 'two', turnId: 't2' })
      // The count is not above the lines that the log holds, so the pane has no event to count that it does not show.
      const { log, logCount } = await readState($)
      expect([log.map(line => line.text), logCount]).toEqual([['two'], 1])
      const ui = await mountPane($)
      expect(await ui.find({ type: 'Text', text: /^\+\d+ more$/ })).toBeUndefined()
      await ui.unmount()
    })
}

// What a reset does to the log, and what a call that writes a line while it runs may leave behind: a count above the
// lines, which stands for the rest of the conversation as a stray `+1 more` on every line after (the 0.4.0 live check,
// finding 7). A call counts only when no reset was running when it started and none has started since, and the second
// check is in the update of the count, which runs again when its write misses. The tests below put a call and a
// reset in the interleavings that the rule has to meet with the holder, and end with one more line, which must be the
// first one counted: one line held, and a count of 1.
const endSession = ($: Engine, reason: 'clear' | 'resume' = 'clear') =>
  $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } })

// A call starts while a reset runs. The reset has raised the epoch, so the call takes the new one, and its write of the
// log has not come yet: the line of the call lands, the reset empties the log, and the count of the call, which lands
// after the end of the reset, would stand one above the lines. So a call that finds a reset running at its start leaves
// its count out. The first hold keeps the reset after its write of `agents`, the second keeps the call after its line
// has landed, until the reset is over. With two resets one of them has ended by the time the call starts and the other
// still runs: a flag, or the parity of the epoch, would take that end for the end of both.
const RESETS_AT_THE_START: Array<[what: string, more: number]> = [
  ['a reset runs', 0],
  ['two resets overlap and one of them has ended', 1],
]
for (const [what, more] of RESETS_AT_THE_START) {
  test(`a call that starts when ${what} leaves its count out: the next line is the first one counted`,
    WITH_WRITE_HOLDER, async ($, on) => {
      const clock = mock.clock(on, { now: 1_000_000 })
      bottom(on, clock)
      await $.session.start(START)
      await clock.advance(1)

      await armHold($, { keys: ['agents'], ms: 100 })
      const reset = endSession($) // it has started, and waits after its write of `agents`: the log is not emptied yet
      await clock.settle()
      for (let i = 0; i < more; i += 1) await endSession($, 'resume') // another reset runs, and ends
      await armHold($, { ms: 200 })
      const call = $.turn.start({ text: 'one', turnId: 't1' }) // it starts while the first reset runs
      await clock.settle() // its line has landed, and its hook waits for the answer to that write
      const between = await readState($)

      await clock.advance(100) // the reset goes on: it empties the log and the count, and ends
      await reset
      await clock.advance(100) // the call goes on: its count
      await call
      expect([between.agents, (between.log ?? []).length]).toEqual([{}, 1]) // `agents` was written, the log not yet
      await $.turn.start({ text: 'two', turnId: 't2' })

      const { log, logCount } = await readState($)
      expect([log.map(line => line.text), logCount]).toEqual([['two'], 1])
      const ui = await mountPane($)
      expect(await ui.find({ type: 'Text', text: /^\+\d+ more$/ })).toBeUndefined()
      await ui.unmount()
    })
}

// A count that has been read before a reset and is written after it: the write misses, since the reset wrote the count,
// and the update runs again on what the reset left. The check of the call must be in the update, where that retry meets
// it, and not before it, or the retry adds one to the 0 that the reset wrote. The hold keeps the write of the count,
// which the update has made from its read, while a whole reset runs.
test('a count read before a reset, whose write misses after it, adds nothing when the update runs again',
  WITH_WRITE_HOLDER, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)

    await armHold($, { keys: ['logCount'], mode: 'before' })
    const call = $.turn.start({ text: 'one', turnId: 't1' })
    await clock.settle() // its line has landed, and the write of its count waits: the count it read was 0
    const between = await readState($)
    await endSession($) // a whole reset, which writes the count too
    await clock.advance(100) // the write of the call goes on: it misses, and the update runs again
    await call
    expect([(between.log ?? []).length, between.logCount ?? 0]).toEqual([1, 0]) // the line has landed, the count not
    await $.turn.start({ text: 'two', turnId: 't2' })

    const { log, logCount } = await readState($)
    expect([log.map(line => line.text), logCount]).toEqual([['two'], 1])
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /^\+\d+ more$/ })).toBeUndefined()
    await ui.unmount()
  })

// The same, with the retry coming after the count of the reset but before its end: the reset began after the call did,
// and is still running, so it is the epoch that tells the call, raised at the start of the reset and not at its end.
// The first hold keeps the write of the count of the call, as above; the second keeps the reset after its last write,
// the one to `usage`, until the call has gone on.
test('a count whose update runs again after the count of a reset, with the reset still running, adds nothing',
  WITH_WRITE_HOLDER, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)

    await armHold($, { keys: ['logCount'], mode: 'before', ms: 100 })
    const call = $.turn.start({ text: 'one', turnId: 't1' })
    await clock.settle() // its line has landed, and the write of its count waits: the count it read was 0
    await armHold($, { keys: ['usage'], ms: 200 })
    const reset = endSession($) // it has written the log and the count, and waits after its last write
    await clock.settle()
    const between = await readState($)

    await clock.advance(100) // the write of the call goes on: it misses, the reset is not over, the update runs again
    await call
    await clock.advance(100) // the reset ends
    await reset
    expect([between.log, between.logCount]).toEqual([[], 0]) // the reset had emptied both, and was not over
    await $.turn.start({ text: 'two', turnId: 't2' })

    const { log, logCount } = await readState($)
    expect([log.map(line => line.text), logCount]).toEqual([['two'], 1])
  })

// A write of the reset that fails, as one does when the signal of the hook aborts: the hook fails, which the engine
// takes as a hook to skip, with the epoch raised and the log not emptied. The reset counts itself as running while its
// writes go on, and must stop counting itself when they end by a failure too, or no call would count again for the
// rest of the module's life.
test('a reset that is cut short by a write that fails is over: the lines after it are counted', WITH_WRITE_HOLDER,
  async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    await $.turn.start({ text: 'zero', turnId: 't0' })

    await armHold($, { keys: ['agents'], mode: 'refuse' })
    await endSession($) // its write of `agents` fails, and the reset with it: the engine skips the hook that failed
    const cut = await readState($)
    await $.turn.start({ text: 'one', turnId: 't1' })

    expect((cut.log ?? []).map(line => line.text)).toEqual(['zero']) // the reset did not get as far as the log
    const { log, logCount } = await readState($)
    expect([log.map(line => line.text), logCount]).toEqual([['one', 'zero'], 2])
  })

// The reset empties the count before the log, as addLog writes the line before the count: the count never stands above
// the lines. The two writes are two steps, and the reset may be seen between them, or be cut short there by a write
// that fails (the signal of the hook aborts, say). With the log emptied first, the old count would stand over an empty
// log, and the next line would show `+N more` for the whole of the old conversation. The two tests go by order, the
// first and the second of the two writes, so that they pin the rule and not the order of the lines in the code: after
// the first of them the count is not above the lines held, whichever of the two it was.
test('a reset seen between the first and the second of its two log writes has no count above the lines',
  WITH_WRITE_HOLDER, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    await $.turn.start({ text: 'one', turnId: 't1' })
    await $.turn.start({ text: 'two', turnId: 't2' }) // two lines on the log, and a count of 2

    await armHold($) // the first of the two writes lands, and the reset waits after it
    const reset = endSession($)
    await clock.settle()
    const between = await readState($)
    const ui = await mountPane($)
    const more = await ui.find({ type: 'Text', text: /^\+\d+ more$/ })
    await ui.unmount()

    await clock.advance(100) // the second write comes, and the reset ends
    await reset
    expect(Number(between.log.length === 0) + Number(between.logCount === 0)).toBe(1) // one of the two is emptied
    expect(Math.max(between.logCount, between.log.length) - between.log.length).toBe(0) // none counted but the lines
    // No pin, only a guard: an empty log draws no Log section, so the old order showed no `+N more` here either.
    expect(more).toBeUndefined()
    const after = await readState($)
    expect([after.log, after.logCount]).toEqual([[], 0])
  })

test('a reset whose second log write fails has no count above the lines, and nor has the next line',
  WITH_WRITE_HOLDER, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    bottom(on, clock)
    await $.session.start(START)
    await clock.advance(1)
    await $.turn.start({ text: 'one', turnId: 't1' })
    await $.turn.start({ text: 'two', turnId: 't2' }) // two lines on the log, and a count of 2

    await armHold($, { mode: 'refuse', skip: 1 }) // the first of the two writes goes through, the second fails
    await endSession($) // the engine skips the hook that failed
    const cut = await readState($)
    expect(Number(cut.log.length === 0) + Number(cut.logCount === 0)).toBe(1) // one of the two is emptied
    expect(Math.max(cut.logCount, cut.log.length) - cut.log.length).toBe(0) // none counted but the lines

    await $.turn.start({ text: 'three', turnId: 't3' })
    const { log, logCount } = await readState($)
    expect(Math.max(logCount, log.length) - log.length).toBe(0)
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /^\+\d+ more$/ })).toBeUndefined()
    await ui.unmount()
  })
