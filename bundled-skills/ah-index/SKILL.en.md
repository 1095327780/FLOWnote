---
name: ah-index
description: Knowledge-base index maintenance workflow. Use when initializing or refreshing vault structure manifest, counts, and key entry points.
---

# ah-index

Maintain the knowledge-base index so AI can quickly understand current vault state.

## Must Follow

- Scan scope must follow Flow four-layer directory convention.
- Index output path: `Meta/索引/kb-manifest.md`.
- Keep metrics schema stable across runs.

## Workflow

1. Check whether index exists (init or update mode).
2. Scan and count four layers: capture/cultivate/connect/create.
3. Summarize active projects, archived projects, topic count, and domain count.
4. Write updates to `kb-manifest.md`.
5. Update index refresh time in `STATUS.md`.

## Read References On Demand

- Index schema, section stability, incremental diff: `references/index-schema.md`

## Output

- Current run summary.
- Delta vs previous run (added/removed).
