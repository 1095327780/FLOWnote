---
name: ah-project
description: Use to create a new project folder and project overview note with goals, status, tasks, milestones, and linked knowledge context.
---

# Project Creation

Goal: turn an intended outcome into a structured project workspace.

## Startup

1. Ask for the project name, outcome, deadline, and priority if missing.
2. Use the configured `activeProjects` folder. English default: `{{notePaths.activeProjects}}`.
3. Create a project folder and a `Project Overview.md` note.

## Project Overview

Include:

- Status
- Priority
- Domain
- Goal
- Milestones
- Tasks
- Related notes
- Review log

## Rules

- Do not create fake tasks. Ask or infer only from user-provided context.
- If a related domain page exists, link it.
- If the project is already present, update it instead of duplicating.

