---
name: ah-card
description: Evergreen card creation workflow. Use to convert capture, reading, and project insights into reusable permanent notes with backlinks.
---

# ah-card

Convert insights into high-quality evergreen cards with backlinks and index mounting.

## Must Follow

- Default minimal memory read: source context + domain summary.
- Template: `assets/templates/Evergreen-Card-Template.md`
- Critical branch: `question gate: card_target`
- Backlink contract: at least one of `daily_ref`, `project_ref`, `source_refs` must be non-empty.
- Card title must be a standalone claim sentence.

## `card_target` Rules

Confirm primary mount target before save:
1. Topic page (default)
2. Domain page
3. Project overview page

If user does not choose, default to topic page.

## Workflow

1. Confirm source: daily/read/project.
2. Select one core claim (one card, one point).
3. Generate body and metadata using template.
4. Build links:
   - Source backlink
   - At least two related note links (placeholders allowed but mark them)
5. Update topic/domain/project index by `card_target`.
6. Update mapping in `index.json`.

## Read References On Demand

- Card quality gate and structure details: `references/card-workflow-details.md`
- Zettelkasten principles: `references/zettelkasten-principles.md`

## Output

- New card path.
- Key links created.
- If source is reading, ask whether to continue batch carding.
