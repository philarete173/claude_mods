import { test, expect } from 'claude-code/testing'
import {
  addAgentCost,
  attributeCost,
  cacheHitPct,
  computeTurnStats,
  CUT_WORD_MAX,
  engineTag,
  finishTask,
  fmtClock,
  fmtCountdown,
  fmtDuration,
  fmtPct,
  fmtRate,
  fmtTokens,
  fmtTtft,
  fmtUsd,
  LOG_MAX,
  LOG_TEXT_MAX,
  mergedLength,
  orderAgents,
  orderTasks,
  parseStatus,
  parseTaskNotification,
  plainText,
  pushLog,
  redact,
  shortType,
  shorten,
  splitCost,
  stripFormat,
  sumNumstat,
  sumUsage,
  taskFromCall,
  textHead,
  toolLabel,
  wordHead,
} from './stats'
import type {
  AgentRow, AgentStatus, Interval, LogEntry, StepTiming, TaskEnd, TaskRow, TaskStatus, TurnAcc, Usage,
} from './stats'

// claude-code/testing has no toBeCloseTo, so a tolerance is checked by hand.
function expectNear(actual: number | null, expected: number, eps = 1e-9): void {
  expect(actual !== null && Math.abs(actual - expected) < eps, `expected ~${expected}, got ${actual}`).toBe(true)
}

// Two steps; the first one ends in a tool call, and the tool intervals overlap.
const S1: StepTiming = {
  tStart: 0, tFirst: 800, tEnd: 5000, usage: { output_tokens: 300 }, hasTool: true, hasText: true,
}
const S2: StepTiming = {
  tStart: 6000, tFirst: 6600, tEnd: 13700, usage: { output_tokens: 477 }, hasTool: false, hasText: true,
}
const U: Usage = {
  input_tokens: 12, output_tokens: 777, cache_read_input_tokens: 99000, cache_creation_input_tokens: 900,
}
const A: TurnAcc = {
  turnId: 't', startedAt: 0, costAtStart: 5, steps: [S1, S2], toolIntervals: [[5000, 5600], [5200, 5900]],
}

const agent = (status: AgentStatus, startedAt: number): AgentRow => ({
  id: `${status}@${startedAt}`, description: 'd', type: 't', model: null, status, startedAt,
  endedAt: null, costUsd: null,
})

const task = (status: TaskStatus, startedAt: number | null, id = `${status}@${startedAt}`): TaskRow => ({
  id, kind: 'shell', description: 'd', status, startedAt, endedAt: null, durationMs: null,
})

test('mergedLength', () => {
  expect(mergedLength([])).toBe(0)
  expect(mergedLength([[0, 10], [5, 15]])).toBe(15) // overlapping
  expect(mergedLength([[0, 10], [2, 3]])).toBe(10) // nested
  const disjoint: Interval[] = [[5, 7], [0, 1]]
  expect(mergedLength(disjoint)).toBe(3) // disjoint, out of order
  expect(disjoint).toEqual([[5, 7], [0, 1]]) // the input is not sorted in place
})

test('sumUsage', () => {
  expect(sumUsage([{ input_tokens: 1, output_tokens: 2 }, { output_tokens: 3, cache_read_input_tokens: 4 }, {
    cache_creation_input_tokens: 5,
  }])).toEqual({ input_tokens: 1, output_tokens: 5, cache_read_input_tokens: 4, cache_creation_input_tokens: 5 })
  expect(sumUsage([])).toEqual({
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  })
})

test('cacheHitPct', () => {
  expect(cacheHitPct({ input_tokens: 0 })).toBe(null)
  expect(cacheHitPct({ input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 })).toBe(80)
})

test('computeTurnStats: the fixture of the brief', () => {
  const s = computeTurnStats(A, 33500, U, 5.005)
  expect(s.elapsedMs).toBe(33500)
  expect(s.modelMs).toBe(12700)
  expect(s.toolMs).toBe(900)
  expect(s.steps).toBe(2)
  expect(s.ttftMs).toBe(700)
  expectNear(s.wholeTurnRate, 61.18, 0.005)
  // The last step: 477 tokens over its whole request, 6000 to 13700 ms: 477 / 7.7.
  expectNear(s.responseRate, 61.95, 0.005)
  expect(s.tokensIn).toBe(912) // 12 not cached and 900 written to the cache; the 99000 read from it are left out
  expect(s.tokensOut).toBe(777)
  expectNear(s.cachePct, 99.09, 0.005)
  expectNear(s.costUsd, 0.005)
})

test('computeTurnStats: ttftMs is null when a step has no first chunk', () => {
  const acc: TurnAcc = { ...A, steps: [{ ...S1, tFirst: null }, S2] }
  expect(computeTurnStats(acc, 33500, U, 5.005).ttftMs).toBe(null)
})

test('computeTurnStats: responseRate needs a last step with text and no tool', () => {
  const lastWith = (patch: Partial<StepTiming>): TurnAcc => ({ ...A, steps: [S1, { ...S2, ...patch }] })
  expect(computeTurnStats(lastWith({ hasTool: true }), 33500, U, 5.005).responseRate).toBe(null)
  expect(computeTurnStats(lastWith({ hasText: false }), 33500, U, 5.005).responseRate).toBe(null)
})

test('computeTurnStats: responseRate runs from the request, so a closing burst of text reads true', () => {
  // The final text came in one burst, 150 ms and 10 ms before the stop. From its first chunk, 477 tokens would read
  // ~3180 tok/s and 47700 tok/s (null); the request lasted 7.7 s, so the answer ran at ~62 tok/s either way.
  for (const tFirst of [6600, 13550, 13690, null]) {
    const acc: TurnAcc = { ...A, steps: [S1, { ...S2, tFirst }] }
    expectNear(computeTurnStats(acc, 33500, U, 5.005).responseRate, 477 / 7.7, 0.005)
  }
})

test('computeTurnStats: a rate above 5000 tok/s is null', () => {
  const fast: StepTiming = {
    tStart: 0, tFirst: 0, tEnd: 1000, usage: { output_tokens: 100000 }, hasTool: false, hasText: true,
  }
  const s = computeTurnStats({ ...A, steps: [fast], toolIntervals: [] }, 1000, undefined, null)
  expect(s.wholeTurnRate).toBe(null)
  expect(s.responseRate).toBe(null)
})

test('computeTurnStats: a zero window or no steps leave the rates null', () => {
  const instant: StepTiming = {
    tStart: 5, tFirst: 5, tEnd: 5, usage: { output_tokens: 0 }, hasTool: false, hasText: true,
  }
  const zero = computeTurnStats({ ...A, steps: [instant], toolIntervals: [] }, 0, undefined, null)
  expect(zero.wholeTurnRate).toBe(null)
  expect(zero.responseRate).toBe(null)
  const none = computeTurnStats({ ...A, steps: [], toolIntervals: [] }, 1000, undefined, null)
  expect(none.steps).toBe(0)
  expect(none.modelMs).toBe(0)
  expect(none.toolMs).toBe(0)
  expect(none.ttftMs).toBe(null)
  expect(none.wholeTurnRate).toBe(null)
  expect(none.responseRate).toBe(null)
  expect(none.tokensIn).toBe(0)
  expect(none.tokensOut).toBe(0)
  expect(none.cachePct).toBe(null)
})

test('computeTurnStats: without turn usage the step usages are summed', () => {
  const acc: TurnAcc = {
    ...A,
    steps: [
      { ...S1, usage: { input_tokens: 40, output_tokens: 300, cache_read_input_tokens: 100 } },
      { ...S2, usage: { input_tokens: 60, output_tokens: 477, cache_read_input_tokens: 200 } },
    ],
  }
  const s = computeTurnStats(acc, 33500, undefined, 5.005)
  expect(s.tokensIn).toBe(100) // 100 not cached; the 300 read from the cache are left out
  expect(s.tokensOut).toBe(777)
  expect(s.cachePct).toBe(75) // but the share counts them: 300 of 400
})

test('computeTurnStats: Tokens in is the input at full price or more, the cache share is of all of it', () => {
  const cases: Array<[usage: Usage, tokensIn: number, cachePct: number | null]> = [
    // What was read from the cache is left out of the figure and is in the share: 100 of 125.
    [{ input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 7 }, 25, 80],
    // Each part alone, and a part that is missing counts 0.
    [{ input_tokens: 40 }, 40, 0],
    [{ cache_read_input_tokens: 40 }, 0, 100],
    [{ cache_creation_input_tokens: 40 }, 40, 0],
    // The turn after a pause: the cache has expired, and the whole context is written to it. The cost is in the number.
    [{ input_tokens: 3, cache_creation_input_tokens: 182_000, output_tokens: 900 }, 182_003, 0],
    // A turn that mostly reads the cache: the figure stays small, as the cost does, and the share is high.
    [{ input_tokens: 10, cache_read_input_tokens: 980, cache_creation_input_tokens: 10 }, 20, 98],
    [{ output_tokens: 9 }, 0, null],
  ]
  for (const [usage, tokensIn, cachePct] of cases) {
    const s = computeTurnStats(A, 1000, usage, null)
    expect(s.tokensIn, JSON.stringify(usage)).toBe(tokensIn)
    expect(s.cachePct, JSON.stringify(usage)).toBe(cachePct)
  }
})

test('computeTurnStats: costUsd is null unless both readings exist', () => {
  expect(computeTurnStats(A, 33500, U, null).costUsd).toBe(null)
  expect(computeTurnStats({ ...A, costAtStart: null }, 33500, U, 5.005).costUsd).toBe(null)
})

test('attributeCost', () => {
  expect(attributeCost(10, 10.25)).toEqual({ delta: 0.25, lastUsd: 10.25 })
  expect(attributeCost(10.25, 10.2)).toEqual({ delta: 0, lastUsd: 10.25 })
})

test('addAgentCost', () => {
  const fresh = agent('running', 0)
  expect(addAgentCost(fresh, 0.02)).toEqual({ ...fresh, costUsd: 0.02 })
  expect(fresh.costUsd).toBe(null) // the row is not mutated
  expectNear(addAgentCost({ ...fresh, costUsd: 0.01 }, 0.02).costUsd, 0.03)
})

test('splitCost', () => {
  const split = splitCost(5.49, 2.95)
  expect(split.total).toBe(5.49)
  expectNear(split.session, 2.54)
  expect(split.subagents).toBe(2.95)
  expect(splitCost(undefined, 1)).toEqual({ total: null, session: null, subagents: 1 })
  expect(splitCost(1, 2).session).toBe(0)
})

test('orderAgents', () => {
  const rows = [agent('done', 100), agent('running', 50), agent('done', 300)]
  expect(orderAgents(rows).map(r => r.id)).toEqual(['running@50', 'done@300', 'done@100'])
  expect(rows.map(r => r.id)).toEqual(['done@100', 'running@50', 'done@300']) // the source is not reordered
  expect(orderAgents([agent('running', 10), agent('running', 20)]).map(r => r.id)).toEqual(['running@20', 'running@10'])
})

test('pushLog', () => {
  expect(LOG_MAX).toBe(200) // the Log keeps 200 lines
  const entry = (at: number): LogEntry => ({ at, who: 'main', text: `e${at}`, kind: 'info' })
  const log = Array.from({ length: LOG_MAX }, (_, i) => entry(LOG_MAX - i)) // newest first: LOG_MAX ... 1
  const next = pushLog(log, entry(LOG_MAX + 1))
  expect(next).toHaveLength(LOG_MAX)
  expect(next[0]?.at).toBe(LOG_MAX + 1)
  expect(next[1]?.at).toBe(LOG_MAX)
  expect(next[LOG_MAX - 1]?.at).toBe(2) // the oldest one fell out
  expect(log).toHaveLength(LOG_MAX) // the source is not mutated
  expect(pushLog(log, entry(LOG_MAX + 1), 3).map(e => e.at)).toEqual([LOG_MAX + 1, LOG_MAX, LOG_MAX - 1])
})

test('shortType', () => {
  expect(shortType('plugin:code-reviewer')).toBe('code-reviewer')
  expect(shortType('engineer')).toBe('engineer')
  // At most 14 characters: a longer type is cut to its first 13 and marked with an ellipsis.
  expect(shortType('feature-dev:a-very-long-agent-type')).toBe('a-very-long-a…')
  expect(shortType('frontend-developer')).toBe('frontend-deve…')
  expect(shortType('abcdefghijklmno')).toBe('abcdefghijklm…') // 15 characters: one too many
  expect(shortType('minimal-change')).toBe('minimal-change') // exactly 14: left as it is
  // The length is the type's own: a long plugin prefix does not count.
  expect(shortType('a-plugin-with-a-very-long-name:engineer')).toBe('engineer')
  for (const type of ['x:minimal-change-engineer', 'frontend-developer', 'a', '']) {
    expect(shortType(type).length, type).toBeLessThanOrEqual(14)
  }
})

test('shorten', () => {
  expect(shorten('  a \n  b  ', 10)).toBe('a b')
  expect(shorten('abcdefghijk', 5)).toBe('abcd…')
  expect(shorten('abcde', 5)).toBe('abcde')
})

// U+202E (right-to-left override) and the other format characters (category Cf) draw nothing, but they reorder or hide
// what is around them: they are taken out. The two joiners are format characters too: they stay between two non-ASCII
// characters that are no spaces, and go beside an ASCII character or a space (ZWJ, ZWNJ).
const FORMAT_CHARS: Array<[name: string, char: string]> = [
  ['U+202E, the right-to-left override', '\u202E'],
  ['U+202D, the left-to-right override', '\u202D'],
  ['U+202A, the left-to-right embedding', '\u202A'],
  ['U+2066, the left-to-right isolate', '\u2066'],
  ['U+2069, the pop of an isolate', '\u2069'],
  ['U+200E, the left-to-right mark', '\u200E'],
  ['U+200B, the zero-width space', '\u200B'],
  ['U+FEFF, the byte order mark', '\uFEFF'],
  ['U+00AD, the soft hyphen', '\u00AD'],
]

// The zero-width joiner (U+200D) holds an emoji sequence together, and the non-joiner (U+200C) belongs to the spelling
// of Persian and of Indic scripts: between two non-ASCII characters that are no spaces they reorder and hide nothing,
// so they stay. Spelled as escapes, so that this file shows what it says.
const ZWJ = '\u200D'
const ZWNJ = '\u200C'
const JOINERS: Array<[name: string, joiner: string]> = [['ZWJ', ZWJ], ['ZWNJ', ZWNJ]]
const ROCKET = '\u{1F680}'
// Spaces above U+007F, each one of `\s` as the ASCII space is: the patterns of redact take them for spaces too.
const NBSP = '\u00A0'
const EM_SPACE = '\u2003'
const SPACES: Array<[name: string, space: string]> = [
  ['U+00A0, the no-break space', NBSP],
  ['U+2003, the em space', EM_SPACE],
  ['U+202F, the narrow no-break space', '\u202F'],
  ['U+3000, the ideographic space', '\u3000'],
  ['U+2028, the line separator', '\u2028'],
]
const FAMILY = `\u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}` // man, woman and girl joined: one emoji, a family
const RAINBOW_FLAG = `\u{1F3F3}\uFE0F${ZWJ}\u{1F308}` // a white flag, a variation selector, a joiner and a rainbow
const PERSIAN = `\u0645\u06CC${ZWNJ}\u062E\u0648\u0627\u0647\u0645` // "mi khaham", I want: two words, joined by a ZWNJ

