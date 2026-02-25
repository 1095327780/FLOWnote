# Inbox Triage Rules

## Scope

Scan last 7 days by default; allow user override.

## Extraction Rules

- Source section: daily note idea section
- Skip items already marked as processed
- Collapse exact duplicates

## Triage Outcomes

1. Action: convert to actionable task
2. Card: send to `ah-card`
3. Archive: mark as processed with brief reason

## Action Quality Check

Action item must include:
- verb
- object
- when (today/this week/date)

## Progress Markers

Append one of:
- `→ 任务`
- `→ 卡片`
- `✅ 已归档`

## Batch Summary

Return:
- total scanned
- processed by type
- remaining
