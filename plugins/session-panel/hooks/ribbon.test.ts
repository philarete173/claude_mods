import { test, expect } from 'claude-code/testing'
import {
  drawRibbon, legendItems, ribbonCeilingMs, ribbonDetail, ribbonFromAcc, ribbonSegments, ribbonTerminal, withLive,
} from './ribbon'
import type { RibbonInput, RibbonPart } from './ribbon'
import { STATION_HUES, zeroStationMs } from './stations'
import type { InFlightCall, ToolStationId } from './stations'
import { computeTurnStats } from './stats'
import type { StepTiming, ToolSegment, TurnAcc, TurnStats } from './stats'
import { BAD, loopBegin, SVG_SOURCE_MAX } from './svg'

const T0 = 1_000_000_000
const s = (seconds: number): number => T0 + Math.round(seconds * 1000)
const FULL = { motion: 'full' as const }
const REDUCED = { motion: 'reduced' as const }
const tool = (t0: number, t1: number, station: ToolStationId, label: string, failed = false): ToolSegment => ({
  t0: s(t0), t1: s(t1), station, label, failed,
})
const joined = (spans: { text: string }[]): string => spans.map((span) => span.text).join('')
const cellsOf = (spans: { text: string }[]): number => [...joined(spans)].length
const barCells = (spans: { text: string }[]): number => [...joined(spans)].filter((c) => '█✗·'.includes(c)).length
const end = (p: RibbonPart): number => p.x + p.w
const detailedSteps = (parts: RibbonPart[]): number => parts.filter((p) => p.kind === 'model').length

// §2.3's turn, in seconds from T0.
const EXAMPLE: RibbonInput = {
  startedAt: T0, endMs: s(134), isLive: true,
  steps: [[0, 9], [9.4, 20.4], [51.4, 65.4], [87.7, 95.7], [95.9, 113.9]].map(([a = 0, b = 0]) => ({
    tStart: s(a), tEnd: s(b),
  })),
  tools: [
    tool(9.0, 9.1, 'files', 'Read stats.ts'),
    tool(9.0, 9.4, 'files', 'Read view.tsx'),
    tool(20.4, 51.4, 'shell', 'Bash tsc --noEmit', true),
    tool(65.4, 87.7, 'agents', 'Agent → explorer: Map the mask'),
    tool(95.7, 95.9, 'you', 'TodoWrite'),
    tool(113.9, 116.0, 'mcp', 'codebase-memory:search_graph'),
  ],
  earlier: zeroStationMs(),
  live: { station: 'model', fromMs: s(116) },
}
// The same turn, finished when its MCP call returned.
const FINISHED: RibbonInput = { ...EXAMPLE, endMs: s(116), isLive: false, live: null }
const STATS: TurnStats = {
  elapsedMs: 134_000, modelMs: 78_000, toolMs: 56_000, steps: 6, ttftMs: 1200, wholeTurnRate: null,
  responseRate: null, tokensIn: 0, tokensOut: 0, cachePct: null, costUsd: null, ribbon: null,
}
const STATIONS: ToolStationId[] = ['files', 'shell', 'web']

// Steps of [model s, tool s] back to back (a 0 s tool is none), the tools' stations cycling; finished at the last end.
function finishedTurn(spans: [number, number][]): RibbonInput {
  const steps: RibbonInput['steps'] = []
  const tools: ToolSegment[] = []
  let at = 0
  spans.forEach(([stepS, toolS], k) => {
    steps.push({ tStart: s(at), tEnd: s(at + stepS) })
    if (toolS > 0) tools.push(tool(at + stepS, at + stepS + toolS, STATIONS[k % 3] ?? 'files', 'Read x'))
    at += stepS + toolS
  })
  return { startedAt: T0, endMs: s(at), isLive: false, steps, tools, earlier: zeroStationMs(), live: null }
}
const repeat = (n: number, span: [number, number]): [number, number][] => Array.from({ length: n }, () => span)
const minOf = (p: RibbonPart): number => (p.kind !== 'earlier' && p.station !== 'model' ? 2 : 1)
// No part starts before the one before it ends, and none is below its minimum width.
function expectSound(parts: RibbonPart[]): void {
  parts.slice(1).forEach((p, i) => expect(p.x).toBeGreaterThanOrEqual(end(parts[i] as RibbonPart)))
  for (const p of parts) expect(p.w).toBeGreaterThanOrEqual(minOf(p))
}

