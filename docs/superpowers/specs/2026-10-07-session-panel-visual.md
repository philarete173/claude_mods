# Session Panel: visual spec v2

> Changes after the approved preview: every Svg carries a non-empty alt (§5.2, §11); the subagent `@type` sits in a column of its own (§6.7); the log's `who` column is 13 cells on the desktop. The HTML preview `docs/design/session-panel-preview.html` stays the approved v2 mock-up and predates these changes.

Date: 2026-10-07. Status: proposal. The user approves the look in `docs/design/session-panel-preview.html` before implementation.

Scope: presentation only. The sections, their content, the formats and every formula of `2026-10-07-session-panel-design.md` §3–§4 stay as they are. Where the two specs differ on looks, this one replaces §3.1 of the main spec. Engine 2.1.288. "d.ts" below means `plugin-authoring/types/claude-code.d.ts` of that engine, cited by line.

## 1. Decisions at a glance

1. **Block separation.** Blocks are separated the OpenChamber way:
   - a 1 px rule with 8 px of space above and below;
   - then a header row: line icon, **bold title**, dim chevron, and a dim summary pushed to the right.
2. **No row can outgrow the pane.** Every row is built from fixed cells (`flexShrink={0}`, width in cells) and at most two flexible cells (`flexShrink={1}` + `minWidth={0}` + `overflow="hidden"`, text `wrap="truncate"`).
3. **Columns that must line up have fixed cell widths:** time, who, status mark, subagent `@type`, cost, percent and limit label. Nothing is aligned by character count.
4. **Icons.** 14 px line icons share one neutral grey, `#8a8a8a`, readable on dark and light. The Context ring draws the percent in the meter's colours. Subagent status icons are shape-coded.
5. **The top block is a header card:**
   - Session and the total;
   - Context with its ring and `tokens / window`;
   - a meter row ending in the percent;
   - the cost split;
   - after 8 px, project and branch.
6. **The terminal draws the same tree without any `Svg`:** text rules, `▰▱` meters, glyph marks and the `📁`/`🌿` line.

```text
Session                                           $148.59
◔  Context                                    529k / 600k
▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▭▭▭▭▭       88.2%
Session $123.23 · Subagents $25.36
                                                              8 px
▭  claude_mods                                      ⑂  main
──────────────────────────────────────────────────────────    8 px · 1 px rule · 8 px
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
22:09:07  minimal-change  Edit .claude-plugin/marketplace.j…
```

## 2. Ground rules

### 2.1 Units: cells, and what a cell is on the desktop

- **Box numbers are character cells** (BoxProps, d.ts l.741–830).
- **On a remote surface, a cell comes from the code font:** "the pane's width and height over the advance and line height of its code font" (RenderViewport, l.9698–9704). `props.bodyColumns` is "Cells across the body, inside the frame" (l.9646–9649).
- **Measured on the live desktop (`current-pane-v1.png`), 1 cell = 8 px**, horizontally and vertically:
  - `width={8}` + `columnGap={1}` put the meter 72 px from the left edge;
  - `width={1}` + `columnGap={1}` put the subagent descriptions 16 px in;
  - `marginTop={1}` adds about 8 px over the 19 px line.
- **The old "12.5 px per column" was a planning guess.** v1 cannot refute it, because its meter is clamped at 180 px either way.
- **`CELL_PX = 8`** is used only to turn `bodyColumns` into the px widths of the meters. §11 says how to confirm it once.
- **`Svg` `width` and `height` are CSS px** (l.11588–11595).

### 2.2 Surfaces

`renderPane` already drops the terminal's stub `Svg` (`Svg` is `undefined` there). In this spec, "desktop" means `d.ui.Svg !== undefined` and "terminal" means the rest. The desktop element table has `Svg` (l.3616–3627); the terminal table has none (l.3595–3615). §9 lists what the terminal draws instead.

### 2.3 The no-overflow rule

**This rule fixes the subagent and log rows that ran past the pane.** A flex item cannot shrink below its content width unless its `minWidth` is 0. v1 never set it, so its "truncating" boxes never shrank.

Every horizontal row is `<Box flexDirection="row">`, and each child is one of two kinds:

| Kind | Props | Holds |
|---|---|---|
| FIXED | `flexShrink={0}`; `width={n}` in cells when it is a column | icons, titles, values, percents, costs, times, the `who` column, the subagent `@type` column |
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
| Declared in the d.ts, first used here | `minWidth`, `overflow`, `flexGrow`, `alignItems`, `marginBottom`, `paddingLeft`, `flexWrap`, `Button` `dimColor` (l.937–941) |
| Deliberately not used | `backgroundColor`, `borderStyle`, `borderColor` (§12) |

No `key` on list Boxes. On a `Box`, `key` makes a hover scope (l.742–750), and v1 does not use it either. Button keys stay `toggle:<SectionId>`.

## 3. Tokens

### 3.1 Colour

Text uses theme keys, so it follows the app's theme (TextProps: "Colors are a theme key or a raw color", l.11867).

| Role | Prop | Where |
|---|---|---|
| Primary | none | titles, labels, values, descriptions, names, log text, the total |
| Secondary | `dimColor` | header summaries, the cost split, `tokens / window`, `@type`, time, `who`, countdowns, `+N more`, empty-state text, `—` |
| Threshold | `color="warning"` from 80 %, `color="error"` from 95 % | context and limit percents (unchanged) |
| Good | `color="success"` | Cache from 50 % (unchanged); the MCP dot |
| Error | `color="error"` | `who` of a log entry of kind `error` |

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
| Title | `bold` | `Session`, the six section titles. Nothing else is bold. |
| Primary | none | everything a person reads for a value |
| Secondary | `dimColor` | everything that explains a value |

### 3.3 Spacing (cells; desktop px in brackets)

| Token | Cells | Use |
|---|---|---|
| `GAP` | 1 (8 px) | icon slot → text; between the columns of a log, subagent or limit row; title → chevron; meter → percent |
| `GAP_WIDE` | 2 (16 px) | the least room between a label and its value in space-between rows; between MCP chips; project ↔ branch |
| `RULE_MARGIN` | 1 (8 px) | above and below each divider (desktop only) |
| `BLOCK_GAP` | 1 (8 px) | above the project row (desktop only) |
| row gap | 0 | rows stack at the text line (~19 px on the desktop) |

Rhythm on the desktop:

- rows inside a block are 19 px apart;
- between blocks there is 8 px + 1 px rule + 8 px, so the last row of a block and the next header are 36 px apart instead of 19.

### 3.4 Sizes and constants (drop-in for view.tsx)

```ts
// Layout, in cells: the unit of Box numbers. On the desktop a cell is CELL_PX wide (spec §2.1).
const CELL_PX = 8 // measured on the desktop; confirm once (spec §11)
const ICON_PX = 14 // every icon, CSS px
const ICON_CELLS = 2 // the slot an icon sits in; text after it starts 3 cells in
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
const TEXT_METER_CELLS = 10 // unchanged
const RULE_PX = 1600 // the divider image; the Box around it cuts it to the pane
const MAX_AGENT_ROWS = 8 // unchanged
const MAX_LOG_ROWS = 15 // unchanged
```

`Draw` gains the body width and the two meter widths, and loses `meterPx`:

```ts
type Draw = { ui: Kit; data: PaneData; handlers: PaneHandlers; cols: number; contextMeterPx: number; limitMeterPx: number }

// in renderPane:
const cols = props.bodyColumns
const d: Draw = { ui: { Box, Text, Button, Svg }, data, handlers, cols,
  contextMeterPx: contextMeterWidth(cols), limitMeterPx: limitMeterWidth(cols) }
```

## 4. Pane skeleton

```tsx
<Box flexDirection="column">
  {topBlock(d)}        {/* never folds; no rule above it */}
  {usageSection(d)}    {/* each section begins with its own rule, so a hidden section leaves no double rule */}
  {turnSection(d)}
  {agentsSection(d)}
  {mcpSection(d)}
  {sourcesSection(d)}
  {logSection(d)}
</Box>
```

The pane frame (title "Session", expand and close controls, outer padding, scroll) belongs to the app and is not ours.

## 5. Shared pieces

