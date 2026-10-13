// Wiring of the session-panel mod: engine events fill the `$.state` atoms, a command opens the pane, and view.tsx
// draws the pane from the atoms. Every hook only observes: it returns what next(e) returned (the command hook answers
// its own command).
// `claude plugin validate` follows `$` only into top-level functions of this file, so every helper that takes `$`
// sits here, the presses of the pane included. The atoms are declared here too: read() and update() refuse a
// reference written in another file.
import { atom, read, update } from 'claude-code'
import type {
  EngineInterface, PluginState, ProcessRunResult, Register, SessionContextUsage, SessionCost, SessionRateLimit,
} from 'claude-code'

import {
  addAgentCost, attributeCost, computeTurnStats, fmtDuration, fmtTokens, fmtUsd, parseStatus, plainText, pushLog,
  redact, shortType, shorten, stripFormat, sumNumstat, textHead, toolLabel,
} from './stats'
import type { AgentRow, AgentStatus, Interval, LogEntry, LogKind, StepTiming, Usage } from './stats'
import { renderPane } from './view'
import type { PaneData, SectionId } from './view'

// The changes of the working tree, as the project value keeps them.
type Changes = PluginState['session-panel']['project']['changes']

const usageAtom = atom({ plugin: 'session-panel', key: 'usage' } as const, { rateLimits: [] })
const projectAtom = atom(
  { plugin: 'session-panel', key: 'project' } as const, { name: '', branch: null, changes: null },
)
const mcpAtom = atom({ plugin: 'session-panel', key: 'mcp' } as const, null)
const turnAtom = atom({ plugin: 'session-panel', key: 'turn' } as const, null)
const lastTurnAtom = atom({ plugin: 'session-panel', key: 'lastTurn' } as const, null)
const agentsAtom = atom({ plugin: 'session-panel', key: 'agents' } as const, {})
const logAtom = atom({ plugin: 'session-panel', key: 'log' } as const, [])
const logCountAtom = atom({ plugin: 'session-panel', key: 'logCount' } as const, 0)
const collapsedAtom = atom({ plugin: 'session-panel', key: 'collapsed' } as const, {})

const PANE = 'session-panel'
const TICK_MS = 30_000

// The words $.agent.list() uses for how a subagent ended; any other word (`running` too) leaves the row as it is.
const LISTED_STATUS: Record<string, AgentStatus> = { completed: 'done', failed: 'failed', killed: 'stopped' }

// The tools that start a subagent (`Task` is the name of `Agent` in older builds).
const SPAWN_TOOLS: string[] = ['Agent', 'Task']

// The tool that a subagent reports through in auto mode; its turn then ends with an empty answer. A `string`, not the
// literal: the engine's types do not list it, and comparing `e.tool` with a literal they lack is an error.
const HANDBACK_TOOL: string = 'SubagentHandback'

// The tools whose call may have changed a file, whichever agent made it: the project is read again after one.
const WRITE_TOOLS: string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']

// How long after such a call the project is read at least, in ms: its change has landed by then, and a burst of calls
// is read once.
const PROJECT_DELAY_MS = 1000

// A delayed read of the project waits at least four times as long as the last read took, which counts
// READ_MS_MAX at most. So git takes at most about a quarter of the time, for the reads after tool calls
// and the minute read, even in a big repository (the timer starts at the call, which may come during the
// read before), as long as a read takes a minute at most; and a read that ran into its timeouts is not
// retried at once.
const PROJECT_GAP_FACTOR = 4

// The most one read counts for in lastReadMs, in ms, so the gap rule waits four minutes at most. A read is timed by the
// wall clock: a suspend in the middle of one would count the whole sleep, and stop the minute read for four times as
// long. A real read is well under that: READ_BUDGET_MS bounds its changes and the branch has its own 5 s for each of
// its calls, so only a suspend makes a read count longer.
const READ_MS_MAX = 60_000

// How long each git call that reads the changes may run, in ms; the budget of the read may leave a call less.
const CHANGES_TIMEOUT_MS = 10_000

// How long the changes of one read may take in all, in ms, counted from the start of gitChanges. Every git call that
// reads them runs with CHANGES_TIMEOUT_MS or with the time left of this, whichever is less, and once none is left the
// next call is not made. Each call alone keeps to its timeout, yet the calls of one read add up: 50 new files that take
// 9 s each are minutes.
const READ_BUDGET_MS = 30_000

// The start of every git call that reads the tree; gitRun says why each option is there.
const GIT_READ: string[] = [
  'git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'diff.autoRefreshIndex=false',
]

// The variables that such a call runs with, set over the process's own. git 2.44 and later, and some distributions'
// 2.43 builds (a backport), honour GIT_NO_LAZY_FETCH; other git ignores it. GIT_CEILING_DIRECTORIES is not set: the mod
// reads no env, so it cannot know $HOME, and a ceiling at the session root would hide the repository of a session that
// starts in one of its folders.
const GIT_READ_ENV: Record<string, string> = { GIT_NO_LAZY_FETCH: '1' }

// git's empty tree. As the source of attributes (GIT_ATTR_SOURCE) it leaves no .gitattributes in force, so no
// attribute-selected filter (a clean or process filter, Git LFS among them) runs on an untracked file that a --no-index
// call reads. `.git/info/attributes` and the person's own attributes file still apply, and a git that has no
// GIT_ATTR_SOURCE ignores it. A SHA-256 repository rejects this id: git dies there, so its new files count no lines,
// and the loop that counts them marks that (hasMoreAdded).
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

// What every --no-index call runs with: GIT_READ_ENV, and the empty tree as the source of attributes.
const NO_INDEX_ENV: Record<string, string> = { ...GIT_READ_ENV, GIT_ATTR_SOURCE: EMPTY_TREE }

// How many reads in a row may have a status, or a diff against HEAD, that threw, for one root, before its changes are
// left unread until READ_RETRY_MS has passed (readThrows).
const READ_THROWS_MAX = 2

// How long the changes of a root are left unread once its reads have reached READ_THROWS_MAX, in ms (15 minutes),
// counted from the start of the read whose throw brought it there (readRetryAt). One read then tries again. A tree that
// git cannot walk in time stays slow, but a throw can also come of a computer that went to sleep, or of a disk that was
// busy for a while, so a folder is not given up for good.
const READ_RETRY_MS = 15 * 60_000

