# Session Panel 0.4–0.6: план реализации

> **Для исполнителей:** план выполняется задачами через superpowers:subagent-driven-development. Шаги отмечены
> чекбоксами (`- [ ]`). Каждую задачу читайте вместе со спецификацией. Раздел «Глобальные ограничения» входит в
> требования каждой задачи.

**Цель:** три выпуска:
- 0.4.0 — счётчик событий и строка `+N more` в Log;
- 0.5.0 — секция фоновых задач Tasks;
- 0.6.0 — восстановление Subagents, Tasks и Log из переписки, когда мод загружается в уже идущую сессию.

**Архитектура:**
- Устройство мода прежнее:
  - `register.tsx` переводит события движка в атомы `$.state`;
  - `stats.ts` содержит чистые функции;
  - `view.tsx` рисует.
- Новое состояние: `logCount` (0.4.0) и `tasks` (0.5.0). Новое чтение: `$.session.messages()` (0.6.0).
- Первая задача — одноразовый спайк на живом десктопе. Его итоги попадают в спецификацию (§8) раньше, чем начинаются
  задачи, которые от них зависят.

**Стек:** TypeScript/TSX hooks-модуль Claude Code (движок 2.1.288),
`claude plugin test`, `claude plugin validate`, `tsc`.

**Спецификация:** `docs/superpowers/specs/2026-10-12-session-panel-v2-design.md`. Ссылки §N ниже ведут на её разделы. Её
основа — `2026-10-07-session-panel-design.md` и `2026-10-07-session-panel-visual.md`.

## Глобальные ограничения

- **Корень репозитория** — `.`. Мод лежит в `plugins/session-panel/`.
- **Типы API** (движок 2.1.288) лежат в `.superpowers/engine-types/2.1.288/`: `claude-code/index.d.ts` и
  `claude-code-tools/index.d.ts`. Это локальная копия, в git она не входит. Файлы большие, искать в них нужно grep'ом по
  имени.
- **Хуки только наблюдают.** Каждый хук возвращает результат `next(e)` без изменений. Нельзя возвращать `deny`,
  переписывать вход или подменять результат. Хук `ui.render` на чужом компоненте (`UserMessage`) только читает `e.props`
  и возвращает `next(e)`.
- **Чего мод не делает:**
  - сеть: `fetch`, `$.http`;
  - чтение учётных данных, `$.env`, `$.settings`;
  - вызовы `$.tool.call` и `$.model`;
  - запись на диск, кроме `$.store` с ключом `collapsed`. Исключение — файл
    результатов спайка в задаче 1: он локальный и
    лежит вне репозитория.
- **Новый вызов движка один** — `$.session.messages()`, в задаче 10. Уже используемые вызовы остаются.
- **Git** не меняется: только `branch`, `rev-parse`, `status` и `diff` с текущими флагами.
- **Язык.**
  - Подписи интерфейса и комментарии в коде — на английском.
  - Документы пишутся на своём языке. README и визуальная спецификация — на английском. Спецификации v1 и v2 и планы —
    на русском.
- **Длина строк** — не больше 120 символов во всех файлах. Считаются символы, а не байты.
- **Идентификаторы.**
  - `SectionId` получает значение `tasks`.
  - Новые ключи `$.state`: `logCount` (задача 2) и `tasks` (задача 6).
  - `AgentStatus` получает статус `ended` (задача 9).
- **Лимиты.**
  - Буфер Log — 60 записей. `MIN_LOG_ROWS` — 8, `MAX_LOG_ROWS` — 15.
  - Subagents и Tasks показывают до 8 строк, остальное уходит в `+N more`.
- **Проверки после каждой задачи с кодом** (из корня репозитория):

  ```bash
  claude plugin test plugins/session-panel
  claude plugin validate plugins/session-panel
  claude plugin validate .
  tsc -p .superpowers/tsc/tsconfig.json
  ```

  Ожидается, что все тесты проходят и обе проверки `validate` проходят: допустимы только прежние четыре предупреждения
  `gating hook without .catch`. `tsc` должен завершиться с кодом 0.

  Если `.superpowers/tsc/tsconfig.json` нет, задача 2 создаёт его. Это локальный файл, все пути в нём абсолютные:

  ```json
  {
    "extends": "<repo>/.superpowers/engine-types/2.1.288/tsconfig.json",
    "include": [
      "<repo>/plugins/session-panel/hooks",
      "<repo>/plugins/session-panel/types"
    ]
  }
  ```
