import { test, expect } from 'claude-code/testing'
import { BAND_PARTS_MAX, bandLayout, bandParts, bandTerminal, drawBand } from './band'
import type { BandInput, Rect } from './band'
import { STATION_HUES, STATION_ORDER } from './stations'
import type { StationId, StationTally } from './stations'
import { loopBegin, SVG_MAX_PX, SVG_SOURCE_MAX } from './svg'

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
  nowMs: NOW,
}
// Every count, every station running and failing, every pulse in flight.
const CAPS: BandInput = {
  pct: 100, tokens: 1_000_000, window: 1_000_000, model: 'claude-opus-5-5', compactions: 50,
  stations: each(() => tally(99_999, 12, NOW - 10)),
  running: each(() => 12),
  nowMs: NOW,
}
const EMPTY: BandInput = {
  pct: undefined, tokens: undefined, window: undefined, model: null, compactions: 0,
  stations: each(() => tally(0)), running: each(() => 0), nowMs: NOW,
}
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
  // Model at 328 travels 0.6 s: its lifetime is 600 + 150 + 300 ms.
  const modelAt = (age: number): string =>
    drawBand(withStation(EXAMPLE, 'model', tally(31, 0, NOW - age)), 328, FULL).svg
  expect(modelAt(1049)).toContain('data-part="pulse"')
  expect(modelAt(1050)).not.toContain('data-part="pulse"')
  expect(modelAt(5000)).not.toContain('data-part="pulse"')
  expect(drawBand(EXAMPLE, 328, FULL).svg).not.toContain('<animateMotion')
  expect(shell).toContain(`dur="2.4s" begin="${loopBegin(NOW, 2400)}"`)
  expect(shell).not.toContain('begin="0s"')
})

test('a pulse past its travel draws its group with no dot', () => {
  // Shell at 328 travels 600 ms; at 700 ms it is still inside its lifetime of 1050 ms.
  const svg = drawBand(withStation(EXAMPLE, 'shell', tally(4, 1, NOW - 700)), 328, FULL).svg
  const group = /<g data-part="pulse"[^>]*>(.*?)<\/g>/.exec(svg)
  expect(group).not.toBeNull()
  expect(group?.[1] ?? '<circle').not.toContain('<circle')
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
  expect(svg).not.toContain('<set')
  expect(svg).toContain('<circle cx="93" cy="25.5" r="14" fill="#e1ac6e" opacity="0.18"/>')
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
  // CAPS at 268, two rows with no labels: core 5, ticks 5, 8 lines, and per station a glow, a circle, an icon, a
  // badge, a disc, a count and a pulse.
  expect(bandParts(drawBand(CAPS, 268, FULL).svg)).toBe(74)
})

test('the states of §4.6', () => {
  const svg = drawBand(EXAMPLE, 328, FULL).svg
  expect(svg).toContain('<circle cx="93" cy="25.5" r="11" fill="#2e2d2b" stroke="#e1ac6e" stroke-width="1.5"')
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