test('stripFormat takes out the characters of category Cf, and leaves everything else as it was', () => {
  for (const [name, char] of FORMAT_CHARS) expect(stripFormat(`a${char}b${char}${char}c`), name).toBe('abc')
  // Letters of other scripts, accents, emoji, the plain space and the no-break space, tabs and line breaks stay.
  const kept = 'main ветка é 日本語 🚀 a\u00A0b\tc\nd'
  expect(stripFormat(kept)).toBe(kept)
  expect(stripFormat('')).toBe('')
})

// The engine refuses a text child that holds a control character (C0 but tab, line feed and carriage return, DEL and
// C1; an escape sequence has one) and draws its own pane in place of the mod's, so they are taken out with the format
// characters, and not turned into spaces: a secret that one splits stays whole for redact. The vertical tab and the
// form feed are the exception: they are whitespace, and shorten made them spaces before, so each becomes a space.
test('stripFormat takes out the control characters, and keeps the tab, the line feed and the carriage return', () => {
  const text = 'a\u001b[31mb\u0000c\u0007d\u000be\u000cf\u007fg\u0085h\u009bi\tj\nk\rl'
  expect(stripFormat(text)).toBe('abcd e fghi\tj\nk\rl')
  // The class is the engine's: U+0000 to U+0008, U+000B, U+000C, U+000E to U+001F, and U+007F to U+009F. Every code
  // point up to U+00A0, the no-break space, is tried between two letters.
  const isControl = (code: number): boolean =>
    code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)
  for (let code = 0; code <= 0xa0; code += 1) {
    const char = String.fromCharCode(code)
    const name = `U+${code.toString(16).padStart(4, '0')}`
    const gone = code === 0x0b || code === 0x0c ? 'a b' : 'ab' // the vertical tab and the form feed become a space
    expect(stripFormat(`a${char}b`), name).toBe(isControl(code) ? gone : `a${char}b`)
  }
  // A secret that one of them splits is whole once it is gone, and redact masks it.
  expect(redact('echo ghp_abc\u001bdefgh12345678')).toBe('echo •••')
  // A vertical tab between a word and a secret is the space that it was for shorten: the secret keeps its mask.
  expect(redact(stripFormat('Bearer\u000babcdefghijklmnop'))).not.toContain('abcdefghijklmnop')
})

// An ANSI escape sequence goes whole, not its ESC alone: a coloured log reads as its text, and the rest of a sequence
// (`[31m`) does not glue to the word after it, which a pattern of redact that starts at a word boundary would miss.
test('stripFormat takes an ANSI escape sequence out whole: a CSI, and an OSC that has its terminator', () => {
  expect(stripFormat('\u001b[31mERROR\u001b[0m build failed')).toBe('ERROR build failed')
  // An OSC ends at `ESC \` (a link, OSC 8) or at BEL (a window title, OSC 0).
  expect(stripFormat('\u001b]8;;file:///etc/x\u001b\\x\u001b]8;;\u001b\\ done')).toBe('x done')
  expect(stripFormat('a\u001b]0;title\u0007b')).toBe('ab')
  // A control string ends at its first terminator: a second one is a stray control character, and goes alone.
  expect(stripFormat('a\x1b]0;t\x07 mid \x07b')).toBe('a mid b')
  expect(stripFormat('a\x9d0;t\x9c mid \x9cb')).toBe('a mid b')
  // A control string with no terminator is no sequence: its introducer goes and its body stays, so that it cannot
  // swallow the rest of a line (a terminal would swallow the text up to a terminator).
  expect(stripFormat('a\x1b]no end')).toBe('ano end')
  expect(stripFormat('a\x1b]0;title')).toBe('a0;title')
  expect(stripFormat('a\x1bPq')).toBe('aPq') // `ESC P` is no two-byte escape here: its ESC goes alone
  expect(stripFormat('a\x1b_x')).toBe('ax')
  expect(stripFormat('a\x1b^x')).toBe('ax')
  expect(stripFormat('a\x1bXx')).toBe('aXx') // `ESC X` is no two-byte escape here either: its ESC goes alone
  // A secret that the sequences of a coloured log stand beside is masked as it is without them: `\bghp_` needs a word
  // boundary, and the `m` of `ESC [ 33 m` left in front of the `g` would be none.
  expect(redact(stripFormat('\u001b[1mBearer\u001b[0m abcdefghijklmnop'))).not.toContain('abcdefghijklmnop')
  const token = 'ghp_abcdefgh12345678'
  expect(redact(stripFormat(`see \u001b[33m${token}\u001b[0m`))).toBe('see •••')
})

// A CSI is `ESC [`, parameter bytes (U+0030 to U+003F: the digits, `;`, `?` and the rest), intermediate bytes (U+0020
// to U+002F), and one final byte (U+0040 to U+007E, `~` included). The first two may be none; each form goes whole.
test('stripFormat takes a CSI out whole, whatever its parameters, intermediate bytes and final byte', () => {
  const sequences: Array<[name: string, sequence: string]> = [
    ['no parameters (reset the colours)', '\u001b[m'],
    ['parameters with `;` (a 256-colour foreground)', '\u001b[38;5;196m'],
    ['a private-mode mark `?` (hide the cursor)', '\u001b[?25l'],
    ['a capital as the final byte (erase the line)', '\u001b[2K'],
    ['an intermediate byte, a space (a cursor shape)', '\u001b[ q'],
    ['`~` as the final byte (the start of a bracketed paste)', '\u001b[200~'],
  ]
  for (const [name, sequence] of sequences) expect(stripFormat(`a${sequence}b`), name).toBe('ab')
})

// A control string (an OSC, a DCS, a SOS, a PM or an APC, with `ESC` and a character or with one C1 character), an
// 8-bit CSI, an nF escape (`ESC`, intermediate bytes and a final byte) and an escape of two bytes go whole too, so that
// no `31m` or `(B` is left to glue to the word after it. Spelled as escapes, so that this file holds no control
// character.
test('stripFormat takes the other whole sequences out: control strings, an 8-bit CSI, nF and two-byte escapes', () => {
  const sequences: Array<[name: string, sequence: string]> = [
    ['an 8-bit CSI (a colour)', '\x9b31m'],
    ['an 8-bit CSI with a private-mode mark (hide the cursor)', '\x9b?25l'],
    ['an 8-bit OSC ended by ST (a window title)', '\x9d0;title\x9c'],
    ['an 8-bit OSC ended by BEL', '\x9d0;t\x07'],
    ['a DCS ended by `ESC \\`', '\x1bPq#0\x1b\\'],
    ['an 8-bit DCS', '\x90q\x9c'],
    ['a SOS', '\x1bXx\x1b\\'],
    ['a PM', '\x1b^x\x1b\\'],
    ['an APC', '\x1b_x\x1b\\'],
    ['an 8-bit SOS', '\x98x\x9c'],
    ['an 8-bit PM', '\x9ex\x9c'],
    ['an 8-bit APC', '\x9fx\x9c'],
    ['`ESC ( B`, what `tput sgr0` ends in', '\x1b(B'],
    ['`ESC ) 0`', '\x1b)0'],
    ['`ESC # 8`', '\x1b#8'],
    ['`ESC % G`', '\x1b%G'],
    ['`ESC $ ( B`, two intermediate bytes', '\x1b$(B'],
    ['`ESC 7`', '\x1b7'],
    ['`ESC 8`', '\x1b8'],
    ['`ESC =`', '\x1b='],
    ['`ESC >`', '\x1b>'],
    ['a lone `ESC \\`, a terminator with no start', '\x1b\\'],
    ['`ESC * 0` and `ESC + B`', '\x1b*0\x1b+B'],
    ['an 8-bit CSI with an intermediate byte only (a cursor shape)', '\x9b q'],
    ['an 8-bit CSI with a parameter and an intermediate byte', '\x9b2 q'],
    ['a DCS with no body', '\x1bP\x1b\\'],
  ]
  for (const [name, sequence] of sequences) expect(stripFormat(`a${sequence}b`), name).toBe('ab')
  // `@` is a final byte, in a 7-bit and in an 8-bit CSI, and `~` is the last final byte of an nF escape.
  expect(stripFormat('a\x1b[1@b\x9b1@c')).toBe('abc')
  expect(stripFormat('a\x1b(~b')).toBe('ab')
})

// A stray ESC or U+009B goes alone, and the letter after it stays: `ESC c` and `ESC M` are no sequence here, and U+009B
// before a letter is no CSI (it has no parameter and no intermediate byte).
test('stripFormat takes a stray ESC or U+009B out alone, and leaves the letter after it', () => {
  expect(stripFormat('a\x1bcb')).toBe('acb')
  expect(stripFormat('a\x1bMb')).toBe('aMb')
  expect(stripFormat('a\x1b1b')).toBe('a1b') // a digit after a stray ESC stays too (`ESC 7` and `ESC 8` apart)
  expect(stripFormat('h\u{9b}i')).toBe('hi')
})

// A stray ESC takes no character with it, not even through a space or a dash after it: the first character of a token,
// a key or a flag stays (`ghp_` needs its `g`, `--token` its dash, `Bearer` its `B`), or the pattern of redact that
// starts there misses the secret.
test('a stray ESC takes no character of a secret: redact masks what stands after it', () => {
  const token = 'ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8' // `ghp_` and 36 letters and digits
  expect(redact('\x1bpassword=hunter22secret')).toBe('password=•••')
  expect(redact(` \x1b${token}`)).toBe(' •••')
  expect(redact('\x1b--token abcdefgh12345678')).toBe('--token •••')
  expect(redact('x \x1b Bearer abcdefgh12345678')).toBe('x  Bearer •••')
})

// The body of a control string ends at a line end (`\n` or `\r`) as well: a lone introducer, in pasted text, must not
// take whole lines up to a BEL or an ST far below it. It loses itself and nothing else, and the lines stay for redact.
test('stripFormat ends the body of a control string at a line end: a lone introducer takes no line', () => {
  expect(stripFormat('line1\n\x9d\nline2 x\nline3\x07 line4')).toBe('line1\n\nline2 x\nline3 line4')
  expect(stripFormat('line1\r\x9d\rline2 x\rline3\x07 line4')).toBe('line1\r\rline2 x\rline3 line4')
  expect(redact('a\x1b]0;x\npassword=hunter2secret\x07')).toBe('a0;x\npassword=•••')
})

// Each ESC of an unfinished sequence starts one and stops at the next ESC, so 128 KB of them cost one pass: a body that
// ran on to the end of the text, looking for its terminator, would read the rest of the text again from every start.
// The other starts do the same (a C1 introducer, an 8-bit CSI, an nF escape, a start that runs into line ends), and so
// do the runs of invisibles: 65,536 of them in a text, each judged once.
test('stripFormat reads 128 KB of unfinished sequences and of invisibles once: milliseconds, not seconds', () => {
  const cases: Array<[name: string, text: string, want: string]> = [
    ['ESC ] 65,536 times and a letter', `${'\x1b]'.repeat(65_536)}a`, 'a'], // 131,073 units, 128 KB
    ['ESC [ 65,536 times and a digit', `${'\x1b['.repeat(65_536)}0`, '0'], // the same, with no final byte
    ['U+009D', '\x9d'.repeat(131_072), ''],
    ['U+0090', '\x90'.repeat(131_072), ''],
    ['U+0098', '\x98'.repeat(131_072), ''],
    ['U+009E', '\x9e'.repeat(131_072), ''],
    ['U+009F', '\x9f'.repeat(131_072), ''],
    ['U+009B and a digit', '\x9b1'.repeat(65_536), '1'.repeat(65_536)],
    ['ESC and `(`', '\x1b('.repeat(65_536), '('.repeat(65_536)],
    ['ESC ] and 65,536 lines', `\x1b]${'a\n'.repeat(65_536)}`, 'a\n'.repeat(65_536)],
    ['`a` and U+034F', 'a\u{34F}'.repeat(65_536), 'a'.repeat(65_536)],
    ['`a` and ZWJ', `a${ZWJ}`.repeat(65_536), 'a'.repeat(65_536)],
    ['`a` and U+FE0F U+FE0F U+20E3', 'a\u{FE0F}\u{FE0F}\u{20E3}'.repeat(32_768), 'a'.repeat(32_768)],
  ]
  // The best of three rounds: a burst of load slows one round, not all of them, while a quadratic pass takes seconds in
  // each.
  let best = Infinity
  let results: string[] = []
  for (let round = 0; round < 3; round += 1) {
    const started = performance.now()
    results = cases.map(([, text]) => stripFormat(text))
    best = Math.min(best, performance.now() - started)
  }
  cases.forEach(([name, , want], index) => expect(results[index], name).toBe(want))
  expect(best).toBeLessThan(300) // generous: a body that ran on to the end took seconds
})

// A quoted value that nothing closes runs to the end of the line, and a key may be followed by 128 KB of spaces before
// its value: each is read in one pass; so are a backtick before a long scheme and 128 KB of no-break spaces after a
// scheme.
test('redact reads 128 KB of an unclosed quoted value and of a gap after a key once: milliseconds, not seconds', () => {
  const gap = ' '.repeat(131_072)
  const started = performance.now()
  expect(redact(`authorization="${'a'.repeat(131_072)}`)).toBe('authorization=•••')
  expect(redact(`"token":${gap}x`)).toBe(`"token":${gap}•••`)
  expect(redact(`Authorization: \`${'a'.repeat(131_072)}`)).toBe('Authorization: •••')
  expect(redact(`"token": \`Bearer${'\u{A0}'.repeat(131_072)}x`)).toBe('"token": •••')
  expect(redact(`Authorization: Foo${'\u{A0}'.repeat(131_072)}x`)).toBe('Authorization: •••')
  expect(performance.now() - started).toBeLessThan(300)
})

// U+10EEEE, a private-use code point, is the placeholder that the engine keeps for itself. It refuses a text child that
// holds it, as it refuses one that holds a control character, so it goes too: the code points beside it do not.
test('stripFormat takes out U+10EEEE, the placeholder of the engine, and no other private-use code point', () => {
  expect(stripFormat('a\u{10EEEE}b')).toBe('ab')
  expect(stripFormat('\u{10EEEE}\u{10EEEE}')).toBe('')
  const kept = '\u{10EEED}\u{10EEEF}\uE000'
  expect(stripFormat(kept)).toBe(kept)
})

// A removal between the two halves of U+10EEEE (U+DBFB and U+DEEE) would join them into the placeholder that the engine
// refuses, so a lone surrogate goes too. A surrogate pair is one code point, and it stays.
test('stripFormat leaves no U+10EEEE behind: a lone surrogate goes, so no removal can join two', () => {
  expect(stripFormat('a\uDBFB\u001b\uDEEEb')).toBe('ab')
  expect(stripFormat(`${'\uDBFB'.repeat(4)}${'\uDEEE'.repeat(4)}`)).toBe('')
  expect(stripFormat('a🚀b')).toBe('a\u{1F680}b')
})

