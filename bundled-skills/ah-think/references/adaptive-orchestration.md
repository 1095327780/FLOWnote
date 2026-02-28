# Adaptive Orchestration

## 设计目标

把 `ah-think` 从“固定提问模板”改成“先诊断再编排”的动态流程，避免机械追问。

## 编排原则

- 先判环境和目标，再选模型，不先套模板。
- 每轮只用最小模型包（1 个主模型 + 0-1 个校验模型）。
- 提问遵循短回合，默认每轮 2-4 问并先总结。
- 一旦达到停止条件立即收口，不追求问满。

## 输入信号

- `goal`: 理解 / 决策 / 复盘 / 制卡 / 学习设计
- `uncertainty`: low / medium / high
- `time_pressure`: low / medium / high
- `reversibility`: high / medium / low
- `mode`: independent / read / card / review

## 路由流程

1. **环境判别**：先用 `cynefin.md` 判断 Simple/Complicated/Complex/Chaotic。
2. **任务定型**：归类为概念澄清、根因分析、决策选择、迁移提炼、学习方法设计之一。
3. **选主模型**：从 `model-catalog.md` 选择最匹配模型。
4. **加校验模型**：必要时再加一个用于边界/证据/风险校验的模型。
5. **执行短回合**：每轮提问后给中间结论，不连续深挖同一问题。
6. **触发收口**：达到输出可执行性后停止提问。

## 常见模型包（建议）

- 概念澄清：`feynman-technique` + `evidence-calibration`
- 根因分析：`five-whys` + `systems-leverage`
- 决策选择：`second-order-thinking` + `uncertainty-calibration`
- 事前风险：`pre-mortem` + `inversion`
- 观点稳健：`steelman` + `evidence-calibration`
- 学习设计：`information-speculation` + `iterative-construction-analysis`

## 反僵化机制

- 同一问题句式最多重复 2 次，超限必须换角度。
- 用户已给可执行结论时，不再追加理论问题。
- 证据不足时先补信息，不强行推进深度推理。
- 用户疲劳时降级为“结论 + 1 个下一步动作”。

## 停止条件

满足任一即收口：
- 已形成“结论 + 边界 + 下一步动作”。
- 关键缺失信息已明确且无法当场补齐。
- 当前回合边际收益明显下降。

## 输出要求

输出结构按 `thinking-output-schema.md`：
- 模型选择理由
- 当前结论与边界
- 风险/反例
- 下一步动作（<=3）
- `confidence` 与 `handoff_hint`
