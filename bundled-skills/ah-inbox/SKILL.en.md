---
name: ah-inbox
description: Batch triage skill for unprocessed ideas. Use to scan recent captures and route each item to action, card, or archive.
---

# ah-inbox

Batch-process recent idea backlog.

## Must Follow

- Default read: `STATUS + recent daily summaries`.
- Every item must be triaged: action / card / archive.
- Card creation must call `ah-card`.

## Flow

1. Scan last 7 days of daily-note idea sections.
2. Deduplicate and triage item-by-item.
3. Write back status markers to source lines.
4. Update `STATUS.md` and `index.json`.

## Read References On Demand

- `references/inbox-triage-rules.md`

## Output

- Return processed counts and remaining backlog.
