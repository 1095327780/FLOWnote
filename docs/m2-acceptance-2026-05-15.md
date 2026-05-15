# M2 Acceptance — End-to-End Skill Verification

**Date:** 2026-05-15
**Branch:** feature/0.5.0-m1-skeleton
**Build:** main.js sha bc674ce274…
**Provider:** DeepSeek V4 Flash (1M context, 384K max output)

This document records manual end-to-end runs of the four "demo" skills the
design doc (§16, M2) calls out for acceptance. The user runs each
scenario in the live Obsidian vault, observes the tool-call trace in the
plugin log, and reports back.

For each skill: expected tool sequence + acceptance criteria + actual
result. "Acceptance criteria" is the minimum bar; anything beyond is gravy.

## Prep

- [x] Reload the FLOWnote plugin after the deploy.
- [ ] Confirm `.flownote/skills/` was created (was `.opencode/skills/`).
- [ ] Confirm console log shows `migrated .opencode/skills → .flownote/skills (NN files copied)` exactly once.
- [ ] Settings → 内置 Skills 安装目录 shows `.flownote/skills`.
- [ ] Open the FLOWnote chat view; start a fresh conversation.

---

## 1. `/ah-note` — daily note creation

**Trigger:** Type `/ah-note` (or natural language: "帮我创建今天的日记").

**Expected tool sequence:**
1. `vault_daily mode="read"` — checks if today's note exists
2. (if missing) `vault_daily mode="create"` — auto-seeds from the daily-notes plugin template
3. `vault_tasks status="open" path="01-捕获层/每日笔记/<yesterday>.md"` — pull yesterday's incomplete tasks
4. `vault_read 01-捕获层/每日笔记/<yesterday>.md` — read yesterday's "## 明日计划" section
5. Model writes today's body (今日聚焦 + 任务清单) — likely `vault_edit` or `vault_write mode="overwrite"`

**Acceptance criteria:**
- [ ] Today's daily note file actually exists after the run.
- [ ] If a template was configured, the note is seeded from it (not a blank file).
- [ ] Yesterday's unfinished tasks appear in today's note.
- [ ] Model replies in Chinese (matches user's language).

**Actual result:** (fill in after running)

---

## 2. `/ah-card` — permanent note crafting

**Trigger:** Drag a snippet of text into the chat (e.g. a quoted paragraph
from a literature note), then `/ah-card`.

**Expected tool sequence:**
1. `vault_read Meta/索引/kb-manifest.md` — load the index (per the new
   Vault navigation guidance). If missing → model prompts user to run
   `/ah-index`, falls back.
2. `vault_list path="02-培养层/永久笔记"` OR `vault_search` for related
   concepts.
3. (optional) `vault_read` on 1-2 related topic pages (📍 prefix).
4. `vault_backlinks` on a candidate related note to confirm relevance.
5. `vault_write` the new permanent note with statement-style title (e.g.
   "X 的关键是 Y").
6. (optional) `vault_edit` the topic page to add a `[[wikilink]]` to the
   new note.

**Acceptance criteria:**
- [ ] Model reads kb-manifest.md FIRST, before any other vault tool call.
- [ ] If kb-manifest exists, model navigates via topic page → permanent
      notes (does NOT scan all 24 permanent notes).
- [ ] New permanent note ends up under `02-培养层/永久笔记/` with
      declarative-statement title.
- [ ] At least 2 wikilinks in the new note (Zettelkasten convention).

**Actual result:** (fill in after running)

---

## 3. `/ah-review` — weekly review

**Trigger:** `/ah-review` (or "帮我做这周的回顾").

**Expected tool sequence:**
1. `vault_daily mode="read"` — current week's anchor (or today, fallback).
2. `vault_list path="01-捕获层/每日笔记" pattern="*.md"` — enumerate this
   week's daily notes (model filters by date range itself).
3. Batched `vault_read` on those daily notes.
4. `vault_property` to set status / week-number on `Meta/.ai-memory/STATUS.md`
   OR `vault_edit` to append to the week's STATUS section.
5. `vault_write mode="overwrite"` or `vault_edit` on the week-note file
   (`01-捕获层/周记/2026-W20.md` or similar).

**Acceptance criteria:**
- [ ] Week note exists at the expected path.
- [ ] STATUS.md (if used) was updated, not clobbered.
- [ ] Summary captures actual entries from the daily notes (not generic
      filler).

**Actual result:** (fill in after running)

---

## 4. `/ah-index` — knowledge-base index rebuild

**Trigger:** `/ah-index` (or "帮我更新一下知识库索引").

**Expected tool sequence:**
1. `vault_read Meta/索引/kb-manifest.md` — check current state (may not
   exist on first run).
2. `vault_list path="03-连接层"` — enumerate domain pages
3. `vault_list path="02-培养层/主题笔记"` — enumerate topic pages
4. `vault_list path="02-培养层/永久笔记"` — count permanent notes
5. `vault_list path="02-培养层/文献笔记"` — count literature notes
6. `vault_list path="04-创造层/项目"` — enumerate projects
7. (optional, slow) `vault_backlinks` on each permanent note to find
   orphans (no topic-page backlink).
8. `vault_write` or `vault_edit` on `Meta/索引/kb-manifest.md` with the
   rebuilt index.

**Acceptance criteria:**
- [ ] `Meta/索引/kb-manifest.md` exists after the run.
- [ ] The manifest lists ALL 4 domain pages (🌱) and ALL 3 topic pages (📍).
- [ ] Counts in the manifest match reality (24 permanent notes, 8 literature
      notes, etc. as of 2026-05-15).
- [ ] If orphan permanent notes are found, the manifest mentions them.

**Actual result:** (fill in after running)

---

## Observed failures & fixes

(Fill in if anything broke during the run — capture the tool sequence,
the error message, and the minimum fix. Each one becomes a follow-up
task.)

---

## Sign-off

When all four acceptance criteria sections are ticked off and "Observed
failures" section is empty (or all failures resolved), M2 is closed.
Next stop: M3 — productionization (mobile smoke + remaining providers +
opencode-legacy adapter).
