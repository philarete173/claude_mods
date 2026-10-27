import { expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'

import { cutAtTurn, restoreFromMessages } from './restore'
import type { Restored, RestoreRow } from './restore'
import type { AgentRow, LogEntry, LogKind, TaskRow } from './stats'

// The rows are synthetic, in the shapes of `$.session.messages()` on 2.1.308 (SessionMessage, ToolUseSummary and
// ToolResultSummary of its d.ts, and the plan's Findings). The engine's rows fit the shape the walk reads.
const engineRows = (rows: SessionMessage[]): readonly RestoreRow[] => rows

const ROOT = '/work/online_shop'
const NONE: ReadonlySet<string> = new Set()

type Fields = Record<string, unknown>
let calls = 0
const user = (text: string): Fields => ({ role: 'user', text, toolUses: [] })
// The user row of tool results that follows an assistant row's calls.
const results = (): Fields => ({
  role: 'user', text: '', toolUses: [],
  toolResults: [{ tool_use_id: 'toolu_r', text: 'output', isError: false, result: { stdout: 'output' } }],
})
const call = (tool: string, input: Fields, outcome: Fields = {}): Fields => {
  calls += 1

  return { tool_use_id: `toolu_${calls}`, tool, input, ...outcome }
}
const assistant = (...toolUses: Fields[]): Fields => ({ role: 'assistant', text: 'Let me look.', toolUses })
const read = (path: string): Fields =>
  call('Read', { file_path: `${ROOT}/${path}` }, { result: { type: 'text' }, text: 'file contents' })
const restore = (rows: readonly unknown[], alive: ReadonlySet<string> = NONE): Restored =>
  restoreFromMessages(rows, alive, ROOT)
const line = (who: string, text: string, kind: LogKind, outcome?: string): LogEntry =>
  ({ at: null, who, text, kind, ...(outcome === undefined ? {} : { outcome }) })
// The lines in short: who, the text and the outcome, newest first.
const said = (restored: Restored): string[] =>
  restored.log.map(l => `${l.who}: ${l.text}${l.outcome === undefined ? '' : ` ${l.outcome}`}`)

// A notification as the engine writes it (stats.test.ts): the header, the summary and what follows.
const notice = (id: string, status: string, summary: string, tail = ''): string =>
  `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_01TkA4cq2o2Hn55hdQA4jJWG</tool-use-id>\n` +
  `<output-file>/tmp/claude-1000/p/tasks/${id}.output</output-file>\n<status>${status}</status>\n` +
  `<summary>${summary}</summary>\n${tail}</task-notification>`
const usageBlock = (ms: number): string =>
  `<usage><subagent_tokens>19770</subagent_tokens><tool_uses>3</tool_uses><duration_ms>${ms}</duration_ms></usage>\n`
const SUMMARY = 'This session is being continued from a previous conversation that ran out of context. Summary: …'
const COMMAND =
  '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>'

const AGENT_INPUT = { description: 'Map the flow', subagent_type: 'Explore', prompt: 'Read the checkout code' }
// A background Agent call, as 2.1.299-2.1.308 store it.
const launched = (agentId: string, input: Fields = AGENT_INPUT): Fields => call('Agent', input, {
  agentId,
  result: {
    status: 'async_launched', agentId, description: 'Map the flow', prompt: 'Read the checkout code',
    outputFile: `/tmp/claude-1000/p/tasks/${agentId}.output`, canContinueAgent: true, resolvedModel: 'claude-sonnet-5',
  },
  text: 'Async agent launched successfully.',
})
const agentRow = (id: string, status: AgentRow['status'], patch: Partial<AgentRow> = {}): AgentRow => ({
  id, description: 'Map the flow', type: 'Explore', model: 'claude-sonnet-5', status, startedAt: null, endedAt: null,
  costUsd: null, restored: true, ...patch,
})
const SPAWNED = line('main', 'spawned · Explore: Map the flow', 'info')
const bash = (id: string, input: Fields, more: Fields = {}): Fields => call('Bash', input, {
  result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: id, ...more },
  text: `Command running in background with ID: ${id}.`,
})
const taskRow = (id: string, status: TaskRow['status'], patch: Partial<TaskRow> = {}): TaskRow => ({
  id, kind: 'shell', description: 'Start the dev server', status, startedAt: null, endedAt: null, durationMs: null,
  ...patch,
})
const DEV = { command: 'npm run dev', description: 'Start the dev server', run_in_background: true }