// How many new files have their lines counted. A new file is in no diff against HEAD, so each takes a git call of its
// own; the files past this many add no lines, so past it the plus is a lower bound.
const NEW_FILES_MAX = 50

// The cost.usd reading that the next request is charged against. It is null until a reading sets it: the first one
// after the module loads (the start of the session), and the first one after a /clear.
let lastUsd: number | null = null

// The messages that subagents handed back through HANDBACK_TOOL, by agent id, until the turn.complete of the agent
// reads its own. The input of that tool is not in the engine types: `{ message: string }` is the shape seen in every
// hand-back so far, so a different shape only leaves the answer out. It is emptied with the ledger.
const handbacks = new Map<string, string>()

// How many times a /clear or a resume has started since this module loaded. The reset raises it once, at its start,
// before it writes any atom, and addLog takes it when it starts: a call that finds it changed when it counts began
// before a reset that has started since, which empties the log and the count under it, and the call does not count. A
// reload of the module starts it over; a call of the old module compares with the old module's own.
let logEpoch = 0

// How many resets are between their start and their end. The reset raises it with logEpoch and lowers it when its
// writes are over, whether they all landed or one threw (a write fails when the signal of the hook aborts, say), so
// that a failure cannot stop all counting for the rest of the module's life. A call that starts while it is above 0
// does not count: the write of the reset to the log may still come after the line of the call, and empty it. It is a
// count, not a flag, and not the parity of logEpoch: resets that overlap are each running until their own end.
let resetsRunning = 0

// The model's context window that the last session.measure brought. It is null until a measure sets it: the first one
// after the module loads only stores it, since session.start has read the breakdown already.
let lastModelWindow: number | null = null

// The cost readings run one after another, each against the one before it: none overtakes another.
let costQueue: Promise<void> = Promise.resolve()

// The presses of the pane run one after another too, whether the one before failed or not. A press builds on the map
// that it reads from the store (toggleSection), so one that read it before the write of the press before it had ended
// would drop that fold. A reload of the module starts the chain over: a press then waits for none of the old module's.
let pressQueue: Promise<void> = Promise.resolve()

// Whether a read of the project is under way. The reads run one at a time: two never overlap, and git is not asked for
// the same thing twice at once.
let isProjectBusy = false

// Whether the project was asked for while a read was under way. The read that ends then starts one more, so the last
// request is always served.
let isProjectStale = false

// The read of the project that waits on a timer: the time at which it was asked for and how long it waits, in ms; null
// when none waits. A call of WRITE_TOOLS that comes meanwhile adds nothing: that read sees the tree as it is when it
// runs. A timer that a hook refused never runs, so a wait older than twice the shorter of its own delay and the one a
// new call would get is taken as lost, and the next call asks again.
let projectWait: { askedAt: number; delayMs: number } | null = null

// How long the last read of the project took, in ms, whether it succeeded or failed, and READ_MS_MAX at most; 0 until
// the first one ends. The delay of the next delayed read follows it (PROJECT_GAP_FACTOR).
let lastReadMs = 0

// Whether a turn of the main agent has started since this module loaded; false at load. `git status` and `git diff` can
// run filters that the repository's own config names, and the engine types give a hook no sign that the person has
// accepted the folder; a turn cannot start before that. So the tree is read from the first turn on, and until then the
// project is its name and its branch (`git branch` runs no filters). A reload of the module starts it over: the tree is
// not read again until the next turn.
let hasMainTurn = false

// For each root, how many reads in a row had a status, or a diff against HEAD, that threw. A throw is a timeout or a
// git that cannot be started; a non-zero exit, as outside a repository, is none. The count of a root rises by one for
// each read that had a throw, up to READ_THROWS_MAX, and a read whose status and diff both ended without one starts it
// over. At READ_THROWS_MAX the changes of that root are left unread until READ_RETRY_MS has passed (readRetryAt), and
// the branch still is read: a session inside a huge tree, such as a dotfiles repository in $HOME, would otherwise
// spend the whole timeout on every read. A read of another root leaves the count of this one as it is. A call also
// throws when the hook's signal aborts, as when the module unloads, and that counts too; it is harmless, since a new
// module starts its counts over.
const readThrows = new Map<string, number>()

// For each root at READ_THROWS_MAX, the time from which its changes are read again: READ_RETRY_MS after the start of
// the read whose throw brought it there, by the clock of `$.clock.now()`, so a computer that wakes from sleep past it
// reads at its next read. A read that comes earlier reads nothing, and the changes are none for it, with no mark. At or
// after that time one read runs: a throw in it sets the time anew and leaves the count at the max, and a read that ends
// without one starts the count over and drops the time. A time more than READ_RETRY_MS ahead of the clock was set under
// a clock that has since been put back, and counts as over. A root that has no time is not waiting.
const readRetryAt = new Map<string, number>()

// ISO 8601 to epoch ms, which is what the `usage` value keeps; undefined when there is none or it does not parse.
const toMs = (iso: string | undefined): number | undefined => {
  const ms = iso === undefined ? Number.NaN : Date.parse(iso)

  return Number.isNaN(ms) ? undefined : ms
}

// The share of `window` that the tokens fill, in percent; undefined when there are no tokens, or when the sum does not
// come to a number: a window of 0 makes it Infinity or NaN, which the state would keep as null and the pane not draw.
const percentOf = (tokens: number | undefined, window: number): number | undefined => {
  const pct = tokens === undefined ? Number.NaN : (tokens * 100) / window

  return Number.isFinite(pct) ? pct : undefined
}

// The figures of session.measure and of usage(), as the `usage` value keeps them. The percent is worked out here, of
// `window`: the engine's own is of the model's window, not of a smaller compaction window.
const usageFields = (
  from: { context: SessionContextUsage; rateLimits: SessionRateLimit[]; cost?: SessionCost },
  window: number,
) => ({
  contextTokens: from.context.tokens,
  contextWindow: window,
  contextPct: percentOf(from.context.tokens, window),
  costUsd: from.cost?.usd,
  rateLimits: from.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: toMs(r.resetsAt) })),
})

// How much of a subagent's answer its log line is made from, in UTF-16 units. The pane shows 80 characters of it, and
// the pair pattern of plainText takes quadratic time on some long inputs (224 KB of ` **x**y` took 4.1 s in Node 22).
// An answer is the subagent's, so a crafted one could stall the turn.complete hook: only the head of it is worked on.
const ANSWER_HEAD_MAX = 4096

