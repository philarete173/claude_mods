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
  // The lines added and removed, those of the new files included up to the limit that NEW_FILES_MAX in register.tsx
  // sets; null when the counts are unknown, as on an unborn HEAD or after a diff that failed.
  lines: { added: number; removed: number } | null
}
export type PanelProject = {
  // The folder of the session root.
  name: string
  // The branch; the short commit on a detached HEAD; null outside a git repository or when git fails.
  branch: string | null
  // Null when there is nothing to show: outside a git repository, on a clean tree, or when git failed. Also null from
  // the moment the name changes until the changes of the new folder are read: a count is never kept under another name.
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
      log: LogEntry[]
      collapsed: Record<string, boolean>
    }
  }
}
