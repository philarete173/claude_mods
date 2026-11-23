# session-panel 0.7.2: the fixes of the 0.7.1 live check

## 1. Status, origin, references

Date: 2026-11-23. Status: settled with the owner (D1–D10, 2026-11-23) and the controller's rulings on the spec's open
points (§15, R-1–R-11); implemented in 0.7.2 (2026-11-23). This spec writes the decisions down and checks them
against the code and the engine. Where the code or the engine forced a choice of detail, the choice is marked "detail"
with its reason. A rule that comes from a ruling says so (`R-n`).

Origin:

- the live check of 0.7.1, `docs/live-check-2026-11-20-0.7.1.md` (Russian). LC1–LC5 are its "Что починить" items,
  LC5a–LC5i the bullets of item 5 in order, LC0 its section "Итог по прошлому списку";
- the owner's picks of 2026-11-23: the task tail V1 (`.superpowers/design/2026-11-23-0.7.2/mockups-1.html`), the
  palette P2 (`mockups-2.html`), the shrinking tag ("Тег ужимается"). The generator is in `mockup-src/` (`gen.ts`,
  `gen2.ts`, the fork `mods/lanes-v.ts`, the colour maths `color.ts`). The folder is git-ignored.

This spec is a delta against the 0.7.1 spec (`2026-11-18-session-panel-0.7.1-design.md`, "0.7.1 §") and the 0.7.0
spec (`2026-11-16-session-panel-visualizations-design.md`, "0.7.0 §"). Bare § points into this spec. Where this spec
is silent, those stand.

