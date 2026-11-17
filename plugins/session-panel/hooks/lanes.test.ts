import { test, expect } from 'claude-code/testing'
import {
  drawAxis, drawLane, laneLabelCells, laneLabelSpans, laneModel, lanesTerminal, taskTime, TASK_TIME_CELLS,
} from './lanes'
import type { Lane, LaneModel } from './lanes'
import { STATION_HUES } from './stations'
import type { AgentRow, MainTurn, TaskRow } from './stats'
import { BAD, GREEN, loopBegin, OK, SVG_SOURCE_MAX } from './svg'

// Local time, so the clock labels hold in any zone.
const NOW = new Date(2026, 10, 16, 12, 4, 20).getTime()
const ago = (seconds: number): number => NOW - seconds * 1000
const FULL = { motion: 'full' as const }
const REDUCED = { motion: 'reduced' as const }
const joined = (spans: { text: string }[]): string => spans.map((span) => span.text).join('')
const cellsOf = (s: string): number => [...s].length

const agent = (id: string, description: string, type: string, status: AgentRow['status'], startedAt: number | null,
  endedAt: number | null, costUsd: number | null, restored?: true): AgentRow => ({
  id, description, type, model: null, status, startedAt, endedAt, costUsd, ...(restored ? { restored } : {}),
})
const task = (id: string, description: string, status: TaskRow['status'], startedAt: number | null,
  endedAt: number | null, durationMs: number | null): TaskRow => ({
  id, kind: 'shell', description, status, startedAt, endedAt, durationMs,
})

// §2.3's agents, tasks and main turns.
const AGENTS: Record<string, AgentRow> = {
  a1: agent('a1', 'Review the diff', 'pr-review:code-reviewer', 'running', ago(360), null, 0.31),
  a2: agent('a2', 'Plan critique', 'plan-critic', 'running', null, null, 0.41, true),
  a3: agent('a3', 'Map the mask', 'explorer', 'done', ago(69), ago(46), 0.12),
  a4: agent('a4', 'Repro check', 'general-purpose', 'failed', ago(240), ago(180), 0.05),
  a5: agent('a5', 'Engine facts', 'general-purpose', 'done', ago(720), ago(240), 0.88),
}
const TASKS: Record<string, TaskRow> = {
  t1: task('t1', 'npm test', 'running', ago(220), null, null),
  t2: task('t2', 'claude plugin test', 'done', ago(580), ago(562), 18_200),
  t3: task('t3', 'dev server', 'stopped', ago(600), ago(360), 240_000),
}
const MAIN_TURNS: MainTurn[] = [
  { start: ago(750), end: ago(530) }, { start: ago(380), end: ago(220) }, { start: ago(134), end: null },
]
const EXAMPLE = {
  agents: AGENTS, tasks: TASKS, mainTurns: MAIN_TURNS, mainUsd: 3.2, nowMs: NOW, isMainRunning: true,
}
const model = (input: Partial<Parameters<typeof laneModel>[0]> = {}): LaneModel => {
  const m = laneModel({ ...EXAMPLE, ...input })
  if (m === null) throw new Error('no model')
  return m
}
const laneOf = (m: LaneModel, label: string): Lane => {
  const lane = m.lanes.find((l) => l.label === label)
  if (lane === undefined) throw new Error(label)
  return lane
}
const AXIS_360 = { startMs: ago(720), nowMs: NOW }

// The bars' [from, to] and the marks' centres of a lane's source.
const barsOf = (svg: string): [number, number][] =>
  [...svg.matchAll(/<rect data-part="bar" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/g)]
    .map(([, x = '', w = '']) => [Number(x), Number(x) + Number(w)])
const marksOf = (svg: string): number[] =>
  [...svg.matchAll(/data-part="mark" transform="translate\(([\d.]+) 9\.5\)"/g)].map(([, x = '']) => Number(x))
const near = (actual: number, expected: number): void => {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(0.05)
}