test('an empty list gives an empty result', () => {
  expect(restore(engineRows([]))).toEqual({ agents: {}, tasks: {}, log: [], logCount: 0 })
})

test('a foreground agent that completed is done, with its time and its answer', () => {
  const done = call('Agent', AGENT_INPUT, {
    agentId: 'a1', result: { status: 'completed', totalDurationMs: 65_000, agentId: 'a1' },
    text: 'Found **three** callers', durationMs: 65_000,
  })
  const restored = restore([user('map it'), assistant(done), results()])
  expect(restored.agents).toEqual({ a1: agentRow('a1', 'done', { model: null }) })
  expect(restored.log).toEqual([
    line('Explore', 'done — Found three callers', 'ok', '✓ 1m 05s'), SPAWNED, line('you', 'map it', 'info'),
  ])
  expect(restored.logCount).toBe(3)
})

test('an agent call that failed is a failed agent and a ✗ line', () => {
  const failed =
    call('Agent', AGENT_INPUT, { agentId: 'a2', result: 'Agent crashed', text: 'Agent crashed', isError: true })
  const restored = restore([assistant(failed), results()])
  expect(restored.agents).toEqual({ a2: agentRow('a2', 'failed', { model: null }) })
  expect(restored.log).toEqual([
    line('main', 'Agent → Explore: Map the flow', 'error', '✗'), line('Explore', 'failed', 'error', '✗'), SPAWNED,
  ])
})

test('a background agent is closed by its notice row: done, failed, killed', () => {
  const restored = restore([
    assistant(launched('a3'), launched('a4'), launched('a5')), results(),
    user(notice('a3', 'completed', 'Agent done', `<result>Done: **two** files</result>\n${usageBlock(42_000)}`)),
    assistant(),
    user(notice('a4', 'failed', 'Agent failed', usageBlock(3000))),
    user(notice('a5', 'killed', 'Agent stopped')),
  ])
  expect(restored.agents).toEqual({
    a5: agentRow('a5', 'stopped'), a4: agentRow('a4', 'failed'), a3: agentRow('a3', 'done'),
  })
  expect(restored.log.slice(0, 6)).toEqual([
    line('engine', 'task-notification', 'info'), line('Explore', 'stopped', 'info'),
    line('engine', 'task-notification', 'info'), line('Explore', 'failed', 'error', '✗ 3.0s'),
    line('engine', 'task-notification', 'info'), line('Explore', 'done — Done: two files', 'ok', '✓ 42.0s'),
  ])
  expect(restored.logCount).toBe(9)
})

test('a background agent with no notice runs if alive, else has ended; so does one with no result', () => {
  const inFlight = call('Agent', AGENT_INPUT, { agentId: 'a9' })
  const rows = [assistant(launched('a6'), launched('a7'), inFlight)]
  const restored = restore(rows, new Set(['a6', 'a9']))
  expect(restored.agents).toEqual({
    a9: agentRow('a9', 'running', { model: null }), a7: agentRow('a7', 'ended'), a6: agentRow('a6', 'running'),
  })
  expect(restored.log).toEqual([SPAWNED, SPAWNED, SPAWNED])
  expect(restore(rows).agents.a9?.status).toBe('ended')
})

test('a TaskStop stops a running agent: the call line, then the stop', () => {
  const stop = call('TaskStop', { task_id: 'a8' }, { result: { message: 'Stopped', task_id: 'a8' }, text: 'Stopped' })
  const restored = restore([assistant(launched('a8')), results(), assistant(stop), results()])
  expect(restored.agents).toEqual({ a8: agentRow('a8', 'stopped') })
  expect(restored.log).toEqual([line('Explore', 'stopped', 'info'), line('main', 'TaskStop', 'ok', '✓'), SPAWNED])
})

