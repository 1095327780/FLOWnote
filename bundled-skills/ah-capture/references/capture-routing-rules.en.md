# Capture Routing Rules

## Default Behavior

Append to today's daily note idea section.

## Destination Decision Table

| Condition | Destination |
|---|---|
| no project context | daily note |
| explicit project mention | project log |
| explicit "standalone capture" intent | standalone inbox |

## Line Format

```text
- HH:mm {raw user text} {#tags} (URL summary: ...)
```

## URL Handling

- Keep original URL
- Optional summary appended at end
- If summary unavailable: keep URL and briefly mark parse failure

## Minimal Normalization

- Remove filler words only for voice transcript input
- Keep user wording unchanged

## Write Targets

- Daily: `01-捕获层/每日笔记/YYYY-MM-DD.md`
- Project: `04-创造层/Projects/{name}/02-执行日志/YYYY-MM-DD.md`
- Inbox: `01-捕获层/收集箱/{slug}.md`
