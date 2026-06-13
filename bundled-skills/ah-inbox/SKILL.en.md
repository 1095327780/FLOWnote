---
name: ah-inbox
description: Use to process accumulated inbox or leftover records into tasks, permanent notes, projects, or archive decisions.
---

# Inbox Processing

Goal: turn loose captures into clear next states.

## Sources

Use configured note paths. English defaults:

- Leftover records: `{{notePaths.dailyNotes}}` sections handed off by `ah-review`
- Daily notes: `{{notePaths.dailyNotes}}`
- Permanent notes: `{{notePaths.permanentNotes}}`
- Projects: `{{notePaths.activeProjects}}`

## Workflow

1. Read the target inbox or leftover section.
2. Group items by intent: task, permanent-note candidate, project material, reference, or discard.
3. Ask for confirmation before bulk changes.
4. Move each item to the right destination or mark it handled.
5. Report counts and updated paths.

## Rules

- Do not invent classifications if the content is ambiguous. Ask one compact question.
- Preserve source links and timestamps where useful.
- High-value ideas should become `ah-card` candidates.
- Operational items should become tasks or project notes.
