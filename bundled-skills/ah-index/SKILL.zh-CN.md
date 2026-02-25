---
name: ah-index
description: 知识库索引维护技能。用于初始化或刷新库结构清单、统计信息和关键入口。
---

# ah-index

维护知识库索引文件，帮助 AI 快速理解当前库状态。

## 必须遵守

- 扫描范围遵守 Flow 四层目录约定。
- 输出索引位置：`Meta/索引/kb-manifest.md`。
- 统计口径稳定，避免每次字段漂移。

## 流程

1. 检查索引是否存在（初始化/更新模式）。
2. 扫描目录并统计：capture/cultivate/connect/create 四层。
3. 汇总活跃项目、归档项目、主题/领域数量。
4. 写回 `kb-manifest.md`。
5. 更新 `STATUS.md` 中索引更新时间。

## 按需读取 References

- 索引字段、区块稳定性、增量比较：`references/index-schema.md`

## 输出

- 本次统计摘要。
- 与上次相比的变化（新增/减少）。
