import { test, expect } from 'claude-code/testing'
import { BAND_PARTS_MAX, bandLayout, bandParts, bandTerminal, drawBand } from './band'
import type { BandInput, Rect } from './band'
import { STATION_HUES, STATION_ORDER } from './stations'
import type { StationId, StationTally } from './stations'
import { beginAt, loopBegin, SVG_MAX_PX, SVG_SOURCE_MAX } from './svg'

const NOW = 1_000_000_000
const FULL = { motion: 'full' as const }
const tally = (calls: number, failedThisTurn = 0, lastCallAt: number | null = null): StationTally => ({
  calls, failedThisTurn, lastCallAt,
})
const each = <T>(f: (id: StationId) => T): Record<StationId, T> =>
  Object.fromEntries(STATION_ORDER.map((id) => [id, f(id)])) as Record<StationId, T>

// §2.3's session.
const EXAMPLE: BandInput = {
  pct: 56, tokens: 112_000, window: 200_000, model: 'claude-opus-5-5', compactions: 1,
  stations: {
    model: tally(31), files: tally(12), shell: tally(4, 1), web: tally(1),
    agents: tally(5), mcp: tally(3), skills: tally(6), you: tally(3),
  },
  running: { model: 3, files: 0, shell: 1, web: 0, agents: 2, mcp: 0, skills: 0, you: 0 },
  nowMs: NOW, isTurnRunning: false,
}
// Every count, every station running and failing, every pulse in flight.
const CAPS: BandInput = {
  pct: 100, tokens: 1_000_000, window: 1_000_000, model: 'claude-opus-5-5', compactions: 50,
  stations: each(() => tally(99_999, 12, NOW - 10)),
  running: each(() => 12),
  nowMs: NOW, isTurnRunning: false,
}
const EMPTY: BandInput = {
  pct: undefined, tokens: undefined, window: undefined, model: null, compactions: 0,
  stations: each(() => tally(0)), running: each(() => 0), nowMs: NOW, isTurnRunning: false,
}
// Nothing runs at any station, the rest of EXAMPLE's session.
const REST: BandInput = { ...EXAMPLE, running: each(() => 0) }
const NO_PULSE: BandInput = { ...CAPS, stations: each(() => tally(99_999, 12, null)) }
const withStation = (input: BandInput, id: StationId, t: StationTally): BandInput => ({
  ...input, stations: { ...input.stations, [id]: t },
})
const counts = (input: BandInput): Record<StationId, number> => each((id) => input.stations[id].calls)
const textOf = (rows: { text: string }[][]): string[] => rows.map((r) => r.map((s) => s.text).join('').trimEnd())
const occurrences = (s: string, part: string): number => s.split(part).length - 1

const WIDTHS = [268, 328, 418, 464, 868, 3368, 4096, 4104, 5000]

test('the layout at every body width: the rows, the width, the trunk on the ring\'s centre line', () => {
  const layouts = WIDTHS.map((w) => bandLayout(w, counts(EXAMPLE)))
  expect(layouts.map((l) => l.rows)).toEqual([5, 5, 5, 4, 4, 4, 4, 4, 4])
  expect(layouts.map((l) => l.heightPx)).toEqual([95, 95, 95, 76, 76, 76, 76, 76, 76])
  expect(layouts.map((l) => l.widthPx)).toEqual([268, 328, 410, 464, 860, 3360, 4088, 4088, 4088])
  expect(layouts.map((l) => l.offsetPx)).toEqual([0, 0, 0, 0, 0, 0, 0, 8, 456])
  for (const l of layouts) {
    expect(l.trunkY).toBe(l.cy0)
    expect(l.cy0).toBe(l.rows === 5 ? 47.5 : 33)
  }
})

