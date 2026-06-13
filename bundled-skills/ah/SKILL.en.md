---
name: ah
description: Unified FLOWnote skill router. Use when the user is unsure which workflow to run, wants a menu, or describes an intent that should be routed to a specific skill.
---

> For Obsidian read, search, and write actions, prefer the built-in Obsidian tools exposed by FLOWnote.

# FLOWnote Knowledge Assistant

This is the central router for the FLOW workflow. Read `Meta/.ai-memory/STATUS.md` first when available, summarize pending items, then route the user to the right skill.

## Startup

1. Try to read `Meta/.ai-memory/STATUS.md`.
2. If it does not exist, treat it as an empty state. Do not repeatedly search for alternatives.
3. Show any pending items from the status file.
4. Ask what the user wants to do next or present the menu below.

## Menu

1. Create today's daily note -> `ah-note`
2. Quick capture -> `ah-capture`
3. Process inbox leftovers -> `ah-inbox`
4. Create a permanent note -> `ah-card`
5. Reading workflow -> `ah-read`
6. Deep thinking / mental models -> `ah-think`
7. Create a project -> `ah-project`
8. Archive a project -> `ah-archive`
9. Daily review -> `ah-review`
10. Weekly review -> `ah-week`
11. Monthly review -> `ah-month`
12. Yearly review -> `ah-year`
13. Update indexes / memory -> `ah-memory`
14. Initialize a vault -> `ah-init`
15. Process legacy notes -> `ah-legacy`

Route home/dashboard requests such as "update home", "refresh Home", or "fix homepage" to `ah-init`.

## Rules

- Never invent projects, tasks, or notes. Read real files first.
- Use the configured note path table from the system prompt. For broad folders, derive them from the configured daily, permanent/topic/literature, domain, active project, and archive paths.
- Keep routing explicit. If the user only gives content, ask one short question or choose the most likely workflow.
- When another skill finishes, return to this router if the user still has pending choices.
