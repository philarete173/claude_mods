import { test, expect } from 'claude-code/testing'
import {
  emptyStationsState,
  LEFT_STATIONS,
  RIGHT_STATIONS,
  runningOf,
  shortModel,
  STATION_HUES,
  STATION_ICONS,
  STATION_LABELS,
  STATION_ORDER,
  stationOf,
  zeroStationMs,
} from './stations'
import type { InFlightCall, StationId, ToolStationId } from './stations'
import type { AgentRow, AgentStatus, TaskKind, TaskRow, TaskStatus } from './stats'

const agent = (id: string, status: AgentStatus, restored = false): AgentRow => ({
  id, description: id, type: 'x', model: null, status, startedAt: null, endedAt: null, costUsd: null,
  ...(restored ? { restored: true as const } : {}),
})
const task = (id: string, kind: TaskKind, status: TaskStatus): TaskRow => ({
  id, kind, description: id, status, startedAt: null, endedAt: null, durationMs: null,
})
const call = (station: ToolStationId, agentId: string | null): InFlightCall => ({ station, agentId, at: 0, label: 'x' })
const rows = <T extends { id: string }>(list: T[]): Record<string, T> => Object.fromEntries(list.map((r) => [r.id, r]))
const counts = (o: Partial<Record<StationId, number>>): Record<StationId, number> => ({
  model: 0, files: 0, shell: 0, web: 0, agents: 0, mcp: 0, skills: 0, you: 0, ...o,
})
// The worked example of §2.3: two running subagents (one restored), three ended; a running, a done, a stopped shell.
const exAgents = rows([
  agent('a1', 'running'), agent('a2', 'running', true), agent('d1', 'done'), agent('f1', 'failed'), agent('d2', 'done'),
])
const exTasks = rows([task('t1', 'shell', 'running'), task('t2', 'shell', 'done'), task('t3', 'shell', 'stopped')])

