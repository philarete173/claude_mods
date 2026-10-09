# session-panel

A live session-stats side pane for the Claude desktop app's Code tab, built as a Claude Code mod.

## What it shows

The pane redraws as the session runs. Every section below the Session and Project blocks can be folded; the choice
is remembered. A press keeps what another session folded: it builds on the map in the store and flips one section.
A copy of the mod read from a folder (`--plugin-dir`, a dev-mods copy) and the installed copy keep separate fold
states: the store file follows the plugin's identity, `session-panel@inline` against `session-panel@claude-mods`.

- **Session**: the session's total cost; a context meter (tokens against the window, in percent); the
  Session / Subagents split once subagents have run. The window is the one auto-compaction uses, so a custom
  `autoCompactWindow` is honoured.
- **Project**: the project folder, its git branch, and the working tree's changes against HEAD: `12 files changed`
  and `+2061 / −111`. New files count too, with their lines counted for the first 50. A count that is only a lower
  bound is marked with a plus: `+2061+ / −111` when new files went uncounted, and `12+ files changed`, with no line
  numbers, when git's status output was cut (it has a 4 MiB limit). A lower bound of no lines shows no numbers, as
  unknown lines do (for example, a SHA-256 repository with only new files, or a first new-file count that failed). The
  changes are read from the first turn of the main agent on; before it only the folder and the branch show. They are
  read again about a second after an agent edits a file or runs a command that is not read-only, and once a minute while
  the pane is shown, so that edits made outside Claude's tools (an editor, a terminal, a background command that ended
  after its call returned) show without a new turn; opening the pane reads at once, and after a slow read the next one
  waits four times as long as that read took, at most four minutes. A folder whose `git status` times out twice in a
  row, such as a dotfiles repository in `$HOME`, is given up for changes while the mod lives (until another folder has
  been read); its branch still shows. Outside a repository only the folder shows; a clean tree has no changes row.
- **Usage**: the plan limits (5-hour, Weekly, Spend) as meters with a countdown to each reset. Hidden when the engine
  reports no plan limits, for example with an API key or a third-party provider.
- **Turn stats**: the last finished turn of the main agent (a turn stopped before any response leaves the previous
  one shown): response and whole-turn speed (tok/s), elapsed, model and tool time, average time to first token,
  steps, tokens in (all the input: what was not cached, what was read from the cache and what was written to it) and
  out, cache hit rate and cost.
- **Subagents**: up to 8 rows, running ones first, in columns: a status mark, the description, `@type` and cost; the
  rest are counted as `+N more`. In a narrow pane `@type` gives way first. A subagent resumed with SendMessage shows
  as running again.
- **MCP**: the servers that have tools in the context, by name, with their count. The desktop app's own servers
  (`ccd_*`, `Claude_Browser`, `scheduled-tasks`, `terminal`) are hidden and not counted.
- **Context sources**: how many skills and MCP servers feed the context.
- **Log**: the last 60 events, newest first, as many lines as the pane's body has rows and at least 8: the first 8
  always show, and the rest fill the height that the other blocks leave and are cut at the bottom, so the oldest go
  first. Folding another section gives the Log its room; when not even 8 lines fit, the pane scrolls; where the body's
  height is not known, it draws 15 lines, as 0.2.0 did. The events are prompts, tool calls, subagent spawns, resumes
  and results (a successful Agent call, a SendMessage to a known subagent or a subagent's `SubagentHandback` is not
  logged: their lines say it), compactions. Tool calls and subagent results both carry their outcome (✓/✗ and the
  time, or denied) in a right-aligned column. A call that comes back as an error because it was abandoned (you
  interrupted it, or a stop did) is not drawn as an error: it is not red, its `who` and outcome are dim as on every line
  that is no error, and its outcome is the time alone, with no ✗; this rests on the engine's `next.signal` and is to be
  confirmed live. A subagent's answer loses its markdown marks (paired `**`, backticks, a heading's `#`).
  In auto mode a subagent's `done` line shows the report it handed back, even when auto mode withheld or flagged it;
  the text is masked as any other, and the main agent did not get it, a known limitation. In a narrow pane the `who`
  column gives way first, and then the outcome moves in front of the text; where there is no `who`, a prompt reads
  `you › …` and an engine message (a tagged one, such as `agent-message`) reads `engine › …`. Unicode format
  characters (the bidi controls, zero-width spaces and joiners, the BOM) are taken out of the branch, the folder name,
  the Subagents rows, the MCP server names and every log text, since a U+202E would reorder what the pane shows; as a
  side effect, an emoji sequence joined by ZWJ shows as separate emoji, and scripts that use ZWNJ or ZWJ lose them.
  Common secret patterns (tokens, keys, passwords in URLs and flags) are masked.

## How costs are measured

There is no price table and no network access. After every model request the mod reads the engine's own `cost.usd`
and attributes the increase to the agent whose step has just finished, the main agent or a subagent. The figure at
the top is the engine's Total; Subagents is the sum of what the subagents were charged; Session = Total − Subagents.

With subagents running at once the split is approximate: steps that overlap can charge one agent for another's
request. The same subagent was measured at $0.100 beside a parallel review and $0.046 alone. The totals stay exact:
Total = Session + Subagents.

## What the mod does not do

- No network access.
- No reading of credentials, environment variables or settings.
- No disk writes except `$.store`, where it keeps which sections are folded.
- Its hooks only observe: prompts, tool calls and their results pass through unchanged.
- Read-only git commands only: `branch`, `rev-parse`, `status` and `diff`.
- They never take git's index lock or rewrite the index, use no fsmonitor, run no textconv or external diff program,
  do not walk a submodule's work tree (`--ignore-submodules=dirty`), and fetch nothing in a partial clone (git 2.44 or
  later, and some distributions' 2.43 builds, which backport it; other git ignores it).
- Git still runs the filters you configured, such as Git LFS, as it does for any `git status`.
- That is why `status` and `diff` wait for the first turn of the main agent, once per session: they can run filters
  that the repository's own config names, and a turn cannot start before you have accepted the folder. Before it the
  mod reads the folder and the branch only (`git branch` runs no filters). A reload of the mod waits for the next turn
  again.
- Untracked files are read with no `.gitattributes` filter: `GIT_ATTR_SOURCE` points at git's empty tree, so no
  attribute-selected filter (a clean or process filter, Git LFS) runs on one. A git that does not know the variable
  ignores it. `.git/info/attributes` and your own attributes file (`core.attributesFile`) still apply: they are local
  config that no clone brings.
- A read gives up early: the count of new files stops at its first failure, and the changes of a folder are no longer
  read once two `git status` calls in a row have timed out or failed to start.
- The mod reads no file itself: git counts the lines.

## Install

Requires Claude Code with mods support (engine 2.1.288 tested).

```bash
claude plugin marketplace add <path to this repository>
claude plugin install session-panel@claude-mods
```

On the desktop the pane opens by itself when a session starts. `/session-panel` opens or closes it; in a terminal it
is the only way to open it. It works mid-turn too.

### Update

An installed copy does not follow the repository: the engine loads a snapshot from
`~/.claude/plugins/cache/claude-mods/session-panel/<version>/`, so an edit in the repository reaches the installed mod
only after an update. Update it, then start a new session:

```bash
claude plugin marketplace update claude-mods
claude plugin update session-panel@claude-mods
```

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

To release a change, bump `version` in both `plugins/session-panel/.claude-plugin/plugin.json` and
`.claude-plugin/marketplace.json`, then update the installed copy as under Install.

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
