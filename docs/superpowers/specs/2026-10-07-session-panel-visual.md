# Session Panel: visual spec v2

> Changes after the approved preview: every Svg carries a non-empty alt (§5.2, §11); the subagent `@type` sits in a
> column of its own (§6.7); the log's `who` column is 13 cells on the desktop; in a narrow pane the log drops `who`
> first and a subagent row drops `@type` below 12 description cells (§6.7, §6.10); the project is a block of its own,
> with a changes row (§6.3); a count that is only a lower bound has a plus, but a lower bound of no lines has no numbers
> (§6.3); in a narrow log a prompt reads `you › …` and an engine message `engine › …` (§6.10); the Log fills the pane's
> free height, 8 lines at least (§6.12); the rule above a section is one line high, with no margins (§5.1); the Log's
> header counts every event, and a dim `+N more` line counts the ones it does not draw (§6.12); the Tasks section lists
> the background tasks after the Subagents, in rows built as theirs are (§6.7). The HTML preview
> `docs/design/session-panel-preview.html` stays the approved v2 mock-up and predates these changes.

Date: 2026-10-07. Status: implemented and shipped (0.5.1). The user approved the look in
`docs/design/session-panel-preview.html` before implementation.

Scope: presentation only. The sections, their content, the formats and every formula of `2026-10-07-session-panel-design.md` §3–§4 stay as they are. Where the two specs differ on looks, this one replaces §3.1 of the main spec. Engine 2.1.288. "d.ts" below means `plugin-authoring/types/claude-code.d.ts` of that engine, cited by line.

## 1. Decisions at a glance

1. **Block separation.** Blocks are separated the OpenChamber way:
   - a 1 px rule, centred in a box one text line high, so it has room above and below it;
   - then a header row: line icon, **bold title**, dim chevron, and a dim summary pushed to the right.
2. **No row can outgrow the pane.** Every row is built from fixed cells (`flexShrink={0}`, width in cells) and at most two flexible cells (`flexShrink={1}` + `minWidth={0}` + `overflow="hidden"`, text `wrap="truncate"`).
3. **Columns that must line up have fixed cell widths:** time, who, log outcome, status mark, subagent `@type`, task
   `@kind`, cost, task time, percent and limit label. Nothing is aligned by character count.
4. **Icons.** 14 px line icons share one neutral grey, `#8a8a8a`, readable on dark and light. The Context ring draws
   the percent in the meter's colours. The status icons of both lists, the Subagents and the Tasks, are shape-coded.
5. **The top block is a header card:**
   - Session and the total;
   - Context with its ring and `tokens / window`;
   - a meter row ending in the percent;
   - the cost split.
6. **The Project block follows it, as in OpenChamber:**
   - a rule, then the bold `Project` with the folder name, dim, at the right;
   - the branch;
   - the changes of the working tree: the number of files, and at the right the lines added and removed;
   - it never folds, so its header has no icon and no chevron.
7. **The terminal draws the same tree without any `Svg`:** text rules, `▰▱` meters, glyph marks and the `🌿`/`📝` lines.

```text
Session                                           $148.59
◔  Context                                    529k / 600k
▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▭▭▭▭▭       88.2%
Session $123.23 · Subagents $25.36
──────────────────────────────────────────────────────────
Project                                        claude_mods
⑂  main
✎  12 files changed                           +2061 / −111
──────────────────────────────────────────────────────────    one line high · 1 px rule centred
▥  Turn stats ▾                                  ~72 tok/s
Whole turn                                       ~72 tok/s
Elapsed                                             1m 18s
…
──────────────────────────────────────────────────────────
☐  Subagents ▾                                         1/6
◑  Implement Task 5: README and cle… @minimal-change  $0.77
✓  Re-review Task 4 fix round 1 @code-reviewer        $1.93
…
──────────────────────────────────────────────────────────
≡  Log ▾                                               137
22:09:07  minimal-change  Edit .claude-plugin/mar…  ✓ 0.3s
```

## 2. Ground rules

### 2.1 Units: cells, and what a cell is on the desktop

- **Box numbers are character cells** (BoxProps, d.ts l.741–830).
- **On a remote surface, a cell comes from the code font:** "the pane's width and height over the advance and line height of its code font" (RenderViewport, l.9698–9704). `props.bodyColumns` is "Cells across the body, inside the frame" (l.9646–9649).
- **Measured on the live desktop (`current-pane-v1.png`), 1 cell = 8 px** wide, and a margin cell is about 8 px tall:
  - `width={8}` + `columnGap={1}` put the meter 72 px from the left edge;
  - `width={1}` + `columnGap={1}` put the subagent descriptions 16 px in;
  - `marginTop={1}` adds about 8 px over the 19 px line.
- **A height cell is one text line,** about 19 px, and `props.scroll.bodyRows` counts text lines: `height={10}` is 10
  lines tall (measured live in the spikes of §6.12). So the 8 px is the width of a cell, not the unit of `height`, and
  a rule built from margins is not a whole line: two margins and the 1 px line were 17 px. The rule is a Box of
  `height={1}` instead (§5.1).
- **The old "12.5 px per column" was a planning guess.** v1 cannot refute it, because its meter is clamped at 180 px either way.
- **`CELL_PX = 8`** is used only to turn `bodyColumns` into the px widths of the meters. Confirmed on the live pane on 2026-10-07 (§11, check 1).
- **`Svg` `width` and `height` are CSS px** (l.11588–11595).

### 2.2 Surfaces

`renderPane` already drops the terminal's stub `Svg` (`Svg` is `undefined` there). In this spec, "desktop" means `d.ui.Svg !== undefined` and "terminal" means the rest. The desktop element table has `Svg` (l.3616–3627); the terminal table has none (l.3595–3615). §9 lists what the terminal draws instead.

### 2.3 The no-overflow rule

**This rule fixes the subagent and log rows that ran past the pane.** A flex item cannot shrink below its content width unless its `minWidth` is 0. v1 never set it, so its "truncating" boxes never shrank.

Every horizontal row is `<Box flexDirection="row">`, and each child is one of two kinds:

| Kind | Props | Holds |
|---|---|---|
| FIXED | `flexShrink={0}`; `width={n}` in cells when it is a column | icons, titles, values, percents, costs, times, the `who` column, the subagent `@type` column, the log's outcome column |
| FLEX | `flexShrink={1}` `minWidth={0}` `overflow="hidden"` (l.798, l.808, l.828); `flexGrow={1}` when it must take the remaining room | exactly one `Text wrap="truncate"` (l.11886) |

- A `Text` that may be cut is never a direct child of a row. It sits alone in a FLEX `Box`.
- No `Text` in the pane wraps to a second line.
- `flexShrink` is 0 or 1 everywhere.

### 2.4 Proportional font

The desktop draws text in the system font, so character counts and padded strings drift. Rules:

- Columns that must line up get a fixed width in cells, with slack for the font.
- Label/value pairs use `justifyContent="space-between"`.
- A value pushed to the right edge sits in a FLEX `Box` with `flexGrow={1}` and `justifyContent="flex-end"`.

### 2.5 Props used, and how sure we are of them

| Status | Props |
|---|---|
| Seen working on the live desktop (v1) | theme keys `success`, `warning`, `error`; `dimColor`; raw hex; `bold`; `Svg` images; a `plain` `Button` drawn as a text row; Box `width`, `columnGap`, `marginTop`, `justifyContent` |
| Declared in the d.ts, first used here | `minWidth`, `overflow`, `flexGrow`, `alignItems`, `paddingLeft`, `flexWrap` |
| Declared in the d.ts, first used here (a Button) | `dimColor` (l.937–941) |
| Seen working live, vertical use (§6.12) | `minHeight`, `height={0}`, `flexGrow`, `flexShrink`, `overflow="hidden"` |
| Seen not working live (§6.12) | `height="100%"` on the root: it grows to its content |
| Deliberately not used | `backgroundColor`, `borderStyle`, `borderColor` (§12) |

No `key` on list Boxes. On a `Box`, `key` makes a hover scope (l.742–750), and v1 does not use it either. Button keys stay `toggle:<SectionId>`.

## 3. Tokens

### 3.1 Colour

Text uses theme keys, so it follows the app's theme (TextProps: "Colors are a theme key or a raw color", l.11867).

| Role | Prop | Where |
|---|---|---|
| Primary | none | titles, labels, values, descriptions, names, log text, the total |
| Secondary | `dimColor` | header summaries, the cost split, `tokens / window`, `@type`, time, `who`, countdowns, `+N more`, empty-state text, `—`, the folder name of the Project header, the `/` between the lines added and removed |
| Threshold | `color="warning"` from 80 %, `color="error"` from 95 % | context and limit percents (unchanged) |
| Good | `color="success"` | Cache from 50 % (unchanged); the MCP dot; the lines added, `+A` |
| Error | `color="error"` | `who` of a log entry of kind `error`, and its text when the log row has neither `who` nor an outcome cell (§6.10); the lines removed, `−D` |

SVG is drawn as an image (l.11570–11577), so its colours are raw and the same in both themes:

| Token | Value | Where | On dark `#262624` | On white |
|---|---|---|---|---|
| `BLUE` | `#2f7de1` | meter fill < 80 %, ring arc < 80 %, running icon | 3.7:1 | 4.1:1 |
| `AMBER` | `#e0a030` | meter fill and ring arc from 80 % | 6.7:1 | 2.3:1 (see §10) |
| `RED` | `#e5484d` | meter fill and ring arc from 95 %, failed icon | 3.9:1 | 3.9:1 |
| `TRACK` | `#808080`, opacity 0.3 | meter track, ring track | ≈ `#414140` | ≈ `#d9d9d9` |
| `RULE` | `#808080`, opacity 0.35 | the divider | ≈ `#454544` | ≈ `#d3d3d3` |
| `NEUTRAL` | `#8a8a8a` | section and row icons, stopped icon | 4.4:1 | 3.4:1 |
| `GREEN` | `#2ea043` | done icon (a theme key cannot reach an SVG) | 4.5:1 | 3.4:1 |

The meter colours and the track are the user's fixed rules (Desktop Statusline) and do not change.

### 3.2 Type

TextProps has no size or family (l.11869–11887). The hierarchy comes from three levels, spacing and icons:

| Level | Props | Used by |
|---|---|---|
| Title | `bold` | `Session`, `Project`, the seven section titles. Nothing else is bold. |
| Primary | none | everything a person reads for a value |
| Secondary | `dimColor` | everything that explains a value |

### 3.3 Spacing (cells; desktop px in brackets)

| Token | Cells | Use |
|---|---|---|
| `GAP` | 1 (8 px) | icon slot → text; between the columns of a log, subagent or limit row; title → chevron; meter → percent |
| `GAP_WIDE` | 2 (16 px) | the least room between a label and its value in space-between rows; between MCP chips |
| rule height | 1 (a text line, ~19 px) | the Box of each divider, the 1 px line centred in it (desktop only) |
| row gap | 0 | rows stack at the text line (~19 px on the desktop) |

Rhythm on the desktop:

- rows inside a block are 19 px apart;
- between blocks there is the rule: one text line (about 19 px) with the 1 px line in the middle of it, so the last row
  of a block and the next header are about 38 px apart instead of 19.

### 3.4 Sizes and constants (drop-in for view.tsx)

```ts
// Layout is in cells, the unit of Box numbers. On the desktop a cell is CELL_PX wide, measured on the live pane (§2.1).
// It is used only to turn `bodyColumns` into the px of the meters; confirmed on the live pane on 2026-10-07 (§11,
// check 1).
const CELL_PX = 8
const ICON_PX = 14 // every icon, in CSS px
const ICON_CELLS = 2 // the slot an icon sits in: the text after it starts 3 cells in
const PCT_CELLS = 6 // `100.0%`
const LIMIT_LABEL_CELLS = 7 // `5-hour`, `Weekly`, `Spend`
const LIMIT_PCT_CELLS = 5 // `100%`
const COST_CELLS = 7 // `$148.59`, `<$0.001`
// A time from 100 hours on takes 8 cells (`100h 00m`), the widest this cell holds. A time of 1000 hours or more
// (`1000h 00m`) would overflow it, and taskTime draws it as not known; a cost of $1000 or more overflows COST_CELLS.
// The `≤` of a bound takes a cell of its own, so `≤99h 59m` is the widest bound the cell holds, and `≤100h 00m` is
// drawn as not known.
const TASK_TIME_CELLS = 8
const TIME_CELLS = 8 // `22:09:07`
// The desktop widths of an agent type are measured on the live pane, in the app's own font. In the log,
// `minimal-change` takes about 96 px: 13 cells (104 px) keep it whole. In a subagent row the widest `@type` is a cut
// one, `@frontend-deve…` or `@minimal-chang…`, about 111 px: 15 cells (120 px) keep it whole, with a margin.
const WHO_CELLS = 13 // desktop: the `who` of the log
const WHO_CELLS_MAX = TYPE_MAX // terminal: the longest `who` that shortType keeps
const TYPE_CELLS = 15 // desktop: the `@type` of a subagent
const TYPE_CELLS_MAX = TYPE_MAX + 1 // terminal: the `@` and the longest type that shortType keeps
// The width of a task's `@kind` is an estimate, not a measure: the widest, `@workflow`, is 9 characters, and the 111 px
// of the 15 in `@frontend-deve…` make about 7.4 px a character, so about 66 px. 10 cells (80 px) keep it whole, with a
// margin. The live check of the release measures it. The terminal's column is the longest kind drawn, up to this.
const TASK_TYPE_CELLS = 10 // desktop: the `@kind` of a task
const TEXT_METER_CELLS = 10
// The engine refuses an Svg whose width or height prop is above this (2.1.288: "Svg width and height are pixels, at
// most 4096"), and a refused tree makes it draw its own pane in place of this one. A pane wider than this (a 32:9
// monitor at 100 % scale) gets a rule that ends short of its right edge, and meters that stop short: a gap before the
// percent of the context meter, and before the countdown of a limit meter.
const SVG_MAX_PX = 4096
const RULE_PX = SVG_MAX_PX // the divider image; the Box around it cuts it to the pane
// The rows that the Subagents and the Tasks show each; the rest of a list is counted in a line after its rows.
const MAX_AGENT_ROWS = 8
// The Log keeps at least this many lines, and when they do not fit the pane scrolls (the user's decision, 2026-10-08),
// as the Subagents list shows up to 8.
const MIN_LOG_ROWS = 8
// The lines the Log draws where the body's height is not known; where it is, logLinesFit works them out.
const MAX_LOG_ROWS = 15
// The rows a rule and a section header take in the body: one each, on the desktop as in the terminal (measured live:
// the icon, the chevron and the summary share the line of the title). The builders of the blocks count their rows with
// these, and the Log works out from the count how many of its lines fit. Both are in the 0.4.0 spec, §8.1 and §3.2
// (docs/superpowers/specs/2026-10-12-session-panel-v2-design.md).
const RULE_ROWS = 1
const HEADER_ROWS = 1
// The chips of MCP are this far apart (the `columnGap` of their Box), and chipRows keeps this many cells of a line
// free.
const CHIP_GAP_CELLS = 2
const CHIP_MARGIN_CELLS = 2
// The cells of an ASCII capital in a chip name where the font is proportional: the desktop's 9 to 11 px against CELL_PX
const WIDE_CAPITAL_CELLS = 1.5
const MIN_LOG_TEXT_CELLS = 8 // the least text a log line keeps: below it `who` gives way, then the outcome column
// In a narrow pane the identity column gives way first, as in the log: a subagent row or a task row leaves out its `@…`
// tag (the `@type` of a subagent, the `@kind` of a task), on every row of its list, when the description would keep
// fewer cells than this beside it.
const MIN_AGENT_DESC_CELLS = 12
const LOG_GAP_CELLS = 1 // the gap between the cells of a log row
const AGENT_GAP_CELLS = 1 // the gap between the cells of a subagent or task row, and between those of its group
const AGENT_ROW_GAPS = 3 // the gaps of such a row that has its tag: two between its cells, one in its group
const TEXT_MARK_CELLS = 1 // the mark of such a row where there is no icon slot
```