test('stationOf maps every tool of §8.1 to its station', () => {
  const of = (station: StationId, tools: string[]): [string, StationId][] => tools.map((t) => [t, station])
  const table: [string, StationId][] = [
    ...of('files', ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob', 'LSP']),
    ...of('shell', ['Bash', 'PowerShell', 'Monitor']),
    ...of('web', ['WebFetch', 'WebSearch', 'Artifact', 'ArtifactComments', 'ArtifactData']),
    ...of('mcp', [
      'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool', 'mcp__codebase-memory__search_graph',
      'mcp__x__y',
    ]),
    ...of('agents', [
      'Agent', 'Task', 'Workflow', 'SendMessage', 'TaskStop', 'ListAgents', 'SubagentHandback', 'ScheduleWakeup',
      'CronCreate', 'CronDelete', 'CronList',
    ]),
    ...of('skills', [
      'Skill', 'ToolSearch', 'ListSkills', 'SearchSkills', 'SuggestSkills', 'ListPlugins', 'SearchPlugins',
      'SuggestPluginInstall',
    ]),
    ...of('you', [
      'AskUserQuestion', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'EnterPlanMode',
      'ExitPlanMode', 'PushNotification', 'SendUserFile',
    ]),
  ]
  for (const [tool, station] of table) expect(stationOf(tool), tool).toBe(station)
})

test('an unknown tool, an inherited name and an empty name go to Shell', () => {
  for (const t of ['Frobnicate', 'constructor', '__proto__', 'toString', '', 'mcp_']) {
    expect(stationOf(t), t).toBe('shell')
  }
  expect(stationOf('mcp__')).toBe('mcp')
})

test('the station orders and tables cover the eight stations once', () => {
  expect(STATION_ORDER).toEqual(['model', 'files', 'shell', 'web', 'agents', 'mcp', 'skills', 'you'])
  expect([...LEFT_STATIONS, ...RIGHT_STATIONS].sort()).toEqual([...STATION_ORDER].sort())
  const P2 = {
    model: { dark: '#df995e', light: '#ad6313' }, files: { dark: '#5adbda', light: '#007070' },
    shell: { dark: '#b8beff', light: '#5456a7' }, web: { dark: '#91afc5', light: '#577d98' },
    agents: { dark: '#ffa6c1', light: '#983c5e' }, mcp: { dark: '#74bf85', light: '#348c4e' },
    skills: { dark: '#cfc86f', light: '#6a6400' }, you: { dark: '#ca93d7', light: '#995da6' },
  }
  expect(STATION_HUES).toEqual(P2)
  for (const table of [STATION_HUES, STATION_LABELS, STATION_ICONS]) {
    expect(Object.keys(table).sort()).toEqual([...STATION_ORDER].sort())
  }
  expect(new Set(STATION_ORDER.map((s) => STATION_HUES[s].dark)).size).toBe(8)
  expect(STATION_ICONS.mcp).toBe(
    '<path d="M5.25 1.5v3M8.75 1.5v3M7 10.25v2.25"/>' +
      '<path d="M3.5 4.5h7v2.75a3 3 0 0 1-3 3h-1a3 3 0 0 1-3-3z"/>',
  )
  expect(STATION_ORDER.map((s) => STATION_LABELS[s])).toEqual(
    ['Model', 'Files', 'Shell', 'Web', 'Agents', 'MCP', 'Skills', 'You'],
  )
})

test('zeroStationMs and emptyStationsState have every station', () => {
  expect(zeroStationMs()).toEqual(counts({}))
  expect(emptyStationsState().you).toEqual({ calls: 0, failedThisTurn: 0, lastCallAt: null })
  expect(Object.keys(emptyStationsState())).toEqual(STATION_ORDER)
})

test('runningOf counts the worked example', () => {
  expect(runningOf({}, exAgents, exTasks, true)).toEqual(counts({ model: 3, shell: 1, agents: 2 }))
})

test('runningOf takes an agent with a call in flight out of Model', () => {
  const inFlight = { u1: call('files', null), u2: call('shell', 'a1') }
  expect(runningOf(inFlight, exAgents, exTasks, true)).toEqual(counts({ model: 1, files: 1, shell: 2, agents: 2 }))
})

test('runningOf counts a running workflow under Agents and a running monitor under Shell', () => {
  const t = { ...exTasks, w: task('w', 'workflow', 'running'), m: task('m', 'monitor', 'running') }
  expect(runningOf({}, exAgents, t, true)).toEqual(counts({ model: 3, shell: 2, agents: 3 }))
})

test('runningOf with no main turn and no running rows counts only the calls in flight', () => {
  const inFlight = { u: call('web', 'zz') }
  expect(runningOf(inFlight, {}, {}, false)).toEqual(counts({ web: 1 }))
})

test('runningOf counts a foreground subagent once at Agents: its own row, not main\'s Agent call', () => {
  const inFlight = { u: call('agents', null) }
  const rowsOf = rows([agent('a1', 'running')])
  expect(runningOf(inFlight, rowsOf, {}, true)).toEqual(counts({ model: 1, agents: 1 }))
})

test('runningOf counts no Agents call in flight without a running row', () => {
  expect(runningOf({ u: call('agents', null) }, {}, {}, true)).toEqual(counts({ agents: 0 }))
})

test('runningOf takes hostile ids as plain ids', () => {
  const hostile: Record<string, AgentRow> = {}
  for (const id of ['__proto__', 'constructor']) {
    Object.defineProperty(hostile, id, { value: agent(id, 'running'), enumerable: true })
  }
  const inFlight = { u: call('files', 'constructor') }
  expect(runningOf(inFlight, hostile, {}, false)).toEqual(counts({ model: 1, files: 1, agents: 2 }))
})

test('shortModel keeps the family and the version', () => {
  const cases: [string, string][] = [
    ['claude-opus-5-5', 'opus 5.5'], ['claude-sonnet-4-5-20250929', 'sonnet 4.5'],
    ['claude-3-5-haiku-20241022', 'haiku 3.5'], ['opus', 'opus'], ['Claude-Opus-4-1', 'opus 4.1'],
    ['', ''], ['a<b&c', 'a<b&c'],
    ['claude-opus-5-5[1m]', 'opus 5.5'], ['claude-opus-4-1@20250805', 'opus 4.1'],
    ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'sonnet 4.5'],
  ]
  for (const [input, want] of cases) expect(shortModel(input), input).toBe(want)
})