test('the worked geometry of §4.3', () => {
  const cxOf = (w: number): number[] => bandLayout(w, counts(EXAMPLE)).stations.map((s) => s.cx)
  const at328 = bandLayout(328, counts(EXAMPLE))
  expect(at328.xc).toBe(164)
  expect(at328.pitch).toBe(62)
  expect(at328.stations.map((s) => s.id)).toEqual(STATION_ORDER)
  expect(cxOf(328)).toEqual([93, 31, 93, 31, 235, 297, 235, 297])
  expect(at328.stations.map((s) => s.cy)).toEqual([25.5, 25.5, 68.5, 68.5, 25.5, 25.5, 68.5, 68.5])
  expect(at328.textPx).toBe(10)
  expect(at328.isStacked).toBe(false)
  const at268 = bandLayout(268, counts(EXAMPLE))
  expect(at268.pitch).toBe(47)
  expect(at268.textPx).toBe(9)
  expect(cxOf(418)).toEqual([126.75, 42.25, 126.75, 42.25, 291.25, 375.75, 291.25, 375.75])
  const at868 = bandLayout(868, counts(EXAMPLE))
  expect(cxOf(868)).toEqual([344.75, 246.25, 147.75, 49.25, 523.25, 621.75, 720.25, 818.75])
  expect(at868.textPx).toBe(10)
  expect(at868.isStacked).toBe(true)
  expect(at868.stations.every((s) => s.cy === 33)).toBe(true)
  expect(cxOf(3368)).toEqual([1438.5, 1027.5, 616.5, 205.5, 1929.5, 2340.5, 2751.5, 3162.5])
  expect({ ...bandLayout(5000, counts(EXAMPLE)), offsetPx: 0 }).toEqual(bandLayout(4096, counts(EXAMPLE)))
})

test('no two boxes overlap and every station is inside the band', () => {
  const overlap = (a: Rect, b: Rect): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
  for (const w of WIDTHS) {
    const l = bandLayout(w, counts(EXAMPLE))
    const boxes: Rect[] = [l.core, ...l.stations.flatMap((s) => [s.marks, s.text])]
    expect(boxes.length).toBe(17)
    for (const [i, a] of boxes.entries()) {
      expect(a.x0 >= 0 && a.y0 >= 0 && a.x1 <= l.widthPx && a.y1 <= l.heightPx).toBe(true)
      for (const b of boxes.slice(i + 1)) expect(overlap(a, b)).toBe(false)
    }
  }
})

test('the label rule picks 10, then 9, then none', () => {
  expect(bandLayout(328, counts(EXAMPLE)).textPx).toBe(10)
  expect(bandLayout(268, counts(EXAMPLE)).textPx).toBe(9)
  const huge = each(() => 999_999)
  expect(bandLayout(268, huge).textPx).toBeNull()
  const input: BandInput = { ...EXAMPLE, stations: each(() => tally(999_999)) }
  const { svg } = drawBand(input, 268, FULL)
  expect(occurrences(svg, '>1M</tspan>')).toBe(8)
  expect(svg).not.toContain('>Model<')
})

test('a window that is no number draws —, never Infinity', () => {
  const input: BandInput = { ...EXAMPLE, pct: 0, tokens: 50_000, window: Infinity }
  const band = drawBand(input, 328, FULL)
  expect(band.svg).toContain('>50k / —<')
  expect(band.alt).toContain('50k of —')
  expect(band.svg).not.toContain('Infinity')
  expect(band.alt).not.toContain('Infinity')
  expect(textOf(bandTerminal(input, 80)).join('\n')).toContain('50k / —')
})

test('the paths of §4.3 at 328 and 868', () => {
  const at328 = drawBand(EXAMPLE, 328, FULL).svg
  for (const d of [
    'M138 47.5H128', 'M190 47.5H200', 'M122 25.5Q128 25.5 128 31.5V62.5Q128 68.5 122 68.5',
    'M206 25.5Q200 25.5 200 31.5V62.5Q200 68.5 206 68.5', 'M122 25.5H31', 'M206 68.5H297',
  ]) expect(at328).toContain(`d="${d}"`)
  const at868 = drawBand(EXAMPLE, 868, FULL).svg
  expect(at868).toContain('d="M408 33H49.25"')
  expect(at868).toContain('d="M460 33H818.75"')
})

