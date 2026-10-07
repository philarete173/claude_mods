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
import type { AgentRow, AgentStatus } from './stats'

export type SectionId = 'usage' | 'turn' | 'agents' | 'mcp' | 'sources' | 'log'

type State = PluginState['session-panel']

// What the pane is drawn from: the atoms it shows, the time for the countdowns, and the surface it is drawn on.
export type PaneData = Pick<State, 'usage' | 'project' | 'mcp' | 'lastTurn' | 'agents' | 'log' | 'collapsed'> & {
  now: number
  surface: RenderSurface
}

// The part of the Pane props the drawing reads.
export type PaneProps = { bodyColumns: number }

// What a press on a header runs. It lives in register.tsx, where the writes to the state are, and waits for nothing.
export type PaneHandlers = { onToggle: (id: SectionId) => void }

type Kit = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  // Only on a surface that draws vectors. The table of the terminal holds an Svg too, but a stub: it draws nothing.
  Svg: ElementConstructor<SvgProps> | undefined
}
// `cols` is the body in cells; the two meter widths are worked out from it once, in px.
type Draw = {
  ui: Kit
  data: PaneData
  handlers: PaneHandlers
  cols: number
  contextMeterPx: number
  limitMeterPx: number
}

// Layout is in cells, the unit of Box numbers. On the desktop a cell is CELL_PX wide, measured on the live pane (§2.1).
const CELL_PX = 8 // used only to turn `bodyColumns` into the px of the meters; confirm it once on a screenshot (§11)
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
const MAX_LOG_ROWS = 15

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

