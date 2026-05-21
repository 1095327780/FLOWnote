# ah-archive Path And Move Rules

## Directory Conventions

- Active projects: `{{notePaths.activeProjects}}/`
- Archive folder: `{{notePaths.archive}}/`

## Archive Hierarchy Principles

The archive hierarchy is not a fixed template. It must follow the user's actual project and folder structure.

1. Read the existing hierarchy under `{{notePaths.archive}}/`.
2. Reuse existing hierarchy when possible.
3. If no hierarchy exists, confirm with the user before creating one.
4. Use names that stay useful for long-term retrieval.

## Move Rules

1. Check whether the source project exists.
2. Check whether the target parent folder exists; create it if needed.
3. Move the folder instead of copying and deleting.
4. Verify the target path after moving.

Example:

```bash
mv "{{notePaths.activeProjects}}/{{id}} {{projectName}}" "{{notePaths.archive}}/{{confirmedLevel}}/{{id}} {{projectName}}"
```

## Multi-Area Projects

If a project belongs to multiple areas, ask the user for the primary archive area. Store the project in one main archive location and keep links from other area pages.

## Area Page Sync

After archiving:

1. Remove the project from active projects.
2. Add it to archive history with completion time and outcome.

## Checklist

- [ ] Existing archive hierarchy read
- [ ] Archive level confirmed
- [ ] Source project folder exists
- [ ] Target parent folder exists or was created
- [ ] Move succeeded
- [ ] Project overview links updated
- [ ] Area page links synced