test('background tasks: a Bash, a moved Bash and a Workflow, each closed or not', () => {
  const workflow = call('Workflow', { name: 'review' }, {
    result: { status: 'async_launched', taskType: 'local_workflow', taskId: 'w1', runId: 'r1' }, text: 'Launched',
  })
  const moved = bash('b2', { command: 'pytest -x' }, { backgroundedToDeliverMessage: true })
  const stop = call('TaskStop', { shell_id: 'b5' }, { result: { message: 'Stopped' }, text: 'Stopped' })
  const restored = restore([
    assistant(bash('b1', DEV), moved, workflow, bash('b3', DEV), bash('b4', DEV), bash('b5', DEV), bash('b6', DEV)),
    results(),
    user(notice('b1', 'completed', 'done')),
    user(notice('w1', 'completed', 'done', usageBlock(5000))),
    user(notice('b2', 'failed', 'failed')),
    user(notice('b3', 'killed', 'killed')),
    user(notice('b4', 'stopped', 'stopped')),
    assistant(stop), results(),
  ])
  expect(restored.tasks).toEqual({
    b6: taskRow('b6', 'ended'), b5: taskRow('b5', 'stopped'), b4: taskRow('b4', 'stopped'),
    b3: taskRow('b3', 'stopped'),
    w1: taskRow('w1', 'done', { kind: 'workflow', description: 'review', durationMs: 5000 }),
    b2: taskRow('b2', 'failed', { description: 'pytest -x' }), b1: taskRow('b1', 'done'),
  })
  expect(said(restored).slice(0, 12)).toEqual([
    'main: stopped · shell: Start the dev server', 'main: TaskStop ✓',
    'engine: task-notification', 'main: stopped · shell: Start the dev server',
    'engine: task-notification', 'main: stopped · shell: Start the dev server',
    'engine: task-notification', 'main: failed · shell: pytest -x',
    'engine: task-notification', 'main: done · workflow: review ✓ 5.0s',
    'engine: task-notification', 'main: done · shell: Start the dev server',
  ])
  expect(said(restored).slice(12)).toEqual([
    ...['b6', 'b5', 'b4', 'b3'].map(() => 'main: Bash npm run dev → background'),
    'main: Workflow → background', 'main: Bash pytest -x → background', 'main: Bash npm run dev → background',
  ])
  expect(restored.log.find(l => l.text === 'failed · shell: pytest -x')?.kind).toBe('error')
})

test('only typed prompts give `you` lines; a notice and a peer give their `engine` lines', () => {
  const skill = call('Skill', { skill: 'superpowers:brainstorming' }, { result: { success: true }, text: 'Launching' })
  const cases: [string, Fields[], string[]][] = [
    ['typed after an assistant row', [assistant(), user('fix the cart')], ['you: fix the cart']],
    ['typed after a command row', [user(COMMAND), user('now the totals')], ['you: now the totals']],
    ['typed after a notice', [user(notice('b9', 'completed', 'ok')), user('and then?')],
      ['you: and then?', 'engine: task-notification']],
    ['typed after an interrupt', [assistant(read('a.ts')), results(), user('[Request interrupted by user]'),
      user('do X instead')], ['you: do X instead', 'main: Read a.ts ✓']],
    ['a reminder before a prompt', [user('<system-reminder>\nToday is 2026-10-27.\n</system-reminder>\nship it')],
      ['you: ship it']],
    ['a peer message', [user('Another Claude session sent a message: hello')], ['engine: peer']],
    ['caveat, command and stdout rows', [
      user('<local-command-caveat>Caveat: The messages below were generated by the user.</local-command-caveat>'),
      user(COMMAND), user('<local-command-stdout>Set model to opus</local-command-stdout>'),
    ], []],
    ['a `!` row', [user('<bash-input>git status</bash-input>')], []],
    ['an empty (image-only) prompt', [user('')], []],
    ['the image companion right after a prompt', [user('what is this?'), user('[Image: source: /tmp/shot.png]')],
      ['you: what is this?']],
    ['the summary after a tool-results row', [assistant(read('a.ts')), results(), user(SUMMARY)], []],
    ['the summary after an assistant row', [assistant(), user(SUMMARY)], []],
    ['a skill note after a tool-results row', [assistant(skill), results(),
      user('Skill superpowers:brainstorming was loaded earlier in this conversation.')], ['main: Skill ✓']],
    ['a skill body after a tool-results row, and a body after a note', [assistant(skill), results(),
      user('(Re-invocation of superpowers:brainstorming)'),
      user('Base directory for this skill: /u/.claude/skills/brainstorming\n\n# Brainstorming\n\nAsk first.'),
    ], ['main: Skill ✓']],
    ['a bundled skill\'s bare title after a tool-results row', [assistant(skill), results(),
      user('# Simplify\n\nReview the changed code.')], ['main: Skill ✓']],
    ['an interrupt after a tool-results row', [assistant(read('a.ts')), results(),
      user('[Request interrupted by user for tool use]')], ['main: Read a.ts ✓']],
  ]
  for (const [name, rows, lines] of cases) expect(said(restore(rows)), name).toEqual(lines)
})

