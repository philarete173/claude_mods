# Session Panel: план реализации

> **Для исполнителей:** план выполняется задачами через superpowers:subagent-driven-development. Шаги отмечены чекбоксами (`- [ ]`). Каждая задача читается вместе со спецификацией, а раздел «Глобальные ограничения» входит в требования каждой задачи.

**Цель:** мод Claude Code с боковой панелью живой статистики сессии для вкладки Code приложения Claude Desktop.

**Архитектура:**
- События движка обновляют атомы `$.state`, панель `Pane` перерисовывается при их изменении.
- Формулы и форматы вынесены в чистый модуль `stats.ts`, связь с событиями — в `register.tsx`, отрисовка — в `view.tsx`.
- Первая задача — одноразовый спайк, который проверяет допущения API на живом десктопе.

**Стек:** TypeScript/TSX hooks-модуль Claude Code (function hooks API движка 2.1.288), `claude plugin test` и `claude plugin validate`.

**Спецификация:** `docs/superpowers/specs/2026-10-07-session-panel-design.md`. Номера разделов ниже (§N) ссылаются на неё.

## Глобальные ограничения

- **Корень репозитория:** `/home/philarete/projects/claude_mods`. Мод лежит в `plugins/session-panel/`.
- **Типы API** (движок 2.1.288):
  - `/tmp/claude-1000/bundled-skills/2.1.288/2f4ee0d234c5e813b450256be851c0db/plugin-authoring/types/claude-code.d.ts`; файл большой, искать grep'ом по имени;
  - рядом лежат `reference.md` и `examples/` (`pane.tsx`, `pane-state.d.ts`, `band.tsx`, `tool-call.ts`);
  - после первой загрузки мода движок кладёт копию типов в `<папка мода в dev-mods>/.claude-plugin/types/claude-code/index.d.ts`.
- **Хуки только наблюдают.** Каждый хук возвращает результат `next(e)` без изменений. Нельзя возвращать `deny`, переписывать вход или подменять результат.
- **Чего мод не делает:**
  - сеть: `fetch`, `$.http` под запретом;
  - чтение токенов, ключей и `$.env`;
  - `$.settings`, `$.model`;
  - запись на диск, кроме `$.store`. Исключение — временный файл спайка `.spike/results.json` в задаче 1.
- **Git:** только `['git', 'branch', '--show-current']` и `['git', 'rev-parse', '--short', 'HEAD']`, с параметрами `{ cwd: root, timeoutMs: 5000 }`.
- **Язык:** подписи интерфейса и комментарии в коде на английском.
- **Идентификаторы:**
  - id панели `session-panel`, заголовок `Session`;
  - команда `/session-panel`;
  - ключ `$.store` — `collapsed`;
  - `SectionId` — один из `usage`, `turn`, `agents`, `mcp`, `sources`, `log`.
- **Лимиты:**
  - журнал хранит 60 записей, показывает 15, новые сверху;
  - список субагентов — до 8 строк, затем `+N more`;
  - скорость выше 5000 tok/s превращается в `null`.
- **Цвета шкалы:** `#2f7de1`, с 80% `#e0a030`, с 95% `#e5484d`; дорожка `#808080` с `fill-opacity 0.3`; высота 8px, `rx=4`.
- **Форматы:** §3.2 спецификации, байт в байт.
- **Стоимость:** только из движка, по приросту `cost.usd` (§4.4). Таблиц цен и сети нет.
- **Горячая перезагрузка.** После каждой правки исполнитель синхронизирует копию:
  ```bash
  rsync -a --delete --exclude '.claude-plugin/types/' /home/philarete/projects/claude_mods/plugins/session-panel/ /home/philarete/.claude/dev-mods/bcaecb67-a219-4453-b027-9e930232ca47/session-panel/
  ```
  Движок перезагружает мод в конце хода главного агента.
- **Git-коммиты исполнители не делают.** Коммитит главный агент после ревью и только с разрешения пользователя.

## Карта файлов

