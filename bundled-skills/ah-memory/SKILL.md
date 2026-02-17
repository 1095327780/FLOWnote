---
name: ah-memory
description: |
  **AI 记忆系统**：跨技能的统一进度追踪与状态管理系统。
  - 基于官方最佳实践设计，采用精简的文件结构
  - 遵循"两阶段记忆处理"模式（笔记记录 → 整合）
  - 支持检查点模式，确保关键状态不丢失
---

# 🧠 AI 记忆系统

> 基于 [Claude Code 官方最佳实践](https://code.claude.com/docs/en/memory) 设计的跨技能记忆系统。

---

## 设计原则（来自官方最佳实践）

### 1. 保持精简（Keep Memory Lean）

> 记忆文件会在每次会话开始时加载，占用上下文窗口空间。

- 核心记忆文件控制在 **500 行以内**
- 详细信息使用单独文件，按需引用
- 定期清理过时信息

### 2. 具体而非泛泛（Be Specific, Not Vague）

```
✅ "阅读整理进度：《社会心理学》3/12批次完成"
❌ "有一些阅读任务待处理"
```

### 3. 两阶段记忆处理（Two-Phase Memory Processing）

```
阶段1：会话中 → 更新任务专属文件（高频）
阶段2：会话结束 → 整合到全局状态（低频）
```

### 4. 检查点模式（Checkpoint Pattern）

> 在关键节点主动保存状态，确保即使开启新会话也能恢复。

---

## 目录结构

```
Meta/
└── .ai-memory/                      # AI 记忆系统根目录
    ├── STATUS.md                    # 全局状态（精简版，< 100 行）
    │
    ├── reading/                     # 阅读整理进度
    │   └── 《书名》.md
    │
    ├── cards/                       # 卡片笔记进度
    │   └── 《来源》.md
    │
    ├── projects/                    # 项目进度
    │   └── 项目名.md
    │
    └── reviews/                     # 回顾记录
        └── history.md
```

---

## 全局状态文件（STATUS.md）

> **核心原则**：只记录"当前待处理"的事项，已完成的移除。

### 文件位置

`Meta/.ai-memory/STATUS.md`

> 路径约定（强制）：所有读写路径必须从 Vault 根目录开始（例如 `Meta/.ai-memory/cards/...`）。
> 禁止在 `/.opencode/skills/ah/` 下拼接相对路径（如 `cards/...`、`reading/...`）。

### 格式规范

```markdown
# AI 记忆 - 全局状态

> 更新时间：{{YYYY-MM-DD HH:mm}}

## 📖 阅读整理

- 《社会心理学》：文献笔记已完成，**待整理卡片笔记**（4个洞见）
- 《效率脑科学》：整理中 3/12 批次

## 🃏 卡片笔记

- 《社会心理学》：4个洞见待制卡 → `Meta/.ai-memory/cards/《社会心理学》.md`

## 📁 项目

- SnapPlan：进行中，下一步完成用户模块

## 🔄 回顾

- 周回顾：上次 2024-02-03，本周日待完成
- 月回顾：上次 2024-01-31，月底待完成
```

### 状态标记规范

| 标记 | 含义 |
|------|------|
| **待xxx** | 需要用户行动 |
| 整理中 N/M | 进行中，有明确进度 |
| ✅ 已完成 | 可以从列表移除 |

---

## Skill 接口规范

### 启动时（Phase 0）

```
[必做]
1. Read Meta/.ai-memory/STATUS.md
2. 检查是否有相关待处理任务
3. 如果有，提示用户选择：
   - A. 继续待处理任务
   - B. 开始新任务
```

### 执行中

```
[每个关键节点]
1. 更新任务专属文件（如 Meta/.ai-memory/reading/《书名》.md）
2. 使用 Write 或 Edit 工具确保真正写入
```

### 结束时（Checkpoint）

```
[必做]
1. 更新任务专属文件（最终状态）
2. 更新 STATUS.md（整合）
   - 如果任务完成：从列表移除或标记完成
   - 如果产生新待办：添加到相关区域
3. 如果有下一步建议（如 ah-read → ah-card），主动询问用户
```

---

## 跨 Skill 状态传递

### 场景：ah-read → ah-card

**ah-read 结束时更新 STATUS.md**：

```markdown
## 📖 阅读整理
- 《社会心理学》：文献笔记已完成，**待整理卡片笔记**（4个洞见）

## 🃏 卡片笔记
- 《社会心理学》：4个洞见待制卡 → `Meta/.ai-memory/cards/《社会心理学》.md`
```

**ah-card 启动时检查 STATUS.md**：

```
📋 发现待处理的卡片笔记任务：

1. 《社会心理学》- 4个洞见等待制卡

要继续处理，还是开始新任务？
```

---

## 任务专属文件格式

### 阅读进度文件（Meta/.ai-memory/reading/《书名》.md）

```markdown
# 《{{书名}}》阅读整理进度

## 基本信息
- 作者：{{作者}}
- 开始时间：{{日期}}
- 整理模式：深度/快速/直接

## 分批计划
| # | 主题 | 状态 |
|---|------|------|
| 1 | 导论 | ✅ |
| 2 | 后见之明偏差 | ✅ |
| 3 | 研究方法 | ⬜ |

## 已提炼洞见
1. 集体主义文化中的个人成长策略
2. 从抽象到具体的知识鸿沟
3. ...

## 下一步
- 状态：待整理卡片笔记
- 洞见数量：4个
```

### 卡片进度文件（Meta/.ai-memory/cards/《来源》.md）

```markdown
# 《{{来源}}》制卡进度

## 待制卡洞见
- [ ] 集体主义文化中的个人成长策略
- [ ] 从抽象到具体的知识鸿沟
- [x] 归因谬误与自我服务偏差（已完成）

## 已创建卡片
- [[在集体主义环境中保持个人成长的策略]]
- [[归因谬误与自我服务偏差]]
```

---

## 需要对接的 Skills

| Skill | 启动检查 | 结束更新 | 状态传递 |
|-------|----------|----------|----------|
| ah | ✅ 显示所有待办 | - | - |
| ah-read | ✅ 检查阅读进度 | ✅ 更新状态 | → ah-card |
| ah-card | ✅ 检查待制卡 | ✅ 更新状态 | ← ah-read |
| ah-inbox | ⬜ 可选 | ✅ 如有待制卡 | → ah-card |
| ah-project | ✅ 检查项目 | ✅ 更新状态 | → ah-archive |
| ah-review | ⬜ 可选 | ✅ 记录完成时间 | - |

---

## 参考资料

设计基于以下最佳实践：

- [Claude Code Memory Management](https://code.claude.com/docs/en/memory)
- [Session Persistence Wiki](https://github.com/ruvnet/claude-flow/wiki/session-persistence)
- [Two-Phase Memory Processing Pattern](https://cookbook.openai.com/examples/agents_sdk/context_personalization)
- [AI Agent Memory Design Patterns](https://www.ibm.com/think/topics/ai-agent-memory)

---

## 检查清单

### Skill 开发者检查清单

- [ ] 启动时读取 STATUS.md
- [ ] 有待处理任务时提示用户
- [ ] 关键节点更新任务文件
- [ ] 结束时更新 STATUS.md
- [ ] 如有状态传递需求，写入目标区域
- [ ] 主动询问是否执行下一步

### 用户使用检查清单

- [ ] 定期查看 STATUS.md 了解待办事项
- [ ] 完成任务后确认状态已更新
- [ ] 长时间不用的任务可手动清理
