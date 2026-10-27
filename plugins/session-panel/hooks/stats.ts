// Pure helpers of the session-panel mod: turn stats, interval merging, cost attribution, the log ring, background
// tasks, redaction and display formats. It imports nothing from the engine and never takes `$`, so every function can
// be tested on its own.

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
// `ended`: the subagent is over, and how it ended is not known (a restored row).
export type AgentStatus = 'running' | 'done' | 'failed' | 'stopped' | 'ended'
export type AgentRow = {
  id: string
  description: string
  type: string
  model: string | null
  status: AgentStatus
  // Null for a start that is not known (a restored row). Rows are drawn newest first, a row of no known start last of
  // its group.
  startedAt: number | null
  endedAt: number | null
  costUsd: number | null
  // Marks a row rebuilt from the session's messages: its cost before the restore is not known, so a cost it has is
  // the cost since.
  restored?: true
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
  // True when `durationMs` is a bound: it ran from the start to the arrival of the task's notice, which can come later
  // than the end of the task, so the task ran at most that long. Absent when the time is exact.
  durationAtMost?: true
}
// What the notification of a task says: its id, how it ended in the engine's words, and how long it ran, if it says.
export type TaskEnd = { id: string; status: 'completed' | 'failed' | 'killed' | 'stopped'; durationMs: number | null }
export type LogKind = 'info' | 'ok' | 'error'
// `at` is null for a line whose time is not known (a restored line).
export type LogEntry = { at: number | null; who: string; text: string; kind: LogKind; outcome?: string }
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

// The order of the Subagents and of the Tasks: the rows that run first, then the newest start first; a row of no known
// start goes last of its group. The input is left as it was.
function orderByStart<T extends { status: string; startedAt: number | null }>(rows: T[]): T[] {
  const rank = (r: T): number => (r.status === 'running' ? 0 : 2) + (r.startedAt === null ? 1 : 0)
  return [...rows].sort((a, b) => rank(a) - rank(b) || (b.startedAt ?? 0) - (a.startedAt ?? 0))
}

export const orderAgents = (rows: AgentRow[]): AgentRow[] => orderByStart(rows)

export const LOG_MAX = 200 // the most lines the Log keeps: the newest ones

