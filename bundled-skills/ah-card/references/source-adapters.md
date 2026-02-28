# Source Adapters for AH Card

统一把不同来源的内容转换为“卡片候选输入”。

## Source Types

1. 阅读整理（`ah-read`）
- 来源：文献笔记/阅读洞见列表
- 重点：去原文依赖，保留可迁移结论

2. 每日/周月回顾（`ah-review` / `ah-inbox` / `ah-week` / `ah-month`）
- 来源：回顾中的洞见条目
- 重点：先区分执行事实 vs 可复用原则

3. 项目沉淀候选（`ah-project`）
- 来源：`04-沉淀候选/洞见候选.md`
- 重点：保留项目来源追踪，转换后回写候选状态

4. 项目归档复盘（`ah-archive`）
- 来源：归档复盘中的经验条目
- 重点：优先提炼“可迁移方法”与“反模式”

## Normalized Input Shape

每条候选在进入制卡流程前应具备：

- `statement`: 一句话洞见
- `source_type`: read/review/project/archive
- `source_ref`: 来源文件或上下文路径
- `scope`: project-local / cross-project
- `link_hints`: 推荐连接线索（可空）
- `topic_hints`: 主题页候选（📍，可空）
- `domain_hints`: 领域页候选（🌱，可空）

## Source Trace Requirement

所有成卡必须写来源追踪：

- 至少 1 个明确来源（文献/项目/回顾）
- 若来源是项目，必须包含项目编号或项目总览链接
