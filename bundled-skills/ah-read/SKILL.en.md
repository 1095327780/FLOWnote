---
name: ah-read
description: Reading workflow skill. Use to transform highlights/notes into structured insights, literature notes, and card candidates.
---

# ah-read

Turn reading input into structured outputs: progress + literature note + card candidates.

## Must Follow

- Default read: `STATUS + domain`; add `project` when needed.
- Templates: `assets/templates/Reading-Progress-Template.md`, `assets/templates/Literature-Note-Template.md`.
- Use `think_insertion` for complex reasoning branches.

## Flow

1. Check existing progress state.
2. Process input in batches.
3. For each batch, extract insights/evidence/card candidates.
4. Create or update literature note.
5. Write back domain/project memory and index.

## Read References On Demand

- `references/read-batch-details.md`
- `../ah-memory/references/skill-interface-spec.md`

## Output

- Literature-note path, progress status, and card candidates.
