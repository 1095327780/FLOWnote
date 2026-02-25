---
name: ah-inbox
description: 积压想法批量整理技能。用于扫描近期未处理想法并分流为行动、卡片或归档。
---

# ah-inbox

批量整理近期想法，防止长期积压。

## 必须遵守

- 默认读取：`STATUS + recent daily summaries`。
- 每条必须分流：行动 / 卡片 / 归档。
- 制卡必须调用 `ah-card`。

## 流程

1. 扫描近 7 天每日笔记想法区。
2. 去重后逐条分流。
3. 回写状态标记到来源条目。
4. 更新 `STATUS.md` 与 `index.json`。

## 按需读取 References

- `references/inbox-triage-rules.md`

## 输出

- 返回处理统计与剩余数量。