- **Коммиты.** Исполнители git-коммиты не делают: коммитит главный агент после ревью. Пуш, отправка тега на GitHub и
  обновление установки — только с разрешения пользователя.
- **Выпуск.**
  1. Версия меняется только в `plugins/session-panel/.claude-plugin/plugin.json`.
  2. В `CHANGELOG.md` добавляется запись.
  3. Делается коммит выпуска.
  4. `claude plugin tag plugins/session-panel` ставит тег `session-panel--vX.Y.Z`; команде нужно чистое рабочее дерево.

## Карта файлов

Все файлы мода лежат в `plugins/session-panel/`, если не указано иное.

- **`hooks/stats.ts`** (задачи 2, 5, 9): разбор задач, уведомлений и снимка, `restoreFromMessages`, статус `ended`.
- **`hooks/stats.test.ts`** (задачи 2, 5, 9): тесты к ним.
- **`hooks/register.tsx`** (задачи 2, 6, 10): `logCount`, хуки задач, восстановление.
- **`hooks/register.test.ts`** (задачи 2, 6, 10): тесты к ним.
- **`hooks/view.tsx`** (задачи 2, 3, 7, 11):
  - счётчик Log;
  - высоты блоков и `+N more`;
  - секция Tasks;
  - `—` и `Subagents $Y+`.
- **`hooks/view.test.tsx`** (задачи 2, 3, 7, 11): тесты к ним.
- **`types/index.d.ts`** (задачи 2, 6, 9): `logCount`, `tasks`, `TaskRow`, `LogEntry.at` может быть `null`.
- **`README.md` мода и корневой `README.md`** (задачи 4, 8, 12): справочник и краткое описание.
- **`docs/superpowers/specs/2026-10-12-session-panel-v2-design.md`** (задачи 1, 4, 8, 12): итоги спайка (§8) и статус.
- **`docs/superpowers/specs/2026-10-07-session-panel-visual.md`** (задачи 4, 8, 12):
  - §6.12 Log;
  - новый раздел о Tasks;
  - восстановленные строки.
- **`docs/superpowers/specs/2026-10-07-session-panel-design.md`** (задачи 4, 8, 12): ссылки на v2 там, где поведение
  изменилось.
- **`CHANGELOG.md` и `.claude-plugin/plugin.json`** (задачи 4, 8, 12): выпуски 0.4.0, 0.5.0 и 0.6.0.

Порядок задач: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12.

- Задача 2 не зависит от спайка. Её можно делать, пока идёт задача 1: файлы не пересекаются.
- Задача 3 ждёт итога S1.
- Задачи 5–7 ждут итогов S4 и S5.
- Задачи 9–10 ждут итогов S2, S3 и S6.

---

### Задача 1: спайк на десктопе (одноразовый)

Код спайка в репозиторий не попадает. Спайк отвечает на вопросы §6 спецификации и на вопрос S6 (resume в том же
процессе, §5.1).

**Файлы** (вне репозитория). Создать:
- `~/.claude/dev-mods/<session-id>/spike-v2/.claude-plugin/plugin.json`;
- `~/.claude/dev-mods/<session-id>/spike-v2/hooks/hooks.json`;
- `~/.claude/dev-mods/<session-id>/spike-v2/hooks/register.tsx`.

`<session-id>` — это десктоп-сессия, в которой главный агент загрузил навык `plugin-authoring`. Путь к папке даёт
главный агент.

**Интерфейсы:**
- Даёт файл `.superpowers/sdd/2026-10-12-session-panel-v2/spike-results.json`.
  Его читает главный агент.

- [ ] **Шаг 1. Манифесты.**
  - `plugin.json`: `{ "name": "spike-v2", "version": "0.0.1",
    "description": "Throwaway probes for session-panel 0.4-0.6"
    }`.
  - `hooks.json`: `{ "modules": ["./register.tsx"] }`.
