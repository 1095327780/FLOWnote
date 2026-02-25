# ah-memory 接口规范（Flow v2）

> 本文件定义所有 skills 调用记忆系统的统一接口与最小行为。

## 1. 必备文件

- `Meta/.ai-memory/STATUS.md`
- `Meta/.ai-memory/index.json`
- `Meta/.ai-memory/domains/{domain-slug}.md`
- `Meta/.ai-memory/projects/{project-slug}.md`
- `Meta/.ai-memory/daily/{YYYY-MM-DD}.md`

若不存在，先创建再写入。

## 2. 读取接口

读取请求参数：

```json
{
  "scope": "global | domain | project | daily | mixed",
  "context_refs": {
    "domain": "string|null",
    "project": "string|null",
    "date": "YYYY-MM-DD|null"
  },
  "budget": "minimal | normal | deep",
  "mode": "summary_only | with_details"
}
```

默认：
- `budget = minimal`
- `mode = summary_only`

### 推荐读层

- `global` -> `STATUS.md`
- `domain` -> `domains/{domain}.md`
- `project` -> `projects/{project}.md`
- `daily` -> `daily/{date}.md`
- `mixed` -> 全局 + 目标层摘要

## 3. 写入接口

每次技能结束至少做三件事：

1. 写回目标层文件（domain/project/daily）
2. 更新 `STATUS.md` 的待处理摘要
3. 更新 `index.json` 的来源映射与时间戳

## 4. index.json 建议结构

```json
{
  "updated_at": "2026-02-23T10:00:00.000Z",
  "records": [
    {
      "id": "card-2026-02-23-001",
      "type": "card",
      "sources": ["daily:2026-02-23", "project:flownote-v2"],
      "updated_at": "2026-02-23T10:00:00.000Z",
      "tags": ["flow/card"]
    }
  ]
}
```

## 5. 失败与降级

- 目标层文件缺失：创建空模板后继续
- 上下文标识不明确：仅读取 `STATUS.md`，并在必要时询问用户选择
- 解析异常：回退到文本读取，不阻断主流程

## 6. 问题提问策略

仅在关键冲突发问：
- 同时命中多个项目
- 同时命中多个领域
- 写回目标层不唯一

其余场景默认最小读取并继续。
