# ah Router Recipes

## Purpose

Provide deterministic routing when user intent is broad or ambiguous.

## Routing Priority

1. Explicit slash command (`/ah-read`) wins.
2. Explicit user intent phrase wins.
3. If multiple intents are detected, ask one disambiguation question.
4. If still unclear, show compact menu.

## Ambiguity Resolution

Use one short question with 2-3 options:

- "Do you want to capture ideas (`ah-capture`) or triage existing ideas (`ah-inbox`)?"
- "Do you want daily review (`ah-review`) or weekly review (`ah-week`)?"

## Pending Task Hints

Read `Meta/.ai-memory/STATUS.md` and surface only top 3 actionable items.

## Output Template

```text
Detected intent: {intent}
Switching to: /{skill}
Reason: {one-line reason}
```

## Anti-patterns

- Do not run full downstream workflows in `ah`.
- Do not output long tutorials before routing.
- Do not invent project/domain names.
