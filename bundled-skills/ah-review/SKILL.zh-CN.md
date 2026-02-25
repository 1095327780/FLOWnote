---
name: ah-review
description: 日回顾技能。用于晚间反思、清理当天收集并确定明日聚焦。
---

# ah-review

晚间回顾：反思当天、清理想法、确定明日聚焦。

## 必须遵守

- Memory 默认最小读取：`STATUS + daily(today) + active project summaries`。
- 关键分叉：`question gate: review_triage`
- 每条想法必须分流：行动 / 卡片 / 归档。
- 制卡时调用 `ah-card`，完成后返回本流程继续。

## `review_triage` 规则

对每条待处理项询问：
1. 行动
2. 卡片
3. 归档

未明确选择时默认“行动”。

## 流程

1. 读取今日日记并生成简短回顾摘要。
2. 进行反思（完成度/收获/改进/明日重点）。
3. 扫描“想法和灵感”并逐条执行 `review_triage`。
4. 回写日记状态标记与明日聚焦。
5. 更新 daily memory + `STATUS.md`。

## 按需读取 References

- 问题库、结束条件、反模式：`references/daily-review-playbook.md`

## 输出

- 今日回顾摘要。
- 分流统计。
- 明日最重要一件事。