test('the order of §6.1 with unknown times', () => {
  const m = model()
  expect(m.lanes.map((l) => l.label)).toEqual([
    'main', 'Review the diff', 'npm test', 'Plan critique', 'Map the mask', 'Repro check', 'Engine facts', 'dev server',
  ])
  expect(m.more).toBe(1)
  expect(m.summary).toBe('3/8')
  expect(m.lanes.map((l) => l.station)).toEqual(['model', 'agents', 'shell', 'agents', 'agents', 'agents', 'agents',
    'shell'])
  // An ended lane with no known end sorts last of the ended ones.
  const ended = model({
    agents: {
      x: agent('x', 'no end', 'a', 'done', ago(100), null, null),
      y: agent('y', 'old end', 'a', 'done', ago(600), ago(500), null),
      z: agent('z', 'new end', 'a', 'failed', ago(60), ago(30), null),
    },
    tasks: {},
  })
  expect(ended.lanes.map((l) => l.label)).toEqual(['main', 'new end', 'old end', 'no end'])
})

test('+N more', () => {
  const agents = { ...AGENTS }
  for (let i = 0; i < 27; i += 1) agents[`x${i}`] = agent(`x${i}`, `extra ${i}`, 'a', 'done', ago(900), ago(800), 0.01)
  const m = model({ agents })
  expect(m.lanes).toHaveLength(8)
  expect(m.more).toBe(28)
  expect(m.summary).toBe('3/35')
  const idle = model({ agents: { a3: AGENTS.a3 as AgentRow }, tasks: { t2: TASKS.t2 as TaskRow } })
  expect(idle.summary).toBe('2')
  expect(idle.more).toBe(0)
})

test('the axis spans the oldest shown start to now, 2 minutes at least, and never by main', () => {
  expect(model().axis).toEqual({ startMs: ago(720), nowMs: NOW })
  const lone = { a: agent('a', 'lone', 'a', 'running', ago(30), null, null) }
  expect(model({ agents: lone, tasks: {} }).axis).toEqual({ startMs: ago(120), nowMs: NOW })
  const restored = { a: agent('a', 'restored', 'a', 'running', null, null, null, true) }
  expect(model({ agents: restored, tasks: {} }).axis).toEqual({ startMs: ago(120), nowMs: NOW })
  const old = [{ start: ago(3000), end: ago(2900) }, { start: ago(10), end: null }]
  expect(model({ agents: lone, tasks: {}, mainTurns: old }).axis).toEqual({ startMs: ago(120), nowMs: NOW })
})

test('hidden with no subagents and no tasks', () => {
  expect(laneModel({ ...EXAMPLE, agents: {}, tasks: {} })).toBeNull()
  expect(laneModel({ ...EXAMPLE, agents: {}, tasks: {}, mainTurns: [] })).toBeNull()
})

test('the values', () => {
  const m = model()
  expect(['main', 'Review the diff', 'npm test', 'Plan critique', 'dev server'].map((l) => laneOf(m, l).value))
    .toEqual(['$3.20', '$0.310', '3m 40s', '$0.410+', '4m 00s'])
  const free = model({ agents: { a: agent('a', 'free', 'a', 'running', ago(10), null, null) } })
  expect(laneOf(free, 'free').value).toBeNull()
  expect(model({ mainUsd: null }).lanes[0]?.value).toBeNull()
  expect(laneOf(m, 'Review the diff').tag).toBe('@code-reviewer')
  expect(laneOf(m, 'npm test').tag).toBe('@shell')
})

test('the moved taskTime is as it was', () => {
  expect(TASK_TIME_CELLS).toBe(8)
  expect(taskTime(task('t', 'x', 'running', ago(220), null, null), NOW)).toBe('3m 40s')
  expect(taskTime(task('t', 'x', 'running', null, null, null), NOW)).toBeNull()
  expect(taskTime({ ...task('t', 'x', 'done', ago(9), ago(1), 8000), durationAtMost: true }, NOW)).toBe('\u{2264}8.0s')
})

