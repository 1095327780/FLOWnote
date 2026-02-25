# 分层记忆示例

## 示例：日常捕获

读取：
- STATUS
- daily/today

写入：
- 追加当日捕获摘要到 daily/today
- 更新 STATUS 待处理计数

## 示例：阅读会话

读取：
- STATUS
- domain/psychology

写入：
- 更新领域阅读进度
- 更新 index.json 来源映射

## 示例：项目会话

读取：
- STATUS
- projects/flownote-v2

写入：
- 更新项目里程碑
- 更新 STATUS 活跃项目摘要

## 省 token 模式

默认使用 `summary_only`，仅在用户明确要求时再深读历史细节。
