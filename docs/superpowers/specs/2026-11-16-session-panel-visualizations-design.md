# session-panel 0.7.0: visualizations

## 1. Status, summary, goals

Date: 2026-11-16. Status: approved by the owner, round by round (rulings R1–R19) and section by section (technical
decisions T1–T6). Implemented in 0.7.0. This spec consolidates the design record; it adds no decision of its own.
Whatever the record leaves open is in §15.

Updated by 0.7.1: `docs/superpowers/specs/2026-11-18-session-panel-0.7.1-design.md`. The sections it changes carry
its rules in place, each with a pointer ("0.7.1 §") into it.

The record, in rising precedence: the first visual spec, the r3 and r4 addenda, the rulings (a later R over an earlier
one), the technical decisions. The rulings and the technical decisions live in this spec as R1–R19 and T1–T6.
Round 6 settled the first draft's open questions (R16 a–j, folded into their sections) and left three open (R17,
§15). Round 7 (R18) corrected the wide mode to stretched, which voids R16 a; R19 caps the band at
4096 px on wider bodies.

This spec adds to the main spec (`2026-10-07-session-panel-design.md`) and the visual spec
(`2026-10-07-session-panel-visual.md`, "the base spec" below). Where it is silent, they stand: cells and `CELL_PX`,
FIXED and FLEX cells, rules, headers, folds, theme keys. Bare § references point into this spec; "base §" points
into the base spec.
Code references are into `plugins/session-panel/` as of main 453c46d (0.6.1).

### 1.1 Summary

0.7.0 adds three visual blocks to the pane:

- **The Session band.** The context ring becomes the core of a band, with eight tool "stations" around it: four on
  each side (layout A2), each fed by a line from the core. On a wide pane the two sides reach the band's edges. A
  pulse runs from the core to a station when the station is called. The band replaces the Context label row and
  the meter row.
- **The turn ribbon.** One bar per turn, one segment per model call and per tool call, each in its station's hue. It
  replaces the Turn stats table; the table stays behind a closed `details` fold.
- **Activity.** One lane per subagent, task and the main agent on a shared time axis. It replaces the Subagents and
  Tasks lists.

### 1.2 Goals

- One colour system: each of the eight stations has one hue, and every mark in the ribbon and the lanes is drawn in
  the hue of its station, at full strength. States show by shape (R5).
- Every new element works at every pane width, from 300 px to a pane maximized on a 21:9 monitor (≈ 3400 px), and in
  the terminal from 40 to ≈ 200 columns (R8). Circles do not grow without limit, the band fills its width (R18),
  and no element grows with the session.
- Bounded state and bounded drawing: nothing grows with the session's length (T1, T2).

### 1.3 Non-goals

- No tooltips: 0.7.0 ships without them (R16 b; §11.3, ruling C-no). Each drawing is an image with an alt that says
  what it shows.
- No new disk writes: on disk the mod still touches only `$.store` `collapsed` (§13.3).
- No totals across turns: Turn stats shows the running turn, else the last one.
- No stats a restore cannot rebuild: restored lanes are dashed, restored stations have no running or failure marks
  (T1.6).

### 1.4 Credits

The station idea and the Agents, Skills and You icons are adapted from **lot-map** by Aleksei Volodin (MIT). The
Model hue (`#e1ac6e` / `#b8762a`) is lot-map's warm accent. THIRD_PARTY_NOTICES.md gains lot-map's MIT notice (§13).

## 2. The pane after 0.7.0

### 2.1 Block order (R4)

| # | Block | Change |
|---|---|---|
| 1 | `Session` … `$4.97` | unchanged |
| 2 | **The Session band** (§4) | new; replaces the Context label row and the meter row (base §6.2) |
| 3 | The split line `Subagents $1.77+` (a restored row; else `Session $3.20 · Subagents $1.77`) | unchanged |
| 4 | Project | unchanged |
| 5 | Usage | unchanged |
| 6 | **Turn stats as the ribbon** (§5) | replaces the Turn stats table (base §6.6), which moves behind `details` |
| 7 | **Activity** (§6) | replaces the Subagents and Tasks lists (base §6.7) |
| 8 | MCP | unchanged |
| 9 | Context sources | kept, unchanged (R4) |
| 10 | Log | unchanged; fills the free height (base §6.12) |

The band is an image with an alt that says what it shows; the alt does not mention skills: Context sources shows
them (R4, over R3).

### 2.2 Row counts

Every new block occupies whole rows, so the Log's row count (`logLinesFit`) stays exact. The counts below are for
the worked example (§2.3), with Log at its minimum of 8 lines and `details` closed.

| Block | Today (0.6.1) | 300 px | 360 px | 900 px | Terminal, 44 columns |
|---|---|---|---|---|---|
| Session row | 1 | 1 | 1 | 1 | 1 |
| Context rows / band | 2 | 5 | 5 | 4 | 3 |
| Split line | 1 | 1 | 1 | 1 | 1 |
| Project | 4 | 4 | 4 | 4 | 4 |
| Usage | 4 | 4 | 4 | 4 | 4 |
| Turn stats | 11 | 8 | 7 | 5 | 7 |
| Subagents + Tasks / Activity | 7 + 5 | 12 | 12 | 12 | 12 |
| MCP | 3 | 3 | 3 | 3 | 3 |
| Context sources | 4 | 4 | 4 | 4 | 4 |
| Log | 11 | 11 | 11 | 11 | 11 |
| **Total** | **53** | **53** | **52** | **49** | **50** |

- The band is 5 rows while each side has two rows of stations (body below 464 px), else 4 (§4.1). In the terminal it
  is the core line plus 3 grid rows at 40–42 columns, 2 at 43–118, 1 from 119 (§4.10).
- Turn stats: rule, header, bar row, the legend's rows, details row (0.7.1 §17.8). The legend wraps by whole items:
  in the example it is 4 rows at 300 px, 3 at 360 px, 1 at 900 px and 3 in a 44-column terminal (§5.4, §5.8). Open
  `details` adds today's 9 label/value rows.
- Activity: rule, header, up to 8 lanes, the axis row, `+N more`. With no subagents and no tasks it is hidden.

### 2.3 The worked example (R1 as changed by R9)

Every geometry table and terminal string in this spec draws this one session. Now is `12:04:20`; main's running turn
started `12:02:06` (relative times below are to now).

- **Context:** 56 %, `112k / 200k`, model `opus 5.5`, 1 compaction.
- **The turn:** 6 model calls and 5 tool steps; elapsed 2m 14s, model 1m 18s, tools 56 s; Steps = 6 (a step is one
  model call); TTFT 1.2s; response `~42 tok/s`.

| # | Segment | Station | Time | Label |
|---|---|---|---|---|
| 1 | model | Model | 9 s | `Model · 9s` |
| 2 | tools | Files | 0.4 s | `Read ×2 (stats.ts, view.tsx) · Files · 0.4s` |
| 3 | model | Model | 11 s | `Model · 11s` |
| 4 | tool, failed | Shell | 31 s | `Bash tsc --noEmit · Shell · 31s · failed` |
| 5 | model | Model | 14 s | `Model · 14s` |
| 6 | tool | Agents | 22.3 s | `Agent → explorer: Map the mask · Agents · 22.3s` (a foreground subagent, done) |
| 7 | model | Model | 8 s | `Model · 8s` |
| 8 | tool | You | 0.2 s | `TodoWrite · You · 0.2s` |
| 9 | model | Model | 18 s | `Model · 18s` |
| 10 | tool | MCP | 2.1 s | `codebase-memory:search_graph · MCP · 2.1s` |
| 11 | model, live | Model | 18 s | `Model · 18s · running` |

The labels are not drawn as tooltips: each drawing is an image with an alt that says what it shows (§11.3, C-no).

- **Stations:** Model 31, Files 12, Shell 4, Web 1, MCP 3, Agents 5, Skills 6, You 3. Running: Model ×3 (main and
  the two running subagents are in model steps), Agents ×2, Shell 1 (the npm test task). Shell failed once this turn
  (tsc).
- **Subagents** (summary 2/5 in 0.6.1 terms):
  - Review the diff `@code-reviewer` `$0.310`: running, started 11:58:20 (−6:00);
  - Plan critique `@plan-critic` `$0.410+`: restored after a reopen, running, start unknown;
  - Map the mask `@explorer` `$0.120`: 12:03:11 → 12:03:34 (−1:09 → −0:46), done; the turn's step 6;
  - Repro check `@general-purpose` `$0.050`: 12:00:20 → 12:01:20 (−4:00 → −3:00), failed;
  - Engine facts `@general-purpose` `$0.880`: −12:00 → −4:00, done.
- **Tasks:** npm test `@shell`, running for 3m 40s since 12:00:40 (−3:40); claude plugin test `@shell` 18.2s,
  −9:40 → −9:22, done; dev server `@shell`, −10:00 → −6:00, stopped after 4m 00s.
- **Main's turns:** −12:30 → −8:50, −6:20 → −3:40, −2:14 → now. Main's value is a dim `—`, and the split line
  reads `Subagents $1.77+`, because Plan critique is restored (§6.4).
- **Log** (8 newest, newest first; header `64`, then `+56 more`): 12:04:00 `codebase-memory:search_graph ✓ 2.1s`;
  12:03:42 `TodoWrite ✓ 0.2s`; 12:03:34 explorer `done — mask mapped ✓ 22s`; 12:03:11
  `spawned · explorer: Map the mask`; 12:02:26 `Bash tsc --noEmit ✗ 31s`; 12:02:15 `Read view.tsx ✓ 0.3s`;
  12:02:15 `Read stats.ts ✓ 0.1s`; 12:02:06 you `Проверь на чём ты остановился`.

Costs are in view.tsx's cost format (`hooks/stats.ts:1010`: three decimals below $1, two from $1).

## 3. The visual language

### 3.1 Pane palette (unchanged)

| Token | Dark | Light | Terminal dark | Terminal light |
|---|---|---|---|---|
| pane bg | `#262624` | `#fbfaf7` | `#17171a` | `#fbfbf9` |
| edge / rule | `#3a3936` | `#dad8cf` | `#34343a` | `#d6d6d2` |
| fg (primary) | `#ecebe6` | `#1d1c1a` | `#d8d8d8` | `#1f1f1f` |
| dim (secondary) | `#9c9a93` | `#6f6d66` | `#7f7f87` | `#8a8a8a` |
| success | `#5bb56c` | `#2e8540` | `#6cc36c` | `#2e8540` |
| warning | `#e0a030` | `#a86500` | `#e5c07b` | `#a86500` |
| error | `#ef5f63` | `#c8363c` | `#e06c75` | `#c8363c` |

The existing raw SVG colours stay exactly as they are, the same in both themes: `BLUE #2f7de1`, `AMBER #e0a030`,
`RED #e5484d`, `NEUTRAL #8a8a8a`, `GREEN #2ea043`, track `#808080 @ 0.3`, rule `#808080 @ 0.35`. The core keeps
`meterColor` (blue below 80 %, amber from 80 %, red from 95 %): it is the user's fixed meter rule, and the core is now
the only context meter.