// The cases of view.test.tsx's task rows before Activity, against taskTime: how long a running task has run, how long
// a finished one ran, and null where that is not known or is wider than the value's 8 cells.
test('taskTime: the time a task ran, null when not known or too wide for its cell', () => {
  const hours = (h: number, m = 0): number => (h * 60 + m) * 60_000
  const ran = (status: TaskRow['status'], patch: Partial<TaskRow> = {}): TaskRow =>
    ({ ...task('t', 'x', status, ago(90), status === 'running' ? null : ago(1), status === 'running' ? null : 5000),
      ...patch })
  const cases: Array<[name: string, row: TaskRow, time: string | null]> = [
    ['running since 90 s', ran('running'), '1m 30s'],
    ['running since 0.4 s', ran('running', { startedAt: NOW - 400 }), '0.4s'],
    ['running since 100 hours', ran('running', { startedAt: NOW - hours(100) }), '100h 00m'],
    // A wall clock that was put back since the task began never gives a negative time.
    ['running, the clock put back', ran('running', { startedAt: NOW + 5000 }), '0.0s'],
    ['running, its start not seen', ran('running', { startedAt: null }), null],
    // A task that has ended shows how long it ran, and not the time since its start.
    ['done in 72 s', ran('done', { durationMs: 72_000, startedAt: NOW - 3_600_000 }), '1m 12s'],
    ['failed in 5 s', ran('failed'), '5.0s'],
    ['stopped after 2 min', ran('stopped', { durationMs: 120_300 }), '2m 00s'],
    ['ended after 5 s', ran('ended'), '5.0s'],
    ['done, no start but a duration', ran('done', { startedAt: null, durationMs: 72_000 }), '1m 12s'],
    ['done, no duration', ran('done', { durationMs: null }), null],
    ['done, no start and no duration', ran('done', { startedAt: null, durationMs: null }), null],
    ['ended, no duration', ran('ended', { durationMs: null }), null],
    // A time that ran to a late notice is a bound: `≤` (U+2264) stands before it.
    ['done, at most 12.2 s', ran('done', { durationMs: 12_200, durationAtMost: true }), '\u{2264}12.2s'],
    // A time is drawn whole or not at all: `999h 59m` is the widest that fits, `≤99h 59m` with a bound's `≤`.
    ['a duration of 2^53 - 1 ms', ran('done', { durationMs: Number.MAX_SAFE_INTEGER }), null],
    ['done in 1000 hours', ran('done', { durationMs: hours(1000) }), null],
    ['done in 999h 59m', ran('done', { durationMs: hours(999, 59) }), '999h 59m'],
    ['running since 1000 hours', ran('running', { startedAt: NOW - hours(1000) }), null],
    ['running since 999h 59m', ran('running', { startedAt: NOW - hours(999, 59) }), '999h 59m'],
    ['99h 59m, at most', ran('done', { durationMs: hours(99, 59), durationAtMost: true }), '\u{2264}99h 59m'],
    ['100 hours, at most', ran('done', { durationMs: hours(100), durationAtMost: true }), null],
  ]
  for (const [name, row, time] of cases) {
    expect(taskTime(row, NOW), name).toBe(time)
    if (time !== null) expect(cellsOf(time), name).toBeLessThanOrEqual(TASK_TIME_CELLS)
  }
  // The time of a running task follows the clock of the drawing; a finished one's does not move.
  expect(taskTime(ran('running'), NOW + 30_000)).toBe('2m 00s')
  expect(taskTime(ran('done', { durationMs: 72_000 }), NOW + 30_000)).toBe('1m 12s')
})

test('hostile ids are plain ids', () => {
  const agents = JSON.parse(
    '{"__proto__": {"id": "__proto__", "description": "proto", "type": "a", "model": null, "status": "running",' +
    ' "startedAt": 1, "endedAt": null, "costUsd": null},' +
    ' "constructor": {"id": "constructor", "description": "ctor", "type": "a", "model": null, "status": "running",' +
    ' "startedAt": 0, "endedAt": null, "costUsd": null}}',
  ) as Record<string, AgentRow>
  for (const row of Object.values(agents)) row.startedAt = ago(row.startedAt === 0 ? 300 : 100)
  const m = model({ agents, tasks: {} })
  expect(m.lanes.map((l) => l.key)).toEqual(['main', 'constructor', '__proto__'])
  expect(m.lanes.map((l) => l.label)).toEqual(['main', 'ctor', 'proto'])
})

test('the label cells follow §6.6', () => {
  expect([33, 41, 52, 108].map(laneLabelCells)).toEqual([9, 12, 15, 32])
  expect([40, 44, 60, 80, 120, 200].map(laneLabelCells)).toEqual([12, 13, 18, 24, 32, 32])
  expect([20, 0, -4].map(laneLabelCells)).toEqual([9, 9, 9])
})

