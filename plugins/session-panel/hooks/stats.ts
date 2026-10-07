// Pure helpers of the session-panel mod: turn stats, interval merging, cost attribution, the log ring,
// redaction and display formats. It imports nothing from the engine and never takes `$`, so every
// function can be tested on its own.

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
  // The first stream chunk of any kind, the engine's envelope chunks included.
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
export type CostSplit = { total: number | null; session: number | null; subagents: number }

const MAX_RATE = 5000 // tok/s; anything above is an artefact, not a measurement

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)
const pad2 = (n: number): string => String(n).padStart(2, '0')

// Length of the union of the intervals: overlapping and nested ones count once.
// Tool time formula after OpenChamber (MIT, © 2025 Bohdan Triapitsyn).
export function mergedLength(intervals: Interval[]): number {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0])
  let total = 0
  let reached = -Infinity
  for (const [start, end] of sorted) {
    if (end > reached) {
      total += end - Math.max(start, reached)
      reached = end
    }
  }
  return total
}

const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const

// Sums the four token counters; the cache_creation breakdown is not needed by any formula.
export function sumUsage(usages: Usage[]): Usage {
  const total: Usage = {}
  for (const key of USAGE_KEYS) total[key] = sum(usages.map(u => u[key] ?? 0))
  return total
}

// Share of the input served from the cache, in percent; null when there was no input at all.
// Cache formula after OpenChamber (MIT, © 2025 Bohdan Triapitsyn).
export function cacheHitPct(u: Usage): number | null {
  const read = u.cache_read_input_tokens ?? 0
  const input = (u.input_tokens ?? 0) + read + (u.cache_creation_input_tokens ?? 0)
  return input > 0 ? (read / input) * 100 : null
}

// Tokens per second over the window; null for an empty window or an implausible rate.
function rate(tokens: number, windowMs: number): number | null {
  const perSecond = tokens / (windowMs / 1000)
  return windowMs > 0 && perSecond <= MAX_RATE ? perSecond : null
}

// Turn stats formulas after OpenChamber (MIT, © 2025 Bohdan Triapitsyn).
export function computeTurnStats(
  acc: TurnAcc,
  durationMs: number,
  usage: Usage | undefined,
  costNow: number | null,
): TurnStats {
  const { steps } = acc
  const stepsUsage = sumUsage(steps.map(s => s.usage))
  const total = usage ?? stepsUsage
  const modelMs = sum(steps.map(s => s.tEnd - s.tStart))
  const ttfts = steps.flatMap(s => (s.tFirst === null ? [] : [s.tFirst - s.tStart]))
  const last = steps[steps.length - 1]
  return {
    elapsedMs: durationMs,
    modelMs,
    toolMs: mergedLength(acc.toolIntervals),
    steps: steps.length,
    // Unknown as soon as one step has no first chunk.
    ttftMs: steps.length > 0 && ttfts.length === steps.length ? sum(ttfts) / steps.length : null,
    wholeTurnRate: rate(stepsUsage.output_tokens ?? 0, modelMs),
    // Only a closing text answer (no tool call) counts. Its window is the whole request, from the send to the stop:
    // the text sometimes arrives as one burst, and a window from the first chunk read ~3000 tok/s on the live desktop.
    responseRate:
      last !== undefined && !last.hasTool && last.hasText
        ? rate(last.usage.output_tokens ?? 0, last.tEnd - last.tStart)
        : null,
    tokensIn: total.input_tokens ?? 0,
    tokensOut: total.output_tokens ?? 0,
    cachePct: cacheHitPct(total),
    costUsd: costNow !== null && acc.costAtStart !== null ? costNow - acc.costAtStart : null,
  }
}

// The cost reading never goes back, so the delta is clamped and the high-water mark kept.
export function attributeCost(lastUsd: number, usd: number): { delta: number; lastUsd: number } {
  return { delta: Math.max(0, usd - lastUsd), lastUsd: Math.max(lastUsd, usd) }
}

export function addAgentCost(row: AgentRow, deltaUsd: number): AgentRow {
  return { ...row, costUsd: (row.costUsd ?? 0) + deltaUsd }
}

// Session and Subagents cost formula after OpenChamber (MIT, © 2025 Bohdan Triapitsyn).
export function splitCost(totalUsd: number | undefined, subagentsUsd: number): CostSplit {
  return {
    total: totalUsd ?? null,
    session: totalUsd === undefined ? null : Math.max(0, totalUsd - subagentsUsd),
    subagents: subagentsUsd,
  }
}