// The log line of a subagent that has ended: its text, and its outcome, the time it took behind a mark (✓ for an
// answer, ✗ for a failure; a stop is no fault, so it has no mark). One that still runs has no outcome, so its status
// is not a parameter.
const agentOutcome = (
  status: 'done' | 'failed' | 'stopped', row: AgentRow, durationMs: number, answer: string,
): { text: string; outcome: string } => {
  const took = fmtDuration(durationMs)
  if (status === 'stopped') return { text: status, outcome: took }
  if (status !== 'done') return { text: status, outcome: `✗ ${took}` }
  // The head is cut first, before any pass reads the answer. The answer is markdown, which the pane shows as it is: its
  // marks go next, but after its format characters, as one beside a mark (a BOM after `**`) hides it from plainText.
  const said = shorten(redact(plainText(stripFormat(textHead(answer, ANSWER_HEAD_MAX)))), 80)
  const head = row.costUsd === null ? 'done' : `done · ${fmtUsd(row.costUsd)}`

  return { text: said === '' ? head : `${head} — ${said}`, outcome: `✓ ${took}` }
}

// Whether a value of the store is a map of booleans, the shape of the folded sections: an object that is neither null
// nor an array, with booleans only in it.
const isFoldedMap = (value: unknown): value is Record<string, boolean> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  Object.values(value).every(held => typeof held === 'boolean')

// Runs the job in a dispatch of its own, so that the hook that asked for it returns at once; a failure is dropped.
function inBackground($: EngineInterface, job: () => Promise<void>): void {
  $.clock.after(1, () => {
    job().catch(() => undefined)
  })
}

// Puts a line on top of the log, and counts it: the log keeps the newest 60 lines, the count every line since the log
// was last emptied. The outcome of an action, a mark and its time, is a field of its own; a line with none has no such
// key. The line goes first. The header's total is max(logCount, lines held) and the pane says `+N more` for the events
// that its lines do not show, so a count written first would stand one above the lines between the two writes, and a
// redraw there would flash a `+1 more` on each of the first 60 events of a conversation. A /clear or a resume empties
// the log and the count, and a count that lands after the reset's own write to it would stand one above the lines for
// the rest of the conversation (the 0.4.0 live check, finding 7). So a call counts only when no reset was running when
// it started and none has started since (resetsRunning, logEpoch). A reset that runs at the start matters because its
// write to the log may still come after the line of the call, and empty it. The second check is in the update of the
// count, not before it: that update runs again when its write misses, as it does when a reset wrote the count after the
// update had read it, and the retry has to meet the reset. A call that does not count writes the count as it was. A
// line of the old conversation may land in the new one then; the count stands behind the lines, never above them, and
// the header's total takes the lines in: it is max(logCount, lines held).
async function addLog(
  $: EngineInterface, at: number, who: string, text: string, kind: LogKind, outcome?: string,
): Promise<void> {
  const entry: LogEntry = { at, who, text, kind, ...(outcome === undefined ? {} : { outcome }) }
  const epoch = logEpoch
  const isResetting = resetsRunning > 0
  await update($, logAtom, list => pushLog(list, entry))
  await update($, logCountAtom, count => (!isResetting && epoch === logEpoch ? count + 1 : count))
}

// Whose line it is: `main`, or the type of the subagent that ran.
async function whoIs($: EngineInterface, agentId: string | undefined): Promise<string> {
  if (agentId === undefined) return 'main'
  const row = (await read($, agentsAtom))[agentId]

  return row === undefined ? 'agent' : shortType(row.type)
}

// Folds or unfolds a section of the pane, and keeps the map in the store, where the next session finds it. The press
// builds on the map of the store, which another session may have written since this one read it (or this one has not
// read it yet): its folds stay, and only this section is set, to the opposite of what the pane shows now. When the
// store has no map to give (it holds none, it cannot be read, or what it holds is no map of booleans) the pane's own
// map is the base.
async function toggleSection($: EngineInterface, id: SectionId): Promise<void> {
  const stored = await $.store.get('collapsed').catch(() => undefined)
  const folded = await update($, collapsedAtom, held => ({
    ...(isFoldedMap(stored) ? stored : held), [id]: held[id] !== true,
  }))
  await $.store.set('collapsed', folded)
}

// The desktop app's own MCP servers are not the person's. The API marks no server as built in, so they are matched by
// name: the `ccd_` family by its prefix, these by the whole name. The user chose this on 2026-10-08.
const DESKTOP_SERVERS: string[] = ['Claude_Browser', 'scheduled-tasks', 'terminal']

// Reads the usage figures with the context breakdown: the skill count and the MCP servers come from it.
async function refreshUsage($: EngineInterface): Promise<void> {
  const now = await $.session.usage({ breakdown: 'summary' })
  const { breakdown } = now.context
  // WaitForMcpServers is not there for a module: every server that has tools in the context is listed, whatever its
  // state. The desktop app's own servers (`ccd_…` and DESKTOP_SERVERS) are neither listed nor counted. A name is the
  // key as a configuration authored it, so its format characters go (stripFormat): a U+202E would reorder the list.
  const names = [...new Set(breakdown?.mcpTools.map(tool => stripFormat(tool.serverName)))].filter(
    name => !name.startsWith('ccd_') && !DESKTOP_SERVERS.includes(name),
  )
  // The window is the breakdown's: a compaction window under the model's shows up only there. Without one, the window
  // held stands, and the model's is the last resort.
  await update($, usageAtom, held => ({
    ...held,
    ...usageFields(now, breakdown?.rawMaxTokens ?? held.contextWindow ?? now.context.window),
    skills: breakdown?.skills?.totalSkills,
  }))
  const servers = names.map(name => ({ name }))
  await update($, mcpAtom, () => ({ servers }))
}

// The branch; the short commit on a detached HEAD; null outside a git repository or when git fails. The format
// characters of the name are taken out (stripFormat): a U+202E in it would reorder what the pane shows.
async function gitBranch($: EngineInterface, root: string): Promise<string | null> {
  const init = { cwd: root, timeoutMs: 5000 }
  try {
    const named = await $.process.run(['git', 'branch', '--show-current'], init)
    if (named.exitCode !== 0) return null
    const branch = stripFormat(named.stdout).trim()
    if (branch !== '') return branch
    const head = await $.process.run(['git', 'rev-parse', '--short', 'HEAD'], init)

    return head.exitCode === 0 ? head.stdout.trim() : null
  } catch {
    return null
  }
}

