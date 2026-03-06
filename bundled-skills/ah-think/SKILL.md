---
name: ah-think
description: Use when 需要在阅读、学习、做卡片笔记或决策时做更深层思考，包括澄清概念、检验论证、追溯根因、比较方案和提炼可迁移洞见。
---

> 执行 Obsidian 的读取、检索、写入等动作时，优先调用官方技能：`obsidian-cli`。

# 思维模型工具箱

目标：在“读、想、写、用”四个环节，用可执行的思维模型把模糊理解变成可复用洞见。

## 启动即执行

1. 识别当前任务类型：概念理解 / 观点检验 / 根因分析 / 方案决策 / 卡片提炼。
2. 从模型库选择 1-2 个模型（默认不超过 2 个，避免过载）。
3. 先征求用户意愿：继续深入，或直接记录。
4. 按模型引导提问，产出可落盘结论或可执行下一步。

## 流程锁定规则（高优先级）

- 用户出现“说不清/想不透/需要取舍/想把想法写成卡片”时，默认进入思维模型引导。
- 仅在两种情况切换技能：
  - 用户明确输入其他命令
  - 用户明确要求停止本轮思考
- 流程完成标志：已形成“结论/待验证假设/下一步动作”之一。

## 重要提醒

- 不一次堆太多模型；每轮优先 1 个主模型 + 1 个辅助模型。
- 引导优先，不直接替用户下结论。
- 用户说“先记下来/先跳过”时立即收口，不继续追问。
- 所有示例都应可映射到用户当前问题，避免空泛说教。

## 触发机制

- 主动触发：用户输入“用某模型想一想 / 帮我深入分析 / 我好像懂了但说不清”。
- 路由触发：`ah-read`、`ah-card`、`ah-review` 需要深入追问时调用。

## 主流程

1. 阶段一：判定问题类型与目标产物（解释清楚 / 写卡片 / 做决策）。
2. 阶段二：推荐 1-2 个候选模型并给出选择理由（最多不超过 2 个）。
3. 阶段三：用户选择模型（或由 AI 默认选最匹配模型）。
4. 阶段四：按模型提问并收敛到结论。
5. 阶段五：输出“可记录版本”（适合写入笔记/卡片）。

## 关键执行规则（确定性）

- 模型优先级：
  - 概念理解 -> `费曼技巧` / `布鲁姆层级` / `苏格拉底式提问`
  - 论证检验 -> `论证图谱` / `钢人化` / `证据分级`
  - 根因分析 -> `5个为什么` / `因果回路` / `冰山模型`
  - 决策取舍 -> `二阶思考` / `预检验(Pre-mortem)` / `机会成本`
  - 卡片提炼 -> `原子化` / `渐进式摘要` / `Zettelkasten连接`（按轮次最多取其中 2 个）
- 提问轮数默认 3-6 问；用户疲劳时降级到 1-2 问快速收口。
- 固定开场问句：`这次你更想要哪种结果：解释清楚、写成卡片，还是辅助决策？`
- 固定收口问句：`我先给你最小记录版本；要继续深挖，还是先记下来？`
- 输出必须包含：
  - 一句话结论
  - 关键依据或假设
  - 下一步动作（验证/记录/执行）
- 若由 `ah-read` / `ah-card` / `ah-review` 路由进入，本轮输出后必须显式返回原技能继续。

## 模型库（20+）

完整模型库、触发词与禁用场景见：`references/model-library.md`

执行页与目录页分工：

- 执行页（可直接按步骤提问）在 `references/` 的单模型文件中。
- 目录页（`model-library.md`）用于选型与禁用判断，不替代完整执行步骤。

选型后读取规则（确定性）：

1. 先读取对应执行页（如 `references/feynman-technique.md`）。
2. 若该模型暂无执行页，改用 `model-library.md` 的“核心问题 + 不适用场景”做最小引导。
3. 若用户需要深挖，再优先切换到有执行页的近邻模型。

优先常用模型（首选）：

1. 费曼技巧
2. 第一性原理
3. 逆向思维
4. 二阶思考
5. 苏格拉底式提问
6. 5个为什么
7. 论证图谱
8. 钢人化
9. 布鲁姆层级
10. 预检验（Pre-mortem）

## 输出标准

- 必须输出：
  - 本轮使用模型
  - 核心问题与简结论
  - 可直接写入笔记的 3-8 行版本
- 若用户不继续深入，输出“最小记录版本”并结束。

## 检查清单

- [ ] 已识别问题类型
- [ ] 已选择 1-2 个模型
- [ ] 已完成引导提问并收敛
- [ ] 已输出可记录版本

## 渐进加载（按需读取）

- 模型总览与触发词：`references/model-library.md`
- 费曼技巧：`references/feynman-technique.md`
- 布鲁姆层级：`references/bloom-taxonomy.md`
- SQ3R 阅读法：`references/sq3r.md`
- 主动回忆：`references/active-recall.md`
- 间隔复习：`references/spaced-repetition.md`
- 交错练习：`references/interleaving.md`
- 第一性原理：`references/first-principles.md`
- 逆向思维：`references/inversion.md`
- 二阶思考：`references/second-order-thinking.md`
- 苏格拉底式提问：`references/socratic-questioning.md`
- 论证图谱：`references/argument-mapping.md`
- 钢人化：`references/steelman.md`
- 证据分级：`references/evidence-grading.md`
- 反例思维：`references/counterexample-thinking.md`
- 能力圈：`references/circle-of-competence.md`
- 5个为什么：`references/five-whys.md`
- 因果回路：`references/causal-loop.md`
- 冰山模型：`references/iceberg-model.md`
- 杠杆点：`references/leverage-points.md`
- MECE 拆解：`references/mece.md`
- 预检验：`references/pre-mortem.md`
- 机会成本：`references/opportunity-cost.md`
- OODA 循环：`references/ooda-loop.md`
- 期望值思维：`references/expected-value.md`
- 原子化：`references/atomicity.md`
- 渐进式摘要：`references/progressive-summarization.md`
- Zettelkasten连接：`references/zettelkasten-linking.md`
- Cornell 提问栏思维：`references/cornell-question-column.md`

## 相关技能

- `ah-read`：阅读后深度理解
- `ah-card`：从想法到高质量卡片
- `ah-review`：复盘中做高质量反思
- `ah-note`：早间计划前澄清优先级
