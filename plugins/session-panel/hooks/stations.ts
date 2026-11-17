// The eight tool stations of the Session band: which station a tool belongs to, each station's hue, label and icon,
// the count of what runs at each, and the short model name. It imports nothing from the engine and never takes `$`,
// so every function can be tested on its own.

import type { AgentRow, TaskRow } from './stats'

export type StationId = 'model' | 'files' | 'shell' | 'web' | 'agents' | 'mcp' | 'skills' | 'you'
export type ToolStationId = Exclude<StationId, 'model'>
export type StationTally = { calls: number; failedThisTurn: number; lastCallAt: number | null }
export type StationsState = Record<StationId, StationTally>
export type InFlightCall = { station: ToolStationId; agentId: string | null; at: number; label: string }
export type StationMs = Record<StationId, number>
// Not state: the `motion` option as the draws take it.
export type Motion = 'full' | 'reduced'

export const STATION_ORDER: StationId[] = ['model', 'files', 'shell', 'web', 'agents', 'mcp', 'skills', 'you']
export const LEFT_STATIONS: StationId[] = ['model', 'files', 'shell', 'web']
export const RIGHT_STATIONS: StationId[] = ['agents', 'mcp', 'skills', 'you']

export const STATION_HUES: Record<StationId, { dark: string; light: string }> = {
  model: { dark: '#e1ac6e', light: '#b8762a' },
  files: { dark: '#5fc2b5', light: '#1c8c81' },
  shell: { dark: '#a48cf0', light: '#6c4fc0' },
  web: { dark: '#93aac4', light: '#4f6b8a' },
  agents: { dark: '#e58fae', light: '#b44a74' },
  mcp: { dark: '#a3c47a', light: '#5b822f' },
  skills: { dark: '#d9c95a', light: '#8c7a00' },
  you: { dark: '#d48ae0', light: '#9a48b0' },
}

export const STATION_LABELS: Record<StationId, string> = {
  model: 'Model', files: 'Files', shell: 'Shell', web: 'Web',
  agents: 'Agents', mcp: 'MCP', skills: 'Skills', you: 'You',
}

// The icon bodies, inside the house `ICON_ROOT` (14 px, stroke 1.4, round caps and joins, no fill).
export const STATION_ICONS: Record<StationId, string> = {
  model:
    '<rect x="3.5" y="3.5" width="7" height="7" rx="1.2"/>' +
    '<path d="M5.5 1.5v2M8.5 1.5v2M5.5 10.5v2M8.5 10.5v2M1.5 5.5h2M1.5 8.5h2M10.5 5.5h2M10.5 8.5h2"/>',
  files: '<path d="M3.5 1.5h4.25L10.5 4.25v8.25h-7z"/><path d="M7.75 1.5v2.75h2.75"/>',
  shell: '<path d="M2.5 4l3 3-3 3M7 10.5h4.5"/>',
  web:
    '<circle cx="7" cy="7" r="5.5"/>' +
    '<path d="M1.5 7h11M7 1.5c-2.2 2.2-2.2 8.8 0 11M7 1.5c2.2 2.2 2.2 8.8 0 11"/>',
  agents:
    '<circle cx="7" cy="3.25" r="1.6"/><circle cx="3.25" cy="10.75" r="1.6"/>' +
    '<circle cx="10.75" cy="10.75" r="1.6"/><path d="M7 4.85V7.2M7 7.2 4.4 9.6M7 7.2l2.6 2.4"/>',
  mcp:
    '<path d="M5.25 1.5v3M8.75 1.5v3M7 10.25v2.25"/>' +
    '<path d="M3.5 4.5h7v2.75a3 3 0 0 1-3 3h-1a3 3 0 0 1-3-3z"/>',
  skills: '<path d="M8.1 .9L3 7.7h3.3L5.2 13.1l5.4-7.05H7.35z"/>',
  you:
    '<circle cx="7" cy="4.75" r="2.75"/>' +
    '<path d="M1.75 12.5c0-3.1 2.35-4.9 5.25-4.9s5.25 1.8 5.25 4.9"/>',
}

const toolTable = (station: ToolStationId, tools: string[]): [string, ToolStationId][] =>
  tools.map((tool): [string, ToolStationId] => [tool, station])

