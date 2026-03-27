# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

FLOWnote is an Obsidian plugin that integrates the OpenCode AI runtime and SDK into Obsidian for AI-assisted note management. It ships a domain-specific skill pack for knowledge workflows (capture, cultivate, connect, create) — not just generic chat.

## Build and Development Commands

```bash
npm run build           # Full release build (vendors SDK + embeds skills + esbuild bundle)
npm test                # Run all tests (Node.js native test runner)
npm run ci              # Full CI pipeline: guards + syntax checks + file size + tests
npm run release:check   # CI + build + submission readiness check
```

Individual guards and checks:
```bash
npm run guard:repo-hygiene      # Ensures data.json not committed
npm run guard:source-of-truth   # Blocks src/ directory reintroduction
npm run guard:runtime-contract  # Prevents legacy patterns (dynamic Function, old module loading)
npm run verify:version-sync     # Checks manifest.json ↔ package.json version match
npm run check                   # Syntax-check main.js
npm run check:runtime           # Syntax-check all runtime/*.js files
npm run check:file-size         # Bundle size guard
```

Run a single test:
```bash
node --test tests/runtime/<test-file>.test.js
```

## Architecture

**Pure JavaScript / CommonJS** — no TypeScript, intentionally enforced by `guard-runtime-contract.js`.

### Build Pipeline

1. `build-sdk-vendor.mjs` — bundles `@opencode-ai/sdk` into `runtime/vendor/opencode-sdk-v2-client.cjs`
2. `build-release.mjs` — embeds `bundled-skills/` into `runtime/generated/bundled-skills-embedded.js`, then runs esbuild to produce `release/main.js` (CJS, ES2020, `obsidian` external)

The root `main.js` is the bundled plugin entry loaded by Obsidian. The `release/` directory contains the distributable artifact.

### Runtime Modules (`runtime/`)

Source code lives in `runtime/`, organized by feature:

- **Core services**: `flownote-client.js` (SDK wrapper), `sdk-transport.js` (session management), `skill-service.js` (skill loading), `session-store.js` (persistence)
- **Plugin infrastructure** (`plugin/`): session bootstrap, bundled skill management, model catalog, module loading
- **UI views** (`view/`): layout rendering, message display, question/dialog UI, command routing
- **Chat** (`chat/`): `chat-orchestrator.js` — message streaming and orchestration
- **Transport layer** (`transports/`): event reducers, finalizers, question tracking, completion signals
- **Settings** (`settings/`): provider auth, settings serialization
- **Mobile** (`mobile/`): quick capture modal, daily note service, URL enrichment, mobile AI
- **i18n**: bilingual support (en, zh-CN) — locale detection, message bundles
- **Payload** (`payload/`): response part merging, markdown processing

### Bundled Skills (`bundled-skills/`)

22 skills for knowledge management workflows (daily notes, reviews, capture, projects, etc.). On startup, these are synced to the vault's `.opencode/skills/` directory. Skills are embedded into the bundle at build time.

### Key Constraints

- **No `src/` directory** — enforced by guard script; all source lives in `runtime/`
- **No TypeScript** — enforced by guard script
- **`data.json` must never be committed** — contains user state; `data.example.json` is the schema template
- **Version sync** — `manifest.json` and `package.json` versions must match
- **Tests use `node:test` and `node:assert/strict`** — no test framework dependency
