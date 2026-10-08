// Wiring of the session-panel mod: engine events fill the `$.state` atoms, a command toggles the pane, and view.tsx
// draws the pane from the atoms. Every hook only observes: it returns what next(e) returned (the command hook answers
// its own command).
// `claude plugin validate` follows `$` only into top-level functions of this file, so every helper that takes `$`
// sits here, the presses of the pane included. The atoms are declared here too: read() and update() refuse a
// reference written in another file.
import { atom, read, update } from 'claude-code'
import type {
  EngineInterface, PluginState, Register, SessionContextUsage, SessionCost, SessionRateLimit,
} from 'claude-code'

import {
  addAgentCost, attributeCost, computeTurnStats, fmtDuration, fmtTokens, fmtUsd, parseStatus, pushLog, redact,
  shortType, shorten, sumNumstat, toolLabel,
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

// How long after such a call the project is read, in ms: its change has landed by then, and a burst of calls is read
// once.
const PROJECT_DELAY_MS = 1000

// How long each git call that reads the changes may run, in ms.
const CHANGES_TIMEOUT_MS = 10_000

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

// The model's context window that the last session.measure brought. It is null until a measure sets it: the first one
// after the module loads only stores it, since session.start has read the breakdown already.
let lastModelWindow: number | null = null

// The cost readings run one after another, each against the one before it: none overtakes another.
let costQueue: Promise<void> = Promise.resolve()

// Whether a read of the project is under way. The reads run one at a time: two never overlap, and git is not asked for
// the same thing twice at once.
let isProjectBusy = false

// Whether the project was asked for while a read was under way. The read that ends then starts one more, so the last
// request is always served.
let isProjectStale = false

// Whether a read of the project waits on the timer that a call of WRITE_TOOLS set. A call that comes meanwhile adds
// nothing: that read sees the tree as it is when it runs.
let isProjectWaiting = false

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

// The log line of a subagent that has ended: its text, and its outcome, the time it took behind a mark (✓ for an
// answer, ✗ for a failure; a stop is no fault, so it has no mark). One that still runs has no outcome, so its status
// is not a parameter.
const agentOutcome = (
  status: 'done' | 'failed' | 'stopped', row: AgentRow, durationMs: number, answer: string,
): { text: string; outcome: string } => {
  const took = fmtDuration(durationMs)
  if (status === 'stopped') return { text: status, outcome: took }
  if (status !== 'done') return { text: status, outcome: `✗ ${took}` }
  const said = shorten(redact(answer), 80)
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

// Puts a line on top of the log. The outcome of an action, a mark and its time, is a field of its own; a line with
// none has no such key.
async function addLog(
  $: EngineInterface, at: number, who: string, text: string, kind: LogKind, outcome?: string,
): Promise<void> {
  const entry: LogEntry = { at, who, text, kind, ...(outcome === undefined ? {} : { outcome }) }
  await update($, logAtom, list => pushLog(list, entry))
}

// Whose line it is: `main`, or the type of the subagent that ran.
async function whoIs($: EngineInterface, agentId: string | undefined): Promise<string> {
  if (agentId === undefined) return 'main'
  const row = (await read($, agentsAtom))[agentId]

  return row === undefined ? 'agent' : shortType(row.type)
}

// Folds or unfolds a section of the pane, and keeps the map in the store, where the next session finds it.
async function toggleSection($: EngineInterface, id: SectionId): Promise<void> {
  const folded = await update($, collapsedAtom, held => ({ ...held, [id]: held[id] !== true }))
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
  // state. The desktop app's own servers (`ccd_…` and DESKTOP_SERVERS) are neither listed nor counted.
  const names = [...new Set(breakdown?.mcpTools.map(tool => tool.serverName))].filter(
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

// The branch; the short commit on a detached HEAD; null outside a git repository or when git fails.
async function gitBranch($: EngineInterface, root: string): Promise<string | null> {
  const init = { cwd: root, timeoutMs: 5000 }
  try {
    const named = await $.process.run(['git', 'branch', '--show-current'], init)
    if (named.exitCode !== 0) return null
    const branch = named.stdout.trim()
    if (branch !== '') return branch
    const head = await $.process.run(['git', 'rev-parse', '--short', 'HEAD'], init)

    return head.exitCode === 0 ? head.stdout.trim() : null
  } catch {
    return null
  }
}

// The stdout of a git call that reads the changes: null unless it ended with one of `exits` and was not cut, or when
// it could not be started. A call that reads the tree passes `--no-optional-locks`: a plain one may refresh the index
// and take index.lock, which makes the git commands of the person or the agent fail.
async function gitOut($: EngineInterface, argv: string[], cwd: string, exits: number[]): Promise<string | null> {
  try {
    const ran = await $.process.run(argv, { cwd, timeoutMs: CHANGES_TIMEOUT_MS })

    return exits.includes(ran.exitCode) && !ran.isStdoutTruncated ? ran.stdout : null
  } catch {
    return null
  }
}

// What differs from HEAD in the working tree: the files that changed, and the lines added and removed. Null when there
// is nothing to show: outside a git repository, on a clean tree, or when the list of files cannot be had whole. The
// lines are null when they cannot be had (an unborn HEAD has no HEAD to diff against).
async function gitChanges($: EngineInterface, root: string): Promise<Changes> {
  const status = await gitOut($, ['git', '--no-optional-locks', 'status', '--porcelain', '-z', '-uall'], root, [0])
  if (status === null) return null
  const { files, newFiles } = parseStatus(status)
  if (files === 0) return null
  // The tracked files, net against HEAD. --no-textconv and --no-ext-diff count the files themselves, and run no program
  // that the person configured.
  const diff = await gitOut(
    $, ['git', '--no-optional-locks', 'diff', '--numstat', '--no-textconv', '--no-ext-diff', 'HEAD'], root, [0],
  )
  if (diff === null) return { files, lines: null }
  let { added, removed } = sumNumstat(diff)
  if (newFiles.length > 0) {
    // The paths of the status are relative to the top of the repository, which may not be the session root.
    const toplevel = await gitOut($, ['git', 'rev-parse', '--show-toplevel'], root, [0])
    if (toplevel === null) return { files, lines: null }
    const top = toplevel.trim()
    // A new file is in no diff against HEAD, so it is diffed against nothing, one file at a time. --no-index exits 1
    // when the sides differ, an empty new file included, and 0 when they do not; any other end adds nothing.
    for (const path of newFiles.slice(0, NEW_FILES_MAX)) {
      const argv = [
        'git', '--no-optional-locks', 'diff', '--no-index', '--numstat', '--no-textconv', '--no-ext-diff', '--',
        '/dev/null', path,
      ]
      const counted = await gitOut($, argv, top, [0, 1])
      if (counted !== null) {
        const lines = sumNumstat(counted)
        added += lines.added
        removed += lines.removed
      }
    }
  }

  return { files, lines: { added, removed } }
}

// Reads the project: the name (the folder of the session root), its branch, then the changes of its working tree.
async function refreshProject($: EngineInterface): Promise<void> {
  const root = await $.session.root()
  const branch = await gitBranch($, root)
  const changes = await gitChanges($, root)
  await update($, projectAtom, () => ({ name: root.replace(/^.*[\\/]/, ''), branch, changes }))
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
    await refreshProject($).catch(() => undefined)
  } while (isProjectStale)
  isProjectBusy = false
}

// Asks for a read of the project PROJECT_DELAY_MS from now, which the call of a tool that may have changed a file does.
// One timer waits at most: a call that comes while it waits adds nothing.
function requestProjectLater($: EngineInterface): void {
  if (isProjectWaiting) return
  isProjectWaiting = true
  $.clock.after(PROJECT_DELAY_MS, () => {
    isProjectWaiting = false
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
      name: 'session-panel', description: 'Open or close the session stats pane', immediate: true,
    })
    // The baseline, and the first Total. A reading that fails must not stop the timer or the opening of the pane.
    await chargeCost($, undefined).catch(() => undefined)
    // The store holds the map this mod wrote itself, but a file can be edited: what is not a map of booleans is
    // ignored.
    const saved = await $.store.get('collapsed')
    if (isFoldedMap(saved)) await update($, collapsedAtom, () => saved)
    inBackground($, () => refreshUsage($))
    inBackground($, () => requestProject($))
    let ticks = 0
    $.clock.every(TICK_MS, () => {
      ticks += 1
      $.ui.invalidate('ui.render')
      syncAgents($).catch(() => undefined)
      if (ticks % 2 === 0) refreshUsage($).catch(() => undefined)
    })
    if ((await $.session.surfaces()).includes('desktop')) await $.ui.open({ id: PANE, title: 'Session' })

    return started
  })

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    if (e.surface === 'desktop') await $.ui.open({ id: PANE, title: 'Session' })

    return attached
  })

  on('session.end', async ($, e, next) => {
    // A /clear or a resume starts the conversation over, and a resume puts another conversation in place of this one.
    // The module, its timers and the pane carry on; the ledger starts over and the hand-backs not read are dropped,
    // and the context reads empty until the next response (the window, the cost and the limits are the session's
    // still).
    if (e.reason === 'clear' || e.reason === 'resume') {
      lastUsd = null
      handbacks.clear()
      await update($, turnAtom, () => turnAtom.initial)
      await update($, lastTurnAtom, () => lastTurnAtom.initial)
      await update($, agentsAtom, () => agentsAtom.initial)
      await update($, logAtom, () => logAtom.initial)
      await update($, usageAtom, held => ({ ...held, contextTokens: undefined, contextPct: undefined }))
    }

    return next(e)
  })

  // A pane that is open but waits undrawn is not shown: asking for it again places it.
  on('command.run', { command: 'session-panel' }, async $ => {
    if ((await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)) {
      await $.ui.close({ id: PANE })

      return { text: 'Session pane closed.' }
    }
    const opened = await $.ui.open({ id: PANE, title: 'Session' })

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
    const now = await $.clock.now()
    const { cost } = await $.session.usage()
    await update($, turnAtom, () => ({
      turnId: e.turnId, startedAt: now, costAtStart: cost?.usd ?? null, steps: [], toolIntervals: [],
    }))
    // A turn the engine started on its own opens with a tag (<task-notification>), a person's prompt does not. A turn
    // with no text (a continuation) is no line of the log.
    if (e.text.trim() !== '') {
      const tag = /^<([^\s>/]+)/.exec(e.text)?.[1]
      await addLog($, now, tag === undefined ? 'you' : 'engine', tag ?? shorten(redact(e.text), 70), 'info')
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
    const t1 = await $.clock.now()
    // A call that may have changed a file asks for a read of the project, whatever its outcome (a command that failed
    // may have changed some first); a denied one never ran.
    if (ran.deny === undefined && WRITE_TOOLS.includes(e.tool)) requestProjectLater($)
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
      // How it went is the outcome, a column of its own: the time it took behind a mark, or `denied`.
      const outcome = ran.deny !== undefined ? 'denied' : `${isFailed ? '✗' : '✓'} ${fmtDuration(t1 - t0)}`
      const label = shorten(redact(toolLabel(e.tool, e, await $.session.root())), 64)
      await addLog($, t1, await whoIs($, e.agentId), label, isFailed ? 'error' : 'ok', outcome)
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
      const type = e.subagentType ?? e.name ?? 'agent'
      const row: AgentRow = {
        id: agentId, description: e.description, type, model: spawned.model, status: 'running', startedAt: now,
        endedAt: null, costUsd: null,
      }
      await update($, agentsAtom, rows => ({ ...rows, [agentId]: row }))
      await addLog($, now, 'main', shorten(redact(`spawned · ${type}: ${e.description}`), 70), 'info')
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
      collapsed: await read($, collapsedAtom),
      now: await $.clock.now(),
      surface: e.surface,
    }

    return renderPane(els, data, e.props, {
      onToggle: id => {
        toggleSection($, id).catch(() => undefined)
      },
    })
  })
}
