// The Session band (spec §4): the context ring as the core, the eight tool stations around it on a trunk each way, and
// a pulse from the core to a station on each call. drawBand gives the desktop's Svg source, bandTerminal the
// terminal's rows. Pure: no `$`, no engine.

import { cells, cutCells, fitRow, padEnd, padStart, spansCells } from './cells'
import type { Span } from './cells'
import {
  LEFT_STATIONS, RIGHT_STATIONS, shortModel, STATION_HUES, STATION_ICONS, STATION_LABELS, STATION_ORDER,
} from './stations'
import type { StationId, StationsState } from './stations'
import { fmtPct, fmtTokens } from './stats'
import {
  altText, BAD, beginAt, clampPct, fitSvg, loopBegin, meterColor, pctColor, SURFACE, SVG_FONT, SVG_MAX_PX, svgPx,
  themeStyle, xmlText,
} from './svg'
import type { Look } from './svg'

export type BandInput = {
  pct: number | undefined; tokens: number | undefined; window: number | undefined; model: string | null
  compactions: number; stations: StationsState; running: Record<StationId, number>; nowMs: number
  isTurnRunning: boolean // main's turn runs (the view's `turn !== null`): with any station running, the core is busy
}
export type Rect = { x0: number; y0: number; x1: number; y1: number }
// `text` is never null: with no label it is the count's box.
export type BandStation = { id: StationId; cx: number; cy: number; marks: Rect; text: Rect }
export type BandLayout = {
  rows: 4 | 5; heightPx: 76 | 95; widthPx: number; offsetPx: number; xc: number; cy0: number; trunkY: number
  pitch: number; textPx: 10 | 9 | null; isStacked: boolean; core: Rect; stations: BandStation[]
}

export const BAND_PARTS_MAX = 99 // core 6 + ticks 5 + 8 stations × (8 parts + 1 pulse group + 1 ripple) + 8 lines

const SIDES = [[LEFT_STATIONS, -1], [RIGHT_STATIONS, 1]] as const
const ROWS_Y = [25.5, 68.5] as const // the two station rows of the two-row band
const RING_EDGE = 26 // the ring's r 24 and half its 4 px stroke
const FORK = 36 // the fork point's distance from the core's x
const ARC = 6 // the r 6 corners of the fork and of the pulse's T junction
const ARC_LEN = (Math.PI * ARC) / 2
const EASE = '.45 0 .55 1'
const HALO_REST_MS = 4800 // the core's halo breathes this slowly at rest
const HALO_BUSY_MS = 1600 // and this fast while main's turn or any station runs
const EASE_OUT = '.2 .6 .35 1'
const FADE_MS = 150
const FLASH_MS = 300
const RIPPLE_MS = 450 // the arrival ripple; a pulse's parts are drawn while age < dur + RIPPLE_MS
const BEAT_MS = 1400 // a running station's beat ring
const TABULAR = ' style="font-variant-numeric:tabular-nums"'
const SKIPPED_TAGS = new Set(['animate', 'animateMotion', 'set', 'title', 'style', 'tspan'])
const SHORT_LABELS: Record<StationId, string> = {
  model: 'Model', files: 'Files', shell: 'Shell', web: 'Web', agents: 'Agent', mcp: 'MCP', skills: 'Skill', you: 'You',
}

const num = (x: number): string => String(Math.round(x * 100) / 100)
const sideOf = (id: StationId): -1 | 1 => (LEFT_STATIONS.includes(id) ? -1 : 1)

// §4.2's width estimates: a capital 0.72 s, another letter 0.6 s; a count's `.` 0.3 (s + 1), any other 0.62 (s + 1).
const labelWidth = (label: string, s: number): number =>
  [...label].reduce((w, ch) => w + (ch >= 'A' && ch <= 'Z' ? 0.72 : 0.6) * s, 0)
const countWidth = (count: string, s: number): number =>
  [...count].reduce((w, ch) => w + (ch === '.' ? 0.3 : 0.62) * (s + 1), 0)
// A station's text at label size `s` (null: the count alone, at 11 px).
const textWidth = (id: StationId, count: string, s: number | null, isStacked: boolean): number => {
  const cw = countWidth(count, s ?? 10)
  const lw = s === null ? 0 : labelWidth(STATION_LABELS[id], s)
  return s === null ? cw : isStacked ? Math.max(lw, cw) : lw + 3 + cw
}

