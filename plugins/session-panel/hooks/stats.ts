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
export type LogKind = 'info' | 'ok' | 'error'
export type LogEntry = { at: number; who: string; text: string; kind: LogKind; outcome?: string }
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

// All the input that was sent: the tokens that were not cached, those read from the cache and those written to it.
function inputTokens(u: Usage): number {
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
}

// The input that was sent at full price or more: the tokens that were not cached and those written to the cache (a
// write costs more than a plain token). What was read from the cache is cheap and is left out.
function fullPriceTokens(u: Usage): number {
  return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
}

// Share of the input served from the cache, in percent; null when there was no input at all.
// Cache formula after OpenChamber (MIT, © 2025 Bohdan Triapitsyn).
export function cacheHitPct(u: Usage): number | null {
  const input = inputTokens(u)
  return input > 0 ? ((u.cache_read_input_tokens ?? 0) / input) * 100 : null
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
    tokensIn: fullPriceTokens(total),
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

export const TYPE_MAX = 14 // the most an agent type takes: the log's `who`; the `@type` column adds the `@`

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

// Whether the character beside a joiner holds it: one above U+007F that is no space. A space is what `\s` says, as in
// the patterns of redact, so the no-break space and the wide ones are spaces. The character is read as one UTF-16 unit:
// every unit of an astral code point is above U+007F (a surrogate), so the unit beside a joiner tells what the
// character is. No unit, past an end of the text, holds nothing.
const holdsJoiner = (char: string | undefined): boolean =>
  char !== undefined && char.charCodeAt(0) > 0x7f && !/\s/.test(char)

// The tag characters (U+E0020 to U+E007F, category Cf) are ASCII made invisible: the tag character of a letter is
// U+E0000 plus the code of the letter.
const tagged = (word: string): string =>
  [...word].map(letter => String.fromCodePoint(0xe0000 + letter.charCodeAt(0))).join('')

// The flags that stay whole: England, Scotland and Wales, each the black flag (U+1F3F4), the tag characters that spell
// `gbeng`, `gbsct` or `gbwls`, and the cancel tag (U+E007F). Only these three: the tag characters can carry ASCII that
// nothing draws (a word, an instruction), and these are the only subdivision flags of the RGI emoji (Recommended for
// General Interchange). Any other tag character goes, and the black flag before it stays alone.
const KEPT_FLAGS = ['gbeng', 'gbsct', 'gbwls'].map(code => `\u{1F3F4}${tagged(code)}\u{E007F}`)

// Either a whole flag of KEPT_FLAGS (group 1) or a format character that is neither joiner.
const FORMAT_OR_FLAG = new RegExp(String.raw`(${KEPT_FLAGS.join('|')})|(?![\u200C\u200D])\p{Cf}`, 'gu')

// Takes out the Unicode format characters (category Cf): the bidi controls (U+202A to U+202E, U+2066 to U+2069), the
// zero-width space, the byte order mark and the rest. They draw nothing, so a U+202E in a branch or a file name would
// reorder what the pane shows after it, and the name would read as another. Two stay, but only between two characters
// that are neither ASCII nor spaces: the zero-width joiner (U+200D) holds an emoji sequence together (a family is three
// emoji with a joiner between each two), and the non-joiner (U+200C) sits inside Persian words; both shape letters of
// Indic scripts. Beside an ASCII character, a space of any kind or an end of the text, a joiner joins nothing and draws
// nothing, and it would hide a character of a branch or a folder name, or split a secret so that no pattern of redact
// matches it (a key and its value have `\s*` between them, and a joiner between two no-break spaces there would end the
// value before it starts): it goes. Its neighbours are those that remain once the rest of Cf is gone (a zero-width
// space beside it does not make it stay), and a run of joiners stays or goes as a whole. The run is matched once and
// judged by what is round it: a lookbehind and lookahead pair would read the run again from each of its joiners. The
// three flags that stay (KEPT_FLAGS) are matched in the same pass, a whole sequence or one format character at a time,
// so a long run of tag characters is read once as well.
export function stripFormat(s: string): string {
  // A flag is put back as it is (`$1`); the group of a character that goes did not match, and `$1` reads it as empty.
  const rest = s.replace(FORMAT_OR_FLAG, '$1')

  return rest.replace(/[\u200C\u200D]+/g, (run, at: number) =>
    holdsJoiner(rest[at - 1]) && holdsJoiner(rest[at + run.length]) ? run : '')
}

// The format characters go first, as shorten takes them out too: one inside a secret would keep a pattern from
// matching, and the secret would show once shorten had closed the gap.
export function redact(s: string): string {
  return SECRETS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), stripFormat(s))
}

