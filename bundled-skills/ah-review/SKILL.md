---
name: ah-review
description: |
  每日回顾技能：围绕今日日记执行“事项复盘 + 想法分流”，并在开始前先确认复盘深度（快速/标准/深度）。AI只给分流建议，最终判断由用户做出；深度复盘时逐条处理并可衔接引导式制卡。
---

# AH Review

`ah-review` 在 FLOW 中承担日闭环中枢：把“今天的事项与想法”转成“明天可执行动作”。

## FLOW Position

- 输入：今日日记中的事项清单、想法捕获、用户选择的复盘深度。
- 输出：回顾结论、想法处理结果、交接状态与明日事项草案。

## Reusable Resources

- 回顾原则：`references/review-principles.md`
- 复盘深度：`references/review-depth-modes.md`
- 反思循环：`references/reflection-loop.md`
- 分流规则：`references/idea-routing.md`
- GTD×卢曼分流：`references/gtd-luhmann-routing.md`
- 状态与升级：`references/status-and-escalation.md`
- 质量检查：`references/quality-checklist.md`

## Skill Contract

### Inputs

- 今日日记（含今日事项、今日想法）。
- 复盘深度选择：`quick` / `standard` / `deep`。
- 用户对每条想法的最终处理决定。
- 可选：项目上下文与处理偏好。

### Reads

- 今日日记文件。
- `Meta/.ai-memory/STATUS.md`
- `references/review-principles.md`
- `references/review-depth-modes.md`
- `references/reflection-loop.md`
- `references/idea-routing.md`
- `references/gtd-luhmann-routing.md`
- `references/status-and-escalation.md`
- `references/quality-checklist.md`
- 若有项目上下文：项目 `01-执行记录/执行日志.md`、`04-沉淀候选/洞见候选.md`

### Writes

- 今日日记：`日终回顾` 与 `想法处理结果` 区域。
- 项目执行日志或洞见候选（按分流规则）。
- `STATUS.md` 的“回顾/卡片笔记/项目”分区。

### Calls

- 协议入口：`Read ../ah-memory/SKILL.md`
- 候选澄清：`Read ../ah-think/SKILL.md`（`mode=review`）
- 引导制卡：`Read ../ah-card/SKILL.md`
- 日记缺失时：`Read ../ah-note/SKILL.md`
- 积压升级（可选）：`Read ../ah-inbox/SKILL.md`

### Return

- 已选复盘深度与处理范围（条目数/剩余数）。
- 今日回顾摘要（完成情况、收获、明日事项）。
- 想法分流统计（项目/转卡/任务/跳过/延后）。
- 交接结果（如 `待交接:ah-card`）与下一步建议。

### Failure Handling

- 今日日记不存在：先调用 `ah-note` 创建最小日记后继续。
- 未选择深度：必须先询问；若用户不选，使用 `standard` 并明确告知。
- 想法过多：按深度模式分批，写 `进行中(N/M)` 允许续跑。
- 分流不清：调用 `ah-think(mode=review)` 或标记“待澄清”。
- 用户未确认去向：保留“待处理”，禁止 AI 擅自定稿。

## Workflow

1. **Boot**：读取日记与状态，定位未处理想法。
2. **Depth Select**：按 `review-depth-modes.md` 先确认复盘深度。
3. **Reflect**：按 `reflection-loop.md` 执行事项复盘。
4. **Suggest**：按 `gtd-luhmann-routing.md` 给每条想法建议去向。
5. **Decide**：由用户确认去向；`deep` 模式逐条决策。
6. **Handoff**：选中转卡条目后调用 `ah-card`（引导式，不直接代写）。
7. **State Update**：按 `status-and-escalation.md` 回写状态。
8. **Return**：输出摘要、统计、下一步（<=3 条）。

## Quality Bar

- 复盘前必须询问并确认复盘深度。
- 分流由用户最终决定，AI仅提供建议与理由。
- `deep` 模式下，每条想法必须“决策或明确延后”。
- 未经用户确认，禁止直接创建卡片。
- 回顾输出必须能直接形成明日可执行清单。
