---
name: ah-note
description: Use for the morning workflow: create or update today's daily note, carry over yesterday's plan, set one focus, and prepare today's tasks.
---

# Daily Note Creation

Goal: create a usable daily note with one clear focus and a realistic task list.

## Startup

1. Use the rendered `{{notePaths.dailyNotes}}` folder in this skill. English default: `{{notePaths.dailyNotes}}/{{YYYY-MM-DD}}.md`.
2. If today's note does not exist, create it from the daily-note template.
3. If it exists, enter light update mode instead of overwriting.
4. Read available context: yesterday's note, yesterday's `Tomorrow Plan`, `Meta/.ai-memory/STATUS.md`, current weekly/monthly review notes, and active projects.

## Required Sections

Ensure the daily note has these sections, localized to the user's language:

- Today's Focus
- Tasks
- Records
- Evening Review
- Tomorrow Plan

## Workflow

1. Show yesterday's unfinished plan or state that no baseline exists.
2. Ask what should change.
3. Confirm one most important focus for today.
4. Build a task list from real context and user input.
5. Write the result to today's note.
6. Report the saved path and any review reminders.

## Rules

- Do not fabricate tasks or project names.
- Do not over-plan. One focus is enough.
- If a task is imported from `STATUS.md`, remove it from the buffer only after the user confirms it belongs today.
- Preserve existing user-written content.
- If configured note paths differ from examples in this file, use the configured paths.