test('the walk starts after the latest summary: each call once', () => {
  const tail = [user('the tail prompt'), assistant(read('tail.ts')), results(), assistant()]
  const newer = [user('a newer prompt'), assistant(launched('a1'), bash('b1', DEV)), results(), assistant()]
  const older =
    [user('an old prompt'), assistant(read('old.ts'), launched('a0'), bash('b0', DEV)), results(), assistant()]
  const expected = [
    'main: Bash npm run dev → background', 'main: spawned · Explore: Map the flow', 'you: a newer prompt',
    'main: Read tail.ts ✓', 'you: the tail prompt',
  ]
  const inProcess = restore([...older, ...tail, user(SUMMARY), ...tail, ...newer])
  expect(said(inProcess)).toEqual(expected)
  expect(Object.keys(inProcess.agents)).toEqual(['a1'])
  expect(Object.keys(inProcess.tasks)).toEqual(['b1'])
  expect(said(restore([user(SUMMARY), ...tail, ...newer]))).toEqual(expected)
})

test('SendMessage: to a known agent no line, to an unknown one a line; failed calls give ✗ lines', () => {
  const send = (to: string, more: Fields = { result: { success: true }, text: 'Sent' }): Fields =>
    call('SendMessage', { to, message: 'go on' }, more)
  const failed = { result: 'No such agent', text: 'No such agent', isError: true }
  const restored = restore([
    assistant(launched('a1'), send('a1'), send('nobody'), send('a1', failed)),
    assistant(call('Agent', AGENT_INPUT, failed), call('Agent', AGENT_INPUT, { result: { status: 'ok' } })),
    assistant(call('SubagentHandback', { message: 'report' }, { result: {} })),
  ])
  expect(said(restored)).toEqual([
    'main: Agent → Explore: Map the flow ✗', 'main: SendMessage ✗', 'main: SendMessage ✓',
    'main: spawned · Explore: Map the flow',
  ])
  expect(restored.log[0]?.kind).toBe('error')
})

test('a call: ✓ or ✗ with no time, and no outcome while it runs', () => {
  const restored = restore([assistant(
    read('a.ts'), call('Bash', { command: 'false' }, { result: 'Exit code 1', text: 'Exit code 1', isError: true }),
    call('Grep', { pattern: 'TODO' }), call('Glob', { pattern: '*.ts' }, { text: 'a.ts' }),
  )])
  expect(restored.log).toEqual([
    line('main', 'Glob *.ts', 'ok', '✓'), line('main', 'Grep TODO', 'info'), line('main', 'Bash false', 'error', '✗'),
    line('main', 'Read a.ts', 'ok', '✓'),
  ])
})

test('the Log keeps the newest 200 lines, newest first, and counts all; rows come newest first', () => {
  const reads = Array.from({ length: 250 }, (_, i) => assistant(read(`f${i}.ts`)))
  const restored = restore([assistant(launched('a1'), launched('a2'), bash('b1', DEV), bash('b2', DEV)), ...reads])
  expect(restored.log).toHaveLength(200)
  expect(restored.logCount).toBe(254)
  expect(restored.log[0]?.text).toBe('Read f249.ts')
  expect(restored.log[199]?.text).toBe('Read f50.ts')
  expect(Object.keys(restored.agents)).toEqual(['a2', 'a1'])
  expect(Object.keys(restored.tasks)).toEqual(['b2', 'b1'])
})