| Файл | Ответственность | Задача |
|---|---|---|
| `.claude-plugin/marketplace.json` | маркетплейс `claude-mods` с одним плагином | 1 |
| `.gitignore` | `.spike/`, `plugins/*/.claude-plugin/types/`, `node_modules/` | 1 |
| `LICENSE` | MIT | 1 |
| `plugins/session-panel/.claude-plugin/plugin.json` | манифест мода (в задаче 3 добавляется `types`) | 1, 3 |
| `plugins/session-panel/hooks/hooks.json` | `{ "modules": ["./register.tsx"] }` | 1 |
| `plugins/session-panel/hooks/register.tsx` | в задаче 1 спайк; в задаче 3 события → атомы, команда, открытие панели, таймер | 1, 3, 4 |
| `plugins/session-panel/hooks/stats.ts` | чистые функции: типы, формулы, распределение стоимости, журнал, форматы, `redact` | 2 |
| `plugins/session-panel/hooks/stats.test.ts` | unit-тесты `stats.ts` | 2 |
| `plugins/session-panel/types/index.d.ts` | контракт `PluginState['session-panel']` | 3 |
| `plugins/session-panel/hooks/state.ts` | атомы `$.state` (`atom(...)`), общие для `register.tsx` и `view.tsx` | 3 |
| `plugins/session-panel/hooks/register.test.ts` | тесты связки: сворачивание в store, команда, открытие | 3 |
| `plugins/session-panel/hooks/view.tsx` | `renderPane`, `meterSvg`, секции, кнопки сворачивания | 4 |
| `plugins/session-panel/hooks/view.test.tsx` | тесты отрисовки на desktop и terminal | 4 |
| `README.md` | описание, установка, разработка, авторство | 5 |

---

### Задача 1: каркас репозитория и спайк

**Файлы:**
- Создать: `.claude-plugin/marketplace.json`, `.gitignore`, `LICENSE`, `plugins/session-panel/.claude-plugin/plugin.json`, `plugins/session-panel/hooks/hooks.json`.
- Создать (временно, задача 3 его заменит): `plugins/session-panel/hooks/register.tsx`.

**Интерфейсы:**
- Даёт: пробы пишут файл `/home/philarete/projects/claude_mods/.spike/results.json` в формате ниже. Его читает главный агент.

- [ ] **Шаг 1. Манифесты.**
  - **`marketplace.json`:** `name: "claude-mods"`, `owner.name` из `git config user.name`, а если имя не задано, то `"philarete"`; один плагин `session-panel` с `source: "./plugins/session-panel"`, `version: "0.1.0"` и описанием «Live session stats side pane for the Claude desktop Code tab». Схему сверить с `claude plugin validate`.
  - **`plugin.json`:** `{ "name": "session-panel", "version": "0.1.0", "description": "<то же>" }`.
  - **`hooks.json`:** `{ "modules": ["./register.tsx"] }`.
  - **`LICENSE`:** MIT, `Copyright (c) 2026 <то же имя>`.
  - **`.gitignore`:** из карты файлов.
- [ ] **Шаг 2. Спайк `register.tsx`.** Экспорт `register: Register` по образцу `examples/pane.tsx`. Модуль собирает объект результатов и пишет его через `$.fs.write` (сигнатуру взять из d.ts) не чаще раза в 2 секунды, отложенно через `$.clock.after`. Все хуки возвращают `next(e)` без изменений. Поля результата:
  - `engine`: строка версии, если API её отдаёт (`$.session.version()`), иначе `null`.
  - `time`: `{ toTimeString: new Date().toTimeString(), tzOffset: new Date().getTimezoneOffset(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }` на `session.start`.
  - `pane` (последние 10): на `session.start` и `session.attach` вызывается `$.ui.open({ id: 'session-panel', title: 'Session' })`. Записать `{ event, surface: e.surface ?? null, surfaces: await $.session.surfaces(), result }`, где `result` — то, что вернул `open`.
  - `steps` (последние 12): хук `turn.step` в виде асинхронного генератора, который сам перебирает чанки `next(e)` и пробрасывает каждый через `yield`. Записать:
    - `keys` — `Object.keys(e)`;
    - `agentId`, `turnId`, `model`;
    - `kinds` — первые 15 значений поля вида у чанков;
    - `tStart`, `tFirst` (первый `text` / `thinking` / `tool`), `tEnd` (`stop`) — через `await $.clock.now()`, не больше трёх `await` за шаг;
    - `usage` из `stop` целиком;
    - `ttftMs`, `rate = output_tokens / ((tEnd − tFirst) / 1000)`.
  - `cost` (последние 60): `{ t, event, agentId, usd: (await $.session.usage()).cost?.usd ?? null }` на `turn.start`, `turn.complete`, `session.measure` и на каждом `stop` субагента. Для `stop` субагента сделать ещё одну запись через `$.clock.after(1500, …)` с событием `'agent-stop+1.5s'`.
  - `mcp`: через 5 секунд после `session.start` (`$.clock.after`) вызвать встроенный `WaitForMcpServers` с пустым входом через `$.tool.call` (сигнатуру взять из d.ts). Записать `{ ok, ms, result }` или `{ ok: false, ms, error: String(err) }`. Вызов не ждать внутри хука.
  - `spawn` (последние 5): на `agent.spawn` записать `Object.keys(e)` и результат `next(e)`.
  - `agentComplete` (последние 5): на `turn.complete` с `agentId` записать `Object.keys(e)`, `reason`, `isAborted`, `durationMs`, `usage`, `typeof e.answer`.
  - `agentList`: результат `$.agent.list()` на каждом `turn.complete`.
  - `measure` (последние 10): `{ changed: e.changed, keys: Object.keys(e) }`.
  - `postTool` (последние 10): на `classic.PostToolUse` и `classic.PostToolUseFailure` записать `Object.keys(e)`, `tool_name`, `duration_ms`, `agent_id ?? null`.
  - `breakdown`: `(await $.session.usage({ breakdown: 'summary' })).context.breakdown` на `session.start`. Если там больше 2000 символов JSON, оставить только `skills` и `mcpTools`.
  - Отрисовка: хук `ui.render` для `{ component: 'Pane', requestId: 'session-panel' }` возвращает `Box` со строкой `spike: N steps, M cost samples` и `Text` с временем последней записи файла.
