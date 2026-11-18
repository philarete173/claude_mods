// The turn ribbon (spec §5): one bar per turn against a ceiling, a part per model call and per step's tool calls, the
// older steps merged into one part per station, a live end that grows, the legend by station (spec 0.7.1 §17) and the
// terminal's bar. Pure: no `$`, no engine.

import { fitRow, padStart, spansCells } from './cells'
import type { Span } from './cells'
import { STATION_HUES, STATION_LABELS, STATION_ORDER, zeroStationMs } from './stations'
import type { InFlightCall, StationId, StationMs } from './stations'
import { fmtDuration, fmtTtft, ribbonOf } from './stats'
import type { RibbonTurn, ToolSegment, TurnAcc, TurnStats } from './stats'
import { altText, BAD, fitSvg, loopBegin, SURFACE, svgPx, themeStyle } from './svg'
import type { Look } from './svg'

export type RibbonInput = {
  startedAt: number; endMs: number; isLive: boolean
  steps: { tStart: number; tEnd: number }[]; tools: ToolSegment[]; earlier: StationMs
  live: { station: StationId; fromMs: number } | null // the running part, from the end of the last finished one
}
/** An item of the legend: its spans, and on the desktop the station whose swatch leads it (null: none). */
export type LegendItem = { station: StationId | null; spans: Span[] }
export const LEGEND_SEP: Span = { text: ' · ', dimColor: true }
export type RibbonPart = {
  kind: 'model' | 'tool' | 'earlier' | 'live'; station: StationId; x: number; w: number; ms: number; failed: boolean
}

// A part before it is placed: its times, and the room it needs.
type Piece = { kind: RibbonPart['kind']; station: StationId; start: number; end: number; ms: number; failed: boolean }
// A step's model part and its tool group, and what it adds to `earlier` once merged.
type Row = { pieces: Piece[]; spent: [StationId, number][] }

const EASE = '.45 0 .55 1'
const CAP_MS = 1600
const HOUR = 3_600_000
const LADDER = [15e3, 30e3, 60e3, 120e3, 180e3, 300e3, 600e3, 900e3, 1200e3, 1800e3, 2700e3, HOUR, 1.5 * HOUR,
  2 * HOUR, 3 * HOUR]

const num = (x: number): string => String(Math.round(x * 100) / 100)
const minPx = (p: Piece): number => (p.station === 'model' ? 1 : 2)

export function ribbonFromTurn(turn: RibbonTurn): RibbonInput {
  const { startedAt, endedAt, steps, tools, earlier } = turn
  return { startedAt, endMs: endedAt, isLive: false, steps, tools, earlier, live: null }
}

/** The running turn at `nowMs` (ruling D: its end is the clock), with its running part. */
export function ribbonFromAcc(acc: TurnAcc, inFlight: Record<string, InFlightCall>, nowMs: number): RibbonInput {
  const base = ribbonFromTurn(ribbonOf(acc, nowMs))
  const lastStop = base.steps[base.steps.length - 1]?.tEnd
  const fromMs = base.tools.reduce((t, tool) => Math.max(t, tool.t1), lastStop ?? base.startedAt)
  let first: InFlightCall | undefined
  for (const c of Object.values(inFlight)) {
    if (c.agentId === null && (first === undefined || c.at < first.at)) first = c
  }
  // A call that started after the last stop is one the model is still writing: the model runs.
  const station = first !== undefined && lastStop !== undefined && first.at <= lastStop ? first.station : 'model'
  return { ...base, isLive: true, live: { station, fromMs } }
}

/** The stats with the running part added: a model part is one more step. */
export function withLive(stats: TurnStats, input: RibbonInput): TurnStats {
  const live = input.live
  if (live === null) return stats
  const ms = input.endMs - live.fromMs
  return {
    ...stats, elapsedMs: input.endMs - input.startedAt,
    ...(live.station === 'model'
      ? { modelMs: stats.modelMs + ms, steps: stats.steps + 1 }
      : { toolMs: stats.toolMs + ms }),
  }
}

/** §5.2: a running turn's ceiling is the first rung ≥ the elapsed time; a finished one's is the elapsed time. */
export function ribbonCeilingMs(elapsedMs: number, isLive: boolean): number {
  if (!Number.isFinite(elapsedMs)) return 15_000
  return isLive
    ? (LADDER.find((ms) => ms >= elapsedMs) ?? Math.ceil(elapsedMs / HOUR) * HOUR)
    : Math.max(1, elapsedMs)
}

