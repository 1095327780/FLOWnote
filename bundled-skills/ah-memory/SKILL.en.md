---
name: ah-memory
description: Use to maintain FLOWnote's cross-skill memory files, including pending tasks, deferred items, and status buffers.
---

# Memory Maintenance

Goal: keep cross-skill state readable, current, and useful.

## Canonical Files

- `Meta/.ai-memory/STATUS.md`
- `Meta/.ai-memory/BUFFER.md` when needed

## Workflow

1. Read the current memory files if they exist.
2. Merge duplicate pending items.
3. Remove completed or obsolete entries.
4. Keep items grouped by this week, later, and blocked.
5. Write back a concise status file.

## Rules

- Missing memory files are normal on first use.
- Do not recreate the old hidden `Meta/ai-memory` path.
- Keep user wording where possible.