// Newest first, capped at LOG_MAX entries unless `max` says otherwise.
export function pushLog(log: LogEntry[], entry: LogEntry, max?: number): LogEntry[] {
  return [entry, ...log].slice(0, max ?? LOG_MAX)
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

// Whether the character beside a joiner, or beside a run of invisibles, holds it: one above U+007F that is no space. A
// space is what `\s` says, as in the patterns of redact, so the no-break space and the wide ones are spaces. The
// character is read as one UTF-16 unit: every unit of an astral code point is above U+007F (a surrogate), so the unit
// beside a run tells what the character is. No unit, past an end of the text, holds nothing.
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

// Either a whole flag of KEPT_FLAGS (group 1), or a format character that is neither joiner, or a whole escape
// sequence, or a control character (C0 but tab, line feed and carriage return, DEL and C1), or U+10EEEE, the
// placeholder that the engine keeps for itself, or a lone surrogate: the engine refuses a pane whose text holds a
// control character or the placeholder, and a removal between the two halves of U+10EEEE would join them into it. A
// sequence goes whole, so that no `31m` or `(B` is left glued to the word after it, where it would hide a token from
// the `\b` of SECRETS (`Bearer`, `ghp_`). It is a control string (an OSC, a DCS, a SOS, a PM or an APC, 7-bit with
// `ESC` or 8-bit with one C1 character, up to its BEL, `ESC \` or U+009C on the same line), a CSI (7-bit, or 8-bit with
// a parameter or an intermediate byte), an nF escape (`ESC`, the intermediate bytes that a terminal's output uses, a
// final byte: the `ESC ( B` that `tput sgr0` ends in) or an escape of two bytes (`ESC` followed by `7`, `8`, `=`, `>`,
// `[`, `\`, `]`, `^` or `_`; any other byte after a stray ESC stays). They come before the class of control characters,
// which would take the ESC alone. A stray ESC or U+009B goes alone, so that it cannot take the first letter of a token
// with it: `ESC c` and `ESC M` are no two-byte escape here, a space or `-` right after an ESC is no intermediate byte
// (in the 7-bit form only: right after U+009B each is one), and U+009B before a letter is no CSI. Crafted input can
// still lose a letter: `ESC (` before a letter is an nF escape that ends at it, and U+009B with a parameter or an
// intermediate byte (a space, `-`) before a letter is a CSI that does, so `\x1b(ghp_…` reads `hp_…`, `x \x9b Bearer …`
// reads `x earer …` and `\x9b--token x` reads `oken x`; the mask leaves that gap, as it leaves `ESC[Bearer`. A control
// string with no terminator loses its introducer, and its body
// stays, unlike a terminal, which would swallow the text up to a terminator; but `ESC P` and `ESC X` are no two-byte
// escape here, so for a DCS or a SOS the ESC alone goes and the letter stays (`aPq`, `aXx`). The body ends at a line
// end (`\n` or `\r`) too, so that a lone introducer cannot take whole lines up to a BEL or an ST far below it. `ESC [`
// followed by a letter is a whole CSI (the letter is its final byte), so `ESC[Bearer x` reads `earer x` as a terminal
// shows it, a gap that the mask leaves. The pass stays linear (each part of a sequence is read once): the body of a
// control string and the parameters of a CSI stop at the next introducer, terminator or line end.
const FORMAT_OR_FLAG = new RegExp(
  String.raw`(${KEPT_FLAGS.join('|')})|(?![\u{200C}\u{200D}])\p{Cf}` +
    String.raw`|(?:\x1b[\]PX^_]|[\x90\x98\x9d-\x9f])[^\x07\x1b\x90\x98\x9c-\x9f\n\r]*(?:\x07|\x1b\\|\x9c)` +
    String.raw`|\x1b\[[0-?]*[ -/]*[@-~]|\x9b(?:[0-?]+[ -/]*|[ -/]+)[@-~]` +
    String.raw`|\x1b[#$%()*+]+[0-~]|\x1b[78=>\[\\\]^_]` +
    String.raw`|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]|\u{10EEEE}|\p{Cs}`,
  'gu',
)

// Joiners and invisibles, one run at a time, judged by what is round the run once the rest has gone (see stripFormat).
// A run is the joiners, the default ignorable code points that are no Cf (the first pass has taken the rest of Cf but
// the tag characters of a kept flag, which remain after it: `(?!\p{Cf})` keeps them out of a run), and four more: the
// braille blank (U+2800), the Khitan small script filler (U+16FE4), the Tifinagh consonant joiner (U+2D7F) and the
// enclosing keycap (U+20E3). A match takes 4096 code points at most: a `+` over an alternation keeps one backtrack
// entry per repetition, and a run of millions overflows the stack in Node. stripFormat joins the matches that touch.
const INVISIBLE_RUN = new RegExp(
  String.raw`(?:[\u{200C}\u{200D}]|(?!\p{Cf})\p{Default_Ignorable_Code_Point}` +
    String.raw`|[\u{2800}\u{16FE4}\u{2D7F}\u{20E3}]){1,4096}`,
  'gu',
)
// A run with a joiner in it is judged as a joiner is: it stays only between two characters that holdsJoiner accepts.
const HAS_JOINER = /[\u{200C}\u{200D}]/u
// What a keycap stands on: a digit, `#` or `*`.
const KEYCAP_BASE = /^[0-9#*]$/
// A character of a word, or of a `sk-` or `ghp_` token: letters, digits, `_` and `-` (`\w` lacks the `-`).
const ASCII_WORD = /^[A-Za-z0-9_-]$/
// A character that a Bearer token can hold, the widest token alphabet of SECRETS: a keycap tail before one goes.
const BEARER_CHAR = /^[A-Za-z0-9._~+/-]$/
// What closes a keycap: U+FE0F U+20E3, or U+20E3 alone.
const KEYCAP_TAIL = new Set(['\u{FE0F}\u{20E3}', '\u{20E3}'])
// Whether the last unit of `tail` is the base of a keycap (a digit, `#` or `*`) that stands alone on its left: one that
// an ASCII word touches is part of that word, and a mark after it is no keycap (a digit in a token, then U+FE0F
// U+20E3). It judges the left side only; the run pass checks the right side (no token character after the keycap).
const isKeycapBase = (tail: string): boolean =>
  KEYCAP_BASE.test(tail.slice(-1)) && !ASCII_WORD.test(tail.slice(-2, -1))

// Takes out the control characters and the Unicode format characters (category Cf): the bidi controls (U+202A to
// U+202E, U+2066 to U+2069), the zero-width space, the byte order mark and the rest. They draw nothing, so a U+202E in
// a branch or a file name would reorder what the pane shows after it, and the name would read as another. Two stay, but
// only between two characters that are neither ASCII nor spaces: the zero-width joiner (U+200D) holds an emoji sequence
// together (a family is three emoji with a joiner between each two), and the non-joiner (U+200C) sits inside Persian
// words; both shape letters of Indic scripts. Beside an ASCII character, a space of any kind or an end of the text, a
// joiner joins nothing and draws nothing, and it would hide a character of a branch or a folder name, or split a secret
// so that no pattern of redact matches it (a key and its value have `\s*` between them, and a joiner between two
// no-break spaces there would end the value before it starts): it goes. Its neighbours are those that remain once the
// rest of Cf is gone (a zero-width space beside it does not make it stay), and a run of joiners stays or goes as a
// whole. The run is matched once and judged by what is round it: a lookbehind and lookahead pair would read the run
// again from each of its joiners. The three flags that stay (KEPT_FLAGS) are matched in the same pass, a whole flag
// or one format character at a time, so a long run of tag characters is read once as well. The control characters go in
// the same pass (C0 but tab, line feed and carriage return, DEL and C1), and a joiner's neighbours are those that
// remain without them too: the engine refuses a text child that holds one (an escape sequence pasted from a terminal
// has them) and draws its own pane in place of the mod's. They are taken out, not turned into spaces, as a format
// character is, so that a secret that one splits (a URL password, a `password=` value, an `sk-` key) stays whole for
// redact; the vertical tab and the form feed alone are whitespace, and become a space, as shorten made them before, so
// that the words on either side stay apart. U+10EEEE goes too, in the same pass: it is the placeholder that the engine
// keeps for itself, and the engine refuses a text child that holds it, as it refuses one that holds a control
// character. A lone surrogate goes too (a pair is one code point, and stays): a removal between the two halves of
// U+10EEEE would join them into that placeholder. An escape sequence goes whole, not its ESC alone (a CSI, an OSC and
// the other control strings, an nF escape such as `ESC ( B`, an escape of two bytes such as `ESC 7`): a coloured log
// reads as its text, and no `31m` or `(B` is left glued to the word after it, where it would hide a token from the
// `\b` of a pattern of redact (`Bearer`, `ghp_`). A stray ESC or U+009B goes alone, so that it cannot take the first
// letter of a token (crafted input still can: `ESC (`, or U+009B with a parameter or an intermediate byte (a space,
// `-`), before a letter takes that letter, so `\x1b(ghp_…` reads `hp_…`, `x \x9b Bearer …` reads `x earer …` and
// `\x9b--token x` reads `oken x`: a gap that the mask leaves). A control string with no terminator loses its
// introducer, and its body stays, unlike a terminal, which would swallow the text up to a terminator (`ESC P` and
// `ESC X` are no two-byte escape here: the ESC alone goes and the letter stays); the body ends at a line end, so that
// a lone introducer takes no whole lines. `ESC [` followed by a letter is a whole CSI (the letter is its final byte),
// so `ESC[Bearer x` reads `earer x` as a terminal shows it, a gap that the mask leaves too. The pass stays linear: each
// part of a sequence is read once. The invisible characters that are no Cf (the combining grapheme joiner U+034F, the
// variation selectors, the fillers, the braille blank, the enclosing keycap U+20E3) go too, in a second pass over runs
// of them and of the joiners: they go unless they modify a character above U+007F (an emoji's U+FE0F) or close a keycap
// (`1` U+FE0F U+20E3) that stands apart, with no ASCII word character before its digit and no character of a Bearer
// token after its marks (keycaps glued to one another or to a word lose their marks). An invisible beside an ASCII
// character would split a token, so that no pattern of redact matches its two halves.
export function stripFormat(s: string): string {
  // A flag (group 1) is put back as it is; a vertical tab and a form feed become a space, any other match goes.
  const rest = s.replace(FORMAT_OR_FLAG, (found, flag: string | undefined) =>
    flag ?? (found === '\x0b' || found === '\x0c' ? ' ' : ''))

  // A run of joiners and invisibles is judged once, by the characters that remain round it. A run with a joiner in it
  // stays only between two characters above U+007F that are no spaces; one with none stays after such a character (the
  // base it modifies: an emoji's U+FE0F), and after a digit, `#` or `*` that no ASCII word character touches when it is
  // the keycap tail (U+FE0F U+20E3, or U+20E3) and no character a Bearer token can hold follows it either: a token can
  // begin with a digit (`Bearer 4` U+20E3 `/3Q7x…`), so keycaps glued to one another or to a word lose their marks. The
  // characters round it are those that remain, so that one that goes cannot shield an invisible, and a second pass
  // takes out nothing more.
  const parts: string[] = []
  // The last two UTF-16 units kept so far: a run is judged by them. Indexing into a string that is built up would
  // flatten it at each run, which takes quadratic time.
  let tail = ''
  let from = 0
  // The run pending, rest[runStart, runEnd), and whether it holds a joiner. A match that starts where the pending run
  // ends goes on with it (INVISIBLE_RUN takes 4096 code points at most), so a run is judged once, as a whole.
  let runStart = 0
  let runEnd = 0
  let hasJoiner = false
  const settle = (): void => {
    if (runEnd > runStart) {
      const between = rest.slice(from, runStart)
      parts.push(between)
      tail = between.length >= 2 ? between.slice(-2) : (tail + between).slice(-2)
      const before = tail[tail.length - 1]
      const after = rest[runEnd]
      // Only a run of two units or fewer can be a keycap tail.
      const isTail = runEnd - runStart <= 2 && KEYCAP_TAIL.has(rest.slice(runStart, runEnd))
      const isKept = hasJoiner
        ? holdsJoiner(before) && holdsJoiner(after)
        : holdsJoiner(before) || (isKeycapBase(tail) && isTail && !BEARER_CHAR.test(after ?? ''))
      if (isKept) {
        const run = rest.slice(runStart, runEnd)
        parts.push(run)
        tail = (tail + run).slice(-2)
      }
      from = runEnd
      runStart = runEnd
    }
  }
  for (const found of rest.matchAll(INVISIBLE_RUN)) {
    const at = found.index ?? 0
    if (at !== runEnd || runEnd === runStart) {
      settle()
      runStart = at
      hasJoiner = false
    }
    runEnd = at + found[0].length
    hasJoiner = hasJoiner || HAS_JOINER.test(found[0])
  }
  settle()
  parts.push(rest.slice(from))

  return parts.join('')
}

// A quoted value, whole: in straight quotes (a backslash escapes a quote inside them), in backticks, or in the curly
// quotes that a chat or a document makes of them. One that nothing closes runs to the end of the line, as a text that
// the Log cut leaves it, and is masked all the same, but for a backtick one (see below). The two patterns below take
// their value from it. Its per-character loops hold: the runtime's regex engine gives up on one past 63,792 units, and
// redact reads 4096 at most (TEXT_HEAD_MAX).
const QUOTED_VALUE = [
  String.raw`"(?:\\.|[^"\\\r\n])*"?`,
  String.raw`'(?:\\.|[^'\\\r\n])*'?`,
  // A markdown code span that ends in `Authorization:` is no value (its closing backtick would open one).
  String.raw`\x60[^\x60\r\n]*\x60`,
  String.raw`\u{201C}[^\u{201D}\r\n]*\u{201D}?`,
  String.raw`\u{2018}[^\u{2019}\r\n]*\u{2019}?`,
].join('|')

// A quote that can stand after the name of a key, or after `authorization`: a straight one, a backtick, or any of the
// four curly ones. A name in curly quotes ends in the right quote of its pair or, in German, in the left one.
const KEY_QUOTE = String.raw`["'\x60\u{201C}\u{201D}\u{2018}\u{2019}]`

// Whitespace that stays on its line: any but CR, LF, U+2028 and U+2029.
const INLINE_SPACE = String.raw`[^\S\r\n\u{2028}\u{2029}]`

// The `_key` names that SECRETS lacks: `secret_key`, `secret_key_base` (the master secret of Rails and Phoenix),
// `access_key` and `private_key`, with `_`, `-` or nothing between the words. The patterns that take them ignore case.
const KEY_NAMES = String.raw`secret[_-]?key(?:[_-]?base)?|access[_-]?key|private[_-]?key`

// No plain value ahead: a bare value that is wholly a literal (`true`, `false`, `null`, `none`: JSON and a Python dict)
// or a number, with what ends a bare value or the end of the text after it, is no secret.
const NOT_PLAIN = String.raw`(?!(?:true|false|null|none|[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?:[\s,;}\])]|$))`

// No anchor of a later pattern ahead: a bare value does not begin with a flag that SECRETS or UNQUOTED_KEY reads, and
// what that pattern reads after it (`--token` and `=` or a space, `--secret-key` and `=` or a gap); or with `Bearer`
// at a line end and a token alone on the next line, which the Bearer patterns read across the line end; or with a key
// name, at the start of the value or after a `.`, `_` or `-`, then a separator and a value (`password: …`,
// `Authorization: …`, `db.password=…`, `X-API-Key: …`). The key is then left as it is, and the later pattern masks
// its own secret. A value that only begins with `--` is a value, and so is one that holds a name glued to a word
// (`Secr3tToken=…`, `MyApiKey:…`) or ends in a name and `=` (base64 padding: `…pwd=`, `…token==`): it goes whole.
const NO_ANCHOR = String.raw`(?!--(?:token|password|api-key|secret)[= ]|` +
  String.raw`--[\w-]*?(?:secret-key(?:-base)?|access-key|private-key)(?:${INLINE_SPACE}+(?![:?+]?=|:)|=)|` +
  String.raw`bearer${INLINE_SPACE}*[\r\n\u{2028}\u{2029}]\s*[A-Za-z0-9._~+/-]{8,}=*` +
  String.raw`(?=${INLINE_SPACE}*(?:[\r\n\u{2028}\u{2029}]|$))|` +
  String.raw`(?:[\w.-]*[._-])?(?:api[_-]?key|token|secret|password|passwd|pwd|` +
  String.raw`authorization|${KEY_NAMES})${KEY_QUOTE}?${INLINE_SPACE}*(?:=>|[:?+]?=|:)${INLINE_SPACE}*[^\s=>])`

// An Authorization header whose value is in quotes (`"Authorization": "Bearer …"`, `'Authorization' => 'Basic …'`,
// `authorization="…"`). SECRETS takes `"Bearer` for the value there and masks that word alone, so the token behind the
// space stays. The whole quoted value goes, the scheme in it too. The arrow is read before `=`, as in QUOTED_KEY.
const QUOTED_AUTHORIZATION = new RegExp(
  String.raw`(authorization${KEY_QUOTE}?\s*(?:=>|:|=(?!>))\s*)(?:${QUOTED_VALUE})`, 'giu',
)

// The value of a key that has a quote after its name, as in JSON, a Python dict and a curl body
// (`{"password":"hunter2"}`, `{'api_key': 'abc'}`, `'token' => 'abc'`). SECRETS masks a value only when the `:` or `=`
// comes right after the name, so the value of such a key shows. The arrow is read before `=`: `=` would take the first
// character of `=>`, and a bare value the `>`. The value is a quoted one (QUOTED_VALUE), which may begin on a later
// line, or a bare one on the line of its key, up to a space, a comma, a semicolon or a closing bracket. A bare one may
// begin with `Bearer` or `Basic` and the credential after it (SECRETS reads those by their scheme, and the key must not
// eat that anchor); it does not begin with a bracket, which opens a nested value for the patterns that read inside it,
// and it does not sit on a later line, where a block that the key opens belongs to SECRETS. The quote after the name is
// required: `the token count` and `"tokens"` are no key. The `access` and `auth` token names and the `client` secret
// name are covered by `token` and `secret` already (no `\b` keeps them out), so they widen nothing. Left as they are: a
// nested value (`{"password": {"value": …}}`), the later items of a list, a bare value cut at `, ; ) ] }`, a quoted
// value across a line end, and a plain value (NOT_PLAIN).
const QUOTED_KEY = new RegExp(
  // The name, its quote and its separator, then the gap: any whitespace before a quoted value, and before a bare one
  // any but a line end (CR, LF, and the line and paragraph separators U+2028 and U+2029), so a tab, a no-break space
  // and an ideographic space are crossed and a new line is not. Group 1 is all of that and stays; the value after it
  // becomes the mask. An `=` that starts an arrow is no separator, so a dangling `=>` is not read as `=` and a value
  // `>`.
  String.raw`((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|token|secret|password|passwd|pwd|` +
    String.raw`${KEY_NAMES})${KEY_QUOTE}\s*(?:=>|:|=(?!>))(?:\s*(?=["'\x60\u{201C}\u{2018}])|${INLINE_SPACE}*))` +
    // The prefix and the value stay on the key's line; a value never starts with `=`. The prefix may open with a
    // backtick that nothing closes (QUOTED_VALUE takes a closed one), as in AUTH_SCHEME: the bare value would otherwise
    // take the backtick and `Bearer` for one word, and the token after it would show. An anchor (NO_ANCHOR) and a
    // plain value are read before the prefix: after it, `Bearer 12345678` would lose `Bearer` alone and show the
    // number.
    String.raw`(?:${QUOTED_VALUE}|${NO_ANCHOR}${NOT_PLAIN}(?:\x60?(?:bearer|basic)${INLINE_SPACE}+)?` +
    String.raw`[^\s,;}\])\[{(=][^\s,;}\])]*)`,
  'giu',
)

// The value of a `_key` name with no quote after it, which SECRETS does not read (`secret_key=…`, `access_key: …`,
// Perl's `secret_key => '…'`, Go's `secretKey := "…"`). There is no `\b` before the name, as in SECRETS, so
// `aws_secret_access_key = …` is read by its tail. A separator is `=>`, `:=`, `?=`, `+=`, `=` or `:`, each read before
// the shorter ones, and the gaps round it stay on the line: a value on a later line shows, a known limit. A
// command-line flag that ends in a name (`--secret-key`, `--s3-secret-access-key`) and `aws_secret_access_key` (`aws
// configure set`) take `=` or a space; prose with that name over-masks the next word, accepted. A `--` that a word
// character or a `-` touches starts no flag, so a run of dashes is read once, and a space that a separator follows is
// left to that separator. The value is a string in triple quotes, double quotes, single quotes or backticks (a
// backslash escapes the next character) or in curly quotes, one that nothing closes (on its line, for the straight
// quotes and the backtick) running to the end of the text (a PEM in a `.env` file), or a bare one that begins with no
// anchor of a later pattern (NO_ANCHOR): an optional `Bearer` or `Basic` with its credential (SECRETS reads those by
// their scheme), then a run of non-space characters that does not begin with `=` or `>`. The name and the separator
// stay (group 1).
// Applied before AUTH_SCHEME and GLUED_BEARER: a bare `Authorization:` or `Bearer` at a line end takes the name on the
// next line for its own, and the value would show.
const UNQUOTED_KEY = new RegExp(
  String.raw`((?:(?<![\w-])--[\w-]*?(?:secret-key(?:-base)?|access-key|private-key)|aws_secret_access_key)` +
    String.raw`(?:${INLINE_SPACE}+(?![:?+]?=|:)|=)|(?:${KEY_NAMES})${INLINE_SPACE}*(?:=>|[:?+]?=|:)${INLINE_SPACE}*)` +
    // Each loop takes a run of plain characters at once: with a group repeated for every character, the regex engine
    // of the mod's runtime gives up on a 128 KB value (no match, no error) and the value shows.
    // A string in `"`, `'` or a backtick closes on its own line, or runs to the end of the text: across a line end its
    // quote would pair with the opening quote of a later value, which would then show.
    String.raw`(?:"""[^"]*(?:"(?!"")[^"]*)*"{0,3}|'''[^']*(?:'(?!'')[^']*)*'{0,3}|` +
    String.raw`"[^"\\\r\n]*(?:\\[\s\S][^"\\\r\n]*)*(?:"|[\s\S]*)|'[^'\\\r\n]*(?:\\[\s\S][^'\\\r\n]*)*(?:'|[\s\S]*)|` +
    String.raw`\x60[^\x60\\\r\n]*(?:\\[\s\S][^\x60\\\r\n]*)*(?:\x60|[\s\S]*)|` +
    String.raw`\u{201C}[^\u{201D}]*\u{201D}?|\u{2018}[^\u{2019}]*\u{2019}?|` +
    String.raw`${NO_ANCHOR}(?:(?:bearer|basic)${INLINE_SPACE}+)?[^\s=>]\S*)`,
  'giu',
)

// An Authorization header with a scheme other than Bearer and Basic (`Token …`, `Bot …`, `ApiKey …`). SECRETS skips
// those two schemes alone, so for any other it takes the scheme for the value and masks that word, and the credential
// behind the space stays. A word that only starts with one of the two (`Bearerx`) is another scheme. The second word is
// no credential when it starts what another pattern reads: a flag (`--token x`), `Bearer` or `Basic`, or a key name
// with its `:` or `=` (`password:`, `X-API-Key:`, `token =`, a second `Authorization:`). The value then has no scheme:
// its first word is the credential, which SECRETS masks, and the key keeps its own mask. Digest and AWS SigV4
// credentials, which are several parts with commas between them, are masked in their first part only. The credential
// stays on the header's line, so the first word of the next line (a key whose own pattern masks it) is left to SECRETS.
// A scheme after a backtick that nothing closes on its line (QUOTED_VALUE takes a closed one) is taken whatever it is,
// Bearer and Basic too: SECRETS would read the backtick and the scheme as one word, and the credential would show. The
// second word is optional: when it is absent or is no credential, the first word goes alone: a value with no scheme,
// which SECRETS masks too when no quote follows the name, and which nothing else masks after a quoted name
// (`"Authorization": abc…`). `Bearer` or `Basic` is refused only as a word of its own (`basic-abc…` is a credential); a
// key name may hold dots (`db.password:`).
const AUTH_SCHEME = new RegExp(
  String.raw`(authorization${KEY_QUOTE}?\s*[:=]\s*)(?:\x60|(?!(?:bearer|basic)\b))[A-Za-z][\w.-]*` +
    String.raw`(?:${INLINE_SPACE}+(?!--|(?:bearer|basic)(?!\S)|` +
    String.raw`[\w.-]*(?:api[_-]?key|token|secret|password|passwd|pwd|authorization|${KEY_NAMES})` +
    String.raw`${KEY_QUOTE}?\s*[:=])\S+)?`,
  'giu',
)

// GitHub and Slack tokens with no word boundary before them, in the shape that real ones have. SECRETS starts a token
// at `\b`, so one that a word touches shows: a whole escape sequence goes out of a text and leaves what was beside it
// glued to the next word (`x`, U+009B, `31m` and `ghp_…` read `xghp_…`). A GitHub token holds 36 letters and digits
// after `ghp_` (or `gho_`, `ghu_`, `ghs_`, `ghr_`; SECRETS has no prefix for `ghu_` and `ghr_`), a fine-grained one 22
// letters, digits and underscores or more after `github_pat_`, a Slack token 10 letters, digits and dashes or more
// after `xoxb-` (or `xoxa-`, `xoxp-`, `xoxr-`, `xoxs-`); neither takes the other's separator. The shapes are narrow
// because the pattern has no `\b`: a looser one would mask the tail of an ordinary word (`laughs-at-everything` holds
// `ghs-at-everything`). `sk-`, `pk-` and `rk-` are left to SECRETS: a word may hold them (`task-management`).
const GLUED_TOKEN = /(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|xox[abprs]-[A-Za-z0-9-]{10,})/g

// A Bearer token with no word boundary before `Bearer`, for the same reason (`xBearer …`, once the sequence between has
// gone). It is case-sensitive: a header writes `Bearer`, and a word that ends in `bearer` (pallbearer, torchbearer) is
// prose; the Bearer pattern of SECRETS, with its `\b`, keeps every case. The mask follows one space, as SECRETS writes
// it. A token is never the name of the next header: this pattern runs before SECRETS, whose Authorization pattern must
// still find its anchor after a `Bearer` that ends a line (`WWW-Authenticate: Bearer`, then `Authorization: Basic …`).
const GLUED_BEARER = /(Bearer)\s+(?![\w.-]*(?:[Aa]uthorization|AUTHORIZATION)\s*[:=])[A-Za-z0-9._~+/-]{8,}=*/g

// The format and control characters go first, as shorten takes them out too: one inside a secret would keep a pattern
// from matching, and the secret would show once shorten had closed the gap. The patterns above come next, in that
// order and each over what the one before has left, and SECRETS last, as it was copied. A caller cuts a text to its
// head first (wordHead): the URL pattern takes quadratic time on a long crafted text such as `a.a.a…`.
export function redact(s: string): string {
  const clean = stripFormat(s)
    .replace(QUOTED_AUTHORIZATION, '$1•••')
    .replace(QUOTED_KEY, '$1•••')
    .replace(UNQUOTED_KEY, '$1•••')
    .replace(AUTH_SCHEME, '$1•••')
    .replace(GLUED_TOKEN, '•••')
    .replace(GLUED_BEARER, '$1 •••')

  return SECRETS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), clean)
}

