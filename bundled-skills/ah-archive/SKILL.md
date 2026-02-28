---
name: ah-archive
description: |
  项目归档技能：在项目完成后执行结项判定、复盘沉淀、归档迁移与状态回写，并把可复用经验交接给 ah-card。用于 FLOW 的 W 阶段收口（W -> F/L 回流）场景，避免“项目做完但知识丢失”。
---

# AH Archive

`ah-archive` 在 FLOW 中承担 **W -> F/L 回流**：把行动结果沉淀成可复用知识。

## FLOW Position

- 输入：W 阶段项目结果（产出、过程、决策）。
- 输出：
  - 归档后的项目记录（可追溯）。
  - 可转化的经验洞见（可交接到 L 阶段）。

## Reusable Resources

- 归档门禁：`references/archive-gates.md`
- 复盘提问与提炼：`references/retrospective-prompts.md`
- 交接协议：`references/handoff-spec.md`
- 复盘模板：`assets/项目归档复盘模板.md`

## Skill Contract

### Inputs

- 项目标识（编号/路径/名称）。
- 项目结果摘要（达成情况、关键输出、问题与经验）。
- 用户的归档意图（立即归档/先补齐再归档）。

### Reads

- 项目主页与进展记录。
- `Meta/.ai-memory/STATUS.md`
- `references/archive-gates.md`
- `references/retrospective-prompts.md`
- `references/handoff-spec.md`
- `assets/项目归档复盘模板.md`

### Writes

- 项目归档复盘内容（按模板）。
- 项目状态（完成或阻塞）。
- `STATUS.md` 的“项目/卡片笔记”分区。

### Calls

- 协议入口：`Read ../ah-memory/SKILL.md`
- 经验转卡：`Read ../ah-card/SKILL.md`
- 索引维护建议（可选）：`Read ../ah-index/SKILL.md`

### Return

- 归档结果：成功/阻塞及原因。
- 沉淀结果：经验条目与卡片候选清单。
- 下一步建议：最多 3 条（如 `ah-card`、`ah-index`、补齐动作）。

### Failure Handling

- 未通过归档门禁：不归档，写 `阻塞:<原因>`，返回最小补齐清单。
- 关键项目信息缺失：先补全模板最小字段再执行归档。
- 无可沉淀经验：允许归档，但标记低沉淀并建议后续回顾补录。

## Workflow

1. **Gate Check**：依据 `archive-gates.md` 检查是否可归档。
2. **Retrospective**：按 `retrospective-prompts.md` 生成结构化复盘。
3. **Archive Write**：使用 `项目归档复盘模板.md` 写入归档摘要。
4. **Handoff Decision**：根据候选洞见判断是否写 `待交接:ah-card`。
5. **State Update**：回写 `STATUS.md`（项目分区 + 卡片笔记分区）。
6. **Return**：输出结果、沉淀、下一步动作。

## Quality Bar

- 归档后必须可追溯：为什么开始、如何推进、为何结束、学到了什么。
- 至少沉淀 1 条可复用经验，避免“仅移动文件”的伪归档。
- 候选洞见必须具备迁移价值，禁止把纯流水账直接交给 `ah-card`。