test('the pulse durations follow §4.8', () => {
  const due = each(() => tally(1, 0, NOW - 10))
  const input: BandInput = { ...EXAMPLE, stations: due }
  const at328 = drawBand(input, 328, FULL).svg
  expect(at328).toContain(
    '<animateMotion path="M138 47.5H134Q128 47.5 128 41.5V31.5Q128 25.5 122 25.5H104" begin="-0.010s" dur="0.6s"',
  )
  expect(drawBand(input, 868, FULL).svg).toContain('<animateMotion path="M460 33H807.75" begin="-0.010s" dur="0.72s"')
  expect(drawBand(input, 3368, FULL).svg).toContain(
    '<animateMotion path="M1710 33H3151.5" begin="-0.010s" dur="1.4s"',
  )
  expect(at328).toMatch(/<animate attributeName="opacity" from="1" to="0" dur="0\.15s" begin="[^"]+" fill="freeze"\/>/)
})

test('a pulse is drawn while its age is below its lifetime, with begin −age', () => {
  const shellPath = 'M138 47.5H134Q128 47.5 128 53.5V62.5Q128 68.5 122 68.5H104'
  const shell = drawBand(withStation(EXAMPLE, 'shell', tally(4, 1, NOW - 100)), 328, FULL).svg
  expect(shell).toContain(`<animateMotion path="${shellPath}" begin="-0.100s"`)
  // Model at 328 travels 0.6 s: its lifetime is 600 + 450 ms (the ripple).
  const modelAt = (age: number): string =>
    drawBand(withStation(EXAMPLE, 'model', tally(31, 0, NOW - age)), 328, FULL).svg
  expect(modelAt(1049)).toContain('data-part="pulse"')
  expect(modelAt(1050)).not.toContain('data-part="pulse"')
  expect(modelAt(5000)).not.toContain('data-part="pulse"')
  expect(drawBand(EXAMPLE, 328, FULL).svg).not.toContain('<animateMotion')
  expect(shell).toContain(`dur="1.4s" begin="${loopBegin(NOW, 1400)}"`)
  expect(shell).not.toContain('begin="0s"')
})

// Shell at 328 travels 600 ms from the ring's edge to its circle at (93, 68.5); its dark hue is #b8beff.
const SHELL_AT = (age: number): string => drawBand(withStation(EXAMPLE, 'shell', tally(4, 1, NOW - age)), 328, FULL).svg

test('a due pulse is one comet with a tail', () => {
  expect(SHELL_AT(100)).toContain(
    '<g data-part="pulse" fill="#b8beff"><linearGradient id="pulse-shell" x1="0" y1="0" x2="1" y2="0">' +
      '<stop offset="0" stop-color="#b8beff" stop-opacity="0"/><stop offset="1" stop-color="#b8beff"' +
      ' stop-opacity="0.7"/></linearGradient><g opacity="0"><set attributeName="opacity" to="1" begin="-0.100s"/>' +
      '<animateMotion path="M138 47.5H134Q128 47.5 128 53.5V62.5Q128 68.5 122 68.5H104" begin="-0.100s" dur="0.6s"' +
      ' keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines=".2 .6 .35 1" rotate="auto" fill="freeze"/>' +
      `<animate attributeName="opacity" from="1" to="0" dur="0.15s" begin="${beginAt(100 - 600)}" fill="freeze"/>` +
      '<path d="M0 -2.8L-14 0L0 2.8Z" fill="url(#pulse-shell)"/><circle r="3.5"/></g></g>',
  )
  // One gradient per station, each id unique in the Svg.
  const ids = [...drawBand(CAPS, 328, FULL).svg.matchAll(/ id="(pulse-[^"]*)"/g)].map(([, id]) => id)
  expect(ids).toEqual(STATION_ORDER.map((id) => `pulse-${id}`))
})