/** §5.3's N: the steps drawn in detail. */
export function ribbonDetail(barPx: number): number {
  return Math.min(60, Math.max(6, Math.floor(barPx / 20)))
}

// The latest step whose start is at or before `t`, or -1.
function stepBefore(steps: RibbonInput['steps'], t: number): number {
  let lo = 0
  let hi = steps.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((steps[mid]?.tStart ?? Infinity) <= t) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

// The steps as rows; the calls before the first step go to `head`, the earlier time.
function rowsOf(input: RibbonInput): { head: StationMs; rows: Row[]; live: Piece | null } {
  const head = { ...input.earlier }
  const rows: Row[] = input.steps.map(({ tStart, tEnd }) => ({
    pieces: [{ kind: 'model', station: 'model', start: tStart, end: tEnd, ms: tEnd - tStart, failed: false }],
    spent: [['model', tEnd - tStart]],
  }))
  const groups: (Piece | undefined)[] = []
  for (const tool of input.tools) {
    const i = stepBefore(input.steps, tool.t0)
    const row = rows[i]
    if (row === undefined) {
      head[tool.station] += tool.t1 - tool.t0
      continue
    }
    row.spent.push([tool.station, tool.t1 - tool.t0])
    const g = groups[i]
    if (g === undefined) {
      groups[i] = { kind: 'tool', station: tool.station, start: tool.t0, end: tool.t1, ms: 0, failed: tool.failed }
    } else {
      // The call that started first gives the hue.
      if (tool.t0 < g.start) g.station = tool.station
      g.start = Math.min(g.start, tool.t0)
      g.end = Math.max(g.end, tool.t1)
      g.failed ||= tool.failed
    }
  }
  groups.forEach((g, i) => {
    if (g !== undefined) rows[i]?.pieces.push({ ...g, ms: g.end - g.start })
  })
  const l = input.live
  const live: Piece | null = l === null
    ? null
    : { kind: 'live', station: l.station, start: l.fromMs, end: input.endMs, ms: input.endMs - l.fromMs, failed: false }
  return { head, rows, live }
}

const addSpent = (earlier: StationMs, row: Row | undefined): void => {
  for (const [id, ms] of row?.spent ?? []) earlier[id] += ms
}

// `earlier` as parts in station order, then the detailed rows from `first`, then the live part.
function piecesOf(earlier: StationMs, rows: Row[], first: number, live: Piece | null): Piece[] {
  const out: Piece[] = STATION_ORDER.filter((id) => earlier[id] > 0).map((id) => ({
    kind: 'earlier', station: id, start: NaN, end: NaN, ms: earlier[id], failed: false,
  }))
  for (let i = first; i < rows.length; i += 1) out.push(...(rows[i]?.pieces ?? []))
  if (live !== null) out.push(live)
  return out
}

/** §17.2: each station's time as the bar draws it, every stored step in detail: piecesOf(head, rows, 0, live). */
export function stationTimes(input: RibbonInput): StationMs {
  const { head, rows, live } = rowsOf(input)
  // The bar's colours, not ribbonSegments' merge, which follows the bar's width: the legend does not change with it.
  const times = zeroStationMs()
  for (const p of piecesOf(head, rows, 0, live)) times[p.station] += p.ms
  return times
}

/**
 * `total` cells or px over `weights`, at least 1 each (callers keep `weights.length` ≤ `total`): each floored share, a
 * 0 raised to 1, the rest by the largest remainders (taken back from the largest when the raises overshoot).
 */
function apportion(weights: number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  const shares = weights.map((w) => (sum > 0 ? (w / sum) * total : 0))
  const counts = shares.map((x) => Math.max(1, Math.floor(x)))
  let rest = total - counts.reduce((a, b) => a + b, 0)
  const byRemainder = shares.map((_, i) => i).sort((a, b) => {
    const ra = (shares[a] ?? 0) - Math.floor(shares[a] ?? 0)
    const rb = (shares[b] ?? 0) - Math.floor(shares[b] ?? 0)
    return rb - ra
  })
  for (const i of byRemainder) {
    if (rest <= 0) break
    counts[i] = (counts[i] ?? 0) + 1
    rest -= 1
  }
  let isTaking = rest < 0
  const byCount = isTaking ? shares.map((_, i) => i).sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0)) : []
  while (isTaking) {
    isTaking = false
    for (const i of byCount) {
      if (rest < 0 && (counts[i] ?? 0) > 1) {
        counts[i] = (counts[i] ?? 0) - 1
        rest += 1
        isTaking = rest < 0
      }
    }
  }
  return counts
}