const ICON: Record<SectionId | 'folder' | 'branch', string> = {
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
  // Project: a folder.
  folder: icon(
    '<path d="M1.5 3.75c0-.55.45-1 1-1h2.6l1.4 1.5h5c.55 0 1 .45 1 1v5.5c0 .55-.45 1-1 1h-9c-.55 0-1-.45-1-1z"/>',
  ),
  // Branch: git-branch.
  branch: icon(
    '<path d="M4 1.75v7.5"/><circle cx="4" cy="11" r="1.75"/><circle cx="10" cy="3.5" r="1.75"/>' +
      '<path d="M10 5.25c0 2.75-2.25 3.75-4.6 4.4"/>',
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

// A section: a rule, then a header row (icon, bold title, a dim chevron that folds it, a dim summary at the right),
// then the body unless folded. A folded section keeps its summary. The title is a Text because a Button label cannot be
// bold; the chevron is a plain Button, dim at rest and full strength under the pointer or the focus (§5.4, §12.1).
function section(d: Draw, id: SectionId, title: string, summary: string, body: RenderElement[]): RenderElement {
  const { Box, Text, Button } = d.ui
  const isFolded = d.data.collapsed[id] === true

  return (
    <Box flexDirection="column">
      {divider(d)}
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        {iconSlot(d, ICON[id], title)}
        <Box flexDirection="row" flexShrink={0}>
          <Text bold>{title}</Text>
        </Box>
        <Button
          plain
          dimColor
          key={`toggle:${id}`}
          label={isFolded ? '▸' : '▾'}
          onPress={() => d.handlers.onToggle(id)}
        />
        {endText(d, summary, { dimColor: true })}
      </Box>
      {!isFolded && <Box flexDirection="column">{body}</Box>}
    </Box>
  )
}

// ---- Top block (§6.1–§6.3) ----

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

// The project at the left and its branch at the right; either gives way, the longer name first. On the desktop each is
// an icon and a name, on the terminal the emoji line of v1.
function projectRow(d: Draw): RenderElement {
  const { Box, Svg } = d.ui
  const { name, branch } = d.data.project
  const group = (iconSvg: string, alt: string, emoji: string, text: string): RenderElement => (
    <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={1} minWidth={0} overflow="hidden">
      {Svg === undefined ? shrinkText(d, `${emoji} ${text}`) : [iconSlot(d, iconSvg, alt), shrinkText(d, text)]}
    </Box>
  )

  return (
    <Box flexDirection="row" justifyContent="space-between" columnGap={2} marginTop={Svg === undefined ? 0 : 1}>
      {group(ICON.folder, 'Project', '📁', name)}
      {branch !== null && group(ICON.branch, 'Branch', '🌿', branch)}
    </Box>
  )
}

// Session and Total, the context, the split of the cost when subagents ran, the project and its branch. The card never
// folds and has no rule above it. The total is primary weight: bold is for titles.
function topBlock(d: Draw): RenderElement {
  const { Box, Text } = d.ui
  const { usage, project, agents } = d.data
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
      {project.name !== '' && projectRow(d)}
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
// are. A pane too narrow for the type column leaves every description 0 wide and the group clips that column, on
// every row alike.
function agentRow(d: Draw, agent: AgentRow, typeCells: number): RenderElement {
  const { Box, Text, Svg } = d.ui
  const mark = AGENT_MARKS[agent.status]

  return (
    <Box flexDirection="row" alignItems="center" columnGap={1}>
      {Svg === undefined ? (
        <Box flexDirection="row" width={1} flexShrink={0}>
          <Text color={mark.color} dimColor={mark.isDim}>
            {mark.glyph}
          </Text>
        </Box>
      ) : (
        iconSlot(d, STATUS_SVG[agent.status], agent.status)
      )}
      <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden" columnGap={1}>
        {growText(d, agent.description)}
        <Box flexDirection="row" width={typeCells} flexShrink={0} overflow="hidden">
          <Text dimColor wrap="truncate">{`@${shortType(agent.type)}`}</Text>
        </Box>
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
  const rows = shown.map(agent => agentRow(d, agent, typeCells))
  const more = agents.length - MAX_AGENT_ROWS
  if (more > 0) {
    // The icon slot and its gap on the desktop, the one-cell mark and its gap on the terminal.
    rows.push(
      <Box flexDirection="row" paddingLeft={Svg === undefined ? 2 : 3}>
        <Text dimColor>{`+${more} more`}</Text>
      </Box>,
    )
  }

  return section(d, 'agents', 'Subagents', summary, rows)
}

// The MCP servers, a green dot and the name each, wrapped whole; the summary is their count. The mod only learns which
// servers have tools in the context (WaitForMcpServers is not there for a module), so it records every one as
// connected. A name wider than the pane goes on its own line and is cut.
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

// The newest log lines: time, who, what. Time and `who` are dim fixed columns, so every text starts at the same x; the
// text is cut to one line, an error shows its `who` in red. On the desktop `who` has a width of its own, so the text
// column does not jump with the longest `who`; on the terminal it is the longest one there is, up to the most
// shortType keeps.
function logSection(d: Draw): RenderElement | null {
  const { Box, Text, Svg } = d.ui
  const lines = d.data.log.slice(0, MAX_LOG_ROWS)
  if (lines.length === 0) return null
  const longest = Math.max(...lines.map(line => line.who.length))
  const whoCells = Svg === undefined ? Math.min(WHO_CELLS_MAX, longest) : WHO_CELLS
  const rows = lines.map(line => (
    <Box flexDirection="row" columnGap={1}>
      <Box flexDirection="row" width={TIME_CELLS} flexShrink={0}>
        <Text dimColor>{fmtClock(line.at)}</Text>
      </Box>
      <Box flexDirection="row" width={whoCells} flexShrink={0} overflow="hidden">
        {line.kind === 'error' ? (
          <Text color={BAD} wrap="truncate">{line.who}</Text>
        ) : (
          <Text dimColor wrap="truncate">{line.who}</Text>
        )}
      </Box>
      <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
        <Text wrap="truncate">{line.text}</Text>
      </Box>
    </Box>
  ))

  return section(d, 'log', 'Log', '', rows)
}

// The whole pane. `els` is the element table of the surface, `data` the state, `props` the Pane props, and `handlers`
// what the presses run. Each section begins with its own rule, so a section that is left out leaves no double rule.
export function renderPane(els: ElementTable, data: PaneData, props: PaneProps, handlers: PaneHandlers): RenderElement {
  const { Box, Text, Button } = els
  const Svg = 'Svg' in els && data.surface !== 'terminal' ? els.Svg : undefined
  const cols = props.bodyColumns
  const d: Draw = {
    ui: { Box, Text, Button, Svg },
    data,
    handlers,
    cols,
    contextMeterPx: contextMeterWidth(cols),
    limitMeterPx: limitMeterWidth(cols),
  }

  return (
    <Box flexDirection="column">
      {topBlock(d)}
      {usageSection(d)}
      {turnSection(d)}
      {agentsSection(d)}
      {mcpSection(d)}
      {sourcesSection(d)}
      {logSection(d)}
    </Box>
  )
}
