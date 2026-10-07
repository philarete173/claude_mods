// SPIKE: a throwaway module that probes how the engine APIs really behave. Task 3 replaces it.
// Observations are kept in memory and copied to .spike/results.json, at most once per 2 s.
// Every hook only observes: it returns what next(e) returned.
// Helpers that take `$` sit at the top level: `claude plugin validate` follows `$` only into those.
// The main loop and the subagents have separate rings, so a busy subagent cannot evict main-loop entries.
import type { EngineInterface, Register } from 'claude-code'

const PANE = 'session-panel'
const RESULTS_PATH = '/home/philarete/projects/claude_mods/.spike/results.json'
const WRITE_DELAY_MS = 2000
const MCP_PROBE_DELAY_MS = 5000

type Results = {
  engine: unknown
  time: unknown
  pane: unknown[]
  // Running totals: the rings below forget old entries, these do not.
  counters: { mainSteps: number; agentSteps: number; mainCost: number; agentCost: number }
  steps: unknown[]
  agentSteps: unknown[]
  cost: unknown[]
  agentCost: unknown[]
  mcp: unknown
  spawn: unknown[]
  agentComplete: unknown[]
  agentList: unknown[]
  measure: unknown[]
  postTool: unknown[]
  toolCalls: unknown[]
  agentToolCalls: unknown[]
  breakdown: unknown
}

// A reload starts these over, which is fine for a spike.
const results: Results = {
  engine: null,
  time: null,
  pane: [],
  counters: { mainSteps: 0, agentSteps: 0, mainCost: 0, agentCost: 0 },
  steps: [],
  agentSteps: [],
  cost: [],
  agentCost: [],
  mcp: null,
  spawn: [],
  agentComplete: [],
  agentList: [],
  measure: [],
  postTool: [],
  toolCalls: [],
  agentToolCalls: [],
  breakdown: null,
}
let isWritePending = false
let lastWrite = 'never'

// Runs one probe; a failure becomes data ({ error }) instead of breaking the hook.
const attempt = async (probe: () => unknown): Promise<unknown> => {
  try {
    return await probe()
  } catch (err) {
    return { error: String(err) }
  }
}

// Appends an entry to a list that keeps only its last `max` entries.
const keepLast = (list: unknown[], entry: unknown, max: number): void => {
  list.push(entry)
  list.splice(0, list.length - max)
}

// Writes the results to disk. The caller drops a rejection: nothing here may break a timer.
const flush = async ($: EngineInterface): Promise<void> => {
  isWritePending = false
  try {
    await $.fs.write(RESULTS_PATH, JSON.stringify(results, null, 2))
    lastWrite = new Date(await $.clock.now()).toTimeString().slice(0, 8)
  } catch (err) {
    lastWrite = `failed: ${String(err)}`
  }
  $.ui.invalidate('ui.render')
}

// Asks for a write 2 s after the first change; later changes ride along.
const schedule = ($: EngineInterface): void => {
  if (isWritePending) {
    return
  }
  isWritePending = true
  $.clock.after(WRITE_DELAY_MS, () => {
    flush($).catch(() => undefined)
  })
}

// Records the session cost the engine reports right now, in the ring of the loop the sample belongs to.
const sampleCost = async ($: EngineInterface, event: string, agentId: string | null): Promise<void> => {
  const t = await $.clock.now()
  const usd = await attempt(async () => (await $.session.usage()).cost?.usd ?? null)
  const isAgent = agentId !== null
  keepLast(isAgent ? results.agentCost : results.cost, { t, event, agentId, usd }, 30)
  results.counters[isAgent ? 'agentCost' : 'mainCost'] += 1
  schedule($)
}

// Opens the pane the way the real mod will and records whether the engine placed it.
const probePane = async ($: EngineInterface, event: string, e: { surface?: string | null }): Promise<void> => {
  const result = await attempt(() => $.ui.open({ id: PANE, title: 'Session' }))
  const surfaces = await $.session.surfaces()
  keepLast(results.pane, { event, surface: e.surface ?? null, surfaces, result }, 10)
}

// Calls the built-in WaitForMcpServers tool and times it. Runs from a timer, never inside a hook.
const probeMcp = async ($: EngineInterface): Promise<void> => {
  const startedAt = await $.clock.now()
  try {
    const result = await $.tool.call({ tool: 'WaitForMcpServers' })
    const ms = (await $.clock.now()) - startedAt
    results.mcp = { ok: result.deny === undefined && result.isError !== true, ms, result }
  } catch (err) {
    results.mcp = { ok: false, ms: (await $.clock.now()) - startedAt, error: String(err) }
  }
  schedule($)
}