// Takes the markdown marks out of a text that the pane shows as it is: a pair of `**` around text on one line, which is
// kept (its first and last characters are no spaces) and which no ASCII letter, digit or `_` touches on the outside;
// backticks (code); and the `#` marks of a heading at the start of a line, with the space after them. A `**` that
// stands alone, has a space beside it or is glued to an ASCII word stays (`x ** 2`; the `**` of `2**10 and 3**4` are
// exponents, no pair), and so does `__`: `__init__.py` is a file, not bold. Only ASCII keeps a pair, for exponents in
// code are ASCII: in scripts written without spaces (Chinese, Japanese, Thai) and inside words of other scripts
// (Cyrillic, Hindi) bold is glued to letters, and markdown reads it as bold, so its marks go. A caller cuts a text to
// its head first (wordHead): the pair pattern takes quadratic time on some long texts.
export function plainText(s: string): string {
  // The group inside the pair is lazy (`??`): a body of one character closes at its own `**`, not at the next pair's.
  // The lookbehind and the lookahead keep out a `**` that an ASCII word character (`\w`) touches on the outside of it.
  const pair = /(?<!\w)\*\*(\S(?:.*?\S)??)\*\*(?!\w)/gu

  return s.replace(pair, '$1').replace(/`/g, '').replace(/^#+ /gm, '')
}

// Takes out the format and control characters (stripFormat), collapses whitespace runs and cuts to `max` characters,
// the last one being an ellipsis. A cut that would leave one unit of a surrogate pair alone drops that unit too
// (textHead), so the text may come out one unit under `max`.
export function shorten(s: string, max: number): string {
  const flat = stripFormat(s).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${textHead(flat, max - 1)}…` : flat
}

// The first `max` UTF-16 units of a text, for the passes that read a text whole (the pair pattern of plainText takes
// quadratic time on some long inputs) when a Log line keeps LOG_TEXT_MAX characters of it at most. A cut between the
// two units of a surrogate pair would leave the high one alone, and a lone surrogate is no character, so that unit goes
// too. A text of `max` units or fewer comes back as it is.
export function textHead(s: string, max: number): string {
  if (s.length <= max) return s
  const head = s.slice(0, max)
  const last = head.charCodeAt(max - 1)

  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head
}

// The longest run of non-whitespace characters, in UTF-16 units, that wordHead takes off the end of a head. The run
// goes so that a secret that the cut goes through loses no mask, and the secrets that the patterns of redact know are
// far shorter than this; a pattern that keys on a name (`password=`, `Bearer`, `sk-`) masks a long value from its start
// all the same. The URL pattern is the exception: it needs the `@` after the password, so a URL password that the cut
// goes through loses its mask when the run before the cut is longer than CUT_WORD_MAX (a long password, or one glued to
// characters that a later pass drops or shrinks: backticks in an answer, a masked key); only a crafted text brings such
// a run into view, and that is accepted as best effort. A longer run is text (a long URL, base64, minified JSON, a CJK
// paragraph) whose start the pane should show, so it stays and the head is cut through it.
export const CUT_WORD_MAX = 256

// The head of a text (textHead) less the run of characters at its end that are no whitespace, for the texts that the
// Log reads: a word cut in two can be a secret that the patterns of redact no longer match (a URL with a password that
// loses its `@`), and a Log line keeps LOG_TEXT_MAX characters of the text at most anyway. The run goes only when it
// has CUT_WORD_MAX units or fewer: a longer one stays, and so does a head with no whitespace at all, which is the head
// as textHead gives it. The whitespace is what `\s` says, as in those patterns, so the no-break space counts. The run
// is found by a scan back from the end, one character at a time, which stops once it has passed CUT_WORD_MAX units: a
// pattern such as `\S+$` takes quadratic time on a long word that whitespace follows. A text of `max` units or fewer
// comes back as it is.
export function wordHead(s: string, max: number): string {
  if (s.length <= max) return s
  const head = textHead(s, max)
  const floor = Math.max(0, head.length - CUT_WORD_MAX - 1)
  let end = head.length
  while (end > floor && !/\s/.test(head.charAt(end - 1))) end -= 1

  // The run goes only if whitespace ended it within the limit; otherwise the head stays whole.
  return end > floor ? head.slice(0, end) : head
}

// How much of a text the Log reads, in UTF-16 units: a prompt, a tool call's label, a subagent's description and
// answer, a task description. A Log line keeps LOG_TEXT_MAX of each at most, and two passes take quadratic time on some
// long inputs: the pair pattern of plainText (224 KB of ` **x**y` took 4.1 s in Node 22) and the URL pattern of redact
// (128 KB of `a.` took 5.5 s in Node 22). These texts come from the agents (a Bash command can be steered by a prompt
// injection, and the hook of tool.call gates every tool call), so a crafted one could stall a hook: the passes that can
// be slow read only the head of a text. The format and control characters go first, over the whole text (logHead, one
// linear pass), and the head is cut at whitespace (wordHead), so that a secret the cut goes through keeps its mask,
// except in a crafted text. The word that the cut goes through is dropped only when it has CUT_WORD_MAX units or fewer;
// a longer run is text, and the head is cut through it.
const TEXT_HEAD_MAX = 4096

// The most of a text that a Log line keeps, in UTF-16 units: more than a line of a pane maximized on a 21:9 monitor
// shows (about 400 characters). The pane cuts each line to its room, with an ellipsis of its own (`wrap="truncate"`),
// so a narrow pane shows what it showed before.
export const LOG_TEXT_MAX = 512

// The head of a text for the Log. The format and control characters go first, over the whole text (stripFormat, one
// linear pass), so that no invisible character pads a secret past the cut: one counts toward the run that wordHead
// measures, and a byte order mark ends it, though redact and shorten take them out later. Then the head is cut
// (wordHead).
export const logHead = (text: string): string => wordHead(stripFormat(text), TEXT_HEAD_MAX)

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

// A value that can be anything, read as a record of fields: the input and the result of a call come as `unknown`.
const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}