// `count` steps, each followed by `calls` Bash calls whose labels are 507 quotes.
function heavyTurn(count: number, calls: number): RibbonInput {
  const steps: RibbonInput['steps'] = []
  const tools: ToolSegment[] = []
  for (let k = 0; k < count; k += 1) {
    steps.push({ tStart: s(k * 2), tEnd: s(k * 2 + 1) })
    for (let c = 0; c < calls; c += 1) tools.push(tool(k * 2 + 1, k * 2 + 1.5, 'shell', `Bash ${'"'.repeat(507)}`))
  }
  return { ...EXAMPLE, endMs: s(count * 2 + 1), steps, tools, live: { station: 'model', fromMs: s(count * 2) } }
}

const step = (tStart: number, tEnd: number): StepTiming => ({
  tStart: s(tStart), tFirst: null, tEnd: s(tEnd), usage: {}, hasTool: true, hasText: false,
})
const acc = (steps: StepTiming[], tools: ToolSegment[] = []): TurnAcc => ({
  turnId: 't', startedAt: T0, costAtStart: null, steps, toolIntervals: [], tools, earlier: zeroStationMs(),
})
const call = (station: ToolStationId, at: number, agentId: string | null = null): InFlightCall => ({
  station, agentId, at: s(at), label: 'x',
})

test('the worked geometry at 264 px', () => {
  const parts = ribbonSegments(EXAMPLE, 264)
  expect(parts.map((p) => [p.kind, p.station, p.x, p.w, p.failed])).toEqual([
    ['model', 'model', 0, 13, false],
    ['tool', 'files', 14, 2, false],
    ['model', 'model', 17, 13, false],
    ['tool', 'shell', 31, 44, true],
    ['model', 'model', 76, 20, false],
    ['tool', 'agents', 97, 32, false],
    ['model', 'model', 130, 10, false],
    ['tool', 'you', 141, 2, false],
    ['model', 'model', 144, 23, false],
    ['tool', 'mcp', 168, 2, false],
    ['live', 'model', 171, 26, false],
  ])
})

test('N follows the bar', () => {
  expect([204, 264, 354, 804, 3304].map(ribbonDetail)).toEqual([10, 13, 17, 40, 60])
  expect(ribbonDetail(0)).toBe(6)
  expect(ribbonDetail(-5)).toBe(6)
})

test('the ceilings', () => {
  expect([0, 15_000, 15_001, 134_000, 3 * 3_600_000 + 1, 10 * 3_600_000].map((ms) => ribbonCeilingMs(ms, true)))
    .toEqual([15_000, 15_000, 30_000, 180_000, 4 * 3_600_000, 10 * 3_600_000])
  expect(ribbonCeilingMs(Infinity, true)).toBe(15_000)
  expect(ribbonCeilingMs(NaN, true)).toBe(15_000)
  expect(ribbonCeilingMs(134_000, false)).toBe(134_000)
  expect(ribbonCeilingMs(0, false)).toBe(1)
})

test('after a merge the parts still sum to the time', () => {
  // 57 short steps merge; the latest 13 are long enough for every minimum width.
  const input = finishedTurn([...repeat(57, [1, 0.5]), ...repeat(13, [10, 5])])
  for (const barPx of [264, 204]) {
    const parts = ribbonSegments(input, barPx)
    const earlier = parts.filter((p) => p.kind === 'earlier')
    expect(parts[0]?.kind).toBe('earlier')
    expect(parts.slice(0, earlier.length)).toEqual(earlier)
    expect(earlier.map((p) => p.station)).toEqual(['model', 'files', 'shell', 'web'])
    earlier.slice(1).forEach((p, i) => expect(p.x).toBe(end(earlier[i] as RibbonPart)))
    expect(detailedSteps(parts)).toBe(ribbonDetail(barPx))
    expect(parts.reduce((ms, p) => ms + p.ms, 0)).toBe(280_500)
    expect(end(parts[parts.length - 1] as RibbonPart)).toBe(barPx)
  }
})