- [ ] **Шаг 2. Пробы в `register.tsx`.**
  - Экспорт — `register: Register`. Все хуки возвращают `next(e)` без изменений.
  - Результаты копятся в одном объекте. В файл он пишется через `$.fs.write` по абсолютному пути: отложенно, через
    `$.clock.after`, не чаще раза в 2 с.
    - Тексты обрезаются до 300 символов, если ниже не сказано
      иное. У каждого поля есть свой предел числа записей: хранятся
    последние.
  - **Поля результата:**
    - `loads` (10 записей) — на `session.start`: `{ t, sessionId: await $.session.id(), turns: await $.session.turns(),
      surfaces: await $.session.surfaces() }`.
    - `messages` (8 снимков). Каждый снимок — это `$.session.messages()`, сжатый так:
      - `{ t, trigger, count, roles, tools }`, где `roles` — число записей по ролям, а `tools` — число вызовов по имени
        инструмента;
      - `taggedUser` — число записей `user` без `toolResults`, чей текст начинается с `<`;
      - `notifications` — число записей, чей текст содержит `<task-notification>`;
      - `first` и `last` — по три записи с каждого конца;
      - `samples` — по две записи каждого вида: промпт (`user` без `toolResults`, текст не с `<`), `user` с тегом,
        уведомление, вызов Agent, Bash с `result.backgroundTaskId`, Monitor, Workflow, TaskStop. Для вызова
        записываются ключи `input`, ключи `result`, `result.status`, `agentId`, `durationMs` и `isError`.

      Когда снимки делаются:
      - через 3 с после `session.start`;
      - на `classic.SessionStart`;
      - через 1 с после `session.end`;
      - на `classic.PostCompact`;
      - по команде `/spike-v2 dump`.
    - `agentList` (5 записей) — на `session.start` и на `turn.complete` основного агента: `$.agent.list()` в виде `{ id,
      type, status, description }`, описание обрезано до 60 символов.
    - `classicStart` (5) — на `classic.SessionStart`: `{ keys, source, session_id, hasTranscriptPath }`.
    - `stops` (10) — на `classic.Stop` и `classic.SubagentStop`: `{ event, keys, background_tasks, session_crons }`.
    - `sessionEnd` (5) — на `session.end`: `{ reason, resumeId: e.resume?.id, keys }`.
    - `notifications` (10), два источника:
      - на `prompt.submit` с `origin.kind === 'task-notification'`: `{ origin, turnId, text }`, текст до 600 символов;
      - на `ui.render` для `{ component: 'UserMessage' }`, если есть `e.props.task` или
        `e.props.origin?.kind === 'task-notification'`: `{ origin, task }`, без повторов по `task.id` и статусу.
    - `toolResults` (20) — на `tool.call` для Bash, Monitor, Workflow, TaskStop и Agent, после `next(e)`:
      - `{ tool, inputKeys, run_in_background, resultKeys }`;
      - поля результата `backgroundTaskId`, `backgroundedByUser`,
        `timedOutAfterMs`, `taskId`, `workflowName` и `status`;
      - `agentId` и `isError`.
    - `rows` — проба S1, панель `spike-rows`. Её открывает команда `/spike-v2 rows <n>`.
      - Тело панели:
        - линия-разделитель (`Box height={1}` со `Svg`, как `divider` в `view.tsx`);
        - `n` заголовков секций, собранных как `sectionHeader` в `view.tsx`: иконка, жирный текст, кнопка-шеврон и
          сводка;
        - строка из пяти чипов MCP, как в `view.tsx`;
        - строки `L01`…`L60` в хвосте с `height={0}`, `flexGrow={1}` и `overflow="hidden"`;
        - корень с `minHeight={bodyRows}`.
      - Запись — `{ n, bodyRows, bodyColumns }` на каждой отрисовке.
- [ ] **Шаг 3. Проверка.** `claude plugin validate <папка спайка>` проходит, отчёт перечисляет хуки шага 2. Исполнитель
  сообщает, что пользователь должен ответить **Enable for this session** на вопрос о горячей перезагрузке.
- [ ] **Шаг 4. Живой прогон.** Его ведёт главный агент вместе с пользователем, в той же сессии:
  1. `/spike-v2 rows 0`, `/spike-v2 rows 3`, `/spike-v2 rows 6`. На каждую — снимок экрана пользователя.
  2. Запуски в фоне:
     - `sleep 60` в фоне;
     - `sleep 600` в фоне и затем TaskStop для него;
     - Monitor с короткой командой;
     - Workflow — только если пользователь сам его разрешит;
     - фоновый субагент и обычный субагент;
     - `sleep 30` без фона, который пользователь отправит в фон Ctrl+B.

     Затем дождаться всех уведомлений.
  3. `/compact`, затем `/spike-v2 dump`.
  4. Перезапустить приложение, открыть ту же сессию, затем `/spike-v2 dump`.
  5. Если десктоп умеет resume в том же процессе: перейти в другую сессию и вернуться.
