// Activity (spec §6): one lane per subagent, one per background task and main's turns on one time axis, drawn with
// R5's status shapes, the axis of clock ticks, and the terminal's rows. Pure: no `$`, no engine.

import { cells, cutCells, fitRow, middleCut, padEnd, padStart, spansCells } from './cells'
import type { Span } from './cells'
import { STATION_HUES } from './stations'
import type { StationId } from './stations'
import { fmtClock, fmtDuration, fmtUsd, shortType } from './stats'
import type { AgentRow, MainTurn, TaskRow } from './stats'
import {
  altText, BAD, fitSvg, GREEN, loopBegin, NEUTRAL, OK, RED, SURFACE, SVG_FONT, svgPx, themeStyle,
} from './svg'
import type { Look } from './svg'

export type LaneStatus = 'running' | 'done' | 'failed' | 'stopped' | 'ended'
export type Lane = {
  key: string // the row's id, never an element key
  kind: 'main' | 'agent' | 'task'; label: string; tag: string; status: LaneStatus
  station: StationId // main: model, a subagent: agents, a task: shell
  spans: { start: number | null; end: number | null }[] // end null: running; start null: not known
  value: string | null
}
export type LaneAxis = { startMs: number; nowMs: number }
export type LaneModel = { lanes: Lane[]; more: number; axis: LaneAxis; summary: string }
type KnownSpan = { start: number; end: number | null }

export const LANE_VALUE_CELLS = 8
// A time from 100 hours on takes 8 cells (`100h 00m`), the widest this cell holds. A time of 1000 hours or more
// (`1000h 00m`) would overflow it, and taskTime draws it as not known.
// The `≤` of a bound takes a cell of its own, so `≤99h 59m` is the widest bound the cell holds, and `≤100h 00m` is
// drawn as not known.
export const TASK_TIME_CELLS = 8

const LANES_MAX = 8
const AXIS_MIN_MS = 120_000
const GUTTER_PX = 12
const TAG_FROM = 24 // the label cells from which the type tag shows (R15)
const STEPS_MIN = [1, 2, 5, 10, 15, 30, 60, 120, 240, 480, 720, 1440]
const CAP_MS = 1600
const EASE = '.45 0 .55 1'
const TABULAR = ' style="font-variant-numeric:tabular-nums"'
// The marks after a finished span, centred on (0, 0): the house check, a cross, a stop square, a ring.
const MARKS: Record<Exclude<LaneStatus, 'running'>, string> = {
  done: `<path d="M-3.92 .08L-1.2 2.8 3.92-2.8" fill="none" stroke="${GREEN}" stroke-width="1.4"` +
    ' stroke-linecap="round" stroke-linejoin="round"/>',
  failed: `<path d="M-3.25-3.25l6.5 6.5M3.25-3.25l-6.5 6.5" fill="none" stroke="${RED}" stroke-width="1.4"` +
    ' stroke-linecap="round"/>',
  stopped: `<rect x="-2.5" y="-2.5" width="5" height="5" rx="1" fill="${NEUTRAL}"/>`,
  ended: `<circle r="3.5" fill="none" stroke="${NEUTRAL}" stroke-width="1.4"/>`,
}
const TERMINAL_MARKS: Record<Exclude<LaneStatus, 'running'>, Span> = {
  done: { text: '✓', color: OK }, failed: { text: '✗', color: BAD }, stopped: { text: '■', dimColor: true },
  ended: { text: '○', dimColor: true },
}

const PLAIN: Partial<Span> = {}

const num = (x: number): string => String(Math.round(x * 100) / 100)

// What a task's row shows at the right: how long a running one has run, never under 0 (the wall clock may have been put
// back since it began), and how long a finished one ran. Null where it is not known: a running task whose start the mod
// did not see, a finished one that has no duration, and one whose time is wider than its cell (1000 hours or more: no
// task runs that long, but a notice can carry any safe integer as its duration). A value is drawn whole, never cut, so
// such a time is drawn as not known, and the row stays one line. A finished task whose time is a bound (durationAtMost)
// has `≤` before it, and the width counts it.
export function taskTime(task: TaskRow, now: number): string | null {
  const ran = task.startedAt === null ? null : Math.max(0, now - task.startedAt)
  const ms = task.status === 'running' ? ran : task.durationMs
  const text = ms === null ? null : `${task.durationAtMost === true ? '\u{2264}' : ''}${fmtDuration(ms)}`

  return text === null || text.length > TASK_TIME_CELLS ? null : text
}

