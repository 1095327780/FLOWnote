---
name: ah
description: Flow 笔记法统一入口。用于用户不知道该调用哪个 ah-* 技能，或需要查看菜单并按意图路由到具体技能。
---

# ah

Flow 总入口，只负责识别意图与路由，不在此执行完整子流程。

## 必须遵守

- 启动先读取 `Meta/.ai-memory/STATUS.md`。
- 不编造项目、主题、领域名称。
- 仅在菜单阶段做意图识别；进入子技能后不抢跳。

## 路由目标

- `ah-note` 每日启动
- `ah-capture` 快速捕获
- `ah-inbox` 批量整理
- `ah-read` 阅读整理
- `ah-card` 永久笔记
- `ah-think` 深度思考
- `ah-project` 项目创建
- `ah-archive` 项目归档
- `ah-review` 日回顾
- `ah-week` 周回顾
- `ah-month` 月回顾
- `ah-index` 索引维护

## 按需读取 References

- `references/router-recipes.md`

## 输出

- 明确告知将调用哪个技能及原因。
