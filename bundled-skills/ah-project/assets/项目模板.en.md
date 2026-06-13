---
Created: YYYY-MM-DD
Type: Project
ID: YY-NN
Status: In Progress
Start Date: YYYY-MM-DD
Due Date:
Priority: High/Medium/Low
Area:
tags:
  - project
---

# 📍 YY-NN Project Name

> 🏷️ Status: Write the current status (in progress or completed).

## 📋 Project Info

| Property | Value |
|------|-----|
| ID | Write project ID (YY-NN) |
| Start Date | Write start date (YYYY-MM-DD) |
| Planned Completion | Write due date (YYYY-MM-DD or leave blank) |
| Area | Write area name(s) |

---

## 🗂️ Project File Directory

```dataview
TABLE WITHOUT ID
  file.link as "File",
  file.ext as "Type",
  file.folder as "Folder",
  file.mtime as "Last Updated"
FROM ""
WHERE startswith(file.folder, this.file.folder)
  AND file.path != this.file.path
SORT file.path ASC
```

## ⏱️ Recent Updates

```dataview
TABLE WITHOUT ID
  file.link as "File",
  file.mtime as "Last Updated",
  file.ctime as "Created"
FROM ""
WHERE startswith(file.folder, this.file.folder)
  AND file.path != this.file.path
SORT file.mtime DESC
LIMIT 10
```

---

## 🎯 Project Goal
Write the outcome this project should achieve in one clear declarative sentence.

### Success Criteria
Write 1-3 verifiable completion criteria.

---

## 🗺️ Action Plan
Write a phased plan, starting with actions that can be done this week.

### Phase 1: Preparation
Write the preparation needed to start.

### Phase 2: Execution
Write core execution tasks and milestones.

### Phase 3: Closing
Write acceptance, review, and archive actions.

---

## 💡 Supporting Knowledge
Write links to key notes or methods this project depends on.

- [[02-培养层/主题笔记/📍 Related Topic|Related Topic]]
- [[Related Evergreen Note Title]]

---

## 📓 Work Log
Write what moved forward today, where it is stuck, and what comes next.

### YYYY-MM-DD
Write the key progress of the day and one next action.