export function bandLayout(bodyPx: number, counts: Record<StationId, number>): BandLayout {
  const w = svgPx(bodyPx)
  // One row of four per side once its pitch S/4 reaches 48.
  const isStacked = w >= 464
  const pitch = ((w - 64) / 2 - 8) / (isStacked ? 4 : 2)
  // Past a 72 px pitch the Svg is a cell short of the body, so a body measured high never clips the outer text.
  const widthPx = svgPx(pitch > 72 ? w - 8 : w)
  const xc = w / 2
  const cy0 = isStacked ? 33 : 47.5
  const fits = (s: number): boolean =>
    STATION_ORDER.every((id) => textWidth(id, fmtTokens(counts[id]), s, isStacked) <= pitch - 2)
  const textPx = fits(10) ? 10 : fits(9) ? 9 : null
  const countPx = (textPx ?? 10) + 1
  const stations = SIDES.flatMap(([ids, d]) =>
    ids.map((id, n): BandStation => {
      const i = isStacked ? n : n % 2
      const cx = xc + d * (40 + pitch * (i + 0.5))
      const cy = isStacked ? cy0 : (ROWS_Y[Math.floor(n / 2)] ?? cy0)
      const half = textWidth(id, fmtTokens(counts[id]), textPx, isStacked) / 2
      // The text's box: from the cap height of its first line to the descender of its last.
      const top = textPx !== null && isStacked ? cy + 24 - 0.72 * textPx : cy + (isStacked ? 38 : 24) - 0.72 * countPx
      const bottom = cy + (isStacked ? 38 : 24) + 0.2 * countPx
      return {
        id, cx, cy, marks: { x0: cx - 14, y0: cy - 14, x1: cx + 14, y1: cy + 14 },
        text: { x0: cx - half, y0: top, x1: cx + half, y1: bottom },
      }
    }))
  return {
    rows: isStacked ? 4 : 5, heightPx: isStacked ? 76 : 95, widthPx,
    offsetPx: bodyPx > SVG_MAX_PX ? (bodyPx - widthPx) / 2 : 0,
    xc, cy0, trunkY: cy0, pitch, textPx, isStacked,
    // The ticks' r 31 around the ring, down to the tokens' descender.
    core: { x0: xc - 31, y0: cy0 - 31, x1: xc + 31, y1: cy0 + 41.2 },
    stations,
  }
}

/** §9.7's count: the parts inside the core and the stations; an icon, badge, disc or pulse group is one part. */
export function bandParts(svg: string): number {
  let parts = 0
  let hidden = 0 // the counted-as-one groups the scan is inside
  const groups: number[] = [] // per open <g>: 1 when it is counted as one
  for (const [, close, name = '', attrs = ''] of svg.matchAll(/<(\/?)(\w+)([^>]*)>/g)) {
    if (close === '/') {
      if (name === 'g') hidden -= groups.pop() ?? 0
      continue
    }
    const part = name === 'g' ? /data-part="(\w+)"/.exec(attrs)?.[1] : undefined
    const isWrapper = part === 'core' || part === 'station'
    if (hidden === 0 && name !== 'svg' && !isWrapper && !SKIPPED_TAGS.has(name)) parts += 1
    if (name === 'g') {
      const isOne = part !== undefined && !isWrapper ? 1 : 0
      groups.push(isOne)
      hidden += isOne
    }
  }
  return parts
}

const svgText = (x: number, y: number, size: number, weight: number, fill: string, body: string, isTab: boolean):
  string =>
  `<text x="${num(x)}" y="${num(y)}" text-anchor="middle" font-family="${SVG_FONT}" font-size="${size}"` +
  ` font-weight="${weight}" fill="${fill}"${isTab ? TABULAR : ''}>${body}</text>`

const tokensText = (input: BandInput, sep: string): string | null =>
  input.tokens === undefined || input.window === undefined
    ? null
    : `${fmtTokens(input.tokens)}${sep}${fmtTokens(input.window)}`

// The core's model text on both surfaces (§4.1): a name over 8 characters drops its version; one with no family is cut.
function coreModel(model: string): string {
  const short = shortModel(model)
  return cutCells(cells(short) > 8 ? (short.split(' ')[0] ?? '') : short, 8)
}