test('a pulse past its travel draws its group empty', () => {
  // At 700 ms Shell is past its travel and still inside its lifetime of 1050 ms.
  const svg = SHELL_AT(700)
  expect(svg).toContain('<g data-part="pulse" fill="#b8beff"></g>')
  expect(svg).not.toContain('r="3.5"')
  expect(svg).not.toContain('linearGradient')
})

test('a ripple spreads at the arrival', () => {
  const ripple = '<circle data-part="ripple" cx="93" cy="68.5" r="11" fill="none" stroke="#b8beff" stroke-width="1.5"' +
    ' opacity="0"><animate attributeName="r" values="11;19" dur="0.45s" begin="-0.100s" fill="freeze"/>' +
    '<animate attributeName="opacity" values="0.7;0" dur="0.45s" begin="-0.100s" fill="freeze"/></circle>'
  const svg = SHELL_AT(700)
  expect(svg).toContain(ripple)
  // In the pulses layer, under every station.
  expect(svg.indexOf(ripple)).toBeLessThan(svg.indexOf('data-part="station"'))
  expect(SHELL_AT(1049)).toContain('data-part="ripple"')
  expect(SHELL_AT(1050)).not.toContain('data-part="ripple"')
})

test('the arrival flash keeps 0.7.0\'s values and timing', () => {
  const circle = '<circle cx="93" cy="68.5" r="11" fill="#2e2d2b" stroke="#e5484d" stroke-width="1.5"'
  expect(SHELL_AT(700)).toContain(
    `${circle}><animate attributeName="stroke-width" values="1.25;2.25;1.25" keyTimes="0;0.5;1" calcMode="spline"` +
      ' keySplines=".2 .6 .35 1;.2 .6 .35 1" dur="0.3s" begin="-0.100s"/></circle>',
  )
  expect(SHELL_AT(1050)).toContain(`${circle}/>`)
  expect(SHELL_AT(1050)).not.toContain('values="1.25;2.25;1.25"')
})

test('a running station has a steady halo and a beat ring, and no glow', () => {
  const svg = drawBand(EXAMPLE, 328, FULL).svg
  const beat = (hue: string, cy: number): string =>
    `<circle cx="93" cy="${cy}" r="14" fill="${hue}" opacity="0.16"/><circle cx="93" cy="${cy}" r="11" fill="none"` +
    ` stroke="${hue}" stroke-width="1.5" opacity="0"><animate attributeName="r" values="11;21" dur="1.4s"` +
    ` begin="${loopBegin(NOW, 1400)}" repeatCount="indefinite"/><animate attributeName="opacity" values="0.9;0"` +
    ` dur="1.4s" begin="${loopBegin(NOW, 1400)}" repeatCount="indefinite"/></circle>`
  // The station groups in station order: Model, Files, Shell, …
  const [model = '', files = '', shell = ''] = svg.split('<g data-part="station">').slice(1)
  expect(model.startsWith(`${beat('#df995e', 25.5)}<circle cx="93" cy="25.5" r="11" fill="#2e2d2b"`)).toBe(true)
  expect(files).not.toContain('r="14"')
  expect(files).not.toContain('values="11;21"')
  // Shell runs and failed: both, in its hue, and the circle's stroke stays the failure's.
  expect(shell.startsWith(`${beat('#b8beff', 68.5)}<circle cx="93" cy="68.5" r="11" fill="#2e2d2b"` +
    ' stroke="#e5484d"')).toBe(true)
  for (const input of [EXAMPLE, CAPS, EMPTY, REST, NO_PULSE]) {
    for (const w of WIDTHS) expect(drawBand(input, w, FULL).svg).not.toContain('0.12;0.24;0.12')
  }
})

