import { test, expect } from 'claude-code/testing'
import { cells, cutCells, middleCut, padEnd, padStart, spansCells } from './cells'

test('cells counts code points', () => {
  expect(cells('中a')).toBe(2)
  expect(cells('\u{1F600}')).toBe(1)
  expect(spansCells([{ text: '中a' }, { text: '\u{1F600}', color: 'error' }])).toBe(3)
})

test('cutCells cuts with an ellipsis', () => {
  expect(cutCells('Review the diff', 13)).toBe('Review the d…')
  expect(cutCells('Plan critique', 13)).toBe('Plan critique')
  expect(cutCells('Plan critique', 0)).toBe('')
  expect(cutCells('Plan critique', -3)).toBe('')
  expect(cutCells('ab', 1)).toBe('…')
})

test('padStart and padEnd pad in cells and never cut', () => {
  expect(padStart('5', 3)).toBe('  5')
  expect(padEnd('5', 3)).toBe('5  ')
  expect(padStart('abcd', 3)).toBe('abcd')
  expect(padEnd('abcd', 3)).toBe('abcd')
  expect(padStart('ab', -2)).toBe('ab')
  expect(padEnd('ab', -2)).toBe('ab')
})

const BAND_CHECK = ['A', 'B', 'C', 'D'].map((x) => `Band check: background sleep ${x}`)

test('middleCut cuts a group in the middle, at its tail\'s word', () => {
  // §4.3's table: L 18, 19 and 23 (41, 44 and 52 columns).
  expect(middleCut(BAND_CHECK, 18)).toEqual(['A', 'B', 'C', 'D'].map((x) => `Band check…sleep ${x}`))
  expect(middleCut(BAND_CHECK, 19)).toEqual(['A', 'B', 'C', 'D'].map((x) => `Band check:…sleep ${x}`))
  expect(middleCut(BAND_CHECK, 23)).toEqual(['A', 'B', 'C', 'D'].map((x) => `Band check: bac…sleep ${x}`))
})

test('middleCut keeps a head of 4 code points', () => {
  expect(middleCut(['abcdefghij-1', 'abcdefghij-2'], 6)).toEqual(['abcd…1', 'abcd…2'])
  // The tail is the 11 code points that tell them apart, the head the 6 left.
  expect(middleCut([`${'x'.repeat(10)}A${'y'.repeat(10)}`, `${'x'.repeat(10)}B${'y'.repeat(10)}`], 18))
    .toEqual([`xxxxxx…A${'y'.repeat(10)}`, `xxxxxx…B${'y'.repeat(10)}`])
  // The head keeps its trailing space: without it, 3 code points would be left.
  expect(middleCut(['Fix the X12', 'Fix the Y12'], 8)).toEqual(['Fix …X12', 'Fix …Y12'])
})

test('middleCut never passes n and falls back to the end cut when no head fits', () => {
  for (let n = 6; n <= 64; n += 1) {
    for (const text of middleCut(BAND_CHECK, n)) expect(cells(text), `${n}: ${text}`).toBeLessThanOrEqual(n)
  }
  expect(middleCut(BAND_CHECK, 5)).toEqual(BAND_CHECK.map((t) => cutCells(t, 5)))
  const [one, two] = middleCut(['Band check: background', 'Band check: background'], 12)
  expect(one).toBe(two)
})

test('middleCut gives back a text that fits in n and cuts the others in the middle', () => {
  expect(middleCut(['Band check', ...BAND_CHECK.slice(0, 2)], 18))
    .toEqual(['Band check', 'Band check…sleep A', 'Band check…sleep B'])
  expect(middleCut(BAND_CHECK, 64)).toEqual(BAND_CHECK)
})
