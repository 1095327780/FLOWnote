# Thinking Output Schema

## 字段定义

- `problem_frame`: 问题边界、目标、约束（1-3 句）
- `selected_models`: 本轮模型及选择理由（最多 2 个）
- `key_assumptions`: 当前依赖的关键假设
- `input_space`: 结论成立所需前提/已知条件
- `mapping_rule`: 从输入到结论的推理关系
- `output_space`: 目标结果与可观察判据
- `candidate_conclusion`: 当前最优结论（可执行）
- `applicability`: 适用与不适用边界
- `risks_or_counterexamples`: 主要风险、反例或失效条件
- `next_actions`: 下一步动作（<=3，含触发条件）
- `confidence`: `high` / `medium` / `low`
- `handoff_hint`: 建议交接 skill（可空）

## 填写规则

- 结论必须带边界，不允许“无条件正确”。
- `next_actions` 必须是可执行动作，不写空泛建议。
- `confidence` 必须有依据：证据质量、样本覆盖、反例数量。
- 若信息不足，明确缺失信息并降级结论置信度。

## 最小输出模板

```yaml
problem_frame: "..."
selected_models:
  - model: "..."
    reason: "..."
key_assumptions:
  - "..."
input_space:
  - "..."
mapping_rule: "..."
output_space: "..."
candidate_conclusion: "..."
applicability:
  valid_when:
    - "..."
  invalid_when:
    - "..."
risks_or_counterexamples:
  - "..."
next_actions:
  - "..."
confidence: "medium"
handoff_hint: "ah-card"
```
