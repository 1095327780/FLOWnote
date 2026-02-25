---
name: ah-memory
description: Shared layered memory foundation for all Flow skills. Use to read and write minimal context across global, domain, project, and daily memory layers.
---

# ah-memory

Shared memory foundation for all Flow skills. It does not run business workflows by itself.

## Structure

```text
Meta/.ai-memory/
├── STATUS.md
├── index.json
├── domains/{domain}.md
├── projects/{project}.md
└── daily/{YYYY-MM-DD}.md
```

## Default Strategy

- Read: minimal on-demand (`budget=minimal`, `mode=summary_only`).
- Write: only relevant layer + update `STATUS.md` + update `index.json`.
- Never load one huge memory file by default.

## Invocation Contract

```json
{
  "scope": "global | domain | project | daily | mixed",
  "context_refs": {"domain":"string|null","project":"string|null","date":"YYYY-MM-DD|null"},
  "budget": "minimal | normal | deep",
  "mode": "summary_only | with_details"
}
```

## Adaptation Rules

- `ah-note`: `STATUS + daily(today)`
- `ah-capture`: `STATUS + daily(today)`, add project when needed
- `ah-read`: `STATUS + domain`, add project when needed
- `ah-think`: `STATUS + current context layer`
- `ah-review`: `STATUS + daily(today) + active project summaries`
- `ah-card`: source context + domain summary
- `ah-project`: `STATUS + project`
- `ah-week/ah-month`: summary mode across layers

## Read References On Demand

- Interface and failure handling: `references/skill-interface-spec.md`
- Read/write examples: `references/layered-memory-examples.md`