An excerpt of `view.tsx`, abridged where it says `in renderPane`: `Draw` gains the body's width and rows (`rows` is 0
where the height is not known, §6.12) and the two meter widths, and loses `meterPx`:

```ts
type Draw = {
  ui: Kit
  data: PaneData
  handlers: PaneHandlers
  cols: number
  rows: number
  contextMeterPx: number
  limitMeterPx: number
}

// in renderPane:
const cols = props.bodyColumns
const bodyRows = props.scroll?.bodyRows
const d: Draw = { ui: { Box, Text, Button, Svg }, data, handlers, cols,
  rows: Number.isFinite(bodyRows) && bodyRows > 0 ? bodyRows : 0,
  contextMeterPx: contextMeterWidth(cols), limitMeterPx: limitMeterWidth(cols) }
```

## 4. Pane skeleton

```tsx
  const blocks = [
    topBlock(d), projectBlock(d), usageSection(d), turnSection(d), agentsSection(d), tasksSection(d), mcpSection(d),
    sourcesSection(d),
  ]
  const above = blocks.reduce((sum, block) => sum + block.rows, 0)

  return (
    <Box flexDirection="column" minHeight={d.rows > 0 ? d.rows : undefined}>
      {blocks.flatMap(block => (block.tree === null ? [] : [block.tree]))}
      {logParts(d, above)}
    </Box>
  )
```

The Session card and the Project block never fold. The card has no rule above it; every other block begins with its own rule, so a block that is left out leaves no double rule.

The root is at least as tall as the body (`minHeight`), and the Log, which comes last, takes the rest of it (§6.12). A
body whose rows are not a positive number has no known height, and the root has no minimum then.

The pane frame (title "Session", expand and close controls, outer padding, scroll) belongs to the app and is not ours.

## 5. Shared pieces

### 5.1 Divider

An excerpt of `view.tsx`: `RULE_SVG` and `divider`, which are apart there.

```tsx
const RULE_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${RULE_PX}" height="1" viewBox="0 0 ${RULE_PX} 1"` +
  ` preserveAspectRatio="none"><rect width="${RULE_PX}" height="1" fill="#808080" fill-opacity="0.35"/></svg>`

// The rule above a section: an image in a Box one line high, with the line centred in it, and the Box cuts the image to
// the pane. A desktop `height` cell is one text line (about 19 px) but a margin of 1 is about 8 px, so a rule built
// from margins was not a whole line, and the Log's tail lost the difference. The terminal draws a text rule, one row,
// as v1's blank line was. The desktop draws no Svg whose alt is empty, so the rule says `rule`.
function divider(d: Draw): RenderElement {
  const { Box, Text, Svg } = d.ui
  if (Svg === undefined) return <Text dimColor wrap="truncate">{'─'.repeat(Math.max(0, d.cols))}</Text>

  return (
    <Box flexDirection="row" height={1} alignItems="center" overflow="hidden">
      <Svg source={RULE_SVG} alt="rule" width={RULE_PX} height={1} />
    </Box>
  )
}
```

How the rule gets the exact pane width:

- The line is as wide as the engine lets an Svg be, 4096 px (`SVG_MAX_PX`, §12 item 8), wider than a pane maximized on a
  21:9 monitor (about 3100 px), and its `overflow="hidden"` Box cuts it at the body's edge. No px estimate is involved.
  A pane wider than 4096 px (a 32:9 monitor at 100 % scale) gets a rule that ends short of its right edge. Until 0.4.3
  the line was 1600 px, and on a 21:9 monitor the rules ended mid-pane (the user's check, 2026-10-14).
- A plain line has no caps, so the cut is invisible.
- v1 already showed that the body clips content running past it, without widening the pane.
- `preserveAspectRatio="none"` keeps the line 1 px tall if the surface scales an image down to its slot (l.11588–11590).

How the rule gets its height:

- The Box is one line high (`height={1}`) and the line is centred in it (`alignItems="center"`). On the desktop a height
  cell is one text line, about 19 px (§2.1), so the rule is a whole line, with room above and below the 1 px line.
- The rule has no margins. A margin of 1 is about 8 px, so a rule of two margins and the 1 px line was 17 px, not a
  whole line, and each one cut 2 px off the Log's last line (§6.12).

### 5.2 Icon slot

```tsx
// A 14 px icon in a 2-cell slot, so the text after it starts at 3 cells on every row that has one. The desktop draws no
// Svg whose alt is empty (the validator accepts it, the image is dropped and its slot stays), so a decorative icon
// carries the label of its row. A surface with no Svg draws no slot at all.
function iconSlot(d: Draw, source: string, alt: string): RenderElement | null {
  const { Box, Svg } = d.ui
  if (Svg === undefined) return null

  return (
    <Box flexDirection="row" width={ICON_CELLS} flexShrink={0} alignItems="center">
      <Svg source={source} alt={alt} width={ICON_PX} height={ICON_PX} />
    </Box>
  )
}
```

Every Svg needs a non-empty `alt`. The desktop draws no image whose `alt` is empty: the validator accepts it, the image is dropped, and its slot stays (found on the first live render, §11 check 4). A decorative icon carries the label of its row: a section icon its title, the ring `Context`, the branch `Branch`, the changes `Changes`. The rule says `rule`.

### 5.3 Text cells

```tsx
// FLEX, left: gives way first when the row is short of room.
function shrinkText(d: Draw, text: string, style: Partial<TextProps> = {}): RenderElement {
  const { Box, Text } = d.ui

  return (
    <Box flexDirection="row" flexShrink={1} minWidth={0} overflow="hidden">
      <Text {...style} wrap="truncate">{text}</Text>
    </Box>
  )
}

// FLEX, left, and it grows: takes the room that is left, so the cells after it start at the same x on every row.
function growText(d: Draw, text: string): RenderElement {
  const { Box, Text } = d.ui

  return (
    <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
      <Text wrap="truncate">{text}</Text>
    </Box>
  )
}

// FLEX, right: takes the room that is left and puts its text at the right edge. Empty text draws the Box alone.
function endText(d: Draw, text: string, style: Partial<TextProps> = {}): RenderElement {
  const { Box, Text } = d.ui

  return (
    <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden" justifyContent="flex-end">
      {text !== '' && <Text {...style} wrap="truncate">{text}</Text>}
    </Box>
  )
}
```

### 5.4 Section and header

Every builder of a block returns a `Block` (§6.12):

```tsx
// A block of the pane as its builder returns it: the tree, and the rows of the body that it takes. A block that is left
// out has no tree and no rows. A builder counts the rows from the very rows it puts in the tree, so that the two cannot
// part: the Log needs the count to know how many of its lines fit below the blocks above it (logParts).
type Block = { tree: RenderElement | null; rows: number }
const NO_BLOCK: Block = { tree: null, rows: 0 }
```

```tsx
const isFolded = (d: Draw, id: SectionId): boolean => d.data.collapsed[id] === true

// The header row of a section: an icon, the bold title, a dim chevron that folds it, a dim summary at the right. The
// title is a Text because a Button label cannot be bold; the chevron is a plain Button, dim at rest and full strength
// under the pointer or the focus (§5.4, §12.1).
function sectionHeader(d: Draw, id: SectionId, title: string, summary: string): RenderElement {
  const { Box, Text, Button } = d.ui

  return (
    <Box flexDirection="row" alignItems="center" columnGap={1}>
      {iconSlot(d, ICON[id], title)}
      <Box flexDirection="row" flexShrink={0}>
        <Text bold>{title}</Text>
      </Box>
      <Button
        plain
        dimColor
        key={`toggle:${id}`}
        label={isFolded(d, id) ? '▸' : '▾'}
        onPress={() => d.handlers.onToggle(id)}
      />
      {endText(d, summary, { dimColor: true })}
    </Box>
  )
}

