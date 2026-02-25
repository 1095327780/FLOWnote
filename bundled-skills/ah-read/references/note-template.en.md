# Literature Note Output Template

Use this structure for literature note generation.

## Frontmatter

```yaml
---
created_at: {{YYYY-MM-DD}}
type: literature_note
source: "{{Book Title}}"
author: {{Author}}
status: finished
tags: [literature-note, {{topic}}]
---
```

## Body Structure

```markdown
# 📖 {{Book Title}}

## Basic Information

| Field | Value |
|------|-----|
| Title | {{Book Title}} |
| Author | {{Author}} |
| Date | {{YYYY-MM-DD}} |

---

## Reading Motivation

{{Keep user's original reason}}

---

## Core Insights

### {{Insight 1 as assertion title}}

> Trigger quote: "{{highlight causing this insight}}"

**My interpretation**:
{{User wording, do not rewrite stance}}

---

### {{Insight 2 as assertion title}}

> Trigger quote: "{{highlight causing this insight}}"

**My interpretation**:
{{User wording, do not rewrite stance}}

---

## Worth Remembering

- {{memory point 1}}
- {{memory point 2}}

## Card Candidates

- [ ] {{Card candidate 1}}
- [ ] {{Card candidate 2}}
```
