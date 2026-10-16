# session-panel

A live session-stats side pane for the Claude desktop app's Code tab, built as a Claude Code mod.

To install it, see the [repository README](https://github.com/philarete173/claude_mods#readme). The design docs are
in [docs](https://github.com/philarete173/claude_mods/blob/main/docs/README.md).

## What it shows

The pane redraws as the session runs. Every section below the Session and Project blocks can be folded; the choice
is remembered. A press keeps what another session folded: it builds on the map in the store and flips one section.
The store file follows the plugin's identity, and each identity keeps a file of its own, so their fold states are
separate: a marketplace install writes `session-panel_philarete-mods-25995b3fb64e.json`
(`session-panel@philarete-mods`), and a copy loaded from a folder, as in development, writes
`session-panel_inline-fb64dc720a6f.json` (`session-panel@inline`).

- **Session**: the session's total cost; a context meter (tokens against the window, in percent); the
  Session / Subagents split once subagents have run. The window is the one auto-compaction uses, so a custom
  `autoCompactWindow` is honoured.
- **Project**: the project folder, its git branch, and the working tree's changes against HEAD: `12 files changed`
  and `+2061 / −111`. New files count too, with their lines counted for the first 50, and your
  `status.showUntrackedFiles` is followed: with `no`, no untracked file is walked. A count that is only a lower bound
  is marked with a plus: `+2061+ / −111` when new files went uncounted, and `12+ files changed`, with no line
  numbers, when git's status output was cut (it has a 4 MiB limit). A lower bound of no lines shows no numbers, as
  unknown lines do (for example, a SHA-256 repository with only new files, or a first new-file count that failed). The
  changes are read from the first turn of the main agent on; before it only the folder and the branch show. They are
  read again about a second after an agent edits a file or runs a command that is not read-only, and once a minute while
  the pane is placed and shown, so that edits made outside Claude's tools (an editor, a terminal, a background command
  that ended after its call returned) show without a new turn. A pane counts as shown when it is in front of the
  session's other plugin panes, so the Session pane, when it is alone, always is: in the usual setup every session whose
  pane is open and placed keeps its minute read (bounded by the wait after a slow read and the 30 s budget below),
  whichever tab or session the desktop has in front. Opening the pane reads at once. `/session-panel` never closes the
  pane, since it cannot tell a pane in front from one that a built-in tab such as Terminal covers: on a pane that is
  open in any state it asks to bring it forward and reads. The surface grants that only while the prompt has the keys
  over an empty composer, and the pane then holds the keyboard until Esc. The pane's close mark closes it (ctrl+x x in a
  terminal). After a slow read the next one waits four times as long as that read took, at most four minutes, and the
  changes of one read have 30 s in all. A folder whose reads time out twice in a row (a `git status`, or a `git diff`
  against HEAD, that times out or cannot start), such as a dotfiles repository in `$HOME`, has its changes left unread
  for 15 minutes, whichever other folder is read, and then one read tries again; meanwhile its branch still shows and
  the changes row is left out. Outside a repository only the folder shows; a clean tree has no changes row.
- **Usage**: the plan limits (5-hour, Weekly, Spend) as meters with a countdown to each reset. Hidden when the engine
  reports no plan limits, for example with an API key or a third-party provider.
- **Turn stats**: the last finished turn of the main agent (a turn stopped before any response leaves the previous
  one shown): response and whole-turn speed (tok/s), elapsed, model and tool time, average time to first token,
  steps, tokens in (what the turn sent at full price or more: the input that was not cached and what was written to
  the cache; what it read from the cache is cheap and left out, and the cache hit rate still counts it) and out, cache
  hit rate and cost. So `↑` roughly follows the cost: a usual turn reads `3.1k ↑`, and a turn after the cache went cold
  `92k ↑`. Only roughly, since a cache read still costs a tenth of the input price: a long turn over a large context can
  spend most of its cost on the reads that `↑` leaves out.
- **Subagents**: up to 8 rows, running ones first, in columns: a status mark, the description, `@type` and cost; the
  rest are counted as `+N more`. In a narrow pane `@type` gives way first. A subagent resumed with SendMessage shows
  as running again.