- [ ] **Шаг 3. Проверка манифестов и модуля.**
  - Запустить: `claude plugin validate /home/philarete/projects/claude_mods/plugins/session-panel`, затем `claude plugin validate /home/philarete/projects/claude_mods`.
  - Ожидается: обе команды без ошибок; отчёт перечисляет хуки `session.start`, `session.attach`, `turn.step`, `turn.start`, `turn.complete`, `session.measure`, `agent.spawn`, `classic.PostToolUse`, `classic.PostToolUseFailure`, `ui.render`.
- [ ] **Шаг 4. Синхронизация.** Выполнить команду `rsync` из глобальных ограничений и вернуть её вывод. В итоговом отчёте написать, что пользователь должен ответить **Enable for this session** на вопрос о горячей перезагрузке.

После задачи главный агент проводит ход с субагентом и с несколькими инструментами, читает `results.json` и записывает решения по пробам в спецификацию (§8, раздел «Итоги спайка»).

---

### Задача 2: `stats.ts`, чистые функции (TDD)

Не зависит от спайка: все варианты задаются параметрами. Может выполняться параллельно с задачей 1.

**Файлы:**
- Создать: `plugins/session-panel/hooks/stats.ts`, `plugins/session-panel/hooks/stats.test.ts`.

**Интерфейсы (даёт; все имена экспортируются из `stats.ts`):**
```ts
export type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number; cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } }
export type Interval = [start: number, end: number]
export type StepTiming = { tStart: number; tFirst: number | null; tEnd: number; usage: Usage; hasTool: boolean; hasText: boolean }
export type TurnAcc = { turnId: string; startedAt: number; costAtStart: number | null; steps: StepTiming[]; toolIntervals: Interval[] }
export type TurnStats = { elapsedMs: number; modelMs: number; toolMs: number; steps: number; ttftMs: number | null;
  wholeTurnRate: number | null; responseRate: number | null; tokensIn: number; tokensOut: number; cachePct: number | null; costUsd: number | null }
export type AgentStatus = 'running' | 'done' | 'failed' | 'stopped'
export type AgentRow = { id: string; description: string; type: string; model: string | null; status: AgentStatus;
  startedAt: number; endedAt: number | null; costUsd: number | null }
export type LogKind = 'info' | 'ok' | 'error'
export type LogEntry = { at: number; who: string; text: string; kind: LogKind }
export type CostSplit = { total: number | null; session: number | null; subagents: number }
export function mergedLength(intervals: Interval[]): number
export function sumUsage(usages: Usage[]): Usage
export function cacheHitPct(u: Usage): number | null
export function computeTurnStats(acc: TurnAcc, durationMs: number, usage: Usage | undefined, costNow: number | null): TurnStats
export function attributeCost(lastUsd: number, usd: number): { delta: number; lastUsd: number }
export function addAgentCost(row: AgentRow, deltaUsd: number): AgentRow
export function splitCost(totalUsd: number | undefined, subagentsUsd: number): CostSplit
export function orderAgents(rows: AgentRow[]): AgentRow[]
export function pushLog(log: LogEntry[], entry: LogEntry, max?: number): LogEntry[]
export function shortType(type: string): string
export function redact(s: string): string
export function shorten(s: string, max: number): string
export function toolLabel(tool: string, input: Record<string, unknown>, root: string): string
export function fmtUsd(x: number): string
export function fmtPct(x: number, digits: 0 | 1): string
export function fmtTokens(n: number): string
export function fmtDuration(ms: number): string
export function fmtTtft(ms: number): string
export function fmtRate(tokPerSec: number): string
export function fmtCountdown(msUntil: number): string
export function fmtClock(ms: number): string
```