test('the tag shows from 24 label cells and gives way after the description', () => {
  const review = laneOf(model(), 'Review the diff')
  // 30 cells hold `Review the diff @code-reviewer` whole: the description primary, the tag dim.
  expect(laneLabelSpans(review, 30)).toEqual([{ text: 'Review the diff' }, { text: ' @code-reviewer', dimColor: true }])
  // At 24 the description gives way first: 24 − 1 − 14 = 9 cells.
  expect(laneLabelSpans(review, 24)).toEqual([{ text: 'Review t…' }, { text: ' @code-reviewer', dimColor: true }])
  expect(laneLabelSpans(review, 18)).toEqual([{ text: 'Review the diff' }])
  const long: Lane = { ...review, label: 'x'.repeat(40), tag: '@a-very-long-agent-type' }
  // The description down to 6 cells, then the tag cut with `…`.
  expect(laneLabelSpans(long, 24)).toEqual([{ text: 'xxxxx…' }, { text: ' @a-very-long-age…', dimColor: true }])
  for (const n of [24, 26, 30, 32, 40]) {
    expect(cellsOf(joined(laneLabelSpans(long, n))), String(n)).toBeLessThanOrEqual(n)
    expect(cellsOf(joined(laneLabelSpans(review, n))), String(n)).toBeLessThanOrEqual(n)
  }
  const ended = laneOf(model(), 'Map the mask')
  expect(laneLabelSpans(ended, 12)).toEqual([{ text: 'Map the mask', dimColor: true }])
})

