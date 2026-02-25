# Flow Contract v2 - Frontmatter Contract

All core templates should include these fields.

## Required Keys

- `type`
- `status`
- `created`
- `updated`
- `flow_stage`
- `source_refs`
- `project_ref`
- `daily_ref`
- `tags`

## Allowed `flow_stage`

- `feed`
- `lift`
- `organize`
- `work`

## Defaults

- `source_refs`: `[]`
- `project_ref`: `null`
- `daily_ref`: `null`
- `tags`: `[]`

## Compatibility

- Keep existing Chinese body sections where useful.
- Frontmatter uses stable machine-readable keys for cross-skill handoff.