- [ ] **Шаг 5. Итоги.** Главный агент дописывает в спецификацию раздел «§8. Итоги спайка»:
  - **S1** — поправка модели строк для десктопа, если она нужна. Это число строк, которое занимает заголовок секции и
    строка чипов.
  - **S2** — правило «промпт или служебный текст»:
    - чем отличаются уведомление и напоминание;
    - отдаёт ли `messages()` записи до компакции и до перезапуска;
    - обезличенные формы записей для тестов.
  - **S3** — что `$.agent.list()` отдаёт после перезапуска.
  - **S4** — доходят ли `classic.SessionStart` и `classic.Stop`, и с какими полями.
  - **S5** — источник уведомления о задаче и его формат для shell, monitor и workflow.

    В этой сессии уже видели формат уведомления о субагенте:
    `<task-notification><task-id>…</task-id><tool-use-id>…</tool-use-id><output-file>…</output-file>`
    `<status>completed</status><summary>…</summary>…<usage>…<duration_ms>…</duration_ms></usage></task-notification>`.
  - **S6** — момент, когда после resume в том же процессе `messages()` отдаёт новую переписку.

  После этого папка спайка удаляется из dev-mods, иначе она будет загружаться в этой сессии и дальше.

---

### Задача 2: счётчик событий Log (TDD)

**Файлы.** Изменить:
- `hooks/register.tsx`;
- `hooks/register.test.ts`;
- `hooks/view.tsx`;
- `hooks/view.test.tsx`;
- `types/index.d.ts`.

Создать, если его нет, `.superpowers/tsc/tsconfig.json`.

**Интерфейсы:**
- Даёт ключ `$.state` `logCount: number` с начальным значением 0. В `register.tsx` это атом, названный так же, как
  соседние (`logCountAtom`). В контракте `PluginState['session-panel']` — поле `logCount: number`.
- Данные для `renderPane` получают `logCount`.

- [ ] **Шаг 1. Падающие тесты.**
  - **`register.test.ts`:**
    - каждый путь `addLog` увеличивает `logCount` на 1: промпт, вызов инструмента, запуск и конец субагента,
      `resumed`, `compacted`;
    - после 65 событий `log` хранит 60 записей, а `logCount` равен 65;
    - `session.end` с `reason: 'clear'` и с `reason: 'resume'` обнуляет `logCount` вместе с `log`;
    - горячая перезагрузка его сохраняет;
    - тестовый читатель состояния (`register.test.ts`, около строк 78–91) получает девятый ключ. `checkStartsOver`
      проверяет и его.
  - **`view.test.tsx`:**
    - правый слот заголовка Log показывает `String(logCount)`, в том числе у свёрнутого Log;
    - два теста, которые сейчас закрепляют пустую сводку Log (около строк 472, 515–517 и 1922, 1927–1929), теперь ждут
      число.
- [ ] **Шаг 2.** Запустить тесты и убедиться, что новые падают.
- [ ] **Шаг 3. Реализация.**
  - Атом `logCount`.
  - `addLog` после записи в `log` делает `update(..., n => n + 1)`.
  - Сброс вместе с `logAtom` при `/clear` и resume.
  - Поле в контракте.
  - `renderPane` передаёт значение дальше, а заголовок Log получает `sectionHeader(d, 'log', 'Log',
    String(d.data.logCount))`.
- [ ] **Шаг 4.** Проверки из глобальных ограничений: все тесты проходят.

---

### Задача 3: Log — видимые строки и `+N more` (TDD)

Нужен итог S1 (§8 спецификации).

**Файлы.** Изменить `hooks/view.tsx` и `hooks/view.test.tsx`.

**Интерфейсы:**
- Каждый строитель блока выше Log (блок Session, Project, Usage, Turn stats, Subagents, MCP, Context sources) возвращает
  не только своё дерево, но и высоту в строках тела. Высота считается по тем же строкам, что блок кладёт в дерево:
  - линия — 1;
  - заголовок секции — 1 (или с поправкой S1);
  - каждая строка значений — 1;
  - `+N more` у Subagents — 1;
  - у свёрнутой секции — только линия и заголовок.
- Чипы MCP оцениваются экспортируемой чистой функцией `chipRows(names: string[], columns: number): number`.
  - Ширина чипа в клетках — та же мера ширины, которой вид уже пользуется для текста, плюс метка и отступы чипа.
  - Перенос жадный, по ширине `columns − 2` (это запас).
  - На десктопе действует поправка S1.
