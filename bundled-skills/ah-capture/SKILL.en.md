---
name: ah-capture
description: Use for quick daytime capture into today's daily note: records, new tasks, completed tasks, and tomorrow-plan items with minimal friction.
---

# Quick Capture

Goal: capture first, organize later, without losing useful information.

## Startup

1. Locate today's daily note in the configured `dailyNotes` folder. English default: `{{notePaths.dailyNotes}}/{{YYYY-MM-DD}}.md`.
2. If it does not exist, create a minimal daily note with Focus, Tasks, Records, Evening Review, and Tomorrow Plan sections.
3. Read the current Tasks and Records sections before writing.

## Routing

Choose one route:

- Completed task: update the best matching `- [ ]` task to `- [x]`.
- Tomorrow task: append to Tomorrow Plan.
- New task: append to Tasks.
- Normal thought: append to Records.
- Multi-line input: split and route each line.

If unclear, ask once: "Should this go to Records, Tasks, or Tomorrow Plan?"

## Write Formats

- Record: `- {{HH:mm}} {{original text}}`
- Task: `- [ ] {{task}}`
- Completed task: change `- [ ]` to `- [x]`

## Rules

- Keep the user's meaning and wording. Only remove obvious filler if asked.
- Do not route across days unless the user explicitly says tomorrow or another date.
- Confirm what was written and where.
- Use configured note paths over any hardcoded examples.

