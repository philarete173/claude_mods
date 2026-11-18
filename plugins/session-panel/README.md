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

- **Session**: the session's total cost; the Session band (below); the Session / Subagents split once subagents have
  run, and `Subagents $Y+` alone while a restored subagent is listed and the Total is known (see "What a reopen
  restores").
- **The Session band**: the core, which shows the context, in the middle, and eight tool stations, four on each side.
  - The core is a ring of the context (tokens against the window): blue below 80 %, amber from 80 %, red from 95 %.
    Inside it are the percent and the model's short name, and under it `tokens / window`. The window is the one
    auto-compaction uses, so a custom `autoCompactWindow` is honoured. With no reading the core shows `—`. A tick
    around the ring stands for each compaction the mod saw, 5 at most. A halo in the ring's colour breathes outside
    the ring, never inside it: slowly at rest, faster while the main agent's turn or any station runs, and steady
    under `motion: reduced`. After a reopen the model is read from the engine at the start, so the core names it
    before the first response, whose model then replaces it.
  - The stations are Model, Files, Shell and Web on the left, and Agents, MCP, Skills and You on the right. Each is a
    circle with its icon in its own hue, its label and its count for the session, the main agent's and the
    subagents' alike. A station at 0 is dim. The ribbon and the lanes below use the same hues, so the band is their
    colour key. Skills is a butter yellow and You a lilac (a deep olive-gold and a plum in the light theme), so that
    they stand apart from their neighbours' hues. What each counts:
    - Model: the model's steps (one model request), the main agent's and the subagents'.
    - Files: Read, Write, Edit, MultiEdit, NotebookEdit, Grep, Glob and LSP calls.
    - Shell: Bash, PowerShell and Monitor calls, and the calls of any tool that no other station names.
    - Web: WebFetch, WebSearch, Artifact, ArtifactComments and ArtifactData calls.
    - Agents: Agent, Task, Workflow, SendMessage, TaskStop, ListAgents, SubagentHandback, ScheduleWakeup and `Cron…`
      calls.
    - MCP: every `mcp__…` tool's calls, and ListMcpResourcesTool, ReadMcpResourceTool and ReadMcpResourceDirTool.
    - Skills: Skill, ToolSearch, ListSkills, SearchSkills, SuggestSkills, ListPlugins, SearchPlugins and
      SuggestPluginInstall calls.
    - You: AskUserQuestion, TodoWrite, TaskCreate, TaskUpdate, TaskList, TaskGet, EnterPlanMode, ExitPlanMode,
      PushNotification and SendUserFile calls.
  - A station where something runs has a steady halo and a ring that beats outward from its circle, and its circle takes
    its hue. Model runs for each agent in a model step (the main agent while its turn runs, each running subagent, while
    it has no call in flight); Agents for each running subagent and Workflow task; Shell for each of its calls in flight
    and each running shell or Monitor task; any other station for each of its calls in flight. With 2 or more at once a
    badge shows `×N` (`×9+` from 10).
  - A failed call (one the Log draws as an error, with ✗; a denied or abandoned call is none) gives its station a red
    circle and a red disc with this turn's count of failures (`9+` from 10). It stays until the main agent's next turn
    starts. A call the engine blocked before it ran (its error starts `Blocked:`) is drawn as a denial, not a failure:
    its Log line reads `denied`.
  - On each call (a model step, for Model) a pulse, a comet with a tail, runs from the core to the station; when it
    arrives the circle flashes and a ripple spreads from it. The pulse dates from the call's first chunk in the
    model's stream; a call the mod saw no chunk of (one another plugin made, for example) pulses at its return.
  - Below a pane of about 496 px each side is two rows of two stations; from there it is one row of four. The core
    stays in the middle and the stations reach the pane's edges: on a wider pane only the gaps grow. On a body wider
    than 4096 px the band is laid out 4096 px wide and centred. When the labels do not fit, the counts stay.
  - In a terminal the band is a core line, `opus 5.5  ▰▰▰▰▰▰▱▱▱▱  56%     112k / 200k ↻1` (`↻N` is the compaction
    count), and a grid of station cells: `●` running or `·` idle, the label in its hue, the count, and `!N` for this
    turn's failures or `×N` for what runs. The grid is 3 rows at 40–42 columns, 2 up to 118 and 1 from 119; below 59
    columns the cells are compact, with a cut label and `!` or `×` alone. Counts from 1000 read `1.2k` on the desktop
    and `1k` … `99k` in a terminal.
- **Project**: the project folder, its git branch, and the working tree's changes against HEAD: `12 files changed`
  and `+2061 / −111`. New files count too, with their lines counted for the first 50, and your
  `status.showUntrackedFiles` is followed: with `no`, no untracked file is walked. A count that is only a lower bound
  is marked with a plus: `+2061+ / −111` when new files went uncounted, and `12+ files changed`, with no line
  numbers, when git's status output was cut (it has a 4 MiB limit). A lower bound of no lines shows no numbers, as
  unknown lines do (for example, a SHA-256 repository with only new files, or a first new-file count that failed). The
  changes are read from the first turn of the main agent on; before it only the folder and the branch show. They are
  read again about a second after an agent edits a file or runs a command that is not read-only, and once a minute while
  the pane is placed and shown, so that edits made outside Claude's tools (an editor, a terminal, a background command
  that ended after its call returned) show without a new turn. While a sandboxed Bash command runs, the project folder
  holds the sandbox's empty placeholder files (dotfiles, `.claude/…` entries), which git sees as untracked, so a read in
  that time counts them (`21 files changed`); the next read after the command counts right. A pane counts as shown when
  it is in front of the session's other plugin panes, so the Session pane, when it is alone, always is: in the usual
  setup every session whose pane is open and placed keeps its minute read (bounded by the wait after a slow read and the
  30 s budget below), whichever tab or session the desktop has in front. Opening the pane reads at once.
  `/session-panel` never closes the pane, since it cannot tell a pane in front from one that a built-in tab such as
  Terminal covers: on a pane that is open in any state it asks to bring it forward and reads. The surface grants that
  only while the prompt has the keys over an empty composer, and the pane then holds the keyboard until Esc. The pane's
  close mark closes it (ctrl+x x in a terminal). After a slow read the next one waits four times as long as that read
  took, at most four minutes, and the changes of one read have 30 s in all. A folder whose reads time out twice in a row
  (a `git status`, or a `git diff` against HEAD, that times out or cannot start), such as a dotfiles repository in
  `$HOME`, has its changes left unread for 15 minutes, whichever other folder is read, and then one read tries again;
  meanwhile its branch still shows and the changes row is left out. Outside a repository only the folder shows; a clean
  tree has no changes row.