### 3.2 SVG surfaces (dark / light)

SVG does not follow the theme, so each new image draws from these two sets (§9.3 says how the light set applies).

| Token | Dark | Light | Use |
|---|---|---|---|
| `raised` | `#2e2d2b` | `#ffffff` | station circle fill, badge fill |
| `line` | `#45443f` | `#d4d1c7` | idle station stroke |
| `rail` | `#3a3936` | `#e2dfd6` | trunk, fork and rails; the lanes' axis hairline |
| `bone` | `#ecebe6` | `#1d1c1a` | numbers inside SVG (core percent, station counts, badge text) |
| `ash` | `#9c9a93` | `#6f6d66` | labels inside SVG (model, tokens, station labels, axis labels) |
| `fail` | `#e5484d` | `#e5484d` | = `RED`: failure disc, failed station stroke, ribbon failure underline, `✗` |

The first spec's `accent` is the Model hue (§3.3). Its `hot` colour is gone: R5 removed the hot cell.

### 3.3 Station hues

One hue per station, shared by the band, the ribbon and the lanes. The band draws each station's icon in its hue, so
the band is the ribbon's and the lanes' colour key. Red, green and the context blue are reserved for failure, done
and the context meter and are not station hues.

| Station | Dark | Light | Name | ≈ contrast on pane bg (dark / light) |
|---|---|---|---|---|
| Model | `#e1ac6e` | `#b8762a` | amber (lot-map's accent) | 7.5 / 3.6 |
| Files | `#5fc2b5` | `#1c8c81` | teal | 7.3 / 4.0 |
| Shell | `#a48cf0` | `#6c4fc0` | violet | 5.6 / 5.9 |
| Web | `#93aac4` | `#4f6b8a` | slate | 6.4 / 5.3 |
| MCP | `#a3c47a` | `#5b822f` | sage | 7.6 / 4.2 |
| Agents | `#e58fae` | `#b44a74` | rose | 6.3 / 4.8 |
| Skills | `#f0e07f` | `#695700` | butter / deep olive-gold | 11.3 / 6.8 |
| You | `#eeb6fb` | `#752f84` | lilac / plum | 9.2 / 8.1 |

- All are at least 3:1 (WCAG 1.4.11 for graphics). Colour is never the only cue: each station has its icon and label,
  each segment and lane has an alt, each status has a shape.
- Approximate OKLCH hue order, reserved colours in brackets: `[red 22] · Model 70 · Skills 100 · MCP 128 ·
  [green 148] · Files 185 · Web (slate, low chroma) · [blue 258] · Shell 295 · You 325 ·
  Agents 355`. Neighbours sit ≈ 25–45° apart.
- Web is slate, not sky: sky sat ≈ 13° from the context blue, and Files and Web segments often sit side by side.
  Slate keeps a blue hue at about a third of the blue's chroma, so it never reads as "context".
- The weakest pairs are listed in §15.
- Skills and You are 0.7.1's palette A (0.7.1 §5); they were lemon `#d9c95a` / `#8c7a00` and orchid `#d48ae0` /
  `#9a48b0`. The change is in lightness, not hue, so the hue order above stands; it closes §15.1 and §15.4. The
  minimum contrast does not change.

### 3.4 Station order

One order everywhere (the band, the terminal grid, the alt texts, and the ribbon's merged "earlier" parts):
**Model, Files, Shell, Web · Agents, MCP, Skills, You.** The first four are the main loop; the last four are
delegation, outside services and the person.

### 3.5 Typography

| Element | Surface | Font | Size / weight | Numbers |
|---|---|---|---|---|
| All pane Text (unchanged) | Text | system-ui | 13px/19px, 400; titles 650 | — |
| Core percent `56%` | SVG | system-ui | 15px, 600, `bone` | tabular |
| Core model `opus 5.5` | SVG | system-ui | 9px, 400, `ash` | — |
| Core tokens `112k / 200k` | SVG | system-ui | 10px, 400, `ash` | tabular |
| Station label | SVG | system-ui | `s` px, 500, `ash` (`bone` while running or failed); `s` is 10 or 9 (§4.2) | — |
| Station count | SVG | system-ui | `(s + 1)` px, 600, `bone` | tabular |
| Badge `×2` / failure count `1` | SVG | system-ui | 8px, 700 | tabular |
| Lane axis labels | SVG | system-ui | 9px, 400, `ash` | tabular |
| Ribbon elapsed, legend, lanes | Text | system-ui 13px | primary/dim (base §3.2) | fixed right-aligned cells |
| Terminal everything | Text | ui-monospace 13px/17px | — | monospace aligns |

SVG text sets `font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"` and tabular numbers with
`font-variant-numeric: tabular-nums`. Nothing new is bold except the SVG numbers above; Text bold stays for titles.

### 3.6 Icons

14 px, the house style: `ICON_ROOT`, stroke 1.4, round caps and joins, `fill="none"`. Station icons are drawn in the
station's hue, not `NEUTRAL`, so the band doubles as the colour key. Bodies inside `ICON_ROOT`:

```text
Model (chip)       <rect x="3.5" y="3.5" width="7" height="7" rx="1.2"/>
                   <path d="M5.5 1.5v2M8.5 1.5v2M5.5 10.5v2M8.5 10.5v2M1.5 5.5h2M1.5 8.5h2M10.5 5.5h2M10.5 8.5h2"/>
Files (page)       <path d="M3.5 1.5h4.25L10.5 4.25v8.25h-7z"/><path d="M7.75 1.5v2.75h2.75"/>
Shell (prompt)     <path d="M2.5 4l3 3-3 3M7 10.5h4.5"/>
Web (globe)        <circle cx="7" cy="7" r="5.5"/>
                   <path d="M1.5 7h11M7 1.5c-2.2 2.2-2.2 8.8 0 11M7 1.5c2.2 2.2 2.2 8.8 0 11"/>
MCP (plug)         the existing ICON.mcp body:
                   <path d="M5.25 1.5v3M8.75 1.5v3M7 10.25v2.25"/>
                   <path d="M3.5 4.5h7v2.75a3 3 0 0 1-3 3h-1a3 3 0 0 1-3-3z"/>
Agents (3 nodes)   <circle cx="7" cy="3.25" r="1.6"/><circle cx="3.25" cy="10.75" r="1.6"/>
                   <circle cx="10.75" cy="10.75" r="1.6"/><path d="M7 4.85V7.2M7 7.2 4.4 9.6M7 7.2l2.6 2.4"/>
Skills (bolt)      <path d="M8.1 .9L3 7.7h3.3L5.2 13.1l5.4-7.05H7.35z"/>
You (person)       <circle cx="7" cy="4.75" r="2.75"/>
                   <path d="M1.75 12.5c0-3.1 2.35-4.9 5.25-4.9s5.25 1.8 5.25 4.9"/>
Activity header    <path d="M1.5 3.5h6M4.5 7h8M2.5 10.5h4.5"/>
```

- Agents is lot-map's three nodes; Skills is lot-map's `skills` scaled × 0.72 about (7, 7); You is lot-map's `you`
  redrawn to the grid.
- The Activity header icon is `NEUTRAL`, like every section icon. Turn stats keeps its bar-chart icon.

## 4. The Session band (A2, stretched; R11, R13, R18)

The core sits in the middle of the band. Left of it, from the core outward: **Model, Files, Shell, Web**. Right of
it, outward: **Agents, MCP, Skills, You**. Each side is fed by its own trunk from the core, and pulses go both ways.
On a narrow pane each side is two rows of two on a forked trunk; on a wide pane each side is one row of four on a
straight rail. On every pane the core stays at the band's centre and each side's stations reach the band's edge:
the pitch grows with the width, the circles keep r 11, and only the gaps grow (R18, over R13's pick).

One `Svg` inside `<Box height={5}>` (two rows per side) or `<Box height={4}>` (one row), with `overflow="hidden"`.
While the pitch is ≤ 72 the Svg is `G = W` px wide. Above that it is `W − 8` px wide and left-aligned: one cell of
slack, so an over-estimate of `W` never clips the outer label.

### 4.1 Geometry

**Common to every width:**

| Stations | Band | Core centre `cy0` | Station rows `cy` |
|---|---|---|---|
| two rows per side | **5 rows = 95 px** | 47.5 | 25.5 and 68.5 |
| one row per side | **4 rows = 76 px** | 33 | 33 (the rail is the core's centre line) |

- `Xc = W/2`, the core's x, where `W` = body px = `cols × 8`. Each side's area `S = (W − 64)/2 − 8`.
- `k` = 2 (two rows per side) or 4 (one row). Pitch `P = S / k`, with no cap.
- Group width `G = 64 + 2(8 + k·P)`, which equals `W`.
- Right `cx = Xc + 40 + P(i + 0.5)`; left `cx = Xc − 40 − P(i + 0.5)`; `i` counts from the core outward.
- Two rows per side: row 1 holds the first two from the core (left: Model inner, Files outer; right: Agents inner,
  MCP outer); row 2 the next two (left: Shell, Web; right: Skills, You).
- **Breakpoint:** one row per side when `S/4 ≥ 48`, that is **`W ≥ 464`** (cols ≥ 58; a pane of ≈ 496 px).

**The core** is the base core moved to `(Xc, cy0)`:

| Part | Geometry | Style |
|---|---|---|
| Halo (0.7.1 §2) | first; an annulus outside the ring, r 26 out to 26 → 32 → 26 | `meterColor`, breathing (§7) |
| Track | circle r 24 | stroke `#808080` @ 0.3, width 4 |
| Arc | same circle, from 12 o'clock clockwise, `pathLength` = percent | `meterColor`, width 4, butt caps |
| Compaction ticks | §4.5 | `ash`, width 1.5, round caps |
| Percent | `56%`, centred on `Xc`, baseline `cy0 + 4` | 15px/600 `bone`, tabular |
| Model | `opus 5.5`, centred, baseline `cy0 + 14` | 9px `ash`; a name over 8 characters drops its version (`sonnet`) |
| Tokens | `112k / 200k`, centred, baseline `cy0 + 39` | 10px `ash`, tabular |

The model is the first main step's. After a reopen, with none held, it is read from `$.session.model()` at the start
and drawn until the first step's model replaces it (0.7.1 §11).

The ring's outer edge is at `Xc ± 26`. Two rows: the ticks' top is at 16.5 and the tokens' descender at ≈ 88.7,
inside 95. One row: 2 … 74.

**A station** at `(cx, cy)`, one circle size at every width:

| Part | Geometry |
|---|---|
| Circle | r 11; the 14 px icon centred in it |
| Halo, running (0.7.1 §3.4) | r 14, steady |
| Beat ring, running (0.7.1 §3.4) | r 11 → 21, under the circle, so only its outside shows |
| `×N` badge | r 6 at `(cx+8, cy−8)` (top at `cy−14`); the same corner on both sides, no mirroring |
| Failure disc | r 5.5 at `(cx−8, cy−8)` |
| Text, two rows per side | one line, baseline `cy + 24`: label `s` px/500, count `(s+1)` px/600, `dx 3`, centred |
| Text, one row | stacked: label baseline `cy + 24`, count baseline `cy + 38` |

Z-order: core (its halo first) → trunk/fork/rails → pulses and ripples → each station's halo → beat ring → circle →
icon → badges and discs → text (0.7.1 §2.2, §3.2, §3.4). A pulse and a ripple pass behind the stations.

**Rows clear each other.** With rows 43 px apart, row 1's text descends to `25.5 + 24 + 2.2 = 51.7`; row 2's badge
top is `68.5 − 14 = 54.5`, so 2.8 px stay clear. Row 2's halo starts at 54.5 and its text descends to 94.7 (< 95).
The core's halo and the beat rings clear the rest by 0.7.1 §2.3 and §3.4.

### 4.2 The label rule

No two texts touch at any width:

- Each station's text must fit its slot, `P − 2` px wide and centred on its `cx`; neighbours' texts then stay
  ≥ 2 px apart.
- The size `s` is the largest of 10 and 9 px at which every station fits. If none fits, all labels are left out and
  the counts stay (the name lives in the alt). All stations share one size.
- Width estimate: a capital 0.72 s, any other letter 0.6 s; a count digit or `k` 0.62 (s+1), `.` 0.3 (s+1); the
  inline gap 3 px. Example: `Model 31` at 10px ≈ 47.8, at 9px ≈ 43.5.
- Counts from 1000 read `1.2k`.
- Badge and disc clearance needs `P ≥ 30`. Every pitch in §4.3 is ≥ 47.

### 4.3 Worked geometry

Up to `W = 368` (a pane of ≈ 400 px) the two-row pitch stays ≤ 72, so the stretched band is the same as one with a
capped pitch; the 300 and 360 px examples hold in both. The modes part from `W > 368` (two rows) and `W > 656`
(one row).

**360 px pane (W 328): two rows per side, band 95 px.** `G = 328`, `Xc = 164`, core `(164, 47.5)`; `S = 124`,
`P = 62`. Text 10px inline.

| Side | Row 1 (cy 25.5) | Row 2 (cy 68.5) | Ring edge | Fork |
|---|---|---|---|---|
| left | Model 93, Files 31 | Shell 93, Web 31 | 138 | 128 |
| right | Agents 235, MCP 297 | Skills 235, You 297 | 190 | 200 |

| Element | Left | Right |
|---|---|---|
| Trunk | `M138 47.5H128` | `M190 47.5H200` |
| Fork | `M122 25.5Q128 25.5 128 31.5V62.5Q128 68.5 122 68.5` | `M206 25.5Q200 25.5 200 31.5V62.5Q200 68.5 206 68.5` |
| Rails | `M122 25.5H31`, `M122 68.5H31` | `M206 25.5H297`, `M206 68.5H297` |
| Pulse, row 1 | `M138 47.5H134Q128 47.5 128 41.5V31.5Q128 25.5 122 25.5H{cx+11}` | the mirror, ending `H{cx−11}` |
| Pulse, row 2 | `M138 47.5H134Q128 47.5 128 53.5V62.5Q128 68.5 122 68.5H{cx+11}` | the mirror, ending `H{cx−11}` |

The right side's pulses are `M190 47.5H194Q200 47.5 200 41.5V31.5Q200 25.5 206 25.5H{cx−11}` (row 1) and
`M190 47.5H194Q200 47.5 200 53.5V62.5Q200 68.5 206 68.5H{cx−11}` (row 2).

Pulse lengths: Model and Agents 50.8 px, Shell and Skills 49.8, Files and MCP 112.8, Web and You 111.8; every one
takes 0.6 s (§4.6).

Edge checks: Web's disc left edge is 17.5 and its text slot 1…61; You's badge right edge is 311 and its slot
267…327 (≤ 328); the tokens (≈ 136–192) stay clear of the inner slots (≤ 124 and ≥ 205).

**300 px pane (W 268):** two rows per side, `P = 47`, `G = 268`, `Xc = 134`, forks at 98 and 170. Left cx 70.5
(Model, Shell) and 23.5 (Files, Web); right cx 197.5 (Agents, Skills) and 244.5 (MCP, You). Text 9px (`Model 31`
≈ 43.5 ≤ `P − 2`). The outer slots span 1…267; Web's disc left edge is 10; the branch from each fork
to the inner circle is 16.5 px.

**450 px pane (W 418): two rows per side, band 95 px.** `P = 84.5`, the Svg 410 px wide; core `(209, 47.5)`, ring
edges 183 / 235, forks at 173 and 245. Left cx 126.75 (Model, Shell) and 42.25 (Files, Web); right cx 291.25
(Agents, Skills) and 375.75 (MCP, You). Rails `M167 25.5H42.25`, `M167 68.5H42.25`, `M251 25.5H375.75`,
`M251 68.5H375.75`. Pulse lengths 61.1–146.6 px, all 0.6 s. Text 10px inline.

**900 px pane (W 868): one row of four per side, band 76 px.** `P = 98.5`, the Svg 860 px wide; core `(434, 33)`,
ring edges 408 / 460. Text 10px stacked.

| Side | cx, from the core outward | Rail = every pulse path |
|---|---|---|
| left (Model, Files, Shell, Web) | 344.75, 246.25, 147.75, 49.25 | `M408 33H49.25`; pulses end `H{cx+11}` |
| right (Agents, MCP, Skills, You) | 523.25, 621.75, 720.25, 818.75 | `M460 33H818.75`; pulses end `H{cx−11}` |

Pulse lengths, from the core outward on either side: 52.3, 150.8, 249.3, 347.8 px; durations 0.6, 0.6, 0.61, 0.72 s.

**≈ 3400 px pane (W 3368): one row of four per side,** below R19's 4096 px cap (§4.4). `P = 411`, the Svg
3360 px wide; core `(1684, 33)`, ring edges 1658 / 1710.

| Side | cx, from the core outward | Rail = every pulse path |
|---|---|---|
| left (Model, Files, Shell, Web) | 1438.5, 1027.5, 616.5, 205.5 | `M1658 33H205.5`; pulses end `H{cx+11}` |
| right (Agents, MCP, Skills, You) | 1929.5, 2340.5, 2751.5, 3162.5 | `M1710 33H3162.5`; pulses end `H{cx−11}` |

Pulse lengths, from the core outward on either side: 208.5, 619.5, 1030.5, 1441.5 px; durations 0.6, 0.96, 1.24, 1.4 s.

**At the breakpoint** (W 464, P 48, stacked 10px; `Agents` ≈ 37 ≤ 46): the outer texts span 1…463 ≤ 464.

### 4.4 Widths, 300 to ≈ 3400 px

The pane's rule (base §5.1, §6.2, §9): a row's bar parts stretch to the edge, and the marks and text keep their size.
Images stop at 4096 px (base §12 item 8). The band follows the same rule: the core stays at the centre, the sides
reach the edges, and the circles and text keep their size; only the gaps grow (R18).

| Pane / W | Rows per side | P | Text | Band rows | Svg width |
|---|---|---|---|---|---|
| 300 / 268 | 2 | 47 | 9px inline | 5 | 268 |
| 360 / 328 | 2 | 62 | 10px inline | 5 | 328 |
| 450 / 418 | 2 | 84.5 | 10px inline | 5 | 410 |
| ≈ 496 / 464 (breakpoint) | 1 | 48 | 10px stacked | 4 | 464 |
| 900 / 868 | 1 | 98.5 | 10px stacked | 4 | 860 |
| ≈ 3400 / 3368 | 1 | 411 | 10px stacked | 4 | 3360 |

- The minimum gap between circles is `P − 22` (≥ 25 at every width here).
- **Wider than 4096 px** (R19): on a body wider than 4096 px (`SVG_MAX_PX`) the band is laid out for `W = 4096`
  with §4's `W − 8` rule, so it is 4088 px wide, and it is centred in the body. Its stations are never clipped. The
  ≈ 3400 px example is below this cap.
- The ribbon and the lanes stretch like the meters (§5.5, §6.6).

### 4.5 Trunk, forks and rails (R10)

- The **trunk** leaves the ring's outer edge on the core's horizontal centre line `y = cy0` and runs **10 px**
  outward. The fork point is at `x_f = Xc ± 36`.
- **Two rows per side:** at `x_f` a vertical **fork** joins the two branches. Its corners into the rows are quarter
  arcs of r 6. The trunk meets the fork's middle as a T. The **rails** run from the arcs' ends along `y = cy_row` to
  the outermost station of that row.
- **One row per side:** no fork. The trunk and the rail are one straight line at `y = cy0`.
- Stroke: 1 px `rail` everywhere.
- **Clearances.** `x_f` is 4 px inside the stations' area (which starts at `Xc ± 40`), so no label slot, badge or
  disc crosses the trunk or the fork. The branch from the fork to the inner circle is `P/2 − 7` px (≥ 16 at every
  width), room enough for the r 6 arc.

### 4.6 Station states

| Part | Idle | Running | Failed this turn |
|---|---|---|---|
| Halo, r 14 | none | station hue at 0.16, steady (0.7.1 §3.4) | — (kept if also running) |
| Beat ring, r 11 → 21 | none | station hue, stroke 1.5, opacity 0.9 → 0, every 1.4 s (§7) | — (kept if also running) |
| Circle, r 11 | fill `raised`, stroke `line` 1 | stroke station hue 1.5 | stroke `fail` 1.5 (wins over the hue) |
| Icon | station hue | station hue | station hue |
| Label | `ash` | `bone` | `bone` |
| Count | `bone` | `bone` | `bone` |
| `×N` badge (N ≥ 2 running) | — | fill `raised`, stroke hue 1; `×2` 8px/700 `bone`; `×9+` from 10 | — |
| Failure disc | — | — | fill `fail`; this turn's failures, `1`, 8px/700 in `raised`; `9+` from 10 |

- **Count 0:** the icon at opacity 0.45, label and count `ash`. Before any call every station reads 0, dimmed.
- **Idle** (no call running): no halos, no beat rings, no badges; Model stops beating between turns.
- **Failure lifetime:** a failure mark stays until main's next turn starts, so it is still there while idle after the
  turn that failed.
- **No context reading:** the track only, the centre `—` in `ash`, the tokens line `—`; the ticks do not change.
- **≥ 80 % / ≥ 95 % context:** the arc turns `AMBER` / `RED` (the meter rule). The percent stays `bone`: the arc's
  colour carries the threshold, and the alt says the value.
- What counts as running and as a failure is in §8.2.
- In the example: Model has a halo, a beat ring and `×3`; Shell a halo, a beat ring, a `fail` stroke and a `1` disc;
  Agents a halo, a beat ring and `×2`; the other five are idle.

### 4.7 Compaction ticks

Radial lines from r 27.5 to r 31 around the core, the first at 12 o'clock, each next 9° clockwise; at most 5. One per
main `session.compact` the mod sees, and one per compaction it finds at a usage reading (§8.5, 0.7.1 §8). The alt
carries the count. When another plugin keeps the event from the mod, the next usage reading counts the compaction; one
inside a running turn whose next response comes first is missed (§10).

### 4.8 Pulses

A pulse runs from the core to a station when the station gets a call (a model step for Model).

- **One `animateMotion` per pulse** along trunk → (rounded junction) → fork → branch → rail. It ends at the
  circle's edge (`cx ∓ 11`). With one row per side the path is the straight rail from the ring's edge.
- The T junction is rounded with r 6 in the motion path only. The comet cuts that corner by ≤ 1.8 px, which does not
  show.
- **The comet** (0.7.1 §3.1): a circle r 3.5 in the station's hue and a tail, a wedge 14 px long and 5.6 px wide at
  the circle, filled with a gradient `pulse-{station}` from opacity 0 at its tip to 0.7. `rotate="auto"` turns it
  along the path. It is drawn while its age is below its travel duration; after that the pulse group is empty.
- Timing: `keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines=".2 .6 .35 1"`.
- **Duration rule:** `dur = clamp(0.6 × √(L / 240), 0.6, 1.4)` s, where `L` is the path's length in px. Short paths
  keep 600 ms; longer ones slow down gently. `L` for a two-row path is
  `4 + 9.42 + (|cy − cy0| − 12) + 9.42 + the branch-and-rail run`. Long paths fly longer (R18): at 900 px the
  outer paths take 0.72 s; at ≈ 3400 px they run 1441.5 px and take the 1.4 s cap.
- The fade, the arrival flash and the ripple follow at `begin + dur` (§7).
- **The ripple** (0.7.1 §3.2): a circle at the station, r 11 → 19, stroke 1.5 in its hue, opacity 0.7 → 0 over
  450 ms, linear, static opacity 0. It goes into the pulses layer, so the station's opaque circle hides its inside.
- **Lifetime** (R16 g, 0.7.1 §3.3): a pulse's parts are drawn while its age is below its travel duration + 450 ms,
  the ripple's time, which outlasts the 150 ms fade and the 300 ms flash; each part has its own phase offset.
- At most one pulse group and one ripple per station, so the element count is fixed.

### 4.9 Alt text

The band's Svg alt, in station order:

```text
Context 56%, 112k of 200k, opus 5.5, 1 compaction. Model 31, 3 running; Files 12; Shell 4, 1 running, 1 failed
this turn; Web 1; Agents 5, 2 running; MCP 3; Skills 6; You 3.
```

With 0 compactions the alt leaves out the compaction part (`…, opus 5.5. Model 31, …`).

The `<title>` texts, drawn only if §11.3 enables interactive mode (not drawn in 0.7.0: §11.3, ruling C-no):

```text
Context 56.0% · 112k / 200k · opus 5.5 · 1 compaction
Model · 31 steps · 3 running
Files · 12 calls
Shell · 4 calls · 1 running · 1 failed this turn
Web · 1 call
Agents · 5 calls · 2 running
MCP · 3 calls
Skills · 6 calls
You · 3 calls
```

### 4.10 Terminal

The terminal has no ring: the core is a line, then the stations in a grid. The station grid is r3's layout A grid.

**The core line:** `opus 5.5  ▰▰▰▰▰▰▱▱▱▱  56%` at the left, `112k / 200k ↻1` right-aligned at
the edge.

- `opus 5.5` primary, by §4.1's model rule (`coreModel` in `hooks/band.ts`: the short model, its first word when it
  is wider than 8 cells, cut to 8 cells) · 2 spaces · the meter, 10 cells (`▰` in `meterColor`, `▱` dim; today's
  rule) · 2 spaces · `56%` primary (theme `warning` / `error` from 80 / 95 %) · the gap · `112k / 200k` dim ·
  space · `↻1` dim (`↻N`; left out at 0 compactions).
- 40–43 columns: `↻N` and its space are left out (38 cells). Wider, only the gap before the tokens grows.
- **No context reading** (R16 i): the model name (or `—` when it is unknown), the empty meter (10 dim `▱`),
  then `—` for the percent and `—` for the tokens. `↻N` shows as usual and is left out at 0.

**Station cells.** Cells are joined by 1 space, never stretch, and the row is left-aligned.

- Full cell, **14** wide: `mark(1) space label(6) count(3, right) space badge(2)`.
- Compact cell, **10** wide: `mark(1) label(5) count(3, right) badge(1)`. Labels cut to
  `Model Files Shell Web MCP Agent Skill You`; the badge is `!` (error) or `×` (hue), with no N.

| Part | Char | Colour |
|---|---|---|
| mark, running | `●` | station hue |
| mark, idle | `·` | dim |
| label | `Model` … `You` | station hue (the terminal's colour key) |
| count | digits; from 1000 `1k` … `99k` (whole thousands, 99k at most; the desktop keeps `1.2k`) | primary; dim at 0 |
| badge, failure this turn | `!N` (`!9` at most) | theme `error`; wins the badge cell |
| badge, N ≥ 2 running | `×N` (`×9` at most) | station hue |

| cols | Cell | Cells per row | Grid rows |
|---|---|---|---|
| 40–42 | 10 | 3 | 3 (3/3/2) |
| 43–58 | 10 | 4 | 2 |
| 59–118 | 14 | 4 | 2 |
| ≥ 119 | 14 | 8 | 1 |

**44 columns** (3 rows; the grid rows are 43 cells, the 44th stays blank):

```text
opus 5.5  ▰▰▰▰▰▰▱▱▱▱  56%     112k / 200k ↻1
●Model 31× ·Files 12  ●Shell  4! ·Web    1
●Agent  5× ·MCP    3  ·Skill  6  ·You    3
```

Each cell is `mark + label padded to 5 + count right in 3 + badge`; `●Shell  4!` is `●` `Shell` `  4` `!`, the `!`
in the error colour.

**60 columns** (full cells, 4 a row):

```text
● Model  31 ×3 · Files  12    ● Shell   4 !1 · Web     1
● Agents  5 ×2 · MCP     3    · Skills  6    · You     3
```

Every terminal colour is raw hex from the dark set (§9.6).

## 5. Turn stats as the ribbon

### 5.1 Block

The rows of 0.7.1 §17.8: rule · header · bar row · the legend's rows · details row; 5 when the legend takes one row.

- **Header** unchanged: the bar-chart icon, bold `Turn stats`, the chevron, and the dim response rate as today.
  Folding the section hides the rows below.
- **Bar row** (one row, `Box height={1} alignItems="center"`): `[Svg bar area, FLEX][gap 1][elapsed, FIXED 7 cells,
  right-aligned Text, primary]`.
- Bar area = `min(W − 64, 4096)` px: **264 px at 360**. Svg height 16 px.

### 5.2 Scale, bar and segments

- **Ceiling.** The bar is drawn against a ceiling: the first of 15 s, 30 s, 1 m, 2 m, 3 m, 5 m, 10 m, 15 m, 20 m,
  30 m, 45 m, 1 h, 1.5 h, 2 h, 3 h, then every hour, that is ≥ the elapsed time. The ceiling is the full bar area, so
  the bar grows, and when it passes the ceiling it steps back to 50–67 % of the width. A **finished** turn's ceiling
  is its own elapsed time: the bar fills the area, and "full" reads as "done".
- **Bar:** y 3–13 (10 px) at every width; outer ends rounded rx 3 (one `clipPath` rect around the whole bar; the
  segments inside are square).
- **Segments:** one per model call and one per tool call. Parallel tool calls of one step are one segment in the hue
  of the first one's station.
  - model: the `Model` hue, solid. There is no waiting-for-the-first-token part; the legend's TTFT carries it (R5);
  - tool: the station's hue, at least 2 px wide (§5.3's layout makes the room);
  - a **1 px gap** (the pane bg shows through) between any two segments.
- **Rest of the scale** (running turn only): a 1 px hairline on pixel row 8 (its centre y 8.5) from the bar's
  end + 2 px to the area's end, `ash` at opacity 0.5, `stroke-dasharray="1 3"`, and a 1 × 6 px tick (y 5–11) at the
  area's end.

### 5.3 Colour rules, the merged earlier part and N (R5, R14)

- Every mark is drawn in the exact hue of its station in the band (§3.3), at full strength. No opacity-dimmed or
  "hot" variant of a hue: a state shows by shape, never by a lighter or darker colour.
- **Detailed steps:** the latest **N = clamp(floor(barPx / 20), 6, 60)** steps (`ribbonDetail(barPx)`) are always
  drawn in detail, about one step per 20 px, so the bar never turns into a barcode. A step is one model call (R1); it
  draws as its model segment and the tool segment after it.
- **Earlier steps** merge into one leftmost "earlier" block: one part per station, each in its hue, joined with no
  gaps, in station order (§3.4), then the usual 1 px gap.
- **Layout** (`ribbonSegments` in `hooks/ribbon.ts`), on the scale's px:
  - forward: each detailed part starts 1 px after the one before (the first 1 px after the block) and ends at the
    greater of its own end and its start + its minimum, 2 px for a tool part and 1 px otherwise; the last part ends
    at the turn's end;
  - pull-back: when the last part ends past the lesser of the bar's end and the live end, the parts are pulled back
    from the end, each keeping its minimum and the 1 px gap before it;
  - the `earlier` block gives way first: it ends 1 px before the first detailed part, its parts split by largest
    remainder, each at least 1 px;
  - only when the block is down to 1 px a part and the parts still do not fit does the oldest detailed step merge
    into it, one step a pass. With no step left to merge, the layout stands as it is.

| Pane | Bar | N |
|---|---|---|
| 300 px | 204 px | 10 |
| 360 px | 264 px | 13 |
| 450 px | 354 px | 17 |
| 900 px | 804 px | 40 |
| ≈ 3400 px | ≈ 3300 px | 60 |

### 5.4 Failure marks, the live cap, the legend

- **Failed tool call:** its segment keeps its hue and gets a `fail` underline, 2 px tall at y 14–16, under it.
- **Live end** (running turn only): a cap 2 × 14 px (y 1–15) at the bar's end, in the live segment's hue. Its opacity
  pulse (§7) is motion, not a colour.
- **Growth between redraws:** the live segment's `width` and the cap's `x` are SMIL-animated linearly at
  `areaPx / ceilingSeconds` px/s up to the ceiling (`dur` = ceiling − elapsed, `fill="freeze"`), so the bar grows
  without redraws. The elapsed Text updates on redraws only.
- **Alt** (0.7.1 §17.7): the stations as the legend lists them, in lower case:
  `Turn 2m 14s: model 58%, files <1%, shell 23%, agents 17%, mcp 2%, you <1%, 6 steps, 1 failed call`.
- **`<title>` per segment** (only with §11.3's interactive mode): the labels of §2.3, e.g.
  `Bash tsc --noEmit · Shell · 31s · failed`. Not drawn in 0.7.0 (§11.3, ruling C-no).
- **Legend rows** (0.7.1 §17.1-§17.3, §17.5): Model first, then each tool station with time in the shown turn, in
  station order, each as `[swatch][gap 1]` + dim label + primary ` NN%` (`<1%` for a share above 0 that rounds to
  0); then primary `6 steps` and dim `TTFT` primary `1.2s`. Separators ` · ` dim. A swatch is an Svg 8 × 8 rect rx 1.5
  in its station's hue, one fixed source per station, in a FIXED 2-cell slot (its cell and the gap), alt the station's
  label. The shares are of the sum of the station times, the time the bar draws in each hue (0.7.1 §17.2). Whole items
  wrap over rows, one Box row each; an item wider than a row is cut with `…`. Every item shows: the narrow rules are
  gone. In the example, at 360 px: `■ Model 58% · ■ Files <1% · ■ Shell 23%`, `■ Agents 17% · ■ MCP 2% · ■ You <1%`,
  `6 steps · TTFT 1.2s`.
- **The fallback** (0.7.1 §17.6): a last turn with no ribbon (one of 0.6.1, kept over a hot reload) draws `Model`
  (with the Model swatch) and `Tools`, by the shares of `modelMs + toolMs`, then the steps and TTFT, and the alt
  `Turn 2m 14s: model 58%, tools 42%, 6 steps, 1 failed call`.

**Worked geometry at 360 px** (bar area 264 px, ceiling 3 m = 180 s → 1.467 px/s; elapsed 134 s; N = 13, so
nothing merges):

| # | Segment | Station | Time | x | w | Note |
|---|---|---|---|---|---|---|
| 1 | model | Model | 9 s | 0 | 13 | |
| 2 | Read ×2 | Files | 0.4 s | 14 | 2 | min width |
| 3 | model | Model | 11 s | 17 | 13 | |
| 4 | Bash tsc --noEmit | Shell | 31 s | 31 | 44 | `fail` underline x 31–75 |
| 5 | model | Model | 14 s | 76 | 20 | |
| 6 | Agent | Agents | 22.3 s | 97 | 32 | |
| 7 | model | Model | 8 s | 130 | 10 | |
| 8 | TodoWrite | You | 0.2 s | 141 | 2 | min width |
| 9 | model | Model | 18 s | 144 | 23 | |
| 10 | search_graph | MCP | 2.1 s | 168 | 2 | |
| 11 | model, live | Model | 18 s | 171 | 26 | cap x 196–198 |
| — | rest of scale | — | — | 199–264 | — | dotted hairline, end tick at 264 |

### 5.5 Widths

| Pane / W | 300 / 268 | 360 / 328 | 450 / 418 | 900 / 868 | ≈ 3400 / 3368 |
|---|---|---|---|---|---|
| Bar area `min(W − 64, 4096)` | 204 | 264 | 354 | 804 | 3304 |
| N | 10 | 13 | 17 | 40 | 60 |
| Legend rows (the example, 0.7.1 §17.5) | 4 | 3 | 3 | 1 | 1 |

- The scale, segments, minimum widths and rest-of-scale hairline do not change with the width; only the area grows.
- Above a 4160 px body (a 32:9 monitor) the bar ends at 4096 px and a gap opens before the elapsed time, as the
  meters do today.

### 5.6 The details fold

- **Details row:** a `plain dimColor` Button, label `▸ details` when closed (**the default**) and `▾ details` when
  open. Open adds today's label/value rows (base §6.6) under it.
- The fold key is `turnDetails` in `collapsed`, with the inverted default: it is open only when
  `collapsed.turnDetails === false`, and the Button toggles it.
- While a turn runs, the table is today's `computeTurnStats` on the live accumulator (§8.3).

### 5.7 Running, idle and no turn

- **Running turn:** drawn live, with the cap, the growth and the dotted rest of the scale.
- **Idle:** the last turn draws: the bar fills the area (its ceiling is its own elapsed time), no cap, no rest of the
  scale.
- **No turn yet:** today's placeholder stays.

### 5.8 Terminal

The bar, the legend's rows, the details Button.

- **Row 1:** the bar is `cols − 8` cells, the ceiling spans them; filled cells = round(elapsed / ceiling × bar); each
  segment gets at least 1 cell, by largest remainder; `·` dim for the rest of the scale; a space; the elapsed time
  right-aligned in 7.
- Every cell is in its segment's hue. No separators: model and tool segments alternate, so colour changes mark the
  steps. No hot cell: the dotted rest of the scale already says the turn runs. A failed tool segment keeps its
  station hue, and its **last cell is `✗`** in the error colour (the band shows a failure the same way).
- **The legend's rows** (0.7.1 §17.4-§17.5): each station's label in its dark hue, `TTFT` dim, values primary, ` · `
  dim; no glyph. Whole items wrap within `cols`, as on the desktop; nothing is left out.
- **The last row:** the dim `▸ details` Button.
- **Finished turn:** the bar fills all `cols − 8` cells, no `·`.
- **No waiting mark** (R16 f): model segments are solid `█` in the terminal too; there is no `▒`.

**44 columns** (ceiling 3 m over 36 cells = 5 s a cell; the bar is round(134/180 × 36) = 27 cells):

```text
██████████✗████████████████·········  2m 14s
Model 58% · Files <1% · Shell 23%
Agents 17% · MCP 2% · You <1% · 6 steps
TTFT 1.2s
▸ details
```

| Cells | Count | Char | Colour |
|---|---|---|---|
| 0–1 | 2 | `█` | Model |
| 2 | 1 | `█` | Files |
| 3–4 | 2 | `█` | Model |
| 5–9 | 5 | `█` | Shell |
| 10 | 1 | `✗` | theme `error` (the failed Shell call's last cell) |
| 11–13 | 3 | `█` | Model |
| 14–17 | 4 | `█` | Agents |
| 18 | 1 | `█` | Model |
| 19 | 1 | `█` | You |
| 20–22 | 3 | `█` | Model |
| 23 | 1 | `█` | MCP |
| 24–26 | 3 | `█` | Model (the live segment) |
| 27–35 | 9 | `·` | dim, the rest of the scale |
| 36 | 1 | space | |
| 37–43 | 7 | ` 2m 14s` | primary, right-aligned |

The legend's rows are 33, 39 and 9 cells. Widths: the bar is 36 cells at 44 columns, 112 at 120, 192 at 200.

## 6. Activity

### 6.1 Rows and order

Rule · header · up to 8 lanes · axis row · `+N more`: **12 rows** in the example, as today's Subagents and Tasks.

- **Header:** the Activity icon (§3.6), bold `Activity`, the chevron, dim summary `3/8`: running / total of the
  subagents and tasks, or the total alone when nothing runs. The main lane is not counted. The fold key is
  `activity`; the old `agents` and `tasks` keys are ignored.
- **Lane order:** `main` first; then the running lanes, the older start first; then the ended lanes, the newer end
  first. A resumed subagent's start is its first run's, its end the last span's (0.7.1 §10.2). At most 8 lanes; the
  rest are counted in `+N more` (dim, no indent).
- **Unknown times** (R16 e): among the running lanes, those with an unknown start sort after those with a known
  start; among the ended lanes, those with an unknown end sort last.
- **Hidden:** with no subagents and no tasks the block is left out (a lone main lane would repeat the ribbon).
- **Hues by lane:** main = Model, subagents = Agents, tasks = Shell (any task kind).
- **Main** draws its latest 6 turns (§8.4): the finished ones as finished bars, the running one as a running bar.

**Example lanes**, in order:

| # | Lane | Hue | Span | Status | Value |
|---|---|---|---|---|---|
| 1 | `main` | Model | −12:30 → −8:50, −6:20 → −3:40, −2:14 → now | running | `—` (a row is restored) |
| 2 | `Review the diff` | Agents | −6:00 → now | running | `$0.310` |
| 3 | `npm test` | Shell | −3:40 → now | running | `3m 40s` |
| 4 | `Plan critique` | Agents | unknown start (restored) | running | `$0.410+` |
| 5 | `Map the mask` | Agents | −1:09 → −0:46 | done | `$0.120` |
| 6 | `Repro check` | Agents | −4:00 → −3:00 | failed | `$0.050` |
| 7 | `Engine facts` | Agents | −12:00 → −4:00 | done | `$0.880` |
| 8 | `dev server` | Shell | −10:00 → −6:00 | stopped | `4m 00s` |
| — | `claude plugin test` (−9:40 → −9:22) | | | | → `+1 more` |

### 6.2 Lane rows and status shapes (desktop)

A lane row, one row, `alignItems="center"`:
`[label, FIXED L cells][gap 1][bar area, Svg × 19][gap 1][value, FIXED 8 cells, right-aligned Text]`.

- **Label cell** (0.7.1 §4.4): with a tag, a FIXED Box of `descW` cells (overflow hidden) holding the description,
  then the dim tag after a no-break space; below 24 cells, or with no tag, the description alone (§6.4).

- **Axis part:** x 0 → A, `A = area − 12`; `x = A − secondsAgo × A / span`.
- **Gutter:** the last 12 px, for the end marks of lanes that end at or near now and of unknown spans.
- **Label:** running lanes and `main` primary, the others dim. **Value:** primary; a dim `—` when unknown.

| Status | Bar | End |
|---|---|---|
| running | 6 px bar (y 6.5–12.5) in full hue, to x = A | live cap 2 × 10 px at x A−2…A, pulsing (§7) |
| done | 3 px bar (y 8–11, rx 1.5) in full hue | `✓` (the house check at 9 px), `GREEN`, centred at end + 6 |
| failed | 3 px bar, as done | `✗` 9 px, `RED`, centred at end + 6 |
| stopped | 3 px bar, as done | `■` 5 × 5 rx 1, `NEUTRAL`, centred at end + 6 |
| ended, unknown span (restored) | the dashed line (below) | `○` ring r 3.5, `NEUTRAL` stroke 1.4, at x A + 6 |
| done, failed or stopped, unknown start (restored) | the dashed line | its `✓`, `✗` or `■`, centred at x A + 6 |
| running, unknown start (restored) | the dashed line | the live cap |
| started before the axis | left end square, an 8 px fade-in at the left edge (`linearGradient` 0 → the hue) | — |
| a resumed subagent's earlier runs (0.7.1 §10) | a 3 px bar each, the time between runs a gap | — |

The dashed line is 2 px, from 0 to A at y 9.5, in full hue, `stroke-dasharray="3 3"`. Any lane but `main` with no
known start draws it (`spansOf` and `drawLane` in `hooks/lanes.ts`). A restored lane whose end was seen live keeps
that end: it sorts by it (§6.1) and draws its status mark at A + 6; a lane with neither time sorts as an unknown one.
A resumed subagent's spans are its closed runs (`runs`, §8.4), then its current one; the current run draws as its
status shows, and the status mark follows the last span. A run with no known start draws nothing.
Status marks keep the pane's status colours: `✓` success green, `✗` red, `■` and `○` neutral.

**Svg alt:** `<description> (@type), <status>, <value>` at every width (R16 d, §6.4); for example
`Review the diff (@code-reviewer), running, $0.310`.

**Worked geometry at 360 px** (0.7.1 §4.5: L 18 cells, area 104 px, A = 92, span 720 s, 0.1278 px/s):

| Lane | Bar x (from → to) | Bar | End mark centre |
|---|---|---|---|
| main | 0 → 24.3 (fade-in), 43.4 → 63.9 | 3 px | — |
| | 74.9 → 92 | 6 px, cap | — |
| Review the diff | 46 → 92 | 6 px, cap | — |
| npm test | 63.9 → 92 | 6 px, cap | — |
| Plan critique | 0 → 92, dashed | 2 px, cap | — |
| Map the mask | 83.2 → 86.1 | 3 px | ✓ 92.1 |
| Repro check | 61.3 → 69 | 3 px | ✗ 75 |
| Engine facts | 0 → 61.3 | 3 px | ✓ 67.3 |
| dev server | 15.3 → 46 | 3 px | ■ 52 |

### 6.3 The axis

- **Span:** from the oldest start among the shown non-main lanes to now, at least 2 minutes. The main lane never sets
  the axis; its spans are cut at the axis start (the fade-in). Restored lanes with an unknown start do not set it.
- **Axis row:** `[L cells empty][gap][Svg area × 16][gap][8 cells empty]`. A 1 px `rail` hairline at y 2.5 from 0 to
  A; ticks 1 × 4 px (y 1–5) at round clock times; labels 9px `ash` `HH:MM`, centred under their ticks, baseline y 14;
  `now` right-aligned to x A + 4.
- **Tick step,** at any width: the least `s` of {1, 2, 5, 10, 15, 30, 60, 120, 240, …} minutes with
  `s × A / spanMin ≥ 48` px. A clock label closer than 36 px to `now` is left out; its tick stays. So is a clock
  label closer than 14 px to the axis start (half its width, which the image would clip); its tick stays too.
- **Alt:** `axis 11:52 to now`.
- Example at 360: span 12 min, step 5 m; `11:55` at x 31.1, `12:00` at x 89.4, `now` at 140.

### 6.4 Values, the type tag, `+N more`

- **Values:** an agent's cost in view.tsx's cost format, a task's time. Main's value is its cost (Session's figure),
  and a dim `—` while any subagent row is restored: main's cost is not known then, and the split line hides Session
  for the same reason (0.6.1).
- **The type tag (R15):** a lane's `@type` tag (`@code-reviewer`, `@shell`) is drawn dim after its label when the
  label column is at least 24 cells wide. A subagent's tag is `@` + its type as the Log shows it (`shortType`: the
  plugin prefix dropped, cut at 14 characters with `…`, so `@general-purpo…`); a task's tag is its kind, `@shell`,
  `@monitor` or `@workflow` (`TaskKind`). That holds from 54 columns (a body of 432 px, a pane of ≈ 464 px; 0.7.1
  §4.2). Below that, the tag is not drawn.
- **Two sub-columns** (0.7.1 §4.2): from 24 cells the column is a description sub-column of `descW = L − 1 − tagW`
  cells, a gap cell and a tag sub-column, `tagW` the most cells of the shown lanes' tags (main's counts 0). Every tag
  starts at cell `descW + 1` and is never cut.
- **Description cuts** (0.7.1 §4.3): a description is cut at the end to `descW` cells with `…`. Where two or more of
  the shown descriptions wider than `descW` have the same end cut, each is cut in the middle instead: a head of at
  least 4 code points, `…`, and a tail long enough to tell them apart (a third of the room at least, moved back to its
  word's start when that costs at most 3). The head drops its trailing spaces, or keeps them all when dropping them
  would leave it under 4 code points: `Fix the X12` and `Fix the Y12` at 8 cells give `Fix …X12` and `Fix …Y12`. A
  description that fits is never cut; descriptions that read the same in whole stay the same.
- **The alt always carries the tag** (R16 d): `<description> (@type), <status>, <value>`.
- **`+N more`:** lanes past 8, dim, at column 0.
- **Hidden** when there are no subagents and no tasks (§6.1).

### 6.5 Terminal

Row = `label(L) space bar space value(8, right)`; the label is the description (padded to `descW` when a tag
follows), a space and the dim tag (0.7.1 §4.4). The bar is `cols − L − 10` cells: the axis is `bar − 1` cells, the
last cell is the gutter. In the example the axis is 14 cells at 44 columns, 51 s a cell (0.7.1 §4.5).

| Char | Meaning | Colour |
|---|---|---|
| `━` | running span | lane hue |
| `─` | finished span | lane hue |
| `┄` | unknown span | lane hue |
| `◐` | running, in the gutter | lane hue |
| `✓` `✗` `■` `○` | house marks after the span's end (`○` in the gutter) | success / error / dim / dim |
| axis labels | clock times, `now` | dim |

Label colour: running lanes and `main` primary, the rest dim.

**44 columns:**

```text
Activity ▾                               3/8
main                ────   ─── ━━━◐        —
Review the diff            ━━━━━━━◐   $0.310
npm test                      ━━━━◐   3m 40s
Plan critique       ┄┄┄┄┄┄┄┄┄┄┄┄┄┄◐  $0.410+
Map the mask                     ─✓   $0.120
Repro check                  ──✗      $0.050
Engine facts        ─────────✓        $0.880
dev server            ─────■          4m 00s
                                now
+1 more
```

Bar strings, 15 cells each (`␣` = space; 0.7.1 §4.5):

| Lane | Bar |
|---|---|
| main | `────␣␣␣───␣━━━◐` (4, 3, 3, 1, 3, 1) |
| Review the diff | 7 `␣`, 7 `━`, `◐` |
| npm test | 10 `␣`, 4 `━`, `◐` |
| Plan critique | 14 `┄`, `◐` |
| Map the mask | 13 `␣`, `─`, `✓` |
| Repro check | 9 `␣`, 2 `─`, `✗`, 3 `␣` |
| Engine facts | 9 `─`, `✓`, 5 `␣` |
| dev server | 2 `␣`, 5 `─`, `■`, 7 `␣` |
| axis | 12 `␣`, `now` |

Values (8, right): `       —`, `  $0.310`, `  3m 40s`, ` $0.410+`, `  $0.120`, `  $0.050`, `  $0.880`, `  4m 00s`.

### 6.6 Widths

`L = clamp(floor(cols × 0.45), 9, 64)` cells (`laneLabelCells`; 0.7.1 §4.1). Body px = cols × 8. Lane area =
`min(body − (L + 10) × 8, 4096)` px, `A` = area − 12. Terminal bar = `cols − L − 10` cells, the axis `bar − 1`. The
axis labels are the example's (span 12 min, §6.3). The widths of 0.7.1 §4.5:

| cols | body | L | label column | area / A, px | bar / axis, cells | desktop axis labels | 0.7.0: L, area, bar |
|---|---|---|---|---|---|---|---|
| 33 (300 px pane) | 264 | 14 | descriptions | 72 / 60 | — | none | 9, 112, — |
| 40 | 320 | 18 | descriptions | 96 / 84 | 12 / 11 | none | 12, 144, 18 |
| 41 | 328 | 18 | descriptions | 104 / 92 | 13 / 12 | none | 12, 152, 19 |
| 44 | 352 | 19 | descriptions | 120 / 108 | 15 / 14 | `12:00` | 13, 168, 21 |
| 52 | 416 | 23 | descriptions | 152 / 140 | 19 / 18 | `11:55`, `12:00` | 15, 216, 27 |
| 54 | 432 | 24 | 8 + 1 + 15 | 160 / 148 | 20 / 19 | `11:55`, `12:00` | 16, 224, 28 |
| 108 | 864 | 48 | 32 + 1 + 15 | 400 / 388 | 50 / 49 | every 2 m, 11:54 … 12:02 | 32, 528, 66 |
| 200 | 1600 | 64 | 48 + 1 + 15 | 1008 / 996 | 126 / 125 | every 1 m, 11:53 … 12:03 | 32, 1264, 158 |

- The label column's split assumes a 15-cell tag; with shorter tags `descW` is wider by the difference.
- The "0.7.0: L, area, bar" column is recomputed on this table's basis (body = cols × 8), so at 33 columns it reads
  112 where the old 300 px table, measured from the pane's W of 268 px, read 116.
- Lane bars stay 6 px (running), 3 px (finished) and 2 px (dashed) at every width; only their lengths scale. The
  12 px gutter is fixed.
- Above a 4160 px body the lanes get a gap before their right-hand values, as the meters do.

## 7. Motion

All SMIL, inside the Svgs; nothing animates in the terminal.

| What | Property | Values | Duration | Easing | Repeat |
|---|---|---|---|---|---|
| Live end cap (ribbon, lanes) | `opacity` | 1 → 0.3 → 1 | 1.6 s | spline `.45 0 .55 1` | indefinite |
| Ribbon live segment growth | `width`, cap `x` | linear to the ceiling | ceiling − elapsed | linear | once, freeze |
| Core halo (0.7.1 §2.1) | `r`, `stroke-width`, `opacity` | 0.7.1 §2.2 | 4.8 s; busy 1.6 s | as the cap | indefinite |
| Beat ring (0.7.1 §3.4) | `r`, `opacity` | 11 → 21, 0.9 → 0 | 1.4 s | linear | indefinite |
| Pulse (new call) | the comet, motion | core → station edge | 0.6–1.4 s (§4.8) | spline `.2 .6 .35 1` | once |
| Pulse fade | the comet's `opacity` | 1 → 0 | 150 ms after arrival | linear | once |
| Arrival flash | station `stroke-width` | 1.25 → 2.25 → 1.25 | 300 ms after arrival | ease-out | once |
| Ripple (0.7.1 §3.2) | `r`, `opacity` | 11 → 19, 0.7 → 0 | 450 ms after arrival | linear | once |

- **Phase-locking.** Every redraw makes a new Svg, so the animations are phase-locked to continue where they were:
  - a pulse's `begin` is −age (age = now − the station's `lastCallAt`); its parts are drawn while the age is below
    the travel duration + 450 ms (R16 g, 0.7.1 §3.3), each part with its own phase offset;
  - a loop's `begin` is −(now mod period);
  - each element's static attributes are its resting state: the comet and the ripple at opacity 0, a station circle
    at its own stroke width, the core's halo at r 26, width 0, opacity .05;
  - a one-shot part whose own interval is already over when the image is made is dropped by the engine, its
    `fill="freeze"` end state included (§11.3), so it changes nothing. The arrival flash ends at the resting stroke
    width, so a flash that is over leaves the station as it was;
  - the comet needs more: its `<set>` of opacity has no end, so it still shows the comet once its `animateMotion`
    (and its fade) are dropped, and the comet would sit at the band's origin. So `pulseSvg` leaves out the comet
    whose travel is over (age ≥ the travel time), and draws the group empty while the ripple lasts;
  - a growth whose start state is computed from now (the ribbon's live part and its cap, from their width at now to
    the ceiling, `dur` = what is left) starts when the image is created, with no `begin`: a redraw computes it again.
- In the pane, pulses fire on real calls. Badges and failure marks appear without animation.
- Redraws come from state writes (at most 10 a second, the engine's cap) and the existing 30 s tick
  (`hooks/register.tsx:42`, `:762`). No new timers.
- **`motion: reduced`** (§9.5; 0.7.1 §2.1, §3.5) draws no comet, ripple, flash, beat ring or core breath and makes
  the caps static: no animation at all is drawn (§12). A running station keeps its steady halo (0.16) and the core
  its steady halo (r 27.5, width 3, opacity 0.08 at rest and 0.16 busy); the caps stay at 1.
- The halos have one opacity range for both themes: SMIL values cannot follow the media query (R16 h, §9.3).
- Image-mode SMIL moves on the desktop (§11.3, ruling A).

## 8. Data and state (T1)

The source is the existing `tool.call` hook (`hooks/register.tsx:986-1039`). It sees both main's calls and
subagents' calls:

- `e.tool`, `e.agentId` (undefined for main), and the input at the top level of `e`;
- the mod's own clock: `t0` before `next(e)`, `t1` after it;
- the outcome: `ran.isError`, `ran.deny`, and the abandoned case (an error with an aborted signal,
  `hooks/register.tsx:992`).

All new state is bounded; nothing grows with the session's length.

### 8.1 Stations

Eight, mapped as below (R7). `stationOf(tool)` is a pure, table-driven function: `mcp__*` goes to MCP, and an
unknown tool goes to Shell.

- **Model:** the model's own steps (main and subagents); no tool.
- **Files:** Read, Write, Edit, MultiEdit, NotebookEdit, Grep, Glob, LSP.
- **Shell:** Bash, PowerShell, Monitor, background-shell tools; **any tool no other row names** (lot-map's fallback).
- **Web:** WebFetch, WebSearch, Artifact, ArtifactComments, ArtifactData.
- **MCP:** every `mcp__*` tool; ListMcpResourcesTool, ReadMcpResourceTool, ReadMcpResourceDirTool.
- **Agents:** Agent, Task, Workflow, SendMessage, TaskStop, ListAgents, SubagentHandback, ScheduleWakeup, Cron*.
- **Skills:** Skill, ToolSearch; ListSkills, SearchSkills, SuggestSkills, ListPlugins, SearchPlugins,
  SuggestPluginInstall.
- **You:** AskUserQuestion, TodoWrite, TaskCreate/TaskUpdate/TaskList/TaskGet, EnterPlanMode, ExitPlanMode,
  PushNotification, SendUserFile.

### 8.2 Per station

- **`calls`:** the session's count. Model counts model steps: `turn.step` stops, for main and for subagents (today
  only main's are kept, `hooks/register.tsx:978-980`). Every other station counts its tool calls, main's and
  subagents'.
- **`failedThisTurn`:** counted since main's current `turn.start`, and reset there. A failure is a call whose Log line
  is an error with a ✗ mark: `ran.isError === true`, not denied, not abandoned, and not by an agent with no row
  (`hooks/register.tsx:1023-1030`). A denied call is not a failure, and neither is a call the engine blocked before it
  ran: an error whose `text`, or whose `result` string, starts `Blocked:` counts as a denial everywhere the hook reads
  `ran.deny` (`isDenied`; its Log outcome is `denied`). As any error, it starts no task and hands nothing back
  (0.7.1 §9).
- **`lastCallAt`** (0.7.1 §7): the time the mod saw the call's first chunk in the model's stream, or the first chunk
  of a model step for Model. A call that reaches `tool.call` with no in-flight entry (no `tool_use_id`, or one no
  chunk named) sets it to its return time, `t1`, in the write that counts it. A pulse's age is `now − lastCallAt`.
- **Running:**
  - Model: the agents now in a model step, that is, running agents (main while its turn runs, plus subagents with a
    running row) that have no call in flight. This needs an in-flight count per agent id.
  - Agents: the running subagent rows, plus the running `workflow` tasks.
  - Shell: its calls in flight, plus the running `shell` and `monitor` tasks.
  - Every other station: its calls in flight.
- In-flight counts never go below zero. They reset at session start and at a restore.

### 8.3 The turn ribbon

- The turn accumulator (the `turn` atom, `types/index.d.ts:123-139`) gains main's tool segments
  `{t0, t1, station, label, failed}`. A segment is written when its call returns, so `t1` is a number; the running
  call is the live part, drawn from `inFlight`. Its `steps: StepTiming[]` stays as it is.
- Storage keeps the latest 60 steps in detail. Older steps fold into per-station duration sums (`earlier`, Model
  included). The drawing then merges down to R14's N (§5.3).
- `PaneData` gains `turn`, and the render reads it, so step and call writes redraw the pane and the ribbon draws the
  running turn live. Today the render never reads `turn` (`hooks/register.tsx:1195-1207`), and the pane shows only
  `lastTurn`.
- At `turn.complete` (`hooks/register.tsx:1041-1066`), `lastTurn` keeps today's `TurnStats` plus the ribbon's
  segments and elapsed time, so the idle pane draws the last turn.
- The live details table runs today's `computeTurnStats` on the live accumulator: duration = now − startedAt; usage =
  the sum of the stopped steps' usage; cost = the current cost − `costAtStart`.

### 8.4 Activity

- Agents and tasks stay as they are: `startedAt | null`, `endedAt | null`, status (`types/index.d.ts:45-75`).
- An agent row gains `runs?: { start: number | null; end: number }[]` (0.7.1 §10.1): its closed earlier runs, oldest
  first, 8 at most. A revive of an ended row pushes `{ start: startedAt, end: endedAt }` and starts the current run at
  the resume time; a ninth run merges the two oldest. A row whose end is unknown pushes nothing and keeps its start; a
  row whose start is unknown pushes no run, and its current run starts at the resume time.
- New: `mainTurns`, the latest 6 main turns as `{start, end | null}`, written at main's `turn.start` and
  `turn.complete`.

### 8.5 Compactions

A new counter, plus one for each main `session.compact` (`hooks/register.tsx:1168-1181`). This is best effort:
another plugin can keep the event from the mod, as cc-plugin-sec-default does.

**A compaction the mod did not see** (0.7.1 §8). The engine drops `context.tokens` after a compaction, until the next
response. A usage reading with no tokens while `usageAtom` holds some is a compaction the mod did not see. Every
reading checks it: `refreshUsage` (the 60 s tick, the pane's start, a model change, a seen compaction's refresh),
`session.measure`, and main `turn.start`'s light `$.session.usage()` read. The decision and the clearing of the held
tokens are one `update` of `usageAtom`, so of two readings that race, only the one whose update cleared them counts:
the tick, and a Log line `compacted` with no token numbers (who `main`, kind `info`). At `turn.start` the line is at
the turn's time, under the prompt's, and a refresh follows. A seen `session.compact` clears the held tokens itself
before its refresh; `/clear` and a resume clear them first in their reset, so a reading that lands during the reset
counts nothing.

### 8.6 Restore after a reopen

`restoreFromMessages` (`hooks/restore.ts:54`) rebuilds:

- each station's `calls`, from the rows' tool uses after the latest compaction summary (the walk's existing cut,
  `hooks/restore.ts:151-155`);
- Model's count, from the assistant rows after that cut;
- `compactions`, as the number of summary rows in the whole history.

It cannot rebuild `running`, failures, `lastCallAt`, `turn`, `lastTurn` or `mainTurns`: the rows carry no timestamps
(`hooks/restore.ts:47-49`). Restored agents and tasks keep null starts, so their lanes are dashed.

### 8.7 Types

New atoms are declared in `types/index.d.ts` (`PluginState`), as today.

## 9. Rendering (T2)

### 9.1 Desktop

- The band is one `Svg`, A2 geometry: 5 rows with two rows per side, 4 rows with one (§4).
- The ribbon is one `Svg` for the bar, plus Text for the elapsed time, the legend and the details table (§5).
- Activity is one row per lane, `[Text label][Svg bar][Text value]`, plus an axis `Svg` (§6).
- At most 19 Svgs: the band, the ribbon, up to 8 legend swatches, 8 lanes and the axis (R16 c, over T2's 11; 0.7.1
  §17.9). The fallback legend draws one swatch.

### 9.2 Image mode

The Svgs are drawn without `isInteractive`. 0.7.0 ships without tooltips; each Svg's `alt` describes it, using the
alt texts of §4.9, §5.4 and §6.2. R16 b's conditional rule is settled (§11.3, ruling C-no): an interactive Svg is
mounted again on every redraw, so every Svg stays an image, with no `isInteractive` and no `<title>`.

### 9.3 Palette

Dark values go in the attributes. Light overrides go in `<style>@media (prefers-color-scheme: light){…}</style>`
inside each SVG, as lot-map does (lot-map `hooks/palette.ts:58-63`). An image's `prefers-color-scheme` follows the
app's theme (§11.3, ruling B1), so there is no `theme` setting.

### 9.4 Motion

SMIL only, no new timers, phase-locked as §7 says (as lot-map's `draw.ts:66-70`, `:184`, `:336`).

### 9.5 The `motion` setting

The plugin's first `userConfig` option: `motion: full | reduced`, default `full`. It is read from
`register(on, options)`, as lot-map does (lot-map `plugin.json:132-141`, `setup.ts:95`). `reduced` turns off the
pulses, the ripples, the beat rings and the core's breath and makes the caps static (§7, 0.7.1 §3.5).

### 9.6 Terminal

- No images. Text rows follow §4.10, §5.8 and §6.5.
- The station hues are raw hex from the dark set, as today's terminal meter passes raw hex (`hooks/view.tsx:142-147`,
  `:302`).
- The mod cannot know a terminal's background, so on a light terminal the hues look pale. That is a known limit, and
  no setting changes it (§11.3, ruling B1): the terminal always uses the dark set.

### 9.7 Budgets

- The draws are pure string builders with fixed element counts: the band ≤ 99 (core 6, the halo included, + ≤ 5
  ticks; 8 stations × (≤ 8 parts + 1 pulse group + 1 ripple); ≤ 8 lines of trunks, forks and rails; `BAND_PARTS_MAX`,
  0.7.1 §3.6), the ribbon ≤ ~131 at the widest, the lanes ≤ 9 × 6. A station's 8 parts are its halo, beat ring,
  circle, icon, `×N` badge, failure disc, label and count; the icon, the badge (its circle and text), the disc (its
  circle and text) and a pulse group (its comet and gradient) count one each, the ripple one, and the inline label
  and count of two rows a side are one `text`, so that layout has 7. The `<style>` and the animation elements are not
  counted.
- A redraw at the caps takes ≤ 2 ms in tests.
- Every Svg is ≤ 4096 px wide (`SVG_MAX_PX`, `hooks/view.tsx:88`) and its source is < 131072 characters.

## 10. Behaviour and edge cases (T3)

- **Session block.** The Context label row and the meter row go, and the band takes their place. With no context
  reading, the core shows `—`. Before any call, the stations read 0, dimmed.
- **Turn stats.**
  - A running turn draws live; when idle, the last turn draws. With no turn yet, today's placeholder stays.
  - Detailed steps: `N = clamp(floor(barPx / 20), 6, 60)` (R14). Older steps merge into per-station parts.
  - The details fold is closed by default; its key is `turnDetails`, with the inverted default (§5.6).
- **Activity.**
  - It replaces Subagents and Tasks, with the fold key `activity`. The old `agents` and `tasks` keys are ignored.
  - Values: an agent's cost in view.tsx's cost format, and a task's time.
  - Order: main first, then the running lanes with the older start first, then the ended lanes with the newer end
    first. At most 8 lanes, then `+N more`.
  - The axis runs from the oldest shown non-main start to now, and spans at least 2 minutes.
  - A resumed subagent's lane draws a bar for each closed run, with the gaps between, then its current run; it sorts
    by its first run's start while it runs and by its last span's end once ended (0.7.1 §10).
  - With no subagents and no tasks, the block is hidden.
  - The type tag follows R15.
- **Edge cases:**
  - counts ≥ 1000 read `1.2k` on the desktop, `1k` … `99k` in a terminal (§4.10);
  - on a body wider than 4096 px the band is laid out for `W = 4096` with §4's `W − 8` rule, so it is 4088 px wide,
    and centred; no station is clipped (R19);
  - running counts above 9 read `×9+`;
  - lanes past 8 go into `+N more`;
  - steps past N merge;
  - a mod reload in the middle of a call clamps and resets the in-flight counts;
  - when another plugin keeps `session.compact` from the mod, the next usage reading that finds the tokens gone counts
    it: the tick and a bare `compacted` line (§8.5). Still missed, a limit: a compaction whose next response lands
    before any reading, in practice an auto-compaction inside a running turn; the code carries it as a `shortcut:`.
    Two races are accepted: a reading taken before a seen compaction and written after its clear puts the old tokens
    back, so a later reading can count that compaction again; and a tick's reading taken after the engine drops the
    tokens can land before `session.compact`'s own clear, so the two count it twice. This is documented;
  - a call the engine blocked (its error starts `Blocked:`) is a denial, not a failure (§8.2). The rule reads the
    engine's text: a heuristic, carried as a `shortcut:` until the engine gives a field for it.

## 11. Engine facts, risks and the first task (T4)

### 11.1 Engine facts

- **SvgProps.** The text in 2.1.288 and 2.1.308 is identical; 2.1.321 was not read.
  - `source` is at most 131072 characters; `alt` is required; `width` and `height` are CSS px.
  - `isInteractive` draws "a script-less sandboxed frame so hover, CSS `:hover`, SMIL animation and `<title>`
    tooltips work". Without it the Svg is "an image".
  - Redraws happen at most 10 a second. The engine refuses an Svg wider or taller than 4096 px.
- **lot-map** (MIT) draws its desktop map in image mode, with SMIL and a `prefers-color-scheme` palette.

### 11.2 Risks

Task 1 (§11.3) turned three of the first risks into facts, and the build found one more:

- Image-mode SMIL animates on the desktop (ruling A).
- An image-mode SVG's `prefers-color-scheme` follows the app's theme (ruling B1).
- A redraw of an interactive Svg mounts it again: it jerks, and its tooltip blinks (ruling C-no).
- Chromium drops a SMIL animation whose whole interval ends before the image's time 0 (begin + dur ≤ 0), and its
  `fill="freeze"` end state is not applied (§7).

One risk stays: the compaction counter is best effort (§8.5).

### 11.3 Task 1 of the plan: a live check with the owner

In the desktop app, a throwaway mod shows:

1. an image-mode SVG with SMIL;
2. an image-mode SVG with the `prefers-color-scheme` palette;
3. an interactive SVG redrawn every second, with a phase-locked loop and a `<title>`.

The rules for each result, as planned:

- if (1) does not move, keep the static picture; the motion is decoration;
- if (2) does not follow the app's theme, add `theme: auto | dark | light`, which also picks the terminal set;
- if (3) redraws without a flicker, use `isInteractive` for the band and the ribbon, with the spec's `<title>`
  tooltips (§4.9, §5.4). Otherwise 0.7.0 ships without tooltips (R16 b).

The results and the owner's rulings (the live check with the owner, desktop 2.1.321, 2026-11-16):

- **A:** (1) moves: SMIL animates in an image Svg. The motion ships as designed.
- **B1:** (2) follows the app's theme. There is no `theme` setting; the terminal always uses the dark set (§9.6).
- **C-no:** (3) is mounted again on every redraw, so it jerks and its tooltip blinks. Every Svg stays an image: no
  `isInteractive` and no `<title>`; the alts carry what a tooltip would have said (§9.2).
- **D:** the engine makes an image Svg again on every redraw, even when its source is unchanged, so a fixed
  `begin="0s"` would restart each time. Every animation takes its `begin` from the wall clock: −(now mod period) for
  a loop, −age for a one-shot; a growth whose start state is computed from now takes none (§7).

## 12. Testing (T5)

- **Classification:** a table of every tool in R7 (§8.1); `mcp__*` goes to MCP, an unknown tool to Shell.
- **State:**
  - the counts;
  - the running rules, Model's included;
  - failures reset at main's turn start, and a denied call is not a failure;
  - turn segments: the storage cap of 60 and the merge;
  - `mainTurns`, at most 6;
  - compactions;
  - the in-flight clamp.
- **Restore:** counts and compactions from the history; dashed lanes.
- **Drawing,** at pane widths 300, 360, 496 (A2's switch to one row per side), 900 and 3400, stretched (R18):
  - the trunk lies on the ring's centre line;
  - no two text or mark boxes overlap;
  - the element counts are fixed;
  - the Svg is ≤ 4096 px wide and its source < 131072 characters;
  - the pulse and loop phases are right;
  - with `motion: reduced` there are no animations;
  - the ribbon's N follows R14.
- **Terminal:**
  - the exact 44-column strings of §4.10, §5.8 and §6.5;
  - at 40, 60, 120 and 200 columns, no row is longer than the width.
- **View:**
  - section order and folds (`activity`, and `turnDetails` closed by default);
  - row counts (§2.2). The existing exact header lists and row counts in `hooks/view.test.tsx` change
    (`hooks/view.test.tsx:532-538`, `:1033-1036`).
- **Budget:** a redraw ≤ 2 ms at the caps.
- All 606 existing tests stay green, with the expected list updates.

## 13. Release, docs and the mod rules (T6)

### 13.1 Release

- **Version:** 0.7.0, on the local branch `session-panel-0.7.0` from main 453c46d.
- **Docs:**
  - README: the new blocks, the `motion` setting, and the known limits (no tooltips, pale hues on a light terminal,
    the compaction tick, restored lanes).
  - The visual spec: new sections replacing the Context rows (base §6.2), the Turn stats table (base §6.6), and
    Subagents and Tasks (base §6.7).
  - CHANGELOG.
  - New live-check items in base §11.
- **THIRD_PARTY_NOTICES.md** gains lot-map's MIT notice (Aleksei Volodin), because the Agents, Skills and You icons
  are adapted from lot-map's and the station idea is its own.

### 13.2 The design reference page

`docs/design/session-panel-visualizations.html` is the approved mockup (R2, R6, R12 as narrowed by R13): two
columns, Today | A2 in the stretched layout, each with its terminal pane under it. It draws the worked example of
§2.3. The page itself, not the pane, has:

- controls for the pane width (`300 | 360 | 450 | 900 | Full`), the terminal width (`40 | 44 | 60 | 120`) and the
  theme;
- a clock frozen at 12:04:20, so the ribbon does not grow and the elapsed time stays `2m 14s`;
- a demo loop that replays one pulse every 2.4 s in the turn's station order, since a static page has no calls; in
  the pane, pulses fire on real calls;
- `prefers-reduced-motion`, which stops all of it, the demo loop included;
- live fold toggles, `details` included.

### 13.3 Mod rules that bind the plan

- **Hooks.** A hook only observes and returns `next(e)` unchanged; state is read and written only after `next(e)`.
- **Access.**
  - No network, no credentials, no `$.env` or `$.settings`.
  - On disk, only `$.store` `collapsed`.
  - No new `$` method; the plugin's `userConfig` options arrive through `register`'s `options`.
  - git is read-only.
- **The LOADER RULE.** No declaration in a hooks file may reuse the name of a function in that file that takes `$`.
- **Code style.** Code points are written as `\u{…}` in code. Lines are at most 120 characters.
- **Kept verbatim.** The SECRETS patterns stay as they are.

## 14. Rejected alternatives

- **The radial map** (lot-map's own form): it takes too much room in the pane (R16 j).
- **Option 1 alone** (the band and the ribbon) **or option 2 alone** (the lanes and the ribbon): the owner took both
  together, keeping Context sources (R4).
- **Six stations:** Skills and You tools had no station of their own; R7 maps every tool to one of eight.
- **Layout B** (the core as a text line over one row of eight): the ring loses its size and its compaction ticks, and
  below a ~305 px pane the station labels drop to icons and counts; dropped in round 4.
- **A1** (the core on the left): the owner picked A2 (R13).
- **The centred mode** (the pitch capped at 72 px, the group in the band's centre): the owner chose the stretched
  mode, which fills the band's width (R18).
- **The fixed 12 steps** in the ribbon: replaced by R14's N, so the detail follows the bar's width.
- **Badges beside the circles on the rail line** (to save the band's fifth row): they would cover the pulses' path.

## 15. Open questions

R17 leaves these for the live check:

1. **Weak light-theme hue pairs.** Skills/MCP (olive-gold against olive-green) and Model/Skills in the light theme.
   The fallback on record is a greener MCP (`#3f8a3a`), at the cost of moving closer to the success green. Closed by
   0.7.1 §5: Skills moved to a light tier in the dark set and a deep one in the light set.
2. **Estimated label widths.** The label rule (§4.2) uses per-character estimates. The live pane may need them tuned;
   the 2 px slot margin is the buffer.
3. **Fine-tuning the 464 px breakpoint.** One row per side starts at `W ≥ 464` (the one-row pitch reaching 48).
   Raise the 48 if one row should start on a wider pane.

Not covered by R16 or R17:

4. **You/Agents.** r3 also names You/Agents, in both themes, among the weakest pairs; R17 lists only the light-theme
   pairs above. Closed by 0.7.1 §5: You moved to a lighter tier in the dark set and a deeper one in the light set.
