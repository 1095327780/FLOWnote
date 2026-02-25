---
name: ah-read
description: 阅读整理技能。用于把划线或摘录整理为洞见、文献笔记与可制卡候选。
---

# ah-read

将阅读输入转成结构化输出：进度 + 文献笔记 + 卡片候选。

## 必须遵守

- 默认读取：`STATUS + domain`，必要时加 `project`。
- 模板：`assets/templates/阅读进度模板.md`、`assets/templates/文献笔记模板.md`。
- 复杂推理时使用 `think_insertion` 决策是否调用思考流程。

## 流程

1. 检查是否存在历史进度。
2. 对输入分批处理。
3. 每批提炼洞见、证据与卡片候选。
4. 生成或更新文献笔记。
5. 回写 domain/project memory 与索引。

## 按需读取 References

- `references/read-batch-details.md`
- `../ah-memory/references/skill-interface-spec.md`

## 输出

- 文献笔记路径、进度状态、卡片候选。
