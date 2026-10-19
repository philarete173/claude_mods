# Changelog

## 0.5.1 — 2026-10-20

- A text is cleaned of whole escape sequences. A control string (DCS, SOS, PM, APC), an 8-bit CSI, an `ESC ( B` (which
  `tput sgr0` ends in) and a two-byte escape left a tail that stuck to the next word and hid a token from the mask; they
  go whole now, as colour and title sequences did. The default-ignorable code points that are no format characters, and
  a few other invisible ones (U+2800, U+20E3, …), go too where they could split a secret, and stay in an emoji or a
  keycap. The short commit of a detached HEAD and the kind of a rate limit are cleaned as well.
- The mask catches more: the value of a key with a quote after its name (`"password": "…"`), the credential of an
  Authorization header with a scheme other than Bearer and Basic (`Token …`), a quoted Authorization value, and a GitHub
  or Slack token or a `Bearer …` that a removed escape sequence glued to a word. The Subagents rows (a subagent's type
  and description) are masked now, as the Log lines are. The README names the kinds the mask does not catch, and the
  design spec lists them.
- A turn that the engine starts with a tag of its own (`<task-notification>`, `<teammate-message teammate_id="lead">`)
  is logged `engine` with the tag's name, masked. Any other text, one that starts with `<` too (`<div class="x">`), is
  yours: `you`, masked. 0.5.0 took every text that starts with `<` for the engine's, and a pasted `<ghp_…` showed in the
  Log.
- A message you type while a turn runs has its `you` line. The engine takes it into the running turn, so no turn starts
  for it, and the Log showed nothing. The desktop writes the line when the model takes the message in, a terminal when
  you press Enter; a message still queued when the turn ends keeps one line.
- A task's time that ran to a late notice is a bound. The engine takes a task's notice in at the next model request of a
  running turn, or when the session is idle, so a shell task's time could run far past the task's end (`echo hi` showed
  12.2s). When the notice came into a running turn, less than 3 s after the main agent's last turn ended, or before the
  pane has seen a turn end, the time reads `≤12.2s` in Tasks and `✓ ≤12.2s` on the Log's end line (`✗ ≤…` for a failure,
  `≤…` for a stop). After the session has been idle for 3 s or more it is exact. A notice with neither `<summary>` nor
  `<result>` closes no row.
- In a terminal an ASCII capital letter in an MCP chip counts one cell, as it is drawn: the cells are even. The desktop
  draws a capital wider and still counts 1.5. 0.5.0 counted 1.5 on both, so in a terminal names in capitals could cost a
  spare row.
- The docs follow the desktop 2.1.288: a Bash command that runs past its timeout is killed (exit 143) and gets no row in
  Tasks, a message you type while a command runs waits until it ends, and the desktop's own task list shows foreground
  calls and agents too. 0.5.0 said that the timeout or a message moved the command to the background. The mod still
  handles a command that a host sends there by its timeout, or that is moved there (Ctrl+B in a terminal).
- The Log keeps 200 lines, so a pane with room for more than 201 Log rows shows blank rows above `+N more`: a known
  limit. The 0.4.2 entry's "no blank rows above `+N more`" holds up to that height.

## 0.5.0 — 2026-10-16

- A Tasks section, after Subagents, lists the background tasks of the main agent: a Bash command that runs in the
  background (started there, sent there by its timeout, or moved there while it ran, for example by Ctrl+B in a terminal
  or by a message you sent), a Monitor and a local Workflow. A row is a status mark, the description, `@shell`,
  `@monitor` or `@workflow`, and the time: how long a running task has run, or how long an ended one ran. A task ends
  with the engine's notification (done, failed or stopped) or with a TaskStop that names it. The engine gives the pane
  no task list, so a task that began before it loaded does not show, a task whose notification never comes stays running
  until `/clear` or a resume, and a shell task's time runs until its notification reaches the pane.
- The Log shows `→ background` as the outcome of a call that started a task, since its time would be the call's, not the
  task's, and logs the end of a task (`done · shell: …`, `failed ·`, `stopped ·`) with its time, as it logs a subagent's
  end. While a `→ background` line is drawn the outcome column is wider, so in a narrow pane `who` gives way sooner:
  below 45 columns on the desktop instead of 39.
- A stopped subagent is a dim `■` in a terminal, as a stopped task is, where it was a dim `✗`: a failed and a stopped
  one differ by shape, not by colour alone.
- A text cut at its limit, such as a Log line at 512 characters, no longer ends in half of an emoji before its `…`.

## 0.4.3 — 2026-10-15

- A pane maximized on a wide monitor is filled to its edge: the rules between sections reach the right edge (the line
  was 1600 px wide and ended mid-pane on a 21:9 monitor), and the context and limit meters stretch across their rows
  (they stopped at 560 and 240 px). The engine takes an image of 4096 px at most, so on a pane wider than that (a 32:9
  monitor at 100 % scale) the rules end short of the edge and the meters short of their values.
- A Log line keeps up to 512 characters of its text instead of 64 to 80, and the pane cuts it to its width, so a wide
  pane shows more of a prompt, a tool call or a subagent's answer. A narrow pane shows what it showed before.
- A text with a control character, such as an ANSI escape in pasted terminal output, no longer blanks the pane: the
  engine refuses such a text, and it drew its own pane in place of the panel's. Control characters are now taken out
  with the invisible format characters, and a colour or cursor sequence (CSI) or a title or link sequence (OSC) goes
  whole, so a coloured log reads as its text.

## 0.4.2 — 2026-10-14

- A long word in a prompt, a tool call, or a subagent's description or answer shows its start again: the cut of a
  text drops the word it splits only when that word has 256 UTF-16 units or fewer, and a text with no whitespace in its
  first 4096 characters is cut through. 0.4.1 showed an empty line for it.
- The Log keeps the newest 200 lines instead of 60, so a tall pane has no blank rows above `+N more`.
- A failed call of an agent that is not in Subagents (such as one of the engine's own forks) is drawn dim instead of
  red: the engine refuses the tools of most of its forks, and one that tried a tool showed a red line that nobody
  caused.
- The docs give the clean filter up to five runs on a changed file in one read.

## 0.4.1 — 2026-10-13

- `/session-panel` only opens the pane, or asks to bring it forward. It no longer closes it: a lone pane counts as
  shown even behind a built-in tab such as Terminal, so the command closed a pane it should have raised. The pane's
  close mark closes it (ctrl+x x in a terminal).
- A folder whose changes were given up after two failed reads is read again after 15 minutes, instead of never while
  the mod lives.
- The Log reads only the first 4096 UTF-16 units (about 4 KB) of a prompt, a tool call, or a subagent's description
  or answer, cut at a space: a long text built to be slow no longer stalls a hook, and the pane shows less than 80
  characters of each anyway.
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
