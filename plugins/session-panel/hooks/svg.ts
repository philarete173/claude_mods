// What every image of the pane shares: the size and source caps, the raw colours and the surfaces, the escaping of
// outside text, the light-scheme rules and the wall-clock phases of the SMIL animations. Pure: no `$`, no engine.

import type { Motion } from './stations'

// The engine refuses an Svg whose width or height prop is above this (2.1.288: "Svg width and height are pixels, at
// most 4096"), and a refused tree makes it draw its own pane in place of this one. A pane wider than this (a 32:9
// monitor at 100 % scale) gets a rule that ends short of its right edge, and meters that stop short: a gap before the
// percent of the context meter, and before the countdown of a limit meter.
export const SVG_MAX_PX = 4096
export const SVG_SOURCE_MAX = 131072 // exclusive: a source must be shorter
export const SVG_FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"

// The meter, the ring and the icons are images, so their colours are raw and the same in both themes.
export const BLUE = '#2f7de1'
export const AMBER = '#e0a030'
export const RED = '#e5484d'
export const NEUTRAL = '#8a8a8a' // the grey of every section and row icon, readable on dark and on light
export const GREEN = '#2ea043' // the done icon: a theme key cannot reach an SVG
// Everything else that is coloured uses theme keys, so that it follows the theme. If a surface does not know one, the
// fix is to put a raw colour here.
export const OK = 'success'
export const WARN = 'warning'
export const BAD = 'error'

export const clampPct = (pct: number): number => (Number.isFinite(pct) ? Math.min(Math.max(pct, 0), 100) : 0)
export const meterColor = (pct: number): string => (pct >= 95 ? RED : pct >= 80 ? AMBER : BLUE)
// The percent is written in a theme colour from 80, plain below.
export const pctColor = (pct: number): string | undefined => (pct >= 95 ? BAD : pct >= 80 ? WARN : undefined)

// The surfaces of the new images (§3.2): the dark value goes in the attribute, the light one in themeStyle's rules.
export const SURFACE: Record<'raised' | 'line' | 'rail' | 'bone' | 'ash' | 'fail', { dark: string; light: string }> = {
  raised: { dark: '#2e2d2b', light: '#ffffff' },
  line: { dark: '#45443f', light: '#d4d1c7' },
  rail: { dark: '#3a3936', light: '#e2dfd6' },
  bone: { dark: '#ecebe6', light: '#1d1c1a' },
  ash: { dark: '#9c9a93', light: '#6f6d66' },
  fail: { dark: RED, light: RED },
}

// How a draw moves: `reduced` draws no animation at all.
export type Look = { motion: Motion }

/** An Svg size the engine takes: within [1, SVG_MAX_PX]; NaN gives 1. */
export function svgPx(px: number): number {
  return Number.isNaN(px) ? 1 : Math.max(1, Math.min(SVG_MAX_PX, px))
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Outside text for Svg markup: what XML 1.0 cannot hold goes, then the five markup characters become entities. */
export function xmlText(s: string): string {
  return s
    .replace(/[^\t\n\r\u{20}-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/[&<>"']/g, (c) => ENTITIES[c] ?? '')
}

/** Outside text for an `alt` prop: the controls, lone surrogates and U+10EEEE go; the rest stays as it is. */
export function altText(s: string): string {
  return s.replace(/[\u{0}-\u{8}\u{B}\u{C}\u{E}-\u{1F}\u{7F}-\u{9F}\u{D800}-\u{DFFF}\u{10EEEE}]/gu, '')
}

/** The source when it is shorter than SVG_SOURCE_MAX, else an empty image: the engine refuses a longer one. */
export function fitSvg(source: string): string {
  return source.length < SVG_SOURCE_MAX ? source : '<svg xmlns="http://www.w3.org/2000/svg"/>'
}

/** The light scheme's overrides of the dark values the attributes hold; a pair that does not change is left out. */
export function themeStyle(pairs: readonly (readonly [dark: string, light: string])[]): string {
  const rules = pairs
    .filter(([dark, light]) => dark !== light)
    .map(([dark, light]) =>
      `[fill="${dark}"]{fill:${light}}[stroke="${dark}"]{stroke:${light}}[stop-color="${dark}"]{stop-color:${light}}`)
    .join('')
  return `<style>@media (prefers-color-scheme: light){${rules}}</style>`
}

/** The `begin` of a one-shot part `ms` into its run: the engine re-creates the image on each redraw (ruling D). */
export function beginAt(ms: number): string {
  return `${(-ms / 1000).toFixed(3)}s`
}

/** The `begin` of a loop, so that every redraw continues it where the wall clock has it. */
export function loopBegin(nowMs: number, periodMs: number): string {
  return beginAt(nowMs % periodMs)
}