- Расчёт по §3.2:
  1. `место = bodyRows − Σ высот − 2`.
  2. Если `logCount ≤ место`, показываются все события, но не больше 60, и строки `+N more` нет.
  3. Иначе показывается `max(8, место − 1)` событий, не больше 60, плюс строка `+N more`, где `N = logCount −
     показано`.
- При `bodyRows` 0 показывается 15 событий, и `N = logCount − 15`.

- [ ] **Шаг 1. Падающие тесты.**
  - **`chipRows`:** одна строка, две строки, длинное имя, перенос на границе.
  - **Число строк Log при разной обстановке:**
    - высота тела 40 и 60;
    - свёрнутые секции;
    - Subagents с `+N more` и без;
    - MCP в одну и в две строки при узкой ширине;
    - Usage есть или нет.
  - **Строка `+N more`:**
    - прямой потомок корня после хвоста, с `flexShrink={0}`;
    - тусклый `Text` с отступом, как у `+N more` в Subagents;
    - N равно «всего минус показано»;
    - строки нет, когда видно всё.
  - **Граничные случаи:**
    - не помещаются даже 8 строк: 8 строк и `+N more` с `N = logCount − 8`;
    - `bodyRows` 0;
    - свёрнутый Log без строки `+N more`;
    - `logCount` больше 60 при высоком теле: 60 строк и `+N more`.
  - **Старые тесты.** Обновить тесты, которые закрепляют число и места потомков корня и свойства головы и хвоста:
    около 966, 1710, 1735, 1769, 1805, 1822, 1982 и 2084. Проверки `rowProblems` проходят и с новой строкой.
- [ ] **Шаг 2.** Убедиться, что тесты падают.
- [ ] **Шаг 3. Реализация** по интерфейсам выше.
  - Хвост остаётся страховкой: `height={0}`, `flexGrow={1}`, `overflow="hidden"`.
  - Голова — первые 8 строк — по-прежнему с `flexShrink={0}`.
  - Комментарий у расчёта объясняет, почему ошибка допустима только в меньшую сторону.
- [ ] **Шаг 4.** Проверки из глобальных ограничений.

---

### Задача 4: выпуск 0.4.0

- [ ] **Шаг 1. Документы.**
  - **`README.md` мода:** в пункте о Log — счётчик и `+N more`.
  - **Корневой `README.md`:** одна фраза в строке о Log.
  - **Визуальная спецификация, §6.12:** расчёт видимых строк, строка
    `+N more`, сводка в заголовке. Блоки кода синхронизировать
    с `view.tsx`.
  - **Спецификация v1:** в описании Log — ссылка на v2 §3.
  - **Спецификация v2:** статус «0.4.0 выпущен».
  - **`CHANGELOG.md`:** запись 0.4.0.
- [ ] **Шаг 2. Ревью.** Главный агент проводит ревью всего диффа выпуска (code-reviewer) и разбирает находки.
- [ ] **Шаг 3. Выпуск.**
  1. Версия `0.4.0` в `plugin.json`.
  2. Коммит выпуска.
  3. `claude plugin tag plugins/session-panel`.
- [ ] **Шаг 4. С разрешения пользователя.**
  1. Пуш: его делает пользователь.
  2. `claude plugin marketplace update philarete-mods`.
  3. `claude plugin update session-panel@philarete-mods`.
  4. Новая сессия.
- [ ] **Шаг 5. Живая проверка** по §3.4. Её находки записываются в `docs/live-check-<дата>-0.4.0.md`.

---

### Задача 5: Tasks — чистые функции (TDD)

Нужны итоги S4 и S5.

**Файлы.** Изменить `hooks/stats.ts` и `hooks/stats.test.ts`.

**Интерфейсы** (даёт):

```ts
export type TaskKind = 'shell' | 'monitor' | 'workflow'
export type TaskStatus = 'running' | 'done' | 'failed' | 'stopped' | 'ended'
export type TaskRow = {
  id: string
  kind: TaskKind
  description: string
  status: TaskStatus
  startedAt: number | null
  endedAt: number | null
  durationMs: number | null
}
export type TaskEnd = { id: string; status: 'completed' | 'failed' | 'killed'; durationMs: number | null }
export type InFlightTask = {
  id: string; type: string; status: string;
  description: string; command?: string; name?: string
}

export function taskFromCall(tool: string, input: unknown, result: unknown, now: number): TaskRow | null
export function parseTaskNotification(text: string): TaskEnd | null
export function finishTask(row: TaskRow, status: TaskStatus, at: number, durationMs: number | null): TaskRow
export function reconcileTasks(
  rows: Record<string, TaskRow>, inFlight: InFlightTask[], now: number
): Record<string, TaskRow>
export function orderTasks(rows: TaskRow[]): TaskRow[]
```