test('every animateMotion drawn still runs at the image\'s time 0', () => {
  let seen = 0
  for (const w of [328, 868, 3368]) {
    for (let age = 0; age <= 1850; age += 25) {
      const input: BandInput = { ...EXAMPLE, stations: each((id) => tally(EXAMPLE.stations[id].calls, 0, NOW - age)) }
      const svg = drawBand(input, w, FULL).svg
      for (const [, begin, dur] of svg.matchAll(/<animateMotion [^>]*begin="(-?[\d.]+)s" dur="([\d.]+)s"/g)) {
        seen += 1
        expect(-Number(begin)).toBeLessThan(Number(dur))
      }
    }
  }
  expect(seen).toBeGreaterThan(0)
})

test('motion reduced draws no animation', () => {
  const due = withStation(EXAMPLE, 'model', tally(31, 0, NOW - 10))
  const { svg } = drawBand(due, 328, { motion: 'reduced' })
  expect(svg).not.toContain('<animate')
  expect(svg).not.toContain('<animateMotion')
  expect(svg).not.toContain('<set')
  expect(svg).toContain('<circle cx="93" cy="25.5" r="14" fill="#df995e" opacity="0.16"/>')
  expect(svg).not.toContain('values="11;21"')
  expect(svg).not.toContain('data-part="ripple"')
  expect(svg).not.toContain('r="3.5"')
  // The core's steady halo: busy, as Model runs.
  expect(svg).toContain(
    '<circle cx="164" cy="47.5" r="27.5" fill="none" stroke="#2f7de1" stroke-width="3" opacity="0.16"/>',
  )
})

test('the parts are bounded for every input and the source is under the cap', () => {
  for (const input of [EXAMPLE, CAPS, EMPTY, NO_PULSE]) {
    for (const w of [268, 464, 3368]) {
      const band = drawBand(input, w, FULL)
      expect(bandParts(band.svg)).toBeLessThanOrEqual(BAND_PARTS_MAX)
      expect(band.svg.length).toBeLessThan(SVG_SOURCE_MAX)
      expect(band.widthPx >= 1 && band.widthPx <= SVG_MAX_PX).toBe(true)
      expect(band.heightPx >= 1 && band.heightPx <= SVG_MAX_PX).toBe(true)
    }
  }
  // CAPS at 268, two rows with no labels: core 6, ticks 5, 8 lines, and per station a halo, a beat ring, a circle, an
  // icon, a badge, a disc, a count, a pulse group and a ripple.
  expect(bandParts(drawBand(CAPS, 268, FULL).svg)).toBe(91)
  expect(BAND_PARTS_MAX).toBe(99)
})

// The core group holds no nested `<g>`.
const coreOf = (svg: string): string => /<g data-part="core">(.*?)<\/g>/.exec(svg)?.[1] ?? ''
// The halo's loop: spline easing on both halves, phase-locked to the clock.
const T = (ms: number): string =>
  ` keyTimes="0;0.5;1" calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1" dur="${ms / 1000}s"` +
  ` begin="${loopBegin(NOW, ms)}" repeatCount="indefinite"`
const haloOf = (peak: string, ms: number, stroke = '#2f7de1'): string =>
  `<circle cx="164" cy="47.5" r="26" fill="none" stroke="${stroke}" stroke-width="0" opacity="0.05">` +
  `<animate attributeName="r" values="26;29;26"${T(ms)}/>` +
  `<animate attributeName="stroke-width" values="0;6;0"${T(ms)}/>` +
  `<animate attributeName="opacity" values="0.05;${peak};0.05"${T(ms)}/></circle>`

test('the core breathes at rest: one halo outside the ring, every 4.8 s', () => {
  const core = coreOf(drawBand(REST, 328, FULL).svg)
  expect(core.startsWith(haloOf('0.12', 4800))).toBe(true)
  expect(occurrences(core, 'r="26"')).toBe(1)
})

test('the core breathes faster while busy, either way', () => {
  for (const input of [EXAMPLE, { ...REST, isTurnRunning: true }]) {
    expect(coreOf(drawBand(input, 328, FULL).svg).startsWith(haloOf('0.24', 1600))).toBe(true)
  }
})

