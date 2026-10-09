// The pane of the session-panel mod, drawn from a snapshot of its state. It is pure: `$` never comes in, because the
// engine's validator follows `$` only inside the file that holds the hooks. register.tsx reads the atoms, takes the
// elements of the surface and builds the press handlers; this file turns them into a tree.
// The look is docs/superpowers/specs/2026-10-07-session-panel-visual.md; the § marks below are its sections.
import type {
  BoxProps, ButtonProps, ElementConstructor, ElementTable, PluginState, RenderElement, RenderSurface, SvgProps,
  TextProps,
} from 'claude-code'

import {
  fmtClock, fmtCountdown, fmtDuration, fmtPct, fmtRate, fmtTokens, fmtTtft, fmtUsd, orderAgents, shortType, splitCost,
  TYPE_MAX,
} from './stats'
import type { AgentRow, AgentStatus, LogEntry } from './stats'

export type SectionId = 'usage' | 'turn' | 'agents' | 'mcp' | 'sources' | 'log'

type State = PluginState['session-panel']

// What the pane is drawn from: the atoms it shows, the time for the countdowns, and the surface it is drawn on.
export type PaneData = Pick<State, 'usage' | 'project' | 'mcp' | 'lastTurn' | 'agents' | 'log' | 'collapsed'> & {
  now: number
  surface: RenderSurface
}

// The part of the Pane props the drawing reads.
export type PaneProps = { bodyColumns: number; scroll: { bodyRows: number } }

// What a press on a header runs. It lives in register.tsx, where the writes to the state are, and waits for nothing.
export type PaneHandlers = { onToggle: (id: SectionId) => void }

type Kit = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  // Only on a surface that draws vectors. The table of the terminal holds an Svg too, but a stub: it draws nothing.
  Svg: ElementConstructor<SvgProps> | undefined
}
// `cols` and `rows` are the body in cells, `rows` 0 where its height is not known; the two meter widths are worked out
// from `cols` once, in px.
type Draw = {
  ui: Kit
  data: PaneData
  handlers: PaneHandlers
  cols: number
  rows: number
  contextMeterPx: number
  limitMeterPx: number
}

// Layout is in cells, the unit of Box numbers. On the desktop a cell is CELL_PX wide, measured on the live pane (§2.1).
// It is used only to turn `bodyColumns` into the px of the meters; confirmed on the live pane on 2026-10-07 (§11,
// check 1).
const CELL_PX = 8
const ICON_PX = 14 // every icon, in CSS px
const ICON_CELLS = 2 // the slot an icon sits in: the text after it starts 3 cells in
const PCT_CELLS = 6 // `100.0%`
const LIMIT_LABEL_CELLS = 7 // `5-hour`, `Weekly`, `Spend`
const LIMIT_PCT_CELLS = 5 // `100%`
const COST_CELLS = 7 // `$148.59`, `<$0.001`
const TIME_CELLS = 8 // `22:09:07`
// The desktop widths of an agent type are measured on the live pane, in the app's own font. In the log,
// `minimal-change` takes about 96 px: 13 cells (104 px) keep it whole. In a subagent row the widest `@type` is a cut
// one, `@frontend-deve…` or `@minimal-chang…`, about 111 px: 15 cells (120 px) keep it whole, with a margin.
const WHO_CELLS = 13 // desktop: the `who` of the log
const WHO_CELLS_MAX = TYPE_MAX // terminal: the longest `who` that shortType keeps
const TYPE_CELLS = 15 // desktop: the `@type` of a subagent
const TYPE_CELLS_MAX = TYPE_MAX + 1 // terminal: the `@` and the longest type that shortType keeps
const TEXT_METER_CELLS = 10
const RULE_PX = 1600 // the divider image; the Box around it cuts it to the pane
const MAX_AGENT_ROWS = 8
// The Log keeps at least this many lines, and when they do not fit the pane scrolls (the user's decision, 2026-10-08),
// as the Subagents list shows up to 8.
const MIN_LOG_ROWS = 8
// The lines the Log draws where the body's height is not known; where it is, the body's rows (MIN_LOG_ROWS at least).
const MAX_LOG_ROWS = 15
const MIN_LOG_TEXT_CELLS = 8 // the least text a log line keeps: below it `who` gives way, then the outcome column
// In a narrow pane the identity column gives way first, as in the log: a subagent row leaves out its `@type`, on
// every row, when the description would keep fewer cells than this beside it.
const MIN_AGENT_DESC_CELLS = 12
const LOG_GAP_CELLS = 1 // the gap between the cells of a log row
const AGENT_GAP_CELLS = 1 // the gap between the cells of a subagent row, and between those of its group
const AGENT_ROW_GAPS = 3 // the gaps of a subagent row that has its type: two between its cells, one in its group
const TEXT_MARK_CELLS = 1 // the mark of a subagent row where there is no icon slot