// A running task of the given kind, or null when the call gave no id. A description is the model's own text, as a Log
// line is, and the pane draws it: a command can hold a secret, and a control character in it would make the engine
// refuse the pane. So each of the texts goes through the pipeline of the Log's lines, and the first that has anything
// left is the description (one of spaces and format characters is none); the name of the kind is the last resort.
function runningTask(kind: TaskKind, id: string, texts: string[], now: number): TaskRow | null {
  if (id === '') return null
  const cleaned = texts.map(text => shorten(redact(logHead(text)), LOG_TEXT_MAX))

  return {
    id, kind, description: cleaned.find(text => text !== '') ?? kind, status: 'running', startedAt: now,
    endedAt: null, durationMs: null,
  }
}

// The task that a tool call has started in the background, or null when it started none. A Bash command that runs in
// the background has a `backgroundTaskId` in its result, whoever sent it there: its own input, its timeout or a move. A
// Monitor and a Workflow have a `taskId`. Each is the id that the notification of the task names (`<task-id>`). Another
// tool starts none that the pane tracks: a subagent has its row in Subagents. `now` is the time the call returned and
// `calledAt` the time it began, before the engine ran it (`now` when not given). A task starts at `now`; a Bash command
// may have begun earlier (see below).
export function taskFromCall(
  tool: string, input: unknown, result: unknown, now: number, calledAt = now,
): TaskRow | null {
  const given = asRecord(input)
  const got = asRecord(result)
  switch (tool) {
    case 'Bash': {
      // A command begins at one of three times, by how it came to the background. One that hit its timeout ran in the
      // foreground for `timedOutAfterMs` before the engine sent it, so it began that long before the call returned (a
      // value that is negative or no finite number is no timeout). One whose input asked for the background
      // (`run_in_background`) came back as soon as it started: it began at `now`. Any other began in the foreground and
      // was moved while it ran (Ctrl+B, a message queued for the model, a plugin's turn abort, any other move), so it
      // began about when its call did, at `calledAt`: a permission prompt's wait, if there was one, is in its time.
      const waited = got.timedOutAfterMs
      const isTimedOut = typeof waited === 'number' && Number.isFinite(waited) && waited >= 0
      const startedAt = isTimedOut ? now - waited : given.run_in_background === true ? now : calledAt

      return runningTask('shell', str(got.backgroundTaskId), [str(given.description), str(given.command)], startedAt)
    }
    case 'Monitor':
      return runningTask('monitor', str(got.taskId), [str(given.description)], now)
    case 'Workflow':
      // A workflow sent to the cloud is a remote agent: the v2 spec (§4.4) leaves it out, and its end would not reach
      // this session. One whose syntax check failed (`error` is set) did not start, so no notice would end its row.
      if (got.status === 'remote_launched' || got.taskType === 'remote_agent' || str(got.error) !== '') return null

      return runningTask('workflow', str(got.taskId), [str(got.workflowName), str(given.name)], now)
    default:
      return null
  }
}