function coreSvg(input: BandInput, xc: number, cy0: number, look: Look): string {
  const p = input.pct === undefined ? 0 : clampPct(input.pct)
  const ring = `<circle cx="${num(xc)}" cy="${cy0}" r="24" fill="none"`
  const busy = input.isTurnRunning || STATION_ORDER.some((id) => input.running[id] > 0)
  // §2.2: the halo is an annulus from r 26 (the ring's outer edge) to r + width / 2, so nothing is drawn inside it.
  const isFull = look.motion === 'full'
  const halo = `<circle cx="${num(xc)}" cy="${cy0}" r="${isFull ? 26 : 27.5}" fill="none" stroke="${meterColor(p)}"` +
    ` stroke-width="${isFull ? 0 : 3}"`
  let out = `${halo} opacity="${busy ? 0.16 : 0.08}"/>`
  if (isFull) {
    const period = busy ? HALO_BUSY_MS : HALO_REST_MS
    const timing = ` keyTimes="0;0.5;1" calcMode="spline" keySplines="${EASE};${EASE}" dur="${period / 1000}s"` +
      ` begin="${loopBegin(input.nowMs, period)}" repeatCount="indefinite"`
    const loop = (name: string, values: string): string =>
      `<animate attributeName="${name}" values="${values}"${timing}/>`
    out = `${halo} opacity="0.05">${loop('r', '26;29;26')}${loop('stroke-width', '0;6;0')}` +
      `${loop('opacity', `0.05;${busy ? 0.24 : 0.12};0.05`)}</circle>`
  }
  out += `${ring} stroke="#808080" stroke-opacity="0.3" stroke-width="4"/>`
  if (p > 0) {
    out += `${ring} stroke="${meterColor(p)}" stroke-width="4" pathLength="100" stroke-dasharray="${num(p)} 100"` +
      ` transform="rotate(-90 ${num(xc)} ${cy0})"/>`
  }
  // §4.7: radial ticks from r 27.5 to r 31, the first at 12 o'clock, each next 9° clockwise; at most 5.
  for (let i = 0; i < Math.min(5, input.compactions); i += 1) {
    const a = ((-90 + 9 * i) * Math.PI) / 180
    out += `<line x1="${num(xc + 27.5 * Math.cos(a))}" y1="${num(cy0 + 27.5 * Math.sin(a))}"` +
      ` x2="${num(xc + 31 * Math.cos(a))}" y2="${num(cy0 + 31 * Math.sin(a))}" stroke="${SURFACE.ash.dark}"` +
      ' stroke-width="1.5" stroke-linecap="round"/>'
  }
  out += input.pct === undefined
    ? svgText(xc, cy0 + 4, 15, 600, SURFACE.ash.dark, '—', false)
    : svgText(xc, cy0 + 4, 15, 600, SURFACE.bone.dark, fmtPct(input.pct, 0), true)
  if (input.model !== null) {
    out += svgText(xc, cy0 + 14, 9, 400, SURFACE.ash.dark, xmlText(coreModel(input.model)), false)
  }
  out += svgText(xc, cy0 + 39, 10, 400, SURFACE.ash.dark, tokensText(input, ' / ') ?? '—', true)
  return `<g data-part="core">${out}</g>`
}

// The trunk, the forks and the rails of §4.5, in `rail`.
function railsSvg(l: BandLayout): string {
  const paths = SIDES.flatMap(([, d]) => {
    const edge = num(l.xc + RING_EDGE * d)
    const xf = l.xc + FORK * d
    const outer = num(l.xc + d * (40 + l.pitch * ((l.isStacked ? 4 : 2) - 0.5))) // the outermost station's cx
    const [y1, y2] = ROWS_Y
    return l.isStacked
      ? [`M${edge} ${l.cy0}H${outer}`]
      : [
        `M${edge} ${l.cy0}H${num(xf)}`,
        `M${num(xf + ARC * d)} ${y1}Q${num(xf)} ${y1} ${num(xf)} ${y1 + ARC}V${y2 - ARC}Q${num(xf)} ${y2}` +
          ` ${num(xf + ARC * d)} ${y2}`,
        `M${num(xf + ARC * d)} ${y1}H${outer}`,
        `M${num(xf + ARC * d)} ${y2}H${outer}`,
      ]
  })
  return paths.map((d) => `<path d="${d}" fill="none" stroke="${SURFACE.rail.dark}" stroke-width="1"/>`).join('')
}

