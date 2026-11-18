# session-panel 0.7.1: the live check's fixes and the owner's visual picks

## 1. Status, origin, references

Date: 2026-11-18. Status: settled with the owner; not implemented. This spec writes the decisions down and checks
them against the code. It adds no decision of its own; where the code forced a choice of detail, the choice is marked
"detail" and the reason is given.

Origin:

- the live check of 0.7.0, `docs/live-check-2026-11-18-0.7.0.md`, findings 1–9 (0.7.1 does all of them);
- the owner's choices of 2026-11-18 from the mockups: section A variant V1, B V2, C V2, palette D A. The pages are in
  `.superpowers/design/2026-11-18-0.7.1/` (`mockups-1.html`, `mockups-2.html`), their generator in `mockup-src/`
  (`gen.ts`, with the forks `mods/band-v.ts` and `mods/lanes-v.ts`), the palette numbers in `palettes.md`. The folder
  is git-ignored;
- the owner's request for a legend by station and the choice E: V1, from `mockups-3.html` (generator in
  `mockup-src-e/`).

This spec is a delta against the 0.7.0 spec (`2026-11-16-session-panel-visualizations-design.md`). "0.7.0 §" points
into it; bare § points into this spec. Where this spec is silent, the 0.7.0 spec stands.

Code references are into `plugins/session-panel/` at 9a6b703 (the released 0.7.0 plus the live-check doc). Engine
type references are to two copies of the `claude-code` d.ts:

- **2.1.325**: the zstd frame at byte 362482568 of the 2.1.325 binary (the live check's engine), decompressed; line
  numbers are of that text;
- **2.1.308**: `.superpowers/engine-types/2.1.308/claude-code/index.d.ts`, on disk. The cited text is the same in both.

| § | Item | Finding | 0.7.0 sections it changes |
|---|---|---|---|
| 2 | The core breathes | 7 | §4.1, §4.6, §7, §9.7 |
| 3 | Pulses, ripples, running stations | 8 | §4.1, §4.6, §4.8, §7, §9.7 |
| 4 | Activity labels | 3, 9 | §6.2, §6.4, §6.5, §6.6 |
| 5 | Palette | 4 | §3.3, §15 |
| 6 | Restore with `claude --resume <id> "…"` | 1 | — |
| 7 | The pulse's time | 2 | §8.2 |
| 8 | A compaction another plugin hid | 5 | §4.7, §8.5, §10 |
| 9 | A call the engine blocked | 6a | §8.2 |
| 10 | A resumed subagent's runs | 6b | §6.1, §6.2, §8.4, §9.7 |
| 11 | The model after a reopen | 6c | §4.1 |
| 12 | The base spec's old meter lines | 6d | — |
| 17 | The Turn stats legend by station | the owner | §2.2, §5.1, §5.4, §5.5, §5.8, §9.1 |

## 2. The core breathes (A: V1, outside only)

### 2.1 The halo

A halo around the context ring breathes all the time. It is drawn only outside the ring: from the ring's outer edge,
r 26 (`RING_EDGE`, `hooks/band.ts:34`: r 24 plus half the 4 px stroke), out to a radius that goes 26 → 32 → 26.
Nothing is drawn inside the ring's circle.

| State | Period | Opacity | Outer radius |
|---|---|---|---|
| at rest | 4.8 s | .05 → .12 → .05 | 26 → 32 → 26 |
| busy | 1.6 s | .05 → .24 → .05 | 26 → 32 → 26 |
| `motion: reduced`, at rest | — | .08, steady | 29, steady |
| `motion: reduced`, busy | — | .16, steady | 29, steady |

- **Busy** means main's turn runs or any station runs: `isTurnRunning || some(running[id] > 0)`. `BandInput`
  (`hooks/band.ts:18-21`) gains `isTurnRunning: boolean`, which the view passes as `turn !== null`
  (`hooks/view.tsx:394-396`, where `runningOf` already takes `turn !== null`). Detail: `running` alone is not enough.
  `runningOf` (`hooks/stations.ts:105-132`) counts no Agents call in flight, and main is not counted in Model while it
  has a call in flight, so main's SendMessage to an agent with no running row reads 0 everywhere while the turn runs.
- **Colour:** `meterColor(p)` of the clamped percent, the arc's own colour (`hooks/svg.ts:27`): `BLUE` below 80,
  `AMBER` from 80, `RED` from 95. With no context reading `p` is 0, as `coreSvg` has it (`hooks/band.ts:142`), so the
  halo is `BLUE`. The colour is raw, the same in both themes, like the arc.
- **Phase:** each loop's `begin` is −(now mod period) (`loopBegin`, `hooks/svg.ts:87-89`; 0.7.0 §11.3 ruling D). A
  switch between rest and busy restarts the halo at the new period's phase; there is no cross-fade.
- **Easing:** spline `.45 0 .55 1` on both halves, keyTimes `0;0.5;1` (the mockup's `EASE`, `hooks/band.ts:38`).
- **The terminal is unchanged.**

### 2.2 Markup

The halo is the first element of the core group (`coreSvg`, `hooks/band.ts:141-164`), before the track, so the track,
the arc, the ticks, the trunk and the text all draw over it. It is an annulus: a circle with no fill whose stroke
spans r 26 to the outer radius.

```text
<circle cx="{Xc}" cy="{cy0}" r="26" fill="none" stroke="{meterColor}" stroke-width="0" opacity="0.05">
  <animate attributeName="r"            values="26;29;26"       {timing}/>
  <animate attributeName="stroke-width" values="0;6;0"          {timing}/>
  <animate attributeName="opacity"      values="0.05;{peak};0.05" {timing}/>
</circle>
{timing} = keyTimes="0;0.5;1" calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1" dur="{4.8|1.6}s"
           begin="{−(now mod period)}" repeatCount="indefinite"
```

- r and the stroke width share the timing and are linear in each other, so the inner edge, r − width/2, is 26 at
  every instant and the outer edge, r + width/2, runs 26 → 32 → 26.
- The static attributes are the resting state: r 26, width 0, opacity .05.
- `reduced`: `<circle … r="27.5" fill="none" stroke="{meterColor}" stroke-width="3" opacity="{0.08|0.16}"/>`, no
  animation: inner edge 26, outer edge 29, the halo's mid radius. Detail: the decision names the opacities; 29 is
  the mid of 26 and 32.
- **From the mockup:** V1 (`mods/band-v.ts`, `coreSvg`) draws a filled disc r 26 → 32 behind the ring, so it tinted
  the ring's inside too. 0.7.1 draws only the part of that disc outside r 26, by the owner's correction. Outside the
  ring the two are the same.

### 2.3 Clearances

- Two rows a side: the halo spans y 15.5…79.5 in the 95 px band; one row: 1…65 in the 76 px band.
- The ticks (r 27.5–31, 0.7.0 §4.7) and the trunk (26…36 from `Xc`) lie on the halo and are drawn after it. The
  tokens line's cap top is at `cy0 + 31.8`, where the halo's peak edge reaches.
- The inner stations' marks start ≥ 49.5 px from `Xc` (`40 + P/2 − 14`, P ≥ 47), clear of r 32.

### 2.4 Tests

- At rest: one halo circle in the core group, `fill="none"`, `dur="4.8s"`, opacity values `0.05;0.12;0.05`, begin =
  `loopBegin(now, 4800)`.
- Busy, both ways: one station running; and `isTurnRunning` with every count 0. Each gives `dur="1.6s"`, peak 0.24,
  begin `loopBegin(now, 1600)`.
- r values `26;29;26` and stroke-width values `0;6;0` with the same keyTimes and keySplines; no element of the core
  but the track and the arc has its area inside r 26 (nothing filled there).
- Colour: 79 % → `BLUE`, 80 % → `AMBER`, 95 % → `RED`, no reading → `BLUE`.
- `reduced`: r 27.5, width 3, opacity 0.08 at rest and 0.16 busy, no `animate`.
- The halo's box stays inside the band at both heights.

## 3. Pulses, ripples and running stations (B: V2)

### 3.1 The pulse: one dot with a tail

The three dots (`DOTS`, `hooks/band.ts:44`; `pulseSvg`, `:205-216`) become one comet, from the mockup's V2
(`mods/band-v.ts`, `pulseSvg`'s `comet` branch; `gen.ts:146`: `comet: { r: 3.5, tail: 14 }`).

```text
<g data-part="pulse" fill="{hue}">
  <linearGradient id="pulse-{station}" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="{hue}" stop-opacity="0"/><stop offset="1" stop-color="{hue}" stop-opacity="0.7"/>
  </linearGradient>
  <g opacity="0">
    <set attributeName="opacity" to="1" begin="{−age}"/>
    <animateMotion path="{route}" begin="{−age}" dur="{dur}s" keyPoints="0;1" keyTimes="0;1" calcMode="spline"
      keySplines=".2 .6 .35 1" rotate="auto" fill="freeze"/>
    <animate attributeName="opacity" from="1" to="0" dur="0.15s" begin="{−(age − dur)}" fill="freeze"/>
    <path d="M0 -2.8L-14 0L0 2.8Z" fill="url(#pulse-{station})"/><circle r="3.5"/>
  </g>
</g>
```

- The dot is r 3.5 in the station's hue. The tail is a wedge 14 px long and 5.6 px wide at the dot (`r × 0.8` each
  side), its gradient along the wedge from opacity 0 at the tip to .7 at the dot. `rotate="auto"` turns it along the
  path, so it trails on both sides.
- Route, duration rule, easing and `begin` are 0.7.0 §4.8's, unchanged (`pulseRoute`, `hooks/band.ts:186-203`).
- **Gradient id** (detail): `pulse-{station}`, one per station, unique within the band's Svg. The mockup numbered
  them with a module counter (`cometN`), which grows without bound.
- **Drawn while age < dur.** Past its travel the `<set>` (no end) would show the comet at the band's origin once the
  motion is dropped (0.7.0 §7; `hooks/band.ts:207-209`). After that the pulse group is drawn empty while the ripple's
  window lasts, as 0.7.0 draws it with no dot (`hooks/band.test.ts:146`).

### 3.2 Arrival: the flash and a ripple

- **The arrival flash stays.** V2 kept it: the fork's options never touch it (`mods/band-v.ts`, `drawBand`), so it is
  0.7.0's: the station circle's `stroke-width` 1.25 → 2.25 → 1.25 over 300 ms at `begin` −(age − dur)
  (`hooks/band.ts:304-305`).
- **New, the ripple** (`gen.ts:146`: `ripple: { grow: 8, from: 0.7, ms: 450 }`):

```text
<circle data-part="ripple" cx="{cx}" cy="{cy}" r="11" fill="none" stroke="{hue}" stroke-width="1.5" opacity="0">
  <animate attributeName="r" values="11;19" dur="0.45s" begin="{−(age − dur)}" fill="freeze"/>
  <animate attributeName="opacity" values="0.7;0" dur="0.45s" begin="{−(age − dur)}" fill="freeze"/>
</circle>
```

- The ripple goes into the pulses layer, after the rails and before every station (0.7.0 §4.1's z-order), so the
  station's opaque circle (fill `raised`, r 11, stroke to 11.75) hides its inner part: only the outside shows.
- Linear, no spline, as in the mockup. Static opacity 0 and the frozen end 0 are the resting state, so a ripple whose
  interval is over changes nothing when the engine drops it.

### 3.3 Lifetime

A pulse's parts are drawn while age < dur + 450 ms. That is 0.7.0's dur + 150 + 300 (`isDue`, `hooks/band.ts:300`),
now set by the ripple's 450 ms. Each part keeps 0.7.0's one-shot rules (0.7.0 §7):

| Part | Interval | Drawn while |
|---|---|---|
| comet travel | 0 … dur | age < dur |
| comet fade | dur … dur + 150 | with the comet |
| flash | dur … dur + 300 | age < dur + 450 |
| ripple | dur … dur + 450 | age < dur + 450 |

At most one pulse group and one ripple per station, so the element count stays fixed.

### 3.4 A running station

The breathing glow (`hooks/band.ts:225-232`; `GLOW_MS`, `:40`) goes. A running station gets
(`gen.ts:146-147`: `glow: null, steady: 0.16, beat: { grow: 10, from: 0.9, ms: 1400 }`):

- **a steady halo:** `<circle cx cy r="14" fill="{hue}" opacity="0.16"/>`, no animation;
- **a beat ring**, spreading:

```text
<circle cx="{cx}" cy="{cy}" r="11" fill="none" stroke="{hue}" stroke-width="1.5" opacity="0">
  <animate attributeName="r" values="11;21" dur="1.4s" begin="{−(now mod 1400)}" repeatCount="indefinite"/>
  <animate attributeName="opacity" values="0.9;0" dur="1.4s" begin="{−(now mod 1400)}" repeatCount="indefinite"/>
</circle>
```

- Order inside the station group: halo, beat ring, circle, icon, badge, disc, text.
- **Outside only** (the controller's ruling, by the owner's rule for the core): both lie under the station's circle,
  whose `raised` fill is opaque, so nothing of them shows inside r 11.75. No mask is needed. The beat ring starts at
  r 11 under the circle and shows from r ≈ 12.5.
- Linear, no spline, as in the mockup. A failed station that also runs keeps both, in its hue; its stroke stays
  `fail` (0.7.0 §4.6).
- **Clearances.** The ring's outer edge reaches 21.75. Circles are ≥ 47 px apart (P ≥ 47, 0.7.0 §4.3), so two
  running neighbours' rings (≤ 43.5) never touch. Two rows: row 1's ring spans 3.75…47.25, clear of row 2's badge
  top at 54.5; row 2's reaches 90.25 < 95. One row: 11.25…54.75 in 76. The ring crosses the top of its own station's
  text (cap top at `cy + 16.8`) at opacity ≤ .38.

### 3.5 `motion: reduced`

No comet, no ripple, no flash, no beat ring and no core breath. The steady station halo (.16) and the core's steady
halo (§2.1) stay. With `reduced` no `animate`, `animateMotion` or `set` is drawn anywhere in the band (0.7.0 §7).

### 3.6 Counts (0.7.0 §9.7)

`BAND_PARTS_MAX` (`hooks/band.ts:30`) goes from 82 to **99**: core 6 (the halo added) + ticks 5 + 8 stations ×
(8 parts + 1 pulse group + 1 ripple) + 8 lines.

- A station's 8 parts: halo, beat ring, circle, icon, `×N` badge, failure disc, label, count. Two rows a side draw the
  label and count as one `text`, so 7.
- The pulse group counts as one, the gradient inside it included (`bandParts`, `hooks/band.ts:104-123`). The ripple
  is a bare circle and counts one.
- Measured on the mockup's fork, worst case (all eight running ×12 and failed 12, all pulsing, 9 compactions, counts
  123456): 91 parts with two rows a side, 93 with one; the source is ≈ 26.2 k characters at 4096 px. 0.7.0 on the
  same input: 74 / 76 parts, ≈ 25.7 k. The source cap is 131072.

### 3.7 Tests

- Comet: per due pulse one `circle r="3.5"` and one wedge `M0 -2.8L-14 0L0 2.8Z` filled `url(#pulse-{station})`;
  stops at opacity 0 and 0.7; `rotate="auto"`; `begin` −age; the ids are unique in the Svg. At age ≥ dur the group
  has no comet.
- Ripple: r `11;19`, opacity `0.7;0`, `dur="0.45s"`, `begin` −(age − dur), static opacity 0; in the source before
  every `data-part="station"` group; drawn while age < dur + 450 and not at dur + 450.
- Flash: 0.7.0's values and timing (unchanged test).
- Running station: the steady halo r 14 at 0.16 with no `animate`; the beat ring r `11;21`, opacity `0.9;0`,
  `dur="1.4s"`, `begin` = `loopBegin(now, 1400)`, `repeatCount="indefinite"`; both before the station's circle in
  its group. No `0.12;0.24;0.12` glow anywhere.
- `reduced`: no `animate`, `animateMotion` or `set` (`hooks/band.test.ts:169`, extended to the halos); the steady
  halos stay.
- Every `animateMotion` drawn still runs at the image's time 0 (`hooks/band.test.ts:154`, unchanged).
- `bandParts ≤ 99` for every input and the source under the cap (`hooks/band.test.ts:177`).

## 4. Activity labels (C: V2)

### 4.1 The label column

`L = clamp(floor(cols × 0.45), 9, 64)` cells (`laneLabelCells`, `hooks/lanes.ts:75-78`; 0.7.0: × 0.3, at most 32).
`mods/lanes-v.ts` takes it as `v1Cells` (`gen.ts:226`).

### 4.2 Two sub-columns

From `L ≥ 24` (`TAG_FROM`, `hooks/lanes.ts:37`, unchanged), the column is a description sub-column, one gap cell and
a tag sub-column (`labelParts`, `gen.ts:209-225`):

- `tagW` = the most cells of the shown lanes' tags (main's tag is empty and counts 0). A tag is `@` + `shortType`
  (cut at 14 characters with `…`, `hooks/stats.ts:264-268`) or `@` + the task kind, so `tagW ≤ 15`.
- `descW = L − 1 − tagW`, so `descW ≥ 8`. Every tag starts at cell `descW + 1`, on every lane.
- Tags are never cut. 0.7.0's rule that the description gives way down to 6 cells and then the tag is cut
  (`LABEL_MIN`, `hooks/lanes.ts:38`; `:131-132`) goes.
- Below 24 there is no tag and `descW = L`. A lane with no tag (main) draws its description alone.
- Tags show from 54 columns (a body of 432 px, a pane of ≈ 464 px); in 0.7.0, from 80.

### 4.3 Description cuts

1. Every description is cut at the end to `descW` cells with `…` (`cutCells`, `hooks/cells.ts:10-13`).
2. The lanes whose description is wider than `descW` are grouped by their end-cut text. In every group of two or
   more, each description is cut in the middle instead (`middleCut`, `gen.ts:192-207`, `HEAD_MIN = 4`):
   - `room = descW − 1`;
   - `k` = the least tail length, in code points, at which the group's descriptions all differ (`k < room`);
   - `t0 = min(room − 4, max(k, floor(room / 3)))`;
   - for each description the tail is its last `t0` code points; when the tail starts inside a word, that word
     starts at most 3 code points earlier, and `room` less the tail from the word's start still leaves ≥ 4, the tail
     moves back to the word's start;
   - the text is the head (the first `room − t` code points), `…`, and the tail. The head's trailing spaces are
     dropped only while it keeps at least 4 code points; otherwise it keeps its first `room − t` code points as they
     are. Example: `Fix the X12` and `Fix the Y12` at `descW` 8 give `Fix …X12` and `Fix …Y12`.
3. Other descriptions keep the end cut. Descriptions that read the same in whole stay the same.

The live check's lanes (`gen.ts:169-177`):

| cols | L | `Band check: background sleep A` | `Write the 0.6.0 live-check doc` |
|---|---|---|---|
| 41 | 18 | `Band check…sleep A` | `Write the 0.6.0 l…` (end cut; it differs already) |
| 44 | 19 | `Band check:…sleep A` | `Write the 0.6.0 li…` |
| 52 | 23 | `Band check: bac…sleep A` | `Write the 0.6.0 live-c…` |
| 108 | 48 | whole, then `@general-purpo…` at cell 33 | whole |

### 4.4 Both surfaces

- **Terminal:** `[description, padded to descW][space][tag, dim]`, then the row as today: padding to `L + 1`, the
  bar, a space, the value (`lanesTerminal`, `hooks/lanes.ts:294-309`).
- **Desktop:** the label cell (`hooks/view.tsx:668-683`) holds a FIXED Box `descW` cells wide (overflow hidden) with
  the description, then the dim tag Text with its leading space as the gap. Below 24 it holds the description alone,
  as today. The mockup draws it so (`gen.ts:262-265`).
- `laneLabelSpans` (`hooks/lanes.ts:127-133`) needs the shown lanes to know `tagW` and the groups, so it takes them
  as an argument; one helper (the mockup's `labelParts`) feeds both surfaces. Names are the plan's.
- The alt is unchanged: the whole description and the tag (0.7.0 §6.2).

### 4.5 Widths

Body px = cols × 8. Lane area = `svgPx(bodyPx − (L + 10) × 8)`, `A` = area − 12 (0.7.0 §6.2). Terminal bar =
`cols − L − 10` cells, the axis `bar − 1`. Axis labels are §2.3's example (span 12 min, 0.7.0 §6.3).

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

- The label column's tag split assumes a 15-cell tag; with shorter tags `descW` is wider by the difference.
- Knock-on: below ≈ 54 columns the lanes are shorter than in 0.7.0. At 41 columns (a 360 px pane) the area drops
  from 152 to 104 px, and the example's axis keeps only `now`: the 10 m step's `12:00` sits 33 px from `now`, under
  0.7.0 §6.3's 36 px. At 44 columns the terminal axis row shows only `now`.
- 0.7.0 §6.2's worked geometry at 360 px becomes A = 92, 0.1278 px/s: main 0 → 24.3 (fade-in), 43.4 → 63.9, 74.9 →
  92 (6 px, cap); Review the diff 46 → 92; npm test 63.9 → 92; Plan critique dashed; Map the mask 83.2 → 86.1, ✓
  92.1; Repro check 61.3 → 69, ✗ 75; Engine facts 0 → 61.3, ✓ 67.3; dev server 15.3 → 46, ■ 52.

**44 columns** (replaces 0.7.0 §6.5's block; L 19, bar 15, axis 14 cells, 51 s a cell):

```text
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

### 4.6 Tests

- `laneLabelCells`: 33, 41, 44, 52, 54, 108, 200 → 14, 18, 19, 23, 24, 48, 64; 20, 0, −4 → 9; 143 and up → 64.
- At L 48 with `@code-reviewer`, `@shell` and `@general-purpo…`: every tag starts at cell 33 in the terminal, and on
  the desktop the description Box is 32 cells wide; tags are whole.
- No tag below L 24; main has none.
- The middle cut: the table of §4.3 at 41, 44 and 52; `Fix the X12` and `Fix the Y12` at `descW` 8 give
  `Fix …X12` and `Fix …Y12` (the head keeps its trailing space); lanes whose end cuts differ keep them; the head
  keeps ≥ 4 code points; no label is wider than L, for every L from 9 to 64.
- The 44-column strings above (`hooks/lanes.test.ts:403`; `hooks/view.test.tsx:3975`).
- Replaced: `hooks/lanes.test.ts:190-212` (0.7.0's label cells and the tag that gives way).

## 5. Palette (D: A)

Only Skills and You change, in `STATION_HUES` (`hooks/stations.ts:27-28`). The other six stay.

| Station | Dark | Light | Name | ≈ contrast on pane bg (dark / light) |
|---|---|---|---|---|
| Skills | `#f0e07f` (was `#d9c95a`) | `#695700` (was `#8c7a00`) | butter / deep olive-gold | 11.3 / 6.8 |
| You | `#eeb6fb` (was `#d48ae0`) | `#752f84` (was `#9a48b0`) | lilac / plum | 9.2 / 8.1 |

- The fix is in lightness, not hue (`palettes.md`): in the dark set the two go to a light tier (OKLCH L .90 and .85),
  in the light set to a deep one (.46 and .44). The hue order of 0.7.0 §3.3 stands (Skills ≈ 100, You ≈ 320).
- ΔE_OK, recomputed: Shell–You 0.161 dark / 0.113 light; Model–Skills 0.134 / 0.173; Skills–MCP 0.134 / 0.121;
  Agents–You 0.124 / 0.153. The weakest pair left is Files–Web, 0.091 dark, unchanged.
- The minimum contrast does not change: 6.02 (Shell) dark and 3.52 (Model) light against `palettes.md`'s
  `#1f1e1c` / `#faf9f6`; 5.5 and 3.6 against the pane bg of 0.7.0 §3.1.
- 0.7.0 §15.1 (Skills/MCP and Model/Skills in the light theme) and §15.4 (You/Agents) are closed by this.
- Colour-blind pairs that stay (Model–MCP under protanopia, Files–Web and Agents–Files under deuteranopia) are
  `palettes.md`'s, unchanged; icons, labels and alts carry the station.
- Tests: none new. No test pins the two hexes; the light rules are built from `STATION_HUES`
  (`hooks/band.ts:309-311`).

## 6. Restore with `claude --resume <id> "…"` (finding 1)

`session.start` (`hooks/register.tsx:856-872`) awaits `update(inFlightAtom)` (`:859`) before `askRestore` (`:865`).
`askRestore` (`:799-812`) relies on its reads being asked before any other await, so a first turn that lands in that
gap makes `isEmpty` read a non-empty pane, and the restore is skipped.

New order, after `const started = await next(e)`:

1. `isDue` and `isRestoreDue` as today (`:863-864`);
2. `if (isDue) askRestore($, null)`;
3. `await update($, inFlightAtom, () => ({}))`;
4. `startPane` on the first start, as today.

`restorePane` clears `inFlightAtom` itself when it restores (`:320`); step 3 still clears it for a reload in the middle
of a call when nothing is restored.

Test: in a `session.start` whose chain lets a main turn write the Log between `next(e)` resolving and the hook's next
await, the restore runs: `$.session.messages()` and the reads of `agents`, `tasks` and `log` are asked before the
first write of `inFlight`, and the restored rows are there.

## 7. The pulse's time (finding 2)

The engine has no real-start signal: `tool.call` "runs the hooks beneath, then core (the permission prompt, the tool
itself)" (2.1.325 d.ts:4264-4265; 2.1.308 :4071-4072), so the hook's `next(e)` holds both.

- **0.7.0 §8.2's `lastCallAt` reads:** the time the mod saw the call's first chunk in the model's stream
  (`markInFlight`, `hooks/register.tsx:751-766`, from `turn.step`, `:1057-1064`), or the first chunk of a model step
  for Model (`pulseModel`, `:770-775`). The pulse and the in-flight glow date from there, and a pending permission
  prompt keeps the station lit.
- **New:** a call that reaches `tool.call` with no in-flight entry (no `tool_use_id`, or none in `inFlightAtom` when
  it returns: no stream chunk the mod saw, for example another plugin's `$.tool.call`) sets its station's
  `lastCallAt` to `t1`, its return time, in the stations write that counts it (`:1098-1104`). It pulses then. The
  check reads `inFlightAtom` before that write; the entry's removal (`:1105-1111`) is unchanged.

Tests: a call whose chunk was seen keeps `lastCallAt` at the chunk's time after its `tool.call`; a call with no entry
(no `tool_use_id`, and an id never seen) gets `lastCallAt = t1`; `calls` goes up by 1 either way.

## 8. A compaction another plugin hid (finding 5)

`session.compact` (`hooks/register.tsx:1307-1321`) counts the tick, writes `compacted … → …` and refreshes the usage.
When another plugin keeps the event from the mod, none of that happens.

The signal: the engine drops `context.tokens` right after a compaction, until the next response. The types say so:
"`tokens` and `percent` … absent until the first response of the live window: a fresh session, or one just
compacted, until its next response" (2.1.325 d.ts:12232-12235; 2.1.308 :11494-11496).

**The rule.** A usage reading whose `context.tokens` is absent, while `usageAtom` holds `contextTokens`, is a
compaction the mod did not see.

**Where it runs:** on every usage reading the mod takes.

- `refreshUsage` (`:374-396`, its write `:386-390`), whatever asked for it: the 60 s tick (`:833-835`), the pane's
  start (`:827`), a model change (`:952`), a seen compaction's own refresh (`:1317`);
- `session.measure`'s write (`:946-956`, the write `:949`);
- main `turn.start`'s light `$.session.usage()` read (`:1001`), which today reads only the cost. It writes `usageAtom`
  only to clear the held tokens when it finds a compaction.

**One update.** The decision and the clearing of the held `contextTokens` and `contextPct` are one `update` of
`usageAtom`: its callback sees the held tokens and returns them cleared. The callback sets a flag on every run, as
`reviveAgent`'s does (`:702-708`), since an update runs again when its write misses. Only the caller whose update
cleared them counts, so two readings that race count once.

**The count**, by that caller:

1. `compactionsAtom` + 1 (the tick, 0.7.0 §4.7);
2. a Log line `compacted`, no token numbers: who `main`, kind `info`, at that moment. At `turn.start` it is at the
   turn's `now`, written before the turn's prompt line, so it shows under it (newest first);
3. at `turn.start` only, `inBackground(refreshUsage)`: the ring reads `—` until the next response. The other readers
   have just written the reading themselves.

No `messages()` read.

- **The seen compaction:** `session.compact` (`:1307-1321`) clears `contextTokens` and `contextPct` itself, in the
  step that counts it (`:1314`) and before its `refreshUsage` (`:1317`), so that refresh finds nothing held.
- **A fresh session's first turn does not trigger it:** `usageAtom` starts with no `contextTokens` (`:31`) and no
  response has given one. After `/clear` or a resume, `session.end` writes `contextTokens: undefined` (`:919`).
- **Still missed, a limit:** a compaction whose next response lands before any reading. In practice that is an
  auto-compaction inside a running turn: the turn's next response brings the tokens back before a reading sees them
  absent. The code carries `// shortcut: a compaction answered before any usage reading is not seen (an
  auto-compaction inside a turn); read the compaction summaries in messages() if that matters`.
- **A race, accepted:** a reading taken before a seen compaction and written after that compaction's clear puts the
  old tokens back, so a later reading can count the same compaction again; the window is the await between a reading
  and its write.

Tests:

- a hidden compaction, then the tick's refresh with no tokens: + 1 and the Log line; a main `turn.start` after it adds
  nothing;
- a hidden compaction, then a main `turn.start`: + 1, the Log line under the prompt line, and a refresh asked;
- `session.measure` with no tokens while tokens are held: + 1;
- a seen `session.compact`, then its refresh, then a tick: one count;
- a fresh session: nothing;
- a subagent's `turn.start`: nothing;
- tokens present on both sides: nothing.

## 9. A call the engine blocked (finding 6a)

Engine 2.1.325 refuses some calls before they run (`Blocked: standalone sleep 60`). The mod sees an error and draws a
red `✗` and a failed Shell. 0.7.1 counts it as a denial.

In `tool.call` (`hooks/register.tsx:1084-1164`):

```text
isBlocked = ran.isError === true &&
  (ran.text?.startsWith('Blocked:') === true || (typeof ran.result === 'string' && ran.result.startsWith('Blocked:')))
isDenied  = ran.deny !== undefined || isBlocked
```

- Every test of `ran.deny` in the hook reads `isDenied`: `isStationFailure` (`:1097`) is false, so the station has
  no failure and main's segment is not failed (`:1155-1158`); no project read (`:1119`); the Log outcome is `denied`
  (`:1147`), with a deny's kind.
- `isFailed` (`:1120`) stays true, as it is for any error: no task, no hand-back.
- The fields: on an error, `result` is "the error text, or undefined", `text` is "the error as the model reads it"
  (2.1.325 d.ts:14738-14746; 2.1.308 :13609-13614). Which one carries `Blocked:`, and whether it starts the text, is
  to be verified live (§14).
- A heuristic, marked in the code: `// shortcut: the engine marks a blocked call only by its text, \`Blocked:\`;
  verify the field live and use a deny or a reason field if the engine gives one`.

Tests: `isError` with `text: 'Blocked: standalone sleep 60'` → Shell `calls` + 1, `failedThisTurn` 0, Log outcome
`denied`, segment not failed; the same with `result: 'Blocked: …'` and no `text`; `'Error: Blocked: x'` and a plain
error stay failures.

## 10. A resumed subagent's runs (finding 6b)

### 10.1 State

`AgentRow` gains `runs?: { start: number | null; end: number }[]`: its closed earlier runs, oldest first, 8 at
most. In `types/index.d.ts:53-67` and its mirror `hooks/stats.ts:59-73`.

`reviveAgent` (`hooks/register.tsx:695-717`; called by `agent.spawn` for a resume, `:1248-1250`, and by a subagent's
step on 2.1.288, `:1045`):

- a row with `endedAt !== null` pushes `{ start: startedAt, end: endedAt }` to `runs`, and its current run starts at
  the resume time: `startedAt` = now (read before the update), `endedAt` null, status `running`;
- with 9 runs the two oldest merge into one: `{ start: runs[0].start, end: runs[1].end }`;
- a row with `endedAt === null` (a restored row that ended unseen, `hooks/restore.ts:66`) pushes nothing and keeps
  its start, as today (detail: `end` is a number by the decision);
- a row with `startedAt === null` (a restored row that ended live and was then resumed) pushes no run either. Such a
  run would draw nothing (`knownSpans`); as the first span it would also sort the lane among the unknown starts and
  keep its known current start off the axis. Its current run starts at the resume time, as for any revive. The type
  stays as it is;
- a row made by a resume with no row (`:1251-1258`) has no `runs`.

### 10.2 Lanes

- `laneModel` (`hooks/lanes.ts:95-99`): a subagent's spans are its runs, then the current run
  (`spansOf(startedAt, status === 'running' ? null : endedAt)`).
- **Order and axis use the first run's start:** both read `spans[0].start` already (`:84-85`, `:120`). The ended
  lanes' key reads `spans[0].end` (`:86`); it becomes the last span's end, `spans.at(-1)`, the lane's latest end.
- `drawLane` (`:142-187`) and `laneBar` (`:234-272`) already draw several spans (main's turns): a finished run is a
  3 px bar, the current one as its status shows, the time between runs a gap; the status mark follows the last
  span. A run with no known start draws nothing (`knownSpans`, `:136-137`); a lane with no known span keeps the
  dashed line.
- A row without `runs` (state from 0.7.0, restored rows) draws as today.
- Bound: a subagent lane draws ≤ 9 bars and a cap or a mark. No subagent span starts before the axis (its start is
  the oldest shown start), so it has no fade-in.

### 10.3 Tests

- A revive of an ended row pushes the run and moves `startedAt` to the resume time; the 9th run merges the two
  oldest; a row with `endedAt` null pushes nothing.
- A revive of a row with `startedAt` null and `endedAt` set pushes no run and starts the current run at the resume
  time; its lane sorts by that start among the known starts, and the axis reaches it.
- `laneModel`: spans = runs + current; the running lanes' order and the axis start by the first run's start; the
  ended lanes' order by the last span's end.
- `drawLane` at 360 px: one bar per run plus the current one, with the gaps; `laneBar` likewise.
- A row without `runs` draws the same source as 0.7.0.
- `register.test.ts`'s type comparison of the two `AgentRow` definitions holds.

## 11. The model after a reopen (finding 6c)

`mainModelAtom` (`hooks/register.tsx:46`) is set by the first main step (`countModelStep`, `:778-781`), so after a
reopen the core shows no model until the first response.

- At `session.start` (`:856-872`) and at the turn fallback start (`:980-985`), when `mainModelAtom` is null, read
  `$.session.model()`: "Returns the main loop's model, as `/model` shows it" (2.1.325 d.ts:2981-2984; 2.1.308
  :2843). Both run in the background (`inBackground`), after `askRestore`; a read that fails sets nothing.
- The value goes through `logText`, as a step's model does (`:1071`), and is written with `held ?? value`, so a
  step's model that landed first stands. The first main step's model overwrites it as today (`:780`).
- `coreModel` and `shortModel` (`hooks/band.ts:136-139`, `hooks/stations.ts:141-149`) draw it: a value with no
  version shows the family alone until the first step. The format is to be verified live (§14).

Tests: atom null and `model()` = `claude-opus-5-5` → the core reads `opus 5.5`; a held model is not overwritten; a
rejecting `model()` leaves null; a step's model then replaces the read one; a control character in the value is
removed.

## 12. The base spec's old meter lines (finding 6d)

In `docs/superpowers/specs/2026-10-07-session-panel-visual.md` (checked at 9a6b703):

- `:1259`, "Meters keep their alt (`Context 88.2%`, `5-hour 3%`)": `Context 88.2%` goes; the 5-hour meters stay.
- `:1266-1267`, check 1's Context bar against `88.2%`: both lines go. `:1268` then stands alone and drops its
  "Either way, ".

The other stale Context passages keep their text, and each gets a one-line note above it that the 0.7.0 spec
(`2026-11-16-session-panel-visualizations-design.md`) replaced it:

- `:991`, the empty ring and `Context` row of §6.11: replaced by 0.7.0 §4.6 ("No context reading");
- `:1210-1211`, the Context label and meter rows of §9's table: replaced by the band, 0.7.0 §4 (and §2.1, row 2);
- §8 "The Context ring" (`:1167` on, the 14 × 14 ring): replaced by the band's core, 0.7.0 §4.1.

## 13. Release and docs

- **README** (`plugins/session-panel/README.md`): the core's breath; the pulses (comet, ripple, the running station's
  halo and beat ring) and that they date from the call's chunk; the labels (the wider column, the aligned tags, the
  middle cut); the palette; a resumed subagent's lane with its runs; blocked calls drawn as denials; the Turn stats
  legend by station (§17); the missed compaction caught at the next usage reading, with its limit (§8), next to the
  compaction-tick limit (`:296-297`).
- **CHANGELOG** (`CHANGELOG.md`): a `0.7.1` entry over `0.7.0`.
- **The 0.7.0 spec**, updated in place where 0.7.1 changes it (the table in §1), with a header line naming 0.7.1.
- **`plugins/session-panel/.claude-plugin/plugin.json`**: `0.7.1`, in the release commit.
- All 740 tests stay green (the live check's count), with the updates listed in §2.4, §3.7, §4.6 and §10.3.

## 14. Live checks for 0.7.1

1. **`Blocked:`.** Make the engine block a call (`sleep 60` alone): the field that carries `Blocked:` (`text` or
   `result`) and that it starts it; the Log reads `denied`, Shell is not red.
2. **`$.session.model()`'s format** after a reopen, before the first response: what the core shows, and that the
   first step's model then replaces it.
3. **The missed-compaction signal** (§8).
   - With `session.compact` kept from the mod (cc-plugin-sec-default), `/compact`, then a prompt within 60 s; and
     again with a prompt after more than 60 s. Both: one tick and one `compacted` line.
   - A seen `/compact` (the other plugin off) counts once.
   - `/model` and `/rewind` count nothing: they must not drop the tokens.
   - Whether `session.measure` fires after `/compact`.
4. **The halo outside the ring,** both themes, at rest and busy: nothing inside the ring, the edge meets the ring.
5. **The beat ring with several stations running** (Model, Shell and Agents at once, two rows and one): calm enough?
6. **The labels at the owner's widths** (≈ 490, 836 and ≈ 2000 px, and 41, 44, 52 terminal columns): the tags on one
   x, the middle cut of the four `Band check` lanes, and that a description in the proportional desktop font is not
   clipped before its tail by its `descW` Box.
7. **The legend by station** (§17) at the owner's widths (≈ 300, 360, 490, 836 and ≈ 2000 px; 44 and 80 columns), in
   both themes: the swatches in their hues, the rows ending short of the edge, no item clipped by its row on the
   desktop (capitals are wider than a cell). While a turn runs: how often a row is added, and whether that is calm.

## 15. Risks

- **The band's source** grows little: ≈ 26.2 k of 131072 characters at the worst case measured (§3.6).
- **`BAND_PARTS_MAX`** rises to 99; the measured worst case is 93. The bound is the sum of every part at once.
- **The redraw budget, 2 ms** (0.7.0 §9.7; `hooks/band.test.ts:318`, `hooks/view.test.tsx:4222`): the band adds a
  halo, 8 ripples and 8 beat rings at most, and the labels add the middle cut over ≤ 8 lanes. Both are small, but
  the budget tests must pass at the caps.
- **The missed-compaction check** (§8) still misses a compaction inside a running turn, whose next response lands
  before any reading. A reading from before a seen compaction, written after its clear, can let a later reading count
  that compaction again; the window is the await between a reading and its write.
- **The `Blocked:` heuristic** (§9) depends on the engine's text.
- **Narrow panes lose lane length** (§4.5): at 360 px the lane area drops from 152 to 104 px and the axis shows only
  `now`.

## 16. Noted, not in 0.7.1

- `markInFlight` writes `lastCallAt` after its in-flight write whether or not the call is done (`:765`). A chunk
  whose `markInFlight` lands after the call's `tool.call` can pulse the station a second time. Rare: a tool runs only
  after its step's stream has sent the whole call.
- The ribbon's `bar` and the lanes' `fade0` ids repeat across Svgs (the live check's mobile-web note); the band's new
  `pulse-{station}` ids are unique within the band but not across panes.
- The base spec's other stale Context passages keep their text under a note (§12); rewriting them is not in 0.7.1.

## 17. The Turn stats legend by station (E: V1)

The owner: "Под полосой сделать более подробную расшифровку с цветами, сейчас там только Model, остальное в Tools".
The choice: "E: V1, в строку", from `.superpowers/design/2026-11-18-0.7.1/mockups-3.html`; its generator is
`mockup-src-e/gen.ts` (`v1Items`, `wrapItems`, `share`).

### 17.1 Items

- **Model** first, always. Then each tool station whose time in the shown turn is above 0, in station order (Files,
  Shell, Web, Agents, MCP, Skills, You). Then `N steps` and `TTFT x`, as today (`legendItems`,
  `hooks/ribbon.ts:306-327`): `steps` with its singular, `TTFT` only when `ttftMs` is known.
- No failure mark: the bar's underline and the alt carry it.
- A station item is its label and ` NN%`. A share above 0 that rounds to 0 prints `<1%`.

### 17.2 A station's time and the total

A station's time is the time the bar draws in its hue, summed over the parts of `rowsOf` (`hooks/ribbon.ts:95-129`)
with every stored step in detail, that is `piecesOf(head, rows, 0, live)` (`:135-143`):

- `head`: the turn's `earlier` (steps folded past the 60 stored, `addStep`, `hooks/stats.ts:198-220`) plus the calls
  before the first stored step, each call to its own station: the bar's merged earlier block;
- each stored step: its model part to Model; its tool group, one part from the first call's start to the last call's
  end, to the station of the call that started first (`:110-119`), as the bar colours it;
- the running part (`live`, `ribbonFromAcc`, `:43-54`) to its station, as `withLive` (`:57-67`) counts it.

Detail: `ribbonSegments` (`:226-240`) and `ribbonTerminal` (`:333-375`) merge more steps into the earlier block when
the bar is short (`addSpent`, `:131-133`, counts each call to its own station). The legend does not follow that merge,
so it does not change with the pane's width. The two differ only in the parallel calls of the merged steps.

**The total.** Today's shares (`pctOf`, `:242-245`) are of `modelMs + toolMs` after `withLive`. The station times do
not always sum to that:

- Model's time is the same: every step is in `earlier.model` or a stored step's part.
- `toolMs` is the union of main's call intervals (`mergedLength`, `hooks/stats.ts:108`, `:170`). The parts' tool time
  is never less: a step's group spans the gaps between its calls, and the folded and pre-step calls count each call
  whole, overlaps twice. They are equal when each step's calls make one unbroken interval and no overlapping calls are
  folded: one call a step, or parallel calls that run together (the usual case, and §2.3's example).

By the rule that the legend explains the bar, **the shares are of the sum of the station times** (the parts' total).
They then add up to 100 but for rounding, and each matches its colour in the bar. `pctOf` stays for the fallback
(§17.6). The details table's `Tool time` stays `toolMs`.

### 17.3 The desktop

One Box row per legend row (`alignItems="center"`). A station item: today's swatch (an Svg 8 × 8, rx 1.5, in the
station's dark hue with its light rule, in a FIXED 1-cell slot; `SWATCH_PX`, `hooks/view.tsx:110`), a 1-cell gap, the
label dim, then ` NN%` primary. `N steps` primary; `TTFT` dim and its value primary. Between items a dim ` · `. Edge
spaces are no-break, as `legendItems` does today (`:325-326`).

- One fixed swatch source per station, built once at load from `STATION_HUES`, in place of the Model-only
  `SWATCH_SVG` (`hooks/view.tsx:168-172`). Its alt is the station's label (`Model`, `Files`, …).
- A row ends short of the pane's edge, because the text is narrower than its cells. Accepted.

### 17.4 The terminal

The label in the station's dark hue (as today's `Model`), the value primary, a dim ` · ` between items. No glyph.

### 17.5 Wrapping, both surfaces

- Whole items in order; an item joins the row when the row's cells plus ` · ` (3) plus the item's cells fit `cols`,
  else it starts the next row (`wrapItems`, `gen.ts:121-139`). A row neither starts nor ends with a separator.
- Cells: a code point a cell; on the desktop a station item adds 2 for its swatch slot and gap.
- An item wider than a whole row is cut to it with `…` (to `cols − 2` after a swatch on the desktop), so a tiny pane
  never overflows; below the narrowest item every item takes a row of its own.
- 0.7.0's narrow rules go (`hooks/ribbon.ts:314-324`: `TTFT` below 36 desktop or 44 terminal cells, `steps` below 30
  or 34, and the terminal's dropping of items): every item shows, and wraps.
- While a turn runs, a station joins when it is first used, and a row is added only when the items no longer fit.

### 17.6 No parts known: the fallback

`turnShown` (`hooks/view.tsx:571-585`) has three paths:

1. a running turn: `ribbonFromAcc` on the accumulator. It always has parts (at least the live part), so it never
   falls back, though its stats come from `computeTurnStats`, which sets `ribbon: null` (`hooks/stats.ts:185`);
2. a last turn with a ribbon: every last turn since 0.7.0, whose `turn.complete` writes `ribbon: ribbonOf(acc, now)`
   (`hooks/register.tsx:1198`). Per-station;
3. a last turn with no ribbon: the empty stand-in (`hooks/view.tsx:579-581`). Only a `lastTurn` written by 0.6.1 and
   kept by a hot reload reaches it: a restore never writes `lastTurn` (0.7.0 §8.6). This is the fallback.

The fallback is today's items: `Model NN%` (with the Model swatch on the desktop) and `Tools NN%`, by `pctOf`, then
`N steps` and `TTFT x`, wrapped as §17.5. Its alt is today's.

### 17.7 The alt

The ribbon's alt (`hooks/ribbon.ts:298-302`) lists the stations as the legend does, the labels in lower case:

```text
Turn 2m 14s: model 58%, files <1%, shell 23%, agents 17%, mcp 2%, you <1%, 6 steps, 1 failed call
```

### 17.8 The height budget

`section` (`hooks/view.tsx:364-380`) counts one row per body element unless the caller passes `contentRows`; the MCP
chips pass `chipRows` (`:724-740`, `:768`) because the layout engine wraps them. The legend is wrapped by the mod, so
`turnSection` (`:590-651`) pushes one element per legend row, and the default count is exact: Turn stats takes
rule + header + bar + legend rows + details (+ the open table). No estimate is needed; the Log's budget
(`logLinesFit`, `:804`; the sum of the blocks' rows, `:943`) takes it as it is. A desktop row that the text overruns is
clipped by its Box, not wrapped, so it never adds a row.

Knock-on to 0.7.0 §2.2 (the example, Log at 8 lines): Turn stats is 8 rows at 300 px (4 legend rows), 7 at 360 px
(3), 5 at 900 px (1), 7 in a 44-column terminal (3); the totals become 53, 52, 49 and 50.

### 17.9 The Svg count

0.7.0 §9.1's "at most 12" (R16 c) becomes at most 19: the band, the ribbon, up to 8 legend swatches, 8 lanes and the
axis. The fallback draws one swatch.

### 17.10 Strings

§2.3's example turn (Model 78 s, Files 0.4 s, Shell 31 s, Agents 22.3 s, You 0.2 s, MCP 2.1 s; 6 steps; TTFT 1.2s).
On the desktop `■ ` stands for the swatch slot and its gap (2 cells); the cells in brackets are the row's count.

Desktop, 33 cells (a 300 px pane):

```text
■ Model 58% · ■ Files <1%                [25]
■ Shell 23% · ■ Agents 17%               [26]
■ MCP 2% · ■ You <1% · 6 steps           [30]
TTFT 1.2s                                [9]
```

Desktop, 41 cells (360 px):

```text
■ Model 58% · ■ Files <1% · ■ Shell 23%  [39]
■ Agents 17% · ■ MCP 2% · ■ You <1%      [35]
6 steps · TTFT 1.2s                      [19]
```

Desktop, 56 cells:

```text
■ Model 58% · ■ Files <1% · ■ Shell 23% · ■ Agents 17%  [54]
■ MCP 2% · ■ You <1% · 6 steps · TTFT 1.2s              [42]
```

Terminal, 44 columns:

```text
Model 58% · Files <1% · Shell 23%
Agents 17% · MCP 2% · You <1% · 6 steps
TTFT 1.2s
```

Terminal, 80 columns:

```text
Model 58% · Files <1% · Shell 23% · Agents 17% · MCP 2% · You <1% · 6 steps
TTFT 1.2s
```

The mockup's Turn 2 (`gen.ts:61`: Model 4 s, 6 s, 5 s; Files 0.3 s and 1.2 s; TTFT 0.9s): desktop 33 cells
`■ Model 91% · ■ Files 9%` and `3 steps · TTFT 0.9s`; 41 cells `■ Model 91% · ■ Files 9% · 3 steps` and
`TTFT 0.9s`; 56 cells one row `■ Model 91% · ■ Files 9% · 3 steps · TTFT 0.9s`; terminal 44 and 80 one row
`Model 91% · Files 9% · 3 steps · TTFT 0.9s`.

### 17.11 Tests

- Items and order: Model first; only stations with time; station order; then steps and TTFT; no TTFT when unknown.
- `<1%` for a share above 0 that rounds to 0; `0%` never printed for a shown tool station.
- Station times against the bar's parts: a turn past 60 steps (its `earlier`), a step with parallel calls in two
  stations (the first-started one's hue), a step with sequential calls and a gap, and a running turn's live part in
  Model and in a tool station; the shares are of their sum.
- Wrapping: §17.10's rows; no row starts or ends with ` · `; no terminal row wider than `cols` at 0, 8, 20, 39, 44
  and 80; an item wider than the row cut with `…`.
- Desktop: one swatch per station item, its alt the station's label; one swatch source per station, the same string
  across draws.
- The Svg count at the caps: `hooks/view.test.tsx:4114` ("at most 12 drawing Svgs at the caps") becomes 19, with 8
  swatches told by their alts.
- The fallback: a `lastTurn` with no `ribbon` draws `Model` and `Tools` with `pctOf`, one swatch and today's alt; a
  running turn and a last turn with a ribbon never do.
- The alt of §17.7.
- Replaced: `hooks/ribbon.test.ts:331` ("the legend and its narrow rules") and `:249` ("the alt"); the row counts in
  `hooks/view.test.tsx` that count Turn stats as 5 rows.

### 17.12 The 0.7.0 sections it changes

§5.4's legend row, §5.5's legend line (the narrow rules go), §5.8 row 2, §9.1 and R16 c (§17.9); also §2.2's row
counts (§17.8) and §5.1's "Five rows".