// One layout pass: the earlier block, then each detailed part pushed forward into later slack, then the tail pulled
// back to the bar's (or the live) end. `isBad` when even a block of 1 px a part leaves no room; with `canMerge` false
// (nothing left to merge, a bar of a few px) the layout stands as it is.
function place(pieces: Piece[], input: RibbonInput, barPx: number, ceiling: number, canMerge: boolean):
  { parts: RibbonPart[]; isBad: boolean } {
  const at = (t: number): number => Math.round(((t - input.startedAt) * barPx) / ceiling)
  const nEarlier = pieces.filter((p) => p.kind === 'earlier').length
  const detail = pieces.slice(nEarlier)
  // The last part ends at the bar's end; the block where the first detailed part starts (-1 px: no block).
  const ends = detail.map((p, i) => (i === detail.length - 1 ? input.endMs : p.end))
  const need = nEarlier > 0 ? nEarlier : -1
  let blockW = nEarlier > 0 ? Math.max(at(detail[0]?.start ?? input.endMs), nEarlier) : -1
  let cursor = blockW + 1
  const boxes = detail.map((p, i) => {
    const box = { x: cursor, w: Math.max(at(ends[i] ?? input.endMs) - cursor, minPx(p)) }
    cursor = box.x + box.w + 1
    return box
  })
  // The tail ends at the bar's end, or at the live end when pushes carried it further.
  let limit = Math.min(barPx, at(input.endMs))
  for (let i = boxes.length - 1; i >= 0; i -= 1) {
    const b = boxes[i]
    if (b === undefined || b.x + b.w <= limit) break
    b.w = Math.max(limit - b.x, minPx(detail[i] as Piece))
    b.x = limit - b.w
    limit = b.x - 1
  }
  // §10's N: the block gives way before any detailed step merges.
  const lead = boxes[0]
  const isBad = lead !== undefined && lead.x - 1 < need && canMerge
  if (lead !== undefined && lead.x <= blockW) blockW = Math.max(lead.x - 1, need)
  const parts: RibbonPart[] = []
  const widths = apportion(pieces.slice(0, nEarlier).map((p) => p.ms), Math.max(0, blockW))
  let x = 0
  pieces.slice(0, nEarlier).forEach((p, i) => {
    const w = widths[i] ?? 0
    parts.push({ kind: p.kind, station: p.station, x, w, ms: p.ms, failed: p.failed })
    x += w
  })
  detail.forEach((p, i) => {
    const box = boxes[i] ?? { x: 0, w: 0 }
    parts.push({ kind: p.kind, station: p.station, x: box.x, w: box.w, ms: p.ms, failed: p.failed })
  })
  return { parts, isBad }
}

/** The parts at `barPx`: the latest N steps in detail; more merge only when even a 1 px block part does not fit. */
export function ribbonSegments(input: RibbonInput, barPx: number): RibbonPart[] {
  const ceiling = ribbonCeilingMs(input.endMs - input.startedAt, input.isLive)
  const { head, rows, live } = rowsOf(input)
  let first = Math.max(0, rows.length - ribbonDetail(barPx))
  const earlier = { ...head }
  for (let i = 0; i < first; i += 1) addSpent(earlier, rows[i])
  let laid = place(piecesOf(earlier, rows, first, live), input, barPx, ceiling, first < rows.length)
  // Each pass merges one more step; with none left the layout stands as it is.
  while (laid.isBad && first < rows.length) {
    addSpent(earlier, rows[first])
    first += 1
    laid = place(piecesOf(earlier, rows, first, live), input, barPx, ceiling, first < rows.length)
  }
  return laid.parts
}

const pctOf = (ms: number, stats: TurnStats): number => {
  const total = stats.modelMs + stats.toolMs
  return total > 0 ? Math.round((ms / total) * 100) : 0
}

// §17.1: a station's share of the station times' sum; above 0 but rounding to 0 is `<1%`.
function shareText(ms: number, total: number): string {
  const pct = total > 0 ? Math.round((ms / total) * 100) : 0
  return ms > 0 && pct === 0 ? '<1%' : `${pct}%`
}
const stepsText = (steps: number): string => `${steps} step${steps === 1 ? '' : 's'}`
// Model, then the tool stations with time, in station order.
const shownStations = (times: StationMs): StationId[] => STATION_ORDER.filter((id) => id === 'model' || times[id] > 0)
const sumOf = (times: StationMs): number => STATION_ORDER.reduce((n, id) => n + times[id], 0)

