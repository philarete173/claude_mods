// The pane of the session-panel mod, drawn from a snapshot of its state. It is pure: `$` never comes in, because the
// engine's validator follows `$` only inside the file that holds the hooks. register.tsx reads the atoms, takes the
// elements of the surface and builds the press handlers; this file turns them into a tree.
import type {
  BoxProps, ButtonProps, ElementConstructor, ElementTable, PluginState, RenderElement, RenderSurface, SvgProps,
  TextProps,
} from 'claude-code'

import {
  fmtClock, fmtCountdown, fmtDuration, fmtPct, fmtRate, fmtTokens, fmtTtft, fmtUsd, orderAgents, shortType, splitCost,
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
type Draw = { ui: Kit; data: PaneData; handlers: PaneHandlers; meterPx: number }

// The meter and the running mark are drawn in raw colours, as Desktop Statusline does.
const BLUE = '#2f7de1'
const AMBER = '#e0a030'
const RED = '#e5484d'
// Everything else that is coloured uses theme keys, so that it follows the theme. If a surface does not know one, the
// fix is to put a raw colour here.
const OK = 'success'
const WARN = 'warning'
const BAD = 'error'
const LABEL_CELLS = 8 // fits `Context`, the longest label of a meter row
const TEXT_METER_CELLS = 10
const MAX_AGENT_ROWS = 8
const MAX_LOG_ROWS = 15

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

// The width of the meter in px: the body at about 12.5 px a column, less the room of the label and the percent.
export function meterWidth(bodyColumns: number): number {
  return Math.min(180, Math.max(40, Math.round(bodyColumns * 12.5 - 210)))
}

// The meter: a vector bar where the surface draws one, ten cells of ▰▱ where it does not.
function meter(d: Draw, pct: number, alt: string): RenderElement {
  const { Box, Text, Svg } = d.ui
  if (Svg !== undefined) return <Svg source={meterSvg(pct, d.meterPx)} alt={alt} width={d.meterPx} height={8} />
  const filled = Math.round((clampPct(pct) * TEXT_METER_CELLS) / 100)

  return (
    <Box flexDirection="row">
      {filled > 0 && <Text color={meterColor(pct)}>{'▰'.repeat(filled)}</Text>}
      {filled < TEXT_METER_CELLS && <Text dimColor>{'▱'.repeat(TEXT_METER_CELLS - filled)}</Text>}
    </Box>
  )
}

// A label on the left, its value on the right.
function row(d: Draw, label: string, value: string, color?: string): RenderElement {
  const { Box, Text } = d.ui

  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Text>{label}</Text>
      <Text color={color}>{value}</Text>
    </Box>
  )
}

// A meter row: label, meter, percent, and a dim note that wraps under them when the pane is narrow.
function meterRow(d: Draw, label: string, pct: number, pctText: string, note: string): RenderElement {
  const { Box, Text } = d.ui

  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
      <Box width={LABEL_CELLS}>
        <Text>{label}</Text>
      </Box>
      {meter(d, pct, `${label} ${pctText}`)}
      <Box minWidth={5} justifyContent="flex-end">
        <Text color={pctColor(pct)}>{pctText}</Text>
      </Box>
      {note !== '' && <Text dimColor>{note}</Text>}
    </Box>
  )
}

// A section: its header is a button that folds it, with a dim summary on the right; the body goes unless folded.
function section(d: Draw, id: SectionId, title: string, summary: string, body: RenderElement[]): RenderElement {
  const { Box, Text, Button } = d.ui
  const isFolded = d.data.collapsed[id] === true

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Button
          plain
          key={`toggle:${id}`}
          label={`${isFolded ? '▸' : '▾'} ${title}`}
          onPress={() => d.handlers.onToggle(id)}
        />
        {summary !== '' && <Text dimColor>{summary}</Text>}
      </Box>
      {!isFolded && body}
    </Box>
  )
}

// The context of the window: tokens held against the window the mod measures, or a dash when there is no reading:
// before any response, after a /clear, or with a percent that is not a number (NaN, Infinity, or a null left by one).
function contextRow(d: Draw): RenderElement {
  const { Box, Text } = d.ui
  const { contextPct, contextTokens, contextWindow } = d.data.usage
  if (contextPct === undefined || !Number.isFinite(contextPct)) {
    return (
      <Box flexDirection="row" columnGap={1}>
        <Box width={LABEL_CELLS}>
          <Text>Context</Text>
        </Box>
        <Text dimColor>—</Text>
      </Box>
    )
  }
  const hasTokens = contextTokens !== undefined && contextWindow !== undefined
  const note = hasTokens ? `${fmtTokens(contextTokens)} / ${fmtTokens(contextWindow)}` : ''

  return meterRow(d, 'Context', contextPct, fmtPct(contextPct, 1), note)
}

// Session and Total, the context, the split of the cost when subagents ran, the project and its branch.
function topBlock(d: Draw): RenderElement {
  const { Box, Text } = d.ui
  const { usage, project, agents } = d.data
  const subagentsUsd = Object.values(agents).reduce((sum, agent) => sum + (agent.costUsd ?? 0), 0)
  const split = splitCost(usage.costUsd, subagentsUsd)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>Session</Text>
        {split.total !== null && <Text>{fmtUsd(split.total)}</Text>}
      </Box>
      {contextRow(d)}
      {split.session !== null && split.subagents > 0 && (
        <Text dimColor>{`Session ${fmtUsd(split.session)} · Subagents ${fmtUsd(split.subagents)}`}</Text>
      )}
      {project.name !== '' && (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Text>{`📁 ${project.name}`}</Text>
          {project.branch !== null && <Text>{`🌿 ${project.branch}`}</Text>}
        </Box>
      )}
    </Box>
  )
}