test('nothing of the core but the track and the arc lies inside r 26', () => {
  for (const input of [REST, EXAMPLE]) {
    const circles = [...coreOf(drawBand(input, 328, FULL).svg).matchAll(/<circle [^>]*>/g)].map(([c]) => c)
    expect(circles.every((c) => c.includes('fill="none"'))).toBe(true)
    // The halo and the ring's two circles: the track and the arc are the two of r 24.
    expect(circles.filter((c) => c.includes('r="24"'))).toHaveLength(2)
    const halo = coreOf(drawBand(input, 328, FULL).svg)
    const values = (attr: string): number[] =>
      (new RegExp(`attributeName="${attr}" values="([^"]*)"`).exec(halo)?.[1] ?? '').split(';').map(Number)
    const [r, width] = [values('r'), values('stroke-width')]
    expect(r).toHaveLength(3)
    expect(r.map((v, i) => v - (width[i] ?? NaN) / 2)).toEqual([26, 26, 26])
  }
})

test('the halo takes the arc\'s colour', () => {
  const colours = [[79, '#2f7de1'], [80, '#e0a030'], [95, '#e5484d'], [undefined, '#2f7de1']] as const
  for (const [pct, colour] of colours) {
    const core = coreOf(drawBand({ ...REST, pct }, 328, FULL).svg)
    expect(/^<circle [^>]*stroke="([^"]*)"/.exec(core)?.[1], `${pct}`).toBe(colour)
  }
})

test('motion reduced: a steady halo, no breath', () => {
  const halo = (op: string): string =>
    `<circle cx="164" cy="47.5" r="27.5" fill="none" stroke="#2f7de1" stroke-width="3" opacity="${op}"/>`
  for (const [input, op] of [[REST, '0.08'], [EXAMPLE, '0.16']] as const) {
    const core = coreOf(drawBand(input, 328, { motion: 'reduced' }).svg)
    expect(core.startsWith(halo(op))).toBe(true)
    expect(core).not.toContain('<animate')
  }
})

test('the halo stays inside the band at both heights', () => {
  for (const w of [328, 868]) {
    const band = drawBand(REST, w, FULL)
    const cy = Number(/^<circle cx="[\d.]+" cy="([\d.]+)"/.exec(coreOf(band.svg))?.[1])
    expect(cy - 32, `${w}`).toBeGreaterThanOrEqual(0)
    expect(cy + 32, `${w}`).toBeLessThanOrEqual(band.heightPx)
  }
})

test('the states of §4.6', () => {
  const svg = drawBand(EXAMPLE, 328, FULL).svg
  expect(svg).toContain('<circle cx="93" cy="25.5" r="11" fill="#2e2d2b" stroke="#df995e" stroke-width="1.5"')
  expect(svg).toContain('>×3</text>')
  expect(svg).toContain('<circle cx="93" cy="68.5" r="11" fill="#2e2d2b" stroke="#e5484d" stroke-width="1.5"')
  expect(svg).toMatch(/<g data-part="disc"><circle cx="85" cy="60\.5" r="5\.5" fill="#e5484d"\/><text [^>]*>1<\/text>/)
  expect(svg).toContain('<circle cx="31" cy="25.5" r="11" fill="#2e2d2b" stroke="#45443f" stroke-width="1"')
  expect(svg).not.toContain('opacity="0.45"')
  const dim = drawBand(withStation(EXAMPLE, 'web', tally(0)), 328, FULL).svg
  expect(dim).toMatch(/<g data-part="icon" transform="translate\(24 61\.5\)"[^>]* opacity="0\.45"/)
  const ten = drawBand({ ...EXAMPLE, running: { ...EXAMPLE.running, agents: 10 } }, 328, FULL).svg
  expect(ten).toContain('>×9+</text>')
  expect(drawBand(withStation(EXAMPLE, 'files', tally(12, 10)), 328, FULL).svg).toContain('>9+</text>')
  const none = drawBand({ ...EXAMPLE, pct: undefined, tokens: undefined, window: undefined }, 328, FULL).svg
  expect(occurrences(none, 'r="24"')).toBe(1)
  expect(occurrences(none, '>—</text>')).toBe(2)
  expect(drawBand({ ...EXAMPLE, pct: 80 }, 328, FULL).svg).toContain('r="24" fill="none" stroke="#e0a030"')
  expect(drawBand({ ...EXAMPLE, pct: 95 }, 328, FULL).svg).toContain('r="24" fill="none" stroke="#e5484d"')
  expect(occurrences(svg, '<line ')).toBe(1)
  expect(occurrences(drawBand({ ...EXAMPLE, compactions: 6 }, 328, FULL).svg, '<line ')).toBe(5)
  expect(svg).toContain(`[stroke="${STATION_HUES.shell.dark}"]{stroke:${STATION_HUES.shell.light}}`)
})

