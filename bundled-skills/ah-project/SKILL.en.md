---
name: ah-project
description: Project bootstrap workflow. Use when starting a new project and needing standardized scaffolding, overview file, and domain links.
---

# ah-project

Create Flow-standard project structure and project overview.

## Must Follow

- Default minimal memory read: `STATUS + current project context`.
- Templates:
  - `assets/templates/Project-Template.md`
  - `assets/templates/Project-Execution-Log-Template.md`
  - `assets/templates/Project-Thinking-Template.md`
  - `assets/templates/Project-Resource-Index-Template.md`
  - `assets/templates/Project-Output-Template.md`
- Critical branch: `question gate: project_scaffold`
- Never invent project IDs. Always scan actual directories first.

## `project_scaffold` Rules

1. Full layered scaffold (default):
   - `📍 项目总览.md`
   - `01-规划与范围/`
   - `02-执行日志/`
   - `03-思考记录/`
   - `04-资料与引用/`
   - `05-产出草稿/`
   - `06-复盘归档/`
   - `_assets/`
2. Lite scaffold: `📍 项目总览.md` + `_assets/`

If user does not choose, default to full layered scaffold.

## Workflow

1. Collect project info (name, goal, deadline, domain).
2. Scan `04-创造层/Projects/` and compute next project ID.
3. Create folders by `project_scaffold`.
4. Generate `📍 项目总览.md` and optional base docs from templates.
5. Update domain project links and project memory layer.

## Read References On Demand

- Scaffolding, naming, and overwrite safety rules: `references/project-scaffold-details.md`

## Output

- Project path and created structure.
- Next steps: use `ah-capture/ah-review` for logs, `ah-think` for deep reasoning.