test('a short last step does not collapse the ribbon', () => {
  const parts = ribbonSegments(finishedTurn([...repeat(13, [10, 5]), [0.3, 0]]), 264)
  expect(detailedSteps(parts)).toBe(13)
  expect(end(parts[parts.length - 1] as RibbonPart)).toBe(264)
  parts.slice(1).forEach((p, i) => expect(p.x).toBeGreaterThanOrEqual(end(parts[i] as RibbonPart)))
  for (const p of parts) expect(p.w).toBeGreaterThanOrEqual(minOf(p))
})

test('when the minimum widths crowd, the pushes carry into later slack', () => {
  const steps: RibbonInput['steps'] = []
  const tools: ToolSegment[] = []
  for (let k = 0; k < 13; k += 1) {
    steps.push({ tStart: s(k * 1.001), tEnd: s(k * 1.001 + 1) })
    tools.push(tool(k * 1.001 + 1, k * 1.001 + 1.001, 'files', 'Read x'))
  }
  steps.push({ tStart: s(13.013), tEnd: s(1013.013) })
  const input: RibbonInput = { ...FINISHED, endMs: s(1013.013), steps, tools }
  // §10's N holds: the long step absorbs the pushes.
  const parts = ribbonSegments(input, 264)
  expect(detailedSteps(parts)).toBe(13)
  expectSound(parts)
  expect(end(parts[parts.length - 1] as RibbonPart)).toBe(264)
  // The terminal merges likewise: a span per part, every part at least a cell. At 44 columns all 27 parts fit in 36
  // cells; at 16 the 8 cells take the earlier pair and the latest 3 steps.
  const barSpans = (cols: number): { text: string }[] =>
    ribbonTerminal(input, cols).filter((span) => /^[█✗·]+$/u.test(span.text))
  expect(barSpans(44).length).toBe(27)
  expect(barCells(barSpans(44))).toBe(36)
  expect(barSpans(16).length).toBe(7)
  expect(barCells(barSpans(16))).toBe(8)
  for (const span of [...barSpans(44), ...barSpans(16)]) expect(barCells([span])).toBeGreaterThanOrEqual(1)
})

test('crowding late in the turn carries forward and merges nothing', () => {
  // §2.3's turn with three quick steps before the live part.
  const quick: RibbonInput = {
    ...EXAMPLE,
    steps: [...EXAMPLE.steps, ...[116, 117.5, 119].map((a) => ({ tStart: s(a), tEnd: s(a + 1) }))],
    tools: [...EXAMPLE.tools, ...[117, 118.5, 120].map((a) => tool(a, a + 0.5, 'files', 'Read x'))],
    live: { station: 'model', fromMs: s(120.5) },
  }
  const parts = ribbonSegments(quick, 264)
  expect(detailedSteps(parts)).toBe(8)
  expect(parts[parts.length - 1]?.kind).toBe('live')
  expectSound(parts)
  // One long step, then 5 rapid ones: the tail is pulled back, nothing merges.
  const rapid = ribbonSegments(finishedTurn([[60, 30], ...repeat(5, [0.5, 0.2])]), 264)
  expect(detailedSteps(rapid)).toBe(6)
  expect(end(rapid[rapid.length - 1] as RibbonPart)).toBe(264)
  expectSound(rapid)
})

test('a crowded live end takes its room from the block', () => {
  // 13 rapid steps in the last px before a live part that starts ≈ 1 px before the ceiling (30 s): the long first
  // step's block gives way and all 13 stay detailed.
  const steps = [{ tStart: s(0), tEnd: s(29.6) }]
  const tools: ToolSegment[] = []
  for (let k = 0; k < 13; k += 1) {
    steps.push({ tStart: s(29.6 + 0.02 * k), tEnd: s(29.61 + 0.02 * k) })
    tools.push(tool(29.61 + 0.02 * k, 29.62 + 0.02 * k, 'files', 'Read x'))
  }
  const input: RibbonInput = { ...EXAMPLE, endMs: s(30), steps, tools, live: { station: 'model', fromMs: s(29.86) } }
  const parts = ribbonSegments(input, 264)
  expect(detailedSteps(parts)).toBe(13)
  const live = parts[parts.length - 1] as RibbonPart
  expect(live.kind).toBe('live')
  expect(end(live)).toBeLessThanOrEqual(264)
  expectSound(parts)
})

