---
name: ah-card
description: 永久笔记（卡片）生成技能。用于把捕获、阅读、项目洞见整理为可回链、可复用的高质量卡片。
---

# ah-card

将输入洞见转成高质量永久笔记（卡片），并完成回链与挂载。

## 必须遵守

- Memory 默认最小读取：来源上下文 + domain 摘要。
- 模板：`assets/templates/永久笔记模板.md`
- 关键分叉：`question gate: card_target`
- 卡片必须满足回链契约：`daily_ref` / `project_ref` / `source_refs` 至少一项非空。
- 标题必须是可独立理解的断言句。

## `card_target` 规则

保存前确认主挂载位置：
1. 主题页（默认）
2. 领域页
3. 项目总览页

未明确选择时默认挂载到主题页。

## 流程

1. 明确来源：daily/read/project。
2. 筛选一条核心观点（一卡一事）。
3. 用模板生成卡片正文与元数据。
4. 建立链接：
   - 来源回链
   - 至少 2 个相关笔记链接（可空位待补，但需标注）
5. 按 `card_target` 更新主题/领域/项目索引。
6. 更新 `index.json` 映射。

## 按需读取 References

- 制卡质量门与结构细节：`references/card-workflow-details.md`
- Zettelkasten 原则补充：`references/zettelkasten-principles.md`

## 输出

- 新卡片路径。
- 已建立的关键链接。
- 如来自阅读，提示是否继续批量制卡。
