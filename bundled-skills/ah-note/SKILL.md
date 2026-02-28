---
name: ah-note
description: |
  每日启动技能：创建或续写今日日记，围绕“今日事项、今日想法、日终回顾”建立当天工作入口。用于早间开工、重启节奏、以及把昨日/本周未完成事项转成今日可执行清单的场景。
---

# AH Note

`ah-note` 在 FLOW 中承担日入口：先把“今天要做什么”写清，再预留“想法捕获”和“日终回顾”区。

## FLOW Position

- 输入：日期、用户口述今日事项、可选历史上下文（昨日未完成/本周未完成）。
- 输出：可直接执行的今日日记（不做复杂项目管理）。

## Reusable Resources

- 启动原理：`references/startup-principles.md`
- 对齐规则：`references/daily-alignment.md`
- 状态协议：`references/status-and-handoff.md`
- 字段规范：`references/note-field-spec.md`
- 每日模板：`assets/每日笔记模板.md`

## Skill Contract

### Inputs

- 日期（默认今天）。
- 用户明确说明的今日事项（可多条，不限条数）。
- 可选：昨日未完成、本周未完成、在途项目信息（仅用于建议，不自动落笔）。

### Reads

- `Meta/.ai-memory/STATUS.md`
- 昨日日记（可选，用于提取未完成项建议）。
- 最新周回顾/月回顾（可选，用于提取未完成项建议）。
- `references/startup-principles.md`
- `references/daily-alignment.md`
- `references/status-and-handoff.md`
- `references/note-field-spec.md`
- `assets/每日笔记模板.md`

### Writes

- 今日日记文件（创建或更新）。
- 日记中的 `今日事项`、`今日想法`、`日终回顾`、`想法处理结果` 区域。
- `STATUS.md` 的“回顾”分区（初始化或续跑状态）。

### Calls

- 协议入口：`Read ../ah-memory/SKILL.md`
- 白天捕获入口：`Read ../ah-capture/SKILL.md`
- 晚间闭环入口：`Read ../ah-review/SKILL.md`
- 可选项目上下文：`Read ../ah-project/SKILL.md`

### Return

- 今日日记路径与创建/更新结果。
- 已写入的“用户确认版今日事项”清单。
- 可选建议池（来自昨日/本周未完成）与用户采纳结果。
- 下一步入口（白天 `ah-capture`，晚间 `ah-review`）。

### Failure Handling

- 日记已存在：更新缺失区块，不重复创建。
- 用户给出多事项：全部保留，不强制收敛为单一 MIT。
- 计划不完整：先给建议池，再由用户确认后写入。
- 未明确完成：禁止自动将事项标记为完成。
- 状态异常：按 `status-and-handoff.md` 纠正为允许枚举。

## Workflow

1. **Boot**：读取 `STATUS.md` 与当日是否已有日记。
2. **Collect**：收集用户口述事项；可选提取昨日/本周未完成作为建议池。
3. **Confirm**：向用户确认“保留/删除/补充”后再写入事项清单。
4. **Create/Update**：按 `每日笔记模板.md` 与 `note-field-spec.md` 写入。
5. **State Update**：在“回顾”分区写 `待开始` 或保留进行中状态。
6. **Return**：返回日记路径与 capture/review 衔接入口。

## Quality Bar

- 不限制事项数量，用户说几件就写几件。
- 事项清单必须来自用户确认，不能由系统擅自定稿。
- 不写“今日上下文/节奏提醒/工作日志”等冗余区块。
- 非用户明确完成，不得自动勾选完成状态。
- 模板结构保持三核：`今日事项`、`今日想法`、`日终回顾`。