test('a 30-minute turn of ordinary steps keeps N detailed', () => {
  // 80 steps of 10, 15 or 20 s, each followed by a 5-10 s tool: ≈ 1800 s.
  const input = finishedTurn(Array.from({ length: 80 }, (_, k): [number, number] => [10 + 5 * (k % 3), 5 + (k % 6)]))
  expect(input.endMs - T0).toBeGreaterThan(1700_000)
  for (const barPx of [264, 204]) {
    const parts = ribbonSegments(input, barPx)
    expect(detailedSteps(parts)).toBe(ribbonDetail(barPx))
    expectSound(parts)
    expect(end(parts[parts.length - 1] as RibbonPart)).toBe(barPx)
  }
})

test('the block gives way to a crowded live end and keeps 1 px a part', () => {
  const earlier = { ...zeroStationMs(), model: 14_000, files: 900, web: 1 }
  for (const from of [14.95, 14.999]) {
    const input: RibbonInput = {
      startedAt: T0, endMs: s(15), isLive: true, steps: [], tools: [], earlier,
      live: { station: 'shell', fromMs: s(from) },
    }
    const parts = ribbonSegments(input, 264)
    expect(parts.map((p) => p.kind)).toEqual(['earlier', 'earlier', 'earlier', 'live'])
    expectSound(parts)
    expect(parts[3]).toMatchObject({ w: 2 })
    expect(end(parts[3] as RibbonPart)).toBeLessThanOrEqual(264)
  }
})

test('a tool belongs to the step before it; parallel calls of one step are one part in the first call\'s hue', () => {
  expect(ribbonSegments(EXAMPLE, 264)[1]).toMatchObject({ kind: 'tool', station: 'files', ms: 400 })
  // The call that started first gives the hue, whatever order the calls returned in.
  const input: RibbonInput = {
    ...FINISHED, tools: [tool(9.1, 9.3, 'files', 'Read a'), tool(9.0, 9.2, 'web', 'WebFetch')],
  }
  expect(ribbonSegments(input, 264)[1]).toMatchObject({ kind: 'tool', station: 'web', ms: 300 })
})

test('the source holds no <title', () => {
  expect(drawRibbon(EXAMPLE, 264, FULL, STATS).svg).not.toContain('<title')
})

test('the alt', () => {
  expect(drawRibbon(EXAMPLE, 264, FULL, STATS).alt).toBe('Turn 2m 14s: model 58%, tools 42%, 6 steps, 1 failed call')
  const passed: RibbonInput = { ...EXAMPLE, tools: EXAMPLE.tools.map((t) => ({ ...t, failed: false })) }
  expect(drawRibbon(passed, 264, FULL, STATS).alt).toBe('Turn 2m 14s: model 58%, tools 42%, 6 steps')
  expect(drawRibbon(passed, 264, FULL, { ...STATS, steps: 1 }).alt).toBe('Turn 2m 14s: model 58%, tools 42%, 1 step')
})

test('the live end: the cap, the growth and the rest of the scale', () => {
  const svg = drawRibbon(EXAMPLE, 264, FULL, STATS).svg
  expect(svg).toContain('<rect data-part="cap" x="196" y="1" width="2" height="14"')
  expect(svg).toMatch(/<rect data-part="live"[^>]*><animate attributeName="width" to="93" dur="46s" fill="freeze"\/>/)
  expect(svg).toContain('<line data-part="rest" x1="199" y1="8.5" x2="264" y2="8.5"')
  expect(svg).toContain('<rect data-part="tick" x="263" y="5" width="1" height="6"')
  const done = drawRibbon(FINISHED, 264, FULL, STATS).svg
  for (const part of ['data-part="cap"', 'data-part="live"', 'data-part="rest"', 'data-part="tick"', '<animate']) {
    expect(done).not.toContain(part)
  }
  const parts = ribbonSegments(FINISHED, 264)
  expect(end(parts[parts.length - 1] as RibbonPart)).toBe(264)
})

