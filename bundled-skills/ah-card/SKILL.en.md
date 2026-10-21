---
name: ah-card
description: Use to turn a source note, highlight, or captured idea into an atomic permanent note with links and a strong assertion title.
metadata:
  flownote:
    completion:
      mode: effect
---

# Permanent Note Creation

Goal: create one atomic, reusable knowledge card.

## Quality Standard

- Assertion title: a complete sentence with a clear claim.
- Atomic: one idea per note.
- Decontextualized: understandable without the original source.
- Connected: preserve all important, evidence-supported relationships; do not force a minimum or cap them at 2-3 links.

## Workflow

1. Prefer `card_prepare`, when available, for configured paths, STATUS, the exact user-supplied source path, and a first page of topic/domain titles. Read the source text or ask the user for it. Reuse unchanged, fully visible attached evidence; continue truncated or stale evidence with `vault_read`.
2. Extract the core claim.
3. Draft an assertion title.
4. Search related notes before writing. A first catalog/search page is not a relation limit or proof of semantic completeness. Expand keywords, synonyms and cross-topic leads; continue cursors and verify enough original text, including conditions and counterexamples.
5. Confirm the title, body and relationship plan with the user. Prefer `card_commit`, when available, to create the permanent note and apply precise topic/source/backlink updates together. It does not author thoughts or decide relationships. See `references/workflow-and-sync-rules.md` for the tool protocol. Otherwise retain the existing vault tools.
6. Report every verified path and any unfinished targets. A failed batch is partial, not atomic: stop and recover from the failed step. Domain/index updates are needed only when the task calls for them.

## Rules

- Do not use vague noun-phrase titles.
- Do not copy long source passages.
- Use the user's actual vault content for links.
- If configured note paths differ from examples, use the configured paths.
- Preserve the user's own wording and ideas; ask for missing reasoning or boundaries rather than inventing them.
- Snippets locate evidence; read more whenever they cannot support a content or relationship judgment.
- If required web/property/task abilities are deferred, call `card_expand_tools` before using them. Existing permission and skill restrictions still apply.
