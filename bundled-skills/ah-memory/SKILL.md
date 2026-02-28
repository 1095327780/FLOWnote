---
name: ah-memory
description: |
  FLOW 记忆协议中枢：统一跨技能状态读写、任务交接和恢复规则。用于任何需要跨会话续跑、跨技能协同或状态一致性的场景。
---

# AH Memory Protocol Hub

`ah-memory` 是整套 FLOW skills 的协议中枢，不直接执行业务流程。

## Goals

- 统一状态文件路径、结构和状态枚举。
- 统一各技能在启动/执行/结束三个阶段的记忆接口。
- 统一跨技能交接（handoff）格式，支持中断后恢复。

## Non-Goals

- 不定义业务技能的详细对话文案。
- 不替代各技能自己的领域流程（阅读、制卡、复盘等）。

## Canonical State File

- 唯一路径：`Meta/.ai-memory/STATUS.md`
- 唯一结构（v2）：
  - `## 阅读整理`
  - `## 卡片笔记`
  - `## 项目`
  - `## 回顾`
- 唯一状态值：
  - `待开始`
  - `进行中(N/M)`
  - `待交接:<skill>`
  - `已完成`
  - `阻塞:<原因>`

## Skill Contract

### Inputs

- 当前 skill 名称。
- 当前任务上下文（可选）。
- 用户是否选择继续上次任务。

### Reads

- `Meta/.ai-memory/STATUS.md`
- 按需读取任务专属进度文件（见 references）。

### Writes

- `Meta/.ai-memory/STATUS.md`
- 任务专属进度文件（按技能类型）。

### Calls

- 无直接子技能调用。
- 通过协议约束所有 `ah-*` 技能行为。

### Return

- 标准化状态快照。
- 下一步可执行动作（最多 3 条）。

### Failure Handling

- 如果 `STATUS.md` 缺失：创建最小 v2 骨架后继续。
- 如果状态非法：按 `references/status-schema.md` 纠正并记录一次修复。
- 如果交接目标不存在：改写为 `阻塞:<原因>` 并返回人工决策提示。

## Reference Routing

- 字段定义、状态转换：`references/status-schema.md`
- 周末/月末提醒协议：`references/cadence-reminders.md`
- 跨技能接口规范：`references/skill-interface-spec.md`
- 交接场景与示例：`references/handoff-playbooks.md`
- 启动/结束检查项：`references/checklists.md`

## Minimal Execution Flow

1. 启动阶段：读取 `STATUS.md`，提取当前 skill 相关条目。
2. 执行阶段：关键节点写入任务专属进度文件。
3. 结束阶段：回写 `STATUS.md`，必要时写入 `待交接:<skill>`。
4. 返回阶段：给出下一步建议，优先指向可直接执行的 skill。

## Integration Rules for All Skills

- 任何 `ah-*` 技能若存在跨会话语义，必须实现本文件 `Skill Contract`。
- 所有调用路径统一使用：`Read ../<skill-name>/SKILL.md`。
- 禁止使用环境耦合路径或旧版硬编码路径。
