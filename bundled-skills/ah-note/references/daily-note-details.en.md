# Daily Note Details

## Inputs to Collect

- One focus item for today
- 3-5 tasks maximum
- Optional references to week/month plans

## File Rules

- Path: `01-捕获层/每日笔记/YYYY-MM-DD.md`
- Create parent directory if missing
- Keep one daily file per date

## Merge Rules (when file exists)

1. Preserve existing checked tasks
2. Fill only missing required sections
3. Do not overwrite user free text unless explicitly requested

## Suggested Prompts

- "What is the single most important task for today?"
- "Besides that, list 2-4 more tasks."

## Completion Check

- Focus item exists
- Task list exists
- `Meta/.ai-memory/daily/YYYY-MM-DD.md` updated

## Failure Handling

- If date parsing fails, use system local date
- If write fails, return target path + error and retry once
