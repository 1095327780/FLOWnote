# ah Router Recipes

## Purpose

Provide deterministic routing when user intent is broad or ambiguous.

## Routing Priority

1. Explicit slash command (`/ah-read`) wins.
2. Explicit user intent phrase (e.g., "做周回顾") wins.
3. If multiple intents detected, ask one disambiguation question.
4. If still unclear, show compact menu.

## Ambiguity Resolution

Use one short question with 2-3 options:

- "你是要记录想法（ah-capture），还是整理已有想法（ah-inbox）？"
- "你是要日回顾（ah-review）还是周回顾（ah-week）？"

## Pending Task Hints

Read `Meta/.ai-memory/STATUS.md` and surface only top 3 actionable items.

## Output Template

```text
已识别你的目标：{intent}
将切换到：/{skill}
原因：{one-line reason}
```

## Anti-patterns

- Do not execute full downstream workflow in `ah`.
- Do not display long tutorials before routing.
- Do not invent project/domain names.
