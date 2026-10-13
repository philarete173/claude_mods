import { test, expect } from 'claude-code/testing'
import {
  addAgentCost,
  attributeCost,
  cacheHitPct,
  computeTurnStats,
  fmtClock,
  fmtCountdown,
  fmtDuration,
  fmtPct,
  fmtRate,
  fmtTokens,
  fmtTtft,
  fmtUsd,
  mergedLength,
  orderAgents,
  parseStatus,
  plainText,
  pushLog,
  redact,
  shortType,
  shorten,
  splitCost,
  stripFormat,
  sumNumstat,
  sumUsage,
  textHead,
  toolLabel,
} from './stats'
import type { AgentRow, AgentStatus, Interval, LogEntry, StepTiming, TurnAcc, Usage } from './stats'

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
  const entry = (at: number): LogEntry => ({ at, who: 'main', text: `e${at}`, kind: 'info' })
  const log = Array.from({ length: 60 }, (_, i) => entry(60 - i)) // newest first: 60 ... 1
  const next = pushLog(log, entry(61))
  expect(next).toHaveLength(60)
  expect(next[0]?.at).toBe(61)
  expect(next[1]?.at).toBe(60)
  expect(next[59]?.at).toBe(2) // the oldest one fell out
  expect(log).toHaveLength(60) // the source is not mutated
  expect(pushLog(log, entry(61), 3).map(e => e.at)).toEqual([61, 60, 59])
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

test('stripFormat keeps a joiner between two non-ASCII characters: an emoji sequence, a Persian word', () => {
  expect(stripFormat(FAMILY)).toBe(FAMILY)
  expect(stripFormat(`${FAMILY} sleep 30`)).toBe(`${FAMILY} sleep 30`)
  expect(stripFormat(`run ${FAMILY}`)).toBe(`run ${FAMILY}`)
  expect(stripFormat(RAINBOW_FLAG)).toBe(RAINBOW_FLAG) // the variation selector before the joiner is no ASCII character
  expect(stripFormat(PERSIAN)).toBe(PERSIAN)
  // Either joiner stays between two characters of any kind above U+007F: accents, letters, Indic letters, emoji, and
  // U+0080, the first code point above it.
  const pairs = [['é', 'é'], ['ж', 'я'], ['\u0915', '\u0937'], [ROCKET, ROCKET], ['\u0080', '\u0080']] as const
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
    // A space, a tab and a line break are ASCII too, and so is U+007F, the last code point of ASCII.
    expect(stripFormat(`é${joiner}\u007F`), name).toBe('é\u007F')
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
  const started = performance.now()
  expect(stripFormat(run)).toBe('ab')
  expect(stripFormat(partials.join('').repeat(2_000))).toBe(BLACK_FLAG.repeat(partials.length * 2_000))
  expect(performance.now() - started).toBeLessThan(500)
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
  // A text of `max` units or fewer is not cut, whatever it ends in: here a high surrogate that nothing follows.
  const lone = ROCKET.slice(0, 1)
  expect(textHead(`a${lone}`, 2)).toBe(`a${lone}`)
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
