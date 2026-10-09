# Session Panel: visual spec v2

> Changes after the approved preview: every Svg carries a non-empty alt (§5.2, §11); the subagent `@type` sits in a
> column of its own (§6.7); the log's `who` column is 13 cells on the desktop; in a narrow pane the log drops `who`
> first and a subagent row drops `@type` below 12 description cells (§6.7, §6.10); the project is a block of its own,
> with a changes row (§6.3); a count that is only a lower bound has a plus, but a lower bound of no lines has no numbers
> (§6.3); in a narrow log a prompt reads `you › …` and an engine message `engine › …` (§6.10); the Log fills the pane's
> free height, 8 lines at least (§6.12); the rule above a section is one line high, with no margins (§5.1). The HTML
> preview `docs/design/session-panel-preview.html` stays the approved v2 mock-up and predates these changes.

Date: 2026-10-07. Status: implemented and shipped (0.3.1). The user approved the look in
`docs/design/session-panel-preview.html` before implementation.

Scope: presentation only. The sections, their content, the formats and every formula of `2026-10-07-session-panel-design.md` §3–§4 stay as they are. Where the two specs differ on looks, this one replaces §3.1 of the main spec. Engine 2.1.288. "d.ts" below means `plugin-authoring/types/claude-code.d.ts` of that engine, cited by line.

## 1. Decisions at a glance

1. **Block separation.** Blocks are separated the OpenChamber way:
   - a 1 px rule, centred in a box one text line high, so it has room above and below it;
   - then a header row: line icon, **bold title**, dim chevron, and a dim summary pushed to the right.