test('stripFormat keeps a joiner between two non-ASCII characters: an emoji sequence, a Persian word', () => {
  expect(stripFormat(FAMILY)).toBe(FAMILY)
  expect(stripFormat(`${FAMILY} sleep 30`)).toBe(`${FAMILY} sleep 30`)
  expect(stripFormat(`run ${FAMILY}`)).toBe(`run ${FAMILY}`)
  expect(stripFormat(RAINBOW_FLAG)).toBe(RAINBOW_FLAG) // the variation selector before the joiner is no ASCII character
  expect(stripFormat(PERSIAN)).toBe(PERSIAN)
  // Either joiner stays between two characters of any kind above U+007F: accents, letters, Indic letters, emoji, and
  // U+00A1, the first one that is neither a control character (U+0080 to U+009F go) nor a space (U+00A0).
  const pairs = [['é', 'é'], ['ж', 'я'], ['\u0915', '\u0937'], [ROCKET, ROCKET], ['\u00A1', '\u00A1']] as const
  for (const [name, joiner] of JOINERS) {
    for (const [left, right] of pairs) {
      expect(stripFormat(`${left}${joiner}${right}`), name).toBe(`${left}${joiner}${right}`)
    }
    // A space further off is no neighbour: the joiner between two letters stays whatever surrounds the pair.
    expect(stripFormat(`${NBSP}é${joiner}é${NBSP} ${EM_SPACE}`), name).toBe(`${NBSP}é${joiner}é${NBSP} ${EM_SPACE}`)
  }
  // The rest of Cf goes from beside them, as from any text: the joiners are the only ones that stay.
  expect(stripFormat(`\u202E${FAMILY}\u200B${PERSIAN}\uFEFF`)).toBe(`${FAMILY}${PERSIAN}`)
  for (const [name, char] of FORMAT_CHARS) expect(stripFormat(`é${ZWJ}${char}${ZWNJ}é`), name).toBe(`é${ZWJ}${ZWNJ}é`)
})

test('stripFormat takes a joiner out when an ASCII character, or an end of the text, is beside it', () => {
  for (const [name, joiner] of JOINERS) {
    // In a branch or a folder name the joiner draws nothing, and it would hide a character: the name reads as it is.
    expect(stripFormat(`ma${joiner}in`), name).toBe('main')
    expect(stripFormat(`a${joiner}b${joiner}${joiner}c`), name).toBe('abc')
    // Beside an emoji it joins nothing either: an ASCII character is no part of an emoji sequence.
    expect(stripFormat(`a${joiner}${ROCKET}`), name).toBe(`a${ROCKET}`)
    expect(stripFormat(`${ROCKET}${joiner}a`), name).toBe(`${ROCKET}a`)
    // An ASCII character on one side is enough, whichever side it is.
    expect(stripFormat(`é${joiner}a`), name).toBe('éa')
    expect(stripFormat(`a${joiner}é`), name).toBe('aé')
    // A space, a tab and a line break are ASCII too, and so is `~`, the last printable ASCII character.
    expect(stripFormat(`é${joiner}~`), name).toBe('é~')
    expect(stripFormat(`é${joiner} é`), name).toBe('é é')
    expect(stripFormat(`é ${joiner}é`), name).toBe('é é')
    expect(stripFormat(`é\t${joiner}é`), name).toBe('é\té')
    expect(stripFormat(`é${joiner}\né`), name).toBe('é\né')
    // A space above U+007F is a space as well: it takes the joiner with it from either side, and from both.
    for (const [spaceName, space] of SPACES) {
      expect(stripFormat(`é${joiner}${space}`), `${name}, ${spaceName}`).toBe(`é${space}`)
      expect(stripFormat(`${space}${joiner}é`), `${name}, ${spaceName}`).toBe(`${space}é`)
      expect(stripFormat(`${space}${joiner}${space}`), `${name}, ${spaceName}`).toBe(`${space}${space}`)
    }
    // No character on a side, or on either: nothing to join.
    expect(stripFormat(`${joiner}é`), name).toBe('é')
    expect(stripFormat(`é${joiner}`), name).toBe('é')
    expect(stripFormat(`${FAMILY}${joiner}`), name).toBe(FAMILY)
    expect(stripFormat(joiner), name).toBe('')
    expect(stripFormat(`${joiner}${joiner}`), name).toBe('')
  }
})

test('stripFormat judges a joiner by the neighbours that remain, and a run of joiners as a whole', () => {
  // The rest of Cf goes first: a character of it beside a joiner does not count as a neighbour that keeps the joiner.
  for (const [name, char] of FORMAT_CHARS) {
    expect(stripFormat(`a${char}${ZWJ}${char}b`), name).toBe('ab')
    expect(stripFormat(`a${char}${ZWNJ}é`), name).toBe('aé')
    expect(stripFormat(`é${char}${ZWJ}${char}é`), name).toBe(`é${ZWJ}é`)
  }
  // A run stays whole or goes whole: its joiners are no neighbours to one another.
  expect(stripFormat(`a${ZWJ}${ZWNJ}${ZWJ}é`)).toBe('aé')
  expect(stripFormat(`é${ZWJ}${ZWNJ}${ZWJ}a`)).toBe('éa')
  expect(stripFormat(`é${ZWJ}${ZWNJ}é`)).toBe(`é${ZWJ}${ZWNJ}é`)
  expect(stripFormat(`é${ZWJ.repeat(3)}é`)).toBe(`é${ZWJ.repeat(3)}é`)
  expect(stripFormat(`a${ZWJ.repeat(3)}b é${ZWNJ.repeat(2)}é a${ZWNJ.repeat(2)}é`)).toBe(`ab é${ZWNJ.repeat(2)}é aé`)
})

test('stripFormat judges a joiner by what remains once the control characters are gone', () => {
  for (const [name, joiner] of JOINERS) {
    expect(stripFormat(`é${joiner}\u001bé`), name).toBe(`é${joiner}é`)
    expect(stripFormat(`é${joiner}\u001b[31mé`), name).toBe(`é${joiner}é`)
    expect(stripFormat(`é${joiner}\u001b[31ma`), name).toBe('éa')
    expect(stripFormat(`é${joiner}\u0085é`), name).toBe(`é${joiner}é`)
    expect(stripFormat(`é${joiner}\u0085a`), name).toBe('éa')
    expect(stripFormat(`a\u009b${joiner}é`), name).toBe('aé')
    expect(stripFormat(`é${joiner}\u{10EEEE}a`), name).toBe('éa')
  }
})

// redact and shorten run over whole prompts: a run of joiners must cost one pass, not one pass from each joiner.
test('stripFormat reads a long run of joiners once: 40,000 of them take a few milliseconds, not seconds', () => {
  const run = ZWJ.repeat(40_000)
  const started = performance.now()
  expect(stripFormat(`é${run}é`)).toBe(`é${run}é`)
  expect(stripFormat(`é${run}a`)).toBe('éa')
  expect(performance.now() - started).toBeLessThan(500) // a lookbehind and lookahead pair takes about two seconds
})

// The flags of England, Scotland and Wales are the black flag (U+1F3F4), the tag characters that spell `gbeng`, `gbsct`
// or `gbwls` (U+E0000 and the code of each letter) and the cancel tag (U+E007F). Tag characters are Cf, yet these three
// sequences stay whole. Spelled as escapes, so that this file shows what it says.
const BLACK_FLAG = '\u{1F3F4}'
const CANCEL_TAG = '\u{E007F}'
const FLAGS: Array<[name: string, flag: string]> = [
  ['England', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}'],
  ['Scotland', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}'],
  ['Wales', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}'],
]
// The tag characters that spell an ASCII word.
const tagged = (word: string): string =>
  [...word].map(letter => String.fromCodePoint(0xe0000 + letter.charCodeAt(0))).join('')

test('stripFormat keeps the flags of England, Scotland and Wales whole, though their tag characters are Cf', () => {
  for (const [name, flag] of FLAGS) {
    expect(stripFormat(flag), name).toBe(flag)
    expect(stripFormat(`${flag}${flag}`), name).toBe(`${flag}${flag}`)
    // In a longer text the other format characters go, the bidi controls among them, and the flag stays.
    for (const [charName, char] of FORMAT_CHARS) {
      expect(stripFormat(`${char}the ${flag}${char} flag${char}`), `${name}, ${charName}`).toBe(`the ${flag} flag`)
    }
  }
})

test('stripFormat leaves the black flag alone when the tag characters after it spell no flag of the three', () => {
  // The tag characters can carry invisible ASCII, a word or an instruction, so only the three flags keep theirs.
  expect(stripFormat(`${BLACK_FLAG}${tagged('hello')}${CANCEL_TAG}`)).toBe(BLACK_FLAG)
  const others: Array<[name: string, tags: string]> = [
    ['the cancel tag alone', CANCEL_TAG],
    ['gbeng with no cancel tag', tagged('gbeng')],
    ['gbeng with one letter more', `${tagged('gbengx')}${CANCEL_TAG}`],
    ['gbeng with one letter fewer', `${tagged('gben')}${CANCEL_TAG}`],
    ['gbeng in capitals', `${tagged('GBENG')}${CANCEL_TAG}`],
    ['gbeng twice, then one cancel tag', `${tagged('gbenggbeng')}${CANCEL_TAG}`],
    ['a subdivision that is no flag of the three', `${tagged('usca')}${CANCEL_TAG}`],
  ]
  for (const [name, tags] of others) expect(stripFormat(`a${BLACK_FLAG}${tags}b`), name).toBe(`a${BLACK_FLAG}b`)
  // After a whole flag, tag characters that are no flag go as well.
  for (const [name, flag] of FLAGS) expect(stripFormat(`${flag}${tagged('hello')}${CANCEL_TAG}`), name).toBe(flag)
})

test('stripFormat takes out tag characters that stand in no flag', () => {
  expect(stripFormat(`a${tagged('hello')}${CANCEL_TAG}b`)).toBe('ab')
  // The tag characters of a flag with no black flag before them, and the language tag and the tag space.
  for (const word of ['gbeng', 'gbsct', 'gbwls']) expect(stripFormat(`a${tagged(word)}${CANCEL_TAG}b`), word).toBe('ab')
  expect(stripFormat('a\u{E0001}\u{E0020}b')).toBe('ab')
  // Another flag that stands before them does not make a flag of them: the white flag is no part of one.
  expect(stripFormat(`\u{1F3F3}${tagged('gbeng')}${CANCEL_TAG}`)).toBe('\u{1F3F3}')
})

// The tag characters are in the text of a subagent, so a run of them, or of black flags with tags that stop short,
// must cost one pass: a pattern that looks behind each tag character for a black flag, or ahead from each black flag
// to the end of a run, reads a run again from each of its characters.
test('stripFormat reads long runs of tag characters once: 100,000 of them take milliseconds, not seconds', () => {
  const run = `a${tagged('hello').repeat(20_000)}${CANCEL_TAG}b`
  // Every proper start of each of the three flags, and `gbeng`, `gbsct` and `gbwls` with no cancel tag.
  const partials = ['gbeng', 'gbsct', 'gbwls'].flatMap(word =>
    [1, 2, 3, 4, 5].map(letters => `${BLACK_FLAG}${tagged(word.slice(0, letters))}`))
  const shortFlags = partials.join('').repeat(2_000)
  // The best of three rounds: a burst of load slows one round, not all of them, while a quadratic pattern takes seconds
  // in each.
  let best = Infinity
  let results: string[] = []
  for (let round = 0; round < 3; round += 1) {
    const started = performance.now()
    results = [stripFormat(run), stripFormat(shortFlags)]
    best = Math.min(best, performance.now() - started)
  }
  expect(results).toEqual(['ab', BLACK_FLAG.repeat(partials.length * 2_000)])
  expect(best).toBeLessThan(500)
})

// The invisible characters that are no format characters (Cf) draw nothing either: the combining grapheme joiner
// (U+034F), the variation selectors, the Hangul and Khitan fillers, the braille blank, the enclosing keycap (U+20E3).
// Each one hides a character from a pattern of redact (a token with U+034F in it is two words). With the joiners they
// go in runs, judged by the characters that remain round the run: it stays only where it modifies a character above
// U+007F (an emoji's U+FE0F, a filler after a Hangul syllable) or closes a keycap (`1` U+FE0F U+20E3).
const INVISIBLE =
  /^(?:[\u{200C}\u{200D}\u{2800}\u{16FE4}\u{2D7F}\u{20E3}]|(?!\p{Cf})\p{Default_Ignorable_Code_Point})$/u

test('stripFormat takes every invisible character out from between two ASCII letters', () => {
  let tried = 0
  for (let code = 0; code <= 0x10ffff; code += 1) {
    const char = String.fromCodePoint(code)
    if (!INVISIBLE.test(char)) continue
    tried += 1
    expect(stripFormat(`a${char}b`), `U+${code.toString(16).toUpperCase().padStart(4, '0')}`).toBe('ab')
  }
  expect(tried, 'the class has members').toBeGreaterThan(100)
})

test('stripFormat leaves an invisible that modifies a character above U+007F, and one that closes a keycap', () => {
  const kept: Array<[name: string, text: string]> = [
    ['a heart with U+FE0F', '\u{2764}\u{FE0F}'],
    ['a rocket with U+FE0F', `${ROCKET}\u{FE0F}`],
    ['a keycap, `1` U+FE0F U+20E3', '1\u{FE0F}\u{20E3}'],
    ['a keycap, `#` U+FE0F U+20E3', '#\u{FE0F}\u{20E3}'],
    ['a keycap, `*` U+20E3', '*\u{20E3}'],
    ['a family of emoji joined by ZWJ', FAMILY],
    ['a Persian word with a ZWNJ', PERSIAN],
    ['a Hangul syllable and the Hangul filler', '\u{AC00}\u{3164}'],
  ]
  for (const [name, text] of kept) expect(stripFormat(text), name).toBe(text)
  for (const [name, flag] of FLAGS) expect(stripFormat(flag), name).toBe(flag)
  // Keycaps glued side by side lose their marks: an ASCII word character follows each tail, and a token can begin with
  // a digit, so a tail that one follows would split it. A keycap before a space or at the end of the text keeps its
  // marks, and every digit is a base.
  const keycaps = '1\u{FE0F}\u{20E3}2\u{FE0F}\u{20E3}3\u{FE0F}\u{20E3}'
  expect(stripFormat(keycaps)).toBe('123')
  expect(stripFormat('1\u{FE0F}\u{20E3} item')).toBe('1\u{FE0F}\u{20E3} item')
  for (const digit of '0123456789') expect(stripFormat(` ${digit}\u{20E3}`), digit).toBe(` ${digit}\u{20E3}`)
  // A run that goes holds no keycap tail after it: the `a` touches the `1` once U+034F is gone.
  expect(stripFormat('a\u{34F}1\u{FE0F}\u{20E3}')).toBe('a1')
  // A lone U+FE0F, or another invisible, after an ASCII digit is no keycap tail: it goes.
  expect(stripFormat('1\u{FE0F} x')).toBe('1 x')
  expect(stripFormat('1\u{34F} x')).toBe('1 x')
  // Two keycaps whose bases touch no token character both stay: the run that stays is what the second base follows.
  const pair = '1\u{FE0F}\u{20E3}*\u{FE0F}\u{20E3}'
  expect(stripFormat(pair)).toBe(pair)
  // After a space the same filler modifies nothing: it goes. The character before a run decides, not the one after it.
  expect(stripFormat(' \u{3164}x')).toBe(' x')
  expect(stripFormat('a\u{34F}\u{E9}')).toBe('a\u{E9}')
  // A flag stays whole whatever follows it: its tag characters are format characters, and no run takes them.
  for (const [name, flag] of FLAGS) expect(stripFormat(`${flag}${ZWJ}a`), name).toBe(`${flag}a`)
})

