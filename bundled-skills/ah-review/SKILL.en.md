---
name: ah-review
description: Daily review workflow. Use at end of day to reflect, triage captured ideas, and define next-day focus.
---

# ah-review

Run evening review: reflect on today, process ideas, and set tomorrow focus.

## Must Follow

- Default minimal memory read: `STATUS + daily(today) + active project summaries`.
- Critical branch: `question gate: review_triage`
- Every idea must be triaged to action/card/archive.
- When carding, call `ah-card` and resume this flow after completion.

## `review_triage` Rules

Ask one decision per pending item:
1. Action
2. Card
3. Archive

If user does not choose, default to Action.

## Workflow

1. Read today's note and create short review summary.
2. Run reflection prompts (completion/learnings/improvements/tomorrow focus).
3. Scan idea section and apply `review_triage` item by item.
4. Write status marks and tomorrow focus back to daily note.
5. Update daily memory and `STATUS.md`.

## Read References On Demand

- Question bank, stop criteria, anti-patterns: `references/daily-review-playbook.md`

## Output

- Daily review summary.
- Triage counts.
- One most important task for tomorrow.