// A pulse's path from the ring's edge to the circle's edge (§4.8), and its travel time in ms.
function pulseRoute(l: BandLayout, s: BandStation): { path: string; durMs: number } {
  const d = sideOf(s.id)
  const edge = l.xc + RING_EDGE * d
  const end = s.cx - 11 * d
  let path = `M${num(edge)} ${l.cy0}H${num(end)}`
  let len = Math.abs(end - edge)
  if (!l.isStacked) {
    const xf = l.xc + FORK * d
    const up = Math.sign(s.cy - l.cy0)
    path = `M${num(edge)} ${l.cy0}H${num(xf - ARC * d)}Q${num(xf)} ${l.cy0} ${num(xf)} ${l.cy0 + ARC * up}` +
      `V${s.cy - ARC * up}Q${num(xf)} ${s.cy} ${num(xf + ARC * d)} ${s.cy}H${num(end)}`
    len = (FORK - RING_EDGE - ARC) + ARC_LEN + (Math.abs(s.cy - l.cy0) - 2 * ARC) + ARC_LEN +
      Math.abs(end - (xf + ARC * d))
  }
  const dur = Math.min(1.4, Math.max(0.6, 0.6 * Math.sqrt(len / 240)))
  return { path, durMs: Math.round(dur * 100) * 10 }
}

// One comet rides the path (§3.1): a dot with a tail that fades to its tip, turned along the path; it shows at its
// start and fades on arrival.
function pulseSvg(id: StationId, path: string, durMs: number, age: number, hue: string): string {
  // Past its travel the comet is left out: an image drops a motion that ended before its time 0, freeze and all, and
  // the `<set>` (no end) would show the comet at the band's origin.
  const comet = age >= durMs
    ? ''
    : `<linearGradient id="pulse-${id}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${hue}"` +
      ` stop-opacity="0"/><stop offset="1" stop-color="${hue}" stop-opacity="0.7"/></linearGradient>` +
      `<g opacity="0"><set attributeName="opacity" to="1" begin="${beginAt(age)}"/>` +
      `<animateMotion path="${path}" begin="${beginAt(age)}" dur="${durMs / 1000}s" keyPoints="0;1" keyTimes="0;1"` +
      ` calcMode="spline" keySplines="${EASE_OUT}" rotate="auto" fill="freeze"/>` +
      `<animate attributeName="opacity" from="1" to="0" dur="${FADE_MS / 1000}s" begin="${beginAt(age - durMs)}"` +
      ` fill="freeze"/><path d="M0 -2.8L-14 0L0 2.8Z" fill="url(#pulse-${id})"/><circle r="3.5"/></g>`
  return `<g data-part="pulse" fill="${hue}">${comet}</g>`
}

// The arrival ripple (§3.2), linear; its static and frozen opacity 0 is the resting state.
function rippleSvg(s: BandStation, durMs: number, age: number, hue: string): string {
  const timing = `dur="${RIPPLE_MS / 1000}s" begin="${beginAt(age - durMs)}" fill="freeze"`
  return `<circle data-part="ripple" cx="${num(s.cx)}" cy="${s.cy}" r="11" fill="none" stroke="${hue}"` +
    ` stroke-width="1.5" opacity="0"><animate attributeName="r" values="11;19" ${timing}/>` +
    `<animate attributeName="opacity" values="0.7;0" ${timing}/></circle>`
}

