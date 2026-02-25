# Capture Routing Rules

## Default Behavior

Append to today's daily note idea section.

## Destination Decision Table

| Condition | Destination |
|---|---|
| no project context | daily note |
| explicit project mention | project log |
| explicit "单独收集" | standalone inbox |

## Line Format

```text
- HH:mm {raw user text} {#tags} （链接摘要：...）
```

## URL Handling

- Keep original URL
- Optional summary at end
- If summary unavailable: keep URL and mark parse failure briefly

## Minimal Normalization

- Remove filler words for voice transcripts only
- Keep user wording intact

## Write Targets

- Daily: `01-捕获层/每日笔记/YYYY-MM-DD.md`
- Project: `04-创造层/Projects/{name}/02-执行日志/YYYY-MM-DD.md`
- Inbox: `01-捕获层/收集箱/{slug}.md`