// A section: a rule, then its header row, then the body unless folded. A folded section keeps its summary. Its rows are
// the rule's, the header's and, unless it is folded, those of what the body holds: one for each element of it, or
// `contentRows` where the caller knows that they take another number (the chips of MCP wrap). These are the rows of the
// section's own body, not the Pane's `bodyRows`, the rows the whole pane has.
function section(
  d: Draw, id: SectionId, title: string, summary: string, body: RenderElement[], contentRows = body.length,
): Block {
  const { Box } = d.ui
  const isOpen = !isFolded(d, id)

  return {
    tree: (
      <Box flexDirection="column">
        {divider(d)}
        {sectionHeader(d, id, title, summary)}
        {isOpen && <Box flexDirection="column">{body}</Box>}
      </Box>
    ),
    rows: RULE_ROWS + HEADER_ROWS + (isOpen ? contentRows : 0),
  }
}
```

- **Title.** Bold `Text`, because a Button label cannot be bold (§12.1).
- **Chevron.** A `plain` `dimColor` Button placed after the title, as in OpenChamber. It is dim at rest and full strength under the pointer or the focus (l.937–941). A one-glyph plain label is a control in its own right (l.929–934).
- **Summary.** Pushed right and cut before it can collide with the title. A folded section keeps its summary.
- **Body.** No extra gap between the header and the body.
- **Header alone.** `sectionHeader` draws the header row on its own. The Log uses it directly: its parts are children of
  the pane's root, not the body of a `section` (§6.10, §6.12).

## 6. Blocks

### 6.1 Top block

```tsx
// Session and Total, the context, and the split of the cost when subagents ran. The card never folds and has no rule
// above it. The total is primary weight: bold is for titles. Its rows, one line each: Session with its total, the
// context (two with a reading, the label and the meter), and the split.
function topBlock(d: Draw): Block {
  const { Box, Text } = d.ui
  const { usage, agents } = d.data
  const subagentsUsd = Object.values(agents).reduce((sum, agent) => sum + (agent.costUsd ?? 0), 0)
  const split = splitCost(usage.costUsd, subagentsUsd)
  const rows: RenderElement[] = [
    <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
      <Box flexDirection="row" flexShrink={0}>
        <Text bold>Session</Text>
      </Box>
      {split.total !== null && (
        <Box flexDirection="row" flexShrink={0}>
          <Text>{fmtUsd(split.total)}</Text>
        </Box>
      )}
    </Box>,
    ...contextRows(d),
  ]
  if (split.session !== null && split.subagents > 0) {
    rows.push(
      <Text dimColor wrap="truncate">
        {`Session ${fmtUsd(split.session)} · Subagents ${fmtUsd(split.subagents)}`}
      </Text>,
    )
  }

  return { tree: <Box flexDirection="column">{rows}</Box>, rows: rows.length }
}
```

The total stays in primary weight: bold is kept for titles, so the number is not competing with them.

### 6.2 Context rows (inside the top block)

```tsx
function contextRows(d: Draw): RenderElement[] {
  const { Box, Text } = d.ui
  const { contextPct, contextTokens, contextWindow } = d.data.usage
  const label = (
    <Box flexDirection="row" flexShrink={0}>
      <Text>Context</Text>
    </Box>
  )
  if (contextPct === undefined || !Number.isFinite(contextPct)) {
    return [
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        {iconSlot(d, ringSvg(undefined), 'Context')}
        {label}
        {endText(d, '—', { dimColor: true })}
      </Box>,
    ]
  }
  const hasTokens = contextTokens !== undefined && contextWindow !== undefined
  const note = hasTokens ? `${fmtTokens(contextTokens)} / ${fmtTokens(contextWindow)}` : ''
  const pctText = fmtPct(contextPct, 1)

  return [
    <Box flexDirection="row" alignItems="center" columnGap={1}>
      {iconSlot(d, ringSvg(contextPct), 'Context')}
      {label}
      {endText(d, note, { dimColor: true })}
    </Box>,
    <Box flexDirection="row" alignItems="center" justifyContent="space-between" columnGap={1}>
      <Box flexDirection="row" flexShrink={1} minWidth={0} overflow="hidden">
        {meter(d, contextPct, `Context ${pctText}`, d.contextMeterPx)}
      </Box>
      <Box flexDirection="row" width={PCT_CELLS} flexShrink={0} justifyContent="flex-end">
        <Text color={pctColor(contextPct)}>{pctText}</Text>
      </Box>
    </Box>,
  ]
}
```

- **Label row:** ring, `Context`, and the dim `tokens / window` at the right edge.
- **Meter row:** the bar from the left edge, then the percent at the right edge.
  - The percent sits beside its bar and lines up with every other value in the pane.
  - The bar needs no exact px width: whatever `CELL_PX` misses ends up as the space before the percent.
  - The Box around the bar can shrink and clips, so an overestimate cannot push the percent out.
- **Empty state:** an empty ring (track only), `Context`, and a dim `—` at the right. No meter row.

`meter(d, pct, alt, widthPx)` is v1's `meter` with the width passed in. It draws `meterSvg` unchanged, or `▰▱` on the terminal.

```ts
// The context meter shares its row with the percent only: the body less the 1-cell gap and PCT_CELLS, up to SVG_MAX_PX,
// so that it reaches the percent in a wide pane too.
export function contextMeterWidth(bodyColumns: number): number {
  return Math.min(SVG_MAX_PX, Math.max(48, (bodyColumns - 7) * CELL_PX))
}
```

At the default width (≈ 45 columns) this gives 304 px. The bar ends about 25 px before the `8` of `88.2%`: the 8 px gap, the 0–7 px left over by `bodyColumns`, and the room `88.2%` leaves in its 6 cells.

The bar stops at 4096 px (`SVG_MAX_PX`), so it reaches the percent in any pane up to about 4150 px wide (519 columns); a
wider pane gets a gap before the percent. Until 0.4.3 it stopped at 560 px, the widest pane of the design preview, and
in a pane maximized on a 21:9 monitor it ended far before its percent (the user's check, 2026-10-14). Whatever `CELL_PX`
misses grows with the width: in a 3100 px pane a cell 1 % off is about 30 px, as space before the percent, or as the end
of the bar cut off by its Box.

### 6.3 Project block

The Project block follows the top block and comes before Usage, as OpenChamber's Project block does. It never folds, so its header has no icon and no chevron. Where the numbers come from is in §4.1 of the main spec.

- **Layout.** A rule (§5.1), then three rows:
  - the header: the bold `Project`, and the folder name, dim, at the right;
  - the branch: an icon slot and the branch;
  - the changes: an icon slot, `N files changed` (`1 file changed` for one file), and at the right the lines added and removed.
- **Cells.**
  - The folder name is an `endText` cell: it takes the room that is left and puts its text at the right edge.
  - The branch is a `shrinkText` cell. The changes label is a `growText` cell, so the numbers start at the same x whatever the label says.
  - The numbers are one FIXED cell (`linesCell`) of three Texts: `+A` in `success`, a dim `/`, and `−D` in `error`.
- **U+2212.** The minus of the lines removed is the minus sign U+2212, not the hyphen.
- **No-break spaces.** The slash has a no-break space at each side (`LINES_SEP`). With plain spaces at its edges the desktop may draw `+8/−1`, as it may drop a plain space at the end of a flex item (§6.8).
- **Cut.** The folder name and the branch are cut from the end. The changes label gives way first, and the numbers never cut (§9).
- **Marks.** A count that is only a lower bound has a plus:
  - When git's status output was cut (it has a 4 MiB limit, which a `node_modules` that is not ignored can pass), the
    label reads `N+ files changed`, always plural, so `1+ files changed` for one file. There are no numbers then: the
    diffs are not run, and `lines` is null. `filesLabel` draws the label.
  - When new files past the first 50, or one whose count failed, add no lines, the added count has a plus after it:
    `+2061+ / −4`. `linesCell` draws it (`hasMoreAdded`).
  - A lower bound of no lines (`+0` with `hasMoreAdded`, and no lines removed) shows no numbers, as unknown lines do:
    the count alone shows. It happens in a SHA-256 repository with only new files, where every `--no-index` call fails,
    and when the first new-file count fails.
- **Left out.**
  - With no project name, the whole block.
  - With no branch, the branch row.
  - Outside a repository, on a clean tree, when git failed, or where the changes are not read, the changes row. They
    are not read before the first turn of the main agent, nor for a folder whose reads have twice in a row had a
    `git status`, or a `git diff` against HEAD, that failed to run (a timeout, or a git that cannot start); the folder
    and the branch still show. A status over 4 MiB does not leave the row out: it is marked above.
  - When the lines are unknown (an unborn HEAD, a failed diff) or both 0 (only binary files changed), the numbers: the count alone shows.
- **Terminal.** No icon slots: the branch and changes rows start with an emoji instead, `🌿 main` and `📝 12 files changed` (§10).

```tsx
// The lines added and removed, `+8 / −1`: three Texts in a fixed cell, so the numbers stay whole when the label beside
// them is cut. A count that is a lower bound (`hasMoreAdded`) has a plus after it: `+8+ / −1`.
function linesCell(d: Draw, lines: { added: number; removed: number; hasMoreAdded?: true }): RenderElement {
  const { Box, Text } = d.ui

  return (
    <Box flexDirection="row" flexShrink={0}>
      <Text color={OK}>{`+${lines.added}${lines.hasMoreAdded === true ? '+' : ''}`}</Text>
      <Text dimColor>{LINES_SEP}</Text>
      <Text color={BAD}>{`${MINUS}${lines.removed}`}</Text>
    </Box>
  )
}
```

```tsx
// The label of the changes row: `1 file changed`, `12 files changed`. A count that is a lower bound (`hasMoreFiles`, a
// status that was cut) has a plus after it, and the label is plural even for 1: `1+ files changed`.
function filesLabel(changes: { files: number; hasMoreFiles?: true }): string {
  if (changes.hasMoreFiles === true) return `${changes.files}+ files changed`

  return changes.files === 1 ? '1 file changed' : `${changes.files} files changed`
}
```

```tsx
// The project, as OpenChamber's Project block shows it: under a rule, the bold title with the folder dim at the right
// (cut from the end), then the branch, then the changes of the working tree: how many files, and at the right the
// lines added and removed. Like the Session card it never folds, so its header has no icon and no chevron. A row is an
// icon and its text on the desktop, and the text behind an emoji on the terminal, as v1 drew it. The block is left out
// when there is no project name; the branch row when there is no branch; the changes row when there are no changes; the
// numbers when the lines are unknown or are none (only binary files changed). Its rows are the rule and one line for
// each row of the block.
function projectBlock(d: Draw): Block {
  const { Box, Text, Svg } = d.ui
  // A value that an earlier build left in the state has no `changes`: it has none to show.
  const { name, branch, changes = null } = d.data.project
  if (name === '') return NO_BLOCK
  const marked = (emoji: string, text: string): string => (Svg === undefined ? `${emoji} ${text}` : text)
  const rows: RenderElement[] = [
    <Box flexDirection="row" alignItems="center" columnGap={1}>
      <Box flexDirection="row" flexShrink={0}>
        <Text bold>Project</Text>
      </Box>
      {endText(d, name, { dimColor: true })}
    </Box>,
  ]
  if (branch !== null) {
    rows.push(
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        {iconSlot(d, ICON.branch, 'Branch')}
        {shrinkText(d, marked('🌿', branch))}
      </Box>,
    )
  }
  if (changes !== null) {
    rows.push(
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        {iconSlot(d, ICON.changes, 'Changes')}
        {growText(d, marked('📝', filesLabel(changes)))}
        {changes.lines !== null && changes.lines.added + changes.lines.removed > 0 && linesCell(d, changes.lines)}
      </Box>,
    )
  }

  return {
    tree: (
      <Box flexDirection="column">
        {divider(d)}
        {rows}
      </Box>
    ),
    rows: RULE_ROWS + rows.length,
  }
}
```

### 6.4 Label/value row

Used by Turn stats and Context sources.

```tsx
function row(d: Draw, label: string, value: string, color?: string): RenderElement {
  const { Box, Text } = d.ui

  return (
    <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
      {shrinkText(d, label)}
      <Box flexDirection="row" flexShrink={0}>
        <Text color={color}>{value}</Text>
      </Box>
    </Box>
  )
}
```

Labels sit flush left, under the icons, as in OpenChamber. They are not indented. Values never cut; the label cuts first, and only in a very narrow pane.

### 6.5 Usage: limit row

An excerpt of `usageSection`, de-indented:

```tsx
const rows = rateLimits.map(limit => {
  const pctText = fmtPct(limit.percentUsed, 0)
  const reset = limit.resetsAt === undefined ? '' : fmtCountdown(limit.resetsAt - d.data.now)

  return (
    <Box flexDirection="row" alignItems="center" columnGap={1}>
      <Box flexDirection="row" width={LIMIT_LABEL_CELLS} flexShrink={0} overflow="hidden">
        <Text wrap="truncate">{label(limit.kind)}</Text>
      </Box>
      <Box flexDirection="row" flexShrink={1} minWidth={0} overflow="hidden">
        {meter(d, limit.percentUsed, `${label(limit.kind)} ${pctText}`, d.limitMeterPx)}
      </Box>
      <Box flexDirection="row" width={LIMIT_PCT_CELLS} flexShrink={0} justifyContent="flex-end">
        <Text color={pctColor(limit.percentUsed)}>{pctText}</Text>
      </Box>
      {endText(d, reset, { dimColor: true })}
    </Box>
  )
})

return section(d, 'usage', 'Usage', `${label(lead.kind)} ${fmtPct(lead.percentUsed, 0)}`, rows)
```

```ts
// A limit meter shares its row with the label, the percent and the countdown: 7 + 1 + 1 + 5 + 1 + 9 + 1 spare cells, up
// to SVG_MAX_PX, as the context meter.
export function limitMeterWidth(bodyColumns: number): number {
  return Math.min(SVG_MAX_PX, Math.max(40, (bodyColumns - 25) * CELL_PX))
}
```

At ≈ 45 columns this gives 160 px, and it too stops at 4096 px (until 0.4.3, at 240). Limit meters line up with each
other: same label width, same meter width. The countdown is right-aligned and dim. A kind with no label of its own (raw
`kind`) is cut inside its 7 cells.

### 6.6 Turn stats

Same rows and the same summary as v1, drawn with `row()` (§6.4); Cache stays `success` from 50 %. With no completed turn, the body is `shrinkText(d, 'No completed turn yet', { dimColor: true })`, so a narrow pane cuts it instead of wrapping it, and the summary is empty.

### 6.7 Subagent and task rows

The Subagents and the Tasks are two lists of one kind of row, with one builder for a row (`statusRow`) and one for a
list (`statusSection`). `agentsSection` and `tasksSection` turn the state into the items that `statusSection` takes, in
the order the rows are drawn, and say what the two columns that differ hold: a subagent's tag is its `@type` and its
value its cost, a task's tag is its `@kind` and its value its time.

```tsx
// What a row of the Subagents or of the Tasks is made of: its status, its description, the dim `@…` tag that says what
// it is (the `@type` of a subagent, the `@kind` of a task), and the figure at the right edge (a subagent's cost, a
// task's time), null where it is not known.
type StatusRow = { status: TaskStatus; description: string; tag: string; value: string | null }

// One row of such a list, in columns: the mark (a cell of its own), a group that takes the rest of the row, and the
// value (right-aligned in a column of `valueCells`, a dim dash where it is not known). The group holds the
// description, which grows and is cut to the room there is, and the tag, a column of `tagCells` on every row, so the
// tags start at one x whatever the descriptions are. A pane too narrow to leave the description MIN_AGENT_DESC_CELLS
// has no tag column (`tagCells` is 0): the description takes the whole group, on every row alike.
function statusRow(d: Draw, item: StatusRow, tagCells: number, valueCells: number): RenderElement {
  const { Box, Text, Svg } = d.ui
  const mark = AGENT_MARKS[item.status]

  return (
    <Box flexDirection="row" alignItems="center" columnGap={AGENT_GAP_CELLS}>
      {Svg === undefined ? (
        <Box flexDirection="row" width={TEXT_MARK_CELLS} flexShrink={0}>
          <Text color={mark.color} dimColor={mark.isDim}>
            {mark.glyph}
          </Text>
        </Box>
      ) : (
        iconSlot(d, STATUS_SVG[item.status], item.status)
      )}
      <Box
        flexDirection="row"
        flexGrow={1}
        flexShrink={1}
        minWidth={0}
        overflow="hidden"
        columnGap={AGENT_GAP_CELLS}
      >
        {growText(d, item.description)}
        {tagCells > 0 && (
          <Box flexDirection="row" width={tagCells} flexShrink={0} overflow="hidden">
            <Text dimColor wrap="truncate">{item.tag}</Text>
          </Box>
        )}
      </Box>
      <Box flexDirection="row" width={valueCells} flexShrink={0} justifyContent="flex-end">
        {item.value === null ? <Text dimColor>—</Text> : <Text>{item.value}</Text>}
      </Box>
    </Box>
  )
}
```

```tsx
// The widths, in cells, of the two columns in which the Subagents and the Tasks differ: the tag, which is
// `desktopTagCells` wide on the desktop whatever it holds, and on the terminal as wide as the longest tag drawn, up to
// `terminalTagCells`; and the value at the right edge, `valueCells` wide.
type StatusColumns = { desktopTagCells: number; terminalTagCells: number; valueCells: number }