// A secret that an invisible splits is one word again once the invisible is gone, and a character that goes first
// cannot hold it there: the run is judged by what remains round it.
test('redact masks a token that invisible characters split, whatever else goes beside them', () => {
  const head = 'ghp_A1b2C3'
  const tail = 'd4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8' // with `head`: `ghp_` and 36 letters and digits
  const split: Array<[name: string, text: string]> = [
    ['ZWJ and U+034F, twice', `${head}${ZWJ}\u{34F}${ZWJ}\u{34F}${tail}`],
    ['a zero-width space and U+034F', `${head}\u{200B}\u{34F}${tail}`],
    ['BEL and U+FE0F', `${head}\x07\u{FE0F}${tail}`],
    ['U+034F and U+20E3', `${head}\u{34F}\u{20E3}${tail}`],
    ['the braille blank, U+2800', `${head}\u{2800}${tail}`],
    ['a keycap tail after a digit of the token', `${head}\u{FE0F}\u{20E3}${tail}`],
  ]
  for (const [name, text] of split) expect(redact(text), name).toBe('•••')
  expect(redact('Bearer \u{34F}abcdefgh12345678')).toBe('Bearer •••')
  // The keycap exception is exact: another run after a lone digit goes, and so does a keycap tail after a digit that a
  // character of a token (a letter, a digit, `_` or `-`) touches, or that one follows: a token can begin with a digit.
  expect(redact('Bearer 1\u{34F}abcdefgh12345678')).toBe('Bearer •••')
  expect(redact('Bearer 1\u{FE0F}abcdefgh12345678')).toBe('Bearer •••')
  expect(redact('Bearer 1\u{FE0F}\u{20E3}abcdefgh12345678')).toBe('Bearer •••')
  expect(redact('ghp_1\u{FE0F}\u{20E3}abcdefgh12345678abcdefgh12345678')).toBe('•••')
  expect(redact('sk-1\u{FE0F}\u{20E3}abcdefgh12345678')).toBe('•••')
  for (const before of ['a', 'Z', '7', '_', '-']) {
    expect(stripFormat(`${before}1\u{FE0F}\u{20E3}`), before).toBe(`${before}1`)
  }
})

// A Bearer token can begin with a digit, and it holds more than a word does: `.`, `~`, `+` and `/` as well. A keycap
// tail between that digit and the rest would split it, so the tail goes before any character a token can hold. A lone
// U+FE0F, or another run, after the digit is no keycap tail at all.
test('redact masks a Bearer token that begins with a digit: a keycap tail goes before any token character', () => {
  expect(redact('Bearer 4\u{20E3}/3Q7x9Zk2LmN4pR8s')).toBe('Bearer •••')
  expect(redact('Bearer 4\u{FE0F}\u{20E3}/3Q7x9Zk2LmN4pR8s')).toBe('Bearer •••')
  for (const after of ['A', 'Z', '_', '-', '9', '.', '~', '+', '/']) {
    expect(redact(`Bearer 1\u{FE0F}\u{20E3}${after}bcdefgh12345678`), after).toBe('Bearer •••')
  }
  expect(redact('Bearer 1\u{20E3}abcdefgh12345678')).toBe('Bearer •••')
  expect(redact('Bearer 1\u{34F}/abcdefgh12345678')).toBe('Bearer •••')
  expect(redact('Bearer 1\u{FE0F}/abcdefgh12345678')).toBe('Bearer •••')
})

// What one pass takes out leaves nothing for a second pass to take: every text of one to three characters from the hard
// ones (the escapes and their pieces, the invisibles, a joiner, an emoji, a space) comes out as it stays.
test('stripFormat is idempotent over every short text of the hard characters', () => {
  const alphabet = [
    '\x1b', '\u{9b}', '\u{9c}', '\x07', '[', ']', '(', 'B', 'a', '1', ZWJ, ZWNJ, '\u{34F}', '\u{FE0F}', '\u{20E3}',
    ROCKET, ' ',
  ]
  let level = ['']
  for (let length = 1; length <= 3; length += 1) {
    level = level.flatMap(prefix => alphabet.map(char => `${prefix}${char}`))
    for (const text of level) {
      const once = stripFormat(text)
      expect(stripFormat(once), JSON.stringify(text)).toBe(once)
    }
  }
})

test('shorten and redact keep the joiners of an emoji sequence and of a Persian word, as stripFormat does', () => {
  for (const text of [FAMILY, PERSIAN]) {
    expect(shorten(text, 20), text).toBe(text)
    expect(redact(text), text).toBe(text)
  }
  expect(shorten(`\u202E${FAMILY} ${PERSIAN}\u200B`, 20)).toBe(`${FAMILY} ${PERSIAN}`)
  expect(redact(`\uFEFF${FAMILY} token=hunter22secret`)).toBe(`${FAMILY} token=•••`)
  // Beside an ASCII character a joiner goes from what shorten shows and from what redact returns.
  expect(shorten(`ma${ZWJ}in`, 20)).toBe('main')
  expect(redact(`ma${ZWNJ}in`)).toBe('main')
})

test('shorten takes the format characters out before it cuts', () => {
  for (const [name, char] of FORMAT_CHARS) expect(shorten(`Edit ${char}fdp.exe`, 20), name).toBe('Edit fdp.exe')
  // They do not count towards the length: 70 visible characters are no more than 70, with 30 of them mixed in.
  const long = 'x'.repeat(70)
  expect(shorten(`${long.slice(0, 35)}${'\u202E'.repeat(30)}${long.slice(35)}`, 70)).toBe(long)
  // And a cut text ends in the ellipsis after the visible characters alone.
  expect(shorten(`ab\u202Ecdefgh`, 5)).toBe('abcd…')
  // A text of nothing else is empty.
  expect(shorten('\u202E\u200B', 5)).toBe('')
})

test('shorten does not cut a surrogate pair in two: the ellipsis follows a whole emoji, never a lone surrogate', () => {
  const rockets = ROCKET.repeat(10) // 20 UTF-16 units
  // The cut of max 6 is 5 units: two rockets and the first unit of a third, which goes too.
  expect(shorten(rockets, 6)).toBe(`${ROCKET}${ROCKET}…`)
  expect(shorten(rockets, 5)).toBe(`${ROCKET}${ROCKET}…`) // 4 units: the pair stands whole
  // A lone surrogate is what `\p{Cs}` matches with the `u` flag: none at any cut.
  for (let max = 2; max < 20; max += 1) expect(/\p{Cs}/u.test(shorten(rockets, max)), `max ${max}`).toBe(false)
  expect(shorten(ROCKET.repeat(3), 6)).toBe(ROCKET.repeat(3)) // a text that fits is not cut
})

test('redact takes the format characters out first: one inside a secret does not keep it from being masked', () => {
  const split = `ghp_abc\u200Bdefgh12345678`
  expect(redact(split)).toBe('•••')
  // What the pane shows is shorten(redact(text)): the secret must not be there once the characters are gone.
  expect(shorten(redact(`echo ${split}`), 64)).toBe('echo •••')
  expect(redact('key sk-abcd\u202Eefgh1234 end')).toBe('key ••• end')
  expect(redact('plain text')).toBe('plain text')
})

test('redact masks a secret that has a joiner inside it: beside an ASCII character the joiner goes first', () => {
  for (const [name, joiner] of JOINERS) {
    expect(redact(`ghp_abc${joiner}defgh12345678`), name).toBe('•••')
    expect(shorten(redact(`echo ghp_abc${joiner}defgh12345678`), 64), name).toBe('echo •••')
    expect(redact(`key sk-abcd${joiner}efgh1234 end`), name).toBe('key ••• end')
    expect(redact(`token${joiner}=hunter22secret`), name).toBe('token=•••')
    expect(redact(`Bearer abc${joiner}defghijk`), name).toBe('Bearer •••')
    // A joiner with the rest of Cf beside it, and a joiner at the very start of a secret.
    expect(redact(`ghp_abc\u200B${joiner}\u200Bdefgh12345678`), name).toBe('•••')
    expect(redact(`é${joiner}ghp_abcdefgh12345678`), name).toBe('é•••')
    // Between a key and its value there is `\s*`, a space of any kind: a joiner between two spaces above U+007F goes,
    // and the value is masked as it is without the joiner (at 0.3.0 it was; the joiner once stood in the way).
    expect(redact(`token=${NBSP}${joiner}${NBSP}hunter22secret`), name).toBe(`token=${NBSP}${NBSP}•••`)
    expect(redact(`Authorization:${EM_SPACE}${joiner}${EM_SPACE}abcdef123456`), name)
      .toBe(`Authorization:${EM_SPACE}${EM_SPACE}•••`)
    expect(redact(`Bearer${NBSP}${joiner}${NBSP}abcdefgh12345678`), name).toBe('Bearer •••')
    // A joiner that stays, between two non-ASCII characters, is no gap: the open part of a pattern matches through it.
    expect(redact(`password=é${joiner}é`), name).toBe('password=•••')
    expect(redact(`https://user:pé${joiner}ss@host`), name).toBe('https://user:•••@host')
  }
})

test('plainText takes the `**` of a pair, backticks and the `#` marks of a heading at a line start out', () => {
  const cases: Array<[markdown: string, plain: string]> = [
    ['**Verdict:** ok', 'Verdict: ok'],
    ['**One** and **two**', 'One and two'],
    ['a **b** c', 'a b c'],
    ['**1** failed and **2** passed', '1 failed and 2 passed'], // a body of one character closes at its own `**`
    ['(**note**)', '(note)'], // a bracket, a comma or a stop beside the pair is no letter or digit
    ['**Note**, **this**.', 'Note, this.'],
    ['**bold** and 2**10 and **again**', 'bold and 2**10 and again'], // the pair goes, the exponent stays
    ['**bold with spaces inside**', 'bold with spaces inside'], // the spaces inside stay: only the pair goes
    // A letter of another script outside a pair keeps it no more than a space does: only an ASCII letter, digit or `_`
    // does. In scripts written without spaces, and inside words of other scripts, bold is glued to letters, and
    // markdown reads it as bold.
    ['这是**重要**的', '这是重要的'],
    ['日本語の**太字**です', '日本語の太字です'],
    ['คำ**หนา**ไทย', 'คำหนาไทย'],
    ['**Итог:** готово', 'Итог: готово'],
    ['слово**жирный** текст', 'словожирный текст'],
    ['नम**स्ते** y', 'नमस्ते y'],
    ['नमस्ते**x** y', 'नमस्तेx y'], // the word ends in a vowel sign, a mark and no letter: it keeps nothing either
    ['`a`', 'a'],
    ['run `git status` now', 'run git status now'],
    ['```\ncode\n```', '\ncode\n'],
    ['**`code`**', 'code'],
    ['# Title', 'Title'],
    ['# Title\nbody', 'Title\nbody'],
    ['## Findings\n\n### Detail\ntext', 'Findings\n\nDetail\ntext'],
    ['**One** and `two`', 'One and two'],
    ['', ''],
  ]
  for (const [markdown, plain] of cases) expect(plainText(markdown), JSON.stringify(markdown)).toBe(plain)
})

test('plainText leaves `__`, a lone `**`, one beside a space or an ASCII word, and a `#` that is no heading', () => {
  const kept = [
    // Never `__`: a dunder is a name, not bold.
    '__init__.py', '__Verdict:__ ok', 'def __init__(self): pass', 'snake__case',
    // A `**` that stands alone or has a space beside it is an exponent, not bold.
    'x ** 2', '2**10', 'a ** b ** c', '2 ** 10 and 3 ** 4', '**', '****', '** spaced **', '**bold **', '** bold**',
    // Two exponents are a pair of `**` with text between them, but an ASCII letter or a digit touches an end of it.
    '2**10 and 3**4', 'x**y and z**w', 'x**2 and y**3', 'π**2 and e**x', '2**n and 2**(n+1)',
    // A pair that an ASCII letter, a digit or `_` touches on either side is no pair: the `**` is inside a word.
    '**a**b', 'a**b**', 'x**y**z', '**1**2', 'a_**b**', '**a**_b',
    // A pair has to be on one line.
    '**one\ntwo**',
    // A `#` that is no heading: no space after it, or not at the start of a line.
    '#hashtag', 'issue #12 is open', 'a # b',
    // One star or one underscore is no mark.
    '*one* and _two_ and snake_case',
  ]
  for (const text of kept) expect(plainText(text), JSON.stringify(text)).toBe(text)
  // In a mix, the pair goes and the rest stays.
  expect(plainText('**fixed `__init__.py`** and x ** 2')).toBe('fixed __init__.py and x ** 2')
})

test('textHead is the first `max` UTF-16 units of a text; one of `max` units or fewer comes back as it is', () => {
  expect(textHead('abcdef', 4)).toBe('abcd')
  expect(textHead('abcdef', 6)).toBe('abcdef')
  expect(textHead('abc', 6)).toBe('abc')
  expect(textHead('abcdef', 0)).toBe('')
})

test('textHead does not split a surrogate pair: the high surrogate that the cut leaves alone goes too', () => {
  // A rocket is two UTF-16 units, a high surrogate and a low one.
  expect(textHead(`ab${ROCKET}c`, 3)).toBe('ab') // the cut falls between the two units of the rocket
  expect(textHead(`ab${ROCKET}c`, 4)).toBe(`ab${ROCKET}`) // here the pair is whole
  expect(textHead(`${ROCKET}${ROCKET}`, 1)).toBe('')
  // The high surrogates are U+D800 to U+DBFF, both ends included; a low surrogate (U+DC00 on) at the cut stays.
  expect(textHead('a\uD800b', 2)).toBe('a')
  expect(textHead('a\uDBFFb', 2)).toBe('a')
  expect(textHead('a\uDC00b', 2)).toBe('a\uDC00')
  // A text of `max` units or fewer is not cut, whatever it ends in: here a high surrogate that nothing follows.
  const lone = ROCKET.slice(0, 1)
  expect(textHead(`a${lone}`, 2)).toBe(`a${lone}`)
})

test('wordHead is the head of a text less a short word the cut goes through; one of `max` units or fewer is not cut',
  () => {
    expect(wordHead('abc def', 7)).toBe('abc def')
    expect(wordHead('abc def', 20)).toBe('abc def')
    expect(wordHead('', 0)).toBe('')
    // A cut inside a word drops the word, and keeps the whitespace before it.
    expect(wordHead('abc def ghi', 6)).toBe('abc ')
    expect(wordHead('abc def ghi', 10)).toBe('abc def ')
    // A head that ends in a word drops it, even when the cut falls just at the end of the word.
    expect(wordHead('abc def ghi', 7)).toBe('abc ')
    // A cut right after whitespace keeps the head up to it, whatever the whitespace is.
    expect(wordHead('abc def', 4)).toBe('abc ')
    expect(wordHead('abc\ndef', 4)).toBe('abc\n')
    expect(wordHead('abc\tdef', 4)).toBe('abc\t')
    expect(wordHead('abc  \n def', 6)).toBe('abc  \n')
    // A head with no whitespace at all is the head as textHead gives it: nothing in it is a word that ended.
    expect(wordHead('abcdefgh', 4)).toBe('abcd')
  })