// The meter, the ring and the icons are images, so their colours are raw and the same in both themes.
const BLUE = '#2f7de1'
const AMBER = '#e0a030'
const RED = '#e5484d'
const NEUTRAL = '#8a8a8a' // the grey of every section and row icon, readable on dark and on light
const GREEN = '#2ea043' // the done icon: a theme key cannot reach an SVG
// Everything else that is coloured uses theme keys, so that it follows the theme. If a surface does not know one, the
// fix is to put a raw colour here.
const OK = 'success'
const WARN = 'warning'
const BAD = 'error'
// The dot of an MCP chip. The no-break space keeps the gap: a plain space at the end of a flex item may be dropped.
const DOT = '●\u00a0'
// The minus sign of the lines removed, not the hyphen.
const MINUS = '\u2212'
// The slash between the lines added and removed, a Text of its own. The no-break spaces keep the gaps, as DOT's does:
// with plain ones at its edges `+8 / −1` may draw as `+8/−1`.
const LINES_SEP = '\u00a0/\u00a0'

const LIMIT_LABELS: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly', spend_limit: 'Spend' }
const AGENT_MARKS: Record<AgentStatus, { glyph: string; color?: string; isDim?: boolean }> = {
  running: { glyph: '◐', color: BLUE },
  done: { glyph: '✓', color: OK },
  failed: { glyph: '✗', color: BAD },
  stopped: { glyph: '✗', isDim: true },
}

const clampPct = (pct: number): number => (Number.isFinite(pct) ? Math.min(Math.max(pct, 0), 100) : 0)
const meterColor = (pct: number): string => (pct >= 95 ? RED : pct >= 80 ? AMBER : BLUE)
// The percent is written in a theme colour from 80, plain below.
const pctColor = (pct: number): string | undefined => (pct >= 95 ? BAD : pct >= 80 ? WARN : undefined)
const orNull = (x: number | null, format: (n: number) => string): string | null => (x === null ? null : format(x))

// ---- Images (§5.1, §7, §8) ----

// The divider: a line far wider than any pane. Its Box cuts it at the body's edge, so no px estimate is involved, and
// `none` keeps it 1 px tall if a surface scales the image down to its slot.
const RULE_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${RULE_PX}" height="1" viewBox="0 0 ${RULE_PX} 1"` +
  ` preserveAspectRatio="none"><rect width="${RULE_PX}" height="1" fill="#808080" fill-opacity="0.35"/></svg>`

// Section and row icons: line icons on a 14-unit grid, one stroke, one grey.
const ICON_ROOT =
  'xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none"' +
  ` stroke="${NEUTRAL}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"`
const icon = (body: string): string => `<svg ${ICON_ROOT}>${body}</svg>`
const dot = (cy: number): string => `<circle cx="2.25" cy="${cy}" r=".9" fill="${NEUTRAL}" stroke="none"/>`

const ICON: Record<SectionId | 'branch' | 'changes', string> = {
  // Usage: a stopwatch.
  usage: icon('<circle cx="7" cy="8" r="4.75"/><path d="M5.5 1.5h3M7 1.5v1.75M7 8V5.75"/>'),
  // Turn stats: a bar chart.
  turn: icon('<path d="M3.5 11.5v-4M7 11.5v-9M10.5 11.5v-6"/>'),
  // Subagents: a bot.
  agents: icon(
    '<rect x="2.5" y="4.75" width="9" height="7" rx="2"/><path d="M7 4.75V2.5H5M5.25 7.75v1.25M8.75 7.75v1.25"/>',
  ),
  // MCP: a plug.
  mcp: icon(
    '<path d="M5.25 1.5v3M8.75 1.5v3M7 10.25v2.25"/><path d="M3.5 4.5h7v2.75a3 3 0 0 1-3 3h-1a3 3 0 0 1-3-3z"/>',
  ),
  // Context sources: layers.
  sources: icon(
    '<path d="M7 1.5 12.5 4.25 7 7 1.5 4.25z"/><path d="M1.5 7 7 9.75 12.5 7M1.5 9.75 7 12.5 12.5 9.75"/>',
  ),
  // Log: a list.
  log: icon(`<path d="M5 3.5h7M5 7h7M5 10.5h7"/>${dot(3.5)}${dot(7)}${dot(10.5)}`),
  // Branch: git-branch.
  branch: icon(
    '<path d="M4 1.75v7.5"/><circle cx="4" cy="11" r="1.75"/><circle cx="10" cy="3.5" r="1.75"/>' +
      '<path d="M10 5.25c0 2.75-2.25 3.75-4.6 4.4"/>',
  ),
  // Changes: a page with a pencil.
  changes: icon(
    '<path d="M5.5 12.5H4A1.5 1.5 0 0 1 2.5 11V3A1.5 1.5 0 0 1 4 1.5h3.5l3 3v1M7.5 1.5v2a1 1 0 0 0 1 1h2"/>' +
      '<path d="M6.25 11.5l-.5 1.75 1.75-.5 4-4a1.06 1.06 0 0 0-1.25-1.25z"/>',
  ),
}

// Subagent status icons are shape-coded, so colour is never the only cue: a half-filled circle, a check, a cross, a
// stop square.
const statusIcon = (color: string, inner: string): string =>
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">' +
  `<circle cx="7" cy="7" r="5.5" fill="none" stroke="${color}" stroke-width="1.4"/>${inner}</svg>`