**Поведение (то, что фиксируют тесты):**
- **`computeTurnStats`:**
  - `modelMs` = Σ (`tEnd − tStart`);
  - `toolMs` = `mergedLength(toolIntervals)`;
  - `steps` = `acc.steps.length`;
  - `ttftMs` — среднее (`tFirst − tStart`); `null`, если у какого-то шага нет `tFirst` или шагов нет;
  - `wholeTurnRate` = Σ `output_tokens` по шагам / (`modelMs` / 1000);
  - `responseRate` берётся у последнего шага, если `!hasTool && hasText && tFirst != null`: `output_tokens / ((tEnd − tFirst) / 1000)`;
  - обе скорости становятся `null` при окне ≤ 0, при значении больше 5000 или когда шагов нет;
  - токены и кеш считаются по `usage ?? sumUsage(steps.map(s => s.usage))`;
  - `costUsd = costNow − acc.costAtStart`, если оба не `null`, иначе `null`.
- **`attributeCost`:** `delta = max(0, usd − lastUsd)`, новый `lastUsd = max(lastUsd, usd)`.
- **`addAgentCost`:** прибавляет `deltaUsd` к `costUsd`; `null + x` = `x`.
- **`splitCost`:** `total = totalUsd`, `session = max(0, total − subagents)`; если `totalUsd` не задан, то `total` и `session` равны `null`.
- **`orderAgents`:** сначала `running`, затем по `startedAt` от новых к старым; исходный массив не меняется.
- **`pushLog`:** `[entry, ...log].slice(0, max ?? 60)`.
- **`shortType`:** часть после последнего `:`, не длиннее 10 символов.
- **`shorten`:** пробельные последовательности сжимаются в один пробел, затем `trim`; если длина больше `max`, то `slice(0, max - 1) + '…'`.
- **`redact`:** список регулярных выражений из `claude-flightdeck/hooks/core.ts`, коммит f31daca (MIT, scasella). Скопировать дословно и указать авторство в комментарии:
  ```text
  /(authorization\s*[:=]\s*)(bearer\s+|basic\s+)?\S+/gi            → '$1$2•••'
  /\b(bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi                          → '$1 •••'
  /\b(sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{8,}/g → '•••'
  /((?:api[_-]?key|access[_-]?token|token|secret|password|passwd|pwd)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi → '$1•••'
  /(--(?:token|password|api-key|secret)[= ])\S+/gi                   → '$1•••'
  /(\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)=)\S+/g             → '$1•••'
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s@]+@/gi                   → '$1•••@'
  ```
- **`toolLabel`** (текст строки журнала до суффикса ✓/✗):
  - `mcp__<server>__<tool>` → `<server>:<tool>`;
  - Bash → `Bash <command>`;
  - Read, Edit, Write, MultiEdit → `<Tool> <file_path относительно root>`; NotebookEdit — так же по `notebook_path`. Если путь начинается с `root + '/'`, префикс срезается;
  - Grep, Glob → `<Tool> <pattern>`;
  - WebFetch → `WebFetch <hostname из url>` (если URL не разбирается, берётся строка как есть);
  - WebSearch → `WebSearch <query>`;
  - Agent, Task → `Agent → <subagent_type ?? 'agent'>: <description ?? ''>`;
  - любой другой инструмент → его имя.
- **Форматы:** §3.2 спецификации. Отображение `fmtCountdown`: `ms ≤ 0` → `'↻ now'`; иначе минуты `M = ceil(ms / 60000)`, и `M < 60` → `↻ Mm`, `M < 1440` → `↻ Hh Mm`, иначе `↻ Dd Hh`. `fmtClock` выдаёт локальное `HH:MM:SS` через `new Date(ms)`.