test('a secret with no closing quote is masked as a prompt, a command, a description and a notice result', () => {
  const secret = `{"password": "hunter2${'a'.repeat(100_000)}`
  const restored = restore([
    user(secret),
    assistant(call('Bash', { command: secret }, { result: {}, text: 'ok' }), launched('m1', { description: secret })),
    results(),
    user(notice('m1', 'completed', 'done', `<result>${secret}</result>\n`)),
  ])
  expect(restored.logCount).toBe(5)
  expect(JSON.stringify(restored)).not.toContain('hunter2')
})

test('canaries: no never-drawn field reaches the result', () => {
  const canary = (field: string): string => `CANARY_${field}`
  const rows: unknown[] = [
    user(`${SUMMARY} ${canary('SUMMARY')}`),
    user('a prompt'),
    {
      role: 'assistant', text: canary('ASSISTANT_TEXT'), toolUses: [
        call('Read', { file_path: `${ROOT}/a.ts` }, {
          result: { file: { content: canary('READ_RESULT') } }, text: canary('READ_TEXT'),
          meta: { 'claude/plugins': canary('USE_META') },
        }),
        call('Bash', { command: 'make' }, {
          result: canary('ERROR_RESULT'), text: canary('ERROR_TEXT'), isError: true,
        }),
        call('Edit', { file_path: `${ROOT}/a.ts`, old_string: canary('EDIT_OLD'), new_string: canary('EDIT_NEW') }, {
          result: canary('DENIED'), text: canary('DENIED_TEXT'), isError: true,
        }),
        call('Write', { file_path: `${ROOT}/b.ts`, content: canary('WRITE_BODY') }, { result: {}, text: 'ok' }),
        call('Agent', { ...AGENT_INPUT, prompt: canary('INPUT_PROMPT') }, {
          agentId: 'a1', text: canary('LAUNCH_TEXT'), result: {
            status: 'async_launched', agentId: 'a1', prompt: canary('RESULT_PROMPT'), outputFile: canary('OUTPUT_FILE'),
          },
        }),
        call('SendMessage', { to: 'a1', message: canary('SEND_KNOWN') }, { result: {}, text: canary('SEND_TEXT') }),
        call('SendMessage', { to: 'x', message: canary('SEND_UNKNOWN') }, { result: {}, text: canary('SEND_TEXT') }),
        bash('b1', DEV),
        call('Agent', AGENT_INPUT, {
          agentId: 'a2', result: canary('AGENT_ERROR_RESULT'), text: canary('AGENT_ERROR_TEXT'), isError: true,
        }),
      ],
    },
    {
      role: 'user', text: '', toolUses: [], toolResults: [{
        tool_use_id: 'toolu_r', text: canary('RESULTS_TEXT'), isError: false, result: canary('RESULTS_RESULT'),
        meta: { 'claude/plugins': canary('RESULTS_META') },
      }],
    },
    user(notice('a1', 'completed', canary('NOTICE_SUMMARY'), '<result>the answer</result>\n')),
    user(notice('b1', 'completed', 'done', `<result>${canary('TASK_RESULT')}</result>\n`)),
  ]
  const restored = restore(rows)
  expect(restored.logCount).toBe(15)
  expect(restored.tasks.b1?.status).toBe('done')
  expect(JSON.stringify(restored)).not.toContain('CANARY')
})