- [ ] **Шаг 1. Падающие тесты.**
  - **`taskFromCall`:**
    - Bash с `result.backgroundTaskId` даёт `shell`. Описание — `input.description`, а если его нет, то команда. Команда
      проходит через уже существующие `stripFormat`, `redact` и `shorten` (до 80 символов, как в Log).
    - Bash с `backgroundTaskId` и с `backgroundedByUser` или `timedOutAfterMs` — тоже `shell`.
    - Bash без `backgroundTaskId` даёт `null`.
    - Monitor с `taskId` даёт `monitor`, описание — `input.description`.
    - Workflow с `taskId` даёт `workflow`. Описание — `result.workflowName`, иначе `input.name`, иначе `'workflow'`.
    - Другой инструмент или результат без id — `null`.
    - Во всех случаях `startedAt = now`, `status: 'running'`.
  - **`parseTaskNotification`** по формату §8 (S5):
    - `completed`, `failed` и `killed`;
    - `<duration_ms>`, если он есть;
    - без `<task-id>` — `null`;
    - чужой текст — `null`.
  - **`finishTask`:**
    - ставит статус и `endedAt`;
    - `durationMs` берёт из уведомления, а если его нет, считает `endedAt − startedAt`;
    - если `startedAt` неизвестен, `durationMs` равен `null`.
  - **`reconcileTasks`:**
    - идущая задача, которой нет в `inFlight`, получает `ended`;
    - неизвестная запись `shell`, `monitor` или `workflow` из `inFlight` добавляется как идущая, с `startedAt: null`.
      Описание — `description`, иначе `command`, иначе `name`;
    - записи `subagent` пропускаются;
    - остальное не меняется.
  - **`orderTasks`:** сначала идущие, затем по `startedAt` от новых к старым, `null` в конце.
- [ ] **Шаг 2.** Убедиться, что тесты падают.
- [ ] **Шаг 3.** Реализация.
- [ ] **Шаг 4.** Проверки из глобальных ограничений.

---

### Задача 6: Tasks — связка в `register.tsx` (TDD)

**Файлы.** Изменить:
- `hooks/register.tsx`;
- `hooks/register.test.ts`;
- `types/index.d.ts`.

**Интерфейсы:**
- Даёт ключ `$.state` `tasks: Record<string, TaskRow>` с начальным значением `{}`. В контракте — `TaskRow`.
- Берёт функции задачи 5.

- [ ] **Шаг 1. Падающие тесты.**
  - **`tool.call`:**
    - после Bash с `backgroundTaskId` в `tasks` есть идущая строка;
    - строка этого вызова в Log получает исход `→ background` вместо `✓ время`;
    - то же для Monitor и Workflow;
    - отклонённый или упавший вызов задачу не добавляет.
  - **TaskStop:**
    - успешный, с `input.task_id` известной задачи, даёт `stopped` и `endedAt`;
    - с неизвестным id или упавший ничего не меняет.
  - **Завершение** через источник из §8 (S5):
    - уведомление закрывает задачу: `completed` → `done`, `failed` → `failed`, `killed` → `stopped`;
    - в Log появляется строка `done · shell: <описание>` с исходом `✓ <длительность>`;
    - у `failed` исход `✗ …`, вид `error`;
    - уведомление о субагенте (его id есть в `agents`) Tasks не трогает.

    Если источник — `ui.render` у `UserMessage`, тест проверяет, что хук возвращает именно результат `next(e)`.
  - **Сверка** по `classic.Stop` и `classic.SubagentStop`, если S4 подтвердил, что они доходят:
    - `reconcileTasks`;
    - строка Log `ended · shell: <описание>` без исхода.

    Если S4 не подтвердил, тестов сверки нет. Спецификация и README
    тогда говорят о пределе: задача, уведомление о которой
    не дошло, остаётся идущей.
  - **Сброс.** `/clear` и resume сбрасывают `tasks`, горячая перезагрузка сохраняет.
  - **Читатель состояния** получает десятый ключ.
- [ ] **Шаг 2.** Убедиться, что тесты падают.
- [ ] **Шаг 3. Реализация.**
  - Атом `tasks`.
  - В обработчике `tool.call` — после `next(e)`.
  - Хук источника уведомлений.
  - Хуки `classic.Stop` и `classic.SubagentStop`, если они подтверждены.
  - Сброс.
  - Поле в контракте.
