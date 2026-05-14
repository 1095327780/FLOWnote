# FLOWnote

Language: **English** | [简体中文](README.zh-CN.md)

**FLOWnote is an Obsidian plugin that makes your notes flow — from raw capture to finished work — powered by an OpenCode-backed AI workspace and a skill pack purpose-built for knowledge management.**

> **OpenCode is required.** Install OpenCode on your desktop before using FLOWnote's chat, sessions, and skill workflows.

## Why FLOWnote

Most note-taking systems collapse for the same reason: ideas pile up faster than you can process them, and after a few weeks 70% of your notes never get opened again. FLOWnote is built around a simple bet — if the friction of moving an idea forward is low enough, you'll actually do it, day after day. That bet has a name: **the FLOW method.**

```
Feed → Lift → Organize → Work
 ↓      ↓        ↓         ↓
daily  perm    domain    project
notes  notes    pages     output
```

- **F · Feed** — single-tap capture into today's daily note. No folder picking, no tag debate.
- **L · Lift** — turn captured ideas into permanent notes with assertive titles, atomic claims, and recommended links.
- **O · Organize** — domain pages act as your "workbench," surfacing the notes you actually need for the project in front of you.
- **W · Work** — projects scaffold themselves with their supporting notes, and review skills (`week`, `month`, `year`) keep the loop honest.

The skills in `bundled-skills/` automate the boring parts (numbering, folder layout, link maintenance, index refresh) so you can stay focused on what to write, think about, and do next.

## Video walkthrough (Chinese, on Bilibili)

The author publishes a six-episode tutorial series on **FLOW 笔记法** at:

📺 **[Bilibili — FLOW 笔记法系列](https://space.bilibili.com/24543451/lists/7386412?type=season)**

| # | Topic |
|---|---|
| 01 | Intro — system overview and the daily 15-minute loop |
| 02 | Reading — turning highlights into literature notes |
| 03 | Permanent notes — atomic claims, assertive titles, AI-assisted crafting |
| 04 | Knowledge connection — topic pages vs. domain pages |
| 05 | Projects & review — weekly / monthly / yearly cadence |
| 06 | AI overview — full setup walkthrough (in production) |

## Requirements

- OpenCode installed on your desktop (required): [OpenCode](https://opencode.ai) / [GitHub](https://github.com/anomalyco/opencode)
- Obsidian v1.5.0+
- For mobile AI cleanup or URL resolving, configure third-party API keys as needed

## Core Capabilities

### Desktop AI workspace

- Session sidebar with persistent history
- Streaming chat responses with retry / cancel
- Model and provider switching, with provider-side auth handling
- Driven by the OpenCode SDK for session and tool orchestration
- Connection diagnostics for executable path, runtime mode, and startup failures

### Built-in skills (bundled and auto-synced)

- Skills are packaged in `bundled-skills/`
- On startup, FLOWnote syncs bundled skills into your vault skills directory (default: `.opencode/skills`)
- Only bundled skill IDs are enabled for execution in FLOWnote's skill menu
- Skill injection modes: `summary` (recommended), `full`, `off`

### Mobile quick capture

- One-tap capture modal that writes into today's daily note
- Optional AI cleanup for spoken / raw text
- URL enrichment with graceful fallback:
  - Pick one resolver: `TianAPI` / `ShowAPI` / `Gugudata`
  - If the resolver is unavailable and an AI provider is configured: AI fallback
  - If neither is configured: keep plain text
- The original URL is preserved in the output
- iOS keyboard avoidance fallback for focus visibility

## Built-in Skill Pack

| Skill | Purpose |
|---|---|
| `ah` | Router/entrypoint: menu + intent-based dispatch |
| `ah-note` | Create today's daily note with planning context |
| `ah-capture` | Low-friction idea capture into the daily note |
| `ah-inbox` | Batch-process captured ideas into actions/cards |
| `ah-read` | Reading-note processing and highlight consolidation |
| `ah-card` | Turn insights into permanent notes with link recommendations |
| `ah-think` | Thinking-models toolkit (Feynman, first principles, inversion, …) |
| `ah-review` | Daily review and reflection flow |
| `ah-week` | Weekly review with metrics + residual idea handling |
| `ah-month` | Monthly review and strategy-level reflection |
| `ah-project` | Create a structured project scaffold and templates |
| `ah-archive` | Archive completed projects with lessons extracted |
| `ah-index` | Build / update AI-readable vault index |
| `ah-memory` | Cross-skill memory / progress state conventions |

## Commands

- `打开` — Open the FLOWnote chat view
- `发送选中文本` — Send the current selection
- `新建会话` — Start a new session
- `快速捕获想法` — Quick-capture (mobile)

## Installation

### Community plugin directory

After approval, install from Community Plugins by searching `FLOWnote`. Before enabling FLOWnote, make sure OpenCode is installed and available on your desktop.

### Manual installation

Drop these files into `<Vault>/.obsidian/plugins/flownote/`:

- `main.js`
- `manifest.json`
- `styles.css`

Then reload plugins in Obsidian.

## Setup

### Desktop

1. Install Node.js first, then run `npm install -g opencode-ai` to install OpenCode and verify the `opencode` command is available.
2. Open FLOWnote settings.
3. Keep CLI path empty for auto-detection, or set an explicit path if needed.
4. Choose a launch strategy (`auto` / native install). WSL on Windows is no longer supported.

### Mobile

Even when you're primarily on mobile, FLOWnote still needs OpenCode installed on your desktop.

1. Configure an AI provider (or a custom OpenAI-compatible endpoint).
2. Configure a URL resolver provider and key if you want link parsing.
3. Set your daily note path and idea section header.

## Privacy, Data, and Network Disclosure

### Account requirements

- FLOWnote itself does not require a separate FLOWnote account.
- Third-party AI or URL resolver usage requires user-provided credentials.

### Data storage

- Plugin state is stored in plugin `data.json` (Obsidian standard behavior).
- Capture output is written to user notes (for example, daily notes).

### Vault and clipboard access

FLOWnote requires the following Obsidian APIs to deliver its skill-driven workflows. Each call site can be reviewed in the source code under `runtime/`:

- **Vault enumeration** (`vault.getFiles`, `vault.getMarkdownFiles`) — to populate the file-mention picker and let skills locate notes by name.
- **Vault read** (`vault.read`, `vault.cachedRead`) — to feed selected notes into chat context and skill prompts.
- **Vault write** (`vault.create`, `vault.modify`) — to append captured ideas, save chat outputs, and persist skill results into your notes.
- **Clipboard access** — used by message/code copy buttons inside the chat view. FLOWnote never reads the clipboard on its own; copy operations are user-initiated.

### Local system access

FLOWnote runs as a desktop-aware plugin and needs to locate the OpenCode CLI on disk. It reads the following standard environment values **solely for path resolution**, not for telemetry or fingerprinting:

- `os.homedir()` and `process.env.USERPROFILE` — locate the user home directory to resolve `~`-relative paths.
- `process.env.APPDATA`, `process.env.LOCALAPPDATA` — Windows-only, used to look up the conventional install location of OpenCode and Node.
- `process.env.PATH`, `process.env.PATHEXT` — used to search for the `opencode` executable.

FLOWnote does not call `os.hostname`, `os.userInfo`, or `os.networkInterfaces`, and does not transmit any of the values above off your device.

### Telemetry

- No standalone telemetry/analytics pipeline is implemented by FLOWnote.
- Debug logs are local console output and controlled by `debugLogs`.

### External network destinations (when features are enabled by user)

- AI endpoints (examples):
  - `api.deepseek.com`, `platform.deepseek.com`
  - `dashscope.aliyuncs.com`, `dashscope.console.aliyun.com`
  - `api.moonshot.cn`, `platform.moonshot.cn`
  - `open.bigmodel.cn`
  - `api.siliconflow.cn`, `cloud.siliconflow.cn`
  - user-defined custom endpoint
- URL resolver endpoints:
  - `apis.tianapi.com`, `www.tianapi.com`
  - `route.showapi.com`, `www.showapi.com`
  - `api.gugudata.com`, `www.gugudata.com`
- Local runtime communication to OpenCode service on local machine via `127.0.0.1` / `localhost`
- OpenCode documentation/install links resolve under `opencode.ai`

### Paid services

- FLOWnote plugin itself is free.
- Third-party APIs may charge by their own pricing plans.

## Development

```bash
npm run ci
npm run build:release
npm run check:submission
```

Release assets are generated in `release/`:

- `release/main.js`
- `release/manifest.json`
- `release/styles.css`

## Acknowledgments

- Thanks [OpenCode](https://github.com/anomalyco/opencode) for the runtime and SDK foundation.
- Thanks [Claudian](https://github.com/YishenTu/claudian) for the original inspiration.
- Thanks [Obsidian](https://obsidian.md) for the plugin API.

## License

FLOWnote is distributed under the MIT License.
