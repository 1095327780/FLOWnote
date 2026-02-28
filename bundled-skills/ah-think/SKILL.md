---
name: ah-think
description: |
  自适应思考引擎：基于问题类型、不确定性和目标动态编排思维模型，输出可执行结论。用于 ah-read、ah-card、ah-review 的思考门，也可独立用于决策、分析与复盘。
---

# AH Think

`ah-think` 是 FLOW 的思考协议层，不是固定问答模板。

## Goals

- 把模糊问题转成可执行结论。
- 在不同场景（read/card/review）中提供可复用推理框架。
- 避免“同一套问题问到底”的僵化循环。

## Non-Goals

- 不直接创建永久笔记文件。
- 不替代 `ah-read`、`ah-card`、`ah-review` 的业务落地职责。

## Mode Contract

- `mode=read`：判断阅读洞见是否值得交接制卡。
- `mode=card`：压实候选洞见到可制卡质量。
- `mode=review`：把反思转成可执行改进动作。
- `mode=independent`：独立完成问题分析与决策建议。

## Reference Routing (Progressive Disclosure)

### Step 1: 必读核心（每次）

- 编排入口：`references/adaptive-orchestration.md`
- 模型选择：`references/model-catalog.md`
- 输出结构：`references/thinking-output-schema.md`
- 模式细节：`references/integration-profiles.md`

### Step 2: 按 mode 读取

- `mode=read`：先看 `integration-profiles.md` 的 read 段。
- `mode=card`：先看 `integration-profiles.md` 的 card 段。
- `mode=review`：先看 `integration-profiles.md` 的 review 段。

### Step 3: 按需加载模型文件

- 只加载 1-2 个主模型 + 0-1 个校验模型。
- 不全量加载全部模型文件。

### Step 4: 输出校验

- 按 `thinking-output-schema.md` 校验必填字段与 `confidence`。

## Reference Index (按需读取)

### Core orchestration

- `references/adaptive-orchestration.md`
- `references/model-catalog.md`
- `references/thinking-output-schema.md`
- `references/integration-profiles.md`

### Model files

- `references/feynman-technique.md`
- `references/first-principles.md`
- `references/inversion.md`
- `references/second-order-thinking.md`
- `references/socratic-questioning.md`
- `references/circle-of-competence.md`
- `references/five-whys.md`
- `references/pre-mortem.md`
- `references/steelman.md`
- `references/evidence-calibration.md`
- `references/abstraction-ladder.md`
- `references/systems-leverage.md`
- `references/uncertainty-calibration.md`
- `references/bayesian-updating.md`
- `references/cynefin.md`
- `references/double-loop-learning.md`
- `references/ooda-loop.md`
- `references/goodharts-law.md`
- `references/experience-model-prediction.md`
- `references/discriminative-model.md`
- `references/connection-model.md`
- `references/abstraction-hierarchy.md`
- `references/memory-encoding.md`
- `references/implicit-explicit-model.md`
- `references/information-speculation.md`
- `references/iterative-construction-analysis.md`
- `references/bottom-up-top-down-learning.md`
- `references/inheritance-pioneering-learning.md`

## Skill Contract

### Inputs

- 待分析问题、观点或候选洞见。
- 调用模式（independent/read/card/review）。
- 目标与约束（时间、风险、信息完备度）。

### Reads

- `references/adaptive-orchestration.md`
- `references/model-catalog.md`
- `references/thinking-output-schema.md`
- `references/integration-profiles.md`
- 按需读取少量模型文件（非全量）。

### Writes

- 无强制文件写入。
- 返回结构化思考包供上游技能落地。

### Calls

- 协议参照：`Read ../ah-memory/SKILL.md`（仅跨会话协作时）。
- 可被调用方：`ah-read`、`ah-card`、`ah-review`。

### Return

- 模型选择与理由。
- 结构化结论（按 `thinking-output-schema.md`）。
- `confidence`、边界条件、下一步动作、`handoff_hint`。

### Failure Handling

- 问题定义不清：先重述问题与输出目标。
- 信息不足：列最小补齐信息，不强行下结论。
- 用户负荷高：降级最小输出（结论 + 1 个动作）。
- 模型冲突：保留分歧并给验证路径。

## Minimal Execution Flow

1. 识别 mode 与问题类型（概念/决策/复盘/学习设计）。
2. 读取 4 份核心参考并确定最小模型包。
3. 短回合提问与中途总结（避免连续盘问）。
4. 输出结构化思考包并标注边界与置信度。
5. 在 read/card/review 场景返回是否交接下游技能。

## Anti-Rigid Guardrails

- 单轮默认 2-4 问后先总结，不机械追问。
- 同一问题句式不重复超过 2 次。
- 达到可执行结论即收口，不追求“问满”。
- 证据不足时先补证据，不先做复杂模型堆叠。

## Quality Bar

- 模型选择必须可解释，不能“默认固定模型”。
- 输出必须有动作、边界、风险与置信度。
- 结论要能被上游技能直接消费（read/card/review）。