// One read of the changes (gitChanges): when its budget ends by the clock, whether a call found none of it left and was
// not made, and whether a status, or the diff against HEAD, threw.
type ChangesRead = { endsAt: number; isSpent: boolean; hasThrown: boolean }

// Runs a git call that reads the changes; null when it was not made or threw. It is not made when none is left of the
// budget of its read (READ_BUDGET_MS), and the read goes on as it does after a call that failed. Otherwise it runs with
// CHANGES_TIMEOUT_MS, or with the time left of the budget when that is less, and it throws when it ran past that and
// was killed, or git could not be started, or the hook's signal aborted (as when the module unloads): for a status or
// the diff against HEAD that counts toward the stop all the same, and it is harmless, since a new module starts its
// counts over. A call that reads the tree (GIT_READ) passes `--no-optional-locks`: a plain one may refresh the index
// and take index.lock, which makes the git commands of the person or the agent fail. So the index is never refreshed,
// and a status and a diff each hash again the files whose stat data changed, on every read; the budget and the gap rule
// (PROJECT_GAP_FACTOR) bound that. It passes `-c core.fsmonitor=false` too, or git may run the fsmonitor hook that the
// person configured, or start its own daemon, and `-c diff.autoRefreshIndex=false`, or a diff of the tree refreshes the
// index all the same, taking index.lock and rewriting .git/index. The `env` it is given, GIT_READ_ENV or, for a
// `--no-index` call, NO_INDEX_ENV, keeps a partial clone from fetching the objects it lacks from its remote, which is
// network.
async function gitRun(
  $: EngineInterface, argv: string[], cwd: string, read: ChangesRead, env?: Record<string, string>,
): Promise<ProcessRunResult | null> {
  const left = read.endsAt - (await $.clock.now())
  if (left <= 0) {
    read.isSpent = true

    return null
  }
  try {
    // The host takes a whole number of ms for a timeout, and the clock may not give one: `left` is rounded up.
    return await $.process.run(argv, {
      cwd, timeoutMs: Math.min(CHANGES_TIMEOUT_MS, Math.ceil(left)), ...(env === undefined ? {} : { env }),
    })
  } catch {
    return null
  }
}

// A call that walks the tree, a status or the diff against HEAD: the calls whose throw counts toward the stop of the
// root (readThrows). A call that was not made, for none was left of the budget, threw nothing.
async function gitWalk(
  $: EngineInterface, argv: string[], cwd: string, read: ChangesRead,
): Promise<ProcessRunResult | null> {
  const ran = await gitRun($, argv, cwd, read, GIT_READ_ENV)
  if (ran === null && !read.isSpent) read.hasThrown = true

  return ran
}

// The stdout of a call that ended with one of `exits` and was not cut; null for any other end, and when it threw or was
// not made (`ran` is null).
const stdoutOf = (ran: ProcessRunResult | null, exits: number[]): string | null =>
  ran !== null && exits.includes(ran.exitCode) && !ran.isStdoutTruncated ? ran.stdout : null

// The stdout of such a call (stdoutOf), for a call that does not walk the tree.
async function gitOut(
  $: EngineInterface, argv: string[], cwd: string, exits: number[], read: ChangesRead, env?: Record<string, string>,
): Promise<string | null> {
  return stdoutOf(await gitRun($, argv, cwd, read, env), exits)
}

// The status of the tree, as `git status --porcelain -z` prints it: `stdout` is its whole entries, and `isCut` says
// that git's output was cut (a status that was cut ends inside an entry, and what follows its last NUL is no entry).
type TreeStatus = { stdout: string; isCut: boolean }

// Whether a status lists an untracked folder, a `?? ` entry that ends in a slash. git lists a folder that holds no
// tracked file as one entry, unless it is asked for `-uall`; a nested repository is one whatever it is asked.
const hasUntrackedFolder = (stdout: string): boolean =>
  stdout.split('\0').some(entry => entry.startsWith('?? ') && entry.endsWith('/'))

// Reads the status. Null when there is no status to read: a call failed (as outside a git repository), threw, or was
// not made. `--ignore-submodules=dirty` keeps git from walking the work tree of a submodule. The first call has no `-u`
// flag, so git follows the person's `status.showUntrackedFiles`: `no` walks no untracked file (a person with a
// dotfiles repository in $HOME sets it, so that git does not walk the home folder), and `normal` lists an untracked
// folder as one entry (`dir/`). Only when that output lists such a folder, a second call with `-uall` lists the files
// in it, and its output is the one used. The two calls have the same other flags and the same budget, and both count
// as status calls for the throws; a second one that fails is a failure of the status, so the read has no changes.
async function gitStatus($: EngineInterface, root: string, read: ChangesRead): Promise<TreeStatus | null> {
  const statusWith = async (flags: string[]): Promise<TreeStatus | null> => {
    const argv = [...GIT_READ, 'status', '--porcelain', '-z', ...flags, '--ignore-submodules=dirty']
    const ran = await gitWalk($, argv, root, read)
    if (ran === null || ran.exitCode !== 0) return null
    const isCut = ran.isStdoutTruncated

    return { stdout: isCut ? ran.stdout.slice(0, ran.stdout.lastIndexOf('\0') + 1) : ran.stdout, isCut }
  }
  const first = await statusWith([])

  return first !== null && hasUntrackedFolder(first.stdout) ? statusWith(['-uall']) : first
}

