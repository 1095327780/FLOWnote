---
name: ah-inbox
description: |
  想法批处理技能：集中清理多天积压想法，逐条分流到项目执行笔记、卡片候选、任务或跳过，并回写状态与交接。用于周中清仓、周回顾前整理和积压治理场景。
---

# AH Inbox

`ah-inbox` 在 FLOW 中承担 **想法积压治理器**：处理“当天没消化完”的想法 backlog。

## FLOW Position

- 输入：跨天未处理想法（来自每日笔记/回顾残留）。
- 输出：清晰去向（项目/卡片/任务/跳过）+ 续跑状态。

## Reusable Resources

- 清仓原则：`references/inbox-principles.md`
- 选单规则：`references/backlog-selection.md`
- 分流协议：`references/batch-routing.md`
- 状态续跑：`references/status-and-resume.md`
- 质量检查：`references/quality-checklist.md`
- 批处理模板：`assets/批处理记录模板.md`

## Skill Contract

### Inputs

- 待处理想法列表（多天/多篇日记）。
- 用户处理偏好（快清仓/稳妥筛选）。
- 可选：项目上下文与优先级。

### Reads

- 近期每日笔记与回顾残留。
- `Meta/.ai-memory/STATUS.md`
- `references/inbox-principles.md`
- `references/backlog-selection.md`
- `references/batch-routing.md`
- `references/status-and-resume.md`
- `references/quality-checklist.md`
- `assets/批处理记录模板.md`

### Writes

- 想法处理标记（在原日记或汇总记录中）。
- 项目执行日志/洞见候选（按分流规则）。
- 批处理记录文件（可选但建议）。
- `STATUS.md` 的“回顾/卡片笔记/项目”分区。

### Calls

- 协议入口：`Read ../ah-memory/SKILL.md`
- 模糊条目澄清：`Read ../ah-think/SKILL.md`
- 正式制卡：`Read ../ah-card/SKILL.md`
- 回顾兜底：`Read ../ah-week/SKILL.md` 或 `Read ../ah-month/SKILL.md`

### Return

- 本轮处理统计（项目/转卡/任务/跳过/待澄清）。
- 剩余 backlog 与续跑入口。
- 若存在可转项，返回 `待交接:ah-card`。

### Failure Handling

- 条目过多：按批处理并写 `进行中(N/M)`。
- 决策不明：标记“待澄清”，禁止强行转卡。
- 源条目缺上下文：保留原句并回链来源，不做过度推断。
- 会话中断：先写批处理记录与状态，再结束。

## Workflow

1. **Scan**：按 `backlog-selection.md` 汇总近期待处理条目。
2. **Batch**：按 `status-and-resume.md` 拆分批次并标记 `进行中(N/M)`。
3. **Route**：按 `batch-routing.md` 逐条分流到项目/卡片/任务/跳过。
4. **Escalate**：模糊条目调用 `ah-think`，仍不清晰则留“待澄清”。
5. **Record**：按 `批处理记录模板.md` 写本轮决策与剩余项。
6. **Handoff**：可转卡项写 `待交接:ah-card` 并返回候选清单。
7. **State Update**：完成则写 `已完成`，未完成保留 `进行中(N/M)`。

## Quality Bar

- 每条 backlog 想法必须有去向，不允许“看过但不标记”。
- 项目细节优先落项目日志，迁移洞见才转卡。
- 清仓优先级应体现“不过夜 -> 不过周 -> 不过月”。
- 返回必须包含剩余量与下次续跑入口。