- **Tasks**: the background tasks of the main agent: up to 8 rows, running ones first and then the newest start, in
  columns: a status mark, the description, `@shell`, `@monitor` or `@workflow`, and the time; the rest are counted as
  `+N more`. The header reads `running/total` while a task runs and the total otherwise, and a pane with no tasks has no
  section. A running task's time is how long it has run (the pane redraws at least every 30 s), and an ended task's is
  how long it ran. In a narrow pane `@kind` gives way first, on every row. The marks are `◐` running, `✓` done, `✗`
  failed and `■` stopped in a terminal, and status icons on the desktop (a half-filled ring, a check, a cross, a stop
  square). Subagents use the same marks: a stopped subagent is `■` and a failed one `✗`, so the two differ by shape, not
  by colour alone. A row comes from a call of the main agent that started a task: a Bash command that runs in the
  background, however it got there (it asked for it, its timeout sent it there, or Ctrl+B did in a terminal), a Monitor,
  or a local Workflow. A remote Workflow is no task, since its end never reaches this session, and a subagent's
  background call makes no row: its task is its own and may end with it. The description is the Bash description or else
  its command, the Monitor's description or the workflow's name, cleaned as a Log text is (secrets masked, format and
  control characters taken out, up to 512 characters), and the name of its kind when nothing is left. A task counts from
  the moment its call came back, so the wait for a permission prompt is not in its time. A command that its timeout sent
  to the background counts from when it began, but one that Ctrl+B sent there counts from that moment, since its result
  says no earlier start: a known limit. A task ends with the engine's task notification (`completed` is done, `failed`
  is failed, `killed` and `stopped` are stopped) or with a successful `TaskStop` that names it (stopped). The status is
  read from the notification's header only, so one that a summary or a result quotes closes nothing, and a notification
  of a task with no row changes nothing. An ended task's time is the duration that the notification gives, where it has
  one (a Workflow's), and otherwise the time from the start to the moment the pane learns of the end, when the
  notification reaches it or the `TaskStop` returns: a shell notification has no duration, so a shell task's time can
  run past the end of its command, a known limit. `/clear` and a resume empty the list. The engine gives a mod no list
  of its background tasks, so the pane has none to reconcile with: a task that began before the panel loaded (Claude
  Code was restarted, or the desktop reopened the session) does not show, and a task whose notification never comes
  stays running until `/clear` or a resume. A Monitor's notification has not been seen live: it is read by the common
  format.
- **MCP**: the servers that have tools in the context, by name, with their count. The desktop app's own servers
  (`ccd_*`, `Claude_Browser`, `scheduled-tasks`, `terminal`) are hidden and not counted.
- **Context sources**: how many skills and MCP servers feed the context.
- **Log**: the last 200 events, newest first, as many lines as fit under the other blocks and at least 8. A dim
  `+N more` line at the bottom counts the events that are not drawn, and the header counts every event it has seen
  (`/clear`, resume and restarting Claude Code start it over). Folding another section gives the Log its room; when not
  even 8 lines fit, the pane scrolls; where the body's height is not known, it draws 15 lines. The panel counts the rows
  of the blocks above the Log itself; only the wrap of the MCP chips is an estimate, made on the high side, so a wrong
  guess leaves a blank row rather than cutting the last line. The events are prompts, tool calls, subagent spawns,
  resumes and results (a successful Agent call, a SendMessage to a known subagent or a subagent's `SubagentHandback` is
  not logged: their lines say it), compactions. A line keeps up to 512 characters of its text, and the pane cuts it to
  its width. Tool calls and subagent results both carry their outcome (✓/✗ and the time, or denied) in a right-aligned
  column. A call that started a background task has `→ background` there in place of ✓ and its time, which would be only
  the launch, whichever agent made the call. The end of a task has a line of its own, as the end of a subagent has:
  `done · shell: <description>` (or `failed ·`, `stopped ·`), with ✓ and its time, ✗ and its time (an error line) or,
  for a stop, the time alone; an end that comes between turns also has the engine's `task-notification` line, as a
  subagent's notice has. While a `→ background` line is drawn, the outcome column is as wide as it (12 characters, 13
  cells on the desktop; it is kept whole on purpose), so in a narrow pane `who` gives way sooner: below 45 body columns
  on the desktop instead of 39 (with `✓ 0.3s`), and below 35 in a terminal instead of 29 (with `main` as the `who`).
  A call that comes back as an error because it was abandoned (you interrupted it, or a stop did) is not drawn
  as an error: it is not red, its `who` and outcome are dim as on every line that is no error, and its outcome is the
  time alone, with no ✗; this rests on the engine's `next.signal`, and was seen live for a subagent stopped with
  `TaskStop` and for Esc on the main agent, while a call that fails by itself stays red. A call of an agent that is not
  in Subagents is labeled `agent`, and its failure is drawn dim, not red: the pane cannot tell a fork's refused try from
  a real failure. Such an agent is one of the engine's own forks (most of them have every tool refused), or a subagent
  that was started before the session was reopened (or Claude Code restarted) and is resumed after it, whose row the
  pane no longer has: a known limit. A subagent's answer loses its markdown marks (a pair of `**`, unless an ASCII
  letter, digit or `_` touches it on the outside, so `2**10 and 3**4` stays, and a letter of another script does not
  stop it: `这是**重要**的` gives `这是重要的`; backticks; a heading's `#`). In auto mode a subagent's `done` line shows the
  report it handed back, even when auto mode withheld or flagged it; the text is masked as any other, and the main agent
  did not get it, a known limitation. In a narrow pane the `who` column gives way first, and then the outcome moves in
  front of the text; where there is no `who`, a prompt reads `you › …` and an engine message (a tagged one, such as
  `agent-message`) reads `engine › …`. A subagent's type then shows in the Log only in its `spawned · type: …` line, if
  the cut leaves it: a known limit. Unicode format characters (the bidi controls, zero-width spaces, the BOM and the
  rest) are taken out of the branch, the folder name, the Subagents rows, the MCP server names and every log text, since
  a U+202E would reorder what the pane shows. A ZWJ or ZWNJ stays only between two characters that are above U+007F and
  are no spaces, so emoji sequences joined by ZWJ stay whole and Persian and Indic scripts keep their joiners. Tag
  characters go too, since they can carry invisible ASCII, except in the flags of England, Scotland and Wales, which
  stay whole; any other run of tags after a black flag goes and leaves the plain black flag. Beside an ASCII character,
  a space of any kind or an end of the text a joiner would join nothing, and it could hide a character in a branch name
  or split a secret so that its mask misses it, so it goes. Control characters (C0 but tab, line feed and carriage
  return; DEL; C1) and U+10EEEE, a placeholder of the engine's, go from the same texts (the vertical tab and the form
  feed become spaces, and a colour or cursor sequence (CSI) or a title or link sequence (OSC) goes whole, so a coloured
  log reads as its text): the engine refuses a text that holds one and draws its own pane in place of the panel's, which
  a pasted ANSI escape used to cause. Common secret patterns (tokens, keys, passwords in URLs and flags) are masked.

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
- Read-only git commands only: `branch`, `rev-parse`, `status` and `diff`. They never take git's index lock or rewrite
  the index, use no fsmonitor, run no textconv or external diff program, do not walk a submodule's work tree
  (`--ignore-submodules=dirty`), and fetch nothing in a partial clone (git 2.44 or later, and some distributions' 2.43
  builds, which backport it; other git ignores it).