// A section of rows with a status mark, the Subagents' and the Tasks' alike; `items` come in the order they are drawn.
// The summary counts the rows that run (`2/5`), and all of them when none does. Up to MAX_AGENT_ROWS are drawn, and the
// ones that do not fit are counted, in line with the descriptions. A row each, and the line that counts the rest is one
// more.
function statusSection(d: Draw, id: SectionId, title: string, items: StatusRow[], columns: StatusColumns): Block {
  const { Svg } = d.ui
  if (items.length === 0) return NO_BLOCK
  const running = items.filter(item => item.status === 'running').length
  const summary = running > 0 ? `${running}/${items.length}` : String(items.length)
  const shown = items.slice(0, MAX_AGENT_ROWS)
  // One width for the tag column of every row, as for the `who` of the log: the terminal takes the longest tag that is
  // drawn, the desktop a width of its own.
  const longest = Math.max(...shown.map(item => item.tag.length))
  const tagCells = Svg === undefined ? Math.min(columns.terminalTagCells, longest) : columns.desktopTagCells
  // What the description keeps beside the tag: the body less the mark, the tag, the value and the gaps of a row. With
  // less than MIN_AGENT_DESC_CELLS the tag is left out of every row.
  const descCells = d.cols - markCellsOf(d) - tagCells - columns.valueCells - AGENT_ROW_GAPS * AGENT_GAP_CELLS
  const hasTag = descCells >= MIN_AGENT_DESC_CELLS
  const rows = shown.map(item => statusRow(d, item, hasTag ? tagCells : 0, columns.valueCells))
  const more = items.length - MAX_AGENT_ROWS
  // The line starts where the descriptions do: after the mark and its gap.
  if (more > 0) rows.push(moreLine(d, more))

  return section(d, id, title, summary, rows)
}
```

```tsx
// The subagents, running ones first and then the newest; the value of a row is its cost.
function agentsSection(d: Draw): Block {
  const items = orderAgents(Object.values(d.data.agents)).map((agent): StatusRow => ({
    status: agent.status,
    description: agent.description,
    tag: `@${shortType(agent.type)}`,
    value: agent.costUsd === null ? null : fmtUsd(agent.costUsd),
  }))

  return statusSection(
    d, 'agents', 'Subagents', items,
    { desktopTagCells: TYPE_CELLS, terminalTagCells: TYPE_CELLS_MAX, valueCells: COST_CELLS },
  )
}

// What a task's row shows at the right: how long a running one has run, never under 0 (the wall clock may have been put
// back since it began), and how long a finished one ran. Null where it is not known: a running task whose start the mod
// did not see, a finished one that has no duration, and one whose time is wider than its cell (1000 hours or more: no
// task runs that long, but a notice can carry any safe integer as its duration). A value is drawn whole, never cut, so
// such a time is drawn as not known, and the row stays one line. A finished task whose time is a bound (durationAtMost)
// has `≤` before it, and the width counts it.
function taskTime(task: TaskRow, now: number): string | null {
  const ran = task.startedAt === null ? null : Math.max(0, now - task.startedAt)
  const ms = task.status === 'running' ? ran : task.durationMs
  const text = ms === null ? null : `${task.durationAtMost === true ? '\u{2264}' : ''}${fmtDuration(ms)}`

  return text === null || text.length > TASK_TIME_CELLS ? null : text
}

// The background tasks, running ones first and then the newest start, as the subagents are; the value of a row is its
// time. The descriptions come from the state clean: the mod masked and cut them when it wrote them.
function tasksSection(d: Draw): Block {
  const items = orderTasks(Object.values(d.data.tasks)).map((task): StatusRow => ({
    status: task.status,
    description: task.description,
    tag: `@${task.kind}`,
    value: taskTime(task, d.data.now),
  }))

  return statusSection(
    d, 'tasks', 'Tasks', items,
    { desktopTagCells: TASK_TYPE_CELLS, terminalTagCells: TASK_TYPE_CELLS, valueCells: TASK_TIME_CELLS },
  )
}
```

The row has four columns. The description and the tag column sit in one group, between the mark and the value:

1. **Status mark** (FIXED). One set of marks for both lists (below).
2. **Description** (FLEX, grows: `growText`). It takes the rest of the row, so the tag column starts at the same x on
   every row.
3. **Tag** (FIXED, `tagCells` wide), while the description keeps room beside it (below). The tag is dim.
   - Subagents, `@type`. Desktop: `TYPE_CELLS`, 15 cells (120 px). The cut types `@frontend-deve…` and
     `@minimal-chang…` measure about 111 px on the live pane. Terminal: the longest `@type` drawn, at most
     `TYPE_CELLS_MAX` (15).
   - Tasks, `@kind`: `@shell`, `@monitor` or `@workflow`. Desktop: `TASK_TYPE_CELLS`, 10 cells (80 px). This width is an
     estimate, not a measure: the widest kind, `@workflow`, is 9 characters, and the 111 px of the 15 characters of
     `@frontend-deve…` make about 7.4 px a character, so about 66 px. The live check of 0.5.0 measures it (§11, check
     21). Terminal: the longest `@kind` drawn, at most `TASK_TYPE_CELLS` (10).
4. **Value** (FIXED, `valueCells` wide, right-aligned). A dim `—` stands where it is not known.
   - Subagents: the cost, `COST_CELLS`, 7 cells. Costs line up on their right edge, and every description ends at the
     same x.
   - Tasks: the time, `TASK_TIME_CELLS`, 8 cells (`taskTime`). A running task shows how long it has run, never under 0
     (the wall clock may have been put back since it began); the pane redraws at least every 30 s, so the time moves
     with it. An ended task shows how long it ran, and a time that is a bound has `≤` before it (below). The time is
     unknown for a running task whose start the mod did not see, for an ended one with no duration, and for one whose
     time is wider than the cell. A time from 100 hours on takes 8 cells (`100h 00m`), the widest this cell holds, so
     `999h 59m` still fits; a bound takes a cell more for its `≤`, so `≤99h 59m` is the widest one shown and `≤100h 00m`
     does not fit; a time of 1000 hours or more does not either: no task runs that long, but a notice can carry any safe
     integer as its duration. A value is never cut, so such a time is drawn as not known, a dim `—`, and the row stays
     one line.
   - **A bound.** A shell notice carries no time, so the time runs from the start to the notice. The engine takes a
     notice in at the next model request of a running turn, or when the session is idle, so it may come later than the
     task's end. When it came into a running turn, less than 3 s after the main agent's last turn ended, or before the
     pane has seen a turn end (just after it loaded), the task ran at most that long, and the time is a bound: `≤12.2s`.
     A notice that comes after the session has been idle for 3 s or more is taken at the task's end, and the time is
     exact. A notice that carries its own `<duration_ms>` (a Workflow's) and a `TaskStop`, which ends the row at once,
     give exact times too. The end line of the Log has the same `≤` (§6.10).

**In a narrow pane the tag gives way first**, as `who` does in the log (§6.10). `statusSection` works out what a
description would keep beside the tag: the body less the mark (`markCellsOf(d)`: `ICON_CELLS` on the desktop,
`TEXT_MARK_CELLS` on the terminal), the tag column, the value column and the gaps of the row (`AGENT_ROW_GAPS` of
`AGENT_GAP_CELLS` each: two between the cells and one in the group). With fewer than `MIN_AGENT_DESC_CELLS` (12) cells
the tag column leaves every row of the list, not some of them: `statusRow` gets `tagCells` 0, and the description takes
the whole group. The choice is made once per list, so every description still ends at the same x. The two lists choose
on their own columns: on the desktop the Subagents keep `@type` from 39 body columns (2 + 15 + 7 + 3 + 12) and the
Tasks keep `@kind` from 35 (2 + 10 + 8 + 3 + 12).

The list:

- The header's summary is `running/total` while a row runs, and `total` otherwise.
- The rows come running first and then the newest start (`orderAgents`, `orderTasks`). A task whose start is not known
  comes last of its group.
- Up to `MAX_AGENT_ROWS` (8) rows are drawn, and the rest are counted in a `+N more` line (below).
- A list with no rows is left out, with its rule and its header: there is no Tasks section until there is a task. A
  folded list is its rule and its header (§5.4), and the fold is kept in `collapsed` under the section's id (`agents`
  or `tasks`).

**Marks.** One set for both lists, by status. The desktop draws an icon (§7), the terminal a glyph in a 1-cell Box:

| Status | Desktop icon | Terminal glyph |
|---|---|---|
| `running` | half-filled ring, `BLUE` | `◐` blue |
| `done` | check in a ring, `GREEN` | `✓` `success` |
| `failed` | cross in a ring, `RED` | `✗` `error` |
| `stopped` | stop square in a ring, `NEUTRAL` | `■` dim |
| `ended` | empty ring, `NEUTRAL` | `○` dim |

A subagent has the first four statuses. `ended` is a task that is over with no known end; nothing sets it in 0.5.0, and
the restore of 0.6.0 will. A stopped row and an ended one are no failure, so neither is a cross, and failed and stopped
differ by shape, not by colour alone. Until 0.5.0 the terminal drew a stopped subagent as a dim `✗`.

```tsx
// The marks of a status on a surface with no images. The Subagents and the Tasks share one set, keyed by the statuses
// of a task: a subagent has the first four, and `ended` is a task that is over with no known end. A stopped row has a
// dim square and an ended one a dim ring: neither is a failure, so neither is a cross.
const AGENT_MARKS: Record<TaskStatus, { glyph: string; color?: string; isDim?: boolean }> = {
  running: { glyph: '◐', color: BLUE },
  done: { glyph: '✓', color: OK },
  failed: { glyph: '✗', color: BAD },
  stopped: { glyph: '■', isDim: true },
  ended: { glyph: '○', isDim: true },
}
```

The status icon's `alt` is the status word (`running`, `done`, `failed`, `stopped`, `ended`): the icon is the only place
that says it.

**"+N more"** aligns with the descriptions:

```tsx
// The cells in front of the text of a row that has a mark: the mark's slot and the gap after it.
const markCellsOf = (d: Draw): number => (d.ui.Svg === undefined ? TEXT_MARK_CELLS : ICON_CELLS)

// The dim line that counts what a list does not show: `+3 more`. It starts where the text of the rows above it does,
// after the mark and its gap, for the Subagents, the Tasks and the Log alike (§6.7). `props` go to the Box that holds
// it.
function moreLine(d: Draw, count: number, props: Partial<BoxProps> = {}): RenderElement {
  const { Box, Text } = d.ui

  return (
    <Box flexDirection="row" paddingLeft={markCellsOf(d) + AGENT_GAP_CELLS} {...props}>
      <Text dimColor>{`+${count} more`}</Text>
    </Box>
  )
}
```

The line starts at `markCellsOf(d)` + `AGENT_GAP_CELLS`, where the descriptions start whether or not the tag column is
drawn. On the desktop that is 3 cells = the 2-cell icon slot + the 1-cell gap. On the terminal it is 2 cells = the
1-cell mark + the 1-cell gap.

### 6.8 MCP chips

```tsx
// The cells that the name of a chip takes, counted high, because the estimate of chipRows must err on the side of more
// rows (the 0.4.0 spec, §3.2): `.length` counts a CJK character as one cell, and it is drawn two wide. Every code point
// above U+007F counts as 2 cells (the wide ones, CJK and emoji, and some that are not, an accented letter), a capital
// ASCII letter (A to Z) as `capital` cells, every other as 1, and the total of a name is rounded up. On the desktop a
// capital is more than a cell, because its font is proportional: the live check of 2026-10-13
// (docs/live-check-2026-10-13-0.4.0.md) measured capitals at about 9 to 11 px against the 8 px of a cell (CELL_PX), so
// two long names in capitals at the edge of a line made the estimate a row short, and `capital` is 1.5 there. The
// terminal's cells are even: a capital is one cell, and `capital` is 1. It goes by code point, not by UTF-16 unit: an
// astral emoji is one code point and 2 cells, where its two units would make 4.
const nameCells = (name: string, capital: number): number => {
  let cells = 0
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0
    cells += code > 0x7f ? 2 : char >= 'A' && char <= 'Z' ? capital : 1
  }

  return Math.ceil(cells)
}

// How many lines the chips of the MCP section wrap into in a body of `columns` cells: the one place where the rows of a
// block are an estimate, since the layout engine does the wrapping. A chip is its dot (DOT.length cells) and its name,
// which nameCells counts high: a name measured short would make the estimate a row short, and that is the side it
// must not err on. The chips go in the order they come, whole, onto a line while the next one fits it with the gap that
// parts them, and a chip wider than the line (it is cut) is a line of its own. A line is the body less
// CHIP_MARGIN_CELLS, so the estimate errs on the side of a row too many: the Log then draws a line fewer than would
// fit, where a row too few would cut its last line (logLinesFit). `capital` is the cells of an ASCII capital in a name:
// 1.5, the desktop's, unless the caller says that the cells are even (nameCells).
export function chipRows(names: string[], columns: number, capital = WIDE_CAPITAL_CELLS): number {
  const lineCells = columns - CHIP_MARGIN_CELLS
  let rows = 0
  let used = 0
  for (const name of names) {
    const chipCells = DOT.length + nameCells(name, capital)
    if (rows > 0 && used + CHIP_GAP_CELLS + chipCells <= lineCells) {
      used += CHIP_GAP_CELLS + chipCells
    } else {
      rows += 1
      used = chipCells
    }
  }

  return rows
}

