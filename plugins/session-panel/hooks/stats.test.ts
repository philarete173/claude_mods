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
  pushLog,
  redact,
  shortType,
  shorten,
  splitCost,
  sumUsage,
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
  expect(s.tokensIn).toBe(12)
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
  expect(s.tokensIn).toBe(100)
  expect(s.tokensOut).toBe(777)
  expect(s.cachePct).toBe(75)
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
  expect(shortType('feature-dev:a-very-long-agent-type')).toBe('a-very-long-ag')
})

test('shorten', () => {
  expect(shorten('  a \n  b  ', 10)).toBe('a b')
  expect(shorten('abcdefghijk', 5)).toBe('abcd…')
  expect(shorten('abcde', 5)).toBe('abcde')
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

test('fmtUsd', () => {
  const cases: Array<[number, string]> = [
    [5.4867, '$5.49'], [0.152, '$0.152'], [0.0049, '$0.005'], [0.0004, '<$0.001'], [0, '$0'],
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
