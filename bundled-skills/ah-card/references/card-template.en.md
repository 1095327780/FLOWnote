# Evergreen Card Output Template

Use this structure when generating evergreen cards.

## Full Template

```markdown
---
created_at: {{YYYY-MM-DD}}
type: evergreen_card
source: {{book/article/source}}
status: completed
tags: [{{tag1}}, {{tag2}}]
---

# {{Assertion Title}}

## Core Claim

{{One-sentence claim in user wording}}

---

## Explanation

{{Expanded explanation in user's own words}}

### Why It Matters

{{Value and importance}}

### How To Apply

{{Use cases and examples}}

---

## Related Notes

- [[{{Related Note 1}}]] - {{support/contrast/extend}}
- [[{{Related Note 2}}]] - {{relation}}
- [[{{Related Note 3}}]] - {{relation}}

---

## Related Projects

- [[{{Project Name}}]] - {{how this supports the project}}

---

## Sources

- [[{{Original Source Note}}]] - {{chapter/page/section}}

---

## Metadata

- **Topic**: [[02-培养层/📍 {{Topic}}]]
- **Domain**: [[03-连接层/🌱 {{Domain}}]]
```