// The MCP servers, a green dot and the name each, wrapped whole; the summary is their count. The mod only learns which
// servers have tools in the context (WaitForMcpServers is not there for a module), so it cannot tell a failed one
// from a connected one: every dot is green. A name wider than the pane goes on its own line and is cut. The chips are
// the one body of a section that is more than one line high, as many as chipRows says. A capital in a name weighs 1
// cell where the pane draws no Svg, on the terminal, whose cells are even, and 1.5 where it does: the desktop draws
// capitals wider, about 9 to 11 px against the 8 px of a cell (CELL_PX).
function mcpSection(d: Draw): Block {
  const { Box, Text } = d.ui
  const { mcp } = d.data
  if (mcp === null || mcp.servers.length === 0) return NO_BLOCK
  const chips = mcp.servers.map(server => (
    <Box flexDirection="row" flexShrink={1} minWidth={0} overflow="hidden">
      <Box flexDirection="row" flexShrink={0}>
        <Text color={OK}>{DOT}</Text>
      </Box>
      {shrinkText(d, server.name)}
    </Box>
  ))
  const names = mcp.servers.map(server => server.name)

  return section(
    d, 'mcp', 'MCP', String(names.length),
    [
      <Box flexDirection="row" flexWrap="wrap" columnGap={CHIP_GAP_CELLS}>
        {chips}
      </Box>,
    ],
    chipRows(names, d.cols, d.ui.Svg === undefined ? 1 : WIDE_CAPITAL_CELLS),
  )
}
```

- **Dot and name.** Only the dot is green; the name is primary text. This is less noise than v1's all-green names, and the dot still says "connected".
- **No-break space.** `DOT` is the dot and a no-break space (`'●\u00a0'`), so one space stays between the dot and the name. A plain space at the end of a flex item may be dropped by the desktop's whitespace rules.
- **Wrapping.** Chips wrap whole. A single name wider than the pane goes on its own line and is cut.
- **Capitals.** `nameCells` counts a capital ASCII letter as 1.5 cells on the desktop, whose font is proportional (a
  capital is about 9 to 11 px against the 8 px of a cell), and as 1 in a terminal, whose cells are even: `mcpSection`
  passes the weight by the surface (no `Svg` is a terminal), and `chipRows` defaults to the desktop's. So in a terminal
  a capital adds no spare row. The wrap stays an estimate on both surfaces, made on the high side: `chipRows` keeps
  `CHIP_MARGIN_CELLS` (2) cells of every line free and counts a character above ASCII as 2 cells (an accented letter is
  drawn as 1), so it can give a row too many anywhere. 0.5.0 counted 1.5 on both, so in a terminal names in capitals
  could cost a spare row.

### 6.9 Context sources

`row(d, 'Skills', …)` and `row(d, 'MCP servers', …)`; summary unchanged (`77 skills · 5 MCP`).

### 6.10 Log row

```tsx
// How many lines of the Log fit in the body (the 0.4.0 spec, 2026-10-12-session-panel-v2-design.md, §3.2). The Log has
// the rows that the blocks above it leave: the body's, less theirs (`above`, which the builders count from the rows
// they draw) and less its own rule and header. If all its `total` events fit in them, that many; if not, one row goes
// to the `+N more` line and the Log has the rest, never fewer than MIN_LOG_ROWS lines: below that the pane scrolls. The
// log holds the newest 200 events at most (pushLog), so the lines drawn are these or all it holds, whichever are fewer.
// Where the body's height is not known the Log has MAX_LOG_ROWS.
//
// The count of the rows above is exact but for the chips of MCP (chipRows), which wrap, and that is made to err on the
// high side. A count that is too high is harmless: the Log draws a line fewer than would have fit; a spare row is left
// above the `+N more` line, where the tail grows into it, or at the bottom of the pane when the Log has no tail or no
// `+N more` line; and `+N more` still counts every event that is not drawn. A count that is too low is not:
// the last line is drawn past the rows there are, the tail clips it, and N is one short of the events that are hidden.
// So an error is allowed on the side of fewer lines only, and the tail's clip is what limits the damage of the other.
function logLinesFit(d: Draw, above: number, total: number): number {
  if (d.rows === 0) return MAX_LOG_ROWS
  const room = d.rows - above - RULE_ROWS - HEADER_ROWS

  return total <= room ? total : Math.max(MIN_LOG_ROWS, room - 1)
}

