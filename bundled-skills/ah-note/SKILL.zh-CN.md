---
name: ah-note
description: 每日笔记创建与更新。用于早间启动、今日规划、创建或补全今日日记。
---

# ah-note

创建或更新当日 `01-捕获层/每日笔记/YYYY-MM-DD.md`。

## 必须遵守

- 默认读取最小记忆：`STATUS + daily(today)`。
- 使用模板：`assets/templates/每日笔记模板.md`。
- 不覆盖用户已有自由文本（除非用户明确要求）。

## 流程

1. 检查今日日记是否存在。
2. 不存在则按模板创建，存在则补全关键段落。
3. 收集今日聚焦（1项）与任务（3-5项）。
4. 回写 `Meta/.ai-memory/daily/YYYY-MM-DD.md`。

## 按需读取 References

- `references/daily-note-details.md`

## 输出

- 返回文件路径、今日聚焦、后续建议。