// The text between the first `<tag>` and the `</tag>` after it, or between the last `<tag>` and its `</tag>` when
// `fromEnd` is set; undefined when there is no such pair. A notification has its header first, the free text of a
// result in the middle and its usage block last, so a result that quotes a tag changes neither the id and the status
// (the first ones) nor the duration (the last one). The tags are found with indexOf, not with a pattern that
// backtracks: a notification carries the result of a subagent or a workflow, which can be long, and a lazy pattern over
// the whole text takes quadratic time on a crafted one.
function tagText(text: string, tag: string, fromEnd = false): string | undefined {
  const open = `<${tag}>`
  const start = fromEnd ? text.lastIndexOf(open) : text.indexOf(open)
  const end = start < 0 ? -1 : text.indexOf(`</${tag}>`, start)

  return end < 0 ? undefined : text.slice(start + open.length, end)
}

// How a task ended, from its notification: the text of a `prompt.submit` whose origin is `task-notification` (the v2
// spec, §8.5). The `<task-id>`, the `<status>` of the header (what stands before the first `<summary>` or `<result>`,
// whichever comes first: a result, or a line that a monitor watched, can quote the tag) and the `<duration_ms>` of the
// usage block, which a shell command has none of; a duration that is no safe integer is none either. Null for a text
// with no id, for a status that is no end of a task (`completed`, `failed`, `killed` and `stopped` are the four that
// end one), and for a text with neither a `<summary>` nor a `<result>`: every real notice has a `<summary>`, and a
// `<status>` quoted inside an unobserved notice (a Monitor's event) must not close a row. The notice of a task that
// an earlier session left running has a `<note>` and says `failed` or `stopped`: it parses, and names an id that this
// session has no row for.
export function parseTaskNotification(text: string): TaskEnd | null {
  const id = tagText(text, 'task-id')
  const headerEnd = text.search(/<summary>|<result>/) // two literals, no quantifier: it cannot backtrack
  const status = headerEnd < 0 ? undefined : tagText(text.slice(0, headerEnd), 'status')
  const duration = tagText(text, 'duration_ms', true)
  if (id === undefined || id === '') return null
  if (status !== 'completed' && status !== 'failed' && status !== 'killed' && status !== 'stopped') return null

  const ms = duration !== undefined && /^\d+$/.test(duration) ? Number(duration) : null

  return { id, status, durationMs: Number.isSafeInteger(ms) ? ms : null }
}