- **Usage**: the plan limits (5-hour, Weekly, Spend) as meters with a countdown to each reset. Hidden when the engine
  reports no plan limits, for example with an API key or a third-party provider.
- **Turn stats**: the main agent's running turn, drawn live, or when it is idle its last finished turn (a turn stopped
  before any response leaves the previous one shown), as a ribbon, a legend and a `details` fold.
  - The ribbon is one bar with a part for each model call and one for each step's tool calls (parallel calls of one
    step are one part, in the hue of the call that started first), each in its station's hue, and the elapsed time
    at its right. A failed call's part is underlined in red. The latest steps are drawn in detail, one for every 20 px
    of bar or so (6 to 60); older ones merge into one part per station at the left. A running turn is drawn against a
    scale (15 s, 30 s, 1 m and so on up to 3 h, then every hour) whose rest is a dotted line with a tick at its end;
    its live end is a pulsing cap in the hue of what runs, and between redraws it grows. A finished turn fills the bar.
  - The legend names the stations: Model first, then each tool station with time in the turn, in station order, each
    with its swatch (in a terminal, its label in its hue) and its share of the bar (`<1%` for a share that rounds to
    0), then the steps and the average time to first token. The shares are of the sum of the stations' times, so each
    matches its colour in the bar. Whole items wrap over as many rows as they need, and one wider than a row is cut
    with `…`. A turn of 0.6.1 kept over a hot reload has no parts: its legend is the old one, `Model` and `Tools`.
  - `▸ details` opens the table, and is closed by default (its fold key is `turnDetails`). While a turn runs, the table
    leaves out the running step, which the bar and the legend count. The table holds response and whole-turn speed
    (tok/s), elapsed, model and tool time, average time to first token, steps, tokens in (what the turn sent at full
    price or more: the input that was not cached and what was written to the cache; what it read from the cache is
    cheap and left out, and the cache hit rate still counts it) and out, cache hit rate and cost. So `↑` roughly
    follows the cost: a usual turn reads `3.1k ↑`, and a turn after the cache went cold `92k ↑`. Only roughly, since a
    cache read still costs a tenth of the input price: a long turn over a large context can spend most of its cost on
    the reads that `↑` leaves out.
  - In a terminal the bar is `cols − 8` cells in the parts' hues, the last cell of a failed part is a red `✗`, and
    `·` marks the rest of the scale.