- [ ] **Шаг 4.** Проверки из глобальных ограничений.

---

### Задача 7: Tasks — вид (TDD)

**Файлы.** Изменить `hooks/view.tsx` и `hooks/view.test.tsx`.

**Интерфейсы:**
- Берёт `tasks`, `orderTasks`, `TaskRow`.
- `SectionId` получает `tasks`.
- Строитель секции возвращает дерево и высоту (задача 3).

- [ ] **Шаг 1. Падающие тесты.**
  - **Место и вид секции.**
    - Секция `Tasks` стоит после Subagents и перед MCP. Её id — `tasks`, а иконку подбирает задача; путь иконки
      записывается в визуальную спецификацию.
    - Строка: метка статуса, описание, `@shell`, `@monitor` или `@workflow`, справа время.
    - Метки: `running` ◐, `done` ✓, `failed` ✗, `stopped` ■, `ended` — тусклая. Задачи живут в том же наборе меток, что
      Subagents: глиф в терминале, `Svg` на десктопе.
  - **Время справа.**
    - У идущей задачи с известным началом — `fmtDuration(now − startedAt)`.
    - У законченной — `fmtDuration(durationMs)`.
    - Неизвестное — тусклое `—`.
  - **Заголовок и строки.**
    - Заголовок показывает `идёт/всего`, если что-то идёт, иначе `всего`.
    - До 8 строк, затем `+N more`.
    - Свёрнутая секция показывает только заголовок.
    - Пока задач нет, секции нет.
    - В узкой панели первым уходит `@тип`, как у Subagents.
  - **Высота.** Расчёт задачи 3 учитывает строки Tasks.
  - **`rowProblems`** проходит.
- [ ] **Шаг 2.** Убедиться, что тесты падают.
- [ ] **Шаг 3.** Реализация.
- [ ] **Шаг 4.** Проверки из глобальных ограничений.

---

### Задача 8: выпуск 0.5.0

- [ ] **Шаг 1. Документы.**
  - **`README.md` мода:** пункт о Tasks — что показывает, источники, пределы. Сюда же исход `→ background` в Log.
  - **Корневой `README.md`:** строка о Tasks в списке секций.
  - **Визуальная спецификация:** новый раздел о Tasks — строки, метки, иконка, высота.
  - **Спецификация v1:** в перечне секций — ссылка на v2 §4.
  - **Спецификация v2:** статус «0.5.0 выпущен».
  - **`CHANGELOG.md`:** запись 0.5.0.
- [ ] **Шаги 2–4** — как в задаче 4, с версией `0.5.0`.
- [ ] **Шаг 5. Живая проверка** по §4.5.

---

### Задача 9: восстановление — чистая функция (TDD)

Нужны итоги S2, S3 и S5.

**Файлы.** Изменить `hooks/stats.ts`, `hooks/stats.test.ts` и `types/index.d.ts`.

**Интерфейсы** (даёт):

```ts
import type { SessionMessage, AgentInfo } from 'claude-code'
export type Restored = {
  agents: Record<string, AgentRow>
  tasks: Record<string, TaskRow>
  log: LogEntry[]
  logCount: number
}
export function restoreFromMessages(messages: SessionMessage[], agentList: AgentInfo[]): Restored
```

Кроме того:
- `LogEntry.at` становится `number | null`, в контракте тоже;
- `AgentStatus` получает `'ended'`.

- [ ] **Шаг 1. Падающие тесты.** Переписка в тестах синтетическая, формы записей взяты из §8 (S2 и S5).
  - **Обход** идёт от старых записей к новым.
  - **Промпт** — запись `user` без `toolResults`, которая по правилу S2 не служебная. Она даёт строку `you`.
  - **Служебный текст** (напоминание, уведомление) строк промпта не даёт.
  - **Каждый вызов инструмента основного агента** даёт строку Log:
    - подпись — через `toolLabel`, `stripFormat`, `redact` и `shorten`, как вживую;
    - исход — `✓ <durationMs>`, `✗ …`, `denied` (если запись это показывает) или `→ background`;
    - успешные Agent и Task, SendMessage известному агенту и SubagentHandback строк не дают, как вживую.
  - **Agent с `agentId`** даёт строку субагента `{ description, type: input.subagent_type ?? 'agent', model:
    input.model ?? null, costUsd: null }` и строку Log `spawned · <тип>: <описание>`. Статус:
    - результат `completed` → `done`, конец и строка Log о нём;
    - `isError` → `failed`;
    - `async_launched`:
      - есть уведомление — статус по нему;
      - иначе агент есть в `agentList` со статусом `running` — `running`;
      - иначе `ended`;
    - TaskStop с этим id → `stopped`.
  - **Задачи** — через `taskFromCall` (с `startedAt: null`), TaskStop и уведомления. Задача без итога получает `ended`.
  - **Порядок.** У восстановленных строк `startedAt` — отрицательные порядковые номера. Так они сортируются после живых
    и сохраняют порядок переписки.
  - **Log:**
    - `at: null`;
    - новые сверху;
    - не больше 60 записей;
    - `logCount` равен числу всех построенных записей.
  - **Пустая переписка** даёт пустой результат.
