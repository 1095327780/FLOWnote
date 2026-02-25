---
name: ah-note
description: Create or update today's daily note. Use for morning startup, day planning, and filling missing daily-note sections.
---

# ah-note

Create/update `01-捕获层/每日笔记/YYYY-MM-DD.md`.

## Must Follow

- Minimal memory read: `STATUS + daily(today)`.
- Template: `assets/templates/Daily-Note-Template.md`.
- Do not overwrite user free text unless requested.

## Flow

1. Check if today's note exists.
2. Create from template if missing; otherwise patch required sections.
3. Collect one focus item and 3-5 tasks.
4. Update `Meta/.ai-memory/daily/YYYY-MM-DD.md`.

## Read References On Demand

- `references/daily-note-details.md`

## Output

- Return path, focus item, and next-step suggestion.
