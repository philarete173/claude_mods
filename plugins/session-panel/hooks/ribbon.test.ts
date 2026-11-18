import { test, expect } from 'claude-code/testing'
import {
  drawRibbon, legendRows, ribbonCeilingMs, ribbonDetail, ribbonFromAcc, ribbonSegments, ribbonTerminal, stationTimes,
  withLive,
} from './ribbon'
import type { LegendItem, RibbonInput, RibbonPart } from './ribbon'
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
// The mockup's Turn 2: three steps of 4, 6 and 5 s, a Read between each two, finished at 16.5 s.
const TURN2: RibbonInput = {
  startedAt: T0, endMs: s(16.5), isLive: false,
  steps: [[0, 4], [4.3, 10.3], [11.5, 16.5]].map(([a = 0, b = 0]) => ({ tStart: s(a), tEnd: s(b) })),
  tools: [tool(4.0, 4.3, 'files', 'Read a'), tool(10.3, 11.5, 'files', 'Read b')],
  earlier: zeroStationMs(), live: null,
}
const STATS2: TurnStats = { ...STATS, steps: 3, ttftMs: 900 }
// A legend row as §17.10 writes it: `■ ` for a desktop item's swatch slot and gap, ` · ` between the items.
const rowText = (row: LegendItem[], isDesktop: boolean): string =>
  row.map((item) => `${item.station !== null && isDesktop ? '■ ' : ''}${joined(item.spans)}`).join(' · ')
const legendText = (rows: LegendItem[][], isDesktop: boolean): string[] => rows.map((row) => rowText(row, isDesktop))

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
  expect(drawRibbon(EXAMPLE, 264, FULL, STATS, stationTimes(EXAMPLE)).svg).not.toContain('<title')
})

test('the alt', () => {
  const times = stationTimes(EXAMPLE)
  expect(drawRibbon(EXAMPLE, 264, FULL, STATS, times).alt)
    .toBe('Turn 2m 14s: model 58%, files <1%, shell 23%, agents 17%, mcp 2%, you <1%, 6 steps, 1 failed call')
  const passed: RibbonInput = { ...EXAMPLE, tools: EXAMPLE.tools.map((t) => ({ ...t, failed: false })) }
  expect(drawRibbon(passed, 264, FULL, STATS, times).alt)
    .toBe('Turn 2m 14s: model 58%, files <1%, shell 23%, agents 17%, mcp 2%, you <1%, 6 steps')
  expect(drawRibbon(passed, 264, FULL, { ...STATS, steps: 1 }, times).alt).toMatch(/, you <1%, 1 step$/)
  // §17.6: with no parts known, today's alt.
  expect(drawRibbon(EXAMPLE, 264, FULL, STATS, null).alt)
    .toBe('Turn 2m 14s: model 58%, tools 42%, 6 steps, 1 failed call')
})

test('the live end: the cap, the growth and the rest of the scale', () => {
  const svg = drawRibbon(EXAMPLE, 264, FULL, STATS, stationTimes(EXAMPLE)).svg
  expect(svg).toContain('<rect data-part="cap" x="196" y="1" width="2" height="14"')
  expect(svg).toMatch(/<rect data-part="live"[^>]*><animate attributeName="width" to="93" dur="46s" fill="freeze"\/>/)
  expect(svg).toContain('<line data-part="rest" x1="199" y1="8.5" x2="264" y2="8.5"')
  expect(svg).toContain('<rect data-part="tick" x="263" y="5" width="1" height="6"')
  const done = drawRibbon(FINISHED, 264, FULL, STATS, stationTimes(FINISHED)).svg
  for (const part of ['data-part="cap"', 'data-part="live"', 'data-part="rest"', 'data-part="tick"', '<animate']) {
    expect(done).not.toContain(part)
  }
  const parts = ribbonSegments(FINISHED, 264)
  expect(end(parts[parts.length - 1] as RibbonPart)).toBe(264)
})