- [ ] **Шаг 1. Написать падающие тесты** в `stats.test.ts` с `import { test, expect } from 'claude-code/testing'` — по одному `test` на функцию. Таблица ожидаемых значений:

  | Вызов | Ожидается |
  |---|---|
  | `mergedLength([])` | `0` |
  | `mergedLength([[0,10],[5,15]])` | `15` |
  | `mergedLength([[0,10],[2,3]])` | `10` |
  | `mergedLength([[5,7],[0,1]])` | `3` |
  | `computeTurnStats(A, 33500, U, 5.005)` (ниже) | `modelMs 12700`, `toolMs 900`, `steps 2`, `ttftMs 700`, `wholeTurnRate ≈ 61.18`, `responseRate ≈ 67.18`, `tokensIn 12`, `tokensOut 777`, `cachePct ≈ 99.09`, `costUsd ≈ 0.005` |
  | то же, но у шага 1 `tFirst: null` | `ttftMs null` |
  | то же, но у последнего шага `hasTool: true` | `responseRate null` |
  | один шаг `tStart 0, tFirst 0, tEnd 1000`, `output 100000` | `wholeTurnRate null`, `responseRate null` |
  | `cacheHitPct({ input_tokens: 0 })` | `null` |
  | `attributeCost(10, 10.25)` | `{ delta: 0.25, lastUsd: 10.25 }` |
  | `attributeCost(10.25, 10.2)` | `{ delta: 0, lastUsd: 10.25 }` |
  | `addAgentCost({ …, costUsd: null }, 0.02).costUsd` / то же с `costUsd: 0.01` | `0.02` / `≈ 0.03` |
  | `splitCost(5.49, 2.95)` | `{ total: 5.49, session ≈ 2.54, subagents: 2.95 }` |
  | `splitCost(undefined, 1)` | `{ total: null, session: null, subagents: 1 }` |
  | `splitCost(1, 2).session` | `0` |
  | `orderAgents` из `[done@100, running@50, done@300]` | `[running@50, done@300, done@100]` |
  | `pushLog` с 60 записями плюс новая | длина 60, новая на индексе 0 |
  | `shortType('plugin:code-reviewer')` | `'code-revie'` |
  | `shorten('  a \n  b  ', 10)` / `shorten('abcdefghijk', 5)` | `'a b'` / `'abcd…'` |
  | `redact('curl -H "Authorization: Bearer abcdefgh12345"')` | без `abcdefgh12345` |
  | `redact('API_KEY=xyz123 run')` | `'API_KEY=••• run'` |
  | `toolLabel('Read', { file_path: '/r/src/a.ts' }, '/r')` | `'Read src/a.ts'` |
  | `toolLabel('mcp__issue-hub__find_issues', {}, '/r')` | `'issue-hub:find_issues'` |
  | `toolLabel('Agent', { subagent_type: 'engineer', description: 'Fix qty' }, '/r')` | `'Agent → engineer: Fix qty'` |
  | `toolLabel('WebFetch', { url: 'https://docs.x.io/a?b' }, '/r')` | `'WebFetch docs.x.io'` |
  | `fmtUsd`: `5.4867` / `0.152` / `0.0049` / `0.0004` / `0` | `'$5.49'` / `'$0.152'` / `'$0.005'` / `'<$0.001'` / `'$0'` |
  | `fmtPct(12.84, 1)` / `fmtPct(23.6, 0)` | `'12.8%'` / `'24%'` |
  | `fmtTokens`: `0`, `999`, `1000`, `2345`, `9960`, `128400`, `999400`, `999600`, `1240000`, `12000000` | `'0'`, `'999'`, `'1k'`, `'2.3k'`, `'10k'`, `'128k'`, `'999k'`, `'1M'`, `'1.2M'`, `'12M'` |
  | `fmtDuration`: `900`, `33500`, `59960`, `65000`, `3720000` | `'0.9s'`, `'33.5s'`, `'1m 00s'`, `'1m 05s'`, `'1h 02m'` |
  | `fmtTtft(40)` / `fmtTtft(800)` | `'<0.1s'` / `'0.8s'` |
  | `fmtRate(103.6)` | `'~104 tok/s'` |
  | `fmtCountdown`: `0`, `30000`, `45·60000`, `59.5·60000`, `(2·60+13)·60000`, `(5·1440+15·60)·60000` | `'↻ now'`, `'↻ 1m'`, `'↻ 45m'`, `'↻ 1h 0m'`, `'↻ 2h 13m'`, `'↻ 5d 15h'` |
  | `fmtClock(Date.now())` | соответствует `/^\d\d:\d\d:\d\d$/` |

  Данные для `computeTurnStats`:
  - `A = { turnId: 't', startedAt: 0, costAtStart: 5, steps: [S1, S2], toolIntervals: [[5000,5600],[5200,5900]] }`;
  - `S1 = { tStart: 0, tFirst: 800, tEnd: 5000, usage: { output_tokens: 300 }, hasTool: true, hasText: true }`;
  - `S2 = { tStart: 6000, tFirst: 6600, tEnd: 13700, usage: { output_tokens: 477 }, hasTool: false, hasText: true }`;
  - `U = { input_tokens: 12, output_tokens: 777, cache_read_input_tokens: 99000, cache_creation_input_tokens: 900 }`.

  Дробные значения сравнивать с допуском (`toBeCloseTo` или аналог из `claude-code/testing`).
