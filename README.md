# session-panel

A live session-stats side pane for the Claude desktop app's Code tab, built as a Claude Code mod.

## What it shows

The pane redraws as the session runs. Every section below the Session and Project blocks can be folded; the choice
is remembered.

- **Session**: the session's total cost; a context meter (tokens against the window, in percent); the
  Session / Subagents split once subagents have run. The window is the one auto-compaction uses, so a custom
  `autoCompactWindow` is honoured.
- **Project**: the project folder, its git branch, and the working tree's changes against HEAD: `12 files changed`
  and `+2061 / −111`. New files count too, with their lines counted for the first 50. It is read again a second
  after any agent edits a file or runs a command. Outside a repository only the folder shows; a clean tree has no
  changes row.
- **Usage**: the plan limits (5-hour, Weekly, Spend) as meters with a countdown to each reset. Hidden when the engine
  reports no plan limits, for example with an API key or a third-party provider.
- **Turn stats**: the last finished turn of the main agent (a turn stopped before any response leaves the previous
  one shown): response and whole-turn speed (tok/s), elapsed, model and tool time, average time to first token,
  steps, tokens in and out, cache hit rate and cost.
- **Subagents**: up to 8 rows, running ones first, in columns: a status mark, the description, `@type` and cost; the
  rest are counted as `+N more`. In a narrow pane `@type` gives way first. A subagent resumed with SendMessage shows
  as running again.
- **MCP**: the servers that have tools in the context, by name, with their count. The desktop app's own servers
  (`ccd_*`, `Claude_Browser`, `scheduled-tasks`, `terminal`) are hidden and not counted.
- **Context sources**: how many skills and MCP servers feed the context.
- **Log**: the latest 15 of the last 60 events, newest first: prompts, tool calls, subagent spawns, resumes and
  results (a successful Agent call, a SendMessage to a known subagent or a subagent's `SubagentHandback` is not
  logged: their lines say it), compactions. Tool calls and subagent results both carry their outcome (✓/✗ and the
  time, or denied) in a right-aligned column. In auto mode a subagent's `done` line shows the report it handed back.
  In a narrow pane the `who` column gives way first, and then the outcome moves in front of the text. Common secret
  patterns (tokens, keys, passwords in URLs and flags) are masked.

## How costs are measured

There is no price table and no network access. After every model request the mod reads the engine's own `cost.usd`
and attributes the increase to the agent whose step has just finished, the main agent or a subagent. The figure at
the top is the engine's Total; Subagents is the sum of what the subagents were charged; Session = Total − Subagents.

## What the mod does not do

- No network access.
- No reading of credentials, environment variables or settings.
- No disk writes except `$.store`, where it keeps which sections are folded.
- Its hooks only observe: prompts, tool calls and their results pass through unchanged.
- Read-only git commands only: `branch`, `rev-parse`, `status` and `diff`.
- They never take git's index lock, use no fsmonitor, and run no textconv or external diff program.
- The mod reads no file itself: git counts the lines.

## Install

Requires Claude Code with mods support (engine 2.1.288 tested).

```bash
claude plugin marketplace add <path to this repository>
claude plugin install session-panel@claude-mods
```

On the desktop the pane opens by itself when a session starts. `/session-panel` opens or closes it; in a terminal it
is the only way to open it. It works mid-turn too.

## Development

The engine hot-reloads a mod from the session's dev folder at the end of the main agent's turn. After each edit,
sync the sources there:

```bash
rsync -a --delete --exclude '.claude-plugin/types/' --exclude '/tsconfig.json' \
  plugins/session-panel/ ~/.claude/dev-mods/<session-id>/session-panel/
```

The two excludes keep the files the engine writes into that folder itself. Checks:

```bash
claude plugin test plugins/session-panel
claude plugin validate plugins/session-panel
```

After installing the plugin from the marketplace, delete the session's dev copy
(`~/.claude/dev-mods/<session-id>/session-panel/`), or that session loads the mod twice.

## Credits

Parts of the mod follow these MIT-licensed projects, and the borrowed code is marked in comments.

- [OpenChamber](https://github.com/openchamber/openchamber) (© 2025 Bohdan Triapitsyn): the panel layout and the
  turn-stats and subagent-cost formulas.
- [claude-flightdeck](https://github.com/scasella/claude-flightdeck) (© 2026 Stephen Casella): the `redact` patterns
  and the session-log design.
- Desktop Statusline by George Liu ([centminmod/claude-plugins](https://github.com/centminmod/claude-plugins)): the
  SVG meter, its colours and thresholds, and the countdown format.

Their license notices are in [THIRD_PARTY_NOTICES.md](plugins/session-panel/THIRD_PARTY_NOTICES.md).

## License

MIT, see [LICENSE](LICENSE). The plugin folder (`plugins/session-panel/`) carries its own copy of the license and the
third-party notices, so an installed copy keeps them.