- [ ] **Шаг 2.** Убедиться, что тесты падают.
- [ ] **Шаг 3. Реализация.**
  - Функции подписей и маскировки — те же, что у живых хуков, без копий.
  - Правила S2 — в одной функции с комментарием.
- [ ] **Шаг 4.** Проверки из глобальных ограничений.

---

### Задача 10: восстановление — связка (TDD)

Нужен итог S6.

**Файлы.** Изменить `hooks/register.tsx` и `hooks/register.test.ts`.

**Интерфейсы:**
- Берёт `restoreFromMessages`.
- Новые вызовы движка: `$.session.messages()`. `$.agent.list()` уже используется.

- [ ] **Шаг 1. Падающие тесты.**
  - **`session.start` при пустых `agents`, `tasks` и `log`:**
    - мод читает `messages()` и `agent.list()` и вливает результат;
    - живые события, пришедшие во время чтения, остаются новее восстановленных;
    - `logCount` равен сумме живых и восстановленных событий;
    - при совпадении id побеждает живая строка.
  - **`session.start` при непустом состоянии** (горячая перезагрузка) не вызывает `messages()`.
  - **Повторов нет.** Восстановление идёт не больше одного раза на id сессии.
  - **resume в том же процессе.** После сброса по `session.end` (`reason: 'resume'`) восстановление идёт в момент из §8
    (S6).
  - **`/clear`** не восстанавливает.
  - **Ошибка `messages()`** — восстановления нет, панель работает как раньше.
- [ ] **Шаг 2.** Убедиться, что тесты падают.
- [ ] **Шаг 3. Реализация.**
  - Восстановление асинхронное и не держит хук: `session.start` возвращает `next(e)` сразу.
  - Защиту от повтора хранит переменная модуля с id сессии.
- [ ] **Шаг 4.** Проверки из глобальных ограничений.

---

### Задача 11: восстановление — вид (TDD)

**Файлы.** Изменить `hooks/view.tsx` и `hooks/view.test.tsx`.

- [ ] **Шаг 1. Падающие тесты.**
  - **Log.** У строки с `at: null` в колонке времени тусклое `—`, ширина колонки не меняется.
  - **Subagents.**
    - `costUsd: null` — тусклое `—` в колонке стоимости.
    - Статус `ended` — та же тусклая метка, что в Tasks.
  - **Разбивка стоимости.**
    - Если хотя бы у одного субагента `costUsd: null`, строка разбивки
      — `Subagents $Y+`, где Y — сумма известных. Session
      при этом нет.
    - Если неизвестных нет, разбивка прежняя.
  - **`rowProblems`** проходит.
- [ ] **Шаг 2.** Убедиться, что тесты падают.
- [ ] **Шаг 3.** Реализация.
- [ ] **Шаг 4.** Проверки из глобальных ограничений.

---

### Задача 12: выпуск 0.6.0

- [ ] **Шаг 1. Документы.**
  - **`README.md` мода:** восстановление — когда работает, что восстанавливается, пределы (4096 записей, компакция по
    S2, нет стоимости и времени), `Subagents $Y+`.
  - **Корневой `README.md`, раздел Privacy:** строка о том, что мод читает переписку сессии через движок, чтобы
    восстановить панель, и ничего из неё не пишет на диск.
  - **Визуальная спецификация:** восстановленные строки — `—` и метка `ended`.
  - **Спецификация v1:** ссылка на v2 §5 там, где сказано, что панель начинает с пустого места.
  - **Спецификация v2:** статус «0.6.0 выпущен».
  - **`CHANGELOG.md`:** запись 0.6.0.
- [ ] **Шаги 2–4** — как в задаче 4, с версией `0.6.0`.
- [ ] **Шаг 5. Живая проверка** по §5.5.