// The ring's arc (the Context ring's test before the band): a track, and an arc of the percent from 12 o'clock,
// clockwise, in the colour of the meter; the track alone at 0 and below; held on the full circle past 100.
test('the core ring: an arc of the percent from 12 o\'clock, the track alone at 0, held at 100', () => {
  const ring = (pct: number): string[] =>
    drawBand({ ...EXAMPLE, pct }, 328, FULL).svg.match(/<circle cx="164" cy="47\.5" r="24"[^>]*\/>/g) ?? []
  const track = '<circle cx="164" cy="47.5" r="24" fill="none" stroke="#808080" stroke-opacity="0.3" stroke-width="4"/>'
  const arc = (dash: string, colour: string): string =>
    `<circle cx="164" cy="47.5" r="24" fill="none" stroke="${colour}" stroke-width="4" pathLength="100"` +
    ` stroke-dasharray="${dash} 100" transform="rotate(-90 164 47.5)"/>`

  // 12.8 of a path 100 long, turned a quarter back so it starts at the top.
  expect(ring(12.8)).toEqual([track, arc('12.8', '#2f7de1')])
  for (const pct of [0, -3]) expect(ring(pct), String(pct)).toEqual([track])
  expect(ring(250)).toEqual([track, arc('100', '#e5484d')])
})

test('the alt of §4.9, and no titles', () => {
  const band = drawBand(EXAMPLE, 328, FULL)
  expect(band.alt).toBe(
    'Context 56%, 112k of 200k, opus 5.5, 1 compaction. Model 31, 3 running; Files 12; Shell 4, 1 running, 1 failed' +
      ' this turn; Web 1; Agents 5, 2 running; MCP 3; Skills 6; You 3.',
  )
  expect(band.svg).not.toContain('<title')
  const odd = drawBand({ ...EXAMPLE, model: '<&"\'>\u{1}' }, 328, FULL)
  expect(odd.alt).toContain('<&"\'>,')
  expect(odd.alt).not.toContain('\u{1}')
  expect(odd.svg).toContain('&lt;&amp;&quot;&#39;&gt;')
  expect(odd.svg).not.toContain('<&"\'')
  expect(odd.svg).not.toContain('\u{1}')
  expect(odd.svg).not.toContain('<title')
})

test('the terminal strings at 44 and 60 columns', () => {
  const at44 = bandTerminal(EXAMPLE, 44)
  expect(textOf(at44)).toEqual([
    'opus 5.5  ▰▰▰▰▰▰▱▱▱▱  56%     112k / 200k ↻1',
    '●Model 31× ·Files 12  ●Shell  4! ·Web    1',
    '●Agent  5× ·MCP    3  ·Skill  6  ·You    3',
  ])
  expect(textOf(bandTerminal(EXAMPLE, 60))).toEqual([
    `opus 5.5  ▰▰▰▰▰▰▱▱▱▱  56%${' '.repeat(21)}112k / 200k ↻1`,
    '● Model  31 ×3 · Files  12    ● Shell   4 !1 · Web     1',
    '● Agents  5 ×2 · MCP     3    · Skills  6    · You     3',
  ])
  const row = at44[1] ?? []
  const shell = row.findIndex((s) => s.text === 'Shell')
  expect(row.slice(shell - 1, shell + 3)).toEqual([
    { text: '●', color: STATION_HUES.shell.dark },
    { text: 'Shell', color: STATION_HUES.shell.dark },
    { text: '  4' },
    { text: '!', color: 'error' },
  ])
})

