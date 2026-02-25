# Flow Contract v2 - Memory Contract

`ah-memory` is a shared base capability for all Flow skills.

## Layered Memory Layout

```text
Meta/.ai-memory/
├── STATUS.md
├── index.json
├── domains/
│   └── {domain-slug}.md
├── projects/
│   └── {project-slug}.md
└── daily/
    └── YYYY-MM-DD.md
```

## Read Policy (Default)

Use minimal reads by default to save tokens.

- `ah-note`: `STATUS + daily(today)`
- `ah-capture`: `STATUS + daily(today)` (+ `project` if context exists)
- `ah-read`: `STATUS + domain` (+ `project` when needed)
- `ah-think`: `STATUS + current context layer`
- `ah-review`: `STATUS + daily(today) + active project summaries`
- `ah-card`: source context + domain summary
- `ah-project`: `STATUS + project`
- `ah-week/ah-month`: summary-only reads across layers

## Memory Call Schema

```json
{
  "scope": "global | domain | project | daily | mixed",
  "context_refs": {
    "domain": "string|null",
    "project": "string|null",
    "date": "YYYY-MM-DD|null"
  },
  "budget": "minimal | normal | deep",
  "mode": "summary_only | with_details"
}
```
