---
name: ah
description: Unified Flow entry skill. Use when users are unsure which ah-* skill to run, or when they need a menu-driven intent router.
---

# ah

Top-level Flow router. It routes to downstream skills and does not execute full downstream workflows.

## Must Follow

- Read `Meta/.ai-memory/STATUS.md` first.
- Never invent project/topic/domain names.
- Do intent routing only at menu stage.

## Route Targets

- `ah-note` daily startup
- `ah-capture` quick capture
- `ah-inbox` batch triage
- `ah-read` reading workflow
- `ah-card` evergreen cards
- `ah-think` deep reasoning
- `ah-project` project bootstrap
- `ah-archive` project archive
- `ah-review` daily review
- `ah-week` weekly review
- `ah-month` monthly review
- `ah-index` index maintenance

## Read References On Demand

- `references/router-recipes.md`

## Output

- State selected skill and one-line reason.
