// Contract of the session-panel state: the named values (`$.state`) that register.tsx writes and the view reads.
// The engine wants this file self-contained (no import), so the types of hooks/stats.ts are mirrored below.
// register.tsx passes values between the two sets of types and register.test.ts compares them, so tsc flags any drift.

export type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
}
export type Interval = [start: number, end: number]
export type StepTiming = {
  tStart: number
  tFirst: number | null
  tEnd: number
  usage: Usage
  hasTool: boolean
  hasText: boolean
}
export type TurnAcc = {
  turnId: string
  startedAt: number
  costAtStart: number | null
  steps: StepTiming[]
  toolIntervals: Interval[]
}
export type TurnStats = {
  elapsedMs: number
  modelMs: number
  toolMs: number
  steps: number
  ttftMs: number | null
  wholeTurnRate: number | null
  responseRate: number | null
  // The input the turn sent at full price or more: what was not cached and what was written to the cache. What it read
  // from the cache is cheap, so it is left out (cachePct still counts it).
  tokensIn: number
  tokensOut: number
  cachePct: number | null
  costUsd: number | null
}
export type AgentStatus = 'running' | 'done' | 'failed' | 'stopped'
export type AgentRow = {
  id: string
  description: string
  type: string
  model: string | null
  status: AgentStatus
  startedAt: number
  endedAt: number | null
  costUsd: number | null
}
export type TaskKind = 'shell' | 'monitor' | 'workflow'
// `ended`: the task is over, and how it ended is not known.
export type TaskStatus = 'running' | 'done' | 'failed' | 'stopped' | 'ended'
export type TaskRow = {
  id: string
  kind: TaskKind
  description: string
  status: TaskStatus
  // Null for a task that began before the mod saw it: its start, and so its time, is not known.
  startedAt: number | null
  endedAt: number | null
  durationMs: number | null
}
export type LogKind = 'info' | 'ok' | 'error'
export type LogEntry = { at: number; who: string; text: string; kind: LogKind; outcome?: string }

export type PanelRateLimit = { kind: string; percentUsed: number; resetsAt?: number }
export type PanelUsage = {
  contextTokens?: number
  contextWindow?: number
  contextPct?: number
  costUsd?: number
  rateLimits: PanelRateLimit[]
  skills?: number
}
// What differs from HEAD in the working tree, as `git status` and `git diff` report it.
export type PanelChanges = {
  // The files that changed: modified, added, deleted, renamed and new ones, each counted once.
  files: number
  // True when the output of `git status` was cut (git's output has a limit): `files` then counts its complete entries
  // only, so it is a lower bound, and `lines` is null. Absent when `files` is exact.
  hasMoreFiles?: true
  // The lines added and removed, those of the new files included up to the limit that NEW_FILES_MAX in register.tsx
  // sets, and as far as they can be counted (hasMoreAdded); null when the counts are unknown, as on an unborn HEAD,
  // after a diff that failed or was not made (the budget of the read, READ_BUDGET_MS, was spent) or after a cut status.
  // The new files alone never make them null: when they cannot be counted, the lines of the diff stand.
  lines: {
    added: number
    removed: number
    // True when new files past that limit, a new file whose count failed, new files that the budget of the read left no
    // time to count, or all of them, as the top of the repository could not be had, add no lines: `added` is then a
    // lower bound. Absent when `added` is exact.
    hasMoreAdded?: true
  } | null
}
export type PanelProject = {
  // The folder of the session root.
  name: string
  // The branch; the short commit on a detached HEAD; null outside a git repository or when git fails.
  branch: string | null
  // Null when there is nothing to show: outside a git repository, on a clean tree, or when git failed. Also null from
  // the moment the name changes until the changes of the new folder are read: a count is never kept under another name.
  // And null where they are not read: before the first turn of the main agent, and for a folder whose reads had a
  // `git status`, or a `git diff` against HEAD, that threw (a timeout, or git that cannot be started) twice in a row:
  // it is left unread until 15 minutes pass, then one read tries again (READ_RETRY_MS in register.tsx).
  changes: PanelChanges | null
}
export type PanelMcp = { servers: { name: string }[] }

declare module 'claude-code' {
  interface PluginState {
    'session-panel': {
      usage: PanelUsage
      project: PanelProject
      mcp: PanelMcp | null
      turn: TurnAcc | null
      lastTurn: TurnStats | null
      agents: Record<string, AgentRow>
      // The background tasks that the main agent started, by id; a /clear or a resume empties them.
      tasks: Record<string, TaskRow>
      log: LogEntry[]
      // Every line put on the log since it was last emptied (a /clear or a resume); `log` keeps the newest 200.
      logCount: number
      collapsed: Record<string, boolean>
    }
  }
}
