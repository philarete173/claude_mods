// Terminal cell strings: a cell is a code point, as the terminal's monospace rows count it.

export type Span = { text: string; color?: string; dimColor?: boolean; bold?: boolean }

export function cells(s: string): number {
  return [...s].length
}

// §9.1's extenders: a code point that belongs to the one before it. Marks (the keycap U+20E3 among them), the ZWJ,
// the variation selectors, the emoji modifiers and the tag characters.
const EXTENDER = /[\p{M}\u{200D}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/u
const REGIONAL = /[\u{1F1E6}-\u{1F1FF}]/u
const isRegional = (point: string | undefined): boolean => point !== undefined && REGIONAL.test(point)

// Whether a cut between points i − 1 and i splits a cluster (§9.1): i is an extender, i − 1 a ZWJ, or both are
// regional indicators and the run of them that ends at i − 1 is odd. Never at either end of the text.
function isBadCut(points: readonly string[], i: number): boolean {
  if (i <= 0 || i >= points.length) return false
  if (EXTENDER.test(points[i] ?? '') || points[i - 1] === '\u{200D}') return true
  if (!isRegional(points[i])) return false
  let run = 0
  while (isRegional(points[i - 1 - run])) run += 1

  return run % 2 === 1
}

/** §9.1's head: the greatest cut ≤ `end` (0 at least) that splits no cluster of `points` (a text's code points). */
export function headEnd(points: readonly string[], end: number): number {
  let cut = Math.max(0, Math.min(end, points.length))
  while (isBadCut(points, cut)) cut -= 1

  return cut
}

/** §9.1's tail: the least start ≥ `start` (`points.length` at most) that splits no cluster of `points`. */
export function tailStart(points: readonly string[], start: number): number {
  let cut = Math.max(start, 0)
  while (isBadCut(points, cut)) cut += 1

  return cut
}

/** At most `n` cells; a cut string ends in `…`, with no white space and no split cluster before it. */
export function cutCells(s: string, n: number): string {
  const points = [...s]
  return n <= 0 ? '' : points.length <= n ? s : `${points.slice(0, headEnd(points, n - 1)).join('').trimEnd()}…`
}

const HEAD_MIN = 4 // the code points a middle cut keeps before its `…`

/**
 * §4.3's middle cut of one group of descriptions whose end cuts to `n` cells read the same: each becomes head, `…`,
 * tail, at most `n` cells, in the order given. The tail tells the texts apart or is a third of the room, whichever is
 * longer, and moves back to its word's start when that costs at most 3 cells; the head keeps at least `HEAD_MIN`. Where
 * no head fits (`n` < 6) the texts take the end cut. A text that fits in `n` comes back as given, and the tail is
 * worked out from the others. The head never ends, nor the tail starts, inside a cluster (§9.1). Bounded with no
 * shortcut: `k` runs to the room (≤ 63 at L 64) over the ≤ 8 lanes shown, and each text is split into code points
 * once.
 */
export function middleCut(texts: string[], n: number): string[] {
  const room = n - 1
  if (room - HEAD_MIN < 1) return texts.map((t) => cutCells(t, n))
  const pts = texts.map((t) => [...t])
  const wide = pts.filter((p) => p.length > n)
  let k = 1
  while (k < room && new Set(wide.map((p) => p.slice(-k).join(''))).size < wide.length) k += 1
  const t0 = Math.min(room - HEAD_MIN, Math.max(k, Math.floor(room / 3)))
  return pts.map((p, i) => {
    if (p.length <= n) return texts[i] ?? ''
    let t = t0
    const start = p.length - t
    const j = start > 0 ? p.lastIndexOf(' ', start - 1) + 1 : 0 // the start of the word the tail starts in
    if (p[start - 1] !== ' ' && start - j <= 3 && room - (p.length - j) >= HEAD_MIN) t = p.length - j
    const head = p.slice(0, headEnd(p, room - t)).join('')
    const trimmed = head.trimEnd()
    const tail = p.slice(tailStart(p, Math.max(0, p.length - t))).join('')
    return `${cells(trimmed) >= HEAD_MIN ? trimmed : head}…${tail}`
  })
}

/** Spaces before `s` up to `n` cells; a longer `s` is never cut. */
export function padStart(s: string, n: number): string {
  return ' '.repeat(Math.max(0, n - cells(s))) + s
}

export function padEnd(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - cells(s)))
}

export const spansCells = (spans: Span[]): number => spans.reduce((n, span) => n + cells(span.text), 0)

// A row cut to `cols` cells, span by span; spans left empty go.
export function fitRow(spans: Span[], cols: number): Span[] {
  let room = Math.max(0, cols)
  const out: Span[] = []
  for (const span of spans) {
    const text = cutCells(span.text, room)
    // A cut span ends the row, so nothing comes after its `…` (the trim may leave cells free).
    room = text === span.text ? room - cells(text) : 0
    if (text !== '') out.push({ ...span, text })
  }
  return out
}