- Git still runs the filters you configured, such as Git LFS, as it does for any `git status`. That is why `status` and
  `diff` wait for the first turn of the main agent, once per session: they can run filters that the repository's own
  config names, and a turn cannot start before you have accepted the folder. Before it the mod reads the folder and the
  branch only (`git branch` runs no filters). A reload of the mod waits for the next turn again.
- Untracked files are read with no `.gitattributes` filter: `GIT_ATTR_SOURCE` points at git's empty tree, so no
  attribute-selected filter (a clean or process filter, Git LFS) runs on one. A git that does not know the variable
  ignores it. `.git/info/attributes` and the attributes file that `core.attributesFile` names (in your git config or in
  the repository's own `.git/config`) still apply: no clone brings either.
- Your `status.showUntrackedFiles` is followed: the first `git status` runs with no `-u` flag, so `no` (as in a dotfiles
  repository in `$HOME`) walks no untracked file, and only when that status lists an untracked folder does a second one,
  with `-uall`, count the files in it. A nested repository that is not ignored, such as a worktree inside the
  repository, is always listed as an untracked folder, so with one every read runs both statuses; the budget bounds
  that. `GIT_CEILING_DIRECTORIES` is not set: the mod reads no environment variable, so it does not know `$HOME`. A
  ceiling at `$HOME` would only keep a folder outside git below it from reading a repository in `$HOME` itself (git
  never holds the folder it starts in against a ceiling), and a ceiling that stops the walk at the session root (set on
  its parent) would hide the repository of a session started in one of the repository's folders. So a session in such a
  folder reads that repository, as `git status` there does, within the budget. Each status and the diff re-hash the
  files whose stat data changed, since the mod never refreshes the index, so a clean filter can run on a changed tracked
  file up to five times in one read (with git 2.43, once in each status and two or three times in the diff); the budget
  and the gap between reads bound that.
- A read gives up early. The changes of one read have 30 s in all: each git call gets the time left, up to its own 10 s,
  and when none is left the read ends as that call's failure would. The count of new files stops at its first failure.
  Once two reads in a row had a `git status`, or a `git diff` against HEAD, that timed out or failed to start, the
  changes of that folder are not read for 15 minutes; then one read tries again, another 15 minutes follow if it times
  out or fails to start too, and one with no such failure reads as before. The count is kept for each folder, so reading
  another one does not reset it.
- The mod reads no file itself: git counts the lines.
