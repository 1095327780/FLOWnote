# ah-memory Interface Spec (Flow v2)

This document defines the shared memory interface and minimum behaviors for all Flow skills.

## 1. Required Files

- `Meta/.ai-memory/STATUS.md`
- `Meta/.ai-memory/index.json`
- `Meta/.ai-memory/domains/{domain-slug}.md`
- `Meta/.ai-memory/projects/{project-slug}.md`
- `Meta/.ai-memory/daily/{YYYY-MM-DD}.md`

If missing, create before writing.

## 2. Read Interface

Read request payload:

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

Defaults:
- `budget = minimal`
- `mode = summary_only`

Recommended layers:
- `global` -> `STATUS.md`
- `domain` -> `domains/{domain}.md`
- `project` -> `projects/{project}.md`
- `daily` -> `daily/{date}.md`
- `mixed` -> global + target-layer summaries

## 3. Write Interface

At minimum after each skill run:

1. Write back to target layer file (domain/project/daily)
2. Update pending summary in `STATUS.md`
3. Update source mapping + timestamp in `index.json`

## 4. Suggested index.json Shape

```json
{
  "updated_at": "2026-02-23T10:00:00.000Z",
  "records": [
    {
      "id": "card-2026-02-23-001",
      "type": "card",
      "path": "02-培养层/...",
      "source": {
        "daily": "2026-02-23",
        "project": "project-slug",
        "domain": "domain-slug"
      },
      "updated_at": "2026-02-23T10:00:00.000Z"
    }
  ]
}
```

## 5. Failure Handling

- read failed: degrade to `STATUS.md` only and mark warning
- write failed: return target path + error and retry once
- index update failed: keep business output, mark index as stale