- [ ] **Шаг 2. Убедиться, что тесты падают.** Запустить `claude plugin test /home/philarete/projects/claude_mods/plugins/session-panel`. Ожидается: FAIL (функций ещё нет).
- [ ] **Шаг 3. Реализовать `stats.ts`** — минимально, чтобы тесты прошли. Без импортов от движка, кроме типов.
- [ ] **Шаг 4. Тесты проходят.** Тот же запуск. Ожидается: все тесты `stats.test.ts` PASS. Затем синхронизация `rsync`.

---

### Задача 3: контракт состояния и связка событий (`register.tsx`)

Зависит от задачи 1: перед отправкой исполнителю главный агент дописывает в спецификацию раздел «Итоги спайка» с решениями. Использует задачу 2.

**Файлы:**
- Создать: `plugins/session-panel/types/index.d.ts`, `plugins/session-panel/hooks/state.ts`, `plugins/session-panel/hooks/register.test.ts`.
- Изменить: `plugin.json` (добавить `"types": "./types/index.d.ts"`).
- Заменить целиком: `plugins/session-panel/hooks/register.tsx`.

**Интерфейсы:**
- Берёт из задачи 2: все типы и функции `stats.ts`.
- Даёт (контракт `PluginState['session-panel']`, ключ → тип):
  - `usage: { contextTokens?: number; contextWindow?: number; contextPct?: number; costUsd?: number; rateLimits: { kind: string; percentUsed: number; resetsAt?: number }[]; skills?: number }`;
  - `project: { name: string; branch: string | null }`;
  - `mcp: { servers: { name: string; status: 'connected' | 'failed' | 'needsAuth' | 'pending' | 'disabled' }[]; exact: boolean } | null`;
  - `turn: TurnAcc | null`;
  - `lastTurn: TurnStats | null`;
  - `agents: Record<string, AgentRow>`;
  - `log: LogEntry[]`;
  - `collapsed: Record<string, boolean>`.

  Атомы создаются через `atom({ plugin: 'session-panel', key }, initial)` по образцу `examples/pane-state.d.ts`. Атомы объявляются и экспортируются в `hooks/state.ts`, который создаётся в этой задаче. `register.tsx` и `view.tsx` импортируют их оттуда. Значение `resetsAt` хранится в epoch-миллисекундах: если API даёт секунды или ISO-строку, оно приводится к миллисекундам при записи.

**Поведение** (§4–§5 спецификации; хуки только наблюдают):
- **`session.start`:**
  - `$.command.register({ name: 'session-panel', description: 'Open or close the session stats pane' })`;
  - карта `collapsed` загружается из `$.store.get('collapsed')`;
  - обновить usage (вызов с `breakdown: 'summary'`), project/branch и MCP (в фоне, без ожидания внутри хука);
  - запустить `$.clock.every(30_000)`: `$.ui.invalidate('ui.render')`, статусы из `$.agent.list()`, MCP каждый второй тик;
  - если среди `$.session.surfaces()` есть `desktop`, вызвать `$.ui.open({ id: 'session-panel', title: 'Session' })`.
- **`session.attach`** с `surface: 'desktop'`: открыть панель так же.
- **`command.run`** для `session-panel`: если панель открыта (`$.ui.panes()`), закрыть её `$.ui.close`; иначе открыть. Ответ `{ text }` с причиной, если `isPlaced: false`.
- **`session.measure`:** обновить `usage` из `e` (context, cost, rateLimits).
- **`turn.start`** без `agentId`: `turn = { turnId, startedAt: now, costAtStart: usage().cost?.usd ?? null, steps: [], toolIntervals: [] }`; запись в журнал §4.7.
- **`turn.step`:** асинхронный генератор с замерами по §4.3, чанки пробрасываются без изменений.
  - Без `agentId` — добавить `StepTiming` в `turn`.
  - После каждого `stop` (любого агента): `$.clock.after(1, …)` читает `usage().cost.usd` и вызывает `attributeCost(lastUsd, usd)`. Прирост идёт в `addAgentCost(agents[agentId], delta)` для субагента; для основного агента он нигде отдельно не хранится (Session = Total − Subagents). `lastUsd` — переменная модуля, её задаёт текущий `cost.usd` на `session.start`.