test('wordHead drops the last word of the head when it has CUT_WORD_MAX units or fewer, and keeps a longer one', () => {
  expect(CUT_WORD_MAX).toBe(256)
  // A last run of 256 units goes, with the whitespace before it kept.
  expect(wordHead(`ab ${'x'.repeat(256)}y`, 3 + 256)).toBe('ab ')
  // One of 257 units stays: the head is cut through it.
  expect(wordHead(`ab ${'x'.repeat(257)}y`, 3 + 257)).toBe(`ab ${'x'.repeat(257)}`)
  // Whitespace and then a run of 4000 units, a paragraph of a script that has no spaces: the run stays, cut through.
  expect(wordHead(`ab ${'あ'.repeat(4000)}`, 1000)).toBe(`ab ${'あ'.repeat(997)}`)
  // A head with no whitespace is the head as textHead gives it, whether its run has 256 units or 257.
  expect(wordHead('x'.repeat(300), 256)).toBe('x'.repeat(256))
  expect(wordHead('x'.repeat(300), 257)).toBe('x'.repeat(257))
})

test('wordHead takes whitespace as `\\s` does: a no-break space and a wide space end a word like a plain one', () => {
  expect(wordHead(`ab${NBSP}cdef`, 5)).toBe(`ab${NBSP}`)
  expect(wordHead(`ab${NBSP}cdef`, 3)).toBe(`ab${NBSP}`)
  expect(wordHead(`ab${EM_SPACE}cdef`, 5)).toBe(`ab${EM_SPACE}`)
  // A zero-width space is no whitespace to `\s`, so the word goes on through it.
  expect(wordHead('x ab\u200Bcdef', 6)).toBe('x ')
})

test('wordHead drops a word that the cut splits a surrogate pair of, and keeps a pair that stands whole', () => {
  // The cut falls between the two units of the rocket: textHead drops the high unit, and the word goes with it.
  expect(wordHead(`ab c${ROCKET}d`, 5)).toBe('ab ')
  expect(wordHead(`ab c${ROCKET}d`, 6)).toBe('ab ') // a pair that is whole at the cut is part of the word too
  expect(wordHead(`${ROCKET} ${ROCKET}`, 3)).toBe(`${ROCKET} `)
  // A head with no whitespace is textHead's: the high surrogate at the cut goes, the pair before it stays.
  expect(wordHead(`${ROCKET}${ROCKET}`, 3)).toBe(ROCKET)
})

// The head of the Log's texts is 4096 units, and the scan back from its end stops after CUT_WORD_MAX units of a run.
test('wordHead handles a head of 4096 units with no whitespace, and more after it, in a few milliseconds', () => {
  const started = performance.now()
  expect(wordHead(`${'x'.repeat(4096)} and more`, 4096)).toBe('x'.repeat(4096))
  expect(wordHead('x'.repeat(100_000), 4096)).toBe('x'.repeat(4096))
  expect(performance.now() - started).toBeLessThan(500)
})

test('redact', () => {
  expect(redact('curl -H "Authorization: Bearer abcdefgh12345"')).not.toContain('abcdefgh12345')
  const cases: Array<[string, string]> = [
    ['API_KEY=xyz123 run', 'API_KEY=••• run'],
    ['Authorization: Basic dXNlcjpwYXNz', 'Authorization: Basic •••'],
    ['use bearer abcdefgh12345 here', 'use bearer ••• here'],
    ['key sk-abcdefgh1234 end', 'key ••• end'],
    ['run --token abc123 now', 'run --token ••• now'],
    ['STRIPE_KEY=abc123 run', 'STRIPE_KEY=••• run'],
    ['postgres://user:hunter2@db:5432/x', 'postgres://user:•••@db:5432/x'],
  ]
  for (const [input, want] of cases) expect(redact(input), `redact(${input})`).toBe(want)
})

// An Authorization header whose value is in quotes, as a header is in JSON, a Ruby hash, a shell word or a log. SECRETS
// takes `"Bearer` for the value there and masks that word alone, so the token behind the space stays. A quoted value is
// one value, spaces and all, whatever its quotes (straight, backtick or curly), with a backslash escaping a quote
// inside the straight ones; one that nothing closes runs to the end of the line, as a cut text leaves it.
test('redact masks a quoted Authorization value whole: any quotes, any scheme inside it, a hash rocket', () => {
  const cases: Array<[input: string, want: string]> = [
    ['Authorization: "Bearer abcdefgh12345678"', 'Authorization: •••'],
    ['"Authorization": "Basic dXNlcjpwYXNzd29yZA=="', '"Authorization": •••'],
    ["authorization='abcdefgh12345678'", 'authorization=•••'],
    ['Authorization: `Bearer abcdefgh12345678`', 'Authorization: •••'],
    ['Authorization: \u{201C}Bearer abcdefgh12345678\u{201D}', 'Authorization: •••'],
    ['Authorization: \u{2018}Bearer abcdefgh12345678\u{2019}', 'Authorization: •••'],
    ["'Authorization' => 'Basic dXNlcjpwYXNzd29yZA=='", "'Authorization' => •••"],
    // The key may have a quote of its own, a space before the separator and none after it, and any case.
    ['`authorization` = `Bearer abcdefgh12345678`', '`authorization` = •••'],
    ['AUTHORIZATION:"Bearer abcdefgh12345678"', 'AUTHORIZATION:•••'],
    // The value ends at its closing quote, and what follows stays; a quote that a backslash escapes does not close it.
    ['{"Authorization": "Bearer abcdefgh12345678", "Accept": "x"}', '{"Authorization": •••, "Accept": "x"}'],
    ['Authorization: "Bearer abcd\\"efgh 12345678" end', 'Authorization: ••• end'],
    ["Authorization: 'Bearer abcd\\'efgh 12345678' end", 'Authorization: ••• end'],
    // Every occurrence goes, not the first alone.
    ['Authorization: "a b" and authorization="c d"', 'Authorization: ••• and authorization=•••'],
  ]
  for (const [input, want] of cases) expect(redact(input), JSON.stringify(input)).toBe(want)
  // Each kind of quote ends its value at its own closing quote; one that nothing closes ends with its line, whichever
  // line end that is (a backtick one is no quoted value, and AUTH_SCHEME takes it with its scheme and credential).
  const quotes: Array<[open: string, close: string]> = [
    ['"', '"'], ["'", "'"], ['`', '`'], ['\u{201C}', '\u{201D}'], ['\u{2018}', '\u{2019}'],
  ]
  for (const [open, close] of quotes) {
    expect(redact(`Authorization: ${open}Bearer abcd efgh 12345678${close} end`), open).toBe('Authorization: ••• end')
    for (const eol of ['\n', '\r', '\r\n']) {
      const unclosed = redact(`Authorization: ${open}Bearer abcdefgh12345678${eol}next line`)
      expect(unclosed, `${open} ${JSON.stringify(eol)}`).toBe(`Authorization: •••${eol}next line`)
    }
  }
})

// SECRETS masks the value of a key only when the `:` or `=` comes right after the key. In JSON, a Python dict and a
// curl body a quote stands between them (`"password":"…"`), and the value showed. That quote is what makes a word a key
// here: `the token count` and `"tokens"` are none. The value is a quoted one, as above, or a bare one up to a space, a
// comma, a semicolon or a closing bracket.
test('redact masks the value of a quoted key: JSON, a dict, a curl body, a bare value', () => {
  const cases: Array<[input: string, want: string]> = [
    ['{"password":"hunter2secret"}', '{"password":•••}'],
    ['{"access_token":"abcdefgh12345678","expires":3600}', '{"access_token":•••,"expires":3600}'],
    ["{'password': 'hunter2secret'}", "{'password': •••}"],
    ['"password": hunter2secret', '"password": •••'],
    [`curl -d '{"username":"u","password":"hunter2secret"}'`, `curl -d '{"username":"u","password":•••}'`],
    ['"password"=hunter2secret', '"password"=•••'],
    ['{"password" : "hunter2 secret", "user": "u"}', '{"password" : •••, "user": "u"}'],
    ['{"Password": "hunter2secret"}', '{"Password": •••}'],
    ['`token`: `abcdefgh12345678`', '`token`: •••'],
    // The name may have a prefix: `refresh_token` ends in `token`.
    ['{"refresh_token": "abcdefgh12345678"}', '{"refresh_token": •••}'],
    // Every occurrence goes, not the first alone.
    ['{"password":"a b","token":"c d"}', '{"password":•••,"token":•••}'],
  ]
  for (const [input, want] of cases) expect(redact(input), JSON.stringify(input)).toBe(want)
  // Every name of the pattern, with its separator and without, holding a value that has a space in it.
  const names = [
    'api_key', 'api-key', 'apikey', 'access_token', 'access-token', 'accesstoken', 'auth_token', 'auth-token',
    'authtoken', 'client_secret', 'client-secret', 'clientsecret', 'token', 'secret', 'password', 'passwd', 'pwd',
  ]
  for (const name of names) expect(redact(`{"${name}": "two words"}`), name).toBe(`{"${name}": •••}`)
  // A bare value ends at a space, a comma, a semicolon, a closing bracket or a brace.
  for (const end of [' ', ',', ';', '}', ']', ')']) {
    expect(redact(`"password": hunter2secret${end}rest`), JSON.stringify(end)).toBe(`"password": •••${end}rest`)
  }
})

// A hash rocket after a quoted key: the arrow is read before `=`. Read the other way, `=` takes the first character of
// `=>` and a bare value takes the `>`, so the quoted value behind it stays in view.
test('redact masks the value after a hash rocket whole: the arrow is read before `=`', () => {
  const cases: Array<[input: string, want: string]> = [
    ["{'password' => 'hunter2 secret'}", "{'password' => •••}"],
    ['"password" => "hunter2secret"', '"password" => •••'],
    ["'api_key' => 'abcdefgh12345678'", "'api_key' => •••"],
    ['"password"=>x', '"password"=>•••'],
  ]
  for (const [input, want] of cases) expect(redact(input), JSON.stringify(input)).toBe(want)
})

// A pattern must not eat the anchor of one that comes after it. A bare value can be a Bearer or a Basic credential,
// which SECRETS reads by its scheme: the key takes the scheme with the credential, not the scheme alone. A bare value
// does not begin with a bracket (a nested value is left to the patterns that read inside it), and it stands on the line
// of its key: the lines behind a key whose value is a block belong to SECRETS. The credential of a scheme does not
// begin with `--`, a flag that SECRETS reads (`--token x`).
test('redact leaves the anchor of a later pattern to it: Bearer, a nested value, the next line, a flag', () => {
  const cases: Array<[input: string, want: string]> = [
    ['"token": Bearer abcdefgh12345678', '"token": •••'],
    ["'secret': Bearer abcdefgh12345678", "'secret': •••"],
    ['"password": Basic dXNlcjpwYXNz==', '"password": •••'],
    ['"token": BEARER   abcdefgh12345678', '"token": •••'],
    [`{"secret": {password: 'hunter2secret'}}`, '{"secret": {password: •••}}'],
    ['"secret":\n  password: hunter2secret', '"secret":\n  password: •••'],
    ['"secret":\r\n  password: hunter2secret', '"secret":\r\n  password: •••'],
    ['"secret":\r  password: hunter2secret', '"secret":\r  password: •••'],
    // The line separator and the paragraph separator end a line as LF does.
    ['"secret":\u{2028}password: hunter2secret', '"secret":\u{2028}password: •••'],
    ['"secret":\u{2029}password: hunter2secret', '"secret":\u{2029}password: •••'],
    // Any whitespace but a line end is a gap: a tab, a no-break space, an ideographic space.
    ['"password":\thunter2secret', '"password":\t•••'],
    ['"password":\u{A0}hunter2secret', '"password":\u{A0}•••'],
    ['"password":\u{3000}hunter2secret', '"password":\u{3000}•••'],
    ['Authorization: Foo --token hunter2secret', 'Authorization: ••• --token •••'],
    // Only a credential that begins with `--` is a flag.
    ['Authorization: Token abc--def', 'Authorization: •••'],
    ['Authorization: Token -abcdefgh', 'Authorization: •••'],
  ]
  for (const [input, want] of cases) expect(redact(input), JSON.stringify(input)).toBe(want)
  // A bracket begins a value that is no bare one: to this pattern there is no value here.
  for (const open of ['{', '[', '(']) {
    const text = `"password": ${open}x`
    expect(redact(text), open).toBe(text)
  }
  // A quoted value of any kind may begin on the next line.
  const quotes: Array<[open: string, close: string]> = [
    ['"', '"'], ["'", "'"], ['`', '`'], ['\u{201C}', '\u{201D}'], ['\u{2018}', '\u{2019}'],
  ]
  for (const [open, close] of quotes) {
    expect(redact(`"token":\n  ${open}two words${close}`), open).toBe('"token":\n  •••')
  }
})

// A key, or the word `Authorization`, in curly quotes (a chat, a document or a word processor makes them). Either quote
// of a pair may close the name: the German closing quotes are the English opening ones.
test('redact masks a key and a header written in curly quotes', () => {
  const [ldq, rdq, lsq, rsq] = ['\u{201C}', '\u{201D}', '\u{2018}', '\u{2019}']
  const cases: Array<[input: string, want: string]> = [
    [`${ldq}password${rdq}: ${ldq}hunter2secret${rdq}`, `${ldq}password${rdq}: •••`],
    [`${ldq}Authorization${rdq}: ${ldq}Token abcdefgh12345678${rdq}`, `${ldq}Authorization${rdq}: •••`],
    [`${lsq}api_key${rsq}: ${lsq}abcdefgh12345678${rsq}`, `${lsq}api_key${rsq}: •••`],
    [`${ldq}access_token${rdq}:${ldq}abcdefgh12345678${rdq}`, `${ldq}access_token${rdq}:•••`],
    // A name closed by the other quote of its pair, with a bare value, and a header with a bare scheme.
    [`\u{201E}password${ldq}: hunter2secret`, `\u{201E}password${ldq}: •••`],
    [`\u{201A}api_key${lsq}: abcdefgh12345678`, `\u{201A}api_key${lsq}: •••`],
    [`${ldq}Authorization${rdq}: Token abcdefgh12345678`, `${ldq}Authorization${rdq}: •••`],
  ]
  for (const [input, want] of cases) expect(redact(input), JSON.stringify(input)).toBe(want)
})

// A credential runs to the next space and a bare value to a space or a closing bracket, so base64, a JWT and a password
// keep every character they hold.
test('redact masks a credential or a value whole when it holds punctuation: base64, a JWT, a password', () => {
  const cases: Array<[input: string, want: string]> = [
    ['Authorization: Token dGVzdA==.a-b/c+d', 'Authorization: •••'],
    ['Authorization: JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig', 'Authorization: •••'],
    ['"password": p@ss.w0rd-x/y=', '"password": •••'],
  ]
  for (const [input, want] of cases) expect(redact(input), JSON.stringify(input)).toBe(want)
})