// The rate-limit windows with the time to their reset; left out when the provider has none (an API key, a gateway).
function usageSection(d: Draw): RenderElement | null {
  const { rateLimits } = d.data.usage
  const lead = rateLimits.find(limit => limit.kind === 'five_hour') ?? rateLimits[0]
  if (lead === undefined) return null
  const label = (kind: string): string => LIMIT_LABELS[kind] ?? kind
  const rows = rateLimits.map(limit => {
    const reset = limit.resetsAt === undefined ? '' : fmtCountdown(limit.resetsAt - d.data.now)

    return meterRow(d, label(limit.kind), limit.percentUsed, fmtPct(limit.percentUsed, 0), reset)
  })

  return section(d, 'usage', 'Usage', `${label(lead.kind)} ${fmtPct(lead.percentUsed, 0)}`, rows)
}

type Line = [label: string, value: string | null, color?: string]

// The last finished turn; a row whose figure is unknown is left out.
function turnSection(d: Draw): RenderElement {
  const { Text } = d.ui
  const turn = d.data.lastTurn
  if (turn === null) return section(d, 'turn', 'Turn stats', '', [<Text dimColor>No completed turn yet</Text>])
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

// One subagent: its mark (in a cell of its own, so the descriptions line up), its description (cut to the room there
// is), its type and what it cost.
function agentRow(d: Draw, agent: AgentRow): RenderElement {
  const { Box, Text } = d.ui
  const mark = AGENT_MARKS[agent.status]

  return (
    <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
      <Box flexDirection="row" columnGap={1} flexShrink={1}>
        <Box width={1}>
          <Text color={mark.color} dimColor={mark.isDim}>
            {mark.glyph}
          </Text>
        </Box>
        <Box flexShrink={1}>
          <Text wrap="truncate">{agent.description}</Text>
        </Box>
        <Text dimColor>{`@${shortType(agent.type)}`}</Text>
      </Box>
      {agent.costUsd === null ? <Text dimColor>—</Text> : <Text>{fmtUsd(agent.costUsd)}</Text>}
    </Box>
  )
}

// The subagents, running ones first and then the newest; the ones that do not fit are counted.
function agentsSection(d: Draw): RenderElement | null {
  const { Box, Text } = d.ui
  const agents = orderAgents(Object.values(d.data.agents))
  if (agents.length === 0) return null
  const running = agents.filter(agent => agent.status === 'running').length
  const summary = running > 0 ? `${running}/${agents.length}` : String(agents.length)
  const rows = agents.slice(0, MAX_AGENT_ROWS).map(agent => agentRow(d, agent))
  const more = agents.length - MAX_AGENT_ROWS
  if (more > 0) {
    rows.push(
      <Box paddingLeft={2}>
        <Text dimColor>{`+${more} more`}</Text>
      </Box>,
    )
  }

  return section(d, 'agents', 'Subagents', summary, rows)
}

// The MCP servers, one green `● name` each, wrapped; the summary is their count. The mod only learns which servers
// have tools in the context (WaitForMcpServers is not there for a module), so it records every one as connected.
function mcpSection(d: Draw): RenderElement | null {
  const { Box, Text } = d.ui
  const { mcp } = d.data
  if (mcp === null || mcp.servers.length === 0) return null
  const items = mcp.servers.map(server => <Text color={OK}>{`● ${server.name}`}</Text>)

  return section(d, 'mcp', 'MCP', String(mcp.servers.length), [
    <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      {items}
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

// The newest log lines: time, who, what; the text is cut to one line, an error shows its `who` in red.
function logSection(d: Draw): RenderElement | null {
  const { Box, Text } = d.ui
  const lines = d.data.log.slice(0, MAX_LOG_ROWS)
  if (lines.length === 0) return null
  const whoCells = Math.max(...lines.map(line => line.who.length))
  const rows = lines.map(line => (
    <Box flexDirection="row" columnGap={1}>
      <Text dimColor>{fmtClock(line.at)}</Text>
      <Box width={whoCells}>
        <Text color={line.kind === 'error' ? BAD : undefined} wrap="truncate">
          {line.who}
        </Text>
      </Box>
      <Box flexShrink={1}>
        <Text wrap="truncate">{line.text}</Text>
      </Box>
    </Box>
  ))

  return section(d, 'log', 'Log', '', rows)
}

// The whole pane. `els` is the element table of the surface, `data` the state, `props` the Pane props, and `handlers`
// what the presses run.
export function renderPane(els: ElementTable, data: PaneData, props: PaneProps, handlers: PaneHandlers): RenderElement {
  const { Box, Text, Button } = els
  const Svg = 'Svg' in els && data.surface !== 'terminal' ? els.Svg : undefined
  const d: Draw = { ui: { Box, Text, Button, Svg }, data, handlers, meterPx: meterWidth(props.bodyColumns) }

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
