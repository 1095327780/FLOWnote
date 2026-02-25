# Layered Memory Examples

## Example: Daily Capture

Read:
- STATUS
- daily/today

Write:
- append capture summary to daily/today
- update STATUS pending counters

## Example: Reading Session

Read:
- STATUS
- domain/psychology

Write:
- domain/psychology progress
- index.json source mapping

## Example: Project Session

Read:
- STATUS
- projects/flownote-v2

Write:
- projects/flownote-v2 milestone update
- STATUS active project summary

## Token-saving Pattern

Default to `summary_only` unless user explicitly asks historical deep dive.