test('ruling D: the cap\'s loop is phase-locked to the clock', () => {
  const svg = drawRibbon(EXAMPLE, 264, FULL, STATS).svg
  expect(svg).toContain(`attributeName="opacity" values="1;0.3;1"`)
  expect(svg).toContain(`begin="${loopBegin(EXAMPLE.endMs, 1600)}"`)
  expect(svg).not.toContain('begin="0s"')
})

test('reduced motion', () => {
  const svg = drawRibbon(EXAMPLE, 264, REDUCED, STATS).svg
  expect(svg).not.toContain('<animate')
  expect(svg).toContain('data-part="cap"')
})

test('escaping: no tool label reaches the source', () => {
  const input: RibbonInput = { ...EXAMPLE, tools: [tool(9.0, 9.4, 'shell', 'Bash echo "<a>" & \'b\'\u{7}', true)] }
  const { svg, alt } = drawRibbon(input, 264, FULL, STATS)
  expect(svg).not.toContain('echo')
  expect(/[\u{0}-\u{1F}\u{7F}-\u{9F}]/u.test(alt)).toBe(false)
})

test('the source stays under the cap', () => {
  const kinds = /data-part="(model|tool|earlier|live)"/g
  for (const input of [heavyTurn(60, 3), heavyTurn(1, 300)]) {
    const svg = drawRibbon(input, 4096, FULL, STATS).svg
    expect(svg.length).toBeLessThan(SVG_SOURCE_MAX)
    expect([...svg.matchAll(kinds)].length).toBeLessThanOrEqual(131)
    expect(ribbonSegments(input, 4096).length).toBeLessThanOrEqual(131)
  }
})

test('ribbonFromAcc puts the live part where the turn is', () => {
  const now = s(30)
  const one = acc([step(0, 5)])
  const at = (inFlight: Record<string, InFlightCall>, a: TurnAcc = one): RibbonInput['live'] =>
    ribbonFromAcc(a, inFlight, now).live
  expect(ribbonFromAcc(one, {}, now)).toMatchObject({ startedAt: T0, endMs: now, isLive: true })
  expect(at({ a: call('shell', 4) })).toEqual({ station: 'shell', fromMs: s(5) })
  expect(at({ a: call('shell', 6) })).toEqual({ station: 'model', fromMs: s(5) })
  // A subagent's call is not main's; of main's two, the earliest decides.
  expect(at({ a: call('web', 4.5), b: call('files', 4), c: call('mcp', 3, 'sub') })).toEqual({
    station: 'files', fromMs: s(5),
  })
  expect(at({})).toEqual({ station: 'model', fromMs: s(5) })
  expect(at({}, acc([step(0, 5)], [tool(5, 7, 'files', 'Read x')]))).toEqual({ station: 'model', fromMs: s(7) })
  expect(at({}, acc([]))).toEqual({ station: 'model', fromMs: T0 })
  const old = { turnId: 't', startedAt: T0, costAtStart: null, steps: [step(0, 5)], toolIntervals: [] } as never
  const input = ribbonFromAcc(old, {}, now)
  expect(input.tools).toEqual([])
  expect(input.earlier).toEqual(zeroStationMs())
  expect(drawRibbon(input, 264, FULL, STATS).svg).toContain('data-part="live"')
})

test('withLive adds the running part', () => {
  const one = acc([step(0, 5)])
  const stats = computeTurnStats(one, 23_000, undefined, null)
  const model = withLive(stats, ribbonFromAcc(one, {}, s(23)))
  expect([model.modelMs, model.toolMs, model.steps, model.elapsedMs]).toEqual([23_000, 0, 2, 23_000])
  const shell = withLive(stats, ribbonFromAcc(one, { a: call('shell', 4) }, s(23)))
  expect([shell.modelMs, shell.toolMs, shell.steps, shell.elapsedMs]).toEqual([5000, 18_000, 1, 23_000])
})

