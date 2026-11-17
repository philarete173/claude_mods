import { test, expect } from 'claude-code/testing'
import {
  altText, AMBER, BAD, beginAt, BLUE, clampPct, fitSvg, loopBegin, meterColor, pctColor, RED, SVG_SOURCE_MAX, svgPx,
  themeStyle, WARN, xmlText,
} from './svg'

const EMPTY_SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>'

test('xmlText escapes the five characters and drops what XML cannot hold', () => {
  expect(xmlText(`a<b>&"c'`)).toBe('a&lt;b&gt;&amp;&quot;c&#39;')
  expect(xmlText('ü 中 \u{1F600}')).toBe('ü 中 \u{1F600}')
  expect(xmlText('a\u{0}b\u{1B}c\u{FFFE}d\u{D800}e')).toBe('abcde')
  expect(xmlText('a\tb\nc\rd')).toBe('a\tb\nc\rd')
})

test('altText keeps the text and drops what an alt cannot carry', () => {
  expect(altText(`a<b&"'`)).toBe(`a<b&"'`)
  expect(altText('a\u{1}b\u{7F}c\u{85}d\u{D800}e\u{10EEEE}f')).toBe('abcdef')
  expect(altText('a\tb\nc\rd \u{1F600}')).toBe('a\tb\nc\rd \u{1F600}')
})

test('fitSvg keeps a source under the cap and gives the empty svg at or over it', () => {
  const under = `<svg>${'x'.repeat(SVG_SOURCE_MAX - 12)}</svg>`
  expect(under.length).toBe(SVG_SOURCE_MAX - 1)
  expect(fitSvg(under)).toBe(under)
  expect(fitSvg(`${under}x`)).toBe(EMPTY_SVG)
  expect(fitSvg(`${under}xx`)).toBe(EMPTY_SVG)
})

test('svgPx clamps every size', () => {
  expect(svgPx(-5)).toBe(1)
  expect(svgPx(0)).toBe(1)
  expect(svgPx(NaN)).toBe(1)
  expect(svgPx(300)).toBe(300)
  expect(svgPx(5000)).toBe(4096)
})

test('themeStyle writes one fill, one stroke and one stop-color rule per pair inside the light media query', () => {
  expect(themeStyle([['#111111', '#eeeeee'], ['#e5484d', '#e5484d']])).toBe(
    '<style>@media (prefers-color-scheme: light){[fill="#111111"]{fill:#eeeeee}[stroke="#111111"]{stroke:#eeeeee}' +
      '[stop-color="#111111"]{stop-color:#eeeeee}}</style>',
  )
})

test('beginAt and loopBegin take the phase from the wall clock', () => {
  expect(beginAt(250)).toBe('-0.250s')
  expect(beginAt(-350)).toBe('0.350s')
  expect(loopBegin(1_000_000_250, 2400)).toBe('-1.850s')
})

test("the moved colour rules are V's", () => {
  expect(meterColor(79.9)).toBe(BLUE)
  expect(meterColor(80)).toBe(AMBER)
  expect(meterColor(95)).toBe(RED)
  expect(pctColor(79)).toBeUndefined()
  expect(pctColor(80)).toBe(WARN)
  expect(pctColor(95)).toBe(BAD)
  expect(WARN).toBe('warning')
  expect(BAD).toBe('error')
  expect(clampPct(NaN)).toBe(0)
})
