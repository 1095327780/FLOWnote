# Project Handoff Spec

## Status Write Rules

在 `Meta/.ai-memory/STATUS.md`：

- 项目启动：`进行中(1/N)`
- 信息不足：`阻塞:<原因>`
- 达到结项条件：`待交接:ah-archive`

## Call Rules

- 协议入口：`Read ../ah-memory/SKILL.md`
- 立项后同步领域页：`Read ../ah-index/SKILL.md`（`sync-project`）
- 结项归档：`Read ../ah-archive/SKILL.md`

## Return Rules

返回必须包含：

1. 新项目路径与编号。
2. 领域页同步结果（命中/跳过/待同步）。
3. 成功标准与首批行动项。
4. 何时触发 `ah-archive` 的明确条件。
