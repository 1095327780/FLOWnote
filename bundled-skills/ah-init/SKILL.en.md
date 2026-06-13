---
name: ah-init
description: Use to initialize or repair the FLOWnote vault structure, templates, home document, topic/domain pages, and memory files.
---

# Vault Initialization

Goal: create or repair the minimum folder and template structure required by FLOWnote, then keep the home document and index usable.

## English Default Structure

- `{{notePaths.dailyNotes}}`
- `{{notePaths.weeklyReviews}}`
- `{{notePaths.monthlyReviews}}`
- `{{notePaths.yearlyReviews}}`
- `{{notePaths.permanentNotes}}`
- `{{notePaths.literatureNotes}}`
- `{{notePaths.topicNotes}}`
- `{{notePaths.domainPages}}`
- `{{notePaths.activeProjects}}`
- `{{notePaths.archive}}`
- `Meta/.ai-memory`
- `Meta/Templates`

## Rules

- Read the current vault before creating folders.
- Do not overwrite customized user templates without confirmation.
- If the UI language is Chinese, use the Chinese folder structure instead.
- If configured note paths differ from the defaults above, use the configured paths.
- Every init run must end with a home document check: create it if missing, refresh the automated block if present, or ask for confirmation before converting a legacy home document.

## Home Refresh Mode

Use this mode when the user asks to update the home document, fix Home, refresh the dashboard, or repair the vault homepage.

1. Find the existing home document in this order:
   - `🏠Home.md`
   - `🏠 Home.md`
   - `Home.md`
2. If no home document exists, create `🏠Home.md` from `references/HOME Template.md`.
3. The first-created home document includes a plugin note at the top:
   - Dataview is required for automatic status panels.
   - Banners is optional for page banners.
4. If the user later deletes that plugin note, do not recreate it during refresh.
5. If the home document contains:
   - `<!-- FLOWNOTE_HOME_AUTOMATED_START -->`
   - `<!-- FLOWNOTE_HOME_AUTOMATED_END -->`
   replace only the content between those markers.
6. Preserve all user-authored content outside the automated block.
7. If an existing home document does not contain the automated markers, explain that converting it will replace the page and ask for confirmation before writing.
8. Prefer Dataview / DataviewJS panels that read the current vault state automatically instead of hardcoding projects, topics, or counts.
9. Exclude hidden/system paths from home stats and recent activity:
   - `.obsidian/`
   - `.flownote/`
   - `.opencode/`
   - `.agents/`
   - `Meta/.ai-memory/`
   - `Meta/ai-memory/`
   - `{{notePaths.archive}}/`
   - `Clippings/`
10. Active projects should count only project overview files under the active projects folder. Do not count the root project index as a project.

## User Scenarios

### 1. New install with an existing non-FLOWnote vault

- Detect missing or incomplete FLOWnote folders while the vault already contains other notes.
- Do not move or delete the user's existing folders unless the user explicitly confirms migration.
- Create the minimum FLOWnote folder structure.
- Automatically create `🏠Home.md` from `references/HOME Template.md`.
- Keep the plugin note at the top because this is the first home document creation.
- Use Dataview panels instead of hardcoded projects or counts, so the home document remains usable while migration is incomplete.

### 2. Existing user upgrading with an existing home document

- If the home document has the `FLOWNOTE_HOME_AUTOMATED_START/END` markers, refresh only the automated block.
- Preserve all user-authored content outside that block.
- Do not recreate the plugin note if the user deleted it.
- If the home document has no automated markers, explain the conversion and ask for confirmation before replacing it.

### 3. Existing user upgrading without a home document

- Automatically create `🏠Home.md` from `references/HOME Template.md`.
- Keep the plugin note at the top because this is the first home document creation.
- Continue the normal index refresh and report the created path.

## Output

- Report the home document path.
- State whether the file was created, converted, or only had the automated block refreshed.
- State whether user-authored content was preserved.
