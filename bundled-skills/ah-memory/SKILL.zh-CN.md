---
name: ah-memory
description: Flow 全技能共享记忆底座。用于在 global、domain、project、daily 四层间按需最小读取与写回。
---

# ah-memory

所有 Flow 技能的共享记忆底座，不负责业务对话本身。

## 结构

```text
Meta/.ai-memory/
├── STATUS.md
├── index.json
├── domains/{domain}.md
├── projects/{project}.md
└── daily/{YYYY-MM-DD}.md
```

## 默认策略

- 读取：按需最小读取（`budget=minimal`, `mode=summary_only`）。
- 写入：仅写当前相关层 + 更新 `STATUS.md` + 更新 `index.json`。
- 避免单文件全量记忆加载。

## 调用契约

```json
{
  "scope": "global | domain | project | daily | mixed",
  "context_refs": {"domain":"string|null","project":"string|null","date":"YYYY-MM-DD|null"},
  "budget": "minimal | normal | deep",
  "mode": "summary_only | with_details"
}
```

## 适配规则

- `ah-note`：`STATUS + daily(today)`
- `ah-capture`：`STATUS + daily(today)`，必要时加 project
- `ah-read`：`STATUS + domain`，必要时加 project
- `ah-think`：`STATUS + 当前上下文层`
- `ah-review`：`STATUS + daily(today) + active project summaries`
- `ah-card`：来源上下文 + domain 摘要
- `ah-project`：`STATUS + project`
- `ah-week/ah-month`：摘要模式跨层读取

## 按需读取 References

- 接口与失败处理：`references/skill-interface-spec.md`
- 读写样例：`references/layered-memory-examples.md`