- **Activity**: the main agent, the subagents and the main agent's background tasks, as lanes on one time axis. The
  header reads `running/total` of the subagents and tasks while one runs, and the total otherwise; with no subagent and
  no task the section is left out. Activity has a fold of its own (`activity`): the folds of the Subagents and Tasks
  sections it replaced (`agents`, `tasks`) are ignored. `main` comes first, with its latest 6 turns; then the running
  lanes, the older start first; then the ended ones, the newer end first. Up to 8 lanes show, and the rest are counted
  as `+N more`. A lane is its label, its bar and its value. The label column is about 45 % of the pane (9 cells at
  least, 64 at most). It holds the description and, from 54 columns (a pane of about 464 px), a dim tag: a subagent's
  `@type` as the Log shows it (with no plugin prefix, cut at 14 characters: `@general-purpo…`), or a task's `@shell`,
  `@monitor` or `@workflow`. The tags start on one x: the description gets the column less the widest shown tag and a
  space, and a tag is never cut. A description is cut at the end with `…`; where the end cuts of two or more would read
  the same, each is cut in the middle instead (`Band check…sleep A`), so that the lanes tell apart. The value is main's
  cost (Session's figure, and a dim `—` while a restored subagent is listed, since the split does not show Session
  then), a subagent's cost or a task's time. Main's lane is in the Model hue, a subagent's in the Agents hue and a
  task's in the Shell hue. A running lane is a thick bar up to now, ending in a pulsing cap; a finished one is a thin
  bar and a mark after it: `✓` done (green), `✗` failed (red), `■` stopped or `○` ended (grey), so the statuses differ
  by shape, not by colour alone. A lane that started before the axis fades in at its left end. The axis runs from the
  oldest start among the lanes shown (main's aside) to now, 2 minutes at least, with ticks at round clock times, `HH:MM`
  labels and `now` at the end; a label closer than 36 px to `now` or 14 px to the axis start is left out, and its tick
  stays. In a terminal a lane is a row of `━` (running), `─` (finished) or `┄` (start not known), with `◐` at the end of
  a running lane and the same marks after a finished one. A subagent resumed with SendMessage runs again: its lane keeps
  each earlier run as a thin bar, with the gaps between, and the current run starts at the resume (8 earlier runs at
  most; a ninth merges the two oldest). It sorts by its first run's start while it runs and by its latest end once it
  ended. A restored subagent keeps no earlier run, since its start is not known. A restored subagent whose run is over
  and whose end is not known is `ended` (`○`); its cost is `—`, or `$x+` once it is charged after the restore. A running
  task's time is how long it has run (the pane redraws at least every 30 s), and an ended task's is how long it ran. A
  task's lane comes from a call of the main agent that started a task: a
  Bash command that runs in the background, however it got there (it asked for it, a host sent it there by its timeout,
  or it was moved there while it ran: Ctrl+B in a terminal, a plugin's abort of the turn, or any other way), a Monitor,
  or a local Workflow. The desktop (2.1.288, 2.1.299 and 2.1.304) moves no command to the background for its timeout:
  one that runs past it is killed, with exit code 143, and gets no row. A message you type while a foreground command
  runs waits until it ends on the desktop 2.1.288; since 2.1.299 the engine moves the command to the background so that
  the message can reach the model, and the command gets a row, timed from its call's start, and `→ background` in the
  Log. Its own task list shows foreground calls and agents too, so it holds more than Activity. A remote Workflow is
  no task, since its end never reaches this session, and neither is a Workflow whose syntax check failed (its result has
  a non-empty `error`); a subagent's background call makes no row: its task is its own and may end with it. The
  description is the Bash description or else its command, the Monitor's description or the workflow's name, cleaned as
  a Log text is (secrets masked, format and control characters taken out, up to 512 characters), and the name of its
  kind when nothing is left. A task counts from the moment its call came back, so the wait for a permission prompt is
  not in its time. Two kinds of command count from earlier: one that its timeout sent to the background counts from when
  it began, and one that was moved there while it ran counts from when its call began, the wait for a permission prompt
  included. A task ends with the engine's task notification (`completed` is done, `failed` is failed, `killed` and
  `stopped` are stopped) or with a successful `TaskStop` that names it (stopped). The status is read from the
  notification's header only, so one that a summary or a result quotes closes nothing, and neither does one with no
  `<summary>` and no `<result>`; a notification of a task with no row changes nothing, and none can come before its
  task's row, since the mod writes the row before the call that started the task returns (as long as every hook above
  the mod's waits for the chain beneath it). An ended task's time is the duration that the notification gives, where it
  has one (a Workflow's), and for a `TaskStop`, which ends the row at once, it is exact too. A shell notification has no
  duration: the time runs from the start to the notice, and the engine takes a notice in at the next model request of a
  running turn, or when the session is idle, so it may come later than the end of the task. When it came into a running
  turn, less than 3 s after the main agent's last turn ended, or before the pane has seen a turn end (just after it
  loaded), the task ran at most that long, and the time is a bound, drawn `≤12.2s`. The 3 s count from when the hooks
  beneath the mod have run at the turn's end. A notice that comes after the session has been idle for 3 s or more is
  taken at the task's end, and the time is exact. The time takes 8 characters, so `≤99h 59m` is the widest bound shown,
  and a wider time is a dim `—`. In a terminal that draws East Asian ambiguous characters two cells wide (CJK locales),
  `≤` takes two cells and a bound row is one cell wider. `/clear` empties the list, and a resume empties it and then
  restores the resumed session's. The engine gives a mod no list of its background tasks, so the pane has none to
  reconcile with: a task that began before the panel loaded (Claude Code was restarted, or the desktop reopened the
  session) is rebuilt from the session's messages (see "What a reopen restores"), and a task whose notification never
  comes stays running until `/clear` or a resume. A Monitor's notification has not been seen live: it is read by the
  common format.
- **MCP**: the servers that have tools in the context, by name, with their count. The desktop app's own servers
  (`ccd_*`, `Claude_Browser`, `scheduled-tasks`, `terminal`) are hidden and not counted.
- **Context sources**: how many skills and MCP servers feed the context.
- **Log**: the last 200 events, newest first, as many lines as fit under the other blocks and at least 8. A dim
  `+N more` line at the bottom counts the events that are not drawn, and the header counts every event it has seen
  (`/clear` starts it over; a resume or a reopen starts it over and then counts the events it restores). Folding another
  section gives the Log its room; when not even 8 lines fit, the pane scrolls; where the body's height is not known, it
  draws 15 lines. The panel counts the rows of the blocks above the Log itself; only the wrap of the MCP chips is an
  estimate, made on the high side (it keeps 2 cells of every line free and counts a character above ASCII as 2 cells; an
  ASCII capital counts 1.5 cells on the desktop, which draws capitals wider, and one cell in a terminal, as it is drawn
  there), so a wrong guess leaves a blank row rather than cutting the last line. The Log keeps 200 lines, so a pane with
  room for more than 201 Log rows shows blank rows above `+N more`: a known limit. The events are prompts, tool calls,
  subagent spawns, resumes and results (a successful Agent call, a SendMessage to a known subagent or a subagent's
  `SubagentHandback` is not logged: their lines say it), compactions. A subagent that is resumed (SendMessage to one
  that stopped; engine 2.1.308 and later raise its spawn again) keeps its row and its cost, runs again from the resume
  (Activity keeps its earlier runs), and is logged `resumed · type: …`; with no row (one from before the restore's rows)
  it is listed again with its cost since the resume (`$x+`). A prompt that starts a turn of the main agent is
  logged `you`, unless the engine started the turn with a tag of its own, a lowercase name with a hyphen or an
  underscore (`<task-notification>`, `<teammate-message teammate_id="lead">`): that line is `engine`, with the tag's
  name, and any other text, one that starts with `<` too (`<div class="x">`), is yours. The line goes by the shape: a
  tag that you type in that shape (`<my_note>`) is logged `engine`, and an engine tag of one word is logged `you`.
  Leading `<system-reminder>` blocks are skipped: the desktop's first prompt after a reopen carries one and is logged
  `you`, a turn that is only a reminder has no line, and the line of a message typed mid-turn skips them too. A
  subagent's hand-back, and any message another agent sends with SendMessage, opens its turn with the engine's
  `<agent-message from="…">` tag, so its line is `engine › agent-message`. The engine's frame of such a message
  (`Another Claude session sent a message:` or `… while you were working:`) stays on rows the mod does not get; a text
  that opens with it is logged `engine` with the text `peer`, never its own text. The rule fails closed: a turn whose
  reminder block may have quoted its own closing tag has no line, and nor has a prompt that starts with one of the
  engine's own openings (`[Image: source: `, `Base directory for this skill: `, `[Request interrupted by user`). An
  agent's run (a subagent, a Workflow's agent; engine 2.1.299 and later raise a turn of its own for it) gets no line for
  its prompt and leaves the
  Turn stats of the main turn alone. A message you type while a turn runs goes into that turn, with no turn of its own,
  and has its `you` line when the model takes it in (the desktop) or at Enter (a terminal); one still queued when the
  turn ends keeps one line. Only a person's message has that line (typed, from a bridge, the SDK or Slack), not a
  plugin's or the engine's. A line keeps up to 512 characters of its text, and the pane cuts it to its width. Tool calls
  and subagent results both carry their outcome (✓/✗ and the time, or denied; a restored line differs, see "What a
  reopen restores") in a right-aligned column. A call that started a background task has `→ background` there in place
  of ✓ and its time, which would be the call's, not the task's, whichever agent made the call. The end of a task has a
  line of its own, as the end of a subagent has: `done · shell: <description>` (or `failed ·`, `stopped ·`), with ✓ and
  its time, ✗ and its time (an error line) or, for a stop, the time alone, with `≤` before a time that is a bound (`✓
  ≤12.2s`); an end that comes between turns also has the engine's `task-notification` line, as a subagent's notice has.
  While a `→ background` line is drawn, the outcome column is as wide as it (12 characters, 13 cells on the desktop; it
  is kept whole on purpose), so in a narrow pane `who` gives way sooner: below 45 body columns on the desktop instead of
  39 (with `✓ 0.3s`), and below 35 in a terminal instead of 29 (with `main` as the `who`). A call that comes back as an
  error because it was abandoned (you interrupted it, or a stop did) is not drawn as an error: it is not red, its `who`
  and outcome are dim as on every line that is no error, and its outcome is the time alone, with no ✗; this rests on the
  engine's `next.signal`, and was seen live for a subagent stopped with `TaskStop` and for Esc on the main agent, while
  a call that fails by itself stays red. A call of an agent that is not in Activity is labeled `agent`, and its failure
  is drawn dim, not red: the pane cannot tell a fork's refused try from a real failure. Such an agent is one of the
  engine's own forks (most of them have every tool refused), or, on engines before 2.1.308, a subagent that was started
  before the session was reopened (or Claude Code restarted) and is resumed after it, whose row the restore could not
  rebuild (see "What a reopen restores"): a known limit. From 2.1.308 the resume raises the spawn again and gives such a
  subagent a row, as above. A subagent's answer loses its markdown marks (a pair of `**`, unless an ASCII
  letter, digit or `_` touches it on the outside, so `2**10 and 3**4` stays, and a letter of another script does not
  stop it: `这是**重要**的` gives `这是重要的`; backticks; a heading's `#`). In auto mode a subagent's `done` line shows the
  report it handed back, even when auto mode withheld or flagged it; the text is masked as any other, and the main agent
  did not get it, a known limitation. In a narrow pane the `who` column gives way first, and then the outcome moves in
  front of the text; where there is no `who`, a prompt reads `you › …` and an engine message (a tagged one, such as
  `agent-message`) reads `engine › …`. A subagent's type then shows in the Log only in its `spawned · type: …` line, if
  the cut leaves it: a known limit. Unicode format characters (the bidi controls, zero-width spaces, the BOM and the
  rest) are taken out of the branch (or the short commit of a detached HEAD), the folder name, the Activity lanes, the
  MCP server names, the kind of a rate limit and every log text, since a U+202E would reorder what the pane shows. A ZWJ
  or ZWNJ stays only between two characters that are above U+007F and are no spaces, so emoji sequences joined by ZWJ
  stay whole and Persian and Indic scripts keep their joiners. Tag characters go too, since they can carry invisible
  ASCII, except in the flags of England, Scotland and Wales, which stay whole; any other run of tags after a black flag
  goes and leaves the plain black flag. Beside an ASCII character, a space of any kind or an end of the text a joiner
  would join nothing, and it could hide a character in a branch name or split a secret so that its mask misses it, so it
  goes. The other default-ignorable code points, such as the variation selectors, and a few more invisible ones (U+2800,
  U+20E3, …) go too, beside ASCII, where they could split a secret from the mask. They stay where they shape text: after
  a character above ASCII (an emoji's variation selector) and in a keycap (`1️⃣`, `#️⃣`) that no word or token touches;
  a keycap glued to a word or a token loses its marks. Control characters (C0 but tab, line feed and carriage return;
  DEL; C1), U+10EEEE, a placeholder of the engine's, and a lone surrogate go from the same texts (the vertical tab and
  the form feed become spaces): the engine refuses a text that holds one and draws its own pane in place of the panel's,
  which a pasted ANSI escape used to cause. An escape sequence goes whole, so a coloured log reads as its text and no
  tail of it sticks to a word that the mask looks for: a control string (OSC, DCS, SOS, PM, APC; 7-bit or 8-bit) up to
  its end on the same line, a CSI (7-bit or 8-bit), an `ESC ( B` such as `tput sgr0` ends in, a two-byte escape such as
  `ESC 7`. A stray ESC or U+009B goes alone, and a control string that nothing ends on its line loses its introducer
  only (the ESC alone, for `ESC P` and `ESC X`: the letter stays). A mask then hides secrets in every Log line, the
  Activity lanes (a subagent's type and description, a task's description). It takes the credential of an Authorization
  header (Bearer and Basic keep the scheme: `Bearer •••`; any other scheme goes with it: `Authorization: •••`), a quoted
  Authorization value whole, the value of a key named like a secret (`password`, `token`, `api_key` and the like) after
  `:` or `=`, also when a quote closes the name, as in JSON, a Python dict and a curl body (`"password": "…"`), tokens
  with a known prefix (`sk-`, `ghp_`, `github_pat_`, `xoxb-`), a GitHub or Slack token and a `Bearer …` that a removed
  escape sequence glued to a word, the `--token`, `--password`, `--api-key` and `--secret` flags, the values of
  `*_KEY=`, `*_TOKEN=`, `*_SECRET=` and `*_PASSWORD=`, and the password in a URL. The names `secret_key`,
  `secret_key_base`, `access_key` and `private_key` are read in any case, with `_`, `-` or nothing between the words
  (`secretKey`, `SECRET_KEY_BASE`): after a quoted name (`{"secret_key": "…"}`), unquoted with `=`, `:`, `=>`, `:=`,
  `?=` or `+=` (`secret_key=…`, `secretKey := "…"`), as a flag (`--secret-key …`, `--s3-secret-access-key …`), and as
  `aws configure set aws_secret_access_key …`. A quoted value of an unquoted name that nothing closes on its line masks
  the rest of the text, so a PEM in a `.env` file stays masked. After a quoted name a bare `true`, `false`, `null` or
  `none` shows as it is (`{"secret": false}`, `{'password': None}`), and so does a bare number after a counter's name
  (`max_token` or `min_token`, with `_`, `-` or nothing between the words: `{"max_token": 4096}`); any other bare number
  is masked (`{"token": 482913}`, `"password": 123456`), as a quoted one (`"4096"`) and an unquoted `token: 120` are. A
  value that begins with a flag, a key and its separator (`--token …`, `password: …`, `Authorization: …`,
  `db.password=…`, `X-API-Key: …`) or a `Bearer` that ends its line is left to the pattern that reads it, which masks
  its own secret (a value that begins with a key and `?=` or `+=` after a quoted name, `"password": pwd+=VAL`, is read
  by no pattern and shows); a value that has a name glued inside (`MyApiKey:…`) or ends in `…token==` goes whole. The
  mask is no scanner: it has no pattern for `curl -u user:pass`, `mysql -p…`, `.netrc`, a `Cookie:` header, `glpat-`
  tokens, a PEM key or a JWT on its own, and it misses a key written in a form it does not read (an escaped JSON key in
  a shell string, `d["password"] = …`, an XML element such as `<secretKey>`, Azure's `AccountKey=`), a value on the next
  line or in a YAML block (`private_key: |`) after an unquoted name, a typed default (`secret_key: str = "…"`), the
  default in `os.environ.get('SECRET_KEY', '…')`, a number under a counter's name (`{"max_token": 482913}`, also behind
  a malformed key such as `{" "max_token": 482913}`, where the closing quote of `" "` passes for the key's opening
  quote), a bare value on the line after a quoted name (`"token":` and `482913` on the next line), all but the first
  part of a Digest or AWS4 credential, and a token whose first letter a crafted escape sequence takes. A tag's name that
  has a secret's shape with no known prefix (`<glpat-…>` at the start of a prompt) shows as the line of an `engine`
  turn, live and restored. It over-masks in known cases: a name that ends in `Bearer` (`JwtBearer`) masks the word after
  it, two code spans around `Authorization:` mask the prose between them, the closing quote after the value of an
  Authorization header, whatever its scheme (`: 'Authorization: Token …'` reads `: 'Authorization: •••`), goes with the
  token, the `;` after a bare value goes with it (`password=abc; next` reads `password=••• next`), prose that has a
  key's name in it (`grep -rn "password": src/` masks `src/`, `Authorization: required for all` reads `••• all`,
  `{"pwd": path}`, a name in backticks such as `` `token`: ``, a name in curly quotes) masks the word after it, a quote
  or a backtick after a `_key` name that nothing closes on its line hides the rest of the text (prose such as ``Set
  `secret_key:` in config``), a counter of another shape (`{"max_new_token": 5}`) has its number masked, and `set
  aws_secret_access_key in the file` reads `••• the file`. Section 4.7 of the design spec (in Russian, linked from the
  [docs](https://github.com/philarete173/claude_mods/blob/main/docs/README.md) page) has the full list.

## Settings

The plugin has one option, `motion`: `full` (the default) or `reduced`. With `reduced` the pane draws no animation:
no pulses, ripples or beat rings, the halos are steady, and the live ends of the ribbon and the lanes stand still, so
the ribbon's live part grows only when the pane redraws.

- In `/config`, the enabled plugin's option shows as a picker row.
- `/plugin configure session-panel@philarete-mods` sets it.
- At install from a shell: `claude plugin install session-panel@philarete-mods --config motion=reduced`.

An install through `/plugin` asks for the option while it is unset; an install from a shell does not ask, and the
option keeps its default. The mod reads the option when it loads, so the pane picks up a change after Claude Code
restarts.

## Limits of the drawings

- No tooltips. Every drawing is an image: an interactive one is mounted again on every redraw, so it jerks and its
  tooltip blinks. Each drawing has a text alternative, its alt, that says what it shows: the band's counts, the turn's
  shares, a lane's description, type, status and value.
- Pale hues on a light terminal. The desktop's drawings follow the app's theme, dark or light. A terminal always gets
  the dark set of hues, since the mod cannot know the terminal's background, and on a light one they look pale. No
  setting changes that.
- The compaction ticks are best effort: one for each main `session.compact` the mod sees. Another plugin can keep the
  event from the mod, as cc-plugin-sec-default does. The engine drops the context's tokens after a compaction, until
  the next response, so the mod then counts it at its next usage reading that finds them gone: the reading of every
  minute, the main agent's next prompt, or a measure. It draws the tick and a bare `compacted` line, with no token
  numbers. A compaction inside a running turn whose next response comes before any reading is still missed, and two
  rare races can count one compaction twice.
- A call the engine blocked is known by its error text alone, which starts `Blocked:`. Should the engine change that
  text, such a call reads as a failure again.
- Restored lanes are dashed, and restored stations have no running or failure marks of their own (see "What a reopen
  restores").
- A call whose `tool.call` another plugin answers never reaches the mod's hook, so it stays in flight, and its station
  running, until its agent's next model request.

## What a reopen restores

- When: at `session.start`, when the subagents, the tasks and the Log are all empty: a new process (the desktop app
  reopened, `claude --resume`, the mod enabled mid-session). A hot reload keeps the state and restores nothing. After an
  in-process `/resume` (a terminal's REPL) it restores at the first turn of the main agent, without that turn's own
  rows. Not after `/clear`, and a `/clear` after a `/resume` cancels the restore that the resume left due. It also
  restores at the first turn of the main agent, without that turn's own rows, when another plugin sent `session.start`
  past the mod (the pane, its command and its timer start there too), unless something was drawn before that turn (a
  subagent the engine resumed), which keeps the restore out as a hot reload's state does. To keep the mod off, disable
  it.
- What: from the newest 4096 rows of the main conversation, walked from the latest compaction summary on. The
  subagents: every Agent call that has an agent id, `done` or `failed` by its result, `done`, `failed` or `stopped` by a
  task notice or a `TaskStop`, else `running` when the engine still lists it alive, or `ended`. The tasks: the
  background calls, closed by notices or `TaskStop`, else `ended`. The band: each station's count of calls, and
  Model's of steps, after the latest compaction summary, added to the counts it holds; and the compactions, one for each
  compaction summary among the rows. The core's model: read from the engine at the start, before the first response,
  whose model then replaces it. The Log: prompts, the turns the engine opened, as live (`engine › task-notification`, a
  `!` command or a skill's command that the model answered; a local command that asks the model nothing has no line),
  task notices, subagent and task lines, and the main agent's tool calls with `✓` or `✗`; the newest 200 are kept, and
  the header counts all.
- How it looks: a Log line has no clock time (a dim `—`). A restored tool call has its `✓` or `✗` and no time (`→
  background` if it started a task, and none if it was still running when the transcript was read). An end line has a
  time only where the call or the notice gave one (a foreground Agent's `durationMs`, a notice's `<duration_ms>`):
  without one, a subagent's end line keeps its `✓` or `✗` and a task's has no outcome, and a stop has none. An end line
  has no answer when the notice says, in the engine's own sentence, that the agent ended without a report or that its
  report came as a message (an answer that holds such a sentence loses its text); a notice that says the agent has not
  reported yet closes nothing. A restored subagent or task has no known start, so its lane is dashed over the whole
  axis, with the pulsing cap while it runs and its mark otherwise, and the axis does not reach back for it. A running
  one comes after the running lanes whose start is known; an ended one comes last, unless its end was seen live, which
  places it among the others by its end.
- Live rows win on an id, and restored lines are older than live ones.
- Not restored: subagents' own tool calls; subagents' hand-backs, which the engine keeps out of the messages (so a
  subagent that reported between turns and has no notice row is `ended`); prompts, notices and other agents' messages
  that arrived mid-turn, which are not rows; tool times, denials and interruptions (a denied or interrupted call reads
  `✗`); Turn stats (`No completed turn yet` until a turn starts); main's turns in Activity (its lane shows the turns
  that start after the restore); the band's calls in flight, failures and pulses, so a restored station has no running
  or failure mark of its own (a restored subagent that runs still counts at Agents and Model); the `compacted` and
  `resumed` lines; costs before the restore; rows before the latest compaction after a restart. A task that was restored
  while it still ran stays `ended` when its notice comes, and a task that the engine's own notice after a reopen names
  (`failed` or `stopped`, with a note) stays `ended` too. A notice that is typed, pasted or sent through the SDK, or
  that another plugin forges, can close a restored row (display only), and a prompt that starts with the summary's
  phrase hides the rows before it.

## How costs are measured

There is no price table and no network access. After every model request the mod reads the engine's own `cost.usd`
and attributes the increase to the agent whose step has just finished, the main agent or a subagent. The figure at
the top is the engine's Total; Subagents is the sum of what the subagents were charged; Session = Total − Subagents.

With subagents running at once the split is approximate: steps that overlap can charge one agent for another's
request. The same subagent was measured at $0.100 beside a parallel review and $0.046 alone. The totals stay exact:
Total = Session + Subagents.

After the app restarts (a reopened session) the pane is rebuilt from the session's messages, which carry no costs: what
the subagents were charged before the restore is not known. While a restored subagent is listed and the Total is known,
the split reads `Subagents $Y+` (Y the sum of the known costs, a lower bound) and Session is not shown. A subagent
resumed with no row in the pane (one from before a reopen or a `/clear`) is listed with its cost since the resume and a
`+`, so the split reads `Subagents $Y+` then too, with or without a reopen. Before 0.6.0 the pane started over, and the
cost of the subagents that ran before counted as Session: Subagents fell from $4.80 to $0.008 in a live check. Total is
right.

## What the mod does not do

- No network access.
- No reading of a credential store, environment variables or settings files. The transcript that the mod reads to
  restore the pane (below) can hold a secret in a tool result, which the pane does not draw.
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
- To rebuild the pane it reads the session's transcript through the engine (`$.session.messages()`), tool results
  included. It draws only prompts, call labels (commands, paths, queries), subagent descriptions and answers, task
  descriptions, and the name of the tag that opened a turn (not its body or attributes), masked best-effort as live
  lines are, and never tool output, file contents, the prompts given to subagents, error texts or the compaction
  summary. Nothing from the transcript is written to disk or sent; it stays in session plugin state, which other plugins
  can read, as live lines do. A reopen shows earlier prompts and commands again.