// The same record for a tool that succeeded and for one that failed.
const recordPostTool = (
  $: EngineInterface,
  e: { tool_name: string; duration_ms?: number; agent_id?: string },
): void => {
  keepLast(
    results.postTool,
    {
      keys: Object.keys(e),
      tool_name: e.tool_name,
      duration_ms: e.duration_ms ?? null,
      agent_id: e.agent_id ?? null,
    },
    10,
  )
  schedule($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    $.clock.after(MCP_PROBE_DELAY_MS, () => {
      probeMcp($).catch(() => undefined)
    })
    results.engine = await attempt(async () => (await $.session.version()).version)
    results.time = await attempt(() => ({
      toTimeString: new Date().toTimeString(),
      tzOffset: new Date().getTimezoneOffset(),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }))
    await probePane($, 'session.start', e)
    results.breakdown = await attempt(async () => {
      const breakdown = (await $.session.usage({ breakdown: 'summary' })).context.breakdown ?? null
      const isLarge = JSON.stringify(breakdown).length > 2000

      return isLarge ? { skills: breakdown?.skills, mcpTools: breakdown?.mcpTools } : breakdown
    })
    schedule($)

    return ran
  })

  on('session.attach', async ($, e, next) => {
    const ran = await next(e)
    await probePane($, 'session.attach', e)
    schedule($)

    return ran
  })

  on('turn.start', async ($, e, next) => {
    const ran = await next(e)
    await sampleCost($, 'turn.start', null)

    return ran
  })

  // One model request. Records when the first chunk of each kind arrives, as ms after tStart, all via
  // $.clock.now(): at most 7 awaits per step (tStart, then the first chunk of each of the 6 kinds).
  // Chunks pass on unchanged.
  on('turn.step', async function* ($, e, next) {
    const tStart = await $.clock.now()
    const kinds: string[] = []
    const kindCounts: Record<string, number> = {}
    const firstAt: Record<string, number> = {}

    for await (const chunk of next(e)) {
      if (kinds.length < 15) {
        kinds.push(chunk.kind)
      }
      kindCounts[chunk.kind] = (kindCounts[chunk.kind] ?? 0) + 1
      if (firstAt[chunk.kind] === undefined) {
        firstAt[chunk.kind] = (await $.clock.now()) - tStart
      }
      if (chunk.kind === 'stop') {
        const { agentId } = e
        const isAgent = agentId !== undefined
        const { usage } = chunk
        keepLast(
          isAgent ? results.agentSteps : results.steps,
          {
            keys: Object.keys(e),
            agentId: agentId ?? null,
            turnId: e.turnId,
            model: e.model,
            kinds: [...kinds],
            kindCounts: { ...kindCounts },
            // tStart is the clock itself; every t* after it is ms since tStart.
            tStart,
            tFirstAny: Math.min(...Object.values(firstAt)),
            tFirstThinking: firstAt.thinking ?? null,
            tFirstText: firstAt.text ?? null,
            tFirstTool: firstAt.tool ?? null,
            tFirstInput: firstAt.input ?? null,
            tEnd: firstAt.stop ?? null,
            outputTokens: usage?.output_tokens ?? null,
            usage,
          },
          12,
        )
        results.counters[isAgent ? 'agentSteps' : 'mainSteps'] += 1
        // A subagent step: sample the cost now and again later. Timers keep the stream free of awaits.
        if (isAgent) {
          $.clock.after(1, () => {
            sampleCost($, 'agent-stop', agentId).catch(() => undefined)
          })
          $.clock.after(1500, () => {
            sampleCost($, 'agent-stop+1.5s', agentId).catch(() => undefined)
          })
        }
        schedule($)
      }

      yield chunk
    }
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    const at = await $.clock.now()
    await sampleCost($, 'turn.complete', e.agentId ?? null)
    keepLast(results.agentList, { at, agentId: e.agentId ?? null, list: await attempt(() => $.agent.list()) }, 3)
    if (e.agentId !== undefined) {
      keepLast(
        results.agentComplete,
        {
          agentId: e.agentId,
          at,
          keys: Object.keys(e),
          reason: e.reason,
          isAborted: e.isAborted,
          durationMs: e.durationMs,
          usage: e.usage ?? null,
          answerType: typeof e.answer,
        },
        5,
      )
    }
    schedule($)

    return ran
  })

  on('session.measure', async ($, e, next) => {
    const ran = await next(e)
    keepLast(results.measure, { changed: e.changed, keys: Object.keys(e) }, 10)
    await sampleCost($, 'session.measure', null)

    return ran
  })

  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    keepLast(results.spawn, { keys: Object.keys(e), result: ran }, 5)
    schedule($)

    return ran
  })

  // Times every tool call as this hook sees it. classic.PostToolUse(Failure) did not fire in a live run.
  on('tool.call', async ($, e, next) => {
    const t0 = await $.clock.now()
    const ran = await next(e)
    const t1 = await $.clock.now()
    const outcome = ran.deny !== undefined ? 'deny' : ran.isError === true ? 'error' : 'ok'
    keepLast(
      e.agentId === undefined ? results.toolCalls : results.agentToolCalls,
      { tool: e.tool, agentId: e.agentId ?? null, ms: t1 - t0, outcome },
      20,
    )
    schedule($)

    return ran
  })

  on('classic.PostToolUse', ($, e, next) => {
    recordPostTool($, e)

    return next(e)
  })

  on('classic.PostToolUseFailure', ($, e, next) => {
    recordPostTool($, e)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const c = results.counters

    return (
      <Box flexDirection="column">
        <Text>{`spike: ${c.mainSteps + c.agentSteps} steps, ${c.mainCost + c.agentCost} cost samples`}</Text>
        <Text dimColor>{`last write: ${lastWrite}`}</Text>
      </Box>
    )
  })
}