// SECRETS skips a Bearer or a Basic scheme and masks the credential after it, but it takes any other scheme for the
// value and masks that word alone: `Authorization: Token abc…` shows `abc…`. A scheme is a word (letters, digits, `_`,
// `.` and `-` after its first letter) and a space before the credential. Bearer and Basic keep the rule they had, and a
// word that only starts with one of them is another scheme.
test('redact masks the credential after any Authorization scheme: Token, Bot, ApiKey and the rest', () => {
  const cases: Array<[input: string, want: string]> = [
    ['Authorization: Token abcdefgh12345678', 'Authorization: •••'],
    ['Authorization: token abcdefgh12345678', 'Authorization: •••'],
    ['Authorization: Bot abcdefgh12345678', 'Authorization: •••'],
    ['Authorization: ApiKey abcdefgh12345678', 'Authorization: •••'],
    ['Authorization: Api-Key.v2 abcdefgh12345678', 'Authorization: •••'],
    ['Authorization:Token abcdefgh12345678', 'Authorization:•••'],
    ['"Authorization": Token abcdefgh12345678', '"Authorization": •••'],
    ["'Authorization': Token abcdefgh12345678", "'Authorization': •••"],
    ['`Authorization`: Token abcdefgh12345678', '`Authorization`: •••'],
    ['authorization=Token abcdefgh12345678', 'authorization=•••'],
    ['Authorization: Token \t abcdefgh12345678', 'Authorization: •••'],
    // Every occurrence goes, not the first alone.
    [
      'Authorization: Token abcdefgh12345678 and authorization: Bot abcdefgh12345678',
      'Authorization: ••• and authorization: •••',
    ],
    ['Authorization: Bearerx abcdefgh12345678', 'Authorization: •••'],
    ['Authorization: Basicx dXNlcjpwYXNz', 'Authorization: •••'],
    ['Authorization: Bearer abcdefgh12345678', 'Authorization: Bearer •••'],
    ['Authorization: Basic dXNlcjpwYXNz', 'Authorization: Basic •••'],
  ]
  for (const [input, want] of cases) expect(redact(input), JSON.stringify(input)).toBe(want)
})

// SECRETS starts a token at a word boundary (`\b`), so one that a word touches shows. A whole escape sequence goes out
// of a text and leaves what was beside it glued: `x`, U+009B, `31m` and `ghp_…` read `xghp_…` once the sequence is
// gone, with no boundary between `x` and `g`. GitHub and Slack tokens are masked wherever they stand, in the shape they
// have: a GitHub token is 36 letters and digits after `ghp_` (or `gho_`, `ghu_`, `ghs_`, `ghr_`), a fine-grained one
// 22 letters, digits and underscores after `github_pat_`, a Slack token 10 letters, digits and dashes after `xoxb-` (or
// `xoxa-`, `xoxp-`, `xoxr-`, `xoxs-`). `sk-`, `pk-` and `rk-` are not: `task-management` holds `sk-management`.
test('redact masks a GitHub or Slack token that a word touches, as the removal of an escape sequence leaves it', () => {
  const token = 'ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8' // `ghp_` and 36 letters and digits
  expect(redact(`x\x9b31m${token}`)).toBe('x•••')
  expect(redact(`x\x1b(B${token}`)).toBe('x•••')
  expect(redact(`foo${token}`)).toBe('foo•••')
  // GitHub: 36 characters make a token and 35 do not; the separator is `_`, and a dash is a Slack one.
  const github = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
  for (const prefix of ['ghp', 'gho', 'ghu', 'ghs', 'ghr']) {
    expect(redact(`${prefix}_${github}`), prefix).toBe('•••')
    expect(redact(`foo${prefix}_${github}`), prefix).toBe('foo•••')
    expect(redact(`foo${prefix}_${github.slice(1)}`), prefix).toBe(`foo${prefix}_${github.slice(1)}`)
    expect(redact(`foo${prefix}-${github}`), prefix).toBe(`foo${prefix}-${github}`)
  }
  // Fine-grained: 22 characters and 21, with `_` in the body; `_` ends the prefix, and a dash does not.
  const fine = '11AbCdEfG0_hIjKlMnOpQr'
  expect(redact(`github_pat_${fine}`)).toBe('•••')
  expect(redact(`foogithub_pat_${fine}`)).toBe('foo•••')
  expect(redact(`foogithub_pat_${fine.slice(1)}`)).toBe(`foogithub_pat_${fine.slice(1)}`)
  expect(redact(`foogithub_pat-${fine}`)).toBe(`foogithub_pat-${fine}`)
  // Slack: 10 characters and 9, with `-` in the body; the separator is `-`, and an underscore is a GitHub one.
  const slack = '1234-AbC-9'
  for (const prefix of ['xoxa', 'xoxb', 'xoxp', 'xoxr', 'xoxs']) {
    expect(redact(`${prefix}-${slack}`), prefix).toBe('•••')
    expect(redact(`foo${prefix}-${slack}`), prefix).toBe('foo•••')
    expect(redact(`foo${prefix}-${slack.slice(1)}`), prefix).toBe(`foo${prefix}-${slack.slice(1)}`)
    expect(redact(`foo${prefix}_${slack}`), prefix).toBe(`foo${prefix}_${slack}`)
  }
  // No other character joins a run: a GitHub body has no `_` or `-`, a fine-grained one no `-`, a Slack one no `_`.
  for (const text of [
    `fooghp_${'a'.repeat(18)}_${'b'.repeat(17)}`,
    `fooghp_${'a'.repeat(18)}-${'b'.repeat(17)}`,
    `foogithub_pat_${'a'.repeat(11)}-${'b'.repeat(10)}`,
    `fooxoxb-${'a'.repeat(5)}_${'b'.repeat(5)}`,
  ]) expect(redact(text), text).toBe(text)
  // Every occurrence goes, not the first alone.
  expect(redact(`foo${token} bar${token}`)).toBe('foo••• bar•••')
})

// The same for a Bearer token: a word that touches `Bearer` hides the token from SECRETS, which wants a word boundary.
test('redact masks a Bearer token that a word touches, and keeps one space between the word and the mask', () => {
  expect(redact('x\x1b[1mBearer abcdefgh12345678')).toBe('xBearer •••')
  expect(redact('xBearer abcdefgh12345678')).toBe('xBearer •••')
  expect(redact('fooBearer abcdefgh12345678')).toBe('fooBearer •••')
  expect(redact('fooBearer \t abcdefgh12345678==')).toBe('fooBearer •••')
  // The token has eight characters of the Bearer alphabet at least; the alphabet holds `.`, `_`, `~`, `+`, `/` and `-`.
  expect(redact('fooBearer abcdefgh')).toBe('fooBearer •••')
  expect(redact('fooBearer abcdefg')).toBe('fooBearer abcdefg')
  expect(redact('fooBearer a.b_c~d+e/f-g12345')).toBe('fooBearer •••')
  // Every occurrence goes, not the first alone.
  expect(redact('fooBearer abcdefgh12345678 barBearer abcdefgh12345678')).toBe('fooBearer ••• barBearer •••')
})

// The glued patterns have no `\b`, so they match the shape of a token and no looser: a word that holds a prefix with a
// dash or an underscore after it keeps its tail (`laughs-at-everything` holds `ghs-at-everything`), and a word that
// ends in `bearer` is prose (`pallbearer carrying` is `bearer` and a word of eight letters).
test('redact leaves alone the words that hold a token prefix or end in `bearer`', () => {
  const kept = [
    'He laughs-at-everything we say', 'the highs-and-lows of it', 'def laughs_loudly_at_x()',
    '/home/u/projects/weighs-and-measures/README.md', 'the pallbearer carrying it', 'torchbearer Elizabeth',
  ]
  for (const text of kept) expect(redact(text), text).toBe(text)
})

// What only looks like a secret stays as it is: a word with the name of a key in it and no quote after it, a header
// with no value, and the two forms of a Bearer header that SECRETS masked before (the closing quote of the first goes
// with the token).
test('redact leaves alone what only looks like a secret, and masks a Bearer header as before', () => {
  const kept = [
    'task-management', 'the token count is 5', '{"tokens": 5}', '{"secret_name": "x"}', '"tokenizer": "bpe"',
    'authorization is required',
  ]
  for (const text of kept) expect(redact(text), text).toBe(text)
  expect(redact('curl -H "Authorization: Bearer abcdefgh12345678"')).toBe('curl -H "Authorization: Bearer •••')
  expect(redact('use bearer abcdefgh12345 here')).toBe('use bearer ••• here')
})

// The gap between a header's scheme and its credential, and the one between the `Bearer` or `Basic` prefix of a bare
// value and the value, stays on the line (a space, a tab, a no-break space; never CR, LF, U+2028 or U+2029). Across a
// line end the first word of the next line was taken for the credential, and a key there, which its own pattern masks,
// was eaten before it could be: its value showed.
test('redact keeps a scheme and a Bearer prefix on their line: the key on the next line is masked on its own', () => {
  const cases: Array<[input: string, want: string]> = [
    ['Authorization: Foo\npassword: hunter2secret', 'Authorization: •••\npassword: •••'],
    ['Authorization: Foo\r\npassword: hunter2secret', 'Authorization: •••\r\npassword: •••'],
    ['Authorization: Foo\u{2028}password: hunter2secret', 'Authorization: •••\u{2028}password: •••'],
    ['Authorization: Foo\nX-Auth-Token: hunter2secret', 'Authorization: •••\nX-Auth-Token: •••'],
    [
      'self.authorization = authorization\nself.password = "hunter2secret"',
      'self.authorization = •••\nself.password = •••',
    ],
    ['- Authorization: none\n- Rate limit: 100/min', '- Authorization: •••\n- Rate limit: 100/min'],
    ['"token": basic\npassword: hunter2secret', '"token": •••\npassword: •••'],
  ]
  for (const [input, want] of cases) expect(redact(input), JSON.stringify(input)).toBe(want)
})

// An arrow with nothing behind it is no value: an `=` that begins an arrow is no separator, so the pattern does not
// read `=>` as `=` and the bare value `>`. A bare value never begins with `=` either, which leaves `==` and `===`
// alone.
test('redact leaves a dangling hash rocket and a comparison after a key as they are', () => {
  for (const text of [`"password" => {'a' => 1}`, '"password" =>', '"password" === x.type']) {
    expect(redact(text), text).toBe(text)
  }
})

// A value in backticks has its closing backtick, as a code span does. A code span that ends in `Authorization:` is no
// value: its closing backtick would open one, and the prose behind it would be masked to the end of the line. SECRETS
// takes the lone backtick for the value, and the words after it stay.
test('redact takes no code span that ends in `Authorization:` for a quoted value: the rest of the line stays', () => {
  expect(redact('Add the `Authorization:` header to every request and retry.')).toBe(
    'Add the `Authorization:••• header to every request and retry.',
  )
})

// A backtick that nothing closes on its line is no quoted value (QUOTED_VALUE takes a closed one), but the scheme after
// it is a scheme all the same. SECRETS would read the backtick and the scheme as one word, and the credential would
// show; AUTH_SCHEME takes it whatever the scheme is, Bearer and Basic too, and the credential stays on its line.
test('redact masks a scheme and a credential after a backtick that nothing closes, Bearer and Basic too', () => {
  const cases: Array<[input: string, want: string]> = [
    ['Authorization: `Token abcdefgh12345678', 'Authorization: •••'],
    ['Authorization: `Basic dXNlcjpwYXNz', 'Authorization: •••'],
    ['"Authorization": `Token abcdefgh12345678', '"Authorization": •••'],
    ['Authorization: `Token abcdefgh12345678\nnext line', 'Authorization: •••\nnext line'],
    // A backtick and a bare credential, with no scheme: SECRETS reads it.
    ['Authorization: `abcdefgh12345678', 'Authorization: •••'],
  ]
  for (const [input, want] of cases) expect(redact(input), JSON.stringify(input)).toBe(want)
})

// The same for a bare value after a quoted key: its Bearer or Basic prefix may open with a backtick that nothing closes
// (QUOTED_VALUE takes a closed one). Otherwise the bare value takes the backtick and the scheme for one word, and
// SECRETS, which reads a token by its scheme, loses its anchor and leaves the token in view. A bare value may begin
// with `!`, but never with a closing bracket or a semicolon.
test('redact masks a Bearer or Basic value after a quoted key when a backtick that nothing closes opens it', () => {
  const cases: Array<[input: string, want: string]> = [
    ['"token": `Bearer Zq8xK2mN9pL4vR7t', '"token": •••'],
    ["'secret': `Basic dXNlcjpwYXNz", "'secret': •••"],
    ['"password": !hunter2secret', '"password": •••'],
  ]
  for (const [input, want] of cases) expect(redact(input), JSON.stringify(input)).toBe(want)
  for (const text of ['{"password": }', '["password": ]', '("password": )', '"password": ;']) {
    expect(redact(text), text).toBe(text)
  }
})

// What the narrower gaps and the arrow rule keep: a credential or a value that holds punctuation is masked whole, a
// Bearer prefix is crossed by a tab and by a no-break space, and a key with no value and a word that only ends in
// `Bearer` stay as they are.
test('redact keeps masking a punctuated credential and a Bearer prefix that a tab or a no-break space follows', () => {
  const cases: Array<[input: string, want: string]> = [
    ['Authorization: Token a~b:c%d!e12345', 'Authorization: •••'],
    ['"password": p~a:s%s!word', '"password": •••'],
    ['"token": Bearer\tabcdefgh12345678', '"token": •••'],
    ['"token": Bearer\u{A0}abcdefgh12345678', '"token": •••'],
    ['"password": ,', '"password": ,'],
    ['fooBearerabcdefgh12345678', 'fooBearerabcdefgh12345678'],
  ]
  for (const [input, want] of cases) expect(redact(input), JSON.stringify(input)).toBe(want)
})

test('toolLabel', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['Read', { file_path: '/r/src/a.ts' }, 'Read src/a.ts'],
    ['Edit', { file_path: '/elsewhere/a.ts' }, 'Edit /elsewhere/a.ts'], // outside root: kept as is
    ['NotebookEdit', { notebook_path: '/r/n.ipynb' }, 'NotebookEdit n.ipynb'],
    ['mcp__issue-hub__find_issues', {}, 'issue-hub:find_issues'],
    ['Bash', { command: 'ls -la' }, 'Bash ls -la'],
    ['Grep', { pattern: 'foo.*bar' }, 'Grep foo.*bar'],
    ['Glob', { pattern: '**/*.ts' }, 'Glob **/*.ts'],
    ['WebFetch', { url: 'https://docs.x.io/a?b' }, 'WebFetch docs.x.io'],
    ['WebFetch', { url: 'not a url' }, 'WebFetch not a url'],
    ['WebSearch', { query: 'rust async' }, 'WebSearch rust async'],
    ['Agent', { subagent_type: 'engineer', description: 'Fix qty' }, 'Agent → engineer: Fix qty'],
    ['Task', {}, 'Agent → agent: '],
    ['TodoWrite', { todos: [] }, 'TodoWrite'],
  ]
  for (const [tool, input, want] of cases) expect(toolLabel(tool, input, '/r'), `toolLabel(${tool})`).toBe(want)
})

