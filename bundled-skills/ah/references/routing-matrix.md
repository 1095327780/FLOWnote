# Routing Matrix

## 意图到技能映射

| 用户意图线索 | 首选技能 | 预期结果 | 常见后续 |
|---|---|---|---|
| 开始一天/今日日记/开工 | `ah-note` | 建立当日入口 | `ah-capture`, `ah-review` |
| 快速记想法/随手记录 | `ah-capture` | 想法写入当日日记 | `ah-review` |
| 每日复盘/处理今天想法 | `ah-review` | 日闭环与分流 | `ah-card`, `ah-inbox` |
| 读书划线整理/文献笔记 | `ah-read` | 文献提炼与候选 | `ah-card` |
| 做永久笔记/制卡 | `ah-card` | 生成高质量卡片 | `ah-index(sync-card)` |
| 想法太模糊/需要深挖 | `ah-think` | 结构化推理结论 | `ah-card`, `ah-review` |
| 想法积压/批量清仓 | `ah-inbox` | backlog 批处理 | `ah-card`, `ah-week` |
| 周回顾 | `ah-week` | 本周清理+下周计划 | `ah-card`, `ah-month` |
| 月回顾 | `ah-month` | 方向校准+月末清零 | `ah-card` |
| 启动项目 | `ah-project` | 建项目空间与沉淀路径 | `ah-index(sync-project)` |
| 项目归档/结项复盘 | `ah-archive` | 经验沉淀与交接 | `ah-card` |
| 维护主题/领域连接 | `ah-index` | 连接巡检与修复建议 | `ah-card`, `ah-project` |

## 显式命令规则

- 用户明确指定 `/ah-xxx` 时，优先直达该技能。
- 若存在关键 `待交接`，先提示风险再尊重用户选择。

## 模糊意图时的默认功能菜单（编号）

当用户只说“用 ah 处理”或任务意图不完整时，按上下文给 4-6 个菜单项，并允许用户输入数字选择。默认优先顺序：

1. `ah-note`：创建/续写今日笔记（开工入口）
2. `ah-capture`：快速捕获想法到今日日记
3. `ah-review`：执行每日回顾并分流
4. `ah-read`：阅读整理与文献提炼
5. `ah-project`：创建项目并建立沉淀目录
6. `ah-index`：同步主题页/领域页连接

规则：
- 若 `STATUS.md` 有 `待交接:<skill>`，将该 skill 提升到菜单前 2 位。
- 若存在 `进行中(N/M)` 任务，对应 skill 至少进入前 3 位。
- 菜单文案必须附带一句用途说明，避免只给技能名。
