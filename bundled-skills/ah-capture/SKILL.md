---
name: ah-capture
description: |
  快速捕获技能：将临时想法追加到今日日记“今日想法”区；若用户反馈的是事项进展或完成，则优先更新“今日事项”区。用于工作中的即时记录与进展同步，不做深度整理。捕获只允许写入每日笔记。
---

# AH Capture

`ah-capture` 在 FLOW 中承担日内即时入口：先留痕，再在回顾阶段统一处理。

## FLOW Position

- 输入：即时想法、事项进展、可选标签与上下文。
- 输出：今日日记中的可处理条目（供 `ah-review` 晚间分流）。

## Reusable Resources

- 捕获原理：`references/capture-principles.md`
- 追加协议：`references/append-protocol.md`
- 写入恢复：`references/write-path-recovery.md`
- 质量检查：`references/quality-checklist.md`

## Skill Contract

### Inputs

- 一条或多条原始想法。
- 或：事项进展/完成反馈（如“X 做完了”“Y 卡住了”）。
- 可选标记：`#标签`、`@项目`、`!重要`、`?问题`。

### Reads

- 今日日记文件。
- `Meta/.ai-memory/STATUS.md`（可选）。
- `references/capture-principles.md`
- `references/append-protocol.md`
- `references/write-path-recovery.md`
- `references/quality-checklist.md`

### Writes

- 今日日记 `## 今日想法（ah-capture 追加）` 区域。
- 可选：今日日记 `## 今日事项（用户确认后写入）` 区域（仅进展/完成更新）。

### Calls

- 协议入口：`Read ../ah-memory/SKILL.md`
- 若今日日记不存在：`Read ../ah-note/SKILL.md`
- 后续处理入口：`Read ../ah-review/SKILL.md`

### Return

- 本次写入条目数与写入位置。
- 若触发事项更新：返回更新了哪些事项。
- 晚间建议入口（`ah-review`）。

### Failure Handling

- 输入过长：按语义最小单元拆分多条。
- 今日日记缺失：先触发 `ah-note` 创建后再写入。
- 目标区块缺失：按 `append-protocol.md` 自动补齐后写入。
- 事项更新无法匹配：不擅自勾选，改写入“今日想法”并提示待确认。

## Workflow

1. **Locate**：定位今日日记；若缺失则走 `ah-note` 创建。
2. **Classify**：判断输入属于“想法捕获”还是“事项进展更新”。
3. **Write**：按 `append-protocol.md` 写入对应区块。
4. **Validate**：按 `quality-checklist.md` 检查保真、时间戳、事项状态准确性。
5. **Recover**：写入异常时按 `write-path-recovery.md` 修复后重试。
6. **Return**：返回写入结果与 `ah-review` 建议。

## Quality Bar

- 想法捕获必须保留原话语义。
- 事项仅在用户明确说明完成时才标记 `[x]`。
- 事项进展更新优先回写到“今日事项”，避免信息散落。
- 捕获只允许落在每日笔记，禁止创建独立收集容器。