test('the shapes of R5 per status', () => {
  const m = model()
  const running = drawLane(laneOf(m, 'Review the diff'), AXIS_360, 152, FULL).svg
  expect(running).toContain('<rect data-part="bar" x="70" y="6.5" width="70" height="6"')
  expect(running).toContain('<rect data-part="cap" x="138" y="4.5" width="2" height="10"')
  const done = drawLane(laneOf(m, 'Map the mask'), AXIS_360, 152, FULL).svg
  expect(done).toMatch(/<rect data-part="bar" x="[\d.]+" y="8" width="[\d.]+" height="3" rx="1.5"/)
  expect(done).toMatch(new RegExp(`data-part="mark" transform="translate\\(137.06 9.5\\)"><path [^>]*${GREEN}`))
  expect(drawLane(laneOf(m, 'Repro check'), AXIS_360, 152, FULL).svg)
    .toMatch(/data-part="mark"[^>]*><path [^>]*#e5484d/)
  expect(drawLane(laneOf(m, 'dev server'), AXIS_360, 152, FULL).svg)
    .toMatch(/data-part="mark"[^>]*><rect x="-2.5" y="-2.5" width="5" height="5" rx="1" fill="#8a8a8a"/)
  const ended: Lane = { ...laneOf(m, 'Map the mask'), status: 'ended', spans: [] }
  const endedSvg = drawLane(ended, AXIS_360, 152, FULL).svg
  expect(endedSvg).toContain('x1="0" y1="9.5" x2="140" y2="9.5"')
  expect(endedSvg).toContain('stroke-dasharray="3 3"')
  expect(endedSvg).toMatch(/data-part="mark" transform="translate\(146 9.5\)"><circle r="3.5"/)
  expect(endedSvg).not.toContain('data-part="cap"')
  const unknown = drawLane(laneOf(m, 'Plan critique'), AXIS_360, 152, FULL).svg
  expect(unknown).toContain('stroke-dasharray="3 3"')
  expect(unknown).toContain('data-part="cap"')
  expect(unknown).not.toContain('data-part="mark"')
  const main = drawLane(laneOf(m, 'main'), AXIS_360, 152, FULL).svg
  expect(main).toContain('<linearGradient')
  expect(main).toContain('<rect data-part="bar" x="0" ')
  expect(main).not.toContain('data-part="mark"')
  // Every hue gets its light pair.
  expect(running).toContain(`[fill="${STATION_HUES.agents.dark}"]{fill:${STATION_HUES.agents.light}}`)
})

test('the worked geometry at 360 px', () => {
  const m = model()
  const table: [string, [number, number][], number[]][] = [
    ['main', [[0, 36.9], [66.1, 97.2], [113.9, 140]], []],
    ['Review the diff', [[70, 140]], []],
    ['npm test', [[97.2, 140]], []],
    ['Plan critique', [], []],
    ['Map the mask', [[126.6, 131.1]], [137.1]],
    ['Repro check', [[93.3, 105]], [111]],
    ['Engine facts', [[0, 93.3]], [99.3]],
    ['dev server', [[23.3, 70]], [76]],
  ]
  for (const [label, bars, marks] of table) {
    const svg = drawLane(laneOf(m, label), m.axis, 152, FULL).svg
    const got = barsOf(svg)
    expect(got.length, label).toBe(bars.length)
    bars.forEach(([from, to], i) => {
      near(got[i]?.[0] ?? NaN, from)
      near(got[i]?.[1] ?? NaN, to)
    })
    const gotMarks = marksOf(svg)
    expect(gotMarks.length, label).toBe(marks.length)
    marks.forEach((x, i) => near(gotMarks[i] ?? NaN, x))
    expect(svg).toContain('width="152" height="19"')
  }
})

test('the axis ticks at every width', () => {
  const m = model()
  const ticks = (svg: string): number => svg.split('data-part="tick"').length - 1
  expect([116, 152, 218, 532, 3032].map((area) => ticks(drawAxis(m.axis, area, FULL).svg))).toEqual([1, 2, 2, 6, 12])
  const at152 = drawAxis(m.axis, 152, FULL)
  expect(at152.svg).toMatch(/<text data-part="label" x="31.11" [^>]*>11:55<\/text>/)
  expect(at152.svg).toMatch(/<text data-part="label" x="89.44" [^>]*>12:00<\/text>/)
  expect(at152.svg).toMatch(/<text data-part="now" x="144" [^>]*text-anchor="end"[^>]*>now<\/text>/)
  expect(at152.alt).toBe('axis 11:52 to now')
  expect(at152.svg).toContain('width="152" height="16"')
  // 12:00 is 60 s before now, 11.7 px from it, and 11:50 is 11.7 px from the axis start:
  // their labels go, their ticks stay.
  const late = new Date(2026, 10, 16, 12, 1, 0).getTime()
  const close = drawAxis({ startMs: late - 720_000, nowMs: late }, 152, FULL).svg
  expect(ticks(close)).toBe(3)
  expect([...close.matchAll(/data-part="label"[^>]*>([\d:]+)</g)].map(([, t]) => t)).toEqual(['11:55'])
  for (const area of [12, 0, -8]) {
    const svg = drawAxis(m.axis, area, FULL).svg
    expect(ticks(svg), String(area)).toBe(0)
    const [, w = '', h = ''] = /width="([\d.]+)" height="([\d.]+)"/.exec(svg) ?? []
    for (const px of [Number(w), Number(h)]) {
      expect(px).toBeGreaterThanOrEqual(1)
      expect(px).toBeLessThanOrEqual(4096)
    }
  }
})

test('a clock label closer than 14 px to the axis start is left out; its tick stays', () => {
  const minute = new Date(2026, 10, 16, 14, 39, 0).getTime()
  const spanMs = 600_000
  const a = 1264 - 12
  // The first round minute is `lead` ms after the start, so its tick lands at lead * a / spanMs px.
  const drawn = (lead: number): { ticks: number; labels: [string, number][] } => {
    const svg = drawAxis({ startMs: minute - lead, nowMs: minute - lead + spanMs }, 1264, FULL).svg
    const labels = [...svg.matchAll(/data-part="label" x="([\d.]+)"[^>]*>([\d:]+)</g)]
    return {
      ticks: svg.split('data-part="tick"').length - 1,
      labels: labels.map(([, x = '', t = '']): [string, number] => [t, Number(x)]),
    }
  }
  const first = drawn(1000)
  expect((1000 * a) / spanMs).toBeLessThan(14)
  expect(first.ticks).toBe(10)
  expect(first.labels.map(([t]) => t).slice(0, 2)).toEqual(['14:40', '14:41'])
  expect(Math.min(...first.labels.map(([, x]) => x))).toBeGreaterThanOrEqual(14)
  // The boundary: a label at 14.02 px stays, one at 13.88 px goes.
  expect(drawn(6720).labels[0]?.[0]).toBe('14:39')
  expect(drawn(6650).labels[0]?.[0]).toBe('14:40')
  expect(drawn(6650).ticks).toBe(drawn(6720).ticks)
})

test('the alts carry the tag at every width', () => {
  const m = model()
  for (const area of [116, 152, 3032]) {
    expect(drawLane(laneOf(m, 'Review the diff'), m.axis, area, FULL).alt)
      .toBe('Review the diff (@code-reviewer), running, $0.310')
  }
  expect(drawLane(laneOf(m, 'main'), m.axis, 152, FULL).alt).toBe('main, running, $3.20')
  const free = { ...laneOf(m, 'npm test'), value: null }
  expect(drawLane(free, m.axis, 152, FULL).alt).toBe('npm test (@shell), running, unknown')
  const ctl = { ...laneOf(m, 'npm test'), label: 'npm\u{1} test' }
  expect(drawLane(ctl, m.axis, 152, FULL).alt).toBe('npm test (@shell), running, 3m 40s')
})

test('motion reduced', () => {
  const m = model()
  for (const lane of m.lanes) expect(drawLane(lane, m.axis, 152, REDUCED).svg).not.toContain('<animate')
  expect(drawAxis(m.axis, 152, REDUCED).svg).not.toContain('<animate')
  const full = drawLane(laneOf(m, 'Review the diff'), m.axis, 152, FULL).svg
  expect(full).toContain(`begin="${loopBegin(NOW, 1600)}"`)
  for (const lane of m.lanes) expect(drawLane(lane, m.axis, 152, FULL).svg).not.toContain('begin="0s"')
})

test('a restored lane that ended live keeps its end and its status mark', () => {
  // Start not known (restored), end seen live: it sorts by its end and draws its status mark after the dashed line.
  const agents = {
    old: agent('old', 'old end', 'a', 'done', ago(600), ago(500), null),
    back: agent('back', 'came back', 'a', 'done', null, ago(30), 0.2, true),
    lost: agent('lost', 'lost end', 'a', 'failed', null, ago(200), null, true),
  }
  const m = model({ agents, tasks: {} })
  expect(m.lanes.map((l) => l.label)).toEqual(['main', 'came back', 'lost end', 'old end'])
  const back = drawLane(laneOf(m, 'came back'), m.axis, 152, FULL).svg
  expect(back).toContain('stroke-dasharray="3 3"')
  expect(back).toMatch(new RegExp(`data-part="mark" transform="translate\\(146 9.5\\)"><path [^>]*${GREEN}`))
  expect(drawLane(laneOf(m, 'lost end'), m.axis, 152, FULL).svg).toMatch(/data-part="mark"[^>]*><path [^>]*#e5484d/)
  const rows = lanesTerminal(m, 44)
  expect(joined(rows[1] ?? [])).toBe(`came back     ${'┄'.repeat(20)}✓  $0.200+`)
  expect(rows[1]?.find((span) => span.text === '✓')).toEqual({ text: '✓', color: OK })
  expect(rows[2]?.find((span) => span.text === '✗')).toEqual({ text: '✗', color: BAD })
})

test('a span of years caps its ticks', () => {
  const axis = { startMs: NOW - 3650 * 86_400_000, nowMs: NOW }
  const { svg } = drawAxis(axis, 152, FULL)
  expect(svg.length).toBeLessThan(SVG_SOURCE_MAX)
  expect(svg).toContain('data-part="now"')
  const rows = lanesTerminal({ ...model(), axis }, 44)
  expect(joined(rows[8] ?? []).endsWith('now')).toBe(true)
})

test('escaping', () => {
  const m = model()
  const hostile: Lane = { ...laneOf(m, 'Review the diff'), label: '<b>&"\'', tag: '@<i>' }
  const { svg, alt } = drawLane(hostile, m.axis, 152, FULL)
  expect(svg).not.toContain('<b>')
  expect(svg).not.toContain('<i>')
  expect(alt).toBe('<b>&"\' (@<i>), running, $0.310')
})

test('the terminal strings at 44 columns', () => {
  const rows = lanesTerminal(model(), 44)
  expect(rows.map(joined)).toEqual([
    'main          ─────    ─────  ━━━━◐    $3.20',
    'Review the d…           ━━━━━━━━━━◐   $0.310',
    'npm test                    ━━━━━━◐   3m 40s',
    'Plan critique ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄◐  $0.410+',
    'Map the mask                    ─✓    $0.120',
    'Repro check                ──✗        $0.050',
    'Engine facts  ─────────────✓          $0.880',
    'dev server       ───────■             4m 00s',
    '                11:55    12:00  now',
    '+1 more',
  ])
  const bar = (row: number): string => [...joined(rows[row] ?? [])].slice(14, 35).join('')
  expect([bar(0), bar(4), bar(6)])
    .toEqual(['─────    ─────  ━━━━◐', `${' '.repeat(18)}─✓ `, `${'─'.repeat(13)}✓${' '.repeat(7)}`])
  const colourOf = (row: number, ch: string): object | undefined => {
    const span = rows[row]?.find((s) => s.text.includes(ch))
    return span === undefined ? undefined : { color: span.color, dimColor: span.dimColor }
  }
  const model_ = STATION_HUES.model.dark
  const agents = STATION_HUES.agents.dark
  const shell = STATION_HUES.shell.dark
  expect(colourOf(0, '━')).toEqual({ color: model_, dimColor: undefined })
  expect(colourOf(0, '─')).toEqual({ color: model_, dimColor: undefined })
  expect(colourOf(1, '◐')).toEqual({ color: agents, dimColor: undefined })
  expect(colourOf(2, '━')).toEqual({ color: shell, dimColor: undefined })
  expect(colourOf(3, '┄')).toEqual({ color: agents, dimColor: undefined })
  expect(colourOf(4, '✓')).toEqual({ color: OK, dimColor: undefined })
  expect(colourOf(5, '✗')).toEqual({ color: BAD, dimColor: undefined })
  expect(colourOf(7, '■')).toEqual({ color: undefined, dimColor: true })
  expect(colourOf(8, 'now')).toEqual({ color: undefined, dimColor: true })
  expect(colourOf(9, '+1 more')).toEqual({ color: undefined, dimColor: true })
  // Running lanes and main primary, the rest dim.
  expect(colourOf(0, 'main')).toEqual({ color: undefined, dimColor: undefined })
  expect(colourOf(4, 'Map the mask')).toEqual({ color: undefined, dimColor: true })
  // An ended lane of unknown span: `┄` and a dim `○` in the gutter.
  const ended = { ...model(), lanes: [{ ...laneOf(model(), 'Map the mask'), status: 'ended' as const, spans: [] }] }
  const endedRow = lanesTerminal(ended, 44)[0] ?? []
  expect(joined(endedRow)).toBe(`Map the mask  ${'┄'.repeat(20)}○   $0.120`)
  expect(endedRow.find((s) => s.text === '○')).toEqual({ text: '○', dimColor: true })
})

test('no terminal row is longer than its width', () => {
  const m = model()
  for (const cols of [0, 8, 20, 39, 40, 60, 80, 120, 200]) {
    const rows = lanesTerminal(m, cols)
    expect(rows).toHaveLength(10)
    for (const row of rows) expect(cellsOf(joined(row)), `${cols}`).toBeLessThanOrEqual(Math.max(cols, 0))
  }
  for (const cols of [40, 44, 60, 80, 120, 200]) {
    for (const row of lanesTerminal(m, cols).slice(0, 8)) expect(cellsOf(joined(row)), `${cols}`).toBe(cols)
  }
  const tagged = (cols: number): boolean => joined(lanesTerminal(m, cols)[1] ?? []).includes('@code-reviewer')
  expect([60, 80, 120].map(tagged)).toEqual([false, true, true])
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
  const m = model()
  for (const lane of m.lanes) {
    expect(bestMs(() => drawLane(lane, m.axis, 3032, FULL)), lane.label).toBeLessThanOrEqual(0.6)
  }
  expect(bestMs(() => drawAxis(m.axis, 3032, FULL))).toBeLessThanOrEqual(0.6)
  expect(bestMs(() => lanesTerminal(m, 200))).toBeLessThanOrEqual(0.6)
})
