// The rebuild of the session-panel mod's Subagents, Tasks and Log from the session's messages: one walk over the rows
// that `$.session.messages()` returns, each row drawn as the live hooks of register.tsx draw it. It imports nothing
// from the engine and never takes `$`, so it can be tested on its own. The rows are untrusted (another plugin's hook
// may answer the call): a row or a field of the wrong type counts as absent, ids key Maps only, and nothing read from
// the rows is kept but the value returned.
import {
  agentOutcome, endKind, HANDBACK_TOOL, LOG_MAX, logText, parseTaskNotification, promptKind, shortType, SPAWN_TOOLS,
  stripFormat, tagText, TASK_END, taskFromCall, taskLine, toolLabel,
} from './stats'
import type { AgentRow, LogEntry, LogKind, TaskEndStatus, TaskRow } from './stats'

// The shape the walk reads from each row; the engine's SessionMessage fits it. Rows are untrusted: anything else is
// skipped field by field.
export type RestoreRow = { role: string; text: string; toolUses: readonly RestoreToolUse[]; toolResults?: unknown }
export type RestoreToolUse = {
  tool_use_id: string; tool: string; input: unknown; result?: unknown; text?: string; isError?: boolean
  agentId?: string; durationMs?: number
}
export type Restored = {
  agents: Record<string, AgentRow> // newest first
  tasks: Record<string, TaskRow> // newest first
  log: LogEntry[] // newest first, at most LOG_MAX (200)
  logCount: number // all lines built
}

// The longest model name a row keeps, in UTF-16 units: a longer one is no model's name.
const MODEL_MAX = 64
// The longest tool name a call keeps, in UTF-16 units (API names are 128 at most): toolLabel's pattern is quadratic.
const TOOL_NAME_MAX = 256

// A value read as a record of fields, or as a string; a value of another type counts as absent.
const fieldsOf = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
const textOf = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

// A restored Log line: no time is known.
const entry = (who: string, text: string, kind: LogKind, outcome?: string): LogEntry =>
  ({ at: null, who, text, kind, ...(outcome === undefined ? {} : { outcome }) })

