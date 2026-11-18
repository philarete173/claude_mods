# Changelog

## 0.7.1 — unreleased

- The core breathes: a halo in the ring's colour swells and fades outside the ring, never inside it, slowly at rest and
  faster while the main agent's turn or any station runs. Under `motion: reduced` it stands still.
- A pulse is a comet, a dot with a tail that turns along its path, in place of the three dots. On arrival the circle
  still flashes, and a ripple spreads from it. A running station has a steady halo and a ring that beats outward from
  its circle, in place of the breathing glow.
- Skills and You take the owner's palette A: butter and lilac on the dark theme, deep olive-gold and plum on the light
  one. They differ from their neighbours by lightness now, and the weak pairs of 0.7.0 (Skills with MCP and Model,
  You with Agents) are apart.
- Activity's label column is about 45 % of the pane, up to 64 cells. The tags show from 54 columns (a pane of about
  464 px), start on one x and are never cut. Descriptions whose end cuts would read the same are cut in the middle,
  so that the lanes tell apart (`Band check…sleep A`).
- A subagent resumed with SendMessage keeps its earlier runs: its lane draws a bar for each run with the gaps
  between, and the current run starts at the resume. A row keeps 8 earlier runs; a ninth merges the two oldest.
- The Turn stats legend names each station the turn used, with its swatch and its share of the bar, then the steps
  and the time to first token, wrapped over as many rows as it needs. The narrow-pane rules that left items out are
  gone. The `Model` and `Tools` legend is left only for a turn of 0.6.1 kept over a hot reload.
- Fix: `claude --resume <id> "…"` restored nothing when its first turn came before the restore's reads. The restore is
  asked first at `session.start`, before any wait.
- Fix: after a reopen the core named no model until the first response. The main model is read from the engine at the
  start, and the first response's model replaces it.
- Fix: a call the mod saw no chunk of in the model's stream (another plugin's call, for example) never pulsed. It
  pulses at its return; any other call still pulses at its first chunk.
- Fix: a call the engine blocked before it ran (`Blocked: …`) was drawn as a failure, with a red Shell. It is a denial
  now, `denied` in the Log. The rule reads the engine's text.
