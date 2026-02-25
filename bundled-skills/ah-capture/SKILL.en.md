---
name: ah-capture
description: Low-friction capture skill. Use to quickly store ideas, URLs, or transcribed voice notes into the proper destination.
---

# ah-capture

Capture raw user input with minimal friction. Default target is today's daily-note idea section.

## Must Follow

- Minimal memory read: `STATUS + daily(today)`.
- Use `capture_destination` for high-impact destination decisions.
- Keep user wording; only light normalization.

## `capture_destination`

1. Today's daily note (default)
2. Project execution log
3. Standalone inbox file

## Flow

1. Parse tags/URLs/project context.
2. Ask destination only when needed.
3. Write single-line entry with timestamp.
4. Update daily memory.

## Read References On Demand

- `references/capture-routing-rules.md`

## Output

- Return destination path and entry preview.
