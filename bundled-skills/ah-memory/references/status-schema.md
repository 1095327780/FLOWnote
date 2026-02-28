# STATUS Schema v2

## Canonical Path

- `Meta/.ai-memory/STATUS.md`

## Required Sections

```markdown
## 阅读整理
## 卡片笔记
## 项目
## 回顾
```

## Allowed Status Values

- `待开始`
- `进行中(N/M)`
- `待交接:<skill>`
- `已完成`
- `阻塞:<原因>`

## Status Transition Rules

- `待开始 -> 进行中(N/M)`
- `进行中(N/M) -> 待交接:<skill>`
- `进行中(N/M) -> 已完成`
- 任意状态 -> `阻塞:<原因>`
- `待交接:<skill> -> 进行中(N/M)`（由目标技能接管后）
- 不允许直接从 `待开始 -> 已完成`（除显式跳过并记录理由）

## Example Entry

```markdown
## 阅读整理
- 《效率脑科学》: 进行中(3/6)

## 卡片笔记
- 《效率脑科学》: 待交接:ah-card

## 项目
- SnapPlan: 进行中(2/5)

## 回顾
- 2026-W08: 待开始
- 2026-W08 周回顾执行: 待开始
- 2026-W08 周回顾提醒注入: 已完成
- 2026-02 月回顾执行: 进行中(1/2)
- 2026-02 月回顾提醒注入: 待开始
```
