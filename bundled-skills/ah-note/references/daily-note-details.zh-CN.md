# Daily Note Details

## Inputs to Collect

- Today's single focus item
- 3-5 tasks max
- Optional references to week/month plans

## File Rules

- Path: `01-捕获层/每日笔记/YYYY-MM-DD.md`
- Create parent dir if missing
- Keep one daily file per date

## Merge Rules (when file exists)

1. Preserve existing checked tasks
2. Fill missing required sections only
3. Do not overwrite user free text unless asked

## Suggested Prompts

- "今天最重要的一件事是什么？"
- "除了这件事，再列 2-4 个任务。"

## Completion Check

- Focus item exists
- Task list exists
- `Meta/.ai-memory/daily/YYYY-MM-DD.md` updated

## Failure Handling

- If date parsing fails, use system local date
- If write fails, return target path + error and retry once
