import { test, expect } from 'claude-code/testing'
import { cells, cutCells, padEnd, padStart, spansCells } from './cells'

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
