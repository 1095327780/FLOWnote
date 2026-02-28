---
name: ah-month
description: |
  月回顾技能：按“优先周回顾汇总（缺失则回退日回顾）→主题提炼→方向调整”完成月度复盘，并执行积压想法最终清零；输出下月1-3件重点与交接状态。用于月底战略校准场景。
---

# AH Month

`ah-month` 在 FLOW 中承担 **月度方向校准器**：把周节奏结果汇总为月度方向决策。

## FLOW Position

- 输入：当月周回顾、项目进展、知识产出、残留想法。
- 输出：单一月度总结、方向调整、下月重点（唯一来源）、清零结果。

## Reusable Resources

- 月回顾原则：`references/month-principles.md`
- 数据回顾：`references/monthly-data-review.md`
- 主题提炼：`references/theme-extraction.md`
- 方向调整：`references/direction-adjustment.md`
- 兜底清零：`references/backlog-final-clearing.md`
- 状态交接：`references/status-handoff.md`
- 质量检查：`references/quality-checklist.md`
- 输出模板：`assets/月回顾模板.md`

## Skill Contract

### Inputs

- 当月周回顾集合（优先）。
- 当月关键事件与项目状态。
- 当月残留想法与下月约束。

### Reads

- 当月周回顾与相关每日回顾（周回顾缺失时回退每日回顾）。
- `Meta/.ai-memory/STATUS.md`
- `references/month-principles.md`
- `references/monthly-data-review.md`
- `references/theme-extraction.md`
- `references/direction-adjustment.md`
- `references/backlog-final-clearing.md`
- `references/status-handoff.md`
- `references/quality-checklist.md`
- `assets/月回顾模板.md`

### Writes

- 月回顾文档（最终版总结 + 下月计划）。
- 想法清零处理结果（项目/卡片/任务/跳过/待澄清）。
- `STATUS.md` 的“回顾/卡片笔记/项目”分区。

### Calls

- 协议入口：`Read ../ah-memory/SKILL.md`
- 残留批处理（可选）：`Read ../ah-inbox/SKILL.md`
- 模糊结论澄清：`Read ../ah-think/SKILL.md`
- 洞见制卡：`Read ../ah-card/SKILL.md`
- 周度补齐（可选）：`Read ../ah-week/SKILL.md`

### Return

- 月度结论（主题、偏差、方向调整）。
- 下月 1-3 件重点与完成标准（后续月计划读取入口）。
- 清零统计、剩余残留与交接项。

### Failure Handling

- 数据碎片化：先生成最小月报并标记缺口。
- 残留过多：分批处理并写 `进行中(N/M)`。
- 方向不清：调用 `ah-think` 先明确判断再规划。
- 时间不足：优先完成“数据+主题+清零”，规划简化到 1 件重点。

## Workflow

1. **Source Resolve**：按 `monthly-data-review.md` 优先汇总周回顾，缺失时回退日回顾。
2. **Monthly Review**：形成月度结论并确认关键补充修正。
3. **Theme Extraction**：按 `theme-extraction.md` 提炼当月主主题与增长方向。
4. **Direction Check**：按 `direction-adjustment.md` 检查与年度目标是否偏离。
5. **Final Clearing**：按 `backlog-final-clearing.md` 清理月末残留想法。
6. **Plan Next Month**：确定下月 1-3 件重点与预备动作。
7. **Handoff**：可转卡项写 `待交接:ah-card`。
8. **State Update**：完成写 `已完成`，未完写 `进行中(N/M)`。

## Quality Bar

- 月末残留需做清零决策，不能把问题推给下月。
- 下月重点限制 1-3 件，并且要可验证且作为后续月计划唯一来源。
- 明确保留“不过夜 -> 不过周 -> 不过月”的闭环收口。