// The name of the tag that opens a turn the engine started on its own, or undefined for a person's prompt. The engine
// opens such a turn with a hyphenated lowercase tag (`task-notification`, `system-reminder`, `command-name`), and its
// tags may carry attributes after a space (`<teammate-message teammate_id="lead">`). An HTML tag has no hyphen, so a
// pasted `<div class=…>` or `<p>` is the person's prompt, and so is a `<token…` that no `>` closes. Only the first 256
// characters are read, once the format and control characters are out of them. The name is two to nine words of
// lowercase letters and digits, joined by `-` or `_`; the attributes hold no `<` or `>`. A lowercase token in brackets
// (`<ghp_…>`) has that shape, so the caller masks the name.
export function engineTag(text: string): string | undefined {
  return /^<([a-z][a-z0-9]*(?:[-_][a-z0-9]+){1,8})(?:\s[^<>]*)?>/.exec(stripFormat(text.slice(0, 256)))?.[1]
}

// What a turn's text is, for the Log: a person's prompt, a turn the engine opened, a compaction summary, or nothing to
// draw. The desktop opens its first prompt after a reopen with reminder blocks, `<system-reminder>…</system-reminder>`,
// which are no turn of the engine's: they are skipped, and what follows is read, on the text with its format
// characters out (one before a block must not stop the strip). One forward pass by indexOf, so linear on any input,
// with no pattern over the blocks. `service` is nothing to draw: a text that is empty or all blocks, an unclosed block,
// and a remainder, after a block, that holds a reminder tag: the strip may have stopped at a closing tag that a block
// quoted, and the tail of a block cannot be told from a prompt with a reminder after it (a block, a prompt and a block
// after it is `service` too: a known cost, for the tail may hold what a reminder holds). With no block before it, a
// reminder after the prompt is cut off, not drawn; a closing tag with no opening one before it is a tail again. The
// notes that the engine puts in the person's turn (an image's source, a skill's folder, an interrupt) are `service`;
// another session's message is the tag `peer`. The `text` of the other kinds is the remainder, which the caller cleans
// and masks as any text it draws.
export type PromptKind =
  | { kind: 'prompt'; text: string }
  | { kind: 'tag'; tag: string; text: string }
  | { kind: 'summary'; text: string }
  | { kind: 'service' }