- **`tool.call`:** `const t0 = await $.clock.now(); const ran = await next(e); const t1 = await $.clock.now()`. Для основного агента (без `agentId`) интервал `[t0, t1]` добавляется в `turn.toolIntervals` (`classic.PostToolUse*` до мода не доходят). Затем запись в журнал (`toolLabel` + `✓ fmtDuration` / `✗` / `denied`, через `redact` и `shorten(…, 64)`); вернуть `ran`.
- **`turn.complete`:**
  - без `agentId`: `const done = await next(e)`; `lastTurn = computeTurnStats(turn, e.durationMs, e.usage, usage().cost?.usd ?? null)`; `turn = null`; обновить branch; вернуть `done`;
  - с `agentId`: статус (`isAborted` → `stopped`; иначе `reason` → `done` или `failed` по правилу из итогов спайка), `endedAt`; запись в журнал §4.7.
- **`agent.spawn`:** `const r = await next(e)`; `agents[r.agentId] = { id, description, type, model: r.model, status: 'running', startedAt: now, endedAt: null, costUsd: null }`; запись в журнал; вернуть `r`.
- **`session.compact`:** `const r = await next(e)`; запись в журнал `compacted <fmtTokens(before)> → <fmtTokens(after)>`; обновить usage; вернуть `r`.
- **`classic.CwdChanged`:** обновить project/branch.
- **MCP** — по итогам спайка: `WaitForMcpServers` (`exact: true`) или запасной источник из breakdown (`exact: false`).
- **Отрисовка временная (до задачи 4):** `ui.render` для `{ component: 'Pane', requestId: 'session-panel' }` выводит `Box` из строк `Text`, по одной на атом, в виде `key: JSON` длиной до 200 символов.

- [ ] **Шаг 1. Написать падающие тесты** в `register.test.ts` на том, что позволяет `claude-code/testing` (в d.ts искать `claude-code/testing`, `mock.store`, `mock.clock`, `$.ui.mount`):
  - (a) после старта сессии команда `session-panel` зарегистрирована;
  - (b) `mock.store` с `collapsed: { log: true }` даёт атом `collapsed.log === true`;
  - (c) `$.ui.mount` панели на `surface: 'desktop'` находит текст `lastTurn`.

  Если тестовый набор не умеет вызывать события движка, в отчёте написать, какие события вызвать не удалось, и не подделывать их.
- [ ] **Шаг 2. Убедиться, что тесты падают.** `claude plugin test …/plugins/session-panel`. Ожидается: FAIL.
- [ ] **Шаг 3. Реализовать** контракт, `plugin.json` и `register.tsx`.
- [ ] **Шаг 4. Проверка.** `claude plugin test` проходит целиком (и `stats.test.ts`); `claude plugin validate …/plugins/session-panel` без ошибок. Затем синхронизация `rsync`.

После задачи главный агент проверяет на живом десктопе, что временная отрисовка показывает правдоподобные значения после хода с субагентом.

---

### Задача 4: отрисовка панели (`view.tsx`)

**Файлы:**
- Создать: `plugins/session-panel/hooks/view.tsx`, `plugins/session-panel/hooks/view.test.tsx`.
- Изменить: `register.tsx` — хук `ui.render` вызывает `renderPane`, временная отрисовка удаляется.

**Интерфейсы:**
- Берёт: атомы задачи 3, форматы задачи 2.
- Даёт:
  - `export function renderPane(els, data: PaneData, props, handlers): <дерево>`. Функция чистая и **не получает `$`**: валидатор движка не прослеживает `$` через импорты. Хук `ui.render` в `register.tsx` вызывает `$.ui.resolve(e)` и `read($, atom)` для каждого атома, затем передаёт:
    - `els` — таблицу элементов;
    - `data` — снимок атомов `{ usage, project, mcp, lastTurn, agents, log, collapsed, now }`;
    - `props` — `e.props` панели;
    - `handlers` — `{ onToggle(id: SectionId) }`, то есть обработчики нажатия, собранные в `register.tsx` из функции верхнего уровня `toggleSection($, id)` (сигнатуру `onPress` взять из d.ts).
  - `export type PaneData` — тип того же снимка;
  - `export function meterSvg(pct: number, widthPx: number): string`. Над функцией комментарий об авторстве: Desktop Statusline, George Liu, MIT;
  - строка split считается через `splitCost(usage.costUsd, Σ agents.costUsd)`.

  Атомы импортируются из `hooks/state.ts`, а `register.tsx` импортирует `renderPane` из `view.tsx`.