export function drawRibbon(
  input: RibbonInput, barPx: number, look: Look, stats: TurnStats, times: StationMs | null,
): { svg: string; alt: string } {
  const w = svgPx(barPx)
  const parts = ribbonSegments(input, w)
  const isMoving = look.motion === 'full'
  const elapsed = input.endMs - input.startedAt
  const ceiling = ribbonCeilingMs(elapsed, input.isLive)
  const hues = new Set<StationId>()
  let rest = ''
  let bar = ''
  let fails = ''
  let cap = ''
  for (const p of parts) {
    const hue = STATION_HUES[p.station].dark
    hues.add(p.station)
    const rect = `<rect data-part="${p.kind}" x="${p.x}" y="3" width="${p.w}" height="10" fill="${hue}"`
    if (p.kind !== 'live') {
      bar += `${rect}/>`
    } else {
      // §5.4: the part and its cap grow to the ceiling from where they are now (ruling D: no begin).
      const isGrowing = isMoving && ceiling > elapsed && w - p.x > p.w
      const dur = `dur="${num((ceiling - elapsed) / 1000)}s" fill="freeze"/>`
      bar += isGrowing ? `${rect}><animate attributeName="width" to="${w - p.x}" ${dur}</rect>` : `${rect}/>`
      const capRect = `<rect data-part="cap" x="${p.x + p.w - 1}" y="1" width="2" height="14" fill="${hue}"`
      cap = isMoving
        ? `${capRect}><animate attributeName="opacity" values="1;0.3;1" keyTimes="0;0.5;1" calcMode="spline"` +
          ` keySplines="${EASE};${EASE}" dur="${CAP_MS / 1000}s" begin="${loopBegin(input.endMs, CAP_MS)}"` +
          ` repeatCount="indefinite"/>${isGrowing ? `<animate attributeName="x" to="${w - 1}" ${dur}` : ''}</rect>`
        : `${capRect}/>`
    }
    if (p.failed) {
      fails += `<rect data-part="fail" x="${p.x}" y="14" width="${p.w}" height="2" fill="${SURFACE.fail.dark}"/>`
    }
  }
  const lastPart = parts[parts.length - 1]
  const barEnd = lastPart === undefined ? 0 : lastPart.x + lastPart.w
  if (input.isLive) {
    // §5.2: the rest of the scale, under the bar so that the growth covers it.
    if (barEnd + 2 < w) {
      rest += `<line data-part="rest" x1="${barEnd + 2}" y1="8.5" x2="${w}" y2="8.5" stroke="${SURFACE.ash.dark}"` +
        ' stroke-opacity="0.5" stroke-dasharray="1 3"/>'
    }
    rest += `<rect data-part="tick" x="${w - 1}" y="5" width="1" height="6" fill="${SURFACE.ash.dark}"/>`
  }
  const style = themeStyle(
    [...[...hues].map((id) => STATION_HUES[id]), SURFACE.ash, SURFACE.fail].map((c) => [c.dark, c.light] as const),
  )
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="16" viewBox="0 0 ${w} 16">${style}` +
    `<defs><clipPath id="bar"><rect x="0" y="3" width="${w}" height="10" rx="3"/></clipPath></defs>${rest}` +
    `<g clip-path="url(#bar)">${bar}</g>${fails}${cap}</svg>`
  // shortcut: failures folded into `earlier` past 60 steps are not counted, carry a folded count if long turns need it
  const failed = input.tools.filter((t) => t.failed).length
  // §17.7: the stations as the legend lists them; with no parts known (§17.6), Model and Tools.
  const total = times === null ? 0 : sumOf(times)
  const shares = times === null
    ? `model ${pctOf(stats.modelMs, stats)}%, tools ${pctOf(stats.toolMs, stats)}%`
    : shownStations(times).map((id) => `${STATION_LABELS[id].toLowerCase()} ${shareText(times[id], total)}`).join(', ')
  const alt = `Turn ${fmtDuration(stats.elapsedMs)}: ${shares}, ${stepsText(stats.steps)}` +
    `${failed > 0 ? `, ${failed} failed call${failed === 1 ? '' : 's'}` : ''}`
  return { svg: fitSvg(svg), alt: altText(alt) }
}

/**
 * §17.1-§17.6: the legend as rows of whole items, ` · ` (LEGEND_SEP, the caller's) between the items of a row. Model,
 * then each tool station with time, then the steps and TTFT; `times` null is the fallback (Model and Tools by pctOf).
 */
export function legendRows(
  stats: TurnStats, times: StationMs | null, cols: number, surface: 'desktop' | 'terminal',
): LegendItem[][] {
  const isDesktop = surface === 'desktop'
  const label = (id: StationId): Span => (isDesktop
    ? { text: STATION_LABELS[id], dimColor: true }
    : { text: STATION_LABELS[id], color: STATION_HUES[id].dark })
  const items: LegendItem[] = []
  if (times === null) {
    items.push(
      { station: isDesktop ? 'model' : null, spans: [label('model'), { text: ` ${pctOf(stats.modelMs, stats)}%` }] },
      { station: null, spans: [{ text: 'Tools', dimColor: true }, { text: ` ${pctOf(stats.toolMs, stats)}%` }] },
    )
  } else {
    const total = sumOf(times)
    for (const id of shownStations(times)) {
      items.push({ station: isDesktop ? id : null, spans: [label(id), { text: ` ${shareText(times[id], total)}` }] })
    }
  }
  items.push({ station: null, spans: [{ text: stepsText(stats.steps) }] })
  if (stats.ttftMs !== null) {
    items.push({ station: null, spans: [{ text: 'TTFT', dimColor: true }, { text: ` ${fmtTtft(stats.ttftMs)}` }] })
  }
  // §17.5: whole items in order, a row a time; an item wider than a row is cut to it, after its swatch's 2 cells.
  const sep = spansCells([LEGEND_SEP])
  const rows: LegendItem[][] = []
  let used = 0
  for (const item of items) {
    const swatch = item.station === null ? 0 : 2
    const spans = spansCells(item.spans) + swatch > cols ? fitRow(item.spans, cols - swatch) : item.spans
    const w = spansCells(spans) + swatch
    const row = rows[rows.length - 1]
    if (row !== undefined && used + sep + w <= cols) {
      row.push({ ...item, spans })
      used += sep + w
    } else {
      rows.push([{ ...item, spans }])
      used = w
    }
  }
  return rows
}

/**
 * §5.8's bar row: the bar in `cols − 8` cells, a space and the elapsed time in 7; never longer than `cols`. The bar
 * is drawn from the input; `elapsedMs` is only the time printed, the stats' own when the caller has them.
 */
export function ribbonTerminal(
  input: RibbonInput, cols: number, elapsedMs: number = input.endMs - input.startedAt,
): Span[] {
  const bar = Math.max(0, cols - 8)
  const elapsed = input.endMs - input.startedAt
  const ceiling = ribbonCeilingMs(elapsed, input.isLive)
  const filled = input.isLive ? Math.min(bar, Math.max(0, Math.round((elapsed / ceiling) * bar))) : bar
  const { head, rows, live } = rowsOf(input)
  let first = Math.max(0, rows.length - ribbonDetail(bar * 8))
  const earlier = { ...head }
  for (let i = 0; i < first; i += 1) addSpent(earlier, rows[i])
  let count = STATION_ORDER.filter((id) => earlier[id] > 0).length + (live === null ? 0 : 1)
  for (let i = first; i < rows.length; i += 1) count += rows[i]?.pieces.length ?? 0
  // A part a cell at least: while they outnumber the cells, the oldest detailed steps merge first.
  while (count > filled && first < rows.length) {
    const before = STATION_ORDER.filter((id) => earlier[id] > 0).length
    addSpent(earlier, rows[first])
    count += STATION_ORDER.filter((id) => earlier[id] > 0).length - before - (rows[first]?.pieces.length ?? 0)
    first += 1
  }
  const pieces = piecesOf(earlier, rows, first, live)
  // Still too many: the smallest parts get none.
  let shown = pieces
  if (pieces.length > filled) {
    const kept = new Set([...pieces].sort((a, b) => b.ms - a.ms).slice(0, filled))
    shown = pieces.filter((p) => kept.has(p))
  }
  const widths = apportion(shown.map((p) => p.ms), filled)
  const spans: Span[] = []
  shown.forEach((p, i) => {
    const n = widths[i] ?? 0
    const color = STATION_HUES[p.station].dark
    if (p.failed) {
      if (n > 1) spans.push({ text: '█'.repeat(Math.max(0, n - 1)), color })
      spans.push({ text: '✗', color: BAD })
    } else {
      spans.push({ text: '█'.repeat(Math.max(0, n)), color })
    }
  })
  if (bar > filled) spans.push({ text: '·'.repeat(Math.max(0, bar - filled)), dimColor: true })
  spans.push({ text: ' ' }, { text: padStart(fmtDuration(elapsedMs), 7) })
  return fitRow(spans, cols)
}