// Running agents first, then the newest start first; the input is left as it was.
export function orderAgents(rows: AgentRow[]): AgentRow[] {
  const rank = (r: AgentRow): number => (r.status === 'running' ? 0 : 1)
  return [...rows].sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt)
}

// Newest first, capped at 60 entries unless `max` says otherwise.
export function pushLog(log: LogEntry[], entry: LogEntry, max?: number): LogEntry[] {
  return [entry, ...log].slice(0, max ?? 60)
}

export const TYPE_MAX = 14 // the most the `who` column of the log takes

// The agent type without its plugin prefix, at most 14 characters: a longer one is cut to 13 and ends in an ellipsis.
export function shortType(type: string): string {
  const name = type.slice(type.lastIndexOf(':') + 1)

  return name.length > TYPE_MAX ? `${name.slice(0, TYPE_MAX - 1)}…` : name
}

// The patterns below are copied verbatim from claude-flightdeck/hooks/core.ts, commit f31daca
// (MIT, Copyright (c) 2026 Stephen Casella, https://github.com/scasella/claude-flightdeck).
const SECRETS: [RegExp, string][] = [
  [/(authorization\s*[:=]\s*)(bearer\s+|basic\s+)?\S+/gi, '$1$2•••'],
  [/\b(bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, '$1 •••'],
  [/\b(sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{8,}/g, '•••'],
  [
    /((?:api[_-]?key|access[_-]?token|token|secret|password|passwd|pwd)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    '$1•••',
  ],
  [/(--(?:token|password|api-key|secret)[= ])\S+/gi, '$1•••'],
  [/(\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)=)\S+/g, '$1•••'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s@]+@/gi, '$1•••@'],
]

export function redact(s: string): string {
  return SECRETS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), s)
}

// Collapses whitespace runs and cuts to `max` characters, the last one being an ellipsis.
export function shorten(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const relativeTo = (path: string, root: string): string =>
  path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

// The log line of a tool call, before the ✓/✗ suffix.
export function toolLabel(tool: string, input: Record<string, unknown>, root: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (mcp) return `${mcp[1]}:${mcp[2]}`
  switch (tool) {
    case 'Bash':
      return `Bash ${str(input.command)}`
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return `${tool} ${relativeTo(str(input.file_path), root)}`
    case 'NotebookEdit':
      return `${tool} ${relativeTo(str(input.notebook_path), root)}`
    case 'Grep':
    case 'Glob':
      return `${tool} ${str(input.pattern)}`
    case 'WebFetch':
      return `WebFetch ${hostOf(str(input.url))}`
    case 'WebSearch':
      return `WebSearch ${str(input.query)}`
    case 'Agent':
    case 'Task':
      return `Agent → ${str(input.subagent_type, 'agent')}: ${str(input.description)}`
    default:
      return tool
  }
}

export function fmtUsd(x: number): string {
  if (x === 0) return '$0'
  if (x < 0.001) return '<$0.001'
  return x >= 1 ? `$${x.toFixed(2)}` : `$${x.toFixed(3)}`
}

export function fmtPct(x: number, digits: 0 | 1): string {
  return `${x.toFixed(digits)}%`
}

// Number() drops a trailing ".0" ('1.0' -> 1). The thousands branch is decided after rounding,
// so 999.6k becomes 1M instead of '1000k'.
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10000) return `${Number((n / 1000).toFixed(1))}k`
  if (Math.round(n / 1000) < 1000) return `${Math.round(n / 1000)}k`
  return `${Number((n / 1000000).toFixed(1))}M`
}

// The unit is picked after rounding to 0.1 s, so 59.96 s is '1m 00s' and never '60.0s'.
export function fmtDuration(ms: number): string {
  const tenths = Math.round(ms / 100)
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`
  const seconds = Math.round(ms / 1000)
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${pad2(m)}m` : `${m}m ${pad2(seconds % 60)}s`
}

export function fmtTtft(ms: number): string {
  return ms < 100 ? '<0.1s' : fmtDuration(ms)
}

export function fmtRate(tokPerSec: number): string {
  return `~${Math.round(tokPerSec)} tok/s`
}

// Countdown format after Desktop Statusline (MIT, George Liu).
export function fmtCountdown(msUntil: number): string {
  if (msUntil <= 0) return '↻ now'
  const minutes = Math.ceil(msUntil / 60000)
  if (minutes < 60) return `↻ ${minutes}m`
  if (minutes < 1440) return `↻ ${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return `↻ ${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`
}

// Local time, HH:MM:SS.
export function fmtClock(ms: number): string {
  const d = new Date(ms)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(pad2).join(':')
}