- Fix: a compaction another plugin kept from the mod drew no tick. The engine drops the context's tokens until the
  next response, so the next usage reading (the minute's tick, the next prompt or a measure) that finds them gone
  counts the compaction, with a bare `compacted` line. One inside a running turn whose next response comes first is
  still missed.
- Docs: the README has 0.7.1's drawings and limits. The 0.7.0 spec carries 0.7.1's rules in place, and the visual
  spec's old Context meter lines are gone or marked as replaced.

## 0.7.0 — 2026-11-17

- The Session band takes the place of the Context label row and the meter row. The context ring is its core, with the
  percent, the model's short name, `tokens / window` and a tick for each compaction the mod saw (5 at most). Around it
  stand eight tool stations, Model, Files, Shell and Web on the left and Agents, MCP, Skills and You on the right, each
  with its icon in its own hue, its label and its count of calls for the session (Model counts model steps), the main
  agent's and the subagents' alike. A station where something runs glows and shows `×N` when 2 or more run; a failed
  call gives it a red disc with this turn's count until the main agent's next turn; a pulse runs from the core to the
  station on each call. The band is two rows a side below a pane of about 496 px and one row from there, and it
  stretches to the pane's edges. A terminal draws a core line and a grid of station cells.
- Turn stats draws the turn as a ribbon: one bar with a part for each model call and each step's tool calls, in the
  stations' hues, a failed call underlined in red, older steps merged into one part per station. The running turn is
  drawn live against a scale, with a pulsing end that grows between redraws; when idle the last turn fills the bar. A
  legend gives the model's and the tools' shares, the steps and the time to first token. The table moves behind a
  `details` fold, closed by default (key `turnDetails`); while a turn runs it leaves out the running step, which the
  bar and the legend count.
- Activity takes the place of the Subagents and Tasks lists: one lane for the main agent, each subagent and each
  background task on one time axis, 8 at most and then `+N more`, each with its description, its cost or time, and its
  status by shape (a pulsing cap while it runs, then `✓`, `✗`, `■` or `○`). From a pane of about 670 px (80 terminal
  columns) a dim `@type` or `@kind` tag follows the description. Restored lanes are dashed. Main's value is a dim `—`
  while a restored subagent is listed, as the split line hides Session then. Activity folds under its own key,
  `activity`; the stored folds of the old sections, `agents` and `tasks`, are ignored.
- A setting, `motion`: `full` (the default) or `reduced`, which draws no animation. It is the plugin's first
  `userConfig` option; the pane picks up a change after Claude Code restarts.
- Every drawing is an image with an alt that says what it shows; there are no tooltips. The desktop's drawings follow
  the app's theme; a terminal always gets the dark hues.
- A reopen restores the stations' counts after the latest compaction summary and the number of compactions. It does
  not restore calls in flight, failures, pulses, the ribbon or the main agent's turns.
- Fix: an agent type longer than 14 characters was cut by UTF-16 units, so the cut could split an emoji and leave half
  a surrogate pair. The cut keeps every pair whole now, in the lane's tag and in the Log's `who`.
- The station idea and the Agents, Skills and You icons are adapted from lot-map by Aleksei Volodin (MIT), and so are
  the phase-locked animations and the light-theme rules inside the images; THIRD_PARTY_NOTICES.md carries its notice.
- Docs: the README has the band, the ribbon, Activity, a Settings section and the limits of the drawings. The visual
  spec's §6.2, §6.6 and §6.7 point to the 0.7.0 spec, which records Task 1's live findings, and it has the checks 50
  to 55.

## 0.6.1 — 2026-11-13

- A subagent that the engine resumes keeps its row. From engine 2.1.308 a resume (SendMessage to a subagent that
  stopped, the engine waking a parked one) raises the spawn again, with `resume`. The pane rebuilt the row: the subagent
  lost its start and its cost (which moved to Session), and the Log said `spawned`. The row now runs again with its
  start and its cost, and the Log says `resumed · type: …`. A subagent with no row (one from before the restore's rows)
  is listed as restored, its cost since the resume (`$x+`), logged `resumed` too.
- The restore draws the engine's turns as live does. A turn that the engine opened is logged `engine › <tag>` live
  (`task-notification`, a `!` command's `bash-stdout`, a skill's slash command `command-message`); after a reopen it has
  the same line now, when the assistant's row comes next and does not follow tool results. A local command that asks the
  model nothing (`/model`) has no line. A subagent's hand-back, and any message another agent sends with SendMessage,
  opens its turn with `<agent-message from="…">` (`engine › agent-message` live); its row is one that
  `$.session.messages()` never returns, so it is not restored. The `peer` rule, which reads the engine's frame of such a
  message (`Another Claude session sent a message:`, or `… while you were working:`), stays as a fail-safe.
- A restored end line shows no engine note as the answer. When the result of a subagent's notice is the engine's own
  sentence (the subagent ended without a report, or its report came as a message), the end line has no answer; a notice
  that says the agent has not reported yet closes nothing, and a later notice closes it.
- The pane starts when another plugin keeps `session.start` from the mod. The restore, the `/session-panel` command, the
  cost baseline, the timer and the pane on a desktop all hung on that event, and with it gone the pane stayed empty with
  no sign. The first turn of the main agent starts them now, and the restore leaves out that turn's own rows. A row
  written before that turn (a subagent the engine resumed) keeps the restore out, as a hot reload's state does.
- Behaviour change of 0.5.2's rule, made after the security review of the live check: after a quoted name a bare number
  is masked, except after a counter's name (`max` or `min`, then `_`, `-` or nothing, then `token`: `{"max_token":
  4096}`). `{"token": 482913}`, `"password": 123456` and `"DB_PASSWORD": 12345678` showed since 0.5.2 and are masked
  now. `true`, `false`, `null` and `none` still show after every name.
- Docs: the README and the specs record what a hand-back is (`<agent-message from="…">`, a row the engine keeps out of
  the messages, so it is never restored and a subagent that reported between turns is `ended`), the new limits of the
  mask (a number under a counter's name, also behind a malformed key such as `{" "max_token": 482913}`; a value that
  begins with a key and `?=` or `+=` after a quoted name; a tag's name of a secret's shape with no known prefix, which
  shows as the line of an `engine` turn) and that a notice that is typed, pasted or sent through the SDK can close a
  restored row (display only). The visual spec has the checks 45 to 49.

## 0.6.0 — 2026-10-27

- The pane restores itself. At `session.start`, when Subagents, Tasks and the Log are all empty (a new process: the
  desktop app reopened, `claude --resume`, the mod enabled mid-session; a hot reload keeps the state and restores
  nothing), and after an in-process `/resume` at the first turn of the main agent, without that turn's own rows, the
  pane is rebuilt from the session's messages, the newest 4096 rows from the latest compaction summary on. Subagents:
  every Agent call with an agent id, `done` or `failed` by its result, `done`, `failed` or `stopped` by a task notice or
  a `TaskStop`, else `running` while the engine still lists it, or `ended`. Tasks: the background calls, closed by
  notices or `TaskStop`, else `ended`. The Log: prompts, other agents' messages, task notices, subagent and task lines,
  and the main agent's tool calls, the newest 200; the header counts all. Not after `/clear`; live rows win over
  restored ones.
- Restored rows look different: a Log line has a dim `—` where the clock time is. A tool call keeps its `✓` or `✗` with
  no time, `→ background` for a call that started a task, and no outcome for a call that was still running when the
  transcript was read. An end line has a time only where the call or a notice gave one (a foreground subagent's
  duration, a notice's `<duration_ms>`); without one, a subagent's end line keeps a bare `✓` or `✗`, a task's has no
  outcome, and a stop has none. A restored subagent or task has no known start, so it is listed after the live rows of
  its group, newest first. An unfinished subagent whose run is over is `ended`, drawn as an ended task (`○`, dim). A
  subagent's cost is `—`, or `$x+` once it is charged after the restore, and while one is listed and the Total is known
  the split reads `Subagents $Y+` (a lower bound) and Session is not shown. Not restored: subagents' own tool calls,
  tool times, denials, Turn stats, costs before the restore.
- One rule decides the Log line of a turn, live or restored. Leading `<system-reminder>` blocks are skipped: the
  desktop's first prompt after a reopen is logged `you` (it was `engine system-reminder`), and a turn that is only a
  reminder has no line. Another agent's message is logged `engine › peer`, not as a `you` line with its text. The rule
  fails closed: when a reminder block may have quoted its own closing tag, or a prompt starts with an engine opening of
  its own (`[Image: source: `, `Base directory for this skill: `, `[Request interrupted by user`), the turn has no line.
- To restore, the mod reads the session's transcript through the engine, tool results included. It draws only prompts,
  call labels, subagent descriptions and answers and task descriptions, masked best-effort as live lines are, and never
  tool output, file contents, the prompts given to subagents, error texts or the compaction summary. Nothing is written
  to disk or sent; it stays in session plugin state, which other plugins can read, as live lines do.
- State contract: other plugins read `PluginState['session-panel']`. `AgentRow.startedAt` and `LogEntry.at` may be null
  now, `AgentStatus` has `ended`, and subagent rows may carry `restored: true`. A typed reader that does arithmetic on
  them must handle null.
- Docs: the README and the specs record the restore and its limits, the engine 2.1.308 (the rows of
  `$.session.messages()`, an `agentId` on an Agent call), and the five view constants that were renamed
  (`MAX_AGENT_ROWS` to `MAX_STATUS_ROWS`, and the others) because tasks use them too.

## 0.5.2 — 2026-10-21

- An agent's run no longer disturbs the main turn. Since engine 2.1.299 every agent run, foreground or background (a
  subagent, a Workflow agent), raises a turn start of its own. The pane took it for a main turn: the Turn stats of a
  turn that launched agents kept only the last step, and the agent's prompt was logged as `you`. It is passed on and
  left alone now: the Turn stats count all the steps, the tool time and the cost of the main turn, and an agent's prompt
  has no line.
- A task's time is exact only if the session had been idle 3 s or more, and the idle time starts now when the turn
  end's hooks beneath the mod have run, not at the mod's own hook. A slow hook beneath the mod no longer makes a notice
  that waited read as exact. A slow hook above the mod, or a slow `session.measure`, still can: the 3 s gap is a
  heuristic.
- The mask reads more names: `secret_key`, `secret_key_base` (Rails, Phoenix), `access_key` and `private_key`, in any
  case, with `_`, `-` or nothing between the words (`secretKey`, `SECRET_KEY_BASE`). They are masked after a quoted name
  (`{"secret_key": "…"}`), unquoted with `=`, `:`, `=>`, `:=`, `?=` or `+=` (`secret_key=…`, `secretKey := "…"`), as a
  flag (`--secret-key …`, `--s3-secret-access-key …`) and in `aws configure set aws_secret_access_key …`; the lowercase
  `aws_secret_access_key` of the AWS credentials file is masked now. A quoted value of an unquoted name that nothing
  closes on its line masks the rest of the text, so a PEM in a `.env` file stays masked.
- After a quoted name, a bare number, `true`, `false`, `null` or `none` shows as it is (`{"max_token": 4096, "secret":
  false}`, `{'password': None}`), and a quoted one (`"4096"`) is masked as before. So a number-shaped secret after a
  quoted name shows (a digit PIN, `"token": 01234567`, hex such as `8e54632190`); an unquoted `token: 120` stays
  masked. A value that begins with what a later pattern reads (`--token …`, `Authorization: …`, another key and its
  separator) is left to that pattern, which masks its secret; a value with a name glued inside (`MyApiKey:…`) is masked
  whole.
- A run of invisible characters of any length is cleaned in pieces of up to 4096 code points and judged as one run,
  with the same output as before. In Node a run of about 4.2 million overflowed the stack; the engine's own runtime
  never did, so this guards against a change of runtime.
- Docs: the README and the specs record the engines 2.1.299 to 2.1.304: a message sent during a foreground command
  moves it to the background (2.1.288 made it wait), the sandbox's placeholder files that a Project read counts while a
  sandboxed command runs, the cost of earlier subagents that counts as Session after the app restarts, and the limits
  and over-masks of the mask.

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