function stationSvg(input: BandInput, l: BandLayout, s: BandStation, look: Look, flash: string): string {
  const { id, cx, cy } = s
  const hue = STATION_HUES[id].dark
  const { calls, failedThisTurn: failed } = input.stations[id]
  const running = input.running[id]
  const x = num(cx)
  let out = ''
  // §3.4: a steady halo and, under full motion, a spreading beat ring. Both lie under the circle, whose `raised` fill
  // is opaque, so only their outside shows.
  if (running > 0) {
    out += `<circle cx="${x}" cy="${cy}" r="14" fill="${hue}" opacity="0.16"/>`
    if (look.motion === 'full') {
      const timing = `dur="${BEAT_MS / 1000}s" begin="${loopBegin(input.nowMs, BEAT_MS)}" repeatCount="indefinite"`
      out += `<circle cx="${x}" cy="${cy}" r="11" fill="none" stroke="${hue}" stroke-width="1.5" opacity="0">` +
        `<animate attributeName="r" values="11;21" ${timing}/>` +
        `<animate attributeName="opacity" values="0.9;0" ${timing}/></circle>`
    }
  }
  const stroke = failed > 0 ? SURFACE.fail.dark : running > 0 ? hue : SURFACE.line.dark
  out += `<circle cx="${x}" cy="${cy}" r="11" fill="${SURFACE.raised.dark}" stroke="${stroke}"` +
    ` stroke-width="${failed > 0 || running > 0 ? 1.5 : 1}"${flash === '' ? '/>' : `>${flash}</circle>`}`
  out += `<g data-part="icon" transform="translate(${num(cx - 7)} ${num(cy - 7)})" fill="none" stroke="${hue}"` +
    ` stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"${calls === 0 ? ' opacity="0.45"' : ''}>` +
    `${STATION_ICONS[id]}</g>`
  // Badge and disc keep their corners on both sides (no mirroring).
  if (running >= 2) {
    out += `<g data-part="badge"><circle cx="${num(cx + 8)}" cy="${cy - 8}" r="6" fill="${SURFACE.raised.dark}"` +
      ` stroke="${hue}" stroke-width="1"/>` +
      `${svgText(cx + 8, cy - 5, 8, 700, SURFACE.bone.dark, running >= 10 ? '×9+' : `×${running}`, true)}</g>`
  }
  if (failed > 0) {
    out += `<g data-part="disc"><circle cx="${num(cx - 8)}" cy="${cy - 8}" r="5.5" fill="${SURFACE.fail.dark}"/>` +
      `${svgText(cx - 8, cy - 5, 8, 700, SURFACE.raised.dark, failed >= 10 ? '9+' : String(failed), true)}</g>`
  }
  const size = l.textPx
  const label = STATION_LABELS[id]
  const count = fmtTokens(calls)
  const labelFill = calls > 0 && (running > 0 || failed > 0) ? SURFACE.bone.dark : SURFACE.ash.dark
  const countFill = calls > 0 ? SURFACE.bone.dark : SURFACE.ash.dark
  const countPx = (size ?? 10) + 1
  if (l.isStacked) {
    if (size !== null) out += svgText(cx, cy + 24, size, 500, labelFill, label, false)
    out += svgText(cx, cy + 38, countPx, 600, countFill, count, true)
  } else {
    const labelSpan = size === null
      ? ''
      : `<tspan font-size="${size}" font-weight="500" fill="${labelFill}">${label}</tspan>`
    out += `<text x="${x}" y="${cy + 24}" text-anchor="middle" font-family="${SVG_FONT}">${labelSpan}` +
      `<tspan${size === null ? '' : ' dx="3"'} font-size="${countPx}" font-weight="600" fill="${countFill}"` +
      `${TABULAR}>${count}</tspan></text>`
  }
  return `<g data-part="station">${out}</g>`
}

// §4.9, in station order.
function bandAlt(input: BandInput): string {
  const core = [input.pct === undefined ? 'Context —' : `Context ${fmtPct(input.pct, 0)}`]
  const tokens = tokensText(input, ' of ')
  if (tokens !== null) core.push(tokens)
  if (input.model !== null) core.push(shortModel(input.model))
  if (input.compactions > 0) core.push(`${input.compactions} compaction${input.compactions === 1 ? '' : 's'}`)
  const stations = STATION_ORDER.map((id) => {
    const { calls, failedThisTurn } = input.stations[id]
    const running = input.running[id]
    return [
      `${STATION_LABELS[id]} ${calls}`,
      ...(running > 0 ? [`${running} running`] : []),
      ...(failedThisTurn > 0 ? [`${failedThisTurn} failed this turn`] : []),
    ].join(', ')
  })
  return altText(`${core.join(', ')}. ${stations.join('; ')}.`)
}