/** §4.1's label column: `clamp(floor(cols × 0.45), 9, 64)` cells. */
export function laneLabelCells(cols: number): number {
  return Math.min(64, Math.max(9, Math.floor(cols * 0.45)))
}

const spansOf = (start: number | null, end: number | null): Lane['spans'] =>
  (start === null && end === null ? [] : [{ start, end }])

// §6.1's order: running lanes by the older start (unknown last), then ended ones by the newer end (unknown last).
const orderKey = (lane: Lane): [number, number] => lane.status === 'running'
  ? [0, lane.spans[0]?.start ?? Infinity]
  : [1, -(lane.spans[0]?.end ?? -Infinity)]

export function laneModel(input: {
  agents: Record<string, AgentRow>; tasks: Record<string, TaskRow>; mainTurns: MainTurn[]; mainUsd: number | null
  nowMs: number; isMainRunning: boolean
}): LaneModel | null {
  const { nowMs, isMainRunning } = input
  // The ids are the records' own keys: no lookup by id, so `__proto__` is a plain id.
  const rows: Lane[] = [
    ...Object.entries(input.agents).map(([key, a]): Lane => ({
      key, kind: 'agent', label: a.description, tag: `@${shortType(a.type)}`, status: a.status, station: 'agents',
      spans: spansOf(a.startedAt, a.status === 'running' ? null : a.endedAt),
      value: a.costUsd === null ? null : `${fmtUsd(a.costUsd)}${a.restored === true ? '+' : ''}`,
    })),
    ...Object.entries(input.tasks).map(([key, t]): Lane => ({
      key, kind: 'task', label: t.description, tag: `@${t.kind}`, status: t.status, station: 'shell',
      spans: spansOf(t.startedAt, t.status === 'running' ? null : t.endedAt), value: taskTime(t, nowMs),
    })),
  ]
  if (rows.length === 0) return null
  rows.sort((a, b) => {
    const [ra, ta] = orderKey(a)
    const [rb, tb] = orderKey(b)
    return ra - rb || ta - tb || 0
  })
  const shown = rows.slice(0, LANES_MAX - 1)
  const running = rows.filter((lane) => lane.status === 'running').length
  const main: Lane = {
    key: 'main', kind: 'main', label: 'main', tag: '', status: isMainRunning ? 'running' : 'done', station: 'model',
    // An open turn is drawn open only while main runs.
    spans: input.mainTurns.filter((t) => t.end !== null || isMainRunning).map((t) => ({ start: t.start, end: t.end })),
    value: input.mainUsd === null ? null : fmtUsd(input.mainUsd),
  }
  // §6.3: the oldest shown start, 2 minutes back at least; main and unknown starts never set it.
  const startMs = shown.reduce((t, lane) => Math.min(t, lane.spans[0]?.start ?? t), nowMs - AXIS_MIN_MS)
  return {
    lanes: [main, ...shown], more: rows.length - shown.length, axis: { startMs, nowMs },
    summary: running > 0 ? `${running}/${rows.length}` : `${rows.length}`,
  }
}

/** One shown lane's label (§4.2-§4.4): the description as drawn, the tag ('' when none shows) and the
 * description's cells (descW; L below TAG_FROM or with no tag column). `isDim`: an ended lane's description. */
export type LaneLabel = { desc: string; tag: string; descCells: number; isDim: boolean }

/** The shown lanes' labels in `labelCells`, one per lane in order: tags whole in a column as wide as the widest, the
 * descriptions cut at the end, or in the middle where their end cuts read the same (§4.2, §4.3). */