test('untrusted rows: wrong types are skipped, and odd ids stay own keys', () => {
  const odd = ['__proto__', 'constructor', 'toString']
  const restored = restore([
    null, 42, 'text', [], { role: 7 }, { role: 'user', text: 5 }, { role: 'user', text: ['x'], toolResults: 'no' },
    { role: 'assistant', toolUses: 'Bash' },
    { role: 'assistant', text: 3, toolUses: [null, 3, 'Read', { tool: 5 }, { tool: 'Bash', input: 'ls' },
      { tool: 'Read', input: { file_path: 9 }, result: 3, isError: 'yes' },
      { tool: 'Agent', agentId: 7, input: { description: 1, subagent_type: 2 }, result: { status: 'completed' } },
      { tool: 'Agent', agentId: 'n1', input: { description: 1, subagent_type: 2, name: [] }, durationMs: '5',
        result: { status: 'completed', resolvedModel: 3 }, text: 4 },
      ...odd.map(id => launched(id)), ...odd.map(id => bash(id, DEV)),
    ] },
    user(notice('toString', 'completed', 'done', '<result>fine</result>\n')),
    user(notice('constructor', 'failed', 'failed')),
  ], new Set(odd))
  expect(Object.getPrototypeOf(restored.agents)).toBe(Object.prototype)
  expect(Object.getPrototypeOf(restored.tasks)).toBe(Object.prototype)
  expect(Object.keys(restored.agents)).toEqual(['toString', 'constructor', '__proto__', 'n1'])
  expect(Object.keys(restored.tasks)).toEqual(['toString', 'constructor', '__proto__'])
  expect(odd.map(id => Object.hasOwn(restored.agents, id) && restored.agents[id]?.status)).toEqual([
    'running', 'running', 'running',
  ])
  expect(restored.agents.n1).toEqual(agentRow('n1', 'done', { description: '', type: 'agent', model: null }))
  expect(odd.map(id => restored.tasks[id]?.status)).toEqual(['ended', 'failed', 'done'])
  expect(said(restored).slice(0, 6)).toEqual([
    'engine: task-notification', 'main: failed · shell: Start the dev server',
    'engine: task-notification', 'main: done · shell: Start the dev server',
    'main: Bash npm run dev → background', 'main: Bash npm run dev → background',
  ])
  expect(said(restored)).toContain('main: Bash')
  expect(said(restored)).toContain('main: Read ✓')
  expect(said(restored)).toContain('agent: done ✓')
})

test('a tool name over 256 units is absent: no line, no row, and no slow label', () => {
  // The line end fails the match of toolLabel's `^mcp__(.+?)__(.+)$` at each `__`: 24 K units take ~120 ms each.
  const crafted = Array.from({ length: 200 }, () => call(`mcp__${'__x'.repeat(8000)}\n`, {}, { result: {} }))
  const started = performance.now()
  const restored = restore([assistant(...crafted)])
  expect(performance.now() - started).toBeLessThan(500)
  expect(restored.logCount).toBe(0)
  const longest = `mcp__s__${'x'.repeat(248)}`
  expect(longest).toHaveLength(256)
  expect(restore([assistant(call(longest, {}, { result: {} }), call(`${longest}x`, {}, { result: {} }))]).logCount)
    .toBe(1)
})

test('only a running row closes: a notice after a TaskStop, and the same notice twice, close once', () => {
  const stop = call('TaskStop', { task_id: 'b1' }, { result: { message: 'Stopped' }, text: 'Stopped' })
  const stopped = restore([assistant(bash('b1', DEV), stop), user(notice('b1', 'completed', 'done'))])
  expect(stopped.tasks).toEqual({ b1: taskRow('b1', 'stopped') })
  expect(said(stopped)).toEqual([
    'engine: task-notification', 'main: stopped · shell: Start the dev server', 'main: TaskStop ✓',
    'main: Bash npm run dev → background',
  ])
  const twice = restore([
    assistant(bash('b1', DEV), launched('a1')),
    user(notice('b1', 'completed', 'done')), user(notice('b1', 'failed', 'failed')),
    user(notice('a1', 'completed', 'done', '<result>ok</result>\n')), user(notice('a1', 'killed', 'stopped')),
  ])
  expect(twice.tasks).toEqual({ b1: taskRow('b1', 'done') })
  expect(twice.agents).toEqual({ a1: agentRow('a1', 'done') })
  expect(said(twice)).toEqual([
    'engine: task-notification', 'engine: task-notification', 'Explore: done — ok ✓',
    'engine: task-notification', 'engine: task-notification', 'main: done · shell: Start the dev server',
    'main: spawned · Explore: Map the flow', 'main: Bash npm run dev → background',
  ])
})