// The Subagents, Tasks and Log that the rows tell, oldest to newest in one pass, from the row after the latest
// compaction summary. Each line is kept as its builder and only the newest LOG_MAX are built (cleaned); a row is
// cleaned once, when made. Restored rows have no clock: no start, no end time. `alive` holds the agents that still run.
export function restoreFromMessages(rows: readonly unknown[], alive: ReadonlySet<string>, root: string): Restored {
  const agents = new Map<string, AgentRow>()
  const tasks = new Map<string, TaskRow>()
  const lines: (() => LogEntry)[] = []
  let isAfterResults = false

  // An agent's end: its status (endedAt stays null) and its end line.
  const endAgent = (row: AgentRow, status: TaskEndStatus, durationMs: number | null, answer: string): void => {
    const ended: AgentRow = { ...row, status }
    agents.set(ended.id, ended)
    lines.push(() => {
      const { text, outcome } = agentOutcome(status, ended, durationMs, answer)

      return entry(shortType(ended.type), text, endKind(status), outcome)
    })
  }
  // Closes the task or the agent of that id, if the walk has it running.
  const close = (id: string, status: TaskEndStatus, durationMs: number | null, answer: string): void => {
    const task = tasks.get(id)
    const agent = agents.get(id)
    if (task?.status === 'running') {
      const closed: TaskRow = { ...task, status, durationMs }
      tasks.set(id, closed)
      lines.push(() => {
        const { text, kind, outcome } = taskLine(status, closed)

        return entry('main', text, kind, outcome)
      })
    } else if (agent?.status === 'running') {
      endAgent(agent, status, durationMs, answer)
    }
  }
  // A call of the main agent, as tool.call, agent.spawn and turn.complete draw it.
  const readCall = (use: Record<string, unknown>): void => {
    const tool = textOf(use.tool)
    if (tool === undefined || tool.length > TOOL_NAME_MAX) return
    const input = fieldsOf(use.input)
    const got = fieldsOf(use.result)
    const isError = use.isError === true
    const agentId = textOf(use.agentId)
    // The call's line: ✓ or ✗ with no time (no tool but Agent stores one), no outcome while it runs.
    const callLine = (background?: string): void => {
      const isAnswered = use.result !== undefined || use.text !== undefined
      const [kind, outcome]: [LogKind, string | undefined] = isError
        ? ['error', '✗']
        : background !== undefined ? ['ok', background] : isAnswered ? ['ok', '✓'] : ['info', undefined]
      lines.push(() => entry('main', logText(toolLabel(tool, input, root)), kind, outcome))
    }
    if (SPAWN_TOOLS.includes(tool) && agentId !== undefined) {
      const type = logText(textOf(input.subagent_type) ?? textOf(input.name) ?? 'agent')
      const description = logText(textOf(input.description) ?? '')
      const named = textOf(got.resolvedModel) ?? textOf(input.model)
      const model = named === undefined ? null : stripFormat(named)
      const row: AgentRow = {
        id: agentId, description, type,
        model: model !== null && model !== '' && model.length <= MODEL_MAX ? model : null,
        status: 'running', startedAt: null, endedAt: null, costUsd: null, restored: true,
      }
      // A repeated agentId re-opens the agent in its first place, as live agent.spawn writes over its row.
      agents.set(agentId, row)
      lines.push(() => entry('main', logText(`spawned · ${type}: ${description}`), 'info'))
      if (isError) {
        endAgent(row, 'failed', null, '')
        callLine()
      } else if (got.status === 'completed') {
        const ms = use.durationMs
        const durationMs = typeof ms === 'number' && Number.isSafeInteger(ms) && ms >= 0 ? ms : null
        endAgent(row, 'done', durationMs, textOf(use.text) ?? '')
      }
      return
    }
    const to = textOf(input.to)
    const isAgentCall = SPAWN_TOOLS.includes(tool) || tool === HANDBACK_TOOL ||
      (tool === 'SendMessage' && to !== undefined && agents.has(to))
    if (isAgentCall) {
      if (isError) callLine()
      return
    }
    // taskFromCall needs a clock: a restored task has no start.
    const task = isError ? null : taskFromCall(tool, input, use.result, 0)
    if (task !== null) {
      tasks.set(task.id, { ...task, startedAt: null })
      callLine('→ background')
    } else {
      callLine()
    }
    const stopId = tool === 'TaskStop' ? (textOf(input.task_id) ?? textOf(input.shell_id)) : undefined
    if (stopId !== undefined && !isError) close(stopId, 'stopped', null, '')
  }

  for (const row of rows) {
    const { role, text, toolUses, toolResults } = fieldsOf(row)
    const hasResults = Array.isArray(toolResults)
    if (role === 'user' && !hasResults && typeof text === 'string') {
      const shown = promptKind(text)
      if (shown.kind === 'summary') {
        // The list goes on from the latest summary: what came before it is the older conversation.
        agents.clear()
        tasks.clear()
        lines.length = 0
      } else if (shown.kind === 'prompt') {
        // A prompt right after tool results is one of the engine's mid-turn rows (a skill body or note), not typed.
        if (!isAfterResults) lines.push(() => entry('you', logText(shown.text), 'info'))
      } else if (shown.kind === 'tag' && (shown.tag === 'peer' || shown.tag === 'task-notification')) {
        // The close line first, then the engine's: live, prompt.submit closes the task before turn.start writes.
        const { tag } = shown
        const end = tag === 'task-notification' ? parseTaskNotification(shown.text) : null
        if (end !== null) close(end.id, TASK_END[end.status], end.durationMs, tagText(shown.text, 'result') ?? '')
        lines.push(() => entry('engine', tag, 'info'))
      }
    } else if (role === 'assistant' && Array.isArray(toolUses)) {
      for (const use of toolUses) readCall(fieldsOf(use))
    }
    isAfterResults = role === 'user' && hasResults
  }

  // What still runs at the end: an agent runs on only if the engine still has it; a task has ended, how is not known.
  for (const [id, row] of agents) {
    if (row.status === 'running' && !alive.has(id)) agents.set(id, { ...row, status: 'ended' })
  }
  for (const [id, row] of tasks) if (row.status === 'running') tasks.set(id, { ...row, status: 'ended' })

  return {
    agents: Object.fromEntries([...agents].reverse()),
    tasks: Object.fromEntries([...tasks].reverse()),
    log: lines.slice(-LOG_MAX).reverse().map(build => build()),
    logCount: lines.length,
  }
}

// The rows before the turn that `text` opened: its opening row is the last user row without tool results that is a
// prompt or a tag, and when its text is the turn's, it and every later row go. Else the rows come back whole: an older
// identical prompt is never the cut point. A prompt right after tool results opens no turn (the walk's rule), so a
// skill body that the turn adds later cannot hide its opening row.
export function cutAtTurn(rows: readonly unknown[], text: string): readonly unknown[] {
  const wanted = promptKind(text)
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const { role, text: said, toolResults } = fieldsOf(rows[i])
    if (role === 'user' && !Array.isArray(toolResults) && typeof said === 'string') {
      const shown = promptKind(said)
      const before = fieldsOf(rows[i - 1])
      const isMidTurn = shown.kind === 'prompt' && before.role === 'user' && Array.isArray(before.toolResults)
      if (!isMidTurn && (shown.kind === 'prompt' || shown.kind === 'tag')) {
        const isTurn = (wanted.kind === 'prompt' || wanted.kind === 'tag') && wanted.text === shown.text

        return isTurn ? rows.slice(0, i) : rows
      }
    }
  }

  return rows
}