2. **No row can outgrow the pane.** Every row is built from fixed cells (`flexShrink={0}`, width in cells) and at most two flexible cells (`flexShrink={1}` + `minWidth={0}` + `overflow="hidden"`, text `wrap="truncate"`).
3. **Columns that must line up have fixed cell widths:** time, who, log outcome, status mark, subagent `@type`, cost, percent and limit label. Nothing is aligned by character count.
4. **Icons.** 14 px line icons share one neutral grey, `#8a8a8a`, readable on dark and light. The Context ring draws the percent in the meter's colours. Subagent status icons are shape-coded.
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
≡  Log ▾
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
| Title | `bold` | `Session`, `Project`, the six section titles. Nothing else is bold. |
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
const TIME_CELLS = 8 // `22:09:07`
// The desktop widths of an agent type are measured on the live pane, in the app's own font. In the log,
// `minimal-change` takes about 96 px: 13 cells (104 px) keep it whole. In a subagent row the widest `@type` is a cut
// one, `@frontend-deve…` or `@minimal-chang…`, about 111 px: 15 cells (120 px) keep it whole, with a margin.
const WHO_CELLS = 13 // desktop: the `who` of the log
const WHO_CELLS_MAX = TYPE_MAX // terminal: the longest `who` that shortType keeps
const TYPE_CELLS = 15 // desktop: the `@type` of a subagent
const TYPE_CELLS_MAX = TYPE_MAX + 1 // terminal: the `@` and the longest type that shortType keeps
const TEXT_METER_CELLS = 10
const RULE_PX = 1600 // the divider image; the Box around it cuts it to the pane
const MAX_AGENT_ROWS = 8
// The Log keeps at least this many lines, and when they do not fit the pane scrolls (the user's decision, 2026-10-08),
// as the Subagents list shows up to 8.
const MIN_LOG_ROWS = 8
// The lines the Log draws where the body's height is not known; where it is, the body's rows (MIN_LOG_ROWS at least).
const MAX_LOG_ROWS = 15
const MIN_LOG_TEXT_CELLS = 8 // the least text a log line keeps: below it `who` gives way, then the outcome column
// In a narrow pane the identity column gives way first, as in the log: a subagent row leaves out its `@type`, on
// every row, when the description would keep fewer cells than this beside it.
const MIN_AGENT_DESC_CELLS = 12
const LOG_GAP_CELLS = 1 // the gap between the cells of a log row
const AGENT_GAP_CELLS = 1 // the gap between the cells of a subagent row, and between those of its group
const AGENT_ROW_GAPS = 3 // the gaps of a subagent row that has its type: two between its cells, one in its group
const TEXT_MARK_CELLS = 1 // the mark of a subagent row where there is no icon slot
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
  return (
    <Box flexDirection="column" minHeight={d.rows > 0 ? d.rows : undefined}>
      {topBlock(d)}
      {projectBlock(d)}
      {usageSection(d)}
      {turnSection(d)}
      {agentsSection(d)}
      {mcpSection(d)}
      {sourcesSection(d)}
      {logParts(d)}
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

- The line is wider than any pane, and its `overflow="hidden"` Box cuts it at the body's edge. No px estimate is involved.
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

// A section: a rule, then its header row, then the body unless folded. A folded section keeps its summary.
function section(d: Draw, id: SectionId, title: string, summary: string, body: RenderElement[]): RenderElement {
  const { Box } = d.ui

  return (
    <Box flexDirection="column">
      {divider(d)}
      {sectionHeader(d, id, title, summary)}
      {!isFolded(d, id) && <Box flexDirection="column">{body}</Box>}
    </Box>
  )
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
function topBlock(d: Draw): RenderElement {
  const { Box, Text } = d.ui
  const { usage, agents } = d.data
  const subagentsUsd = Object.values(agents).reduce((sum, agent) => sum + (agent.costUsd ?? 0), 0)
  const split = splitCost(usage.costUsd, subagentsUsd)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Box flexDirection="row" flexShrink={0}>
          <Text bold>Session</Text>
        </Box>
        {split.total !== null && (
          <Box flexDirection="row" flexShrink={0}>
            <Text>{fmtUsd(split.total)}</Text>
          </Box>
        )}
      </Box>
      {contextRows(d)}
      {split.session !== null && split.subagents > 0 && (
        <Text dimColor wrap="truncate">
          {`Session ${fmtUsd(split.session)} · Subagents ${fmtUsd(split.subagents)}`}
        </Text>
      )}
    </Box>
  )
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
// The context meter shares its row with the percent only: the body less the 1-cell gap and PCT_CELLS.
export function contextMeterWidth(bodyColumns: number): number {
  return Math.min(560, Math.max(48, (bodyColumns - 7) * CELL_PX))
}
```

At the default width (≈ 45 columns) this gives 304 px. The bar ends about 25 px before the `8` of `88.2%`: the 8 px gap, the 0–7 px left over by `bodyColumns`, and the room `88.2%` leaves in its 6 cells.

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
// numbers when the lines are unknown or are none (only binary files changed).
function projectBlock(d: Draw): RenderElement | null {
  const { Box, Text, Svg } = d.ui
  // A value that an earlier build left in the state has no `changes`: it has none to show.
  const { name, branch, changes = null } = d.data.project
  if (name === '') return null
  const marked = (emoji: string, text: string): string => (Svg === undefined ? `${emoji} ${text}` : text)

  return (
    <Box flexDirection="column">
      {divider(d)}
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        <Box flexDirection="row" flexShrink={0}>
          <Text bold>Project</Text>
        </Box>
        {endText(d, name, { dimColor: true })}
      </Box>
      {branch !== null && (
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          {iconSlot(d, ICON.branch, 'Branch')}
          {shrinkText(d, marked('🌿', branch))}
        </Box>
      )}
      {changes !== null && (
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          {iconSlot(d, ICON.changes, 'Changes')}
          {growText(d, marked('📝', filesLabel(changes)))}
          {changes.lines !== null && changes.lines.added + changes.lines.removed > 0 && linesCell(d, changes.lines)}
        </Box>
      )}
    </Box>
  )
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
// A limit meter shares its row with the label, the percent and the countdown: 7 + 1 + 1 + 5 + 1 + 9 + 1 spare cells.
export function limitMeterWidth(bodyColumns: number): number {
  return Math.min(240, Math.max(40, (bodyColumns - 25) * CELL_PX))
}
```

At ≈ 45 columns this gives 160 px. Limit meters line up with each other: same label width, same meter width. The countdown is right-aligned and dim. A kind with no label of its own (raw `kind`) is cut inside its 7 cells.

### 6.6 Turn stats

Same rows and the same summary as v1, drawn with `row()` (§6.4); Cache stays `success` from 50 %. With no completed turn, the body is `shrinkText(d, 'No completed turn yet', { dimColor: true })`, so a narrow pane cuts it instead of wrapping it, and the summary is empty.

### 6.7 Subagent row

```tsx
function agentRow(d: Draw, agent: AgentRow, typeCells: number): RenderElement {
  const { Box, Text, Svg } = d.ui
  const mark = AGENT_MARKS[agent.status]

  return (
    <Box flexDirection="row" alignItems="center" columnGap={AGENT_GAP_CELLS}>
      {Svg === undefined ? (
        <Box flexDirection="row" width={TEXT_MARK_CELLS} flexShrink={0}>
          <Text color={mark.color} dimColor={mark.isDim}>
            {mark.glyph}
          </Text>
        </Box>
      ) : (
        iconSlot(d, STATUS_SVG[agent.status], agent.status)
      )}
      <Box
        flexDirection="row"
        flexGrow={1}
        flexShrink={1}
        minWidth={0}
        overflow="hidden"
        columnGap={AGENT_GAP_CELLS}
      >
        {growText(d, agent.description)}
        {typeCells > 0 && (
          <Box flexDirection="row" width={typeCells} flexShrink={0} overflow="hidden">
            <Text dimColor wrap="truncate">{`@${shortType(agent.type)}`}</Text>
          </Box>
        )}
      </Box>
      <Box flexDirection="row" width={COST_CELLS} flexShrink={0} justifyContent="flex-end">
        {agent.costUsd === null ? <Text dimColor>—</Text> : <Text>{fmtUsd(agent.costUsd)}</Text>}
      </Box>
    </Box>
  )
}
```

```tsx
function agentsSection(d: Draw): RenderElement | null {
  const { Box, Text, Svg } = d.ui
  const agents = orderAgents(Object.values(d.data.agents))
  if (agents.length === 0) return null
  const running = agents.filter(agent => agent.status === 'running').length
  const summary = running > 0 ? `${running}/${agents.length}` : String(agents.length)
  const shown = agents.slice(0, MAX_AGENT_ROWS)
  // One width for the type column of every row, as for the `who` of the log: the terminal takes the longest `@type`
  // that is drawn, the desktop a width of its own.
  const longest = Math.max(...shown.map(agent => `@${shortType(agent.type)}`.length))
  const typeCells = Svg === undefined ? Math.min(TYPE_CELLS_MAX, longest) : TYPE_CELLS
  // What the description keeps beside the type: the body less the mark, the type, the cost and the gaps of a row. With
  // less than MIN_AGENT_DESC_CELLS the type is left out of every row.
  const markCells = Svg === undefined ? TEXT_MARK_CELLS : ICON_CELLS
  const descCells = d.cols - markCells - typeCells - COST_CELLS - AGENT_ROW_GAPS * AGENT_GAP_CELLS
  const hasType = descCells >= MIN_AGENT_DESC_CELLS
  const rows = shown.map(agent => agentRow(d, agent, hasType ? typeCells : 0))
  const more = agents.length - MAX_AGENT_ROWS
  if (more > 0) {
    // The line starts where the descriptions do: after the mark and its gap.
    rows.push(
      <Box flexDirection="row" paddingLeft={markCells + AGENT_GAP_CELLS}>
        <Text dimColor>{`+${more} more`}</Text>
      </Box>,
    )
  }

  return section(d, 'agents', 'Subagents', summary, rows)
}
```

The row has four columns. The description and the `@type` column sit in one group, between the mark and the cost:

1. **Status mark** (FIXED).
2. **Description** (FLEX, grows: `growText`). It takes the rest of the row, so the `@type` column starts at the same x on every row.
3. **`@type`** (FIXED, `typeCells` wide), while the description keeps room beside it (below).
   - Desktop: `TYPE_CELLS`, 15 cells (120 px). The cut types `@frontend-deve…` and `@minimal-chang…` measure about 111 px on the live pane.
   - Terminal: the longest `@type` drawn, at most `TYPE_CELLS_MAX` (15).
4. **Cost** (FIXED, `COST_CELLS`, 7 cells, right-aligned). Costs line up on their right edge, and every description ends at the same x.

**In a narrow pane the type gives way first**, as `who` does in the log (§6.10). `agentsSection` works out what a description would keep beside the type: the body less the mark (`markCells`: `ICON_CELLS` on the desktop, `TEXT_MARK_CELLS` on the terminal), the type column, `COST_CELLS` and the gaps of the row (`AGENT_ROW_GAPS` of `AGENT_GAP_CELLS` each: two between the cells and one in the group). With fewer than `MIN_AGENT_DESC_CELLS` (12) cells the type column leaves every row, not some of them: `agentRow` gets `typeCells` 0, and the description takes the whole group. The choice is made once per section, so every description still ends at the same x.

The status icon's `alt` is the status word (`running`, `done`, `failed`, `stopped`): the icon is the only place that says it.

**"+N more"** aligns with the descriptions:

```tsx
    // The line starts where the descriptions do: after the mark and its gap.
    rows.push(
      <Box flexDirection="row" paddingLeft={markCells + AGENT_GAP_CELLS}>
        <Text dimColor>{`+${more} more`}</Text>
      </Box>,
    )
```

The line starts at `markCells` + `AGENT_GAP_CELLS`, where the descriptions start whether or not the type column is drawn. On the desktop that is 3 cells = the 2-cell icon slot + the 1-cell gap. On the terminal it is 2 cells = the 1-cell mark + the 1-cell gap.

### 6.8 MCP chips

```tsx
function mcpSection(d: Draw): RenderElement | null {
  const { Box, Text } = d.ui
  const { mcp } = d.data
  if (mcp === null || mcp.servers.length === 0) return null
  const chips = mcp.servers.map(server => (
    <Box flexDirection="row" flexShrink={1} minWidth={0} overflow="hidden">
      <Box flexDirection="row" flexShrink={0}>
        <Text color={OK}>{DOT}</Text>
      </Box>
      {shrinkText(d, server.name)}
    </Box>
  ))

  return section(d, 'mcp', 'MCP', String(mcp.servers.length), [
    <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      {chips}
    </Box>,
  ])
}
```

- **Dot and name.** Only the dot is green; the name is primary text. This is less noise than v1's all-green names, and the dot still says "connected".
- **No-break space.** `DOT` is the dot and a no-break space (`'●\u00a0'`), so one space stays between the dot and the name. A plain space at the end of a flex item may be dropped by the desktop's whitespace rules.
- **Wrapping.** Chips wrap whole. A single name wider than the pane goes on its own line and is cut.

### 6.9 Context sources

`row(d, 'Skills', …)` and `row(d, 'MCP servers', …)`; summary unchanged (`77 skills · 5 MCP`).

### 6.10 Log row

```tsx
// The Log, as the parts of the pane's root: its rule, its header and its lines, with no Box around them. That is the
// layout the live desktop has verified, and it needs no chain of Boxes that grow (the visual spec, §6.12 Log height).
// Folded, it is the rule and the header; with no lines, nothing.
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
// The height: the lines drawn are the body's rows, MIN_LOG_ROWS at least, for a line past them could never show. The
// first MIN_LOG_ROWS are the head, a Box that holds its height, so they always show. The rest are the tail, a Box with
// no height of its own that grows into the rows the root leaves free (it is at least the body's height) and clips at
// its bottom, so the oldest lines go first. When not even the head fits, the root grows to its content and the pane
// scrolls, which the engine does. Where the body's height is not known the lines are MAX_LOG_ROWS, in one Box at their
// natural height: a tail would have no room to grow into.
function logParts(d: Draw): RenderElement[] {
  const { Box, Text, Svg } = d.ui
  const lines = d.data.log.slice(0, d.rows > 0 ? Math.max(MIN_LOG_ROWS, d.rows) : MAX_LOG_ROWS)
  if (lines.length === 0) return []
  const rule = divider(d)
  const header = sectionHeader(d, 'log', 'Log', '')
  if (isFolded(d, 'log')) return [rule, header]
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
  if (d.rows === 0) return [rule, header, <Box flexDirection="column">{lineRows}</Box>]
  const parts = [rule, header, <Box flexDirection="column" flexShrink={0}>{lineRows.slice(0, MIN_LOG_ROWS)}</Box>]
  if (lineRows.length > MIN_LOG_ROWS) {
    parts.push(
      <Box flexDirection="column" height={0} flexGrow={1} flexShrink={1} overflow="hidden">
        {lineRows.slice(MIN_LOG_ROWS)}
      </Box>,
    )
  }

  return parts
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
- **Outcome.** The mark and the time of an action (`✓ 0.3s`, `✗ 0.3s`), or `denied`, in a column of its own at the right edge of the row. A subagent's result has one too: `✓ 1m 12s`, `✗ 1m 12s`, or the time alone for a stop, which is no fault.
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
- **Red text.** The last layout has neither a `who` nor an outcome cell to carry the red of an error, so the text of an error line is red there. In the other layouts the text stays primary.
- **Labels.** Where the layout has no `who` cell (layouts 2 and 3), a line of the person (`you`) reads `you › …`, and a
  line of the engine (`engine`: a tagged message such as `agent-message`) reads `engine › …`: its text alone does not
  say whose it is. The other lines have no label. In [time, text] a line's outcome still comes first, and the label
  follows it. The layout does not count the label: `MIN_LOG_TEXT_CELLS` counts the text alone, so at the edge of a
  layout an engine line shows its label and none of its text. Where `who` has given way, a subagent's type has no
  column and no label, so it is visible nowhere in the Log but in its `spawned · type: …` line, if the cut does not
  take it: a known limit (finding 11 of the 0.3.0 live check).
- **Columns.** The `who` and outcome columns are worked out from the longest `who` and the longest outcome among the
  lines drawn. Those may be more than the lines shown (§6.12), so a long outcome lower down can make `who` give way for
  every row. The rule stays: one layout for the head and the tail is what keeps their columns in line.
- **Abandoned call.** A tool call that came back as an error while its call had been abandoned (the person interrupted
  it, or a stop did) is a note, not a fault. It is kind `info`, so it is not red: its text is drawn as on any line that
  is no error, its `who` and outcome are dim as on every such line, and its outcome is the time alone, with no ✗, as a
  stopped subagent's result does. This rests on the engine's `next.signal` (`ran.isError` and `next.signal.aborted`
  after `await next(e)`), and was seen live for a subagent stopped with `TaskStop` and for Esc on the main agent, while
  a call that fails by itself stays red (§11, check 9).

### 6.11 Empty and partial states

| State | Drawn |
|---|---|
| No context reading | empty ring + `Context` + dim `—` at the right; no meter row (§6.2) |
| No total cost | `Session` alone on the first row; no split line |
| No subagents | no split line; no Subagents section (and no rule for it) |
| No completed turn | Turn stats header with no summary, body `No completed turn yet` (dim) |
| No project name | no Project block (§6.3) |
| No branch | the Project block without the branch row |
| No repository, a clean tree, a failed git, or changes not read yet or given up (§6.3) | no changes row |
| A status over 4 MiB | `N+ files changed` with no numbers (§6.3) |
| New files not all counted | `+2061+ / −4`; with no line counted, no numbers, as in the next row (§6.3) |
| Lines unknown (an unborn HEAD, a failed diff) or both 0 (only binary files changed) | the changes row with the count alone, no numbers |
| Subagent cost unknown | dim `—` in the cost column |
| More than 8 subagents | `+N more` (§6.7) |
| No rate limits, MCP servers, sources or log | the section and its rule are left out |

### 6.12 Log height

The Log draws as many lines as the pane's body has rows, at least 8 (`MIN_LOG_ROWS`), of the last 60 events, newest
first. The first 8 always show. The rest fill the height that the other blocks leave, and are cut at the bottom, so the
oldest go first. Folding another section gives the Log its room. When not even 8 lines fit, the pane scrolls, and the
engine does that. Where the body's height is not known (`bodyRows` 0), the Log draws 15 lines (`MAX_LOG_ROWS`) at their
natural height, in one Box, as 0.2.0 did.

- **Structure** (the root is in §4, `logParts` in §6.10):
  - the root has `minHeight={bodyRows}`, and none when the height is not known;
  - the Log's rule, header, head and tail are direct children of the root, with no Box around them;
  - the head is a column Box with `flexShrink={0}` and the first 8 lines;
  - the tail is a column Box with `height={0}`, `flexGrow={1}`, `flexShrink={1}` and `overflow="hidden"`. It has no
    height of its own, grows into what the root leaves free, and cuts its lines at the bottom.
- **The unit.** A desktop height cell is one text line, about 19 px, and `props.scroll.bodyRows` counts text lines
  (§2.1). The 8 px is the width of a cell, and what a margin of 1 adds; it does not hold for `height`.
- **The rules.** The rule above a section is one line high (`height={1}`, §5.1), so every block is a whole number of
  lines and the Log's last line is whole at the bottom of the pane. The rule was two margins and the 1 px line, 17 px,
  and each one cut 2 px off that line: with 6 or 7 rules, about a third of it (finding 1 of the 0.3.0 live check). A
  look at the fix on the desktop is pending (§11, check 2). If a strip remains, the next suspect is the Button's height
  in the section header.
- **What the engine does.**
  - It scrolls a body that is taller than the pane, natively, with a scrollbar and the wheel.
  - A change of `bodyRows` alone re-runs `ui.render`, on every frame of a resize.
- **What did not work.** A root with `height="100%"` grows to its content: all 60 lines show, and the pane scrolls.
- **Not verified.** The terminal (Ink/Yoga); the real pane at three heights, though the 0.3.0 live check saw it fill the
  pane (§11, check 10); the Log's last line since the rule became one line high (§11, check 2); and nested chains of
  growing Boxes, which the flat structure avoids.
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

Subagent status icons are shape-coded, so colour is never the only cue: a half-filled circle, a check, a cross, a stop square.

The block is an excerpt of `view.tsx`: `GREEN` is apart from the icons there, and its long lines are wrapped.

```ts
const GREEN = '#2ea043'
const statusIcon = (color: string, inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">` +
  `<circle cx="7" cy="7" r="5.5" fill="none" stroke="${color}" stroke-width="1.4"/>${inner}</svg>`

const STATUS_SVG: Record<AgentStatus, string> = {
  running: statusIcon(BLUE, `<path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="${BLUE}"/>`),
  done: statusIcon(GREEN, `<path d="M4.6 7.2l1.7 1.7 3.2-3.5" fill="none" stroke="${GREEN}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`),
  failed: statusIcon(RED, `<path d="M5.1 5.1l3.8 3.8M8.9 5.1l-3.8 3.8" fill="none" stroke="${RED}" stroke-width="1.4" stroke-linecap="round"/>`),
  stopped: statusIcon(NEUTRAL, `<rect x="5" y="5" width="4" height="4" rx=".75" fill="${NEUTRAL}"/>`),
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
| MCP chip | the name, only when it alone is wider than the pane | nothing | the dot |
| Log row | text (ellipsis) | `who` leaves the row; then the outcome moves in front of the text (each below 8 cells of text, §6.10) | time, the outcome while it is a column; `who` cuts inside its own column |

The ellipsis is the surface's own, from `wrap="truncate"`. No string is shortened by hand for layout: `shorten()` in the log formulas is content and stays as it is.

## 10. Terminal surface

| Element | Desktop | Terminal |
|---|---|---|
| Divider | 1600 × 1 px SVG in a clipping Box, one line high | `Text dimColor` of `'─'.repeat(bodyColumns)`, one row |
| Section icon, ring, branch, changes | `Svg` in a 2-cell slot | dropped (`iconSlot` returns null) |
| Project block | rule; bold `Project` + the folder name at the right; branch icon + branch; changes icon + `12 files changed`, the numbers at the right | text rule; `Project` + the folder name at the right; `🌿 main`; `📝 12 files changed`, the numbers at the right |
| Meter | `meterSvg` at the computed px width | ten cells of `▰▱` in the meter colours, as v1 |
| Status mark | 14 px status icon, `alt` = status | v1 glyphs in a 1-cell Box: `◐` blue, `✓` success, `✗` error, `✗` dim |
| `+N more` indent | 3 cells | 2 cells |
| `who` column | 13 cells | longest `who` among the lines drawn, ≤ 14 |
| `@type` column | 15 cells | longest drawn `@type`, ≤ 15 |
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
   Opening the pane reads at once, and so does `/session-panel` on a pane that is not shown, which it asks to bring
   forward instead of closing it. In a new session the changes row is absent until the first turn of the main agent:
   before it only the folder and the branch show.

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

Results of the live renders (2026-10-07, 2026-10-08 and 2026-10-09):

1. Pass. At ~300 px the bar ends ~18 px left of the percent; `CELL_PX` 8 stays.
2. Pass for the rule of two margins: 12–14 px between the ink and the rule on each side, ≈ 17 px box to box. That rule
   was not a whole line: the 0.3.0 live check saw it cut 2 px off the Log's last line for each rule (finding 1, §6.12).
   The rule is one line high now (§5.1), and a look at the fix on the desktop is pending.
3. Pass. At ~300 px no row crosses the edge; descriptions and log text end in `…`. Since Task 8 the log's outcome column gives way when the text would keep fewer than 8 cells (about 40 columns on the desktop), so at ~300 px the log shows the outcome at the end of the text, by design.
   - Task 9 changed the narrow rules (§6.7, §6.10) and replaces the Task 8 rule above: in a narrow pane `who` gives way
     first, then the outcome moves in front of the text, and a subagent row drops `@type` when its description would
     keep fewer than 12 cells. By the constants, below about 40 columns on the desktop the log drops `who` and the
     subagent rows drop `@type`, and below about 26 the outcome moves in front of the text. These figures are computed;
     the live check of 0.2.0 (`docs/live-check-2026-10-08-0.2.0.md`) saw part of them. At about 355 px there is no `who`
     and the outcome is at the right. At about 270 px `@type` is gone, while the descriptions and the outcome show. The
     third layout, with the outcome in front of the text, was not reached at about 270 px.
4. The tree was not refused, but the desktop drew no Svg with an empty `alt`: the icons, the ring and the rules were missing while their slots stayed. Fixed by giving every Svg a label (commit c5f73d1).
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
    folded. Its last line was cut by the rules above it (finding 1): that is fixed (§5.1), and a look at the fix is
    pending (check 2). The three heights and the scrollbar were not recorded.
11. Pending. The 0.3.0 live check does not mention the first frame.
12. Seen in a narrow pane in the 0.3.0 live check: the lines read `you › …` and `engine › agent-message`. How much text
    follows `engine › ` at the edge of the layout was not recorded.
13. Pending. The review before 0.3.1 read the engine's source (CLI 2.1.295); no desktop has been looked at.

Not checked in the 0.3.0 live check, or pending a look:

- the fix of finding 1, the rule one line high: the Log's last line has not been looked at since (check 2);
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
7. **No `maxWidth`** (Box has `width`, `minWidth`, `height`, `minHeight` only; l.806–809). So `@type` sits in a column of fixed width (15 cells on the desktop, the longest drawn on the terminal, §6.7), and its text is cut inside that column.

## 13. Test impact (view.test.tsx)

These tests encode v1's tree and need updating with the implementation:

| Test / helper | Change |
|---|---|
| `headers()` | Button labels are now `▾`/`▸`. Read the bold title `Text` in the same header row instead. |
| `summaries()` | The header row's children are [icon slot (desktop only)], title Box, Button, summary Box. The summary is the `Text` in the last child. |
| Header assertions | Buttons are still `toggle:<id>`, six of them, all `plain`. Add `dimColor === true`. |
| Project block | The project is no longer in the top block. Header: the bold `Project` and the dim folder name, no Button, no icon. Branch row: Svg + Text on the desktop, `🌿 master` on the terminal. Changes row: Svg + label + the three Texts of `linesCell` on the desktop, `📝 12 files changed` + the numbers on the terminal; `1 file changed` for one. Left out: no name, no block; no branch, no branch row; no changes, no row; no lines or both 0, no numbers. |
| Svg lists (alts, widths) | Filter to meters (`alt` matching `/%$/`). Icons and rules carry their row's label, and statuses have `alt` = status. Meter alts are unchanged. |
| Empty pane | The desktop now draws the ring track. Assert "no meter" (no Svg with a `%` alt) instead of "no Svg". |
| Meter widths | `meterWidth` becomes `contextMeterWidth` and `limitMeterWidth` (§6.2, §6.5). |
| `markCells()` | Desktop marks are Svg in a 2-cell slot. The terminal is unchanged (1-cell Box with `◐ ✓ ✗`). |
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
