---
name: ah-week
description: |
  周回顾技能：回顾上周每日笔记与执行结果，形成周总结与下周1-3件重点计划；并处理积压与交接。用于周末固定复盘与下周启动准备场景。
---

# AH Week

`ah-week` 在 FLOW 中承担 **周节奏闭环**：把“本周残留”转成“下周可执行”。

## FLOW Position

- 输入：本周每日笔记、未处理想法、执行结果。
- 输出：单一周总结 + 下周计划（周计划唯一来源）。

## Reusable Resources

- 周回顾原则：`references/week-principles.md`
- 积压清理：`references/backlog-clearing.md`
- 周回顾三问：`references/weekly-retrospective.md`
- 下周规划：`references/next-week-planning.md`
- 状态交接：`references/status-handoff.md`
- 质量检查：`references/quality-checklist.md`
- 输出模板：`assets/周回顾模板.md`

## Skill Contract

### Inputs

- 上周/本周回顾周期内每日笔记集合。
- 本周未处理想法。
- 本周任务结果与下周约束。

### Reads

- 回顾周期内每日笔记与当周回顾残留。
- `Meta/.ai-memory/STATUS.md`
- `references/week-principles.md`
- `references/backlog-clearing.md`
- `references/weekly-retrospective.md`
- `references/next-week-planning.md`
- `references/status-handoff.md`
- `references/quality-checklist.md`
- `assets/周回顾模板.md`

### Writes

- 周回顾文档（最终版总结 + 下周计划）。
- 想法处理结果（项目日志/卡片候选/任务/跳过）。
- `STATUS.md` 的“回顾/卡片笔记/项目”分区。

### Calls

- 协议入口：`Read ../ah-memory/SKILL.md`
- 积压批处理（可选）：`Read ../ah-inbox/SKILL.md`
- 模糊条目澄清：`Read ../ah-think/SKILL.md`
- 洞见制卡：`Read ../ah-card/SKILL.md`
- 月度兜底：`Read ../ah-month/SKILL.md`

### Return

- 本周结论与下周 1-3 件重点（后续周计划读取入口）。
- 积压处理统计与剩余量。
- 交接项（如 `待交接:ah-card`）与下一步。

### Failure Handling

- 数据不足：先输出最小周报并标记缺口。
- 想法过多：分批处理并写 `进行中(N/M)`。
- 去向不明：调用 `ah-think` 或标记“待澄清”。
- 时间不足：先完成“积压清理 + 三问结论”，规划可简化。

## Workflow

1. **Scan**：汇总本周数据与未处理想法。
2. **Retrospective**：按 `weekly-retrospective.md` 形成周结论并确认关键补充。
3. **Clear Backlog**：按 `backlog-clearing.md` 处理积压并给出去向。
4. **Plan Next Week**：按 `next-week-planning.md` 产出下周 1-3 件重点。
5. **Handoff**：可转卡项写 `待交接:ah-card`。
6. **State Update**：完成写 `已完成`，未完写 `进行中(N/M)`。
7. **Return**：输出结果、剩余量、下次入口。

## Quality Bar

- 三问必须落到可执行改进，不写空泛感受。
- 下周计划限制 1-3 件重点，且作为后续周计划唯一来源。
- 明确保留“不过夜 -> 不过周 -> 不过月”升级路径。