export function drawBand(input: BandInput, bodyPx: number, look: Look):
  { svg: string; widthPx: number; heightPx: number; rows: 4 | 5; offsetPx: number; alt: string } {
  const counts = Object.fromEntries(STATION_ORDER.map((id) => [id, input.stations[id].calls])) as
    Record<StationId, number>
  const l = bandLayout(bodyPx, counts)
  let pulses = ''
  let stations = ''
  for (const s of l.stations) {
    const { path, durMs } = pulseRoute(l, s)
    const at = input.stations[s.id].lastCallAt
    const age = at === null ? Infinity : input.nowMs - at
    // A pulse lives through its travel and the ripple, which outlasts the fade and the flash (§3.3); `reduced` draws
    // none.
    const isDue = look.motion === 'full' && age < durMs + RIPPLE_MS
    let flash = ''
    if (isDue) {
      const hue = STATION_HUES[s.id].dark
      pulses += pulseSvg(s.id, path, durMs, age, hue) + rippleSvg(s, durMs, age, hue)
      flash = '<animate attributeName="stroke-width" values="1.25;2.25;1.25" keyTimes="0;0.5;1" calcMode="spline"' +
        ` keySplines="${EASE_OUT};${EASE_OUT}" dur="${FLASH_MS / 1000}s" begin="${beginAt(age - durMs)}"/>`
    }
    stations += stationSvg(input, l, s, look, flash)
  }
  const style = themeStyle(
    [...Object.values(SURFACE), ...Object.values(STATION_HUES)].map((c) => [c.dark, c.light] as const),
  )
  const w = num(l.widthPx)
  // Z-order (§4.1): core, trunk/fork/rails, pulses and ripples, then each station's halo, beat ring, circle, icon,
  // badge, disc, text.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${l.heightPx}"` +
    ` viewBox="0 0 ${w} ${l.heightPx}">${style}${coreSvg(input, l.xc, l.cy0, look)}${railsSvg(l)}${pulses}` +
    `${stations}</svg>`
  return {
    svg: fitSvg(svg), widthPx: l.widthPx, heightPx: l.heightPx, rows: l.rows, offsetPx: l.offsetPx,
    alt: bandAlt(input),
  }
}

// shortcut: counts from 100k read 99k, widen the cell if sessions reach that
const countCell = (n: number): string => (n < 1000 ? String(n) : `${Math.min(99, Math.floor(n / 1000))}k`)

// A station's cell of §4.10: full (14 cells) or compact (10).
function stationCell(input: BandInput, id: StationId, isFull: boolean): Span[] {
  const hue = STATION_HUES[id].dark
  const { calls, failedThisTurn: failed } = input.stations[id]
  const running = input.running[id]
  const mark: Span = running > 0 ? { text: '●', color: hue } : { text: '·', dimColor: true }
  const countText = padStart(countCell(calls), 3)
  const count: Span = calls === 0 ? { text: countText, dimColor: true } : { text: countText }
  let badge: Span = { text: isFull ? '  ' : ' ' }
  if (failed > 0) badge = { text: isFull ? `!${Math.min(9, failed)}` : '!', color: BAD }
  else if (running >= 2) badge = { text: isFull ? `×${Math.min(9, running)}` : '×', color: hue }
  return isFull
    ? [mark, { text: ' ' }, { text: padEnd(STATION_LABELS[id], 6), color: hue }, count, { text: ' ' }, badge]
    : [mark, { text: padEnd(SHORT_LABELS[id], 5), color: hue }, count, badge]
}

/** §4.10: the core line, then the stations' grid. */
export function bandTerminal(input: BandInput, cols: number): Span[][] {
  const pct = input.pct
  const filled = pct === undefined ? 0 : Math.round(clampPct(pct) / 10)
  const left: Span[] = [
    { text: input.model === null ? '—' : coreModel(input.model) },
    { text: '  ' },
    { text: '▰'.repeat(filled), color: meterColor(pct ?? 0) },
    { text: '▱'.repeat(10 - filled), dimColor: true },
    { text: '  ' },
    pct === undefined ? { text: '—' } : { text: fmtPct(pct, 0), color: pctColor(pct) },
  ]
  // ↻N is left out at 0 compactions and at 40-43 columns.
  const loop = input.compactions > 0 && cols >= 44 ? ` ↻${input.compactions}` : ''
  const right: Span[] = [{ text: `${tokensText(input, ' / ') ?? '—'}${loop}`, dimColor: true }]
  const gap = Math.max(0, cols - spansCells(left) - spansCells(right))
  const rows: Span[][] = [[...left, { text: ' '.repeat(gap) }, ...right]]
  const isFull = cols >= 59
  const perRow = cols >= 119 ? 8 : cols >= 43 ? 4 : 3
  for (let i = 0; i < STATION_ORDER.length; i += perRow) {
    rows.push(STATION_ORDER.slice(i, i + perRow).flatMap((id, n) => [
      ...(n > 0 ? [{ text: ' ' }] : []),
      ...stationCell(input, id, isFull),
    ]))
  }
  return rows.map((row) => fitRow(row, cols))
}
