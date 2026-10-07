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
export type LogEntry = { at: number; who: string; text: string; kind: LogKind }

export type PanelRateLimit = { kind: string; percentUsed: number; resetsAt?: number }
export type PanelUsage = {
  contextTokens?: number
  contextWindow?: number
  contextPct?: number
  costUsd?: number
  rateLimits: PanelRateLimit[]
  skills?: number
}
export type PanelProject = { name: string; branch: string | null }
export type PanelMcpStatus = 'connected' | 'failed' | 'needsAuth' | 'pending' | 'disabled'
export type PanelMcp = { servers: { name: string; status: PanelMcpStatus }[]; exact: boolean }

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