// Every tool §8.1 names. A tool that is not here, not `mcp__*` and not `Cron*` is Shell, as in lot-map.
const TOOL_STATIONS = new Map<string, ToolStationId>([
  ...toolTable('files', ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob', 'LSP']),
  ...toolTable('shell', ['Bash', 'PowerShell', 'Monitor']),
  ...toolTable('web', ['WebFetch', 'WebSearch', 'Artifact', 'ArtifactComments', 'ArtifactData']),
  ...toolTable('mcp', ['ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool']),
  ...toolTable('agents', [
    'Agent', 'Task', 'Workflow', 'SendMessage', 'TaskStop', 'ListAgents', 'SubagentHandback', 'ScheduleWakeup',
  ]),
  ...toolTable('skills', [
    'Skill', 'ToolSearch', 'ListSkills', 'SearchSkills', 'SuggestSkills', 'ListPlugins', 'SearchPlugins',
    'SuggestPluginInstall',
  ]),
  ...toolTable('you', [
    'AskUserQuestion', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'EnterPlanMode', 'ExitPlanMode',
    'PushNotification', 'SendUserFile',
  ]),
])

/** The station of a tool. A Map, so an inherited name (`constructor`) is no tool. */
export function stationOf(tool: string): ToolStationId {
  let station = TOOL_STATIONS.get(tool)
  if (station === undefined) {
    if (tool.startsWith('mcp__')) station = 'mcp'
    else if (tool.startsWith('Cron')) station = 'agents'
    else station = 'shell'
  }
  return station
}

export const zeroStationMs = (): StationMs => ({
  model: 0, files: 0, shell: 0, web: 0, agents: 0, mcp: 0, skills: 0, you: 0,
})

export const emptyStationsState = (): StationsState =>
  Object.fromEntries(
    STATION_ORDER.map((s) => [s, { calls: 0, failedThisTurn: 0, lastCallAt: null }]),
  ) as StationsState

/**
 * What runs at each station now (§8.2). Model counts the running agents (main while its turn runs, each subagent
 * with a running row) that have no call in flight; Agents the running subagent rows and workflow tasks; Shell the
 * calls in flight and the running shell and monitor tasks; every station but Agents the calls in flight.
 */
export function runningOf(
  inFlight: Record<string, InFlightCall>,
  agents: Record<string, AgentRow>,
  tasks: Record<string, TaskRow>,
  isMainRunning: boolean,
): Record<StationId, number> {
  const out = zeroStationMs()
  // The agents with a call in flight, by id; main is `null`.
  const inCall = new Set<string | null>()
  for (const call of Object.values(inFlight)) {
    // An Agents call in flight is no count: its subagent's own row counts it.
    if (call.station !== 'agents') out[call.station] += 1
    inCall.add(call.agentId)
  }
  if (isMainRunning && !inCall.has(null)) out.model += 1
  // The key is the id: a row's own `id` is not looked up.
  for (const [id, row] of Object.entries(agents)) {
    if (row.status !== 'running') continue
    out.agents += 1
    if (!inCall.has(id)) out.model += 1
  }
  for (const row of Object.values(tasks)) {
    if (row.status !== 'running') continue
    if (row.kind === 'workflow') out.agents += 1
    else out.shell += 1
  }
  return out
}

/**
 * `claude-sonnet-4-5-20250929` as `sonnet 4.5`. The name is lower-cased and cut at its first `[` or `@` (Claude Code's
 * `[1m]` context alias, Vertex's `@date`), so that what they hold is no part of the version; a leading `claude-` goes.
 * The family is the first alphabetic `-` token, the version the numeric tokens joined by `.`; an 8-digit token is a
 * date wherever it stands (Bedrock's `-20250929-v1:0`) and is no part of it. A name with no alphabetic token comes
 * back lower-cased, whole.
 */
export function shortModel(model: string): string {
  const name = model.toLowerCase()
  const tokens = name.replace(/[[@].*$/s, '').replace(/^claude-/, '').split('-')
  const family = tokens.find((t) => /^[a-z]+$/.test(t))
  const version = tokens.filter((t) => /^\d+$/.test(t) && !/^\d{8}$/.test(t)).join('.')
  let out = name
  if (family !== undefined) out = version === '' ? family : `${family} ${version}`
  return out
}