// What differs from HEAD in the working tree: the files that changed, and the lines added and removed. Null when there
// is nothing to show: outside a git repository, on a clean tree, when there is no status to read (gitStatus), or while
// the reads of this root wait (readRetryAt). A status that was cut gives the files it listed whole as a lower bound
// (`hasMoreFiles`) and no lines. The lines are null when they cannot be had (an unborn HEAD has no HEAD to diff
// against); `hasMoreAdded` says that `added` is a lower bound.
// Two rules bound the cost. A read has READ_BUDGET_MS in all, from here: a call that finds none left is not made, and
// the read ends as that call's failure would (readChanges). And the reads of a root stop once READ_THROWS_MAX of them
// in a row had a status, or a diff against HEAD, that threw (readThrows): one count for each read, so that a status
// that is fine does not clear a diff that keeps timing out. The root then waits READ_RETRY_MS, counted from the start
// of the read that stopped it, and gives no changes meanwhile (no mark in the pane); the first read at or after that
// time tries again: with a throw the root waits another READ_RETRY_MS, and with none the count starts over. A read
// whose status and diff both ended without a throw starts the count over; a throw of a later call of the read (the top
// of the repository, a new file) is none for the root.
async function gitChanges($: EngineInterface, root: string): Promise<Changes> {
  const held = readThrows.get(root) ?? 0
  const now = await $.clock.now()
  const retryAt = readRetryAt.get(root)
  // A wait ends READ_RETRY_MS ahead of the clock at most. One that ends further ahead was set under a clock that has
  // since been put back (it is the wall clock, which a person or a time service may set), so it counts as over, and the
  // root is read, instead of waiting until the clock catches up.
  if (retryAt !== undefined && now < retryAt && retryAt - now <= READ_RETRY_MS) return null
  const read: ChangesRead = { endsAt: now + READ_BUDGET_MS, isSpent: false, hasThrown: false }
  const changes = await readChanges($, root, read)
  if (read.hasThrown) {
    // The count stops at the max: a read that tries again after the wait, and throws, leaves it there.
    const thrown = Math.min(held + 1, READ_THROWS_MAX)
    readThrows.set(root, thrown)
    if (thrown === READ_THROWS_MAX) readRetryAt.set(root, now + READ_RETRY_MS)
  } else {
    readThrows.set(root, 0)
    readRetryAt.delete(root)
  }

  return changes
}

// The read of gitChanges: the status, the diff against HEAD and the lines of the new files, in calls that share the
// budget of `read`. A call that finds none left ends the read as its failure would: no status gives no changes, no diff
// gives no lines, and no top of the repository or count of a new file gives a lower bound.
async function readChanges($: EngineInterface, root: string, read: ChangesRead): Promise<Changes> {
  const status = await gitStatus($, root, read)
  if (status === null) return null
  const { files, newFiles } = parseStatus(status.stdout)
  if (files === 0) return null
  // The files that were cut off the status are in no count, so a diff against HEAD would give the lines of more files
  // than `files` says: none are worked out.
  if (status.isCut) return { files, hasMoreFiles: true, lines: null }
  // The tracked files, net against HEAD, over the whole repository: `-c diff.relative=false` overrides the person's
  // `diff.relative`, which would cut the lines to the folder of the session. Older git ignores the key (the option
  // --no-relative came with git 2.28, so it is no use there). --no-textconv and --no-ext-diff count the files
  // themselves: no textconv or external diff program runs, and --ignore-submodules=dirty keeps git from walking the
  // work tree of a submodule. The person's own filters may run on a tracked file that git has to read (clean and
  // process filters, Git LFS among them), as in any `git status`: that is why the tree is read only from the first turn
  // on (hasMainTurn). The `--` after HEAD makes it a revision: a file or folder named HEAD in the root would make it
  // ambiguous, and git would refuse.
  const diffArgv = [
    ...GIT_READ, '-c', 'diff.relative=false', 'diff', '--numstat', '--no-textconv', '--no-ext-diff',
    '--ignore-submodules=dirty', 'HEAD', '--',
  ]
  const diff = stdoutOf(await gitWalk($, diffArgv, root, read), [0])
  if (diff === null) return { files, lines: null }
  let { added, removed } = sumNumstat(diff)
  // The new files past NEW_FILES_MAX are not counted, and nor are those that follow a count that failed, or that the
  // budget left no time for.
  let hasMoreAdded = newFiles.length > NEW_FILES_MAX
  if (newFiles.length > 0) {
    // The paths of the status are relative to the top of the repository, which may not be the session root. Finding it
    // reads no object, so that call runs without GIT_READ_ENV.
    const toplevel = await gitOut($, ['git', 'rev-parse', '--show-toplevel'], root, [0], read)
    if (toplevel === null) {
      // A top that cannot be had (the call was not made, as none was left of the budget; it was killed by the little
      // that was left; or it exited with anything but 0) leaves the new files uncounted, as a count that failed leaves
      // them: the lines of the diff stand, as a lower bound. Inside a repository whose status and diff worked, it
      // fails only by the budget, its own timeout or the module's unload, and the lower bound is right in each case.
      hasMoreAdded = true
    } else {
      const top = toplevel.trim()
      // A new file is in no diff against HEAD, so it is diffed against nothing, one file at a time. --no-index exits 1
      // when the sides differ, an empty new file included, and 0 when they do not. Any other end, a cut output, a throw
      // or a call that was not made (the budget is spent) is a failure, and the loop stops at the first: a timeout on
      // each of 50 files would add up to a read of minutes. The lines counted so far stand, as a lower bound.
      for (const path of newFiles.slice(0, NEW_FILES_MAX)) {
        const argv = [
          ...GIT_READ, 'diff', '--no-index', '--numstat', '--no-textconv', '--no-ext-diff', '--', '/dev/null', path,
        ]
        const counted = await gitOut($, argv, top, [0, 1], read, NO_INDEX_ENV)
        if (counted === null) {
          hasMoreAdded = true
          break
        }
        const lines = sumNumstat(counted)
        added += lines.added
        removed += lines.removed
      }
    }
  }

  return { files, lines: { added, removed, ...(hasMoreAdded ? { hasMoreAdded: true } : {}) } }
}

// Reads the project: the name (the folder of the session root, without its format characters: a U+202E would reorder
// what the pane shows), its branch, then the changes of its working tree. The changes can take long to read, so it
// writes twice: the name and the branch as soon as git has said it, with the changes held, or none when the name
// changed (a count of another folder is never shown under the new name), and then the changes. Before the first turn of
// the main agent (hasMainTurn) there is no second step: the tree is not read, and the changes are none.
async function refreshProject($: EngineInterface): Promise<void> {
  const root = await $.session.root()
  const name = stripFormat(root.replace(/^.*[\\/]/, ''))
  const branch = await gitBranch($, root)
  // Read once: a turn that starts meanwhile has asked for a read of its own, which comes after this one.
  const isTreeOpen = hasMainTurn
  await update($, projectAtom, held => ({
    name, branch, changes: isTreeOpen && held.name === name ? held.changes : null,
  }))
  if (!isTreeOpen) return
  const changes = await gitChanges($, root)
  await update($, projectAtom, held => ({ ...held, changes }))
}

// Reads the project once, and keeps in lastReadMs how long it took, whether the read succeeded or failed.
async function readProject($: EngineInterface): Promise<void> {
  const startedAt = await $.clock.now()
  try {
    await refreshProject($)
  } finally {
    lastReadMs = Math.min((await $.clock.now()) - startedAt, READ_MS_MAX)
  }
}