// The Log, as the parts of the pane's root: its rule, its header, its lines and the line that counts the events that
// are not drawn, with no Box around them. That is the layout the live desktop has verified, and it needs no chain of
// Boxes that grow (the visual spec, §6.12 Log height).
// Folded, it is the rule and the header; with no lines, nothing. The summary of its header is the count of every event
// (the lines are the newest of them): logCount, or the lines the log holds where the count is behind them. A folded Log
// keeps it, and has no `+N more` line.
// The newest log lines: time, who, what, and how it went. Time and `who` are dim fixed columns, so every text starts
// at the same x; the text is cut to one line. On the desktop `who` has a width of its own, so the text column does not
// jump with the longest `who`; on the terminal it is the longest one there is, up to the most shortType keeps. The
// outcome (the mark and the time of an action, or `denied`) is a fixed column at the right edge, as wide as the
// longest one drawn, a cell wider on the desktop: a ✓ or a ✗ varies by font, and the margin keeps the mark whole. A
// line without one has the cell empty. An error shows its `who` and its outcome in red, the others are dim; in
// [time, text], which has neither cell, its text is red.
// The layout is the first of these whose text keeps MIN_LOG_TEXT_CELLS cells, one for every row: [time, who, text,
// outcome]; then `who` gives way, [time, text, outcome]; then [time, text], where a line shows its outcome in front of
// its text, so that the cut at the end keeps it. That one is also the layout when nothing fits. With no outcome among
// the lines drawn there is no outcome cell, and a line shows its text alone.
// Where `who` has no cell, a line of the person (`you`) or of the engine (`engine`) shows it in front of its text, as
// `you › …`, for its text alone does not say whose it is; the other lines have no label. It comes after the outcome,
// where a line shows that in front too. MIN_LOG_TEXT_CELLS counts the text alone, not the label: at the edge of a
// layout an engine line shows its label and none of its text.
// The height: the lines drawn are as many as fit under the blocks above the Log (logLinesFit), MIN_LOG_ROWS at least.
// The first MIN_LOG_ROWS are the head, a Box that holds its height, so they always show. The rest are the tail, a Box
// with no height of its own that grows into the rows the root leaves free (it is at least the body's height) and clips
// at its bottom, so the oldest lines go first; with the count of the rows right it clips nothing, and it is the
// insurance for the day it is not. After the tail comes the line that counts the events that are not drawn: a child of
// the root, that holds its size, so that the tail's growing leaves it its row and it ends the pane. When not even the
// head fits, the root grows to its content and the pane scrolls, which the engine does. Where the body's height is not
// known the lines are MAX_LOG_ROWS, in one Box at their natural height (a tail would have no room to grow into), and
// the line that counts the rest follows it.
function logParts(d: Draw, above: number): RenderElement[] {
  const { Box, Text, Svg } = d.ui
  const { log } = d.data
  if (log.length === 0) return []
  // Every event of the session: the count, and at least the lines the log holds. A session that began on an earlier
  // build and has this one loaded into it has lines on its log that the count never saw: it starts at 0.
  const total = Math.max(d.data.logCount, log.length)
  const rule = divider(d)
  const header = sectionHeader(d, 'log', 'Log', String(total))
  if (isFolded(d, 'log')) return [rule, header]
  const lines = log.slice(0, logLinesFit(d, above, total))
  const longestWho = Math.max(...lines.map(line => line.who.length))
  const whoCells = Svg === undefined ? Math.min(WHO_CELLS_MAX, longestWho) : WHO_CELLS
  const longestOutcome = Math.max(...lines.map(line => line.outcome?.length ?? 0))
  const outcomeCells = longestOutcome === 0 ? 0 : longestOutcome + (Svg === undefined ? 0 : 1)
  // The cells the text keeps in a layout: the body less the time, `who` and outcome cells it has, and its gaps (the
  // cells of the row less one).
  const textCells = (withWho: boolean, withOutcome: boolean): number =>
    d.cols - TIME_CELLS - (withWho ? whoCells : 0) - (withOutcome ? outcomeCells : 0) -
    (1 + Number(withWho) + Number(withOutcome)) * LOG_GAP_CELLS
  const hasOutcomes = outcomeCells > 0
  const hasWho = textCells(true, hasOutcomes) >= MIN_LOG_TEXT_CELLS
  const hasOutcomeCell = hasOutcomes && (hasWho || textCells(false, true) >= MIN_LOG_TEXT_CELLS)
  const isTextOnly = !hasWho && !hasOutcomeCell
  // What the text cell shows, one string in one Text, so that the cut at its end keeps what leads: the outcome, where
  // the row has no cell for it, then the label of a line of the person or of the engine, where it has none for `who`.
  const textOf = (line: LogEntry): string => {
    const outcome = hasOutcomeCell || line.outcome === undefined ? '' : `${line.outcome} `
    const label = !hasWho && (line.who === 'you' || line.who === 'engine') ? `${line.who} › ` : ''

    return `${outcome}${label}${line.text}`
  }
  const lineRows = lines.map(line => (
    <Box flexDirection="row" columnGap={LOG_GAP_CELLS}>
      <Box flexDirection="row" width={TIME_CELLS} flexShrink={0}>
        <Text dimColor>{fmtClock(line.at)}</Text>
      </Box>
      {hasWho && (
        <Box flexDirection="row" width={whoCells} flexShrink={0} overflow="hidden">
          {line.kind === 'error' ? (
            <Text color={BAD} wrap="truncate">{line.who}</Text>
          ) : (
            <Text dimColor wrap="truncate">{line.who}</Text>
          )}
        </Box>
      )}
      <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
        <Text color={isTextOnly && line.kind === 'error' ? BAD : undefined} wrap="truncate">{textOf(line)}</Text>
      </Box>
      {hasOutcomeCell && (
        <Box flexDirection="row" width={outcomeCells} flexShrink={0} overflow="hidden" justifyContent="flex-end">
          {line.outcome !== undefined && (line.kind === 'error' ? (
            <Text color={BAD} wrap="truncate">{line.outcome}</Text>
          ) : (
            <Text dimColor wrap="truncate">{line.outcome}</Text>
          ))}
        </Box>
      )}
    </Box>
  ))
  // The events that are not drawn, counted: N is all of them less the lines, and the line is there when there are any.
  const hidden = total - lines.length
  const moreParts = hidden > 0 ? [moreLine(d, hidden, { flexShrink: 0 })] : []
  if (d.rows === 0) return [rule, header, <Box flexDirection="column">{lineRows}</Box>, ...moreParts]
  const parts = [rule, header, <Box flexDirection="column" flexShrink={0}>{lineRows.slice(0, MIN_LOG_ROWS)}</Box>]
  if (lineRows.length > MIN_LOG_ROWS) {
    parts.push(
      <Box flexDirection="column" height={0} flexGrow={1} flexShrink={1} overflow="hidden">
        {lineRows.slice(MIN_LOG_ROWS)}
      </Box>,
    )
  }

  return [...parts, ...moreParts]
}
```

- **Time and `who`** are fixed columns.
  - In the full layout every text starts at the same x: 8 + 1 + 13 + 1 = 23 cells = 184 px on the desktop.
  - Proportional digits can no longer move the columns.
  - The `who` column no longer shrinks with the text beside it. It did in v1, which moved the text column row to row.
- **Weight.** Time and `who` are dim, so the text carries the row. An error `who` is red.
- **`who` width per surface.**
  - Desktop: a constant 13 cells, so the text column does not jump when the longest `who` changes.
  - Terminal: the longest `who` among the lines drawn, as in v1, capped at 14.
- **Outcome.** The mark and the time of an action (`✓ 0.3s`, `✗ 0.3s`), or `denied`, in a column of its own at the right
  edge of the row. A subagent's result has one too: `✓ 1m 12s`, `✗ 1m 12s`, or the time alone for a stop, which is no
  fault. The end of a background task has one by the same rule: its line reads `done · shell: …`, `failed · …` or
  `stopped · …`, its `who` and outcome are red for `failed` only, and an end that came between turns has the engine's
  `task-notification` line beside it. A time that is a bound has `≤` before it: `✓ ≤12.2s`, `✗ ≤…` for a failure, `≤…`
  for a stop (§6.7). A call that started a background task has `→ background` instead of `✓` and its time, whichever
  agent made the call: its time would be the call's, not the task's.
  - The column is FIXED and right-aligned (`justifyContent="flex-end"`). It holds one `Text wrap="truncate"`, styled like the `who` of the same line: red for an error line, dim otherwise.
  - A line without an outcome (a prompt, `spawned`, `resumed`, a compaction) gets the same cell, empty, so every text is cut at the same x.
- **Outcome width per surface.** Worked out once per section, from the lines drawn.
  - Terminal: the longest outcome, in characters.
  - Desktop: the longest outcome + 1 cell. A ✓ or a ✗ varies by font, and the margin keeps the mark whole.
  - With no outcome among the lines drawn there is no outcome cell, and a line shows its text alone.
- **Narrow pane: `who` gives way first.** The layout is the first of these whose text keeps at least `MIN_LOG_TEXT_CELLS` (8) cells (the body less the time, `who` and outcome cells the layout has, and its gaps), one for every row of the section:
  1. [time, who, text, outcome];
  2. [time, text, outcome]: `who` has given way;
  3. [time, text]: the outcome goes in front of the text, as `✓ 0.3s Bash ls`, so that the cut at the end of the text keeps it. This is also the layout when nothing fits.
- **A `→ background` line makes `who` give way sooner.** While one is among the lines drawn, the outcome column is as
  wide as it: 12 characters in a terminal and 13 cells on the desktop, against 6 and 7 for `✓ 0.3s`. The first layout
  then needs more room, so `who` gives way below 45 body columns on the desktop instead of 39 (8 + 13 + 13 + 3 + 8:
  the time, `who`, the outcome, the gaps and the least text) and below 35 in a terminal instead of 29 (8 + 4 + 12 +
  3 + 8, with `main` as the longest `who`). The outcome is kept whole on purpose, not shortened to spare `who` (the
  user's decision, 2026-10-16).
- **Red text.** The last layout has neither a `who` nor an outcome cell to carry the red of an error, so the text of an error line is red there. In the other layouts the text stays primary.
- **Labels.** Where the layout has no `who` cell (layouts 2 and 3), a line of the person (`you`) reads `you › …`, and a
  line of the engine (`engine`: a turn that the engine starts with a tag of its own, a lowercase name with a hyphen or
  an underscore, such as `agent-message`; any other text, a pasted `<div class="x">` too, is the person's) reads
  `engine › …`: its text alone does not say whose it is. The other lines have no label. In [time, text] a line's outcome
  still comes first, and the label follows it. The layout does not count the label: `MIN_LOG_TEXT_CELLS` counts the text
  alone, so at the edge of a layout an engine line shows its label and none of its text. Where `who` has given way, a
  subagent's type has no column and no label, so it is visible nowhere in the Log but in its `spawned · type: …` line,
  if the cut does not take it: a known limit (finding 11 of the 0.3.0 live check).
- **Columns.** The `who` and outcome columns are worked out from the longest `who` and the longest outcome among the
  lines drawn. The lines drawn are the lines that fit (§6.12); only a row count that is too low draws one more, which
  the tail clips. A long outcome lower down can make `who` give way for every row. The rule stays: one layout for the
  head and the tail is what keeps their columns in line.
- **Abandoned call.** A tool call that came back as an error while its call had been abandoned (the person interrupted
  it, or a stop did) is a note, not a fault. It is kind `info`, so it is not red: its text is drawn as on any line that
  is no error, its `who` and outcome are dim as on every such line, and its outcome is the time alone, with no ✗, as a
  stopped subagent's result does. This rests on the engine's `next.signal` (`ran.isError` and `next.signal.aborted`
  after `await next(e)`), and was seen live for a subagent stopped with `TaskStop` and for Esc on the main agent, while
  a call that fails by itself stays red (§11, check 9). A failure of an agent with no row in Subagents (labeled `agent`)
  is drawn dim too: design spec §4.7.

### 6.11 Empty and partial states

| State | Drawn |
|---|---|
| No context reading | empty ring + `Context` + dim `—` at the right; no meter row (§6.2) |
| No total cost | `Session` alone on the first row; no split line |
| No subagents | no split line; no Subagents section (and no rule for it) |
| No tasks | no Tasks section (and no rule for it) (§6.7) |
| No completed turn | Turn stats header with no summary, body `No completed turn yet` (dim) |
| No project name | no Project block (§6.3) |
| No branch | the Project block without the branch row |
| No repository, a clean tree, a failed git, or changes not read yet or given up (§6.3) | no changes row |
| A status over 4 MiB | `N+ files changed` with no numbers (§6.3) |
| New files not all counted | `+2061+ / −4`; with no line counted, no numbers, as in the next row (§6.3) |
| Lines unknown (an unborn HEAD, a failed diff) or both 0 (only binary files changed) | the changes row with the count alone, no numbers |
| Subagent cost unknown | dim `—` in the cost column |
| Task time not known (none, or wider than its cell) | dim `—` in the time column (§6.7) |
| More than 8 subagents or tasks | `+N more` (§6.7) |
| Events the Log does not draw | a dim `+N more` at its bottom; none when all are drawn or the Log is folded (§6.12) |
| No rate limits, MCP servers, sources or log | the section and its rule are left out |

### 6.12 Log height

The Log draws as many lines as fit under the blocks above it, at least 8 (`MIN_LOG_ROWS`), of the last 200 events,
newest first. A dim `+N more` line at its bottom counts the events it does not draw. The header's summary is the count
of every event, `max(logCount, lines held)`: a session that began on an earlier build has lines that its count never
saw. The first 8 lines always show. Folding another section gives the Log its room. When not even 8 lines fit, the pane
scrolls, and the engine does that. Where the body's height is not known (`bodyRows` 0), the Log draws 15 lines
(`MAX_LOG_ROWS`) at their natural height, in one Box, and then the `+N more` line.

- **How many lines fit** (`logLinesFit` in §6.10; the 0.4.0 spec, `2026-10-12-session-panel-v2-design.md`, §3.2):
  - `room = bodyRows − rows above − 2`, where the 2 are the Log's own rule and header;
  - if every event fits in `room`, the Log draws all of them, though never more than the 200 it holds;
  - otherwise it draws `max(8, room − 1)` lines, never more than the 200 it holds, and one row goes to the
    `+N more` line;
  - N is the total less the lines drawn. The line shows exactly when N is above 0, and never for a folded Log, which
    keeps its count in the header.
  - With room for more than 201 rows (the 200 lines the Log holds, and the `+N more` line), the rows that are left stay
    blank above `+N more`: a known limit.
- **The rows above.**
  - Every builder returns a `Block = { tree, rows }` (§5.4) and counts the rows from the very rows it puts in the tree,
    so that the two cannot part.
  - A rule and a section header take one row each (`RULE_ROWS`, `HEADER_ROWS`), measured on the desktop (the 0.4.0
    spec, §8.1). A folded section is its rule and header. A block that is left out is 0 rows.
  - The Subagents and the Tasks count a row for each row they draw, 8 at most (`MAX_AGENT_ROWS`), and one more for the
    `+N more` line when there is one (`statusSection`, §6.7). The Tasks block is left out, and so counts 0 rows, while
    there is no task.
  - The one estimate is the chips of MCP (`chipRows`, §6.8), because the layout engine wraps them: whole chips, greedy,
    over `bodyColumns − 2` (`CHIP_MARGIN_CELLS`), 2 cells apart (`CHIP_GAP_CELLS`). A chip is the dot's 2 cells and the
    name's, counted by code point: every code point above U+007F as 2 cells, a capital ASCII letter as 1.5 on the
    desktop, where the font is proportional, and as 1 in a terminal, whose cells are even (so a capital adds no spare
    row there), any other as 1, and the name's total rounded up (`nameCells`).
- **Errors go one way.**
  - A count that is too high leaves a spare row. It sits between the last Log line and `+N more`, since the tail's
    `flexGrow` takes the spare rows. When the Log has no tail or no `+N more` line, it is at the bottom of the pane.
  - A count that is too low draws a line past the rows there are. The tail clips it, and N is one short.
  - So the estimate errs high, and the tail stays as insurance.
  - Beyond 201 rows of room the spare rows are blank whatever the count says, since the Log holds 200 lines (above).
- **Structure** (the root is in §4, `logParts` in §6.10):
  - the root has `minHeight={bodyRows}`, and none when the height is not known;
  - the Log's rule, header, head and tail are direct children of the root, with no Box around them;
  - the head is a column Box with `flexShrink={0}` and the first 8 lines;
  - the tail is a column Box with `height={0}`, `flexGrow={1}`, `flexShrink={1}` and `overflow="hidden"`. It has no
    height of its own, grows into what the root leaves free, and cuts its lines at the bottom;
  - the `+N more` line (`moreLine`, §6.7) is a direct child of the root after the tail, with `flexShrink={0}`, and has
    the same indent as the Subagents' line.
- **The unit.** A desktop height cell is one text line, about 19 px, and `props.scroll.bodyRows` counts text lines
  (§2.1). The 8 px is the width of a cell, and what a margin of 1 adds; it does not hold for `height`.
- **The rules.** The rule above a section is one line high (`height={1}`, §5.1), so every block is a whole number of
  lines and the Log's last line is whole at the bottom of the pane. The rule was two margins and the 1 px line, 17 px,
  and each one cut 2 px off that line: with 6 or 7 rules, about a third of it (finding 1 of the 0.3.0 live check). The
  0.4.0 spike measured the fix on the desktop (§11, check 2; the 0.4.0 spec, §8.1): a rule, a section header and a chips
  row took one row each, and at `bodyRows` 65 exactly 65 rows of 19 px fit.
- **What the engine does.**
  - It scrolls a body that is taller than the pane, natively, with a scrollbar and the wheel.
  - A change of `bodyRows` alone re-runs `ui.render`, on every frame of a resize.
- **What did not work.** A root with `height="100%"` grows to its content: all 60 lines show, and the pane scrolls.
- **Not verified.** The 0.4.0 layout on the live desktop (the release's live check, the 0.4.0 spec, §3.4); the terminal
  (Ink/Yoga); the real pane at three heights, though the 0.3.0 live check saw it fill the pane (§11, check 10); and
  nested chains of growing Boxes, which the flat structure avoids.
- **Evidence.** Two live spikes on the desktop, engine 2.1.288, 2026-10-08, with a throwaway mod that drew numbered log
  lines and a footer line after them (the mod was deleted afterwards). Four of its modes matter:
  - B, a root with `height={bodyRows}` and a `flexGrow` log with `overflow="hidden"`, worked exactly: at `bodyRows` 65
    the footer touched the bottom edge, and the log's Box took exactly the rest and cut its extra lines at the bottom.
  - C, a root with `height="100%"`, did not work: it grew to its content (see "What did not work").
  - E, the structure above, worked: the footer touched the bottom edge and there was no scrollbar; the head showed
    lines 1–8 and the tail the rest (lines 9–53 at `bodyRows` 65). When another panel opened and took `bodyRows` from
    65 to 40, the footer came back to the bottom edge with no manual redraw: the render count rose from 292 to 337 in
    20 s.
  - F, E with 70 lines above the log, so that the content was taller than the body, worked: the root grew past the body
    and the pane scrolled natively, the head kept its 8 lines, and the tail collapsed to nothing.

## 7. Icons

All icons are 14 × 14 CSS px, drawn on a 14-unit grid with a 1.4 stroke, round caps and joins, and no fill unless stated. Section and row icons share this root:

```text
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#8a8a8a" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">…</svg>
```

`NEUTRAL` is the grey `#8a8a8a` of §3.1.

```ts
const ICON_ROOT =
  'xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none"' +
  ` stroke="${NEUTRAL}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"`
const icon = (body: string): string => `<svg ${ICON_ROOT}>${body}</svg>`
const dot = (cy: number): string => `<circle cx="2.25" cy="${cy}" r=".9" fill="${NEUTRAL}" stroke="none"/>`

const ICON: Record<SectionId | 'branch' | 'changes', string> = {
  // Usage: a stopwatch.
  usage: icon('<circle cx="7" cy="8" r="4.75"/><path d="M5.5 1.5h3M7 1.5v1.75M7 8V5.75"/>'),
  // Turn stats: a bar chart.
  turn: icon('<path d="M3.5 11.5v-4M7 11.5v-9M10.5 11.5v-6"/>'),
  // Subagents: a bot.
  agents: icon(
    '<rect x="2.5" y="4.75" width="9" height="7" rx="2"/><path d="M7 4.75V2.5H5M5.25 7.75v1.25M8.75 7.75v1.25"/>',
  ),
  // Tasks: a terminal.
  tasks: icon(
    '<rect x="1.5" y="2.5" width="11" height="9" rx="1.75"/><path d="M4.25 5.5 6 7l-1.75 1.5M7.25 8.5h2.5"/>',
  ),
  // MCP: a plug.
  mcp: icon(
    '<path d="M5.25 1.5v3M8.75 1.5v3M7 10.25v2.25"/><path d="M3.5 4.5h7v2.75a3 3 0 0 1-3 3h-1a3 3 0 0 1-3-3z"/>',
  ),
  // Context sources: layers.
  sources: icon(
    '<path d="M7 1.5 12.5 4.25 7 7 1.5 4.25z"/><path d="M1.5 7 7 9.75 12.5 7M1.5 9.75 7 12.5 12.5 9.75"/>',
  ),
  // Log: a list.
  log: icon(`<path d="M5 3.5h7M5 7h7M5 10.5h7"/>${dot(3.5)}${dot(7)}${dot(10.5)}`),
  // Branch: git-branch.
  branch: icon(
    '<path d="M4 1.75v7.5"/><circle cx="4" cy="11" r="1.75"/><circle cx="10" cy="3.5" r="1.75"/>' +
      '<path d="M10 5.25c0 2.75-2.25 3.75-4.6 4.4"/>',
  ),
  // Changes: a page with a pencil.
  changes: icon(
    '<path d="M5.5 12.5H4A1.5 1.5 0 0 1 2.5 11V3A1.5 1.5 0 0 1 4 1.5h3.5l3 3v1M7.5 1.5v2a1 1 0 0 0 1 1h2"/>' +
      '<path d="M6.25 11.5l-.5 1.75 1.75-.5 4-4a1.06 1.06 0 0 0-1.25-1.25z"/>',
  ),
}
```

The status icons of the Subagents and the Tasks are shape-coded, so colour is never the only cue: a half-filled
circle, a check, a cross, a stop square, and an empty ring for a task that is over with no known end (`ended`).

The block is an excerpt of `view.tsx`: `GREEN` is apart from the icons there.

```ts
const GREEN = '#2ea043' // the done icon: a theme key cannot reach an SVG

// Status icons, the Subagents' and the Tasks' alike, are shape-coded, so colour is never the only cue: a half-filled
// circle, a check, a cross, a stop square, and an empty ring for a task that is over with no known end.
const statusIcon = (color: string, inner: string): string =>
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">' +
  `<circle cx="7" cy="7" r="5.5" fill="none" stroke="${color}" stroke-width="1.4"/>${inner}</svg>`

const STATUS_SVG: Record<TaskStatus, string> = {
  running: statusIcon(BLUE, `<path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="${BLUE}"/>`),
  done: statusIcon(
    GREEN,
    `<path d="M4.6 7.2l1.7 1.7 3.2-3.5" fill="none" stroke="${GREEN}" stroke-width="1.4" stroke-linecap="round"` +
      ' stroke-linejoin="round"/>',
  ),
  failed: statusIcon(
    RED,
    `<path d="M5.1 5.1l3.8 3.8M8.9 5.1l-3.8 3.8" fill="none" stroke="${RED}" stroke-width="1.4"` +
      ' stroke-linecap="round"/>',
  ),
  stopped: statusIcon(NEUTRAL, `<rect x="5" y="5" width="4" height="4" rx=".75" fill="${NEUTRAL}"/>`),
  ended: statusIcon(NEUTRAL, ''),
}
```