test('ruling D: the cap\'s loop is phase-locked to the clock', () => {
  const svg = drawRibbon(EXAMPLE, 264, FULL, STATS, stationTimes(EXAMPLE)).svg
  expect(svg).toContain(`attributeName="opacity" values="1;0.3;1"`)
  expect(svg).toContain(`begin="${loopBegin(EXAMPLE.endMs, 1600)}"`)
  expect(svg).not.toContain('begin="0s"')
})

test('reduced motion', () => {
  const svg = drawRibbon(EXAMPLE, 264, REDUCED, STATS, stationTimes(EXAMPLE)).svg
  expect(svg).not.toContain('<animate')
  expect(svg).toContain('data-part="cap"')
})

test('escaping: no tool label reaches the source', () => {
  const input: RibbonInput = { ...EXAMPLE, tools: [tool(9.0, 9.4, 'shell', 'Bash echo "<a>" & \'b\'\u{7}', true)] }
  const { svg, alt } = drawRibbon(input, 264, FULL, STATS, stationTimes(input))
  expect(svg).not.toContain('echo')
  expect(/[\u{0}-\u{1F}\u{7F}-\u{9F}]/u.test(alt)).toBe(false)
})

test('the source stays under the cap', () => {
  const kinds = /data-part="(model|tool|earlier|live)"/g
  for (const input of [heavyTurn(60, 3), heavyTurn(1, 300)]) {
    const svg = drawRibbon(input, 4096, FULL, STATS, stationTimes(input)).svg
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
  expect(drawRibbon(input, 264, FULL, STATS, stationTimes(input)).svg).toContain('data-part="live"')
})

test('withLive adds the running part', () => {
  const one = acc([step(0, 5)])
  const stats = computeTurnStats(one, 23_000, undefined, null)
  const model = withLive(stats, ribbonFromAcc(one, {}, s(23)))
  expect([model.modelMs, model.toolMs, model.steps, model.elapsedMs]).toEqual([23_000, 0, 2, 23_000])
  const shell = withLive(stats, ribbonFromAcc(one, { a: call('shell', 4) }, s(23)))
  expect([shell.modelMs, shell.toolMs, shell.steps, shell.elapsedMs]).toEqual([5000, 18_000, 1, 23_000])
})

test('stationTimes sums the bar\'s parts by station', () => {
  expect(stationTimes(EXAMPLE)).toEqual({
    model: 78_000, files: 400, shell: 31_000, web: 0, agents: 22_300, mcp: 2100, skills: 0, you: 200,
  })
  const inMcp = stationTimes({ ...EXAMPLE, live: { station: 'mcp', fromMs: s(116) } })
  expect([inMcp.model, inMcp.mcp]).toEqual([60_000, 20_100])
})

test('stationTimes counts earlier and the calls before the first step', () => {
  const times = stationTimes({
    ...FINISHED, earlier: { ...zeroStationMs(), model: 5000, files: 700 },
    tools: [tool(-2, -1, 'web', 'WebFetch'), ...FINISHED.tools],
  })
  expect([times.model, times.files, times.web]).toEqual([65_000, 1100, 1000])
})

test('parallel calls give their group to the first-started call\'s station', () => {
  const times = stationTimes({
    ...FINISHED, steps: [{ tStart: s(0), tEnd: s(9) }, { tStart: s(9.4), tEnd: s(10) }], endMs: s(10),
    tools: [tool(9.1, 9.3, 'files', 'Read a'), tool(9.0, 9.2, 'web', 'WebFetch')],
  })
  expect([times.web, times.files]).toEqual([300, 0])
})

test('sequential calls count the gap between them', () => {
  const input: RibbonInput = {
    startedAt: T0, endMs: s(5), isLive: false, steps: [{ tStart: s(0), tEnd: s(1) }, { tStart: s(4), tEnd: s(5) }],
    tools: [tool(1, 2, 'shell', 'Bash a'), tool(3, 4, 'shell', 'Bash b')], earlier: zeroStationMs(), live: null,
  }
  const times = stationTimes(input)
  // The group spans 1 → 4.
  expect([times.shell, times.model]).toEqual([3000, 2000])
  // `toolMs` is the union, 2 s; the shares are of the parts' sum, 5 s.
  const stats = { ...STATS, modelMs: 2000, toolMs: 2000 }
  expect(rowText(legendRows(stats, times, 80, 'terminal')[0] ?? [], false)).toStartWith('Model 40% · Shell 60%')
})

test('the items: Model first, then the stations with time in station order, then steps and TTFT', () => {
  const rows = legendRows(STATS, stationTimes(EXAMPLE), 80, 'terminal')
  expect(legendText(rows, false)).toEqual([
    'Model 58% · Files <1% · Shell 23% · Agents 17% · MCP 2% · You <1% · 6 steps',
    'TTFT 1.2s',
  ])
  const items = rows.flat()
  expect(items[0]?.spans).toEqual([{ text: 'Model', color: STATION_HUES.model.dark }, { text: ' 58%' }])
  const texts = items.map((item) => joined(item.spans))
  expect(texts.some((text) => /^(Web|Skills) /.test(text))).toBe(false)
  expect(texts.slice(1, 6).some((text) => text.endsWith(' 0%'))).toBe(false)
  // A running turn at its first instant: every time 0.
  const first: RibbonInput = {
    startedAt: T0, endMs: T0, isLive: true, steps: [], tools: [], earlier: zeroStationMs(),
    live: { station: 'model', fromMs: T0 },
  }
  expect(legendText(legendRows(STATS, stationTimes(first), 80, 'terminal'), false))
    .toEqual(['Model 0% · 6 steps · TTFT 1.2s'])
  expect(legendText(legendRows({ ...STATS, ttftMs: null }, stationTimes(EXAMPLE), 80, 'terminal'), false).join())
    .not.toContain('TTFT')
})

test('the rows of §17.10', () => {
  const times = stationTimes(EXAMPLE)
  const at = (cols: number, surface: 'desktop' | 'terminal', stats = STATS, t = times): string[] =>
    legendText(legendRows(stats, t, cols, surface), surface === 'desktop')
  expect(at(33, 'desktop')).toEqual([
    '■ Model 58% · ■ Files <1%', '■ Shell 23% · ■ Agents 17%', '■ MCP 2% · ■ You <1% · 6 steps', 'TTFT 1.2s',
  ])
  expect(at(41, 'desktop')).toEqual([
    '■ Model 58% · ■ Files <1% · ■ Shell 23%', '■ Agents 17% · ■ MCP 2% · ■ You <1%', '6 steps · TTFT 1.2s',
  ])
  expect(at(56, 'desktop')).toEqual([
    '■ Model 58% · ■ Files <1% · ■ Shell 23% · ■ Agents 17%', '■ MCP 2% · ■ You <1% · 6 steps · TTFT 1.2s',
  ])
  expect(at(44, 'terminal')).toEqual([
    'Model 58% · Files <1% · Shell 23%', 'Agents 17% · MCP 2% · You <1% · 6 steps', 'TTFT 1.2s',
  ])
  expect(at(80, 'terminal')).toEqual([
    'Model 58% · Files <1% · Shell 23% · Agents 17% · MCP 2% · You <1% · 6 steps', 'TTFT 1.2s',
  ])
  // The mockup's Turn 2.
  const t2 = stationTimes(TURN2)
  expect(at(33, 'desktop', STATS2, t2)).toEqual(['■ Model 91% · ■ Files 9%', '3 steps · TTFT 0.9s'])
  expect(at(41, 'desktop', STATS2, t2)).toEqual(['■ Model 91% · ■ Files 9% · 3 steps', 'TTFT 0.9s'])
  expect(at(56, 'desktop', STATS2, t2)).toEqual(['■ Model 91% · ■ Files 9% · 3 steps · TTFT 0.9s'])
  for (const cols of [44, 80]) {
    expect(at(cols, 'terminal', STATS2, t2)).toEqual(['Model 91% · Files 9% · 3 steps · TTFT 0.9s'])
  }
  // The desktop's label is dim beside its swatch; the terminal's is in the station's hue, with no swatch.
  const files = (surface: 'desktop' | 'terminal'): LegendItem | undefined =>
    legendRows(STATS, times, 80, surface).flat()[1]
  expect(files('desktop')).toEqual({ station: 'files', spans: [{ text: 'Files', dimColor: true }, { text: ' <1%' }] })
  expect(files('terminal')).toEqual({
    station: null, spans: [{ text: 'Files', color: STATION_HUES.files.dark }, { text: ' <1%' }],
  })
})

test('no terminal row is wider than cols, and no row is empty', () => {
  const times = stationTimes(EXAMPLE)
  for (const cols of [0, 8, 20, 39, 44, 80]) {
    for (const surface of ['desktop', 'terminal'] as const) {
      for (const row of legendRows(STATS, times, cols, surface)) {
        expect(row.length, `${surface} ${cols}`).toBeGreaterThan(0)
        if (surface === 'terminal') {
          const used = row.reduce((n, item) => n + cellsOf(item.spans), 3 * (row.length - 1))
          expect(used, `${cols}`).toBeLessThanOrEqual(Math.max(cols, 0))
        }
      }
    }
  }
})

test('an item wider than its row is cut with …', () => {
  const times = stationTimes(EXAMPLE)
  expect(rowText(legendRows(STATS, times, 8, 'terminal')[0] ?? [], false)).toBe('Model 5…')
  expect(joined(legendRows(STATS, times, 8, 'desktop')[0]?.[0]?.spans ?? [])).toBe('Model…')
})

test('the fallback: Model and Tools by pctOf', () => {
  expect(legendText(legendRows(STATS, null, 44, 'terminal'), false))
    .toEqual(['Model 58% · Tools 42% · 6 steps · TTFT 1.2s'])
  const [model, tools] = legendRows(STATS, null, 44, 'terminal').flat()
  expect(model?.spans[0]).toEqual({ text: 'Model', color: STATION_HUES.model.dark })
  expect(tools?.spans[0]).toEqual({ text: 'Tools', dimColor: true })
  const desktop = legendRows(STATS, null, 80, 'desktop').flat()
  expect(desktop.map((item) => item.station)).toEqual(['model', null, null, null])
  expect(desktop[0]?.spans[0]).toEqual({ text: 'Model', dimColor: true })
  expect(legendText(legendRows(STATS, null, 33, 'terminal'), false))
    .toEqual(['Model 58% · Tools 42% · 6 steps', 'TTFT 1.2s'])
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

test('the terminal time is the elapsedMs passed, else the input\'s span', () => {
  const input = { ...FINISHED, endMs: s(134) }
  expect(joined(ribbonTerminal(input, 44, 135_000)).endsWith(' 2m 15s')).toBe(true)
  expect(joined(ribbonTerminal(input, 44)).endsWith(' 2m 14s')).toBe(true)
})

test('no terminal row is longer than its width', () => {
  for (const cols of [0, 8, 20, 39, 40, 60, 120, 200]) {
    for (const input of [EXAMPLE, FINISHED]) {
      expect(cellsOf(ribbonTerminal(input, cols))).toBeLessThanOrEqual(Math.max(cols, 0))
    }
  }
  expect(barCells(ribbonTerminal(EXAMPLE, 120))).toBe(112)
  expect(barCells(ribbonTerminal(EXAMPLE, 200))).toBe(192)
  for (const barPx of [0, 5]) {
    const svg = drawRibbon(EXAMPLE, barPx, FULL, STATS, stationTimes(EXAMPLE)).svg
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
  expect(bestMs(() => drawRibbon(input, 3304, FULL, STATS, stationTimes(input)))).toBeLessThanOrEqual(0.6)
  expect(bestMs(() => ribbonTerminal(input, 200))).toBeLessThanOrEqual(0.6)
})
