# Skill Interface Spec (v2)

本文件定义所有 `ah-*` 技能必须实现的跨会话接口。

## 1. 启动阶段（Start）

必做：

1. 读取 `Meta/.ai-memory/STATUS.md`。
2. 定位本技能相关分区条目。
3. 如果存在 `进行中(...)` 或 `待交接:<当前技能>`，先询问“继续/新建”。

## 2. 执行阶段（Progress）

必做：

1. 在关键节点写任务专属进度文件。
2. 使用可验证的状态值（见 `status-schema.md`）。
3. 避免只更新局部文件而不更新全局状态。

## 3. 结束阶段（Checkpoint）

必做：

1. 回写任务专属进度文件最终状态。
2. 回写 `STATUS.md`。
3. 若需跨技能衔接，设置 `待交接:<skill>`。

## 4. Handoff Contract

当技能 A 移交给技能 B：

- A 在 `STATUS.md` 中写入：`待交接:ah-b`
- A 返回给用户：建议调用 `/ah-b`
- B 启动时识别 `待交接:ah-b` 并给出“继续/新建”选择

## 5. Path Contract

- 仅允许 `Read ../<skill-name>/SKILL.md`
- 禁止 `skills/ah-...` 和其他环境特定路径
