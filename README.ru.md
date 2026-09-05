# FLOWnote

<p align="center">
  <img src="assets/flownote-logo.svg" width="104" alt="Логотип FLOWnote">
</p>

Язык: [English](README.md#english) | [简体中文](README.zh-CN.md) | **Русский**

**FLOWnote — это AI-рабочее пространство для заметок в Obsidian: домашняя панель, быстрый захват мыслей, ежедневное планирование, проекты, статистика базы знаний, AI-чат и Skill-воркфлоу работают в одном месте.**

> По умолчанию FLOWnote использует AI API Key, который настраивает сам пользователь, и может работать как на desktop, так и на mobile. Режим OpenCode bridge остается опциональным desktop-режимом для пользователей, которые уже привыкли к старому workflow.

## Предпросмотр

<p align="center">
  <img src="assets/screenshots/home-dashboard.png" width="100%" alt="Домашняя панель FLOWnote">
</p>

<p align="center">
  <img src="assets/screenshots/chat-workspace.png" width="100%" alt="AI-чат FLOWnote">
</p>

## v0.5.25 Примечания к выпуску

Исправлены известные ошибки и повышена стабильность выполнения задач ИИ.

## v0.5.12 Примечания к выпуску

Это обновление повышает общую стабильность FLOWnote и исправляет несколько известных проблем.

## v0.5.11 Примечания к выпуску

В этом обновлении исправлены проблемы, о которых сообщали пользователи.

- **Меньше лишних уведомлений при обновлении**: minor-обновления больше не показывают compatibility notice. Оно появляется только один раз при обновлении с версии до `0.5.0`.
- **Защита пользовательских данных**: при запуске и обновлении FLOWnote добавляет только отсутствующие bundled Skills и templates. Ваши пользовательские настройки не перезаписываются.
- **Безопасная переустановка**: при переустановке встроенного контента конфликты по умолчанию пропускаются. Замена происходит только после ручного выбора, backup сохраняется.
- **Доработка языков**: тексты Simplified Chinese, English и Russian выровнены для Home, Chat, Settings, template management и связанных экранов. Русские Skill bodies используют английскую версию, чтобы снизить стоимость поддержки.
- **Более надежные AI tool calls**: в Direct AI mode FLOWnote ориентируется на реальные результаты инструментов. Ошибки возвращаются на исправление, tool cards показываются в интерфейсе, ненадежная regex-проверка текста удалена.
- **Исправления model picker**: Ollama cloud models теперь получают понятную метку. OpenRouter корректно загружает список моделей и больше не сбрасывает выбор автоматически.
- **Понятнее ошибки**: OpenRouter authorization, balance, unavailable models и ошибки Ollama models теперь показывают более ясные объяснения.
- **Исправлены серьезные проблемы**: исправлены случаи, когда Home stats могли показывать все нули, а note-path settings page могла не отрисоваться.
- **Улучшен release process**: core files попадают в release package, версии синхронизированы, добавлены commit checks и regression tests.

## Зачем нужен FLOWnote

Большинство систем заметок ломаются в одном и том же месте: мысли накапливаются быстрее, чем пользователь успевает их обработать, и через несколько недель большая часть заметок уже не открывается. FLOWnote построен вокруг простой идеи: **если снизить трение при продвижении мысли хотя бы на один шаг, вы действительно будете делать это каждый день.** Эта идея называется **метод FLOW**.

```
Feed → Lift → Organize → Work
 ↓      ↓        ↓         ↓
daily  perm    domain    project
notes  notes    pages     output
```

- **F · Feed** — быстрый захват в сегодняшнюю daily note без выбора папки и споров с тегами.
- **L · Lift** — превращение сырых мыслей в permanent notes: атомарные идеи, уверенные заголовки, AI-подбор связанных заметок.
- **O · Organize** — domain pages работают как рабочий стол: когда вы занимаетесь темой или проектом, нужные заметки поднимаются рядом.
- **W · Work** — проекты создаются как структурированные папки, а weekly/monthly/yearly reviews помогают замыкать цикл.

Skills в `bundled-skills/` автоматизируют механические шаги: номера, структуру папок, поддержку ссылок и обновление индексов. Пользователь остается сфокусирован на том, что писать, обдумывать и делать дальше.

## Видеообзор

Автор публикует серию уроков по **FLOW 笔记法** на Bilibili:

📺 **[Bilibili — серия FLOW 笔记法](https://space.bilibili.com/24543451/lists/7386412?type=season)**

| # | Тема |
|---|---|
| 01 | Введение — обзор системы и ежедневный 15-минутный цикл |
| 02 | Чтение — от выделений к literature notes |
| 03 | Permanent notes — атомарность, assertive titles, AI-assisted crafting |
| 04 | Связи знаний — topic pages и domain pages |
| 05 | Проекты и reviews — weekly / monthly / yearly cadence |
| 06 | AI overview — полная настройка окружения (в работе) |

## Требования

- Obsidian v1.5.0+
- Для встроенных AI workflows: API key поддерживаемого provider или custom OpenAI-compatible endpoint
- Опциональный desktop bridge: установите [OpenCode](https://opencode.ai) / [GitHub](https://github.com/anomalyco/opencode), если хотите подключить FLOWnote к внешнему OpenCode runtime
- Для mobile AI cleanup или URL resolving: настройте third-party API keys при необходимости

## Основные возможности

### Home Dashboard

- Today's state, статус daily note и today's focus
- Чтение задач из daily note и синхронизация checkbox обратно в Markdown
- Quick actions: plan today, quick capture, daily review, new project, open home document
- Recent activity, all projects, knowledge metrics и yearly activity heatmap
- Responsive layout для desktop, narrow pane и mobile

### Desktop AI Workspace

- Session sidebar и persistent history
- Streaming replies, retry и cancel
- Переключение model/provider и обработка provider auth
- Built-in direct API mode с оркестрацией FLOWnote Skills/tools
- Опциональный OpenCode bridge mode для существующих desktop OpenCode setups
- Connection diagnostics: provider, executable path, runtime mode, startup failures

### Built-in Skills

- Bundled Skills находятся в `bundled-skills/`
- При запуске FLOWnote синхронизирует bundled Skills в vault skills directory, по умолчанию `.opencode/skills`
- FLOWnote включает только bundled skill IDs, чтобы не подмешивать неожиданные Skills
- Режимы Skill injection: `summary` (рекомендуется), `full`, `off`

### Mobile Quick Capture

- One-tap capture в today's daily note
- iOS Shortcuts entrypoint для отправки текста прямо в FLOWnote
- Опциональный AI cleanup для голосового или сырого текста
- URL enrichment с graceful fallback:
  - resolver на выбор: `TianAPI` / `ShowAPI` / `Gugudata`
  - если resolver недоступен, но настроен AI provider: AI fallback
  - если ничего не настроено: сохранить plain text
- Original URL сохраняется в результате
- Есть fallback для iOS keyboard avoidance

<p align="center">
  <img src="assets/screenshots/ios-shortcut-setup.png" width="360" alt="Настройка iOS Shortcut для FLOWnote">
</p>

## Built-in Skill Pack

| Skill | Назначение |
|---|---|
| `ah` | Единая точка входа: меню и intent routing |
| `ah-note` | Создать today's daily note и подготовить план |
| `ah-capture` | Быстро записать мысль в daily note |
| `ah-inbox` | Пакетно разобрать захваченные идеи в actions/cards/processed |
| `ah-read` | Обработка highlights и literature notes |
| `ah-card` | Превратить insights в permanent notes и предложить связи |
| `ah-think` | Набор thinking models |
| `ah-review` | Daily review и reflection flow |
| `ah-week` | Weekly review с метриками и обработкой остаточных идей |
| `ah-month` | Monthly review и стратегическая рефлексия |
| `ah-project` | Создание project scaffold и templates |
| `ah-archive` | Архивация завершенных проектов и извлечение lessons |
| `ah-index` | Создание/обновление AI-readable vault index |
| `ah-memory` | Cross-skill memory и progress state conventions |

## Команды

- `打开` — открыть FLOWnote chat view
- `发送选中文本` — отправить выделенный текст
- `新建会话` — начать новую сессию
- `快速捕获想法` — quick capture на mobile

## Установка

### Через Community Plugins

После публикации установите FLOWnote через Obsidian Community Plugins, найдя `FLOWnote`. Затем в настройках FLOWnote выберите встроенный direct API mode или опциональный OpenCode bridge mode.

### Ручная установка

Поместите файлы в `<Vault>/.obsidian/plugins/flownote/`:

- `main.js`
- `manifest.json`
- `styles.css`

После этого перезагрузите плагины в Obsidian.

## Настройка

### Desktop

1. Откройте FLOWnote settings.
2. Оставьте default built-in AI mode, если хотите использовать свой provider API key без внешних локальных инструментов.
3. Выбирайте OpenCode bridge mode только если хотите подключить FLOWnote к desktop OpenCode runtime. Сначала установите Node.js, затем выполните `npm install -g opencode-ai` и проверьте доступность команды `opencode`.
4. В OpenCode bridge mode оставьте CLI path пустым для auto-detection или укажите absolute path при необходимости. WSL on Windows больше не поддерживается.

### Mobile

Mobile использует встроенный AI provider path FLOWnote. Из-за sandbox mobile-версия не может запускать desktop OpenCode CLI.

1. Настройте AI provider или custom OpenAI-compatible endpoint.
2. Настройте URL resolver provider и key, если нужен link parsing.
3. Укажите daily note path и заголовок секции для идей.

## Privacy, Data, and Network Disclosure

### Account Requirements

- Сам FLOWnote не требует отдельного FLOWnote account.
- Third-party AI или URL resolver требуют credentials, которые пользователь настраивает сам.

### Data Storage

- Состояние плагина хранится в `data.json` стандартным способом Obsidian.
- Capture output записывается в пользовательские заметки, например daily notes.

### Vault and Clipboard Access

Для Skill-driven workflows FLOWnote использует следующие Obsidian APIs. Их вызовы можно проверить в исходном коде в `runtime/`:

- **Vault enumeration** (`vault.getFiles`, `vault.getMarkdownFiles`) — для file-mention picker и поиска заметок по имени.
- **Vault read** (`vault.read`, `vault.cachedRead`) — чтобы передавать выбранные заметки в chat context и Skill prompts.
- **Vault write** (`vault.create`, `vault.modify`) — чтобы добавлять capture content, сохранять chat outputs и записывать Skill results в ваши заметки.
- **Clipboard access** — только для кнопок copy message/code внутри chat view. FLOWnote не читает clipboard самостоятельно; copy actions запускаются пользователем.

### Local System Access

Когда включен OpenCode bridge mode или CLI diagnostics, FLOWnote может искать OpenCode CLI на диске. Он читает следующие стандартные значения **только для path resolution**, не для telemetry или fingerprinting:

- `os.homedir()` и `process.env.USERPROFILE` — определить user home directory и раскрыть пути с `~`.
- `process.env.APPDATA`, `process.env.LOCALAPPDATA` — только Windows, для поиска стандартных install locations OpenCode и Node.
- `process.env.PATH`, `process.env.PATHEXT` — для поиска executable `opencode`.

FLOWnote не вызывает `os.hostname`, `os.userInfo` или `os.networkInterfaces` и не отправляет эти значения за пределы устройства.
При запуске опционального OpenCode child process FLOWnote передает только allowlisted path, locale, proxy, certificate и AI-provider environment values, а не весь environment процесса Obsidian.

### Telemetry

- В FLOWnote нет отдельного telemetry/analytics pipeline.
- Debug logs выводятся только в local console и управляются настройкой `debugLogs`.

### External Network Destinations

Следующие адреса могут использоваться только когда соответствующие функции включены пользователем:

- AI endpoints:
  - `api.deepseek.com`, `platform.deepseek.com`
  - `dashscope.aliyuncs.com`, `dashscope.console.aliyun.com`
  - `api.moonshot.cn`, `platform.moonshot.cn`
  - `open.bigmodel.cn`
  - `api.siliconflow.cn`, `cloud.siliconflow.cn`
  - custom endpoints пользователя
- URL resolver endpoints:
  - `apis.tianapi.com`, `www.tianapi.com`
  - `route.showapi.com`, `www.showapi.com`
  - `api.gugudata.com`, `www.gugudata.com`
- Опциональная локальная связь с OpenCode service через `127.0.0.1` / `localhost`
- Документация и installation links OpenCode на `opencode.ai`

### Paid Services

- Сам FLOWnote plugin бесплатный.
- Third-party APIs могут взимать плату по правилам своих provider.

## Development

```bash
npm run ci
npm run build:release
npm run check:submission
```

Release assets создаются в `release/`:

- `release/main.js`
- `release/manifest.json`
- `release/styles.css`

## Благодарности

- Спасибо [OpenCode](https://github.com/anomalyco/opencode) за runtime и SDK foundation.
- Спасибо [Claudian](https://github.com/YishenTu/claudian) за первоначальное вдохновение.
- Спасибо [Obsidian](https://obsidian.md) за plugin API.

## Лицензия

FLOWnote распространяется по лицензии MIT.
