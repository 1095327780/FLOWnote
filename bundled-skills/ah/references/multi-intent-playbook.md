# Multi-Intent Playbook

## 目标

把一句话里的多个需求拆成可执行顺序，避免用户来回切换。

## 常见链路

1. 日常闭环链：`ah-note -> ah-capture -> ah-review`
2. 阅读加工链：`ah-read -> ah-card -> ah-index(sync-card)`
3. 项目沉淀链：`ah-project -> ah-index(sync-project) -> ah-archive`
4. 复盘清仓链：`ah-review/ah-week -> ah-inbox -> ah-card`

## 编排规则

- 先处理高时效和待交接，再处理扩展任务。
- 链路最多返回 3 步，首步必须立即可执行。
- 若链路含不确定判断，插入 `ah-think` 作为澄清步。

## 返回格式

- `步骤1（现在执行）`：目标技能 + 目的
- `步骤2（完成后）`：目标技能 + 触发条件
- `步骤3（可选）`：目标技能 + 收口动作

## 反模式

- 给出多个并行建议但无顺序。
- 输出完整方案但不指定第一步。