test('a TaskStop that failed closes nothing', () => {
  const stop = call('TaskStop', { task_id: 'b1' }, { result: 'No task b1', text: 'No task b1', isError: true })
  const restored = restore([assistant(bash('b1', DEV), launched('a1')), assistant(stop, call('TaskStop', {
    task_id: 'a1',
  }, { result: 'No task a1', text: 'No task a1', isError: true }))], new Set(['a1']))
  expect(restored.tasks).toEqual({ b1: taskRow('b1', 'ended') })
  expect(restored.agents).toEqual({ a1: agentRow('a1', 'running') })
  expect(said(restored).slice(0, 2)).toEqual(['main: TaskStop ✗', 'main: TaskStop ✗'])
})

test('odd ids on the agent path: __proto__, constructor and toString are closed by their notices', () => {
  const odd = ['__proto__', 'constructor', 'toString']
  const restored = restore([
    assistant(...odd.map(id => launched(id))),
    user(notice('__proto__', 'completed', 'done', '<result>fine</result>\n')),
    user(notice('constructor', 'failed', 'failed')),
    user(notice('toString', 'killed', 'stopped')),
  ])
  expect(Object.getPrototypeOf(restored.agents)).toBe(Object.prototype)
  expect(odd.map(id => Object.hasOwn(restored.agents, id) && restored.agents[id]?.status)).toEqual([
    'done', 'failed', 'stopped',
  ])
  expect(said(restored).slice(0, 6)).toEqual([
    'engine: task-notification', 'Explore: stopped', 'engine: task-notification', 'Explore: failed ✗',
    'engine: task-notification', 'Explore: done — fine ✓',
  ])
})

test('model: format characters go, and an empty name or one of 65 units is none', () => {
  const model = (resolvedModel: unknown, inputModel?: unknown): string | null | undefined => restore([assistant(
    call('Agent', { ...AGENT_INPUT, model: inputModel }, {
      agentId: 'a1', result: { status: 'async_launched', resolvedModel },
    }),
  )]).agents.a1?.model
  expect(model('claude-\u{202E}opus-5')).toBe('claude-opus-5')
  expect(model('x'.repeat(64))).toBe('x'.repeat(64))
  expect(model('x'.repeat(65))).toBe(null)
  expect(model(5, 'opus')).toBe('opus')
  expect(model(undefined, 7)).toBe(null)
  expect(model('')).toBe(null)
  expect(model('\u{202E}')).toBe(null)
})

test('4096 rows of large texts restore well within the timeout', () => {
  const big = `${'word '.repeat(3000)}`
  const rows = Array.from({ length: 4096 }, (_, i) => i % 2 === 0
    ? user(`${big}${i}`)
    : assistant(
      call('Bash', { command: big }, { result: {}, text: big }),
      launched(`a${i}`, { ...AGENT_INPUT, description: big }),
    ))
  const started = performance.now()
  const restored = restore(rows)
  expect(performance.now() - started).toBeLessThan(2500)
  expect(restored.logCount).toBe(2048 * 3)
})

test('cutAtTurn drops the turn that the text opened, from its row on', () => {
  const rows = [user('first'), assistant(read('a.ts')), results(), assistant(), user('second'), assistant(), results()]
  expect(cutAtTurn(rows, 'second')).toEqual(rows.slice(0, 4))
  expect(cutAtTurn(rows, '<system-reminder>r</system-reminder>\nsecond')).toEqual(rows.slice(0, 4))
  // An older identical prompt is never the cut point.
  expect(cutAtTurn(rows, 'first')).toEqual(rows)
  const opened = [...rows, user(notice('b1', 'completed', 'done')), assistant()]
  expect(cutAtTurn(opened, notice('b1', 'completed', 'done'))).toEqual(rows)
  expect(cutAtTurn([], 'second')).toEqual([])
})

test('cutAtTurn passes over a mid-turn row: a prompt kind right after tool results opens no turn', () => {
  const skill = call('Skill', { skill: 'simplify' }, { result: { success: true }, text: 'Launching' })
  const rows = [user('fix it'), assistant(skill), results(), user('# Simplify\n\nReview the changed code.')]
  expect(cutAtTurn(rows, 'fix it')).toEqual([])
})