const STATUS_SVG: Record<AgentStatus, string> = {
  running: statusIcon(BLUE, `<path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="${BLUE}"/>`),
  done: statusIcon(
    GREEN,
    `<path d="M4.6 7.2l1.7 1.7 3.2-3.5" fill="none" stroke="${GREEN}" stroke-width="1.4" stroke-linecap="round"` +
      ' stroke-linejoin="round"/>',
  ),
  failed: statusIcon(
    RED,
    `<path d="M5.1 5.1l3.8 3.8M8.9 5.1l-3.8 3.8" fill="none" stroke="${RED}" stroke-width="1.4"` +
      ' stroke-linecap="round"/>',
  ),
  stopped: statusIcon(NEUTRAL, `<rect x="5" y="5" width="4" height="4" rx=".75" fill="${NEUTRAL}"/>`),
}

const RING_R = 5.5
const RING_C = 2 * Math.PI * RING_R

// The Context ring: a track, and an arc of the percent from 12 o'clock, clockwise, in the colour of the meter. No arc
// when there is no reading or the percent is 0; a full circle at 100, so no hairline gap is left. Butt caps keep the
// arc as long as the percent says.
export function ringSvg(pct: number | undefined): string {
  const p = pct === undefined || !Number.isFinite(pct) ? 0 : clampPct(pct)
  const circle = `<circle cx="7" cy="7" r="${RING_R}" fill="none"`
  const dash = p >= 100 ? '' : ` stroke-dasharray="${((p / 100) * RING_C).toFixed(2)} ${RING_C.toFixed(2)}"`
  const track = `${circle} stroke="#808080" stroke-opacity="0.3" stroke-width="2"/>`
  const arc = p > 0 ? `${circle} stroke="${meterColor(p)}" stroke-width="2"${dash} transform="rotate(-90 7 7)"/>` : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">${track}${arc}</svg>`
}