The meter keeps `meterSvg(pct, widthPx)` exactly as it is, with its Desktop Statusline attribution.

## 8. The Context ring

The ring is 14 × 14, centred at (7, 7), with r = 5.5, stroke 2 and circumference C = 2πr = 34.5575.

- **Track:** always drawn, `#808080` at opacity 0.3, the same as the meter track.
- **Arc input:** p = `contextPct` clamped to [0, 100]. There is no arc when the reading is missing or not finite, or when p = 0.
- **Arc length:** L = p / 100 × C, written with 2 decimals.
- **Arc for p < 100:** the dash starts at 12 o'clock (`rotate(-90 7 7)`) and runs clockwise for L. The gap of C leaves exactly one dash.
- **Arc for p = 100:** a full circle, with no dasharray, so no hairline gap is left.
- **Colour:** `meterColor(p)`, so the ring and the meter always agree.

```ts
const RING_R = 5.5
const RING_C = 2 * Math.PI * RING_R

// The Context ring: a track, and an arc of the percent from 12 o'clock, clockwise, in the colour of the meter. No arc
// when there is no reading or the percent is 0; a full circle at 100, so no hairline gap is left. Butt caps keep the
// arc as long as the percent says.
export function ringSvg(pct: number | undefined): string {
  const p = pct === undefined || !Number.isFinite(pct) ? 0 : clampPct(pct)
  const circle = `<circle cx="7" cy="7" r="${RING_R}" fill="none"`
  const dash = p >= 100 ? '' : ` stroke-dasharray="${((p / 100) * RING_C).toFixed(2)} ${RING_C.toFixed(2)}"`
  const track = `${circle} stroke="#808080" stroke-opacity="0.3" stroke-width="2"/>`
  const arc = p > 0 ? `${circle} stroke="${meterColor(p)}" stroke-width="2"${dash} transform="rotate(-90 7 7)"/>` : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">${track}${arc}</svg>`
}
```

Example, 88.2 %:

```text
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="#808080" stroke-opacity="0.3" stroke-width="2"/><circle cx="7" cy="7" r="5.5" fill="none" stroke="#e0a030" stroke-width="2" stroke-dasharray="30.48 34.56" transform="rotate(-90 7 7)"/></svg>
```

Butt caps keep the arc honest: round caps would add a stroke-width to its visible length.

## 9. Truncation rules

| Row | Gives way first | Then | Never cut |
|---|---|---|---|
| Header | summary (ellipsis) | nothing | icon, title, chevron |
| Label/value | label (narrow panes only) | nothing | value |
| Context label row | `tokens / window` | nothing | ring, `Context` |
| Context meter row | the bar's Box clips, only if `CELL_PX` overestimates | nothing | percent |
| Limit row | countdown (ellipsis) and the bar's Box, in proportion | nothing | label (cut inside its own 7 cells), percent |
| Split line | its end (ellipsis) | nothing | nothing else on the row |
| Project header | the folder name (ellipsis, from the end) | nothing | `Project` |
| Branch row | the branch (ellipsis, from the end) | nothing | icon |
| Changes row | the label `N files changed` (ellipsis) | nothing | the numbers cell (`+A / −D`), icon |
| Subagent row | the `@type` column, which leaves every row when the description would keep fewer than 12 cells (§6.7) | description (ellipsis) | mark, cost |
| Task row | the `@kind` column, as the `@type` does (§6.7) | description (ellipsis) | mark, time (whole, or `—`) |
| MCP chip | the name, only when it alone is wider than the pane | nothing | the dot |
| Log row | text (ellipsis) | `who` leaves the row; then the outcome moves in front of the text (each below 8 cells of text, §6.10) | time, the outcome while it is a column; `who` cuts inside its own column |

The ellipsis is the surface's own, from `wrap="truncate"`. No string is shortened by hand for layout: `shorten()` in the
log formulas keeps up to 512 characters of a text (`LOG_TEXT_MAX`, from 0.4.3; before, 64 to 80), more than a line of a
pane maximized on a 21:9 monitor shows (about 400), and the surface cuts the line to its room. The texts that an agent
wrote (every Log line, the Subagents rows, the Tasks rows) are cleaned and masked before that (`stripFormat`, `redact`;
§12 item 9, and §4.7 of the main spec).

## 10. Terminal surface

| Element | Desktop | Terminal |
|---|---|---|
| Divider | 4096 × 1 px SVG in a clipping Box, one line high | `Text dimColor` of `'─'.repeat(bodyColumns)`, one row |
| Section icon, ring, branch, changes | `Svg` in a 2-cell slot | dropped (`iconSlot` returns null) |
| Project block | rule; bold `Project` + the folder name at the right; branch icon + branch; changes icon + `12 files changed`, the numbers at the right | text rule; `Project` + the folder name at the right; `🌿 main`; `📝 12 files changed`, the numbers at the right |
| Meter | `meterSvg` at the computed px width | ten cells of `▰▱` in the meter colours, as v1 |
| Status mark | 14 px icon, `alt` = status | glyph in a 1-cell Box: `◐` blue, `✓` success, `✗` error, `■` dim, `○` dim |
| `+N more` indent | 3 cells | 2 cells |
| `who` column | 13 cells | longest `who` among the lines drawn, ≤ 14 |
| `@type` column | 15 cells | longest drawn `@type`, ≤ 15 |
| `@kind` column | 10 cells | longest drawn `@kind`, ≤ 10 |
| Task time column | 8 cells, right-aligned | 8 cells, right-aligned |
| Outcome column | longest drawn outcome + 1 cell | longest drawn outcome |
| Header | `[icon] Title ▾ … summary` | `Title ▾ … summary`. The plain Button draws the glyph alone, and the focus inverts it (l.896–897, l.929–934). |

The chevron Button and the bold title are the same elements on both surfaces, so the tests drive one tree.

## 11. Accessibility, and checks on the live desktop

Accessibility:

- **Contrast.**
  - The icon grey and the status colours meet 3:1 against both themes (§3.1).
  - Amber is 2.3:1 on white. The meter colours are fixed by the user, and the percent beside the bar carries the value in the theme's `warning` colour, so the bar is never the only cue.
- **Status.** Statuses differ by shape as well as colour (§7).
- **Keyboard and target size.**
  - The chevron Buttons stay in the Tab order of the focused pane.
  - Each is a small target. Nothing else in a header is pressable, so the 24 px spacing exception of WCAG 2.5.8 applies.
- **Alt text.**
  - Meters keep their alt (`Context 88.2%`, `5-hour 3%`).
  - Status icons say their status.
  - Decorative icons carry the label of their row, and rules say `rule`: the desktop does not draw an Svg whose `alt` is empty.

Checks on the first live render, before the tests are frozen:

1. **Cell size.**
   - At the default width, the right end of the Context bar should sit about 16–32 px left of the `8` of `88.2%`, and no row should cross the pane's right edge.
   - If the bar's right end is cut off or touches the percent, `CELL_PX` is too big; if the gap is over 45 px, it is too small.
   - Either way, set `CELL_PX` to the body's px width ÷ `bodyColumns`.
2. **Rule spacing.** The rule is a Box one text line high, with the 1 px line centred in it (§5.1). Between the last row
   of a block and the next header there should be about 19 px of space, split by the 1 px line, and the Log's last line
   should be whole at the bottom of the pane, not cut by the rules above it (the 0.3.0 check saw about 2 px lost for
   each rule). If a strip remains, the next suspect is the Button's height in the section header (§5.4).
3. **Narrow pane.** Narrow the pane to about 300 px. No row crosses the edge, and descriptions, log text and summaries end in `…`. Costs and percents stay whole; `@type` and the log's `who` are either whole or left out (§6.7, §6.10).
4. **Empty alt.** If the transcript says a `ui.render` tree was refused and names `alt`, give each decorative icon the label of its row and the rule `alt="rule"`.
5. **Chevron.** It is dim at rest and full strength under the pointer. A click folds the section and the header keeps its summary.
6. **Lines separator.** On the desktop the changes row reads `+8 / −1`, with the spaces around the slash, not `+8/−1` (the no-break spaces of `LINES_SEP`, §6.3).
7. **Changes refresh.** The changes row updates about a second after an edit or a command by any agent. A read-only
   command such as `ls` does not trigger it. In a big repository it comes later: four times the last read, which counts
   at most a minute, so the wait is at most four minutes. An edit made outside Claude's tools (an editor, a terminal)
   shows within about a minute, with no new turn: the project is read on every second tick of the 30-second timer, while
   the pane is placed and shown. The Session pane alone is always shown (`isShown` names only the plugin pane in front,
   §4.1 of the main spec), so a session that is not in front reads too, unless the desktop unplaces its pane (check 13).
   Opening the pane reads at once, and so does `/session-panel`, which never closes the pane: on an open pane it asks to
   bring it forward. In a new session the changes row is absent until the first turn of the main agent: before it only
   the folder and the branch show.

Checks since Tasks 11 and 12, for the 0.3.0 release:

8. **The terminal under the new root.** The root has `minHeight` (§4), and Ink/Yoga has not been seen with it and with
   the Log's tail of `height={0}` (§6.12). Docked (110 columns or more) and inline: the Log reaches the bottom of the
   pane, and a pane too short for the head scrolls. If the terminal does not grow the tail, the hedge is `rows` 0 on the
   terminal, which draws the tree of 0.2.0.
9. **An abandoned call.** A tool call that is stopped (an agent on `sleep 120`, stopped after 20 s) logs a line that is
   not red, with its time alone as the outcome (`20.0s`) and no ✗ (§6.10). Look for that, not for a dim line: the text
   is drawn as on any line that is no error, and its `who` and outcome are dim. The same for a subagent stopped with
   `TaskStop`: does `next.signal` fire for it, and has it fired by the time `next(e)` returns the aborted result?
10. **The real pane at three sizes.** The spikes drew throwaway content, so the pane as the mod draws it has not been
    seen (§6.12). At three pane heights: the Log reaches the bottom edge, there is no scrollbar while the content fits,
    and folding a section grows the Log.
11. **The first frame.** If the engine hands `bodyRows` 0 on the first draw, the Log draws 15 lines in one Box until the
    next `bodyRows` (§6.12). See whether the change shows as a jump.
12. **A narrow pane, about 270 px.** The layout does not count the label (§6.10), so at the edge of a layout an engine
    line shows `engine › ` and may show none of its text. See how much of the text shows after `engine › `, beside the
    longest outcome.

Check since the review of Task 13, for the 0.3.1 release:

13. **A session in the background.** In the engine `isShown` names only which of a session's plugin panes is in front,
    so the Session pane alone is always shown (§4.1 of the main spec). With two desktop sessions open, does the
    background session's `$.ui.panes()` list the pane as placed and shown? And with a built-in tab of the desktop
    (Diff, Terminal) in front? If it does, that session keeps its minute read, as in 0.3.0, and finding 2 of the 0.3.0
    live check (every live session reads the tree once a minute) is not fixed.

Checks for the 0.5.0 release: the Tasks section (§4.5 of the 0.4–0.6 spec, `2026-10-12-session-panel-v2-design.md`),
three checks of 0.4.3 that were left for it, and four that the final review of 0.5.0 added (27 to 30):

14. **The three kinds of task.** A background `sleep 120`, a Monitor and a local Workflow in one session. Each gets a
    row in Tasks, after Subagents, with `@shell`, `@monitor` or `@workflow`, the blue running icon and a time that
    counts up (the pane redraws at least every 30 s). The header reads `running/total`, and the Log line of each call
    ends in `→ background`. When a task ends, its row shows the green check (done) or the red cross (failed) and its
    whole duration (a bound, `≤…`, when its notice came late: check 31), and the Log has `done · shell: …` (or
    `failed ·`) with the same time.
15. **TaskStop.** One running task stopped with TaskStop: its row turns to the grey stop square with the time it ran,
    and the Log has `stopped · …` with the time alone, not red. No notification comes for it (§8.5 of the 0.4–0.6 spec).
16. **Ctrl+B in a terminal.** A command moved to the background with Ctrl+B while it runs gets a row. Its time counts
    from the start of its call, not from the key press, and the wait for a permission prompt is in it. (On the desktop,
    Ctrl+B did not move a command to the background, and neither does a message: check 29.)
17. **The desktop's own task list.** Compare the background tasks only, since the desktop's list holds foreground calls
    and agents too. The outcomes agree. A shell task's time is exact when its notice came after the session had been
    idle for 3 s or more, and otherwise a bound (`≤`) that is not under the desktop's time.
18. **A timeout (the desktop).** A Bash command that runs past its timeout is killed (exit 143), and Tasks gets no row
    for it.
19. **A notice between turns.** A task that ends while no turn runs: its row closes, the Log has its end line, and the
    notice, which starts a turn of its own, shows as an `engine` line, `task-notification`, beside it.
20. **A Monitor notice.** The notification of a Monitor was never seen, and the pane reads it by the common format (§8.5
    of the 0.4–0.6 spec). Does its row close, and with which status and time?
21. **`@workflow` whole on the desktop.** The `@kind` column is 10 cells (80 px), an estimate (§6.7, §12 item 7). Is
    `@workflow` whole, and how much room is left? If it is cut, `TASK_TYPE_CELLS` is too small; if there is a lot of
    room, a narrower column gives the description more.
22. **The Tasks icon.** A terminal (§7) in its 2-cell slot beside the title, in the grey of the other icons, readable on
    dark and light, and told from the others.
23. **The terminal's ■ and ○.** In a terminal a stopped task and a stopped subagent are a dim `■`, and a failed one a
    red `✗`: the two differ by shape (§6.7). The dim `○` of `ended` cannot be seen yet, since nothing sets that status
    before 0.6.0; only the tests pin it.
24. **A pane maximized on a 21:9 monitor** (left from 0.4.3, §5.1 and §6.2). The rules between the sections reach the
    right edge, and the meters reach their values: the context meter its percent, a limit meter its countdown.
25. **A long Log line on a wide pane** (left from 0.4.3, §9). A line keeps up to 512 characters of its text, and the
    pane cuts it at its edge.
26. **A pasted ANSI-coloured text** (left from 0.4.3, §12 item 9). The pane stays, and the Log line reads as plain text,
    with no `[31m` left in it.
27. **A Monitor that prints several lines.** A Monitor whose command prints several lines before it exits has a notice
    for each line. The row stays running through them and closes once, when the Monitor ends.
28. **Two commands that end while the session is idle.** Two background commands that end while no turn runs: each
    notice comes as a prompt of its own and closes its own row (the parser reads one notification per text). Both rows
    close, and each has its end line in the Log.
29. **A message while a command runs (the desktop).** A message sent while a long foreground command runs waits until
    the command ends. Then the model takes it in, and its `you` line is written then. The command gets no row.
30. **A Workflow with a syntax error.** A Workflow whose script fails the syntax check (its result has a non-empty
    `error`) starts no task: there is no row, and its Log line ends in its time, not in `→ background`.

Checks for the 0.5.1 release (17, 18 and 29 above are written for the desktop 2.1.288, after the 0.5.0 live check):

31. **A late notice.** A background shell task that ends while a turn runs shows `≤…` in Tasks and `✓ ≤…` in the Log;
    one that ends with the session idle for 3 s or more shows an exact time.
32. **A message mid-turn.** A message typed while a turn runs gets one `you` line, when the model takes it in (the
    desktop) or at Enter (the terminal); a message still queued when the turn ends gets one line, not two.
33. **The mask (0.5.1).** In a prompt or a command, `"password": "hunter2secret"`,
    `Authorization: Token abcdefgh12345678` and `"Authorization": "Bearer abcdefgh12345678"` show masked in the Log, and
    a subagent's description with a token shows masked in Subagents. The escape cases (a token after a colour sequence,
    for one) are covered by the unit tests (`stats.test.ts`), as a prompt cannot carry a raw ESC from the composer.
34. **An engine tag.** A task's notice logs `engine` with `task-notification`; a prompt that starts with `<div>` logs
    `you`.
35. **Capitals in the terminal.** MCP servers with ASCII names in capitals leave no spare row in the terminal, where a
    capital counts one cell, as it is drawn (0.5.0 counted 1.5 and could leave one).

Results of the live renders (2026-10-07, 2026-10-08, 2026-10-09, 2026-10-12 and 2026-10-13):

1. Pass. At ~300 px the bar ends ~18 px left of the percent; `CELL_PX` 8 stays.
2. Pass for the rule of two margins: 12–14 px between the ink and the rule on each side, ≈ 17 px box to box. That rule
   was not a whole line: the 0.3.0 live check saw it cut 2 px off the Log's last line for each rule (finding 1, §6.12).
   The rule is one line high now (§5.1). Pass for that fix, in the 0.4.0 spike (2026-10-12): a rule took one row, and at
   `bodyRows` 65 exactly 65 rows of 19 px fit (the 0.4.0 spec, §8.1).
3. Pass. At ~300 px no row crosses the edge; descriptions and log text end in `…`. Since Task 8 the log's outcome column gives way when the text would keep fewer than 8 cells (about 40 columns on the desktop), so at ~300 px the log shows the outcome at the end of the text, by design.
   - Task 9 changed the narrow rules (§6.7, §6.10) and replaces the Task 8 rule above: in a narrow pane `who` gives way
     first, then the outcome moves in front of the text, and a subagent row drops `@type` when its description would
     keep fewer than 12 cells. By the constants, below about 40 columns on the desktop the log drops `who` and the
     subagent rows drop `@type`, and below about 26 the outcome moves in front of the text. These figures are computed;
     the live check of 0.2.0 (`docs/live-check-2026-10-08-0.2.0.md`) saw part of them. At about 355 px there is no `who`
     and the outcome is at the right. At about 270 px `@type` is gone, while the descriptions and the outcome show. The
     third layout, with the outcome in front of the text, was not reached at about 270 px.
4. The tree was not refused, but the desktop drew no Svg with an empty `alt`: the icons, the ring and the rules were
   missing while their slots stayed. Fixed by giving every Svg a label (commit eb28b17).
5. Pass. A click on the chevron folds the section, and the folded state survives a reload.
6. Pending.
7. Seen working in the 0.3.0 live check (2026-10-09):
   - a file made by a background process at about 14:09:20 showed in Project by 14:10 (`1 file changed  +3 / −0`),
     with no new turn;
   - 60 new files read `60 files changed  +50+ / −0`: the 50 counted, and the plus for the rest.
8. Pending. The 0.3.0 live check was on the desktop only.
9. Pass, in the 0.3.0 live check. A subagent stopped with `TaskStop` (`Bash sleep 120`, `28.8s`) and Esc on the main
   agent (`Bash sleep 30`, `4.6s`) each logged a line with the time alone, no ✗ and not red, while `Bash false` stayed
   red. So `next.signal` fires for both, and by the time `next(e)` returns the aborted result.
10. Partly, in the 0.3.0 live check. The Log filled the pane (33 lines instead of 15) and grew when a section was
    folded. Its last line was cut by the rules above it (finding 1): that is fixed (§5.1), and the 0.4.0 spike settled
    the fix (check 2). The three heights and the scrollbar were not recorded.
11. Pending. The 0.3.0 live check does not mention the first frame.
12. Seen in a narrow pane in the 0.3.0 live check: the lines read `you › …` and `engine › agent-message`. How much text
    follows `engine › ` at the edge of the layout was not recorded.
13. Answered in part by the 0.4.0 live check (2026-10-13): with the Terminal tab in front, a lone Session pane listed as
    placed and shown (the 0.4.0 command closed it), so its minute read goes on, and the person chose to keep it as it
    is. Two desktop sessions were not looked at.

Not checked in the 0.3.0 live check, or pending a look:

- the fix of finding 1, the rule one line high: settled by the 0.4.0 spike, exactly 65 rows of 19 px fit (check 2);
- the fold state after a restart;
- a pane behind another plugin pane of its session (`isShown: false`): the minute read now skips it, and
  `/session-panel` asks to bring it forward instead of closing it;
- a branch change, a detached HEAD, `git stash`, an edit of a tracked file, `N+ files changed` (a status over 4 MiB), a
  root outside git, a SHA-256 repository;
- Usage, `denied`, `/compact` and `/clear`.

## 12. Compromises forced by the API

1. **No bold or coloured Button label at rest.**
   - ButtonProps (l.900–992) has `dimColor`, and `hover` restyles the label only under the pointer (l.972–980).
   - So the bold title is a `Text`, and the fold control is a chevron-only Button. It is a small target, and its accessible name is `▾`/`▸`.
   - A `Markdown` link can be pressed too (l.5385–5422), but it draws as a link with paragraph spacing, so it was rejected.
2. **No per-side borders, no radius.**
   - BoxProps has only `borderStyle`, `borderColor` and `borderDimColor` (l.824–826). The d.ts has no `borderTop*`/`borderBottom*` and no `borderRadius`.
   - So rules are SVG images, and sections are not boxed. A full border would cost the terminal two rows and two columns per section.
3. **No tints.**
   - Box `backgroundColor` (l.827) has never been seen on the desktop.
   - An alpha tint like `#8080801a` could be refused by the validator, which would blank the whole pane, or painted opaque grey by the terminal.
   - So there are no section cards and no chip pills.
4. **SVG cannot follow the theme** (drawn as an image, l.11570–11577).
   - One mid grey serves both themes.
   - The done icon's `#2ea043` may differ slightly from the theme's `success` green used by Cache and the MCP dots.
5. **No font size or family** (TextProps l.11869–11887). Hierarchy is bold / primary / dim, plus spacing and icons; titles cannot be larger.
6. **Svg widths are px while layout is in cells.**
   - Meter widths depend on `CELL_PX` (check 1 in §11).
   - The dividers avoid the question by clipping.
   - The meters are wrapped in clipping Boxes, so an error cannot push a value out of the row.
7. **No `maxWidth`** (Box has `width`, `minWidth`, `height`, `minHeight` only; l.806–809). So `@type` sits in a column
   of fixed width (15 cells on the desktop, the longest drawn on the terminal, §6.7), and its text is cut inside that
   column. A task's `@kind` does the same: 10 cells on the desktop, an estimate that the 0.5.0 live check measures
   (§11, check 21), and the longest drawn on the terminal.
8. **Svg width and height are at most 4096 px.**
   - The engine refuses an Svg whose `width` or `height` prop is larger ("Svg width and height are pixels, at most
     4096", 2.1.288), and a refused tree makes it draw its own pane in place of the mod's. Only the props are checked,
     not the markup. The d.ts does not say so; `claude plugin test` shows it (found in 0.4.3, 2026-10-14).
   - So the rule and the meters stop at `SVG_MAX_PX`, and a pane wider than 4096 px gets a rule that ends short of its
     edge, a gap before the percent of the context meter, and one before the countdown of each limit meter.
9. **No control characters in a text.**
   - The engine refuses a text child that holds a C0 control (but tab, line feed and carriage return), DEL, a C1
     control or U+10EEEE (a placeholder of its own), and draws its own pane in place of the mod's.
   - So `stripFormat` removes them with the format characters (0.4.3): before, a prompt with an ANSI escape from
     pasted terminal output blanked the pane until its line left the Log. The vertical tab and the form feed are
     whitespace, so they become spaces; a lone surrogate goes too, so that no removal can join two halves into U+10EEEE.
     An escape sequence goes whole, so a coloured log reads as its text and no tail of it sticks to a word that the mask
     looks for (until 0.5.1 only a CSI and an OSC with its terminator went whole): a control string (OSC, DCS, SOS, PM,
     APC; 7-bit with ESC or 8-bit with one C1 character) up to its BEL, `ESC \` or U+009C on the same line; a CSI
     (7-bit, or 8-bit with a parameter or an intermediate byte); an nF escape (`ESC ( B`, which `tput sgr0` ends in); a
     two-byte escape (ESC and one of `7 8 = > [ \ ] ^ _`). A stray ESC or U+009B goes alone, and a control string that
     nothing ends on its line loses its introducer only (the ESC alone, for `ESC P` and `ESC X`: the letter stays).

## 13. Test impact (view.test.tsx)

These tests encode v1's tree and need updating with the implementation:

| Test / helper | Change |
|---|---|
| `headers()` | Button labels are now `▾`/`▸`. Read the bold title `Text` in the same header row instead. |
| `summaries()` | The header row's children are [icon slot (desktop only)], title Box, Button, summary Box. The summary is the `Text` in the last child. |
| Header assertions | Buttons are still `toggle:<id>`, six (seven with tasks), all `plain`. Add `dimColor === true`. |
| Project block | The project is no longer in the top block. Header: the bold `Project` and the dim folder name, no Button, no icon. Branch row: Svg + Text on the desktop, `🌿 master` on the terminal. Changes row: Svg + label + the three Texts of `linesCell` on the desktop, `📝 12 files changed` + the numbers on the terminal; `1 file changed` for one. Left out: no name, no block; no branch, no branch row; no changes, no row; no lines or both 0, no numbers. |
| Svg lists (alts, widths) | Filter to meters (`alt` matching `/%$/`). Icons and rules carry their row's label, and statuses have `alt` = status. Meter alts are unchanged. |
| Empty pane | The desktop now draws the ring track. Assert "no meter" (no Svg with a `%` alt) instead of "no Svg". |
| Meter widths | `meterWidth` becomes `contextMeterWidth` and `limitMeterWidth` (§6.2, §6.5). |
| `markCells()` | `marksOf(tree)`: Svg (`alt` = status) in a 2-cell slot; terminal: a 1-cell Box with `◐ ✓ ✗ ■ ○`. |
| `listRows()` | The rows of a list with a status mark; `agentRows` and `taskRows` tell the lists by the value cell. |
| `logColumns()` | The time `Text` sits in an 8-cell Box. The row is [time Box, who Box, text Box, outcome Box]; the `who` Box and the outcome Box are there only in the layouts that draw them (§6.10); `who` is 13 cells on the desktop. |
| MCP | `● name` in `success` becomes `Text '● '` in `success` + `Text 'name'` with no colour. |

## 14. d.ts references

| Topic | Lines |
|---|---|
| BoxProps (flex, gap, width/minWidth, margins, padding, border trio, backgroundColor, overflow) | 741–830 |
| Box `key` = hover scope | 742–750 |
| ButtonProps; terminal draws plain label alone, desktop a native button | 892–992 (896–897, 929–934) |
| Button `dimColor` | 937–941 |
| Element tables: terminal without `Svg`, desktop with | 3594–3627 |
| `MarkdownProps` (pressable links, rejected) | 5385–5422 |
| Pane `bodyColumns` | 9646–9649 |
| RenderViewport: remote cells from the code font | 9697–9704 |
| SvgProps (image, px, `alt` required) | 11570–11605 |
| TextHoverProps (bold only on hover) | 11845–11863 |
| TextProps (`color` key or raw, `dimColor`, `bold`, `wrap`) | 11865–11887 |
| A tree that does not validate is not drawn (reference.md) | 97–100 |