const REMINDER_OPEN = '<system-reminder>'
const REMINDER_CLOSE = '</system-reminder>'
const SUMMARY_START = 'This session is being continued from a previous conversation'
const PEER_START = 'Another Claude session sent a message:'
const SERVICE_STARTS = ['[Image: source: ', 'Base directory for this skill: ', '[Request interrupted by user']

export function promptKind(text: string): PromptKind {
  const clean = stripFormat(text)
  // `at` only moves forward: the blocks are not sliced off the rest one by one, which is quadratic with many blocks.
  const skipSpace = (from: number): number => {
    let i = from
    while (i < clean.length && /\s/.test(clean.charAt(i))) i += 1

    return i
  }
  let at = skipSpace(0)
  let hasBlock = false
  while (clean.startsWith(REMINDER_OPEN, at)) {
    const end = clean.indexOf(REMINDER_CLOSE, at)
    if (end < 0) return { kind: 'service' } // an unclosed block
    at = skipSpace(end + REMINDER_CLOSE.length)
    hasBlock = true
  }

  const open = clean.indexOf(REMINDER_OPEN, at)
  const close = clean.indexOf(REMINDER_CLOSE, at)
  // After a block, any reminder tag in the remainder; with none, a closing tag that no opening one comes before.
  if (hasBlock ? open >= 0 || close >= 0 : close >= 0 && (open < 0 || close < open)) return { kind: 'service' }

  const rest = open < 0 ? clean.slice(at) : clean.slice(at, open)
  if (rest.trim() === '') return { kind: 'service' }
  const tag = engineTag(rest)
  if (tag !== undefined) return { kind: 'tag', tag, text: rest }
  if (rest.startsWith(SUMMARY_START)) return { kind: 'summary', text: rest }
  if (rest.startsWith(PEER_START)) return { kind: 'tag', tag: 'peer', text: rest }

  return SERVICE_STARTS.some(start => rest.startsWith(start)) ? { kind: 'service' } : { kind: 'prompt', text: rest }
}

