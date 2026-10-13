# Changelog

## 0.4.1 — 2026-10-13

- `/session-panel` only opens the pane, or asks to bring it forward. It no longer closes it: a lone pane counts as
  shown even behind a built-in tab such as Terminal, so the command closed a pane it should have raised. The pane's
  close mark closes it (ctrl+x x in a terminal).
- A folder whose changes were given up after two failed reads is read again after 15 minutes, instead of never while
  the mod lives.
- Only the first 4096 characters of a subagent's answer are processed for its `done` line, so a long answer no longer
  takes seconds to process.
- In the estimate of the MCP chips, a capital ASCII letter counts 1.5 cells, since the desktop draws capitals wider.
- The flags of England, Scotland and Wales stay whole; other tag characters still go.
- A `/clear` or a resume that lands while the Log writes a line no longer leaves a stray `+1 more`.

## 0.4.0 — 2026-10-13

- The Log's header shows how many events it has seen. `/clear`, resume and restarting Claude Code start the count over.
- The Log draws as many lines as fit under the other blocks, at least 8, and a dim `+N more` line at its bottom counts
  the events it does not draw, as the Subagents list does.
- The rows of the MCP chips are estimated on the high side, and a name's characters beyond ASCII count two cells each,
  so a wrong guess leaves a blank row instead of cutting the Log's last line.

## 0.3.2 — 2026-10-09

- The first public release.
- The marketplace is renamed `philarete-mods` and installs from GitHub, so the plugin installs as
  `session-panel@philarete-mods`.
- The plugin's listing metadata is new: a homepage, the repository, the license, keywords and the author's URL.
- The full reference moved to [the plugin's README](plugins/session-panel/README.md).
- The code is unchanged.
- The fold state starts over under the new name: the store file is the new plugin's, and the old one is not carried
  over.

## 0.3.1 — 2026-10-09

- The rule above a section is one line high. On the desktop the old rules cut into the Log's last line.
- Tokens in (`↑`) is what the turn sent at full price or more: the input that was not cached and what was written to
  the cache. What it read from the cache is cheap and left out, so `↑` follows the cost.
- `/session-panel` on a pane that is open but not shown asks to bring it forward instead of closing it. The minute
  read runs only while the pane is in front of the session's other plugin panes.
- The changes of one read have 30 s in all. A `git diff` against HEAD that times out or cannot start counts toward
  giving a folder up, and the count is kept for each folder.
- Your `status.showUntrackedFiles` is followed: with `no`, no untracked file is walked.
- Emoji sequences joined by ZWJ stay whole, and Persian and Indic scripts keep their joiners. The flags of England,
  Scotland and Wales lose their tag characters.
- A pair of `**` that an ASCII letter, digit or `_` touches on the outside keeps its marks, so `2**10 and 3**4` stays.

## 0.3.0 — 2026-10-09

- The Log fills the pane's free height, at least 8 lines, and folding another section gives it room.
- The changes are also read once a minute while the pane is open, so edits made outside Claude's tools show without a
  new turn. Opening the pane reads at once.
- `git status` and `git diff` wait for the first turn of the main agent, since they can run filters that the
  repository's own config names. Before it only the folder and the branch show.
- Git reads are bounded: no submodule's work tree is walked, new files are read with no `.gitattributes` filter, the
  count of new files stops at its first failure, and a folder is given up once two `git status` calls in a row have
  timed out or failed to start.
- A count that is only a lower bound is marked with a plus: `+2061+ / −111`, or `12+ files changed`.
- A fold press builds on the map in the store, so it keeps what another session folded.
- Unicode format characters are taken out of the branch, the folder name, the Subagents rows, the MCP server names and
  the Log, and a subagent's answer loses its markdown marks.
- A call abandoned by an interrupt or a stop is no longer drawn as an error. In a narrow Log a prompt reads `you › …`
  and an engine message `engine › …`. Tokens in (`↑`) counts the whole input.

## 0.2.0 — 2026-10-08

- The Project block: the project folder, its git branch, and the working tree's changes against HEAD, such as
  `12 files changed` and `+2061 / −111`.
- The changes are read again about a second after an agent edits a file or runs a command that is not read-only.
  After a slow read the next one waits four times as long as that read took.
- Git runs read-only commands only: `branch`, `rev-parse`, `status` and `diff`. They never take git's index lock or
  rewrite the index, use no fsmonitor, run no textconv or external diff program, and fetch nothing in a partial clone.
- In a narrow pane the Log's `who` column gives way first, and then the outcome moves in front of the text. In the
  Subagents rows `@type` gives way first.
- In auto mode a subagent's `SubagentHandback` call is no longer logged, and its `done` line shows the report it
  handed back.

## 0.1.0 — 2026-10-08

- The first installed version: a live session-stats side pane for the Code tab of the Claude desktop app.
- The Session / Project block: the session's total cost, a context meter against the window auto-compaction uses, the
  Session / Subagents split, the project folder and its git branch.
- Usage, Turn stats, Subagents, MCP, Context sources and Log sections. Each can be folded, and the choice is
  remembered.
- Costs come from the engine's own `cost.usd`, with no price table and no network access.
- Subagent rows in columns: a status mark, the description, `@type` and cost. A subagent resumed with SendMessage
  shows as running again.
- The Log shows the latest 15 of the last 60 events, with the outcome of each call (✓/✗ and the time, or denied) in a
  right-aligned column. Common secret patterns are masked.
- The desktop app's own MCP servers are hidden and not counted.
- On the desktop the pane opens by itself when a session starts; `/session-panel` opens or closes it, mid-turn too.