export function laneLabels(lanes: Lane[], labelCells: number): LaneLabel[] {
  const tagW = labelCells >= TAG_FROM ? Math.max(0, ...lanes.map((lane) => cells(lane.tag))) : 0
  const descCells = tagW > 0 ? labelCells - 1 - tagW : labelCells
  const descs = lanes.map((lane) => cutCells(lane.label, descCells))
  const groups = new Map<string, number[]>() // an end cut to the lanes that cut to it
  descs.forEach((desc, i) => {
    if (cells(lanes[i]?.label ?? '') <= descCells) return
    const group = groups.get(desc)
    if (group === undefined) groups.set(desc, [i])
    else group.push(i)
  })
  for (const group of groups.values()) {
    if (group.length < 2) continue
    middleCut(group.map((i) => lanes[i]?.label ?? ''), descCells).forEach((desc, n) => {
      descs[group[n] ?? 0] = desc
    })
  }
  return lanes.map((lane, i) => ({
    desc: descs[i] ?? '', tag: tagW > 0 ? lane.tag : '', descCells,
    isDim: !(lane.kind === 'main' || lane.status === 'running'),
  }))
}

// The spans with a known start that reach into the axis (main's older turns do not).
const knownSpans = (lane: Lane, axis: LaneAxis): KnownSpan[] =>
  lane.spans.filter((s): s is KnownSpan => s.start !== null && (s.end === null || s.end >= axis.startMs))

const laneAlt = (lane: Lane): string =>
  altText(`${lane.label}${lane.tag === '' ? '' : ` (${lane.tag})`}, ${lane.status}, ${lane.value ?? 'unknown'}`)