**Поведение (§3 спецификации):**
- **Элементы:** `const { Box, Text, Button, Svg } = $.ui.resolve(e)`. Если `Svg` нет (terminal), шкала выводится текстом из 10 делений `▰▱`.
- **Ширина шкалы:** `clamp(round(bodyColumns · 12.5 − 210), 40, 180)`.
- **Порядок блоков** — §3:
  - верх без сворачивания: Session, Total, Context со шкалой, split при `subagents > 0`, строка `📁 name   🌿 branch`;
  - затем Usage (скрыт при пустом `rateLimits`), Turn stats (при `lastTurn = null` — приглушённое `No completed turn yet`), Subagents (скрыт, если записей нет), MCP, Context sources, Log.
- **Заголовок секции:** `Button` с `plain`, `key: 'toggle:<SectionId>'`, `label: '▾ Title'` или `'▸ Title'`; справа приглушённая сводка §4.
  - `onPress` вызывает `handlers.onToggle(id)`. Сама запись живёт в `register.tsx`, в функции верхнего уровня `toggleSection($, id)`: `update($, collapsedAtom, m => ({ ...m, [id]: !m[id] }))`, затем `$.store.set('collapsed', <новая карта>)`.
  - Сам `render` в состояние не пишет, `view.tsx` не импортирует `$`-зависимый код.
- **Строка «метка — значение»:** `Box` с `justifyContent: 'space-between'`.
- **Цвета текста:** процент шкалы — ключ `warning`/`error` по порогу; Cache от 50% — `success`; статусы ◐ `#2f7de1`, ✓ `success`, ✗ `error`.

- [ ] **Шаг 1. Написать падающие тесты** в `view.test.tsx`: заполнить атомы фикстурами (как именно — найти в `claude-code/testing`) и смонтировать `Pane` на `desktop` и на `terminal`.
  - (a) есть тексты `Context`, `12.8%`, `Turn stats`, `~61 tok/s`, `$0.02`;
  - (b) нажатие `toggle:log` убирает строки журнала, а `mock.store` содержит `collapsed.log === true`;
  - (c) при `rateLimits: []` заголовка `Usage` нет;
  - (d) на `terminal` шкала текстовая (`▰`);
  - (e) `meterSvg(85, 100)` содержит `#e0a030` и `width="85"` у заливки.
- [ ] **Шаг 2. Убедиться, что тесты падают.** Ожидается: FAIL.
- [ ] **Шаг 3. Реализовать** `view.tsx` и подключить его в `register.tsx`.
- [ ] **Шаг 4. Проверка.** `claude plugin test` проходит целиком; `claude plugin validate` без ошибок. Затем синхронизация `rsync`.

---

### Задача 5: README, полная проверка, установка

**Файлы:**
- Создать: `README.md`.

- [ ] **Шаг 1. README.** Разделы:
  - что показывает панель (по §3, без скриншотов);
  - установка: `claude plugin marketplace add ~/projects/claude_mods`, `claude plugin install session-panel@claude-mods`;
  - команда `/session-panel`;
  - что мод делает и чего не делает (§2);
  - как считается стоимость: прирост `cost.usd` после каждого шага приписывается его агенту;
  - разработка: `rsync` и горячая перезагрузка;
  - авторство по §10.
- [ ] **Шаг 2. Полная проверка** (делает `reality-checker`; результат — реальный вывод команд):
  - `claude plugin validate plugins/session-panel` и `claude plugin validate .` — без ошибок;
  - `claude plugin test plugins/session-panel` — все тесты PASS;
  - проверка типов. TypeScript в системе нет, поэтому **нужно разрешение пользователя** на загрузку через npx: `npx -y -p typescript@5.9 tsc -p /home/philarete/.claude/dev-mods/bcaecb67-a219-4453-b027-9e930232ca47/session-panel` (tsconfig, который движок положил в `.claude-plugin/types/`). Ожидается: 0 ошибок.
- [ ] **Шаг 3. Ручная сверка с пользователем** (§7, пункт 4): контекст и лимиты совпадают с индикаторами приложения; после хода с субагентом заполнены Turn stats, Subagents и Log.
- [ ] **Шаг 4. Установка** (с разрешения пользователя):
  - `claude plugin marketplace add /home/philarete/projects/claude_mods`;
  - `claude plugin install session-panel@claude-mods`;
  - удалить копию в dev-mods, чтобы мод не загрузился дважды;
  - в новой сессии убедиться, что панель открылась.
- [ ] **Шаг 5. Коммиты** — главный агент, только с разрешения пользователя.
