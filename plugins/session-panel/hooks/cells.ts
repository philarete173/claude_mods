// Terminal cell strings: a cell is a code point, as the terminal's monospace rows count it.

export type Span = { text: string; color?: string; dimColor?: boolean; bold?: boolean }

export function cells(s: string): number {
  return [...s].length
}

/** At most `n` cells; a cut string ends in `…`. */
export function cutCells(s: string, n: number): string {
  const points = [...s]
  return n <= 0 ? '' : points.length <= n ? s : `${points.slice(0, n - 1).join('')}…`
}

/** Spaces before `s` up to `n` cells; a longer `s` is never cut. */
export function padStart(s: string, n: number): string {
  return ' '.repeat(Math.max(0, n - cells(s))) + s
}

export function padEnd(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - cells(s)))
}

export const spansCells = (spans: Span[]): number => spans.reduce((n, span) => n + cells(span.text), 0)