// The arguments are what the tool.call hook has once next(e) is back: the input of the call, and its result.
test('taskFromCall: a Bash command that went to the background is a running shell task, whoever sent it there', () => {
  const input = { command: 'sleep 120', description: 'Wait for two minutes', run_in_background: true }
  expect(taskFromCall('Bash', input, { stdout: '', stderr: '', backgroundTaskId: 'bzzvhtd8a' }, 1000)).toEqual({
    id: 'bzzvhtd8a', kind: 'shell', description: 'Wait for two minutes', status: 'running', startedAt: 1000,
    endedAt: null, durationMs: null,
  })
  // Ctrl+B sends a command that runs to the background: its result has the same id, beside a flag.
  const row = taskFromCall('Bash', { command: 'sleep 120' }, { backgroundTaskId: 'b2', backgroundedByUser: true }, 5)
  expect(row).toEqual({
    id: 'b2', kind: 'shell', description: 'sleep 120', status: 'running', startedAt: 5, endedAt: null, durationMs: null,
  })
})

// A command that hit its timeout ran in the foreground for that long before the engine sent it to the background (the
// result says so: `timedOutAfterMs`), so the task began that long before the call returned. Any other value is no time
// to count back: a negative one, one that is no finite number, and one that is no number at all.
test('taskFromCall: a Bash command that timed out in the foreground began that long before the call returned', () => {
  const input = { command: 'sleep 120' }
  expect(taskFromCall('Bash', input, { backgroundTaskId: 'b2', timedOutAfterMs: 120_000 }, 1_000_000)).toEqual({
    id: 'b2', kind: 'shell', description: 'sleep 120', status: 'running', startedAt: 880_000, endedAt: null,
    durationMs: null,
  })
  const startOf = (flag: object): number | null | undefined =>
    taskFromCall('Bash', input, { backgroundTaskId: 'b2', ...flag }, 1_000_000)?.startedAt
  expect(startOf({ timedOutAfterMs: 0 })).toBe(1_000_000)
  for (const timedOutAfterMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, '120000', null, undefined]) {
    expect(startOf({ timedOutAfterMs }), String(timedOutAfterMs)).toBe(1_000_000)
  }
  expect(startOf({ backgroundedByUser: true })).toBe(1_000_000) // Ctrl+B sends no time
  expect(startOf({})).toBe(1_000_000)
})

// A command whose input did not ask for the background began in the foreground and was moved while it ran (Ctrl+B, a
// message queued for the model, a plugin's turn abort, any other move), so it began about when its call did:
// `calledAt`, before the engine ran it. One that asked for it came back as soon as it started, whenever it was called,
// and a timeout counts back from the return.
test('taskFromCall: a Bash command that was moved to the background while it ran began when its call did', () => {
  const command = { command: 'sleep 120' }
  const startOf = (input: object, result: object): number | null | undefined =>
    taskFromCall('Bash', input, { backgroundTaskId: 'b2', ...result }, 1_000_000, 940_000)?.startedAt
  const moves = [
    { backgroundedToDeliverMessage: true }, { backgroundedByUser: true }, { backgroundedByTurnAbort: true }, {},
  ]
  for (const move of moves) expect(startOf(command, move), JSON.stringify(move)).toBe(940_000)
  // `false` asks for nothing, as an input without it does.
  expect(startOf({ ...command, run_in_background: false }, { backgroundedToDeliverMessage: true })).toBe(940_000)
  // The command that asked for the background started as the call came back: now, not the time of the call.
  expect(startOf({ ...command, run_in_background: true }, {})).toBe(1_000_000)
  // A timeout is counted back from the return, whichever way the input asked. A value that is no timeout is none.
  expect(startOf(command, { timedOutAfterMs: 120_000 })).toBe(880_000)
  expect(startOf({ ...command, run_in_background: true }, { timedOutAfterMs: 120_000 })).toBe(880_000)
  expect(startOf(command, { timedOutAfterMs: -1 })).toBe(940_000)
  // The time of the call is optional: it is the time of the return when none is given.
  expect(taskFromCall('Bash', command, { backgroundTaskId: 'b2' }, 1_000_000)?.startedAt).toBe(1_000_000)
})

test('taskFromCall: a Monitor and a Workflow start when their call returns, whenever it was called', () => {
  const startOf = (tool: string, input: object, result: object): number | null | undefined =>
    taskFromCall(tool, input, result, 1_000_000, 940_000)?.startedAt
  expect(startOf('Monitor', { description: 'd' }, { taskId: 'm1' })).toBe(1_000_000)
  expect(startOf('Workflow', { name: 'w' }, { taskId: 'w1' })).toBe(1_000_000)
})

test('taskFromCall: the description of a shell task is the one the model gave, else the command, else `shell`', () => {
  const descriptionOf = (input: object): string | undefined =>
    taskFromCall('Bash', input, { backgroundTaskId: 'b1' }, 0)?.description
  expect(descriptionOf({ command: 'npm test', description: 'Run the tests' })).toBe('Run the tests')
  expect(descriptionOf({ command: 'npm test' })).toBe('npm test')
  expect(descriptionOf({ command: 'npm test', description: '' })).toBe('npm test')
  // A text that nothing is left of once it is cleaned (spaces, a zero-width space, a line break) is no description.
  expect(descriptionOf({ command: 'npm test', description: ' \u200B\n ' })).toBe('npm test')
  expect(descriptionOf({ command: ' \u202E ', description: '\u200B' })).toBe('shell')
})

test('taskFromCall: a Monitor with a taskId is a monitor task, described by its description, else `monitor`', () => {
  const input = { description: 'Errors in the build log', command: 'tail -f build.log', timeout_ms: 300_000 }
  expect(taskFromCall('Monitor', input, { taskId: 'mq8x1', timeoutMs: 300_000 }, 7)).toEqual({
    id: 'mq8x1', kind: 'monitor', description: 'Errors in the build log', status: 'running', startedAt: 7,
    endedAt: null, durationMs: null,
  })
  // A description that nothing is left of once it is cleaned is none: the name of the kind stands in, not the command.
  const blank = { ...input, description: ' \u200B ' }
  expect(taskFromCall('Monitor', blank, { taskId: 'mq8x1' }, 7)?.description).toBe('monitor')
})

test('taskFromCall: a Workflow with a taskId is a workflow task, named by its result, then its input, then `workflow`',
  () => {
    const launched = { status: 'async_launched', taskType: 'local_workflow', taskId: 'wcq0w65wv' }
    const row = (input: object, result: object): TaskRow | null =>
      taskFromCall('Workflow', input, { ...launched, ...result }, 9)
    expect(row({ name: 'review' }, { workflowName: 'Deep review' })).toEqual({
      id: 'wcq0w65wv', kind: 'workflow', description: 'Deep review', status: 'running', startedAt: 9, endedAt: null,
      durationMs: null,
    })
    expect(row({ name: 'review' }, {})?.description).toBe('review')
    expect(row({ script: 'export const meta = {}' }, {})?.description).toBe('workflow')
    expect(row({ name: '' }, { workflowName: '' })?.description).toBe('workflow')
    // A name that nothing is left of once it is cleaned is none, and the next one stands in.
    expect(row({ name: 'review' }, { workflowName: '\u200B' })?.description).toBe('review')
    expect(row({ name: ' ' }, { workflowName: ' ' })?.description).toBe('workflow')
    // An `error` that is empty is none: the workflow started, and has its row.
    expect(row({ name: 'review' }, { error: '' })?.id).toBe('wcq0w65wv')
  })

test('taskFromCall: a call that started no background task, or none the pane tracks, is null', () => {
  const cases: Array<[tool: string, input: unknown, result: unknown]> = [
    ['Bash', { command: 'ls' }, { stdout: 'a', stderr: '', interrupted: false }], // it ran to its end
    ['Bash', { command: 'ls' }, { backgroundTaskId: '' }],
    ['Bash', { command: 'ls' }, { backgroundTaskId: 7 }],
    ['Monitor', { description: 'd' }, { timeoutMs: 1000 }],
    // A workflow whose syntax check failed did not start, though its result may name a task: no notice would end a row.
    ['Workflow', { name: 'w' }, { status: 'async_launched', error: 'a syntax error' }],
    ['Workflow', { name: 'w' }, { status: 'async_launched', taskId: 'w1', error: 'a syntax error' }],
    // A workflow sent to the cloud is a remote agent, which the pane leaves out: either word of its result says so.
    ['Workflow', { name: 'w' }, { status: 'remote_launched', taskId: 'r1' }],
    ['Workflow', { name: 'w' }, { status: 'async_launched', taskId: 'r1', taskType: 'remote_agent' }],
    // Another tool is none of these, whatever its result holds: a subagent has its own section.
    ['Agent', { description: 'd' }, { status: 'async_launched', agentId: 'a1', taskId: 't1' }],
    ['TaskStop', { task_id: 'b1' }, { task_id: 'b1', backgroundTaskId: 'b1' }],
    ['Read', { file_path: '/r/a.ts' }, { taskId: 'x' }],
    // No result (the call was denied), or one that is no record.
    ['Bash', { command: 'ls' }, undefined],
    ['Bash', { command: 'ls' }, null],
    ['Bash', { command: 'ls' }, 'text'],
  ]
  for (const [tool, input, result] of cases) {
    expect(taskFromCall(tool, input, result, 0), `${tool} ${JSON.stringify(result)}`).toBe(null)
  }
})

// Every source of a description, each given the text: the description and the command of a Bash call, the description
// of a Monitor, and the name of a Workflow, from its result and from its input.
const described = (text: string): string[] =>
  [
    taskFromCall('Bash', { command: 'x', description: text }, { backgroundTaskId: 'b1' }, 0),
    taskFromCall('Bash', { command: text }, { backgroundTaskId: 'b1' }, 0),
    taskFromCall('Monitor', { description: text }, { taskId: 'm1' }, 0),
    taskFromCall('Workflow', { name: 'x' }, { taskId: 'w1', workflowName: text }, 0),
    taskFromCall('Workflow', { name: text }, { taskId: 'w1' }, 0),
  ].map(row => row?.description ?? 'no row')

// The description is the model's own text, as a Log line is: a command can hold a secret, and the pane draws it.
test('taskFromCall masks a secret in a description, whichever source it comes from', () => {
  for (const description of described('export API_KEY=xyz123 && sleep 120')) {
    expect(description).toBe('export API_KEY=••• && sleep 120')
  }
  for (const description of described('psql postgres://user:hunter2@db:5432/x -f dump.sql')) {
    expect(description).toBe('psql postgres://user:•••@db:5432/x -f dump.sql')
  }
  for (const description of described('curl -H "Authorization: Bearer abcdefgh12345" https://x.io')) {
    expect(description).not.toContain('abcdefgh12345')
  }
})

// The engine refuses a text child that holds a control character, and draws its own pane in place of the mod's.
test('taskFromCall takes an ANSI escape sequence and the control and format characters out of a description', () => {
  const dirty = '\u001b[31mnpm\u001b[0m run\u0000 build\u0007 \u202E--watch\n  now\tdone'
  for (const description of described(dirty)) expect(description).toBe('npm run build --watch now done')
})

test('taskFromCall keeps LOG_TEXT_MAX characters of a description, the last one an ellipsis', () => {
  expect(LOG_TEXT_MAX).toBe(512)
  for (const description of described('x'.repeat(600))) expect(description).toBe(`${'x'.repeat(511)}…`)
  for (const description of described('x'.repeat(512))) expect(description).toBe('x'.repeat(512))
})

// The command of a Bash call can be steered by a prompt injection, and the hook of tool.call runs for every call: the
// URL pattern of redact takes quadratic time on a text such as `a.a.a.…` (128 KB of it took 5.5 s in Node 22), so only
// the head of the text is read by it.
test('taskFromCall reads the head of a 128 KB description: milliseconds, not seconds', () => {
  const started = performance.now()
  const row = taskFromCall('Bash', { command: 'a.'.repeat(65_536) }, { backgroundTaskId: 'b1' }, 0)
  expect(row?.description).toBe(`${'a.'.repeat(255)}a…`)
  expect(performance.now() - started).toBeLessThan(300)
})

// A notification as the engine sends it (the v2 spec, §8.5): the header, the summary, and what follows. A shell command
// has nothing after the summary; a subagent and a workflow add their result and a usage block with the time they ran.
const notification = (id: string, status: string, summary: string, tail = ''): string =>
  `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_01TkA4cq2o2Hn55hdQA4jJWG</tool-use-id>\n` +
  `<output-file>/tmp/claude-1000/p/tasks/${id}.output</output-file>\n<status>${status}</status>\n` +
  `<summary>${summary}</summary>\n${tail}</task-notification>`
const usageBlock = (ms: number): string =>
  `<usage><subagent_tokens>19770</subagent_tokens><tool_uses>3</tool_uses><duration_ms>${ms}</duration_ms></usage>\n`

test('parseTaskNotification reads the id and the outcome: completed, failed, killed and stopped', () => {
  const cases: Array<[text: string, want: TaskEnd]> = [
    [
      notification('bzzvhtd8a', 'completed', 'Background command "sleep 60" completed (exit code 0)'),
      { id: 'bzzvhtd8a', status: 'completed', durationMs: null },
    ],
    [
      notification('bqjf7o4gg', 'failed', 'Background command "make" failed with exit code 2'),
      { id: 'bqjf7o4gg', status: 'failed', durationMs: null },
    ],
    [
      notification('a85029748ff1ea697', 'killed', 'Agent "Long sleep" was stopped by Claude'),
      { id: 'a85029748ff1ea697', status: 'killed', durationMs: null },
    ],
    [
      notification('bc3d9f2kx', 'stopped', "Background shell command didn't finish before the previous session ended"),
      { id: 'bc3d9f2kx', status: 'stopped', durationMs: null },
    ],
  ]
  for (const [text, want] of cases) expect(parseTaskNotification(text), want.status).toEqual(want)
})

test('parseTaskNotification takes the duration from <duration_ms> when the notification has one', () => {
  const result = '<result>{"answer":"OK"}</result>\n<diagnostics>Per-agent results: journal.jsonl</diagnostics>\n'
  const workflow = notification('wcq0w65wv', 'completed', 'Dynamic workflow "w" completed', result + usageBlock(7897))
  expect(parseTaskNotification(workflow)).toEqual({ id: 'wcq0w65wv', status: 'completed', durationMs: 7897 })
  const agent = notification('a1', 'killed', 'Agent "x" was stopped by the user', usageBlock(0))
  expect(parseTaskNotification(agent)).toEqual({ id: 'a1', status: 'killed', durationMs: 0 })
  // A duration that is no whole number, or lies past the safe integers (400 digits are Infinity), is none.
  for (const ms of ['', 'soon', '12 s', '9'.repeat(400), '9007199254740992']) {
    const tail = `<usage><duration_ms>${ms}</duration_ms></usage>\n`
    const text = notification('a1', 'completed', 'Agent "x" finished', tail)
    expect(parseTaskNotification(text), JSON.stringify(ms)).toEqual({ id: 'a1', status: 'completed', durationMs: null })
  }
})

