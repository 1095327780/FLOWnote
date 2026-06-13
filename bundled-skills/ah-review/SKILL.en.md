---
name: ah-review
description: Use for evening daily review: compare today's execution with yesterday's plan, process records, route unfinished tasks, and update memory state.
---

# Daily Review

Goal: close today's loop and leave tomorrow clean.

## Startup

1. Read today's daily note from the configured `dailyNotes` folder.
2. Read `Meta/.ai-memory/STATUS.md` if it exists.
3. Read yesterday's daily note if it exists.
4. Read the latest weekly review if available.
5. Extract Focus, Records, Tasks, Tomorrow Plan, and yesterday's Tomorrow Plan.

## Workflow

1. Compare yesterday's plan with today's execution.
2. Check whether the week is still on track.
3. Process each record: permanent note, task, handled, or deferred to inbox.
4. Route unfinished tasks to tomorrow, this week, later, canceled, or done.
5. Update today's note and `STATUS.md`.
6. Ask for a minimal tomorrow plan.
7. Output a traceable summary with file paths.

## Rules

- The review is not a router by default. If the user mentions reading, projects, or cards, treat it as review input unless they explicitly invoke another command.
- If time is short, process the highest-value items and mark the rest for `ah-inbox`.
- Do not say the review is complete until note updates and `STATUS.md` updates are handled or explicitly skipped.
- Use configured note paths over examples.