// Takes the markdown marks out of a text that the pane shows as it is: a pair of `**` around text on one line, which is
// kept (its first and last characters are no spaces) and which no ASCII letter, digit or `_` touches on the outside;
// backticks (code); and the `#` marks of a heading at the start of a line, with the space after them. A `**` that
// stands alone, has a space beside it or is glued to an ASCII word stays (`x ** 2`; the `**` of `2**10 and 3**4` are
// exponents, no pair), and so does `__`: `__init__.py` is a file, not bold. Only ASCII keeps a pair, for exponents in
// code are ASCII: in scripts written without spaces (Chinese, Japanese, Thai) and inside words of other scripts
// (Cyrillic, Hindi) bold is glued to letters, and markdown reads it as bold, so its marks go.
export function plainText(s: string): string {
  // The group inside the pair is lazy (`??`): a body of one character closes at its own `**`, not at the next pair's.
  // The lookbehind and the lookahead keep out a `**` that an ASCII word character (`\w`) touches on the outside of it.
  const pair = /(?<!\w)\*\*(\S(?:.*?\S)??)\*\*(?!\w)/gu

  return s.replace(pair, '$1').replace(/`/g, '').replace(/^#+ /gm, '')
}

// Takes out the format characters (stripFormat), collapses whitespace runs and cuts to `max` characters, the last one
// being an ellipsis.
export function shorten(s: string, max: number): string {
  const flat = stripFormat(s).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// The first `max` UTF-16 units of a text, for the passes that read a text whole (the pair pattern of plainText takes
// quadratic time on some long inputs) when the pane shows a few dozen characters of it. A cut between the two units of
// a surrogate pair would leave the high one alone, and a lone surrogate is no character, so that unit goes too. A text
// of `max` units or fewer comes back as it is.
export function textHead(s: string, max: number): string {
  if (s.length <= max) return s
  const head = s.slice(0, max)
  const last = head.charCodeAt(max - 1)

  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head
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

// The log line of a tool call: what it did. How it went is the outcome of the entry, a field of its own.
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

// The entries of `git status --porcelain -z`: `XY path`, the two status letters, a space and the path, each ended by a
// NUL. A rename or a copy (an R or a C in either letter) is followed by a field that is not an entry: the path it came
// from. `files` counts the entries; `newFiles` are the untracked ones (`??`), less a nested repository, which git lists
// as a folder (`dir/`) and which has no lines to count.
export function parseStatus(stdout: string): { files: number; newFiles: string[] } {
  const fields = stdout.split('\0')
  const newFiles: string[] = []
  let files = 0
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i] ?? ''
    // The output ends with a NUL, so the last field is empty; any other empty one is no entry either.
    if (field !== '') {
      files += 1
      const status = field.slice(0, 2)
      const path = field.slice(3)
      if (/[RC]/.test(status)) i += 1 // the next field is the original path
      else if (status === '??' && !path.endsWith('/')) newFiles.push(path)
    }
  }

  return { files, newFiles }
}

// The lines of `git diff --numstat`, one per file: `added<TAB>removed<TAB>path`, a rename as `a => b`. The first two
// fields are summed. A binary file has a `-` for each, and a line that is not of this form has no fields to read: they
// add nothing, and neither does any count that is not a whole number.
export function sumNumstat(stdout: string): { added: number; removed: number } {
  const count = (field: string | undefined): number => (field !== undefined && /^\d+$/.test(field) ? Number(field) : 0)
  let added = 0
  let removed = 0
  for (const line of stdout.split('\n')) {
    const fields = line.split('\t')
    if (fields.length >= 3) {
      added += count(fields[0])
      removed += count(fields[1])
    }
  }

  return { added, removed }
}

export function fmtUsd(x: number): string {
  if (x === 0) return '$0'
  if (x < 0.001) return '<$0.001'
  // The branch follows the rounding: 0.9996 is $1.000 at three decimals, so it takes two.
  return Number(x.toFixed(3)) >= 1 ? `$${x.toFixed(2)}` : `$${x.toFixed(3)}`
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