// A result is free text, and it can quote a notification. The header comes first and the usage block last, so the
// first id and status and the last duration are the engine's own.
test('parseTaskNotification: a result that quotes the tags does not change the id, the status or the duration', () => {
  const quoted = '<result>It said <task-id>other</task-id>, <status>failed</status>, <duration_ms>5</duration_ms>.' +
    '</result>\n'
  const text = notification('a1', 'completed', 'Agent "x" finished', quoted + usageBlock(900))
  expect(parseTaskNotification(text)).toEqual({ id: 'a1', status: 'completed', durationMs: 900 })
})

// A notice of Monitor has not been seen, and what a monitor watches or a result says can hold any tag. The status is
// the header's: what stands before the first summary or result, whichever comes first, or the whole text when there is
// neither.
test('parseTaskNotification reads the status from the header alone: one in the summary or a result is none', () => {
  const header = '<task-notification>\n<task-id>mq8x1</task-id>\n'
  const quoted = '<result>build done <status>completed</status></result>\n'
  expect(parseTaskNotification(`${header}<summary>Monitor event</summary>\n${quoted}</task-notification>`)).toBe(null)
  const inSummary = '<summary>line <status>completed</status></summary>\n'
  expect(parseTaskNotification(`${header}${inSummary}</task-notification>`)).toBe(null)
  // A result with no summary before it ends the header too, and so does one that comes before the summary.
  expect(parseTaskNotification(`${header}${quoted}</task-notification>`)).toBe(null)
  expect(parseTaskNotification(`${header}${quoted}<summary>s</summary>\n</task-notification>`)).toBe(null)
  // With neither a summary nor a result the whole text is the header.
  expect(parseTaskNotification(`${header}<status>failed</status>\n</task-notification>`)).toEqual({
    id: 'mq8x1', status: 'failed', durationMs: null,
  })
})

test('parseTaskNotification: a text with no <task-id> is no notification, nor is one whose status is no end', () => {
  const header = (id: string, status: string): string =>
    `<task-notification>\n${id}${status}<summary>s</summary>\n</task-notification>`
  const texts = [
    '', 'hello', '{"task-id":"a1","status":"completed"}', '<system-reminder>Run the tests.</system-reminder>',
    '<command-name>/compact</command-name>',
    // A notification with no id, an empty one and one that never closes.
    header('', '<status>completed</status>\n'),
    header('<task-id></task-id>\n', '<status>completed</status>\n'),
    header('<task-id>a1\n', '<status>completed</status>\n'),
    // A status that is no end of a task: an unknown one, a real one in the wrong case, none, and one that never closes.
    notification('a1', 'paused', 's'),
    notification('a1', 'running', 's'),
    notification('a1', 'Completed', 's'),
    notification('a1', '', 's'),
    header('<task-id>a1</task-id>\n', ''),
    header('<task-id>a1</task-id>\n', '<status>completed\n'),
  ]
  for (const text of texts) expect(parseTaskNotification(text), JSON.stringify(text)).toBe(null)
})

// A notification carries the result of a subagent or a workflow, which can be long, so the tags are found with indexOf:
// a lazy pattern over the whole text (`<task-id>[\s\S]*?</task-id>`) reads the rest of it from each opening tag again.
test('parseTaskNotification reads 128 KB once: a long result, and tags that open and never close', () => {
  const want: TaskEnd = { id: 'wcq0w65wv', status: 'completed', durationMs: 7897 }
  const opens = (tag: string): string => `<${tag}>`.repeat(Math.ceil(131_072 / (tag.length + 2)))
  const withResult = (result: string): string => notification(
    'wcq0w65wv', 'completed', 'Dynamic workflow "w" completed', `<result>${result}</result>\n${usageBlock(7897)}`,
  )
  const started = performance.now()
  expect(parseTaskNotification(withResult('x'.repeat(131_072)))).toEqual(want)
  for (const tag of ['task-id', 'status', 'duration_ms']) {
    expect(parseTaskNotification(withResult(opens(tag))), tag).toEqual(want) // a result of 128 KB of opening tags
    expect(parseTaskNotification(opens(tag)), tag).toBe(null) // and a text of nothing else
  }
  expect(performance.now() - started).toBeLessThan(300)
})

// The engine opens a turn of its own with a tag in angle brackets: a name of lowercase words joined by hyphens
// (`task-notification`, `system-reminder`, `command-name`), closed by `>`, after attributes if it has any
// (`<teammate-message teammate_id="lead">`). What a person pastes (`<token…`, `<div class=…>`, `<p>`) is the person's
// prompt: an HTML tag has no hyphen.
test('engineTag names the tag that opens a turn of the engine: hyphenated lowercase words, attributes allowed', () => {
  const named: Array<[text: string, name: string]> = [
    ['<task-notification>\n<task-id>a1</task-id>', 'task-notification'],
    ['<system-reminder>\nx', 'system-reminder'],
    ['<command-name>/clear</command-name>', 'command-name'],
    ['<local-command-stdout>', 'local-command-stdout'],
    ['<user-prompt-submit-hook>', 'user-prompt-submit-hook'],
    ['<bash-input>', 'bash-input'],
    ['<\u{202E}task-notification>', 'task-notification'], // a format character goes before the name is read
    ['\x1b[0m<system-reminder>', 'system-reminder'], // and so does an escape sequence
    ['<my_tag>', 'my_tag'], // an underscore joins words too
    ['<h1-x>', 'h1-x'], // a digit may follow the first letter
    ['<a-b-c-d-e-f-g-h-i>', 'a-b-c-d-e-f-g-h-i'], // nine words, the most
    ['<teammate-message teammate_id="lead">\nhi', 'teammate-message'], // attributes follow a space
    ['<task-notification id="1"\n  kind="x">', 'task-notification'],
    ['<x-y z>', 'x-y'],
    ['<x-y\nz>', 'x-y'],
    // A lowercase token in brackets is a tag by this rule; the caller masks the name.
    ['<ghp_abcdefghijklmnopqrstuvwxyz0123456789>', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  ]
  for (const [text, name] of named) expect(engineTag(text), JSON.stringify(text)).toBe(name)
  // Only the first 256 characters count: a name that closes inside them is a tag, one that closes after them is none.
  expect(engineTag(`<${'a'.repeat(252)}-b>`)).toBe(`${'a'.repeat(252)}-b`) // 256 characters with the brackets
  expect(engineTag(`<${'a'.repeat(253)}-b>`)).toBeUndefined() // 257: the `>` is past them
})

test('engineTag is undefined for a text that is the person\'s: markup, a pasted token, no tag at the start', () => {
  const given = [
    '<div class="x">', '<html>', '<p>x</p>', '<script>', '<Task-notification>', '< x>', '</x>', '<x-y', ' <x-y>',
    'no tag in this text', '<ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8 please', '',
    // A name starts with a lowercase letter, goes on with lowercase letters and digits, and has one to eight more
    // words, each after a hyphen or an underscore and none of them empty.
    '<1-x>', '<-x>', '<x->', '<x--y>', '<task-Notification>', '<taSk-x>', '<a-b-c-d-e-f-g-h-i-j>',
    // Attributes follow a space, and `>` closes the tag after them: a tag with no `>`, one whose attributes hold `<`,
    // and a name that something other than a space follows are no tag.
    '<my-tag x="1"', '<my-tag x="1" <b>', '<x-y=z>', '<teammate-message teammate_id="lead"',
  ]
  for (const text of given) expect(engineTag(text), JSON.stringify(text)).toBeUndefined()
})

test('finishTask ends the row: the status, the end time, and a duration from the notification or the clock', () => {
  const running = task('running', 1000)
  expect(finishTask(running, 'done', 4500, 3000)).toEqual({
    ...running, status: 'done', endedAt: 4500, durationMs: 3000,
  })
  expect(finishTask(running, 'failed', 4500, null)).toEqual({
    ...running, status: 'failed', endedAt: 4500, durationMs: 3500,
  })
  expect(finishTask(running, 'stopped', 4500, null).durationMs).toBe(3500)
  expect(finishTask(running, 'done', 400, null).durationMs).toBe(0) // the clock was put back: no negative time
  expect(running).toEqual(task('running', 1000)) // the row is not changed
  // A duration of 0 is a duration, not a missing one.
  expect(finishTask(running, 'done', 4500, 0).durationMs).toBe(0)
})

test('finishTask: a task whose start is not known has no duration of its own, only the notification\'s', () => {
  const unknown = task('running', null)
  expect(finishTask(unknown, 'ended', 4500, null)).toEqual({
    ...unknown, status: 'ended', endedAt: 4500, durationMs: null,
  })
  expect(finishTask(unknown, 'done', 4500, 2000).durationMs).toBe(2000)
})

test('orderTasks puts the running tasks first, then the newest start first, and a start not known last', () => {
  const rows = [
    task('done', 100), task('running', 50), task('done', 300), task('running', null), task('failed', null),
    task('running', 70), task('stopped', 200), task('done', null),
  ]
  expect(orderTasks(rows).map(r => r.id)).toEqual([
    'running@70', 'running@50', 'running@null', 'done@300', 'stopped@200', 'done@100', 'failed@null', 'done@null',
  ])
  expect(rows.map(r => r.id)).toEqual([
    'done@100', 'running@50', 'done@300', 'running@null', 'failed@null', 'running@70', 'stopped@200', 'done@null',
  ]) // the source is not reordered
  // Tasks that started at the same time keep their order.
  expect(orderTasks([task('running', 10, 'a'), task('running', 10, 'b'), task('running', 10, 'c')]).map(r => r.id))
    .toEqual(['a', 'b', 'c'])
  expect(orderTasks([])).toEqual([])
})

test('parseStatus counts the entries and lists the new files', () => {
  const cases: Array<[stdout: string, files: number, newFiles: string[]]> = [
    [' M a.ts\0M  b.ts\0?? c.ts\0?? dir/d.ts\0UU e.ts\0', 5, ['c.ts', 'dir/d.ts']],
    ['', 0, []],
    // A path keeps its spaces.
    ['?? a b.ts\0', 1, ['a b.ts']],
    // A field that is empty is no entry.
    [' M a.ts\0\0 M b.ts\0', 2, []],
    // A nested repository is one file, and has no lines of its own: git lists it as a folder.
    ['?? nested/\0', 1, []],
    ['?? nested/\0?? n.ts\0', 2, ['n.ts']],
  ]
  for (const [stdout, files, newFiles] of cases) {
    expect(parseStatus(stdout), JSON.stringify(stdout)).toEqual({ files, newFiles })
  }
})

test('parseStatus skips the original path of a rename or a copy, in either column', () => {
  const cases: Array<[stdout: string, files: number, newFiles: string[]]> = [
    ['R  new.ts\0old.ts\0 M x.ts\0', 2, []],
    ['C  new.ts\0old.ts\0 M x.ts\0', 2, []],
    [' R new.ts\0old.ts\0 M x.ts\0', 2, []],
    [' C new.ts\0old.ts\0 M x.ts\0', 2, []],
    ['RM new.ts\0old.ts\0 M x.ts\0', 2, []],
    // The field after a rename is a path, whatever it looks like: it is not read as an entry.
    ['R  new.ts\0?? old.ts\0 M x.ts\0', 2, []],
    // The entries after it count as before.
    ['R  new.ts\0old.ts\0?? n.ts\0', 2, ['n.ts']],
  ]
  for (const [stdout, files, newFiles] of cases) {
    expect(parseStatus(stdout), JSON.stringify(stdout)).toEqual({ files, newFiles })
  }
})

test('sumNumstat adds the first two fields of each line', () => {
  expect(sumNumstat('3\t1\ta.ts\n-\t-\tlogo.png\n10\t0\tdir/{a => b}.ts\n')).toEqual({ added: 13, removed: 1 })
  expect(sumNumstat('')).toEqual({ added: 0, removed: 0 })
  expect(sumNumstat('5\t0\t/dev/null => n.ts\n')).toEqual({ added: 5, removed: 0 })
})

test('sumNumstat: a binary file, a line with no tabs and a count that is no whole number add 0', () => {
  expect(sumNumstat('-\t-\tlogo.png\n')).toEqual({ added: 0, removed: 0 })
  expect(sumNumstat('no tabs here\n3\t1\ta.ts\n')).toEqual({ added: 3, removed: 1 })
  // A bare number is no line of the form either.
  expect(sumNumstat('7\n')).toEqual({ added: 0, removed: 0 })
  expect(sumNumstat('x\t2\ta\n1.5\t-3\tb\n 4\t5\tc\n')).toEqual({ added: 0, removed: 7 })
})

test('fmtUsd', () => {
  const cases: Array<[number, string]> = [
    [5.4867, '$5.49'], [0.152, '$0.152'], [0.0049, '$0.005'], [0.0004, '<$0.001'], [0, '$0'],
    // The branch follows the rounding to three decimals: 0.9996 comes to $1.000, so it takes two.
    [0.9996, '$1.00'], [0.9994, '$0.999'],
  ]
  for (const [x, want] of cases) expect(fmtUsd(x), `fmtUsd(${x})`).toBe(want)
})

test('fmtPct', () => {
  expect(fmtPct(12.84, 1)).toBe('12.8%')
  expect(fmtPct(23.6, 0)).toBe('24%')
})

test('fmtTokens', () => {
  const cases: Array<[number, string]> = [
    [0, '0'], [999, '999'], [1000, '1k'], [2345, '2.3k'], [9960, '10k'],
    [128400, '128k'], [999400, '999k'], [999600, '1M'], [1240000, '1.2M'], [12000000, '12M'],
  ]
  for (const [n, want] of cases) expect(fmtTokens(n), `fmtTokens(${n})`).toBe(want)
})

test('fmtDuration', () => {
  const cases: Array<[number, string]> = [
    [900, '0.9s'], [33500, '33.5s'], [59960, '1m 00s'], [65000, '1m 05s'], [3720000, '1h 02m'],
  ]
  for (const [ms, want] of cases) expect(fmtDuration(ms), `fmtDuration(${ms})`).toBe(want)
})

test('fmtTtft', () => {
  expect(fmtTtft(40)).toBe('<0.1s')
  expect(fmtTtft(800)).toBe('0.8s')
})

test('fmtRate', () => {
  expect(fmtRate(103.6)).toBe('~104 tok/s')
})

test('fmtCountdown', () => {
  const cases: Array<[number, string]> = [
    [0, '↻ now'],
    [30000, '↻ 1m'],
    [45 * 60000, '↻ 45m'],
    [59.5 * 60000, '↻ 1h 0m'],
    [(2 * 60 + 13) * 60000, '↻ 2h 13m'],
    [(5 * 1440 + 15 * 60) * 60000, '↻ 5d 15h'],
  ]
  for (const [ms, want] of cases) expect(fmtCountdown(ms), `fmtCountdown(${ms})`).toBe(want)
})

test('fmtClock', () => {
  expect(fmtClock(Date.now())).toMatch(/^\d\d:\d\d:\d\d$/)
  expect(fmtClock(new Date(2026, 0, 15, 3, 4, 5).getTime())).toBe('03:04:05') // local time, zero-padded
})