// Asks for a read of the project. The reads run one at a time: one asked for while another is under way only marks the
// project stale, and the read that ends, whether it succeeded or failed, starts one more at once. So no two reads
// overlap, and the last request is always served.
async function requestProject($: EngineInterface): Promise<void> {
  if (isProjectBusy) {
    isProjectStale = true

    return
  }
  isProjectBusy = true
  do {
    isProjectStale = false
    await readProject($).catch(() => undefined)
  } while (isProjectStale)
  isProjectBusy = false
}

// Asks for a read of the project some time after `now`, which the call of a tool that may have changed a file does: the
// delay is PROJECT_DELAY_MS, or PROJECT_GAP_FACTOR times as long as the last read took when that is more. One timer
// waits at most: a call that comes while it waits adds nothing. A wait counts for twice the shorter of its own delay
// and the delay a new one would get, so a wait set after a slow read does not outlive a fast one; a timer that a hook
// refused never runs, so past that a wait is taken as lost, and the call asks again. A late timer that still fires
// only adds a read, which the runner coalesces.
function requestProjectLater($: EngineInterface, now: number): void {
  const delayMs = Math.max(PROJECT_DELAY_MS, PROJECT_GAP_FACTOR * lastReadMs)
  if (projectWait !== null && now - projectWait.askedAt < 2 * Math.min(projectWait.delayMs, delayMs)) return
  projectWait = { askedAt: now, delayMs }
  $.clock.after(delayMs, () => {
    projectWait = null
    requestProject($).catch(() => undefined)
  })
}

// Takes how a subagent ended from the engine's own list, for a row that is still running: our events missed it.
async function syncAgents($: EngineInterface): Promise<void> {
  const listed = await $.agent.list()
  const now = await $.clock.now()
  await update($, agentsAtom, rows => {
    const synced = { ...rows }
    for (const info of listed) {
      const row = synced[info.id]
      const status = LISTED_STATUS[info.status]
      // An outcome that an event has recorded stands, whatever the list says later.
      if (row?.status === 'running' && status !== undefined) synced[info.id] = { ...row, status, endedAt: now }
    }

    return synced
  })
}

// A subagent that SendMessage has resumed keeps its id, and runs again: its row says so, and the log says it once.
async function reviveAgent($: EngineInterface, agentId: string): Promise<void> {
  // A step of a row that is missing or runs already is the usual one, and it writes nothing.
  const held = (await read($, agentsAtom))[agentId]
  if (held === undefined || held.status === 'running') return
  let revived = null as AgentRow | null // the cast stops TypeScript narrowing it to `null`: the update callback sets it
  await update($, agentsAtom, rows => {
    const row = rows[agentId]
    // The update runs again when its write misses, so it sets `revived` on every run.
    revived = row !== undefined && row.status !== 'running' ? { ...row, status: 'running', endedAt: null } : null

    return revived === null ? rows : { ...rows, [agentId]: revived }
  })
  if (revived !== null) {
    const line = `resumed · ${revived.type}: ${revived.description}`
    await addLog($, await $.clock.now(), 'main', shorten(redact(line), 70), 'info')
  }
}

// Takes a cost reading, shows it as Total, and charges what is new since the last reading to the agent whose request
// has just stopped. The main loop's share is not kept anywhere: Session is Total less the subagents. The engine books
// a request as it stops, so a timer takes the reading, off the stream.
function chargeCost($: EngineInterface, agentId: string | undefined): Promise<void> {
  const charged = costQueue.then(() => readAndCharge($, agentId))
  costQueue = charged.catch(() => undefined)

  return charged
}

