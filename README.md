# FLOWnote

Language: **English** | [简体中文](README.zh-CN.md)

FLOWnote is an OpenCode-powered plugin for AI-assisted note management.

It is designed as an end-to-end workflow for:

- Capture -> Cultivate -> Connect -> Create
- Daily execution + weekly/monthly review
- Skill-driven structured writing, not generic chat only

## What Makes FLOWnote Different

FLOWnote is inspired by [Claudian](https://github.com/YishenTu/claudian), which embeds Claude Code into Obsidian.

FLOWnote takes a different path:

- Integrates **OpenCode** runtime into Obsidian
- Ships a **domain-specific skill pack** for knowledge workflows
- Focuses on **note management loops**, not just agent access

In short: this is not only "OpenCode inside Obsidian", but "OpenCode + a complete note-management skill system".

## Core Capabilities

### Desktop AI workspace

- Session sidebar with persistent history
- Streaming chat responses and retry/cancel flows
- Model/provider switching and provider auth handling
- Connection diagnostics for executable path, runtime mode, and startup failures

### Built-in skills (bundled and auto-synced)

- Built-in skills are packaged in `bundled-skills/`
- On startup, FLOWnote syncs bundled skills into your vault skills directory (default: `.opencode/skills`)
- Only bundled skill IDs are enabled for execution in FLOWnote's skill menu
- Skill injection modes: `summary` (recommended), `full`, `off`

### Mobile quick capture

- One-tap capture modal to write into daily note
- Optional AI cleanup for spoken/raw text
- URL enrichment pipeline with fallback:
  - Resolver provider (choose one): `TianAPI` / `ShowAPI` / `Gugudata`
  - If resolver unavailable and AI configured: AI fallback
  - If no resolver and no AI key: keep plain text
- Original URL is preserved in output
- iOS keyboard avoidance fallback is included for focus visibility

## Built-in Skill Pack

FLOWnote currently bundles these skills:

| Skill | Purpose |
|---|---|
| `ah` | Router/entrypoint: menu + intent-based dispatch |
| `ah-note` | Create today's daily note with planning context |
| `ah-capture` | Low-friction idea capture into daily note |
| `ah-inbox` | Batch process captured ideas into actions/cards |
| `ah-read` | Reading-note processing and highlight consolidation |
| `ah-card` | Turn insights into permanent notes with link recommendations |
| `ah-think` | Thinking models toolkit (Feynman, first principles, inversion, etc.) |
| `ah-review` | Daily review and reflection flow |
| `ah-week` | Weekly review with metrics + residual idea handling |
| `ah-month` | Monthly review and strategy-level reflection |
| `ah-project` | Create structured project scaffold and templates |
| `ah-archive` | Archive completed projects with lessons extracted |
| `ah-index` | Build/update AI-readable vault index |
| `ah-memory` | Cross-skill memory/progress state conventions |

## Commands

- `打开`
- `发送选中文本`
- `新建会话`
- `快速捕获想法` (mobile)

## Installation

### Community plugin directory

After approval, install from Community Plugins by searching `FLOWnote`.

### Manual installation

Put these files into:

`<Vault>/.obsidian/plugins/flownote/`

- `main.js`
- `manifest.json`
- `styles.css`

Then reload plugins in Obsidian.

## Setup

### Desktop setup

1. Install OpenCode locally.
2. Open FLOWnote settings.
3. Keep CLI path empty first (auto-detect), or set explicit path if needed.
4. Choose launch strategy (`auto` / native Windows / WSL) when applicable.

### Mobile setup

1. Configure AI provider (or custom OpenAI-compatible endpoint).
2. Configure URL resolver provider and key if link parsing is needed.
3. Set daily note path and idea section header.

## Privacy, Data, and Network Disclosure

### Account requirements

- FLOWnote itself does not require a separate FLOWnote account.
- Third-party AI or URL resolver usage requires user-provided credentials.

### Data storage

- Plugin state is stored in plugin `data.json` (Obsidian standard behavior).
- Capture output is written to user notes (for example, daily notes).

### Telemetry

- No standalone telemetry/analytics pipeline is implemented by FLOWnote.
- Debug logs are local console output and controlled by `debugLogs`.

### External network destinations (when features are enabled by user)

- AI endpoints (examples):
  - `api.deepseek.com`
  - `dashscope.aliyuncs.com`
  - `api.moonshot.cn`
  - `open.bigmodel.cn`
  - `api.siliconflow.cn`
  - user-defined custom endpoint
- URL resolver endpoints:
  - `apis.tianapi.com`
  - `route.showapi.com`
  - `api.gugudata.com`
- Local runtime communication to OpenCode service on local machine

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

## Acknowledgements

- Inspired by [Claudian](https://github.com/YishenTu/claudian) by YishenTu.
- Claudian is MIT licensed, and FLOWnote also uses MIT license for this project.