Code references are into `plugins/session-panel/` at a9108da (the mod's files equal the 0.7.1 release, a605580).
Engine type references are to `.superpowers/engine-types/{2.1.288,2.1.308,2.1.325}/claude-code/index.d.ts`, on disk;
"d.ts 2.1.325:N" is a line of that file. Engine texts are quoted from the 2.1.325 binary
(`~/.config/Claude-3p/claude-code/2.1.325/00b1b977bcc3/claude`), with the byte offset of the JS source that holds
them (`@316783219`). The mod supports engines 2.1.288 to 2.1.325: every rule relies only on what 2.1.288 has, or says
how it degrades.

| § | Item | Live check | 0.7.0 sections it changes | 0.7.1 sections it changes |
|---|---|---|---|---|
| 2 | Engine refusals are denials (D1) | LC1, LC5b | §8.2, §8.6 | §9, §15 |
| 3 | One pulse per call (D2) | LC5a | §4.8, §8.2 | §7, §16 |
| 4 | Activity labels: the tag shrinks (D3) | LC5f | §6.4, §6.5, §6.6 | §4.2, §4.3, §4.5, §4.6 |
| 5 | A background task's bounded end (D4) | LC2 | §6.2, §6.5, §8.4, §8.7 | — |
| 6 | The ribbon splits parallel calls (D5) | LC5c | §5.3, §5.4 | §17.2, §17.11 |
| 7 | A prompt of images (D6) | LC5d | — | — |
| 8 | Usage guards and the model after a reset (D7) | LC3, LC0 | §8.5 | §8, §11, §15 |
| 9 | Cuts and numbers (D8) | LC5i | §4.1, §6.4 | §4.3 |
| 10 | Palette P2 (D9) | LC5g | §1.4, §3.3 | §5 |
| 11 | Docs (D10) | LC4, LC5e | §1 (header) | §1 (header) |

## 2. Engine refusals are denials (D1; LC1, LC5b)

### 2.1 What the live check saw, and why 0.7.1 missed it

0.7.1's rule (`hooks/register.tsx:1157-1163`) takes a call as blocked when `ran.text` or `ran.result` starts with
`Blocked:`. The engine wraps a refused input in a tag: a failed `validateInput` yields the tool_result
`<tool_use_error>${message}</tool_use_error>${remedy ?? ""}` (`@315809950`), and `text` is "the error as the model
reads it" (d.ts 2.1.325:14745; 2.1.288:12066). So `text` starts with `<tool_use_error>`, and the test's bare string
(`hooks/register.test.ts:766-770`) passed. Other refusals reach the model untagged (the user's rejection,
`@321412855`) or tagged (a permission rule's denial, `<tool_use_error>${denyMessage}</tool_use_error>`,
`@315810745`, whose stored `result` is `Error: ${denyMessage}`).

### 2.2 The rule

One pure function in `hooks/stats.ts`, beside the other text rules, used by the live hook and the restore:

```text
isRefused(tool: string, isError: boolean, text: unknown, result: unknown): boolean
```

- **Applies** when `isError === true` and `tool` does not start with `mcp__`, as 0.7.1 §9 has it.
- **Reads** `text` and `result`, each only when it is a string. A value of another type is no refusal text, so the
  check cannot throw.
- **Unwraps** each: drop leading white space; if what is left starts with `<tool_use_error>`, drop that tag, and drop a
  `</tool_use_error>` at its end if there is one. A remedy after the closing tag (`@315809950`) leaves it in place;
  only the start is read.
- **A refusal** is an unwrapped text that:
  1. starts with `Blocked:`;
  2. starts with `The user doesn't want to proceed with this tool use`, unless it contains
     `Correction to the text above: this call was stopped while running` (R-2: that text, `Jbn`, is no refusal);
  3. starts with `Permission for this action was denied`;
  4. starts with `Permission for this action has been denied`;
  5. has a first line that starts with `Permission to use ` and contains ` has been denied`, or ` denied by plugin`
     (R-1: a plugin's `tool.check` denial; ` denied by plugin` covers `by plugins` too);
  6. has a first line that contains `, so auto mode cannot determine the safety of ` and does not start with
     `Exit code`;
  7. (R-1) starts with `Permission for this tool use was denied`, `Permission for this command was denied`, or
     `This tool call was refused and did not run: `.
- **The first line** is the text up to the first `\n`, or the whole text.
- A shortcut comment replaces 0.7.1's at `hooks/register.tsx:1157-1158`, on the function: `// shortcut: the engine
  marks a refused call only by its text, of a built-in tool (an MCP server writes its error text freely); use a deny
  or a reason field if the engine gives one`.

### 2.3 The engine's texts, verbatim

Each start is pinned in the 2.1.325 binary. `${…}` is the engine's own value.

Rule 1, `Blocked:`:

- `Blocked: ${q}. To wait for a condition, use Monitor with an until-loop (e.g. …). To wait for a command you
  started, use run_in_background: true. Do not chain shorter sleeps to work around this block.`, the `…` being the
  code span of `BLOCKED_LIVE` below (Bash `validateInput`, `errorCode: 10`, `@316783219`); `q` is
  `standalone sleep ${n}` or `sleep ${n} followed by: ${rest}` (`@316775868`);
- PowerShell's twin: `Blocked: ${g}. …`, `g` is `standalone Start-Sleep ${s}` or `Start-Sleep ${s} followed by: ${m}`
  (`@329013570`);
- auto mode's `Blocked: ${reason}` for four reasons (`Classifier unavailable`, …; `@301349986`).

Rule 2, the person's rejection (`@302888679`, `@316813179`):

- `c3r`: `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit,
  the new_string was NOT written to the file).`;
- `kh`: `c3r` + ` STOP what you are doing and wait for the user to tell you how to proceed.`;
- `A0`: `c3r` + ` To tell you how to proceed, the user said:\n` and the user's words;
- `Jbn`: `kh` + ` Correction to the text above: this call was stopped while running, not refused before it ran. …`
  (`@302888679`): no refusal (R-2).

Rules 3 and 4, the auto-mode classifier (`@316821889`, which tests the same two starts itself, `c8i`):

- `Permission for this action was denied by the Claude Code auto mode classifier. Reason: ${reason}`;
- `Permission for this action has been denied. Reason: ${reason}`.

Rule 5, permission rules:

- `Permission to use ${tool} has been denied.` (`@314767131`), `Permission to use ${tool} with command ${cmd} has
  been denied.` (`@312693806` and others), `Permission to use ${tool} has been denied: …` (`@310328671`);
- (R-1) a plugin's `tool.check`: `Permission to use ${tool} denied by plugin ${name}: ${reason}`, or `by plugins
  ${a}, ${b}` (`@311365438`).

Rule 6, auto mode could not decide (`Ihe` = `, so auto mode cannot determine the safety of `, `@316828533`):

- `${n} is temporarily unavailable${Y}${Ihe}${tool} right now. Wait a moment and then try this action again. …`
  (`@316836806`);
- `The API told auto mode's safety classifier (${n}) to wait ${t} from now${Y}${Ihe}${tool} until then. …`;
- `${n} gave no verdict${Y}${Ihe}${tool}. …` (`@316835915`) and `${tool} was not run: ${why}${Ihe}${tool}. …`
  (`@316829915`).

Rule 7 (R-1):

- `Permission for this tool use was denied. …`: four texts. `It requires approval, and this session has no approval
  surface` follows the start (`n4e`, `@311518924`); `: it requires interactive approval` (`wFo`, `@316816056`);
  `. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). Try a different
  approach or report the limitation to complete your task.` (`MW`, `@316813179`); and the same up to `the file).`,
  then ` The user said:\n` and the user's words (`g$e`, `@316813398`);
- `Permission for this command was denied by a built-in Claude Code safety check` (`@316816136`);
- `This tool call was refused and did not run: the permission answer for it could not be matched to this call. Do
  not run it again unless the user asks you to.` (`jXn`, `@302888679`).

The `Bash` text in full, as a test takes it (one string, joined with no break):

```ts
const BLOCKED_LIVE = '<tool_use_error>Blocked: standalone sleep 30. To wait for a condition, use Monitor with an ' +
  'until-loop (e.g. `until <check>; do sleep 2; done`). To wait for a command you started, use run_in_background: ' +
  'true. Do not chain shorter sleeps to work around this block.</tool_use_error>'
const REJECTED = 'The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a ' +
  'file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell ' +
  'you how to proceed.'
const INTERRUPTED = `${REJECTED} Correction to the text above: this call was stopped while running, not refused ` +
  'before it ran. It may have run in part or in full, and its changes may have been written.' // a head of `Jbn`
const NO_SURFACE = 'Permission for this tool use was denied. It requires approval, and this session has no approval ' +
  'surface'
const SAFETY_CHECK = 'Permission for this command was denied by a built-in Claude Code safety check'
const UNMATCHED = 'This tool call was refused and did not run: the permission answer for it could not be matched to ' +
  'this call. Do not run it again unless the user asks you to.'
const BY_PLUGIN = 'Permission to use Bash denied by plugin guard: no shell here'
```

`${n}` (the classifier's name) and `${Y}` (a parenthesis) vary, so a test takes them as `The safety classifier` and
`''`. The `Exit code` guard keeps a command's own output out: a Bash failure's text is `Exit code N`, then the output.

### 2.4 Drawing and counting

A refusal is drawn as 0.7.1 §9 draws a blocked call:

- **Live** (`tool.call`, `hooks/register.tsx:1150-1243`): `isDenied = ran.deny !== undefined ||
  isRefused(e.tool, ran.isError === true, ran.text, ran.result)`, in place of `isBlocked` (`:1159-1163`). The Log
  outcome is `denied` (`:1225`), the station has no failure (`:1170`), main's segment is not failed (`:1234`).
  `isFailed` (`:1198`) stays true: no task, no hand-back. The project read stays gated on `ran.deny === undefined`
  (`:1197`, 0.7.1's F8): a refused write tool still asks it.
- **The Log's look.** A denied line has kind `error` (`:1230`): the view draws its `who` and its outcome `denied` in
  red (`hooks/view.tsx:926-930`, `:938-942`), as 0.7.1 §9 does. Denied rows have no look of their own beyond that.
- **An abandoned call** (`isAbandoned`, `:1156`, the signal aborted) whose text is a refusal reads `denied` (R-11):
  the outcome tests `isDenied` first (`:1225`), as a `ran.deny` does today. Its kind is `info` (`:1230` tests
  `isAbandoned` first), so its `who` and `denied` are drawn dim, in the secondary text colour, not red. The engine text
  in question is `kh`: the rejection at a permission prompt, and also the stand-in result the engine writes for a call
  the person interrupted (`createSyntheticErrorMessage`, `user_interrupted`, `toolDenialKind: 'user-rejected'`,
  `@321412855`). The text cannot tell the two apart, and the text wins. A running call stopped by a remote cancel
  gets `Jbn` instead, which rule 2 leaves out (R-2), so it keeps the abandoned line (its time alone, dim).
- **Restored** (`hooks/restore.ts:93-150`): `readCall` reads `isError` at `:99` and `callLine` (`:102-108`) draws
  `['error', '✗']`. A refusal draws `['error', 'denied']`, the live line's kind and outcome. `isRefused(tool, isError,
  use.text, use.result)` is computed once in `readCall`. Nothing else in the restore changes: the restore counts no
  station failures (`stationCalls`, `:96`), and the task and the `TaskStop` keep reading `isError` (a refused call
  started nothing). A refused Agent call has no `agentId` (d.ts 2.1.288:12361 on: "Absent … on an Agent call the
  session refused before an agent started"), so it takes the `isAgentCall` path (`:136-138`), whose `callLine` reads
  the same pair.

### 2.5 Tests

- `stats.test.ts`, `isRefused`: true for `BLOCKED_LIVE`; for each text of §2.3's rules 1–7, `REJECTED`,
  `NO_SURFACE`, `SAFETY_CHECK`, `UNMATCHED`, `BY_PLUGIN` (R-1) among them, each in `text` and in `result`, wrapped in
  `<tool_use_error>…</tool_use_error>` and bare, with leading white space; for `BLOCKED_LIVE` with a remedy after the
  closing tag. `Blocked: sleep 5 followed by: echo done. To wait …` is true.
- `isRefused` false: `Exit code 1\nBlocked: standalone sleep 30` (a command that prints the word); `Exit code 1\n` +
  the row 6 text; `Error: Blocked: x` (0.7.1's case); any refusal text for `mcp__x__y`; `isError` false with
  `BLOCKED_LIVE`; `text` 42 or `{}` with `result` undefined; `INTERRUPTED`, bare and wrapped, in `text` and in
  `result` (R-2); `Permission to use the room` (no ` has been denied`, no ` denied by plugin`).
- `register.test.ts`: the mock's `blocked-text` answer (`:766`) becomes `BLOCKED_LIVE`; `blocked-result` keeps
  `result: 'Blocked: standalone sleep 60'` with no `text`. The tests at `:3496`, `:3514`, `:3528`, `:3545`, `:3558`
  hold with the new strings. New: `REJECTED` as `text` → Shell `calls` + 1, `failedThisTurn` 0, Log `denied`,
  segment not failed; the same call with the signal aborted → Log `denied`, kind `info` (R-11); `INTERRUPTED` with
  the signal aborted → the abandoned line (the time alone, kind `info`), as today (R-2); `INTERRUPTED` with the signal
  not aborted → a failure (`✗`, `failedThisTurn` 1), as today. `UNMATCHED` and `BY_PLUGIN` as `text` → `denied`.
- `restore.test.ts`: a row whose Bash use has `isError: true`, `text: BLOCKED_LIVE` → its line `{ kind: 'error',
  outcome: 'denied' }`; the same with `REJECTED` and with `SAFETY_CHECK`; `INTERRUPTED` → `✗` (R-2); `isError: true`
  with `Exit code 1` → `✗`; an `mcp__x__y` use with `BLOCKED_LIVE` → `✗`.

Files: `hooks/stats.ts`, `hooks/register.tsx`, `hooks/restore.ts`, their tests.

## 3. One pulse per call (D2; LC5a)

### 3.1 Today

A call pulses at its first chunk (`markInFlight`, `hooks/register.tsx:781-796`, the write at `:795`), and `tool.call`
pulses it again at its return when it has no in-flight entry (`isUnseen`, `:1171-1181`). The entry also goes missing
when the call was seen:

- eviction past `IN_FLIGHT_MAX = 64` (`:134`, `:791-793`);
- the wipes at `session.start` (`:909`), the reset (`:957`), `restorePane` (`:320`), `turn.complete` (`:1250-1251`),
  the agent sync (`:715-716`) and `pulseModel` (`:803-804`);
- a chunk whose `markInFlight` passes its check (`:783`) after `tool.call` read the map (`:1174`) and before
  `doneCallIds.add` (`:1185`): the chunk pulses, and the return has pulsed already.

0.7.1 §16 named one more: a `tool.call` that lands between `markInFlight`'s check and its update returns `held` from
the in-flight update (`:788`), but the pulse at `:795` is written all the same.

### 3.2 The rule

- **A record of pulsed calls**: `pulsedCallIds`, a module `Set<string>` beside `doneCallIds` (`:140`), the latest
  `CALL_IDS_MAX = 256` ids, oldest dropped first. `DONE_CALLS_MAX` (`:137`) becomes `CALL_IDS_MAX` and caps both, and
  one helper keeps both (delete, add, drop the oldest past the cap: today's `:1184-1186`). Detail: the two sets stay
  apart. `doneCallIds` means "its `tool.call` has run", which keeps a late chunk out of the in-flight map (`:783`,
  `:788`); a pulse record alone cannot tell a first chunk from a chunk after the return.
- **`markInFlight`**: after its clock read and the `doneCallIds` check (`:782-783`), in the same synchronous step,
  `isFirst = !pulsedCallIds.has(id)`, and the id is added. The in-flight update is as today; the station's
  `lastCallAt` is written only when `isFirst`.
- **`tool.call`**: right after `t1` is read (`:1164`), with no `await` between, `isUnseen = callId === undefined ||
  !pulsedCallIds.has(callId)`, and the id, when there is one, is added to `pulsedCallIds` and to `doneCallIds`. The
  read of `inFlightAtom` at `:1174` goes; the station write (`:1175-1182`) keeps `isUnseen ? { lastCallAt: t1 } : {}`.
  The removal of the entry (`:1187`) is unchanged; the `doneCallIds` lines at `:1184-1186` move up into this step.
- **Kept over a reset** (R-3): `pulsedCallIds` is not emptied at `/clear` or a resume (`doneCallIds` is, `:941`). An
  id is unique and the set is bounded, so the rule holds with no exception there.
- **Accepted**: a hot reload starts the module state over, so a call in flight across a reload may pulse twice. Ids
  past the cap are forgotten: a call whose return comes after 256 newer calls have pulsed pulses again.

### 3.3 Tests (`register.test.ts`)

Each reads `stations[station].lastCallAt` after the return. "Pulses once" means it equals the chunk's time, not `t1`.

- **Evicted**: a call's chunk at time T, then 64 newer chunks (its entry is evicted), then its `tool.call` returning
  at T + 5 s: `lastCallAt` is T (before: T + 5 s).
- **Wiped by `pulseModel`**: the chunk at T, a step of the same agent whose first chunk drops the entry, then the
  call's return: `lastCallAt` of its station is T.
- **Wiped by `turn.complete`**: the same, with a main `turn.complete` between the chunk and the return.
- **No chunk**: a call with no chunk, and one with no `tool_use_id`, pulse at the return: `lastCallAt = t1`
  (`:3479`'s test, unchanged).
- **A chunk after the return**: `tool.call` returns at T, then a chunk of the same id is marked: `lastCallAt` stays
  T, and the id is not in flight (`:3583`'s test, extended).
- `calls` goes up by 1 in each case.

Files: `hooks/register.tsx`, `hooks/register.test.ts`.

## 4. Activity labels: the tag shrinks (D3; LC5f)

### 4.1 Today

`L = laneLabelCells(cols) = clamp(floor(cols × 0.45), 9, 64)` (`hooks/lanes.ts:75-77`). From `L ≥ TAG_FROM = 24`
(`:37`), `tagW` is the widest shown tag (`:135`), up to 15 cells (`@` + `shortType`, `TYPE_MAX = 14`,
`hooks/stats.ts:280`, `:283-287`), and `descCells = L − 1 − tagW` (`:136`). At 54–57 columns a description gets 8–9
cells (`Securit…`). `cutCells` (`hooks/cells.ts:10-13`) keeps `n − 1` code points and `…`, so a cut after a space
leaves it: `Review …`.

### 4.2 The rule

- **The tag column**: `T = min(tagW, L − 1 − 12)` cells, from `TAG_FROM` as today; `descCells = L − 1 − T`. So a
  description keeps at least 12 cells, and gets more only once the widest tag is whole.
- **Each tag** is cut at its end to `T` cells (`cutCells(tag, T)`). A subagent's tag is already `@` + a type cut at 14
  (`@appsec-engine…`); cutting it again keeps one `…`.
- **No floor.** With `TAG_FROM = 24`, `T ≥ 24 − 13 = 11`, so the owner's "hidden under 6 cells" floor never triggers.
  The code carries no floor; a one-line comment at `T` says why.
- **The end cut** (`cutCells`): the kept head drops its trailing white space before `…` (`.trimEnd()`; on an
  all-space head that leaves `…` alone). It is one change for every caller: the descriptions (`:137`), the tags,
  `fitRow` (`hooks/cells.ts:61`, every terminal row of the pane), `middleCut`'s fallback (`:27`), the core's model
  (`hooks/band.ts:140`) and the legend's cut item (`hooks/ribbon.ts:365`).
- **The middle cut** (`middleCut`, `hooks/cells.ts:25-43`) keeps 0.7.1 §4.3's head rule (`:40`): the head drops its
  trailing spaces unless that leaves fewer than 4 code points (`Fix …X12`). Only the end cut drops the space always
  (R-6). The middle cut's tail starts at a word or at a code point, never after a space (`:37-38`).
- **Both surfaces** take `LaneLabel.tag` as cut (`laneLabels`, `:151-154`): the terminal row (`:322-324`) and the
  desktop label cell (`hooks/view.tsx:711-723`). Neither needs another change: the tag stays the last thing in the
  label, and the label's Box (`hooks/view.tsx:703`) is `L` cells wide.

### 4.3 Widths (a 15-cell tag, `@appsec-engine…`)

| cols | L | T | descCells | the tag drawn |
|---|---|---|---|---|
| 53 | 23 | — | 23 | none |
| 54 (≈ 464 px pane) | 24 | 11 | 12 | `@appsec-en…` |
| 57 | 25 | 12 | 12 | `@appsec-eng…` |
| 62 | 27 | 14 | 12 | `@appsec-engin…` |
| 63 | 28 | 15 | 12 | `@appsec-engine…` (whole) |
| 65 | 29 | 15 | 13 | whole |
| 108 | 48 | 15 | 32 | whole |

With shorter tags `T` is `tagW` sooner and the description wider by the difference. 0.7.1 §4.5's table changes in
its `L` = 24 row (`8 + 1 + 15` becomes `12 + 1 + 11`); the rows from 108 on are unchanged.

### 4.4 Tests

- `lanes.test.ts`, `laneLabels` with a lane of type `appsec-engineer` (shown `@appsec-engine…`) and one of
  `general-purpose`: at L 24 every `descCells` is 12 and the tags are `@appsec-en…` and `@general-p…`; at L 25, 12
  and `@appsec-eng…`; at L 28, 12 and the tags whole; at L 29, 13. In `lanesTerminal` at 54 columns every tag starts
  at cell 13 (0-based), and no row is wider than 54.
- `cells.test.ts`: `cutCells('Review the 0.7.1 diff', 12)` is `Review the…`; `cutCells('Review the diff', 13)` stays
  `Review the d…` (`:11`); `cutCells('a   b', 3)` is `a…`; `cutCells('    x', 3)` is `…`.
- The middle cut at 12 cells tells the live lanes apart: `Label check: background sleep with a long description,
  lane A` and `… lane B` give `Label…lane A` and `Label…lane B`; `BAND_CHECK` (`cells.test.ts:27`) at 12 gives
  `Band che…p A` … `Band che…p D`. 0.7.1's middle-cut tests (`:29-58`) hold.
- Replaced: `lanes.test.ts` cases that pin `descCells` 8 or a whole 15-cell tag at L 24–27; `view.test.tsx:3975`'s
  44-column strings are below `TAG_FROM` and hold.

Files: `hooks/lanes.ts`, `hooks/cells.ts`, their tests.

## 5. A background task's bounded end (D4; LC2)

### 5.1 Today

A task closes when its notice arrives: `prompt.submit` with `origin.kind === 'task-notification'`
(`hooks/register.tsx:1372-1381`) calls `closeTask` (`:750-767`), which calls `finishTask` (`hooks/stats.ts:1028-1035`).
`finishTask` sets `endedAt = at`, the arrival, even when the notice gives `<duration_ms>` (parsed at
`hooks/stats.ts:882-886`). The `≤` comes from `atMost` (`register.tsx:1379`, `IDLE_GAP_MS` `:218`) and `isBound`
(`stats.ts:1032`). `lanes.ts` draws the span to `endedAt` whatever `durationAtMost` says (`laneModel` `:101-104`,
`drawLane` `:186-201`, `laneBar` `:275-281`). A shell task's notice has no `<duration_ms>` (`stats.ts:872`), so the
live case is always bounded.

### 5.2 Rule 1: the notice's duration is the end

`finishTask`: when `durationMs !== null` and `row.startedAt !== null`, `endedAt = min(at, row.startedAt +
durationMs)`; otherwise `at`, as today. Detail: the `min` keeps the end at or before the notice when the mod's start
is later than the engine's (a `run_in_background` call starts at its return, `stats.ts:838`). `durationMs` and
`durationAtMost` are as today: such a row is exact, and nothing is faded.

### 5.3 Rule 2: K, the last request the task was still running at

- **State.** `TaskRow` gains `seenRunningAt?: number`: the start of the latest main-agent model request at which the
  row was still running. In `types/index.d.ts:75-87` and its mirror `hooks/stats.ts:100-112`; the mirror check
  (`register.test.ts:13-19`) holds.
- **Written** by a main `turn.step` (`e.agentId === undefined`): after `tStart` is read (`register.tsx:1102`), off
  the stream (`$.clock.after(1, …)`, as `pulseModel` is started at `:1119-1121`), the hook reads `tasksAtom` and, when
  a row runs with a known start, updates it: every row with `status === 'running'` and `startedAt !== null` takes
  `seenRunningAt = tStart`. A pure helper in `hooks/stats.ts` does the mapping. A subagent's step writes nothing.
- **Why it bounds the end.** The engine takes queued notices in before each main request (`register.tsx:1098-1100`,
  `:1375-1376`), and a notice's `prompt.submit` runs no later than that take-in. A task whose notice had not come
  when a request began had not ended before it.
- **Verified, with a gap.** The close does not always land before that request's `turn.step` writes K:
  `prompt.submit`'s `next(e)` "resolves once the prompt entered the session and its turn started, or it was queued"
  (d.ts 2.1.325:10119-10120; 2.1.288:8474-8475), and `closeTask` runs after it, after `await arrival` and a read
  (`register.tsx:1378-1380`). A notice taken in while idle starts its own turn inside `next(e)`, so that turn's first
  `turn.step` can write K = its `tStart`, later than the arrival `at`. A notice queued into a running turn can lose
  the same race by a few awaits.
- **The guard.** K counts only when `startedAt < K < endedAt`; any other K is taken as none. It is applied where the
  lane is built (§5.4), so `finishTask` keeps the field as it is. A K written over a good one by a late step is lost,
  and the bar falls back to all faded: never wrong, only less sure. Accepted.
- A row closed by `TaskStop` (`:1240`) or a notice with `<duration_ms>` is exact; its K is ignored.

### 5.4 Drawing (V1, the faded tail)

- **`laneModel`** (`hooks/lanes.ts:101-104`): `Lane` gains `fadeFrom?: number`. A task lane has it when the row is
  not running, `durationAtMost === true`, and `startedAt` and `endedAt` are known: `fadeFrom = seenRunningAt` when
  `startedAt < seenRunningAt < endedAt`, else `startedAt`. Every other lane has none.
- **Desktop** (`drawLane`, `:186-201`), for the span with an end: when `fadeFrom` is set, `xK = xOf(fadeFrom)` and
  the bar is two rects, from the mockup (`mods/lanes-v.ts`, V1):

```text
<rect data-part="bar" x="{x0}" y="8" width="{xK − x0}" height="3" rx="1.5" fill="{fill}"/>   (only when xK > x0)
<rect data-part="tail" x="{xK}" y="8" width="{x1 − xK}" height="3" fill="{fill}" opacity="0.35"/>
```

  Same colour, same thickness; `TAIL_OPACITY = 0.35`, a constant in `lanes.ts`. `fill` is the span's (the hue, or the
  fade-in gradient for a span that starts before the axis). The end mark stays at `x1 + 6` (`:202-205`). With no K
  (`fadeFrom = startedAt`) only the tail rect is drawn.
- **Terminal** (`laneBar`, `:275-281`): the cells from `at(fadeFrom)` to the span's end are `─` in the hue with
  `dimColor: true`, one style object for the whole tail (`{ ...hue, dimColor: true }`, made once per bar) so that
  the tail is one span. The mark is unchanged.
- **Unchanged**: the value keeps its `≤` (`taskTime`, `:66-72`), as does the Log line (`taskLine`,
  `stats.ts:1011-1023`). A restored task (`startedAt` null) is dashed (`:181-185`). A running task is drawn as today.
  The tail draws no animation, so `motion: reduced` changes nothing here.

### 5.5 Tests

- `stats.test.ts`, `finishTask`: `startedAt` 1000, `at` 9000, `durationMs` 5000 → `endedAt` 6000, no
  `durationAtMost`; `durationMs` 9999 → `endedAt` 9000; `startedAt` null with `durationMs` → `endedAt` = `at`.
- `stats.test.ts`, the K helper: running rows of known start take `seenRunningAt`; ended rows and restored rows do
  not.
- `register.test.ts`: a background Bash task, a main `turn.step` at K, then a notice delivered into a running turn
  with no `<duration_ms>` → the row has `seenRunningAt = K`, `durationAtMost: true`, `endedAt` = the arrival. A
  subagent's step writes no K. A main step whose K lands after the notice closed the row changes nothing. The tests
  at `:5626` and `:5951` (a notice with a duration) now expect `endedAt = startedAt + durationMs`.
- `lanes.test.ts`, `drawLane` at 360 px: a bounded task with K → one `data-part="bar"` rect from the start to `xOf(K)`
  with `rx="1.5"`, one `data-part="tail"` rect from `xOf(K)` to the end with `opacity="0.35"` and no `rx`, the mark at
  the end; with no K → only the tail rect, from the start; K ≥ `endedAt` or K ≤ `startedAt` → as with no K; an exact
  task (with `<duration_ms>`) → no tail rect; `motion: 'reduced'` → the same source as `'full'`.
- `lanes.test.ts`, `lanesTerminal`: the tail cells are one span `{ color: hue, dimColor: true }`, the cells before it
  `{ color: hue }`; the mark after the tail.
- A restored task's lane is unchanged (the dashed line).

Files: `types/index.d.ts`, `hooks/stats.ts`, `hooks/register.tsx`, `hooks/lanes.ts`, their tests.

## 6. The ribbon splits parallel calls (D5; LC5c)

### 6.1 Today

`rowsOf` (`hooks/ribbon.ts:98-132`) merges a step's calls into one group (`:104-126`), from the least `t0` to the
greatest `t1`, in the station of the call with the least `t0` (`:118`); the first call to complete creates the group
(`:115`). The legend's `stationTimes` (`:148-155`) books the whole group to that station. Calls come in completion
order (`addTool`, `register.tsx:1233-1236`). So a Bash call held 70 s by the classifier, with a Read from the same
response that started a moment earlier, painted 70 s of Files.

### 6.2 The rule

A pure function splits one step's calls into pieces; `rowsOf` uses it in place of the group.

- **Cut points**: every call's `t0` and `t1`, sorted, each once.
- **The owner of a piece** `[a, b]` is a call running over it (`t0 ≤ a` and `t1 ≥ b`) that ends last (greatest
  `t1`); on a tie, the earlier `t0`; then the first to complete (the earlier in `tools`). The piece takes the owner's
  station.
- **A gap** (no call runs over `[a, b]`: calls one after another within a step) goes to the piece before it (R-4).
  So the pieces still cover the step's span from the least `t0` to the greatest `t1`, as the group did, and the bar
  keeps no hole within a step. A gap before which no piece exists goes to the running best's station, as 0.7.1's
  group did: a zero-length first call, with the next call starting later, is an example.
- **Merge**: adjacent pieces of one station become one.
- **Failure marks**: a piece is failed when its owner failed. A failed call that owns no piece marks the piece in
  which it ends (the piece whose `[a, b]` holds its `t1`, `a < t1 ≤ b`). Merged pieces keep a mark if any part had
  one.
- Each piece is a `Piece` of `kind: 'tool'` (`:27`), in time order, after the step's model piece (`:101`).
- **The legend** sums the pieces (`stationTimes`, unchanged in form), so its shares match the drawn widths.
- **The merged earlier block** (R-5): `row.spent` (`:102`, `:112`), which `addSpent` (`:134-136`) adds when a step
  merges into `earlier`, takes the step's pieces (each piece's station and ms), not each call whole. The 60-step fold
  in `addStep` (`hooks/stats.ts:220-239`, the calls whose `t0` is before the window: one leaving step's calls) folds
  them the same way. The split function lives in `hooks/stats.ts` (ribbon.ts imports from stats.ts, not the other
  way). Then the legend equals the bar in every path, and 0.7.1 §17.2's "detail" (the two differ in the parallel
  calls of merged steps) goes. `head`, the calls before the first stored step (`:108-110`), keeps each call whole.
- **Bounds**: a step of `k` calls makes at most `2k − 1` pieces; the work is `O(k log k)`: a running best over the
  step's calls sorted by `t0`. More pieces per step make `place` (`:194-235`) and the terminal's merge (`:395-402`)
  merge older steps sooner on a narrow bar; both already handle that.

### 6.3 Tests (`ribbon.test.ts`)

Times in seconds from the step's model stop; each list is in completion order.

- **The live case**: Read [0, 0.3] then Bash [0, 70] → one tool part, Shell, 70 s; `stationTimes` Shell 70 000,
  Files 0; the legend has no Files item.
- Read [0, 5] then Bash [4, 6] → Files 4 s, then Shell 2 s.
- **Three**: Read [0, 3], WebFetch [2, 4], Bash [1, 5] → Files 1 s, Shell 4 s, Web 0.
- **Ties**: Read [0, 4] and Bash [1, 4] → Files 4 s (same end, the earlier start). Read [0, 2] and WebFetch [0, 2],
  Read completing first → Files 2 s.
- **A gap**: Read [0, 1] then Bash [2, 3] → Files 2 s, Shell 1 s (R-4).
- **Failure**: Read [0, 0.3] failed and Bash [0, 70] → the Shell part is failed. Read [0, 5] failed and Bash [4, 6]
  → the Files part is failed, the Shell part is not. The alt's `1 failed call` is unchanged.
- **Legend = bar**: for a turn whose steps all show in detail, each station's sum of `RibbonPart.ms` equals
  `stationTimes`; at a bar narrow enough to merge steps, the earlier block's parts plus the detailed parts equal it
  too (R-5).
- Replaced: 0.7.1 §17.11's "a step with parallel calls in two stations (the first-started one's hue)".

Files: `hooks/stats.ts`, `hooks/ribbon.ts`, their tests.

## 7. A prompt of images (D6; LC5d)

### 7.1 Today

`promptKind` (`hooks/stats.ts:935-966`) reads a text that starts `[Image: source: ` as `service` (`SERVICE_STARTS`,
`:929`; the return at `:965`), which draws no line. The paths: the live `turn.start` (`register.tsx:1083-1090`), the
mid-turn `prompt.submit` (`:1358-1368`), the restore (`hooks/restore.ts:156-167`). `cutAtTurn` (`restore.ts:214-231`)
compares turns by `promptKind` too. The README says so at `plugins/session-panel/README.md:200-201`.

### 7.2 How the engine writes the image lines

From the 2.1.325 binary:

- `yhe` (`@309508317`) builds the line: `[Image: source: ${path}]`; with the size changed,
  `[Image: source: ${path}, original ${w}x${h}, displayed at ${dw}x${dh}. Multiply coordinates by ${f} to map to
  original image.]`; with no path and a changed size, `[Image: original …]`; with no size known, `[Image source:
  ${path}]` (`idn`, `@309486595`).
- One line per image. The lines go into a message of their own after the prompt's, one text block each, flagged
  `isMeta` (`ys`, `@321720560`). A row's text is "its text blocks joined" (d.ts 2.1.325:12488); the engine joins with
  `\n` (`@316921909`).
- `turn.start`'s text is the last user message that is not `isMeta` (`@340146816`). So the image lines reach the mod
  only where a text carries them: the session's rows, or a text that a surface or a hook built with them. The live
  `turn.start` of an images-only prompt may carry `""` instead. So the rule has two paths (R-7).

### 7.3 The rule (R-7: two paths)

**(a) The text path**, in `promptKind`, on `rest` (the text after the reminder blocks, `:958`), before the empty check
and the tag, summary, peer and service checks:

- drop every line that starts with `[Image: source: `, `[Image source: ` or `[Image: original `, and count them;
- if what is left is only white space and the count is above 0, the result is `{ kind: 'prompt', text: '[N images]'
  }`, `[1 image]` for one;
- otherwise the checks run on what is left, so a text with an image line before or after it is that text.

`[Image: source: ` leaves `SERVICE_STARTS`. The callers are unchanged: each cleans and masks `shown.text`
(`logText`), and the live `turn.start`, the mid-turn `prompt.submit`, the restore and `cutAtTurn` go through
`promptKind`. A path is never shown: an image line goes whole. A path the person typed in the text stays.

**(b) The attachments path**, for the live `turn.start` only. `PromptSubmitInput.attachments` is on every supported
engine (d.ts 2.1.288:8425-8433, "Present only when the submission carried images or other non-text items"; the
brief's "from 2.1.308" was wrong), and each item has `type: 'image' | 'audio' | 'document'` (2.1.288:8406-8419).

- **The note**: a module `let pendingImages = 0`.
- **Set by `prompt.submit`** at its entry, before `next(e)`: `pendingImages` = the count of `e.attachments` items with
  `type === 'image'` (0 when there is no `attachments`), when the prompt is the person's (`PERSON_ORIGINS`, `:222`)
  and `e.turnId === undefined`. Before `next(e)`, because an idle prompt's `turn.start` runs inside its `next(e)`
  (d.ts 2.1.325:10119-10120). Detail: a prompt typed over a running turn (`turnId` set) sets no note: no `turn.start`
  of its own follows (the next one is another prompt's), and its mid-turn line is path (a)'s. Detail: when
  `next(e)` answers `{ drop }`, the hook sets `pendingImages = 0`, since the turn never starts.
- **Read and cleared by a main `turn.start`** at its entry, beside `queued = unfolded` (`:1023-1024`): `images =
  pendingImages; pendingImages = 0`, whether it is used or not, so it never reaches a later turn.
- **Used** when the turn's text gives no line by path (a): the text is empty or white space, or `promptKind` gives
  `service` (a reminder block alone, as the desktop's first prompt after a reopen has). Then, with `images > 0`, the
  turn writes the `you` line `[N images]` at its `now` (`:1083-1090`), as it writes any prompt line. A text that gives a
  line, image lines included, writes that line alone, and the note is dropped.
- **Cleared by the reset** too (`session.end`, beside `unfolded = []`, `:943`). Detail: a note from the old
  conversation must not name the new one's first turn.
- **The restore** uses path (a) only: a row has no attachments. An images-only row whose text is `""` has no line.
  It reads image lines only: an image-lines row right after a typed prompt's row is that prompt's companion
  (`isCompanion`, `hooks/restore.ts`), which draws no line, and `cutAtTurn` passes over it. A resumed images-only first
  prompt passes `imagesText(images)` as the turn text that cuts the restore (`turn.start`'s `turnText`). If the chain
  rejects, `prompt.submit` clears the note and passes the same error on.
- **With neither**, an empty text leaves no row, as today.

### 7.4 Tests

- `stats.test.ts`, `promptKind` (a): `[Image: source: /tmp/a.png]\n[Image: source: /tmp/b.png]` → `{ kind: 'prompt',
  text: '[2 images]' }`; `[Image: source: /tmp/a.png]` → `[1 image]`; `[Image source: /tmp/a.png]` → `[1 image]`;
  `[Image: original 3000x2000, displayed at 1500x1000. Multiply coordinates by 2.00 to map to original image.]` →
  `[1 image]`; `Look at this\n[Image: source: /tmp/a.png]` and `[Image: source: /tmp/a.png]\nLook at this` →
  `Look at this`; a reminder block, then two image lines → `[2 images]`; `[Image: source: /tmp/a.png, original
  3000x2000, displayed at 1500x1000. Multiply coordinates by 2.00 to map to original image.]` → `[1 image]`. No
  result's `text` contains `/tmp/`.
- `register.test.ts`, (a): a main `turn.start` with the two-line text logs `you` `[2 images]`; a mid-turn
  `prompt.submit` with it logs the same; a text of white space and no image line logs nothing (as today).
- `register.test.ts`, (b):
  - an idle `prompt.submit` with text `""` and two image attachments, then its `turn.start` with text `""` → one `you`
    line `[2 images]`;
  - the same with `turn.start` text `Look at this` → one line, `Look at this`;
  - attachments of two images and a `turn.start` text of three image lines → one line, `[3 images]` (path (a) wins);
  - one image and a `turn.start` text that is a reminder block alone → `[1 image]`;
  - attachments of one `document` alone → no line;
  - the note is cleared at its `turn.start`: a later continuation `turn.start` with `""` writes no line;
  - a prompt a hook beneath drops (`{ drop }`), then a continuation `turn.start` with `""` → no line;
  - a prompt with images typed over a running turn (`turnId` set) sets no note: the next `turn.start` with `""`
    writes no line;
  - a `/clear` between a note and the next `turn.start` with `""` → no line;
  - a `prompt.submit` from an origin outside `PERSON_ORIGINS` sets no note.
- `restore.test.ts`: a user row with the two-line text restores a `you` line `[2 images]`; `cutAtTurn` with that turn
  text cuts at that row; a row with text `""` restores no line.

Files: `hooks/stats.ts`, `hooks/register.tsx`, their tests, `restore.test.ts`.

## 8. Usage guards and the model after a reset (D7; LC3, LC0)

### 8.1 `session.measure` guarded as `refreshUsage`

`session.measure` (`hooks/register.tsx:989-1007`) writes usage (`:994-998`, `usageFields` `:267-278`) with no reset
guard. `refreshUsage` (`:387-421`) captures `logEpoch` before its read (`:392`) and checks it in the update (`:407`).

Rule: `const epoch = logEpoch` at the hook's entry, before `next(e)`. In the update callback, `isCurrent = epoch ===
logEpoch && resetsRunning === 0`; when not current it returns `held` and `isCompacted` is false. A measure raised
before a reset and landing after it writes nothing and counts nothing. The window check (`:1001-1004`) is unchanged:
the model's window is the session's, not the conversation's.

### 8.2 The `turn.start` check skips itself when usage was written meanwhile

The check (`:1051-1076`) reads usage at `:1052`, awaits three writes (`:1053`, `:1058`, `:1061`), then reads the atom
(`:1066`). A measure or a refresh that lands between makes the atom hold tokens the reading never saw.

Rule: a module counter `usageWrites`, raised in the update callbacks of `refreshUsage` (`:406-417`) and
`session.measure` when they write (`isCurrent`). A callback runs again when its write misses, so it may raise the
counter twice: only a change counts. `turn.start` takes `const writes = usageWrites` before `$.session.usage()`
(`:1052`). The check at `:1066` and its update callback (`:1067-1071`) each add `usageWrites === writes`. When it
changed, this check counts nothing, writes nothing and asks no refresh; the next reading decides as it does today.

### 8.3 The model after `/clear` and an in-process resume

The reset (`:938-967`) clears the model (`:958`). No `session.start` follows (d.ts 2.1.325:4657-4658, "never
`/clear`"; `SessionEndInput.reason`, :12342-12343), so nothing reads it again until the first response.

- Rule: `session.end` awaits `next(e)` (today it returns it at `:969`), then, for `clear` and `resume`, starts
  `readMainModel($)` (`:816-820`) in the background (`inBackground`), as `session.start` does (`:906`), and returns
  what `next(e)` returned. The hook's 1.5 s bound (d.ts 2.1.325:12333-12335) is not spent: `inBackground` only sets a
  timer.
- The guard is there already: `readMainModel` reads nothing when a model is held (`:817`) and writes `held ?? model`
  (`:819`), so a step's model that landed first stands, and the first main step's model replaces a read one
  (`countModelStep`, `:808-811`). No change.

### 8.4 Known limit

A `/rewind`, or a `session.end` another plugin keeps from the mod, may still count a compaction: the engine drops the
tokens and no signal tells them from one. `/model` did not, live (LC3). The risks (§13) and the README's limits say
so.

### 8.5 Tests (`register.test.ts`)

- A `session.measure` whose chain beneath is held while a `/clear` runs, then released with `context.tokens` 120 000:
  `usage.contextTokens` is undefined, `compactions` is 0, no `compacted` line.
- Tokens held; a seen `session.compact` clears them; a main `turn.start` whose `$.session.usage()` is held, answers
  with no tokens, and a `session.measure` with tokens lands while it is held: `compactions` is unchanged and no
  `compacted` line is written. The same with no measure counts nothing either (no tokens held); 0.7.1's tests at
  `:6430` and `:6447` hold.
- After `session.end` with `clear`: `$.session.model()` is asked once more, and `mainModel` is its cleaned value. The
  same with `resume`; with `logout` it is not asked.
- After `/clear`, a main step's model lands before `model()` answers: the step's model stands (`:7818`'s test, on the
  reset path).

Files: `hooks/register.tsx`, `hooks/register.test.ts`.

## 9. Cuts and numbers (D8; LC5i)

### 9.1 Clusters

The cuts work by code point (`hooks/cells.ts:5-7`, `:10-13`, `:28-41`), so a cut can split a cluster. The runtime is
not Node, and `Intl.Segmenter` is in neither the code nor the engine types (no match in the three d.ts files).

Rule: a cut point never splits a cluster, by a code-point heuristic. Cell counting is unchanged: a code point is a
cell.

- **An extender** is a code point that belongs to the one before it: `\p{M}` (marks, the keycap U+20E3 among them),
  U+200D (ZWJ), U+FE00–FE0F and U+E0100–E01EF (variation selectors), U+1F3FB–1F3FF (emoji modifiers), U+E0020–E007F
  (tag characters). One regex with the `u` flag. The runtime has Unicode property escapes: `hooks/stats.ts:346` and
  `:361` use `\p{Cf}` and `\p{Default_Ignorable_Code_Point}`; a test proves `\p{M}` too.
- **A bad cut** between code points `i − 1` and `i` is one where code point `i` is an extender, or `i − 1` is a ZWJ,
  or both are regional indicators (U+1F1E6–1F1FF) and the run of indicators that ends at `i − 1` is odd in length.
- **A head** (kept from the start) moves its end back while the cut is bad. So it never ends with a ZWJ, and a base
  keeps its marks, selectors, modifiers and tags, or goes with them.
- **A tail** (kept to the end: `middleCut`'s, `:41`) moves its start forward while the cut is bad.
- Both only shrink the kept text, so no cut grows past `n`. One helper in `hooks/cells.ts` serves `cutCells`, both
  pieces of `middleCut` and the Log's cuts below. The head's trim (§4.2) runs after the move.

### 9.2 The Log's cuts (R-8)

`textHead` (`hooks/stats.ts:688-694`) and `shorten` (`:679-682`) count UTF-16 units today, and `textHead` guards only
a surrogate pair. They feed every Log text (`logText`, `:748`; `engineLineText`, `:933`; the answers, `:1000`; the task
lines, `:1018`) and, through `logText`, the model name that the band draws in its SVG (`readMainModel`,
`register.tsx:818`; `countModelStep`, `:1137`; `coreModel`, `hooks/band.ts:138-141`), where a lone surrogate must
never appear.

- **`textHead(s, max)`** keeps the first `max` code points, then moves its end back by §9.1's head rule. It walks at
  most `max + 1` code points from the start and never spreads the whole text, so its cost stays linear in the head
  (the reason it exists: the passes after it are slow on long texts, `:725-733`). A text of `max` code points or fewer
  comes back as it is. A cut by code point never leaves a lone surrogate.
- **`shorten(s, max)`**: a text of more than `max` code points is `textHead(flat, max − 1)` + `…`, counted by the same
  bounded walk.
- **The constants** keep their numbers and count code points: `TEXT_HEAD_MAX = 4096` (`:734`), `LOG_TEXT_MAX = 512`
  (`:739`); their comments (`:725-738`) say "code points" where they say "UTF-16 units". `CUT_WORD_MAX` (`:704`)
  stays in units: `wordHead`'s scan back (`:717-722`) stops at white space, which is never half a pair.
- **`wordHead`** (`:714-723`) returns `s` when `textHead(s, max)` is `s` (in place of `s.length <= max`, which would
  now drop the last word of a text longer in units than in code points).
- **`shortType`** (`:283-287`) is unchanged: it tests `name.length` in units and cuts with `textHead`, so it inherits
  the cluster-safe cut. Agent types are ASCII, where units and code points agree. The limit: a type with astral
  characters is cut when its units pass 14, and may come out shorter than 14 cells.
- `stats.ts` imports the helper from `hooks/cells.ts`, which imports nothing, so there is no cycle.

### 9.3 Numbers that are not finite

`fmtTokens` (`hooks/stats.ts:1091-1096`) of a number that is not finite returns `—`. Today a `contextWindow` of
`Infinity` with finite tokens makes a percent of 0 (`percentOf`, `register.tsx:258-262`), so the core draws
`${fmtTokens(tokens)} / InfinityM` (`tokensText`, `hooks/band.ts:132-135`). `NaN%` is already guarded
(`hooks/view.tsx:397`, `register.tsx:258-262`): no change there.

### 9.4 Tests

Code points are written `\u{…}`.

- `cells.test.ts`: `/\p{M}/u.test('\u{301}')` is true; `cutCells('cafe\u{301} au lait', 5)` is `caf…`;
  `cutCells('ab\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}cd', 5)` is `ab…`; `cutCells('ab\u{1F1FA}\u{1F1E6}cd', 4)`
  is `ab…`, and at 5 `ab\u{1F1FA}\u{1F1E6}…`; `cutCells('ab\u{1F44D}\u{1F3FD}cd', 4)` is `ab…`; no result ends with
  `\u{200D}`. `middleCut` of two texts whose tail would start on a mark or between a flag's halves drops that
  cluster from the tail, and every text stays ≤ `n` cells.
- `stats.test.ts`, the Log's cuts (R-8): `shorten('abcd\u{1F600}efg', 6)` is `abcd\u{1F600}…` (today `abcd…`);
  for each position `k` from 0 to 8 of `\u{1F600}` in a 9-code-point text, `shorten(text, 6)` has no lone surrogate
  (`/\p{Cs}/u` finds none) and is at most 6 code points; `shorten('abcd\u{1F44D}\u{1F3FD}ef', 6)` is `abcd…`;
  `shorten('ab\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}cd', 4)` is `ab…`; `textHead('ab\u{1F600}', 3)` is the
  text whole; `textHead('abcde\u{301}f', 5)` is `abcd`; `wordHead` of a text of 4096 code points and more UTF-16 units
  comes back whole; `logText` of a model name with an astral character at its 512th code point has no lone surrogate.
  The tests at `stats.test.ts:311-314` and `:906-926` hold.
- `stats.test.ts`: `fmtTokens(Infinity)`, `fmtTokens(-Infinity)` and `fmtTokens(NaN)` are `—`; finite values as today.
- `band.test.ts`: a core with tokens 50 000 and window `Infinity` draws `50k / —`, never `Infinity`.

Files: `hooks/cells.ts`, `hooks/stats.ts`, their tests, `band.test.ts`.

## 10. Palette P2 (D9; LC5g)

### 10.1 The hues

`STATION_HUES` (`hooks/stations.ts:20-29`) becomes:

| Station | Dark | Light | OKLCH dark (L, C, h) | OKLCH light |
|---|---|---|---|---|
| model | `#df995e` | `#ad6313` | .740 .113 60 | .572 .127 60 |
| files | `#5adbda` | `#007070` | .820 .113 194 | .494 .084 195 |
| shell | `#b8beff` | `#5456a7` | .820 .092 280 | .492 .127 280 |
| web | `#91afc5` | `#577d98` | .739 .046 240 | .572 .060 240 |
| agents | `#ffa6c1` | `#983c5e` | .820 .109 0 | .492 .128 360 |
| mcp | `#74bf85` | `#348c4e` | .740 .112 150 | .571 .126 150 |
| skills | `#cfc86f` | `#6a6400` | .819 .112 105 | .493 .105 106 |
| you | `#ca93d7` | `#995da6` | .739 .113 320 | .573 .127 320 |

The design: OKLCH hues model 60, skills 105, mcp 150, files 195, web 240, shell 280, you 320, agents 0. L sits at each
theme's mean (dark .780, light .532), ±.04 alternating round the wheel, the sign flipped in the light theme. C is the
mean of the seven (.112 dark, .128 light); Web keeps its low chroma (.046 / .060). Chroma was cut to fit sRGB on dark
Shell (.092), light Skills (.105) and light Files (.084). The table's values are measured from the hexes with
`mockup-src/color.ts` (`lchOf`).

### 10.2 Metrics, re-checked

Re-computed with `color.ts` (`contrast`, `de2000`, `hueGap`) on 2026-11-23:

| | Dark | Light |
|---|---|---|
| least contrast on `#262624` / `#fbfaf7` (0.7.0 §3.1) | 6.26 (You) | 4.02 (MCP) |
| least contrast on `#1f1e1c` / `#faf9f6` (0.7.1 §5) | 6.87 (You) | 3.98 (MCP) |
| least pairwise CIEDE2000 | 12.8 (Shell–Web) | 14.8 (Shell–Web) |
| Model–Skills | 22.9 at 45° | 22.9 at 45° |
| Shell–You | 16.6 at 40° | 16.3 at 41° |
| least CIEDE2000 to the failure red `#e5484d` | 25.3 (Agents) | 21.4 (Agents) |
| MCP to the done mark `#2ea043` | 12.9 | 7.9 |
| MCP to the `success` key (`#5bb56c` / `#2e8540`; terminal `#6cc36c` 5.5) | 4.8 | 3.2 |
| palette A: least pairwise; Model–Skills; Shell–You | 11.5; 17.7; 16.8 | 13.2; 22.1; 13.6 |
| palette A: least contrast on `#262624` / `#fbfaf7` | 5.48 (Shell) | 3.55 (Model) |

The mockup's numbers stand. The pane is drawn on 0.7.0 §3.1's background, `#262624` / `#fbfaf7`: the mod does not set
it, and 0.7.1 §5's `#1f1e1c` / `#faf9f6` were the palette notes' (`palettes.md`). Every hue is above 3:1 (WCAG 1.4.11)
on both; light MCP is the lowest, under 4:1 on `#faf9f6`. Light-theme rules stay built from `STATION_HUES`
(`hooks/band.ts:344`, `themeStyle`), so no drawing code changes.

MCP's hue (150) sits by the greens of the pane: the done mark `GREEN #2ea043` (hue 146.2, the lanes' `✓`) and the
`success` key of 0.7.0 §3.1 (hue about 144–148), which colours the Log's and the terminal's `✓`, the MCP section's
server dots, the `+N` lines and Cache ≥ 50 %. Under 0.7.1 MCP was 17.2 and 12.1 from the done mark and 11.2, 8.4 and 8.6
(terminal) from the `success` key. The two meet in the MCP section's dots, where the match reads as one idea. The lanes
are never MCP-hued, so the lanes' `✓` stands by Model, Agents and Shell only. A done mark keeps its meaning by its shape
and its place. The owner chose P2 for its even spacing, with this closeness.

### 10.3 Every place that names the old colours

- Code: `hooks/stations.ts:21-28`.
- Tests: `stations.test.ts:72-73` (model and web, pinned: they take P2's); `band.test.ts:153-154`, `:169`, `:175`,
  `:205`, `:209`, `:237`, `:331` (Model `#e1ac6e`, Shell `#a48cf0` in drawn sources); `lanes.test.ts:553-583` (Agents
  `#e58fae` / `#b44a74` in four lane sources). `view.test.tsx:2929`, `:2943` use `#e1ac6e` as any span colour and need
  no change. Tests that read `STATION_HUES` (`lanes.test.ts:308`, `:492-494`; `band.test.ts:349`, `:399-400`) hold.
- Specs: 0.7.0 §3.3's table and its notes (`:185-212`), §1.4's sentence that the Model hue is lot-map's accent
  (`:58`: it is no longer; the icons and the station idea stay credited), §15.1 and §15.4 (closed notes); 0.7.1 §5.
  The visual spec (`2026-10-07-session-panel-visual.md`) names no station hue (its colours are `BLUE`, `AMBER`, `RED`,
  `NEUTRAL`, `GREEN`, §3.1 there): no change.
- README: `plugins/session-panel/README.md:31-32` ("Skills is a butter yellow and You a lilac …").
- `THIRD_PARTY_NOTICES.md:98-105` (lot-map) names no hue: no change.

### 10.4 Tests

`stations.test.ts`: `STATION_HUES` equals the table of §10.1 (all eight). The others above update their literals.

Files: `hooks/stations.ts`, the tests above.

## 11. Docs (D10; LC4, LC5e)

- **CHANGELOG** (`CHANGELOG.md`, house form: `## 0.7.2 — <date>`, one bullet per change, fixes as `Fix: …`):
  - a 0.7.2 entry over 0.7.1, one bullet per §2–§10;
  - 0.7.1's sentence at `:12-14` becomes: "Activity's label column is about 45 % of the pane, up to 64 cells. The tags
    show from 54 columns (a pane of about 464 px) and start on one x; a subagent's type is cut at 14 characters, as in
    the Log (`@general-purpo…`). Descriptions whose end cuts would read the same are cut in the middle, so that the
    lanes tell apart (`Band check…sleep A`)." The 0.7.2 entry adds that the tag now also shrinks, with `…`, to keep a
    description 12 cells wide.
- **For the owner**: the GitHub Release text of 0.7.1 carries the same wrong "are never cut". The corrected sentence
  is the CHANGELOG's above.
- **README** (`plugins/session-panel/README.md`):
  - §2: the refusals (`:49-52`, `:318`) and the restore's `denied` (`:358-359`: "a denied or interrupted call reads
    `✗`" becomes "an interrupted call reads `✗`; a call the engine or the person refused reads `denied`");
  - §3: one pulse per call;
  - §4: the tag (`:119-122`: "a tag is never cut" goes; the tag shrinks, with `…`, to keep a description 12 cells);
  - §5: the faded tail of a bounded task, the exact end from `<duration_ms>`;
  - §6: the ribbon's pieces (`:93`, "in the hue of the call that started first" goes: the hue of the call that ends
    last);
  - §7: images (`:200-201`: `[Image: source: ` leaves the list; a prompt of images reads `[N images]`, from the
    engine's image lines or from the prompt's attachments; a restored one only from its lines);
  - §8: the guards; the limit of §8.4 next to the compaction limits;
  - §9: the cluster-safe cuts, the Log's texts included, which now count code points; `—` for a window that is no
    number; the `shortType` limit;
  - §10: the palette (`:31-32`);
  - the counters after a reopen (`:338-340`, `:356`): "They hold only the main agent's calls, so they read lower than
    before the reopen."
  - the limits of §3.2 (a reload, the cap) and §8.4.
- **The 0.7.0 and 0.7.1 specs**: each section in the table of §1 carries 0.7.2's rule in place, with a pointer
  ("0.7.2 §"), and each header gains a line naming this spec, as 0.7.0's names 0.7.1's.
- **The visual spec**: no colour of it changes (§10.3).
- **The root README's version line** and `plugin.json`'s `0.7.2`: in the release commit, not in a task.

## 12. Not in 0.7.2

- **`"network": {"hosts": []}` in `plugin.json`** (LC5h). No engine type file (2.1.288, 2.1.308, 2.1.325) names a
  manifest `network` field, and no schema in the repo does (no match for `network` or `hosts` as a manifest key). An
  older engine may refuse an unknown key; the validator's `Hosts not declared` is a notice. `$.process.run` is local
  execution, "not a network path" (d.ts 2.1.325:3765; 2.1.288:3287).
- **A restored row with `endedAt = null` keeping an old start** (LC0). A restored row has no start
  (`hooks/restore.ts:117`), so it draws dashed (`hooks/lanes.ts:181-185`, `:158-159`), not solid; the review's claim
  does not reproduce. The one path that keeps an old start is a live row still `running` when a SendMessage resume
  comes (`reviveAgent` returns early, `register.tsx:728`): rare, and a limit (§13).
- **`NaN%`** (LC5i): already guarded (§9.3).
- **Pulses at the first chunk**, before a run or a permission answer (LC0 item 2): 0.7.1 §7 records it.

## 13. Risks and accepted limits

- **Refusals by text** (§2). The rule reads the engine's words, for built-in tools only. A new engine text, or a
  changed one, reads as a failure again; a built-in tool's own error that starts with one of the texts reads as a
  denial. Other auto-mode texts that lack the pinned phrase (`… gave no verdict for ${tool}: a hook changed …`,
  `@316831510`) stay failures. Rule 6 matches its phrase anywhere in the first line, and a built-in validator echoes
  the model's input there (Grep's `Path does not exist: <path>`): a failed call whose path holds the phrase reads
  `denied`. Only the drawing is affected; the project read and `isFailed` are not.
- **An interrupted call whose result the engine made up** reads `denied` (kind `info`: `who` and outcome dim), not
  the time alone: the engine gives it the rejection's text, `kh`, and marks it `user-rejected` (§2.4, R-11).
- **One pulse per call** (§3) holds within a module's life and for the latest 256 calls; a hot reload or a call
  older than that may pulse twice.
- **K** (§5.3) is lost to a late step's write or a close that loses its race; the bar is then all faded. The guard
  keeps a K outside `(start, end)` from being drawn.
- **More ribbon pieces** (§6): a step of parallel calls may make two or three parts where it made one, so a narrow bar
  merges older steps sooner.
- **Images** (§7): an images-only prompt typed over a running turn whose text carries no image line has no line
  (path (b) serves only a prompt that starts its own turn); a restored images-only row with text `""` has none
  either. A note whose prompt neither starts a turn nor is dropped (a chain that never answers) is cleared by the next
  main `turn.start`, which may then read it if its own text is empty: accepted, as the chain that hangs is a fault.
- **Usage** (§8): a `/rewind` or a `session.end` kept from the mod may still count a compaction. The `turn.start`
  check skips itself when usage was written meanwhile, so a hidden compaction there waits for the next reading.
- **Clusters** (§9): a heuristic, not UAX #29. Hangul jamo, Indic conjuncts and prepended marks can still split.
  `shortType` tests its length in UTF-16 units (§9.2).
- **The Log's heads in code points** (§9.2): `TEXT_HEAD_MAX` and `LOG_TEXT_MAX` now count code points, so a text of
  astral characters passes up to twice as many units (8192) to the passes that are slow on long texts (`redact`,
  `plainText`). That is far under the measured slow inputs (128 KB, 224 KB, `hooks/stats.ts:725-733`).
- **Palette** (§10): light MCP is 3.98:1 on `#faf9f6` (4.02 on the pane's `#fbfaf7`); MCP's green sits by the success
  green (12.9 and 7.9 from the done mark, 4.8 and 3.2 from the `success` key, §10.2); colour-blind pairs are not
  re-measured, and icons, labels and alts still carry the station.
- **A resumed subagent whose row still runs** when the resume comes keeps its old start (§12).

## 14. Live checks for 0.7.2

1. A blocked `sleep 30` (alone): the Log reads `denied`, Shell is not red; after a reopen the restored row reads
   `denied` too.
2. A user rejection in the default permission mode: `denied`, live and restored. Also an Esc while a call waits for
   permission: the Log reads `denied`, dim (R-11).
3. An auto-mode classifier refusal, if one happens: `denied`.
4. A Bash call held by the classifier beside a parallel Read: the legend gives the wait to Shell, and Files has
   `<1%` or nothing.
5. A background `sleep 240` with an AskUserQuestion held past its end: the bar is solid to K and faded from K to the
   notice, the end mark at the notice, the time `≤`.
6. A prompt of two images: the Log reads `you` `[2 images]`; one image with text reads the text.
7. After `/clear`, the core names the model at once, before any response.
8. At about 490 px: a description has 12 cells at least, the tags are cut with `…`, and a cut leaves no space before
   `…`.
9. Palette P2 in both themes: the band, the ribbon's legend swatches, the lanes.

Carried over, never checked: `/rewind`; `motion: reduced`; the light theme under load; a hot reload;
`claude --resume <id> "…"`.

## 15. Rulings

The controller's rulings on the spec's open points (2026-11-23); every section above follows them.

- R-1 more refusal texts: accepted, all four in §2; each is an engine phrase no tool output starts with.
- R-2 `Jbn`, "stopped while running": accepted, no refusal (§2.2); the call ran, so it stays abandoned.
- R-3 pulse record over a reset: accepted, it survives `/clear` and resume (§3.2); ids are unique, the set bounded.
- R-4 a gap in a step: accepted, it joins the piece before it (§6.2), so the bar keeps no hole.
- R-5 earlier block and 60-step fold: accepted, both take the split pieces (§6.2), so the legend matches the bar.
- R-6 middle cut's space: accepted, only the end cut drops it (§4.2); 0.7.1's `Fix …X12` rule stands.
- R-7 images: both paths, no probe (§7.3); `turn.start` may get `""`, and `attachments` is there from 2.1.288.
- R-8 Log cuts: `textHead`, `shorten` cluster-safe by code point (§9.2); they feed the SVG; `shortType` stays (ASCII).
- R-9 D3's numbers: accepted, §4.3's table (57 columns: 12 + 12; 11 cells: `@appsec-en…`); the brief's did not add up.
- R-10 moved anchors: accepted, the spec cites the verified lines (§1's code references).
- R-11 refusal on an abandoned call: accepted, `kh` reads `denied`, kind `info`, dim (§2.4); the text cannot tell.
