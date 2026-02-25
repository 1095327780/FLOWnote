---
name: ah-capture
description: 快速捕获技能。用于把用户想法、链接、语音转写内容低摩擦写入指定位置。
---

# ah-capture

快速记录用户原话，默认落到今日日记想法区。

## 必须遵守

- 默认最小记忆：`STATUS + daily(today)`。
- 关键分叉使用 `capture_destination`。
- 只做轻量清理，不改写观点。

## `capture_destination`

1. 今日日记（默认）
2. 项目执行日志
3. 独立收集箱

## 流程

1. 识别输入中的标签、链接、项目上下文。
2. 必要时询问落位。
3. 以单行格式写入并加时间戳。
4. 更新当日记忆。

## 按需读取 References

- `references/capture-routing-rules.md`

## 输出

- 返回写入位置和条目预览。