export function drawLane(lane: Lane, axis: LaneAxis, areaPx: number, look: Look): { svg: string; alt: string } {
  const w = svgPx(areaPx)
  const a = Math.max(0, w - GUTTER_PX)
  const spanMs = axis.nowMs - axis.startMs
  const xOf = (t: number): number => Math.min(a, Math.max(0, a - ((axis.nowMs - t) * a) / spanMs))
  const hue = STATION_HUES[lane.station]
  const capRect = `<rect data-part="cap" x="${num(a - 2)}" y="4.5" width="2" height="10" fill="${hue.dark}"`
  const cap = look.motion === 'full'
    ? `${capRect}><animate attributeName="opacity" values="1;0.3;1" keyTimes="0;0.5;1" calcMode="spline"` +
      ` keySplines="${EASE};${EASE}" dur="${CAP_MS / 1000}s" begin="${loopBegin(axis.nowMs, CAP_MS)}"` +
      ' repeatCount="indefinite"/></rect>'
    : `${capRect}/>`
  const mark = (status: Exclude<LaneStatus, 'running'>, cx: number): string =>
    `<g data-part="mark" transform="translate(${num(cx)} 9.5)">${MARKS[status]}</g>`
  const known = knownSpans(lane, axis)
  let defs = ''
  let body = ''
  if (known.length === 0 && lane.kind !== 'main') {
    // A restored lane: its start is not known; an end seen live keeps its status mark.
    body += `<line data-part="dash" x1="0" y1="9.5" x2="${num(a)}" y2="9.5" stroke="${hue.dark}" stroke-width="2"` +
      ` stroke-dasharray="3 3"/>${lane.status === 'running' ? cap : mark(lane.status, a + 6)}`
  }
  known.forEach((s, i) => {
    const x0 = xOf(s.start)
    const x1 = s.end === null ? a : xOf(s.end)
    let fill = hue.dark
    if (s.start < axis.startMs) {
      // Started before the axis: an 8 px fade-in at the left edge.
      defs += `<linearGradient id="fade${i}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="8" y2="0">` +
        `<stop offset="0" stop-color="${hue.dark}" stop-opacity="0"/><stop offset="1" stop-color="${hue.dark}"/>` +
        '</linearGradient>'
      fill = `url(#fade${i})`
    }
    const rect = `<rect data-part="bar" x="${num(x0)}"`
    body += s.end === null
      ? `${rect} y="6.5" width="${num(x1 - x0)}" height="6" rx="3" fill="${fill}"/>${cap}`
      : `${rect} y="8" width="${num(x1 - x0)}" height="3" rx="1.5" fill="${fill}"/>`
  })
  const last = known[known.length - 1]
  if (last !== undefined && lane.kind !== 'main' && lane.status !== 'running') {
    body += mark(lane.status, (last.end === null ? a : xOf(last.end)) + 6)
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="19" viewBox="0 0 ${w} 19">` +
    `${themeStyle([[hue.dark, hue.light]])}${defs === '' ? '' : `<defs>${defs}</defs>`}${body}</svg>`
  return { svg: fitSvg(svg), alt: laneAlt(lane) }
}

// §6.3 and §6.6: the least step whose ticks are `gap` units apart, at `perMin` units a minute; past 1440 m, the least
// whole number of days that is wide enough.
const tickStepMs = (perMin: number, gap: number): number =>
  (STEPS_MIN.find((s) => s * perMin >= gap) ?? Math.ceil(gap / perMin / 1440) * 1440) * 60_000

// The clock times on the axis whose minutes since local midnight are a multiple of the step.
function ticksOf(axis: LaneAxis, stepMs: number, max: number): number[] {
  const d = new Date(axis.startMs)
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const out: number[] = []
  // Past the 1440 m step the ticks would grow with the span: `max` (a px or a cell each) bounds them.
  let t = midnight + Math.ceil((axis.startMs - midnight) / stepMs) * stepMs
  for (; t <= axis.nowMs && out.length < max; t += stepMs) out.push(t)
  return out
}

const hhmm = (ms: number): string => fmtClock(ms).slice(0, 5)
const axisText = (x: number, part: string, anchor: string, body: string): string =>
  `<text data-part="${part}" x="${num(x)}" y="14" font-family="${SVG_FONT}" font-size="9" fill="${SURFACE.ash.dark}"` +
  ` text-anchor="${anchor}"${TABULAR}>${body}</text>`

// The axis draws no motion; `look` keeps the signature of the other draws.
export function drawAxis(axis: LaneAxis, areaPx: number, look: Look): { svg: string; alt: string } {
  const w = svgPx(areaPx)
  const a = Math.max(0, w - GUTTER_PX)
  const spanMs = axis.nowMs - axis.startMs
  let body = ''
  if (a > 0) {
    body += `<rect data-part="rail" x="0" y="2" width="${num(a)}" height="1" fill="${SURFACE.rail.dark}"/>`
    for (const t of ticksOf(axis, tickStepMs(a / (spanMs / 60_000), 48), Math.max(0, Math.floor(a)))) {
      const x = a - ((axis.nowMs - t) * a) / spanMs
      body += `<rect data-part="tick" x="${num(x - 0.5)}" y="1" width="1" height="4" fill="${SURFACE.ash.dark}"/>`
      // A label closer than 36 px to `now` is left out; its tick stays.
      // So is one closer than 14 px to the axis start (half its width), which the image would clip.
      if (a - x >= 36 && x >= 14) body += axisText(x, 'label', 'middle', hhmm(t))
    }
  }
  body += axisText(a + 4, 'now', 'end', 'now')
  const style = themeStyle([SURFACE.rail, SURFACE.ash].map((c) => [c.dark, c.light] as const))
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="16" viewBox="0 0 ${w} 16">${style}` +
    `${body}</svg>`
  return { svg: fitSvg(svg), alt: altText(`axis ${hhmm(axis.startMs)} to now`) }
}

// §6.5's bar: `axisCells` cells of the axis and the gutter, runs of one colour merged into one span.
function laneBar(lane: Lane, axis: LaneAxis, axisCells: number): Span[] {
  if (axisCells < 1) return [{ text: ' '.repeat(Math.max(0, axisCells + 1)) }]
  const hue: Partial<Span> = { color: STATION_HUES[lane.station].dark }
  const cellMs = (axis.nowMs - axis.startMs) / axisCells
  const at = (t: number): number => Math.round((t - axis.startMs) / cellMs)
  // A cell's character and its style; a run of one style object is one span.
  const chars: string[] = Array<string>(axisCells + 1).fill(' ')
  const styles: Partial<Span>[] = Array<Partial<Span>>(axisCells + 1).fill(PLAIN)
  const put = (i: number, text: string, style: Partial<Span>): void => {
    chars[i] = text
    styles[i] = style
  }
  const known = knownSpans(lane, axis)
  if (known.length === 0 && lane.kind !== 'main') {
    for (let i = 0; i < axisCells; i += 1) put(i, '┄', hue)
    if (lane.status === 'running') put(axisCells, '◐', hue)
    else put(axisCells, TERMINAL_MARKS[lane.status].text, TERMINAL_MARKS[lane.status])
  }
  let lastEnd = 0
  for (const s of known) {
    const from = Math.min(axisCells - 1, Math.max(0, at(s.start)))
    const to = s.end === null ? axisCells : Math.min(axisCells, Math.max(from + 1, at(s.end)))
    for (let i = from; i < to; i += 1) put(i, s.end === null ? '━' : '─', hue)
    if (s.end === null) put(axisCells, '◐', hue)
    lastEnd = to
  }
  if (known.length > 0 && lane.kind !== 'main' && lane.status !== 'running') {
    put(lastEnd, TERMINAL_MARKS[lane.status].text, TERMINAL_MARKS[lane.status])
  }
  const out: Span[] = []
  let from = 0
  for (let i = 1; i <= axisCells + 1; i += 1) {
    if (i === axisCells + 1 || styles[i] !== styles[from]) {
      out.push({ ...styles[from], text: chars.slice(from, i).join('') })
      from = i
    }
  }
  return out
}

// §6.5's axis row: clock labels centred on their ticks' cells, none touching another or `now` in the last 3 cells.
function axisRow(axis: LaneAxis, axisCells: number): string {
  const nowAt = axisCells - 2 // the bar's last 3 cells
  if (nowAt < 0) return ''
  const cellMs = (axis.nowMs - axis.startMs) / axisCells
  let out = ''
  let pos = 0 // the cells of `out`: every one is a code point
  let free = 0 // the first cell the next label may take
  for (const t of ticksOf(axis, tickStepMs(60_000 / cellMs, 8), axisCells + 1)) {
    const start = Math.round((t - axis.startMs) / cellMs) - 2
    if (start >= free && start + 5 <= nowAt - 1) {
      out += `${' '.repeat(Math.max(0, start - pos))}${hhmm(t)}`
      pos = start + 5
      free = start + 6
    }
  }
  return `${out}${' '.repeat(Math.max(0, nowAt - pos))}now`
}

/** §6.5's rows but the header: the lanes, the axis and `+N more`, each cut to `cols`. The labels are §4.4's. */
export function lanesTerminal(model: LaneModel, cols: number): Span[][] {
  const l = laneLabelCells(cols)
  const axisCells = Math.max(0, cols - l - 10) - 1
  const labels = laneLabels(model.lanes, l)
  const rows = model.lanes.map((lane, i) => {
    const { desc, tag, descCells, isDim } = labels[i] ?? { desc: '', tag: '', descCells: l, isDim: false }
    const label: Span[] = [
      { text: tag === '' ? desc : padEnd(desc, descCells), ...(isDim ? { dimColor: true } : {}) },
      ...(tag === '' ? [] : [{ text: ` ${tag}`, dimColor: true }]),
    ]
    const value: Span = lane.value === null
      ? { text: padStart('—', LANE_VALUE_CELLS), dimColor: true }
      : { text: padStart(lane.value, LANE_VALUE_CELLS) }
    return fitRow([
      ...label, { text: ' '.repeat(Math.max(0, l + 1 - spansCells(label))) }, ...laneBar(lane, model.axis, axisCells),
      { text: ' ' }, value,
    ], cols)
  })
  rows.push(fitRow([{ text: ' '.repeat(l + 1) }, { text: axisRow(model.axis, axisCells), dimColor: true }], cols))
  if (model.more > 0) rows.push(fitRow([{ text: `+${model.more} more`, dimColor: true }], cols))
  return rows
}