test('the terminal core line drops ↻N at 40-43 columns and reads — with no context', () => {
  const at40 = textOf(bandTerminal(EXAMPLE, 40))[0]
  expect(at40).toBe('opus 5.5  ▰▰▰▰▰▰▱▱▱▱  56%    112k / 200k')
  expect([...(at40 ?? '')].length).toBe(40)
  expect(textOf(bandTerminal(EXAMPLE, 43))[0]).not.toContain('↻')
  expect(textOf(bandTerminal(EXAMPLE, 44))[0]).toContain('↻1')
  const none = bandTerminal({ ...EXAMPLE, pct: undefined, tokens: undefined, window: undefined }, 40)[0] ?? []
  expect(textOf([none])[0]).toBe(`opus 5.5  ▱▱▱▱▱▱▱▱▱▱  —${' '.repeat(16)}—`)
  expect(none).toContainEqual({ text: '▱▱▱▱▱▱▱▱▱▱', dimColor: true })
  const qwen = textOf(bandTerminal({ ...EXAMPLE, model: 'qwen2.5-coder:32b' }, 40))[0] ?? ''
  expect(qwen.startsWith('qwen2.5…  ')).toBe(true)
  expect([...qwen].length).toBeLessThanOrEqual(40)
  expect(textOf(bandTerminal({ ...EXAMPLE, model: null }, 40))[0]?.startsWith('—  ▰')).toBe(true)
  // §4.1's rule on both surfaces: a name over 8 characters drops its version.
  expect(textOf(bandTerminal({ ...EXAMPLE, model: 'claude-sonnet-4-5' }, 40))[0]?.startsWith('sonnet  ▰')).toBe(true)
  expect(textOf(bandTerminal({ ...EXAMPLE, model: 'claude-haiku-4-5' }, 40))[0]?.startsWith('haiku  ▰')).toBe(true)
  expect(drawBand({ ...EXAMPLE, model: 'claude-sonnet-4-5' }, 328, FULL).svg).toContain('>sonnet</text>')
})

test('no terminal row is longer than its width', () => {
  const widths = [40, 42, 43, 58, 59, 118, 119, 120, 200]
  for (const input of [EXAMPLE, CAPS]) {
    const gridRows = widths.map((cols) => {
      const rows = bandTerminal(input, cols)
      for (const r of rows) expect(r.reduce((n, s) => n + [...s.text].length, 0)).toBeLessThanOrEqual(cols)
      return rows.length - 1
    })
    expect(gridRows).toEqual([3, 3, 2, 2, 2, 2, 1, 1, 1])
  }
})

test('tiny widths draw and do not throw', () => {
  for (const px of [0, 8, 64, 160, 312]) {
    for (const input of [EXAMPLE, CAPS, EMPTY]) {
      const band = drawBand(input, px, FULL)
      expect(band.widthPx >= 1 && band.widthPx <= SVG_MAX_PX).toBe(true)
      expect(band.heightPx >= 1 && band.heightPx <= SVG_MAX_PX).toBe(true)
      expect(band.svg.length).toBeLessThan(SVG_SOURCE_MAX)
    }
  }
  for (const cols of [0, 8, 20, 39]) {
    for (const input of [EXAMPLE, CAPS, EMPTY]) {
      for (const r of bandTerminal(input, cols)) {
        expect(r.reduce((n, s) => n + [...s.text].length, 0)).toBeLessThanOrEqual(cols)
      }
    }
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
  expect(bestMs(() => drawBand(CAPS, 3368, FULL))).toBeLessThanOrEqual(0.6)
  expect(bestMs(() => bandTerminal(CAPS, 200))).toBeLessThanOrEqual(0.6)
})