// The statuses that the row of a task takes when it ends.
export type TaskEndStatus = 'done' | 'failed' | 'stopped'

// How the notice of a task words its end, and the status its row takes: `killed` and `stopped` are both a stop. Not
// LISTED_STATUS, which is for $.agent.list() and has no `stopped`.
export const TASK_END: Record<TaskEnd['status'], TaskEndStatus> = {
  completed: 'done', failed: 'failed', killed: 'stopped', stopped: 'stopped',
}

// The log line of a subagent that has ended: its text, and its outcome, the time it took behind a mark (✓ for an
// answer, ✗ for a failure; a stop is no fault, so it has no mark). A time that is not known (a restored row) leaves
// the mark alone, and a stop with no time has no outcome. One that still runs has no outcome, so its status is not a
// parameter. The cost of a restored row is the cost since the restore, so it has a plus.
export const agentOutcome = (
  status: TaskEndStatus, row: AgentRow, durationMs: number | null, answer: string,
): { text: string; outcome: string | undefined } => {
  const took = durationMs === null ? '' : fmtDuration(durationMs)
  // The mark and the time, whichever there are; none of either (a stop of no known time) is no outcome.
  const outcomeOf = (mark: string): string | undefined => {
    const parts = [mark, took].filter(part => part !== '')

    return parts.length === 0 ? undefined : parts.join(' ')
  }
  if (status === 'stopped') return { text: status, outcome: outcomeOf('') }
  if (status !== 'done') return { text: status, outcome: outcomeOf('✗') }
  // The format and control characters go first and the head is cut (logHead), then the marks, then the secrets: no pass
  // that takes quadratic time reads more than the head. The answer is markdown, which the pane shows as it is: its
  // marks go after its format and control characters, as one beside a mark (a BOM after `**`) hides it from plainText.
  const said = shorten(redact(plainText(logHead(answer))), LOG_TEXT_MAX)
  const plus = row.restored === true ? '+' : ''
  const head = row.costUsd === null ? 'done' : `done · ${fmtUsd(row.costUsd)}${plus}`

  return { text: said === '' ? head : `${head} — ${said}`, outcome: outcomeOf('✓') }
}

// The log line of a task that has ended, drawn as the end of a subagent is (agentOutcome): the text is the status, the
// kind and what the task was; the outcome is the time it ran behind a mark (✓ for a task that finished, ✗ for one that
// failed; a stop is no fault, so it has no mark). A task whose time is not known has no outcome, and a time that is a
// bound (durationAtMost) has `≤` before it.
export const taskLine = (
  status: TaskEndStatus, row: TaskRow,
): { text: string; kind: LogKind; outcome: string | undefined } => {
  const mark = status === 'done' ? '✓ ' : status === 'failed' ? '✗ ' : ''
  const bound = row.durationAtMost === true ? '\u{2264}' : ''

  return {
    text: shorten(`${status} · ${row.kind}: ${row.description}`, LOG_TEXT_MAX),
    kind: status === 'done' ? 'ok' : status === 'stopped' ? 'info' : 'error',
    outcome: row.durationMs === null ? undefined : `${mark}${bound}${fmtDuration(row.durationMs)}`,
  }
}

// The row of a task that has ended: its status, the end time and the time it ran. The notification's duration stands
// when it gives one; otherwise it is the time from the start to `at`, never under 0 (the wall clock can be put back),
// and a task whose start is not known has none. With `atMost` set, a time from the clock is a bound (durationAtMost):
// `at` is when the notice arrived, which may be later than the end of the task.
export function finishTask(
  row: TaskRow, status: TaskStatus, at: number, durationMs: number | null, atMost = false,
): TaskRow {
  const ran = row.startedAt === null ? null : Math.max(0, at - row.startedAt)
  const isBound = atMost && durationMs === null && ran !== null

  return { ...row, status, endedAt: at, durationMs: durationMs ?? ran, ...(isBound ? { durationAtMost: true } : {}) }
}

export const orderTasks = (rows: TaskRow[]): TaskRow[] => orderByStart(rows)

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