test('the legend and its narrow rules', () => {
  const terminal = legendItems(STATS, 44, 'terminal')
  expect(joined(terminal)).toBe('Model 58% · Tools 42% · 6 steps · TTFT 1.2s')
  expect(terminal[0]).toEqual({ text: 'Model', color: STATION_HUES.model.dark })
  expect(joined(legendItems(STATS, 43, 'terminal'))).toBe('Model 58% · Tools 42% · 6 steps')
  expect(joined(legendItems(STATS, 33, 'terminal'))).toBe('Model 58% · Tools 42%')
  const desktop = (cols: number): string => joined(legendItems(STATS, cols, 'desktop'))
  expect(legendItems(STATS, 36, 'desktop')[0]).toEqual({ text: 'Model', dimColor: true })
  expect(desktop(36).replaceAll('\u{a0}', ' ')).toBe('Model 58% · Tools 42% · 6 steps · TTFT 1.2s')
  expect(desktop(36)).not.toContain(' ')
  expect(desktop(35)).not.toContain('TTFT')
  expect(desktop(30)).toContain('steps')
  expect(desktop(29)).not.toContain('steps')
  expect(joined(legendItems({ ...STATS, ttftMs: null }, 44, 'terminal'))).toBe('Model 58% · Tools 42% · 6 steps')
})

test('the terminal bar at 44 columns', () => {
  const row = ribbonTerminal(EXAMPLE, 44)
  expect(joined(row)).toBe('██████████✗████████████████·········  2m 14s')
  const hue = (id: keyof typeof STATION_HUES): string => STATION_HUES[id].dark
  expect(row).toEqual([
    { text: '██', color: hue('model') },
    { text: '█', color: hue('files') },
    { text: '██', color: hue('model') },
    { text: '█████', color: hue('shell') },
    { text: '✗', color: BAD },
    { text: '███', color: hue('model') },
    { text: '████', color: hue('agents') },
    { text: '█', color: hue('model') },
    { text: '█', color: hue('you') },
    { text: '███', color: hue('model') },
    { text: '█', color: hue('mcp') },
    { text: '███', color: hue('model') },
    { text: '·········', dimColor: true },
    { text: ' ' },
    { text: ' 2m 14s' },
  ])
  const done = ribbonTerminal(FINISHED, 44)
  expect(barCells(done)).toBe(36)
  expect(joined(done)).not.toContain('·')
})

test('no terminal row is longer than its width', () => {
  for (const cols of [0, 8, 20, 39, 40, 60, 120, 200]) {
    for (const input of [EXAMPLE, FINISHED]) {
      expect(cellsOf(ribbonTerminal(input, cols))).toBeLessThanOrEqual(Math.max(cols, 0))
    }
    expect(cellsOf(legendItems(STATS, cols, 'terminal'))).toBeLessThanOrEqual(Math.max(cols, 0))
  }
  expect(barCells(ribbonTerminal(EXAMPLE, 120))).toBe(112)
  expect(barCells(ribbonTerminal(EXAMPLE, 200))).toBe(192)
  for (const barPx of [0, 5]) {
    const svg = drawRibbon(EXAMPLE, barPx, FULL, STATS).svg
    for (const [, size] of svg.matchAll(/<svg[^>]* (?:width|height)="([^"]+)"/g)) {
      expect(Number(size)).toBeGreaterThanOrEqual(1)
      expect(Number(size)).toBeLessThanOrEqual(4096)
    }
    expect(/<svg[^>]* width="([^"]+)" height="16"/.exec(svg)?.[1]).toBe(String(Math.max(1, barPx)))
  }
})

test('a draw stays fast', () => {
  const bestMs = (f: () => unknown): number => {
    let best = Infinity
    for (let batch = 0; batch < 5; batch += 1) {
      const started = performance.now()
      for (let i = 0; i < 50; i += 1) f()
      best = Math.min(best, (performance.now() - started) / 50)
    }
    return best
  }
  const input = heavyTurn(60, 3)
  expect(bestMs(() => drawRibbon(input, 3304, FULL, STATS))).toBeLessThanOrEqual(0.3)
  expect(bestMs(() => ribbonTerminal(input, 200))).toBeLessThanOrEqual(0.3)
})