### 5.1 Divider

```tsx
const RULE_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${RULE_PX}" height="1" viewBox="0 0 ${RULE_PX} 1"` +
  ` preserveAspectRatio="none"><rect width="${RULE_PX}" height="1" fill="#808080" fill-opacity="0.35"/></svg>`

// The rule above a section: an image in a Box that cuts it to the pane, with room around it. The terminal draws a text
// rule, one row, as v1's blank line was. The desktop draws no Svg whose alt is empty, so the rule says `rule`.
function divider(d: Draw): RenderElement {
  const { Box, Text, Svg } = d.ui
  if (Svg === undefined) return <Text dimColor wrap="truncate">{'─'.repeat(Math.max(0, d.cols))}</Text>

  return (
    <Box flexDirection="row" marginTop={1} marginBottom={1} overflow="hidden">
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

Every Svg needs a non-empty `alt`. The desktop draws no image whose `alt` is empty: the validator accepts it, the image is dropped, and its slot stays (found on the first live render, §11 check 4). A decorative icon carries the label of its row: a section icon its title, the ring `Context`, the folder `Project`, the branch `Branch`. The rule says `rule`.

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
function section(d: Draw, id: SectionId, title: string, summary: string, body: RenderElement[]): RenderElement {
  const { Box, Text, Button } = d.ui
  const isFolded = d.data.collapsed[id] === true

  return (
    <Box flexDirection="column">
      {divider(d)}
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        {iconSlot(d, ICON[id], title)}
        <Box flexDirection="row" flexShrink={0}>
          <Text bold>{title}</Text>
        </Box>
        <Button
          plain
          dimColor
          key={`toggle:${id}`}
          label={isFolded ? '▸' : '▾'}
          onPress={() => d.handlers.onToggle(id)}
        />
        {endText(d, summary, { dimColor: true })}
      </Box>
      {!isFolded && <Box flexDirection="column">{body}</Box>}
    </Box>
  )
}
```

- **Title.** Bold `Text`, because a Button label cannot be bold (§12.1).
- **Chevron.** A `plain` `dimColor` Button placed after the title, as in OpenChamber. It is dim at rest and full strength under the pointer or the focus (l.937–941). A one-glyph plain label is a control in its own right (l.929–934).
- **Summary.** Pushed right and cut before it can collide with the title. A folded section keeps its summary.
- **Body.** No extra gap between the header and the body.

## 6. Blocks

### 6.1 Top block

```tsx
function topBlock(d: Draw): RenderElement {
  const { Box, Text } = d.ui
  const { usage, project, agents } = d.data
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
        <Text dimColor wrap="truncate">{`Session ${fmtUsd(split.session)} · Subagents ${fmtUsd(split.subagents)}`}</Text>
      )}
      {project.name !== '' && projectRow(d)}
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

### 6.3 Project row (inside the top block)

```tsx
function projectRow(d: Draw): RenderElement {
  const { Box, Svg } = d.ui
  const { name, branch } = d.data.project
  const group = (iconSvg: string, alt: string, emoji: string, text: string): RenderElement => (
    <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={1} minWidth={0} overflow="hidden">
      {Svg === undefined ? shrinkText(d, `${emoji} ${text}`) : [iconSlot(d, iconSvg, alt), shrinkText(d, text)]}
    </Box>
  )

  return (
    <Box flexDirection="row" justifyContent="space-between" columnGap={2} marginTop={Svg === undefined ? 0 : 1}>
      {group(ICON.folder, 'Project', '📁', name)}
      {branch !== null && group(ICON.branch, 'Branch', '🌿', branch)}
    </Box>
  )
}
```

- The project sits at the left and the branch at the right.
- Both groups can shrink. The longer name gives way more, because the shrink is shared in proportion to width.
- The 8 px above the row sets project and branch apart from the session figures, without a rule. The card stays one block.

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
    <Box flexDirection="row" alignItems="center" columnGap={1}>
      {Svg === undefined ? (
        <Box flexDirection="row" width={1} flexShrink={0}>
          <Text color={mark.color} dimColor={mark.isDim}>
            {mark.glyph}
          </Text>
        </Box>
      ) : (
        iconSlot(d, STATUS_SVG[agent.status], agent.status)
      )}
      <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden" columnGap={1}>
        {growText(d, agent.description)}
        <Box flexDirection="row" width={typeCells} flexShrink={0} overflow="hidden">
          <Text dimColor wrap="truncate">{`@${shortType(agent.type)}`}</Text>
        </Box>
      </Box>
      <Box flexDirection="row" width={COST_CELLS} flexShrink={0} justifyContent="flex-end">
        {agent.costUsd === null ? <Text dimColor>—</Text> : <Text>{fmtUsd(agent.costUsd)}</Text>}
      </Box>
    </Box>
  )
}

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
  const rows = shown.map(agent => agentRow(d, agent, typeCells))
  const more = agents.length - MAX_AGENT_ROWS
  if (more > 0) {
    // The icon slot and its gap on the desktop, the one-cell mark and its gap on the terminal.
    rows.push(
      <Box flexDirection="row" paddingLeft={Svg === undefined ? 2 : 3}>
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
3. **`@type`** (FIXED, `typeCells` wide).
   - Desktop: `TYPE_CELLS`, 15 cells (120 px). The cut types `@frontend-deve…` and `@minimal-chang…` measure about 111 px on the live pane.
   - Terminal: the longest `@type` drawn, at most `TYPE_CELLS_MAX` (15).
4. **Cost** (FIXED, `COST_CELLS`, 7 cells, right-aligned). Costs line up on their right edge, and every description ends at the same x.

In a pane too narrow for the type column, every description is 0 wide and the group clips the column at the same x on every row.

The status icon's `alt` is the status word (`running`, `done`, `failed`, `stopped`): the icon is the only place that says it.

**"+N more"** aligns with the descriptions:

```tsx
<Box flexDirection="row" paddingLeft={Svg === undefined ? 2 : 3}>
  <Text dimColor>{`+${more} more`}</Text>
</Box>
```

On the desktop, 3 cells = the 2-cell icon slot + the 1-cell gap. On the terminal, 2 cells = the 1-cell mark + the 1-cell gap.

### 6.8 MCP chips

```tsx
const chips = mcp.servers.map(server => (
  <Box flexDirection="row" flexShrink={1} minWidth={0} overflow="hidden">
    <Box flexDirection="row" flexShrink={0}>
      <Text color={OK}>{'● '}</Text>
    </Box>
    {shrinkText(d, server.name)}
  </Box>
))
return section(d, 'mcp', 'MCP', String(mcp.servers.length), [
  <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
    {chips}
  </Box>,
])
```

- **Dot and name.** Only the dot is green; the name is primary text. This is less noise than v1's all-green names, and the dot still says "connected".
- **No-break space.** The ` ` keeps one space between the dot and the name. A plain space at the end of a flex item may be dropped by the desktop's whitespace rules.
- **Wrapping.** Chips wrap whole. A single name wider than the pane goes on its own line and is cut.

### 6.9 Context sources

`row(d, 'Skills', …)` and `row(d, 'MCP servers', …)`; summary unchanged (`77 skills · 5 MCP`).

### 6.10 Log row

```tsx
const lines = d.data.log.slice(0, MAX_LOG_ROWS)
const longest = Math.max(...lines.map(line => line.who.length))
const whoCells = Svg === undefined ? Math.min(WHO_CELLS_MAX, longest) : WHO_CELLS
const rows = lines.map(line => (
  <Box flexDirection="row" columnGap={1}>
    <Box flexDirection="row" width={TIME_CELLS} flexShrink={0}>
      <Text dimColor>{fmtClock(line.at)}</Text>
    </Box>
    <Box flexDirection="row" width={whoCells} flexShrink={0} overflow="hidden">
      {line.kind === 'error'
        ? <Text color={BAD} wrap="truncate">{line.who}</Text>
        : <Text dimColor wrap="truncate">{line.who}</Text>}
    </Box>
    <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
      <Text wrap="truncate">{line.text}</Text>
    </Box>
  </Box>
))
return section(d, 'log', 'Log', '', rows)
```

- **Time and `who`** are fixed columns.
  - Every text starts at the same x: 8 + 1 + 13 + 1 = 23 cells = 184 px on the desktop.
  - Proportional digits can no longer move the columns.
  - The `who` column no longer shrinks with the text beside it. It did in v1, which moved the text column row to row.
- **Weight.** Time and `who` are dim, so the text carries the row. An error `who` is red.
- **`who` width per surface.**
  - Desktop: a constant 13 cells, so the text column does not jump when the longest `who` changes.
  - Terminal: v1's longest-visible `who`, capped at 14.

### 6.11 Empty and partial states

| State | Drawn |
|---|---|
| No context reading | empty ring + `Context` + dim `—` at the right; no meter row (§6.2) |
| No total cost | `Session` alone on the first row; no split line |
| No subagents | no split line; no Subagents section (and no rule for it) |
| No completed turn | Turn stats header with no summary, body `No completed turn yet` (dim) |
| No project name | no project row; no branch → the folder group alone |
| Subagent cost unknown | dim `—` in the cost column |
| More than 8 subagents | `+N more` (§6.7) |
| No rate limits, MCP servers, sources or log | the section and its rule are left out |

## 7. Icons

All icons are 14 × 14 CSS px, drawn on a 14-unit grid with a 1.4 stroke, round caps and joins, and no fill unless stated. Section and row icons share this root:

```text
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#8a8a8a" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">…</svg>
```

```ts
const NEUTRAL = '#8a8a8a'
const ICON_ROOT = `xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="${NEUTRAL}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"`
const icon = (body: string): string => `<svg ${ICON_ROOT}>${body}</svg>`
const dot = (cy: number): string => `<circle cx="2.25" cy="${cy}" r=".9" fill="${NEUTRAL}" stroke="none"/>`

const ICON: Record<SectionId | 'folder' | 'branch', string> = {
  // Usage: a stopwatch.
  usage: icon('<circle cx="7" cy="8" r="4.75"/><path d="M5.5 1.5h3M7 1.5v1.75M7 8V5.75"/>'),
  // Turn stats: a bar chart.
  turn: icon('<path d="M3.5 11.5v-4M7 11.5v-9M10.5 11.5v-6"/>'),
  // Subagents: a bot.
  agents: icon('<rect x="2.5" y="4.75" width="9" height="7" rx="2"/><path d="M7 4.75V2.5H5M5.25 7.75v1.25M8.75 7.75v1.25"/>'),
  // MCP: a plug.
  mcp: icon('<path d="M5.25 1.5v3M8.75 1.5v3M7 10.25v2.25"/><path d="M3.5 4.5h7v2.75a3 3 0 0 1-3 3h-1a3 3 0 0 1-3-3z"/>'),
  // Context sources: layers.
  sources: icon('<path d="M7 1.5 12.5 4.25 7 7 1.5 4.25z"/><path d="M1.5 7 7 9.75 12.5 7M1.5 9.75 7 12.5 12.5 9.75"/>'),
  // Log: a list.
  log: icon(`<path d="M5 3.5h7M5 7h7M5 10.5h7"/>${dot(3.5)}${dot(7)}${dot(10.5)}`),
  // Project: a folder.
  folder: icon('<path d="M1.5 3.75c0-.55.45-1 1-1h2.6l1.4 1.5h5c.55 0 1 .45 1 1v5.5c0 .55-.45 1-1 1h-9c-.55 0-1-.45-1-1z"/>'),
  // Branch: git-branch.
  branch: icon('<path d="M4 1.75v7.5"/><circle cx="4" cy="11" r="1.75"/><circle cx="10" cy="3.5" r="1.75"/><path d="M10 5.25c0 2.75-2.25 3.75-4.6 4.4"/>'),
}
```

Subagent status icons are shape-coded, so colour is never the only cue: a half-filled circle, a check, a cross, a stop square.

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

export function ringSvg(pct: number | undefined): string {
  const p = pct === undefined || !Number.isFinite(pct) ? 0 : clampPct(pct)
  const track = `<circle cx="7" cy="7" r="${RING_R}" fill="none" stroke="#808080" stroke-opacity="0.3" stroke-width="2"/>`
  const dash = p >= 100 ? '' : ` stroke-dasharray="${((p / 100) * RING_C).toFixed(2)} ${RING_C.toFixed(2)}"`
  const arc = p > 0
    ? `<circle cx="7" cy="7" r="${RING_R}" fill="none" stroke="${meterColor(p)}" stroke-width="2"${dash} transform="rotate(-90 7 7)"/>`
    : ''

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
| Project row | the longer of project and branch | the other | icons |
| Subagent row | description (ellipsis) | the `@type` column, clipped by the group at the same x on every row (panes too narrow for it) | mark, cost |
| MCP chip | the name, only when it alone is wider than the pane | nothing | the dot |
| Log row | text (ellipsis) | nothing | time; `who` cuts inside its own column |

The ellipsis is the surface's own, from `wrap="truncate"`. No string is shortened by hand for layout: `shorten()` in the log formulas is content and stays as it is.

## 10. Terminal surface

| Element | Desktop | Terminal |
|---|---|---|
| Divider | 1600 × 1 px SVG in a clipping Box, 8 px above and below | `Text dimColor` of `'─'.repeat(bodyColumns)`, no margins (one row, as v1's blank line was) |
| Section icon, ring, folder, branch | `Svg` in a 2-cell slot | dropped (`iconSlot` returns null) |
| Project row | folder + name … branch icon + branch, 8 px above | `📁 name` … `🌿 branch`, as v1, no margin |
| Meter | `meterSvg` at the computed px width | ten cells of `▰▱` in the meter colours, as v1 |
| Status mark | 14 px status icon, `alt` = status | v1 glyphs in a 1-cell Box: `◐` blue, `✓` success, `✗` error, `✗` dim |
| `+N more` indent | 3 cells | 2 cells |
| `who` column | 13 cells | longest visible `who`, ≤ 14 |
| `@type` column | 15 cells | longest drawn `@type`, ≤ 15 |
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
2. **Rule spacing.** Between the last row of a block and the next header there should be about 17 px of space, split by the 1 px line. If it is about 35 px, the image is being laid out in a text line: drop the divider Box's `marginTop` and `marginBottom` to 0.
3. **Narrow pane.** Narrow the pane to about 300 px. No row crosses the edge, and descriptions, log text and summaries end in `…`. Costs, percents and `@type` stay whole.
4. **Empty alt.** If the transcript says a `ui.render` tree was refused and names `alt`, give each decorative icon the label of its row and the rule `alt="rule"`.
5. **Chevron.** It is dim at rest and full strength under the pointer. A click folds the section and the header keeps its summary.

Results of the live renders (2026-10-07 and 2026-10-08):

1. Pass. At ~300 px the bar ends ~18 px left of the percent; `CELL_PX` 8 stays.
2. Pass. 12–14 px between the ink and the rule on each side, ≈ 17 px box to box.
3. Pass. At ~300 px no row crosses the edge; descriptions and log text end in `…`.
4. The tree was not refused, but the desktop drew no Svg with an empty `alt`: the icons, the ring and the rules were missing while their slots stayed. Fixed by giving every Svg a label (commit c5f73d1).
5. Pass. A click on the chevron folds the section, and the folded state survives a reload.

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
| Top block (desktop) | `📁 online_shop` and `🌿 master` become Svg + `Text 'online_shop'` / `'master'`. The terminal is unchanged. |
| Svg lists (alts, widths) | Filter to meters (`alt` matching `/%$/`). Icons and rules carry their row's label, and statuses have `alt` = status. Meter alts are unchanged. |
| Empty pane | The desktop now draws the ring track. Assert "no meter" (no Svg with a `%` alt) instead of "no Svg". |
| Meter widths | `meterWidth` becomes `contextMeterWidth` and `limitMeterWidth` (§6.2, §6.5). |
| `markCells()` | Desktop marks are Svg in a 2-cell slot. The terminal is unchanged (1-cell Box with `◐ ✓ ✗`). |
| `logColumns()` | The time `Text` sits in an 8-cell Box. The row is [time Box, who Box, text Box]; `who` is 13 cells on the desktop. |
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