// Meter bar after Desktop Statusline (George Liu, centminmod, MIT): a rounded track with a rounded fill on it.
export function meterSvg(pct: number, widthPx: number): string {
  const fillPx = Math.round((clampPct(pct) * widthPx) / 100)

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="8" viewBox="0 0 ${widthPx} 8">`,
    `<rect width="${widthPx}" height="8" rx="4" fill="#808080" fill-opacity="0.3"/>`,
    `<rect width="${fillPx}" height="8" rx="4" fill="${meterColor(pct)}"/>`,
    '</svg>',
  ].join('')
}

// The context meter shares its row with the percent only: the body less the 1-cell gap and PCT_CELLS.
export function contextMeterWidth(bodyColumns: number): number {
  return Math.min(560, Math.max(48, (bodyColumns - 7) * CELL_PX))
}

// A limit meter shares its row with the label, the percent and the countdown: 7 + 1 + 1 + 5 + 1 + 9 + 1 spare cells.
export function limitMeterWidth(bodyColumns: number): number {
  return Math.min(240, Math.max(40, (bodyColumns - 25) * CELL_PX))
}

// ---- Shared pieces (§5) ----

// The meter: a vector bar where the surface draws one, ten cells of ▰▱ where it does not. The text bar is a fixed
// cell, so a pane too narrow for it clips it (the Box around it) rather than wrapping it.
function meter(d: Draw, pct: number, alt: string, widthPx: number): RenderElement {
  const { Box, Text, Svg } = d.ui
  if (Svg !== undefined) return <Svg source={meterSvg(pct, widthPx)} alt={alt} width={widthPx} height={8} />
  const filled = Math.round((clampPct(pct) * TEXT_METER_CELLS) / 100)

  return (
    <Box flexDirection="row" flexShrink={0}>
      {filled > 0 && <Text color={meterColor(pct)}>{'▰'.repeat(filled)}</Text>}
      {filled < TEXT_METER_CELLS && <Text dimColor>{'▱'.repeat(TEXT_METER_CELLS - filled)}</Text>}
    </Box>
  )
}

// The rule above a section: an image in a Box that cuts it to the pane, with room around it. The terminal draws a text
// rule, one row, as v1's blank line was. The desktop draws no Svg whose alt is empty, so the rule says `rule`.
function divider(d: Draw): RenderElement {
  const { Box, Text, Svg } = d.ui
  if (Svg === undefined) return <Text dimColor wrap="truncate">{'─'.repeat(Math.max(0, d.cols))}</Text>

  return (
    <Box flexDirection="row" marginTop={1} marginBottom={1} overflow="hidden">
      <Svg source={RULE_SVG} alt="rule" width={RULE_PX} height={1} />
    </Box>
  )
}

// A 14 px icon in a 2-cell slot, so the text after it starts at 3 cells on every row that has one. The desktop draws no
// Svg whose alt is empty (the validator accepts it, the image is dropped and its slot stays), so a decorative icon
// carries the label of its row. A surface with no Svg draws no slot at all.
function iconSlot(d: Draw, source: string, alt: string): RenderElement | null {
  const { Box, Svg } = d.ui
  if (Svg === undefined) return null

  return (
    <Box flexDirection="row" width={ICON_CELLS} flexShrink={0} alignItems="center">
      <Svg source={source} alt={alt} width={ICON_PX} height={ICON_PX} />
    </Box>
  )
}

// A row's cells are FIXED (`flexShrink` 0, a width in cells when it is a column) or FLEX (`flexShrink` 1, `minWidth`
// 0 and `overflow` hidden: a flex item cannot shrink below its content unless its minWidth is 0). A Text that may be
// cut is never a direct child of a row: it sits alone in a FLEX cell. So no row can outgrow the pane (§2.3).

// FLEX, left: gives way first when the row is short of room.
function shrinkText(d: Draw, text: string, style: Partial<TextProps> = {}): RenderElement {
  const { Box, Text } = d.ui

  return (
    <Box flexDirection="row" flexShrink={1} minWidth={0} overflow="hidden">
      <Text {...style} wrap="truncate">{text}</Text>
    </Box>
  )
}

// FLEX, left, and it grows: takes the room that is left, so the cells after it start at the same x on every row.
function growText(d: Draw, text: string): RenderElement {
  const { Box, Text } = d.ui

  return (
    <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
      <Text wrap="truncate">{text}</Text>
    </Box>
  )
}

// FLEX, right: takes the room that is left and puts its text at the right edge. Empty text draws the Box alone.
function endText(d: Draw, text: string, style: Partial<TextProps> = {}): RenderElement {
  const { Box, Text } = d.ui

  return (
    <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden" justifyContent="flex-end">
      {text !== '' && <Text {...style} wrap="truncate">{text}</Text>}
    </Box>
  )
}

// A label on the left, its value on the right. The value never cuts; the label gives way first.
function row(d: Draw, label: string, value: string, color?: string): RenderElement {
  const { Box, Text } = d.ui

  return (
    <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
      {shrinkText(d, label)}
      <Box flexDirection="row" flexShrink={0}>
        <Text color={color}>{value}</Text>
      </Box>
    </Box>
  )
}

const isFolded = (d: Draw, id: SectionId): boolean => d.data.collapsed[id] === true

// The header row of a section: an icon, the bold title, a dim chevron that folds it, a dim summary at the right. The
// title is a Text because a Button label cannot be bold; the chevron is a plain Button, dim at rest and full strength
// under the pointer or the focus (§5.4, §12.1).
function sectionHeader(d: Draw, id: SectionId, title: string, summary: string): RenderElement {
  const { Box, Text, Button } = d.ui

  return (
    <Box flexDirection="row" alignItems="center" columnGap={1}>
      {iconSlot(d, ICON[id], title)}
      <Box flexDirection="row" flexShrink={0}>
        <Text bold>{title}</Text>
      </Box>
      <Button
        plain
        dimColor
        key={`toggle:${id}`}
        label={isFolded(d, id) ? '▸' : '▾'}
        onPress={() => d.handlers.onToggle(id)}
      />
      {endText(d, summary, { dimColor: true })}
    </Box>
  )
}

// A section: a rule, then its header row, then the body unless folded. A folded section keeps its summary.
function section(d: Draw, id: SectionId, title: string, summary: string, body: RenderElement[]): RenderElement {
  const { Box } = d.ui

  return (
    <Box flexDirection="column">
      {divider(d)}
      {sectionHeader(d, id, title, summary)}
      {!isFolded(d, id) && <Box flexDirection="column">{body}</Box>}
    </Box>
  )
}

// ---- Top block (§6.1–§6.2) ----

// The context of the window: a ring, the label and `tokens / window`; under it the meter and the percent. A dash when
// there is no reading: before any response, after a /clear, or with a percent that is not a number (NaN, Infinity, or a
// null left by one). Then the ring is its track alone and there is no meter row.
function contextRows(d: Draw): RenderElement[] {
  const { Box, Text } = d.ui
  const { contextPct, contextTokens, contextWindow } = d.data.usage
  const label = (
    <Box flexDirection="row" flexShrink={0}>
      <Text>Context</Text>
    </Box>
  )
  if (contextPct === undefined || !Number.isFinite(contextPct)) {
    return [
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        {iconSlot(d, ringSvg(undefined), 'Context')}
        {label}
        {endText(d, '—', { dimColor: true })}
      </Box>,
    ]
  }
  const hasTokens = contextTokens !== undefined && contextWindow !== undefined
  const note = hasTokens ? `${fmtTokens(contextTokens)} / ${fmtTokens(contextWindow)}` : ''
  const pctText = fmtPct(contextPct, 1)

  return [
    <Box flexDirection="row" alignItems="center" columnGap={1}>
      {iconSlot(d, ringSvg(contextPct), 'Context')}
      {label}
      {endText(d, note, { dimColor: true })}
    </Box>,
    <Box flexDirection="row" alignItems="center" justifyContent="space-between" columnGap={1}>
      <Box flexDirection="row" flexShrink={1} minWidth={0} overflow="hidden">
        {meter(d, contextPct, `Context ${pctText}`, d.contextMeterPx)}
      </Box>
      <Box flexDirection="row" width={PCT_CELLS} flexShrink={0} justifyContent="flex-end">
        <Text color={pctColor(contextPct)}>{pctText}</Text>
      </Box>
    </Box>,
  ]
}

// Session and Total, the context, and the split of the cost when subagents ran. The card never folds and has no rule
// above it. The total is primary weight: bold is for titles.
function topBlock(d: Draw): RenderElement {
  const { Box, Text } = d.ui
  const { usage, agents } = d.data
  const subagentsUsd = Object.values(agents).reduce((sum, agent) => sum + (agent.costUsd ?? 0), 0)
  const split = splitCost(usage.costUsd, subagentsUsd)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Box flexDirection="row" flexShrink={0}>
          <Text bold>Session</Text>
        </Box>
        {split.total !== null && (
          <Box flexDirection="row" flexShrink={0}>
            <Text>{fmtUsd(split.total)}</Text>
          </Box>
        )}
      </Box>
      {contextRows(d)}
      {split.session !== null && split.subagents > 0 && (
        <Text dimColor wrap="truncate">
          {`Session ${fmtUsd(split.session)} · Subagents ${fmtUsd(split.subagents)}`}
        </Text>
      )}
    </Box>
  )
}

// ---- Project block (§6.3) ----

// The lines added and removed, `+8 / −1`: three Texts in a fixed cell, so the numbers stay whole when the label beside
// them is cut. A count that is a lower bound (`hasMoreAdded`) has a plus after it: `+8+ / −1`.
function linesCell(d: Draw, lines: { added: number; removed: number; hasMoreAdded?: true }): RenderElement {
  const { Box, Text } = d.ui

  return (
    <Box flexDirection="row" flexShrink={0}>
      <Text color={OK}>{`+${lines.added}${lines.hasMoreAdded === true ? '+' : ''}`}</Text>
      <Text dimColor>{LINES_SEP}</Text>
      <Text color={BAD}>{`${MINUS}${lines.removed}`}</Text>
    </Box>
  )
}

// The label of the changes row: `1 file changed`, `12 files changed`. A count that is a lower bound (`hasMoreFiles`, a
// status that was cut) has a plus after it, and the label is plural even for 1: `1+ files changed`.
function filesLabel(changes: { files: number; hasMoreFiles?: true }): string {
  if (changes.hasMoreFiles === true) return `${changes.files}+ files changed`

  return changes.files === 1 ? '1 file changed' : `${changes.files} files changed`
}

// The project, as OpenChamber's Project block shows it: under a rule, the bold title with the folder dim at the right
// (cut from the end), then the branch, then the changes of the working tree: how many files, and at the right the
// lines added and removed. Like the Session card it never folds, so its header has no icon and no chevron. A row is an
// icon and its text on the desktop, and the text behind an emoji on the terminal, as v1 drew it. The block is left out
// when there is no project name; the branch row when there is no branch; the changes row when there are no changes; the
// numbers when the lines are unknown or are none (only binary files changed).
function projectBlock(d: Draw): RenderElement | null {
  const { Box, Text, Svg } = d.ui
  // A value that an earlier build left in the state has no `changes`: it has none to show.
  const { name, branch, changes = null } = d.data.project
  if (name === '') return null
  const marked = (emoji: string, text: string): string => (Svg === undefined ? `${emoji} ${text}` : text)

  return (
    <Box flexDirection="column">
      {divider(d)}
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        <Box flexDirection="row" flexShrink={0}>
          <Text bold>Project</Text>
        </Box>
        {endText(d, name, { dimColor: true })}
      </Box>
      {branch !== null && (
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          {iconSlot(d, ICON.branch, 'Branch')}
          {shrinkText(d, marked('🌿', branch))}
        </Box>
      )}
      {changes !== null && (
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          {iconSlot(d, ICON.changes, 'Changes')}
          {growText(d, marked('📝', filesLabel(changes)))}
          {changes.lines !== null && changes.lines.added + changes.lines.removed > 0 && linesCell(d, changes.lines)}
        </Box>
      )}
    </Box>
  )
}

// ---- Sections (§6.5–§6.10) ----

// The rate-limit windows with the time to their reset; left out when the provider has none (an API key, a gateway).
// The meters line up: the same label width and the same meter width on every row.
function usageSection(d: Draw): RenderElement | null {
  const { Box, Text } = d.ui
  const { rateLimits } = d.data.usage
  const lead = rateLimits.find(limit => limit.kind === 'five_hour') ?? rateLimits[0]
  if (lead === undefined) return null
  const label = (kind: string): string => LIMIT_LABELS[kind] ?? kind
  const rows = rateLimits.map(limit => {
    const pctText = fmtPct(limit.percentUsed, 0)
    const reset = limit.resetsAt === undefined ? '' : fmtCountdown(limit.resetsAt - d.data.now)

    return (
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        <Box flexDirection="row" width={LIMIT_LABEL_CELLS} flexShrink={0} overflow="hidden">
          <Text wrap="truncate">{label(limit.kind)}</Text>
        </Box>
        <Box flexDirection="row" flexShrink={1} minWidth={0} overflow="hidden">
          {meter(d, limit.percentUsed, `${label(limit.kind)} ${pctText}`, d.limitMeterPx)}
        </Box>
        <Box flexDirection="row" width={LIMIT_PCT_CELLS} flexShrink={0} justifyContent="flex-end">
          <Text color={pctColor(limit.percentUsed)}>{pctText}</Text>
        </Box>
        {endText(d, reset, { dimColor: true })}
      </Box>
    )
  })

  return section(d, 'usage', 'Usage', `${label(lead.kind)} ${fmtPct(lead.percentUsed, 0)}`, rows)
}

type Line = [label: string, value: string | null, color?: string]

// The last finished turn; a row whose figure is unknown is left out. With none, a dim line that a narrow pane cuts.
function turnSection(d: Draw): RenderElement {
  const turn = d.data.lastTurn
  if (turn === null) {
    return section(d, 'turn', 'Turn stats', '', [shrinkText(d, 'No completed turn yet', { dimColor: true })])
  }
  const lines: Line[] = [
    ['Response', orNull(turn.responseRate, fmtRate)],
    ['Whole turn', orNull(turn.wholeTurnRate, fmtRate)],
    ['Elapsed', fmtDuration(turn.elapsedMs)],
    ['Model time', fmtDuration(turn.modelMs)],
    ['Tool time', fmtDuration(turn.toolMs)],
    ['Average TTFT', orNull(turn.ttftMs, fmtTtft)],
    ['Steps', turn.steps > 1 ? String(turn.steps) : null],
    ['Tokens', `${fmtTokens(turn.tokensIn)} ↑ · ${fmtTokens(turn.tokensOut)} ↓`],
    ['Cache', orNull(turn.cachePct, pct => fmtPct(pct, 0)), (turn.cachePct ?? 0) >= 50 ? OK : undefined],
    ['Cost', orNull(turn.costUsd, fmtUsd)],
  ]
  const rows = lines.flatMap(([label, value, color]) => (value === null ? [] : [row(d, label, value, color)]))
  const summary = orNull(turn.responseRate ?? turn.wholeTurnRate, fmtRate) ?? ''

  return section(d, 'turn', 'Turn stats', summary, rows)
}

// One subagent, in columns: the mark (a cell of its own), a group that takes the rest of the row, and the cost
// (right-aligned in a column of its own). The group holds the description, which grows and is cut to the room there
// is, and the `@type`, a column of `typeCells` on every row, so the types start at one x whatever the descriptions
// are. A pane too narrow to leave the description MIN_AGENT_DESC_CELLS has no type column (`typeCells` is 0): the
// description takes the whole group, on every row alike.
function agentRow(d: Draw, agent: AgentRow, typeCells: number): RenderElement {
  const { Box, Text, Svg } = d.ui
  const mark = AGENT_MARKS[agent.status]

  return (
    <Box flexDirection="row" alignItems="center" columnGap={AGENT_GAP_CELLS}>
      {Svg === undefined ? (
        <Box flexDirection="row" width={TEXT_MARK_CELLS} flexShrink={0}>
          <Text color={mark.color} dimColor={mark.isDim}>
            {mark.glyph}
          </Text>
        </Box>
      ) : (
        iconSlot(d, STATUS_SVG[agent.status], agent.status)
      )}
      <Box
        flexDirection="row"
        flexGrow={1}
        flexShrink={1}
        minWidth={0}
        overflow="hidden"
        columnGap={AGENT_GAP_CELLS}
      >
        {growText(d, agent.description)}
        {typeCells > 0 && (
          <Box flexDirection="row" width={typeCells} flexShrink={0} overflow="hidden">
            <Text dimColor wrap="truncate">{`@${shortType(agent.type)}`}</Text>
          </Box>
        )}
      </Box>
      <Box flexDirection="row" width={COST_CELLS} flexShrink={0} justifyContent="flex-end">
        {agent.costUsd === null ? <Text dimColor>—</Text> : <Text>{fmtUsd(agent.costUsd)}</Text>}
      </Box>
    </Box>
  )
}

// The subagents, running ones first and then the newest; the ones that do not fit are counted, in line with the names.
function agentsSection(d: Draw): RenderElement | null {
  const { Box, Text, Svg } = d.ui
  const agents = orderAgents(Object.values(d.data.agents))
  if (agents.length === 0) return null
  const running = agents.filter(agent => agent.status === 'running').length
  const summary = running > 0 ? `${running}/${agents.length}` : String(agents.length)
  const shown = agents.slice(0, MAX_AGENT_ROWS)
  // One width for the type column of every row, as for the `who` of the log: the terminal takes the longest `@type`
  // that is drawn, the desktop a width of its own.
  const longest = Math.max(...shown.map(agent => `@${shortType(agent.type)}`.length))
  const typeCells = Svg === undefined ? Math.min(TYPE_CELLS_MAX, longest) : TYPE_CELLS
  // What the description keeps beside the type: the body less the mark, the type, the cost and the gaps of a row. With
  // less than MIN_AGENT_DESC_CELLS the type is left out of every row.
  const markCells = Svg === undefined ? TEXT_MARK_CELLS : ICON_CELLS
  const descCells = d.cols - markCells - typeCells - COST_CELLS - AGENT_ROW_GAPS * AGENT_GAP_CELLS
  const hasType = descCells >= MIN_AGENT_DESC_CELLS
  const rows = shown.map(agent => agentRow(d, agent, hasType ? typeCells : 0))
  const more = agents.length - MAX_AGENT_ROWS
  if (more > 0) {
    // The line starts where the descriptions do: after the mark and its gap.
    rows.push(
      <Box flexDirection="row" paddingLeft={markCells + AGENT_GAP_CELLS}>
        <Text dimColor>{`+${more} more`}</Text>
      </Box>,
    )
  }

  return section(d, 'agents', 'Subagents', summary, rows)
}

// The MCP servers, a green dot and the name each, wrapped whole; the summary is their count. The mod only learns which
// servers have tools in the context (WaitForMcpServers is not there for a module), so it cannot tell a failed one
// from a connected one: every dot is green. A name wider than the pane goes on its own line and is cut.
function mcpSection(d: Draw): RenderElement | null {
  const { Box, Text } = d.ui
  const { mcp } = d.data
  if (mcp === null || mcp.servers.length === 0) return null
  const chips = mcp.servers.map(server => (
    <Box flexDirection="row" flexShrink={1} minWidth={0} overflow="hidden">
      <Box flexDirection="row" flexShrink={0}>
        <Text color={OK}>{DOT}</Text>
      </Box>
      {shrinkText(d, server.name)}
    </Box>
  ))

  return section(d, 'mcp', 'MCP', String(mcp.servers.length), [
    <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      {chips}
    </Box>,
  ])
}

// What feeds the context: the skills and the MCP servers that are counted.
function sourcesSection(d: Draw): RenderElement | null {
  const { skills } = d.data.usage
  const servers = d.data.mcp?.servers.length
  if (skills === undefined && servers === undefined) return null
  const rows: RenderElement[] = []
  const parts: string[] = []
  if (skills !== undefined) {
    rows.push(row(d, 'Skills', String(skills)))
    parts.push(`${skills} skills`)
  }
  if (servers !== undefined) {
    rows.push(row(d, 'MCP servers', String(servers)))
    parts.push(`${servers} MCP`)
  }

  return section(d, 'sources', 'Context sources', parts.join(' · '), rows)
}

// The Log, as the parts of the pane's root: its rule, its header and its lines, with no Box around them. That is the
// layout the live desktop has verified, and it needs no chain of Boxes that grow (the visual spec, §6.12 Log height).
// Folded, it is the rule and the header; with no lines, nothing.
// The newest log lines: time, who, what, and how it went. Time and `who` are dim fixed columns, so every text starts
// at the same x; the text is cut to one line. On the desktop `who` has a width of its own, so the text column does not
// jump with the longest `who`; on the terminal it is the longest one there is, up to the most shortType keeps. The
// outcome (the mark and the time of an action, or `denied`) is a fixed column at the right edge, as wide as the
// longest one drawn, a cell wider on the desktop: a ✓ or a ✗ varies by font, and the margin keeps the mark whole. A
// line without one has the cell empty. An error shows its `who` and its outcome in red, the others are dim; in
// [time, text], which has neither cell, its text is red.
// The layout is the first of these whose text keeps MIN_LOG_TEXT_CELLS cells, one for every row: [time, who, text,
// outcome]; then `who` gives way, [time, text, outcome]; then [time, text], where a line shows its outcome in front of
// its text, so that the cut at the end keeps it. That one is also the layout when nothing fits. With no outcome among
// the lines drawn there is no outcome cell, and a line shows its text alone.
// Where `who` has no cell, a line of the person (`you`) or of the engine (`engine`) shows it in front of its text, as
// `you › …`, for its text alone does not say whose it is; the other lines have no label. It comes after the outcome,
// where a line shows that in front too. MIN_LOG_TEXT_CELLS counts the text alone, not the label: at the edge of a
// layout an engine line shows its label and none of its text.
// The height: the lines drawn are the body's rows, MIN_LOG_ROWS at least, for a line past them could never show. The
// first MIN_LOG_ROWS are the head, a Box that holds its height, so they always show. The rest are the tail, a Box with
// no height of its own that grows into the rows the root leaves free (it is at least the body's height) and clips at
// its bottom, so the oldest lines go first. When not even the head fits, the root grows to its content and the pane
// scrolls, which the engine does. Where the body's height is not known the lines are MAX_LOG_ROWS, in one Box at their
// natural height: a tail would have no room to grow into.
function logParts(d: Draw): RenderElement[] {
  const { Box, Text, Svg } = d.ui
  const lines = d.data.log.slice(0, d.rows > 0 ? Math.max(MIN_LOG_ROWS, d.rows) : MAX_LOG_ROWS)
  if (lines.length === 0) return []
  const rule = divider(d)
  const header = sectionHeader(d, 'log', 'Log', '')
  if (isFolded(d, 'log')) return [rule, header]
  const longestWho = Math.max(...lines.map(line => line.who.length))
  const whoCells = Svg === undefined ? Math.min(WHO_CELLS_MAX, longestWho) : WHO_CELLS
  const longestOutcome = Math.max(...lines.map(line => line.outcome?.length ?? 0))
  const outcomeCells = longestOutcome === 0 ? 0 : longestOutcome + (Svg === undefined ? 0 : 1)
  // The cells the text keeps in a layout: the body less the time, `who` and outcome cells it has, and its gaps (the
  // cells of the row less one).
  const textCells = (withWho: boolean, withOutcome: boolean): number =>
    d.cols - TIME_CELLS - (withWho ? whoCells : 0) - (withOutcome ? outcomeCells : 0) -
    (1 + Number(withWho) + Number(withOutcome)) * LOG_GAP_CELLS
  const hasOutcomes = outcomeCells > 0
  const hasWho = textCells(true, hasOutcomes) >= MIN_LOG_TEXT_CELLS
  const hasOutcomeCell = hasOutcomes && (hasWho || textCells(false, true) >= MIN_LOG_TEXT_CELLS)
  const isTextOnly = !hasWho && !hasOutcomeCell
  // What the text cell shows, one string in one Text, so that the cut at its end keeps what leads: the outcome, where
  // the row has no cell for it, then the label of a line of the person or of the engine, where it has none for `who`.
  const textOf = (line: LogEntry): string => {
    const outcome = hasOutcomeCell || line.outcome === undefined ? '' : `${line.outcome} `
    const label = !hasWho && (line.who === 'you' || line.who === 'engine') ? `${line.who} › ` : ''

    return `${outcome}${label}${line.text}`
  }
  const lineRows = lines.map(line => (
    <Box flexDirection="row" columnGap={LOG_GAP_CELLS}>
      <Box flexDirection="row" width={TIME_CELLS} flexShrink={0}>
        <Text dimColor>{fmtClock(line.at)}</Text>
      </Box>
      {hasWho && (
        <Box flexDirection="row" width={whoCells} flexShrink={0} overflow="hidden">
          {line.kind === 'error' ? (
            <Text color={BAD} wrap="truncate">{line.who}</Text>
          ) : (
            <Text dimColor wrap="truncate">{line.who}</Text>
          )}
        </Box>
      )}
      <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
        <Text color={isTextOnly && line.kind === 'error' ? BAD : undefined} wrap="truncate">{textOf(line)}</Text>
      </Box>
      {hasOutcomeCell && (
        <Box flexDirection="row" width={outcomeCells} flexShrink={0} overflow="hidden" justifyContent="flex-end">
          {line.outcome !== undefined && (line.kind === 'error' ? (
            <Text color={BAD} wrap="truncate">{line.outcome}</Text>
          ) : (
            <Text dimColor wrap="truncate">{line.outcome}</Text>
          ))}
        </Box>
      )}
    </Box>
  ))
  if (d.rows === 0) return [rule, header, <Box flexDirection="column">{lineRows}</Box>]
  const parts = [rule, header, <Box flexDirection="column" flexShrink={0}>{lineRows.slice(0, MIN_LOG_ROWS)}</Box>]
  if (lineRows.length > MIN_LOG_ROWS) {
    parts.push(
      <Box flexDirection="column" height={0} flexGrow={1} flexShrink={1} overflow="hidden">
        {lineRows.slice(MIN_LOG_ROWS)}
      </Box>,
    )
  }

  return parts
}

// The whole pane. `els` is the element table of the surface, `data` the state, `props` the Pane props, and `handlers`
// what the presses run. Each section begins with its own rule, so a section that is left out leaves no double rule. The
// root is at least the body's height, and the Log, which comes last, takes the rest of it (logParts). A body whose rows
// are not a positive number has no known height: the root has no minimum then.
export function renderPane(els: ElementTable, data: PaneData, props: PaneProps, handlers: PaneHandlers): RenderElement {
  const { Box, Text, Button } = els
  const Svg = 'Svg' in els && data.surface !== 'terminal' ? els.Svg : undefined
  const cols = props.bodyColumns
  // The types say a Pane always has `scroll`, but a throw while the pane is drawn blanks it: an engine that hands none
  // is read as one whose height is not known, and the pane is drawn as 0.2.0 drew it.
  const bodyRows = props.scroll?.bodyRows
  const d: Draw = {
    ui: { Box, Text, Button, Svg },
    data,
    handlers,
    cols,
    rows: Number.isFinite(bodyRows) && bodyRows > 0 ? bodyRows : 0,
    contextMeterPx: contextMeterWidth(cols),
    limitMeterPx: limitMeterWidth(cols),
  }

  return (
    <Box flexDirection="column" minHeight={d.rows > 0 ? d.rows : undefined}>
      {topBlock(d)}
      {projectBlock(d)}
      {usageSection(d)}
      {turnSection(d)}
      {agentsSection(d)}
      {mcpSection(d)}
      {sourcesSection(d)}
      {logParts(d)}
    </Box>
  )
}