async function readAndCharge($: EngineInterface, agentId: string | undefined): Promise<void> {
  const { cost } = await $.session.usage()
  if (cost === undefined) return
  // The first reading, and one under the last (the ledger started over), only set the baseline.
  const charged =
    lastUsd === null || cost.usd < lastUsd ? { delta: 0, lastUsd: cost.usd } : attributeCost(lastUsd, cost.usd)
  lastUsd = charged.lastUsd
  await update($, usageAtom, held => ({ ...held, costUsd: cost.usd }))
  if (agentId === undefined || charged.delta === 0) return
  await update($, agentsAtom, rows => {
    const row = rows[agentId]

    return row === undefined ? rows : { ...rows, [agentId]: addAgentCost(row, charged.delta) }
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // The command only touches panes, so it may run while a turn is in flight.
    await $.command.register({
      name: 'session-panel', description: 'Open the session stats pane', immediate: true,
    })
    // The baseline, and the first Total. A reading that fails must not stop the timer or the opening of the pane.
    await chargeCost($, undefined).catch(() => undefined)
    // The store holds the map this mod wrote itself, but a file can be edited: what is not a map of booleans is
    // ignored, and so is a store that cannot be read. A press made while the map was loading wins over it; the atom
    // starts as `{}`, so with no press the stored map is taken whole.
    const saved = await $.store.get('collapsed').catch(() => undefined)
    if (isFoldedMap(saved)) await update($, collapsedAtom, held => ({ ...saved, ...held }))
    inBackground($, () => refreshUsage($))
    inBackground($, () => requestProject($))
    let ticks = 0
    $.clock.every(TICK_MS, () => {
      ticks += 1
      $.ui.invalidate('ui.render')
      syncAgents($).catch(() => undefined)
      if (ticks % 2 === 0) {
        refreshUsage($).catch(() => undefined)
        // A file that changed outside Claude's tools (an editor, a terminal, a background command that ended after
        // its call returned) shows without a new turn. The gap rule keeps git to about a quarter of the time
        // (PROJECT_GAP_FACTOR). The tick asks only for a pane in front of the session's other plugin panes, placed and
        // shown (the Session pane alone is always in front): until 0.3.0 an idle session ran no git, and a pane that is
        // closed, waits undrawn or is a tab behind another plugin pane has no one to show the count to. The reads that
        // follow the person's or the agent's work (turn ends, write calls, CwdChanged) are unchanged, and a pane that
        // opens asks for one itself. A list of panes that cannot be read asks for nothing.
        $.clock.now()
          .then(async now => {
            const panes = await $.ui.panes()
            if (panes.some(pane => pane.id === PANE && pane.isPlaced && pane.isShown)) requestProjectLater($, now)
          })
          .catch(() => undefined)
      }
    })
    if ((await $.session.surfaces()).includes('desktop')) await $.ui.open({ id: PANE, title: 'Session' })

    return started
  })

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    if (e.surface === 'desktop') {
      await $.ui.open({ id: PANE, title: 'Session' })
      // The timer reads the project only for a pane in front of the session's other plugin panes (session.start), so a
      // pane that opens asks for a read.
      inBackground($, () => requestProject($))
    }

    return attached
  })

  on('session.end', async ($, e, next) => {
    // A /clear or a resume starts the conversation over, and a resume puts another conversation in place of this one.
    // The module, its timers and the pane carry on; the ledger starts over and the hand-backs not read are dropped,
    // and the context reads empty until the next response (the window, the cost and the limits are the session's
    // still). The reset marks itself before it writes any atom: logEpoch goes up, and resetsRunning with it until the
    // writes are over. An addLog that began earlier, or that begins while the reset runs, leaves its count out (its
    // line may land in the log before the reset empties it, or after), and one that begins after the end counts as
    // usual. The finally lowers resetsRunning when a write throws too, as one does when the signal of the hook aborts:
    // it would stay above 0 otherwise, and no call would count again for the rest of the module's life. The count is
    // emptied before the log, as addLog writes the line before the count, so that the count never stands above the
    // lines: not between the two writes, and not when a write between them throws.
    if (e.reason === 'clear' || e.reason === 'resume') {
      lastUsd = null
      handbacks.clear()
      logEpoch += 1
      resetsRunning += 1
      try {
        await update($, turnAtom, () => turnAtom.initial)
        await update($, lastTurnAtom, () => lastTurnAtom.initial)
        await update($, agentsAtom, () => agentsAtom.initial)
        await update($, logCountAtom, () => logCountAtom.initial)
        await update($, logAtom, () => logAtom.initial)
        await update($, usageAtom, held => ({ ...held, contextTokens: undefined, contextPct: undefined }))
      } finally {
        resetsRunning -= 1
      }
    }

    return next(e)
  })

  // The command only opens. `UiPane.isShown` only ranks this plugin's panes, so a lone pane counts as shown even when a
  // built-in desktop tab such as Terminal covers it (the 0.4.0 live check): the command cannot tell a pane in front
  // from a hidden one, so it never closes, and the tab's own close mark closes the pane. The person asks for the pane,
  // so it is asked for: a pane that is not open is opened, and one that is open in any state (in front, a tab behind
  // another plugin pane, or waiting undrawn) is asked for again with `focus`, which places a pane that waits and brings
  // a tab forward (a request, which the surface may refuse).
  on('command.run', { command: 'session-panel' }, async $ => {
    const pane = (await $.ui.panes()).find(listed => listed.id === PANE)
    const focus = pane === undefined ? {} : { focus: true as const }
    const opened = await $.ui.open({ id: PANE, title: 'Session', ...focus })
    // As on an attach: a pane that opens asks for a read of the project, since the timer asks only for a pane in front
    // of the session's other plugin panes.
    inBackground($, () => requestProject($))

    return { text: opened.isPlaced ? 'Session pane opened.' : `Session pane is not shown: ${opened.reason}` }
  })

  on('session.measure', async ($, e, next) => {
    const measured = await next(e)
    // A measure brings the model's window only: it stands in when none is held, and never replaces the breakdown's.
    await update($, usageAtom, held => ({ ...held, ...usageFields(e, held.contextWindow ?? e.context.window) }))
    // Another window than the last measure's is another model: the breakdown has the window that counts for it.
    if (e.context.window !== lastModelWindow) {
      if (lastModelWindow !== null) inBackground($, () => refreshUsage($))
      lastModelWindow = e.context.window
    }

    return measured
  })

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    // The first turn of the main agent opens the tree to the reads (hasMainTurn), and asks for one. The types give this
    // event no agentId (a subagent's run raises no turn.start), so one that had it is not a main turn.
    if (!hasMainTurn && (!('agentId' in e) || e.agentId === undefined)) {
      hasMainTurn = true
      inBackground($, () => requestProject($))
    }
    const now = await $.clock.now()
    const { cost } = await $.session.usage()
    await update($, turnAtom, () => ({
      turnId: e.turnId, startedAt: now, costAtStart: cost?.usd ?? null, steps: [], toolIntervals: [],
    }))
    // A turn the engine started on its own opens with a tag (<task-notification>), a person's prompt does not. A turn
    // with no text (a continuation) is no line of the log.
    if (e.text.trim() !== '') {
      const tag = /^<([^\s>/]+)/.exec(e.text)?.[1]
      await addLog($, now, tag === undefined ? 'you' : 'engine', shorten(tag ?? redact(e.text), 70), 'info')
    }

    return started
  })

  // One model request, main loop or subagent. The chunks pass on as they are; only the first chunk and the stop are
  // timed, so the stream waits on at most three clock reads.
  on('turn.step', async function* ($, e, next) {
    const tStart = await $.clock.now()
    let tFirst: number | null = null
    let tEnd: number | null = null
    let usage: Usage = {}
    let hasTool = false
    let hasText = false
    // A step of a subagent whose row has closed means that a message resumed it: the row runs again. The stream does
    // not wait for that.
    const { agentId } = e
    if (agentId !== undefined) inBackground($, () => reviveAgent($, agentId))
    const stream = next(e)
    for await (const chunk of stream) {
      // The first chunk of any kind is the start of the response, the engine's own chunks included.
      if (tFirst === null) tFirst = await $.clock.now()
      if (chunk.kind === 'tool') hasTool = true
      if (chunk.kind === 'text') hasText = true
      if (chunk.kind === 'stop') {
        tEnd = await $.clock.now()
        usage = chunk.usage ?? {}
        $.clock.after(1, () => {
          chargeCost($, e.agentId).catch(() => undefined)
        })
      }
      yield chunk
    }
    if (tEnd !== null && e.agentId === undefined) {
      const step: StepTiming = { tStart, tFirst, tEnd, usage, hasTool, hasText }
      await update($, turnAtom, acc => acc && { ...acc, steps: [...acc.steps, step] })
    }

    return await stream.result
  })

  on('tool.call', async ($, e, next) => {
    const t0 = await $.clock.now()
    const ran = await next(e)
    // A call that came back as an error while its signal had aborted was abandoned: the person interrupted it, or a
    // stop did. That is no fault of the tool, so the line is no error. The signal is read at once, before any other
    // wait.
    const isAbandoned = ran.isError === true && next.signal.aborted
    const t1 = await $.clock.now()
    // A call that may have changed a file asks for a read of the project, whatever its outcome (a command that failed
    // may have changed some first); a denied one never ran. A call that core ran read-only (a Bash `ls`) changed no
    // file, so it asks for none.
    if (ran.deny === undefined && ran.isReadOnly !== true && WRITE_TOOLS.includes(e.tool)) requestProjectLater($, t1)
    if (e.agentId === undefined) {
      const interval: Interval = [t0, t1]
      await update($, turnAtom, acc => acc && { ...acc, toolIntervals: [...acc.toolIntervals, interval] })
    }
    const isFailed = ran.deny !== undefined || ran.isError === true
    // A subagent that reports through the hand-back tool (auto mode) says it in its `done` line: the message is kept
    // for it. The input is not typed, so only a string counts.
    if (e.tool === HANDBACK_TOOL && e.agentId !== undefined && !isFailed) {
      const message = 'message' in e ? e.message : undefined
      if (typeof message === 'string') handbacks.set(e.agentId, message)
    }
    // A call that started a subagent, woke one or handed a report back has its lines in the log already (`spawned · …`,
    // `resumed · …`, the agent's own `done`): only a call that failed or was denied is logged here.
    const isAgentCall =
      SPAWN_TOOLS.includes(e.tool) || e.tool === HANDBACK_TOOL ||
      (e.tool === 'SendMessage' && typeof e.to === 'string' && Object.hasOwn(await read($, agentsAtom), e.to))
    if (isFailed || !isAgentCall) {
      // How it went is the outcome, a column of its own: the time it took behind a mark, or `denied`. An abandoned call
      // has the time alone, as a stopped subagent has, and is news, not a fault.
      const took = fmtDuration(t1 - t0)
      const outcome = ran.deny !== undefined ? 'denied' : isAbandoned ? took : `${isFailed ? '✗' : '✓'} ${took}`
      const kind: LogKind = isAbandoned ? 'info' : isFailed ? 'error' : 'ok'
      const label = shorten(redact(toolLabel(e.tool, e, await $.session.root())), 64)
      await addLog($, t1, await whoIs($, e.agentId), label, kind, outcome)
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      const acc = await read($, turnAtom)
      if (acc !== null) {
        // A turn stopped before any response leaves the previous one shown: the spec shows the last completed turn.
        if (acc.steps.length > 0) {
          const { cost } = await $.session.usage()
          await update($, lastTurnAtom, () => computeTurnStats(acc, e.durationMs, e.usage, cost?.usd ?? null))
        }
        await update($, turnAtom, () => null)
      }
      inBackground($, () => requestProject($))

      return done
    }
    const { agentId } = e
    // The answer is the engine's, or the message that the agent handed back when the engine has none (spaces are none);
    // the message serves once, whatever the outcome.
    const answer = e.answer.trim() !== '' ? e.answer : (handbacks.get(agentId) ?? '')
    handbacks.delete(agentId)
    const now = await $.clock.now()
    // The agent's last request may not be charged yet: a reading in line with the others settles that before the row
    // is read. A reading that fails leaves the row as it is: the outcome is logged all the same.
    await chargeCost($, agentId).catch(() => undefined)
    const status: AgentStatus = e.isAborted ? 'stopped' : e.reason === 'answer' ? 'done' : 'failed'
    const rows = await update($, agentsAtom, held => {
      const row = held[agentId]

      return row === undefined ? held : { ...held, [agentId]: { ...row, status, endedAt: now } }
    })
    const row = rows[agentId]
    if (row !== undefined) {
      const { text, outcome } = agentOutcome(status, row, e.durationMs, answer)
      // A subagent that failed is an error in the log; one that was stopped is news, not a fault.
      const kind: LogKind = status === 'done' ? 'ok' : status === 'stopped' ? 'info' : 'error'
      await addLog($, now, shortType(row.type), text, kind, outcome)
    }

    return done
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.agentId !== undefined) {
      const { agentId } = spawned
      const now = await $.clock.now()
      // The Subagents list draws the description and the type as the row keeps them, so their format characters go
      // here (a U+202E would reorder what the list shows). No other step writes a row from what the engine gave: a
      // sync, a resume and the end of a run only change a row that is there.
      const type = stripFormat(e.subagentType ?? e.name ?? 'agent')
      const description = stripFormat(e.description)
      const row: AgentRow = {
        id: agentId, description, type, model: spawned.model, status: 'running', startedAt: now, endedAt: null,
        costUsd: null,
      }
      await update($, agentsAtom, rows => ({ ...rows, [agentId]: row }))
      await addLog($, now, 'main', shorten(redact(`spawned · ${type}: ${description}`), 70), 'info')
    }

    return spawned
  })

  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)
    // Only a compaction of the main conversation that stands: not a skip, not a subagent's, not a precompute.
    if (
      e.agentId === undefined && compacted.skip === undefined && compacted.tokensBefore !== undefined &&
      compacted.tokensAfter !== undefined
    ) {
      const text = `compacted ${fmtTokens(compacted.tokensBefore)} → ${fmtTokens(compacted.tokensAfter)}`
      await addLog($, await $.clock.now(), 'main', text, 'info')
      inBackground($, () => refreshUsage($))
    }

    return compacted
  })

  on('classic.CwdChanged', async ($, e, next) => {
    const changed = await next(e)
    inBackground($, () => requestProject($))

    return changed
  })

  // The pane. Reading the atoms here subscribes it: a write to one draws it again. The view gets plain values and the
  // elements of the surface, never `$`; a press on a header runs toggleSection, which is where `$` goes. The press does
  // not wait for it, and a write that fails (the store) is not a failed press: the section has folded all the same.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const data: PaneData = {
      usage: await read($, usageAtom),
      project: await read($, projectAtom),
      mcp: await read($, mcpAtom),
      lastTurn: await read($, lastTurnAtom),
      agents: await read($, agentsAtom),
      log: await read($, logAtom),
      logCount: await read($, logCountAtom),
      collapsed: await read($, collapsedAtom),
      now: await $.clock.now(),
      surface: e.surface,
    }

    return renderPane(els, data, e.props, {
      onToggle: id => {
        pressQueue = pressQueue.then(() => toggleSection($, id)).catch(() => undefined)
      },
    })
  })
}
