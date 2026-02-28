---
name: ah-read
description: |
  阅读整理技能：将划线与摘录按批次整理为文献笔记，识别可迁移洞见并交接 ah-card，必要时把项目相关阅读沉淀到项目目录。用于 FLOW 中 F -> L 的阅读加工与续跑场景。
---

# AH Read

`ah-read` 在 FLOW 中承担 **F -> L 加工**：把“零散划线”转为“可复用知识输入”。

## FLOW Position

- 输入：阅读划线、摘录、批注、阅读动机。
- 输出：文献笔记、洞见候选、状态回写、可选项目沉淀。

## Reusable Resources

- 设计原则：`references/read-principles.md`
- 分批续跑：`references/batching-and-resume.md`
- 洞见分流：`references/insight-routing.md`
- 质量门槛：`references/quality-checklist.md`
- 文献模板：`references/note-template.md`
- 进度模板：`assets/进度模板.md`

## Skill Contract

### Inputs

- 书名/文章来源与基础元信息。
- 划线、摘录与批注（可一次性大量输入）。
- 整理深度：`快速` / `标准` / `深度`。
- 可选：项目上下文（项目路径或项目编号）。

### Reads

- `Meta/.ai-memory/STATUS.md`
- `references/read-principles.md`
- `references/batching-and-resume.md`
- `references/insight-routing.md`
- `references/quality-checklist.md`
- `references/note-template.md`
- `assets/进度模板.md`

### Writes

- 文献笔记文件（主输出）。
- 阅读进度文件（分批与续跑依据）。
- `STATUS.md` 的“阅读整理/卡片笔记”分区。
- 可选：项目目录中的阅读提要与洞见候选追加。

### Calls

- 协议入口：`Read ../ah-memory/SKILL.md`
- 思考提炼：`Read ../ah-think/SKILL.md`
- 制卡交接：`Read ../ah-card/SKILL.md`
- 可选项目上下文：`Read ../ah-project/SKILL.md`

### Return

- 本轮处理结果（完成批次、剩余批次、续跑建议）。
- 文献笔记与进度文件路径。
- 洞见分流结果：留在文献笔记 / `待交接:ah-card` / 项目沉淀。

### Failure Handling

- 输入过大：按 `batching-and-resume.md` 强制分批并写 `进行中(N/M)`。
- 信息缺失：写 `阻塞:<原因>`，返回最小补齐项（书名/来源/最小样本）。
- 洞见模糊：先调用 `ah-think(mode=read)`，不直接交接 `ah-card`。
- 中断退出：先写进度与状态，再结束会话。

## Workflow

1. **Boot**：读取 `STATUS.md`，判断新任务或续跑。
2. **Scope**：按 `read-principles.md` 确认阅读动机与整理深度。
3. **Batch**：按 `batching-and-resume.md` 聚类并处理当前批次。
4. **Synthesize**：按 `note-template.md` 更新文献笔记（不用原文堆砌）。
5. **Route**：按 `insight-routing.md` 分流洞见（文献/制卡/项目）。
6. **Gate**：按 `quality-checklist.md` 做交付前质量检查。
7. **State Update**：回写 `STATUS.md`（`进行中(N/M)` / `已完成` / `待交接:ah-card`）。

## Quality Bar

- 文献笔记必须体现“我的理解”，禁止纯摘抄堆叠。
- 每个批次至少沉淀 1 条可操作结论或明确“本批无候选”。
- 交接 `ah-card` 的候选必须具备迁移价值与边界描述。
- 若提供项目上下文，必须给出“项目内沉淀”去向，避免知识悬空。
