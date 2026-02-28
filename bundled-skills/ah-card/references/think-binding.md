# Think Binding for AH Card

`ah-card` 与 `ah-think` 采用“独立技能 + 强绑定接口”。

## When Think Gate Is Mandatory

候选满足任意 1 项，必须先调用 `ah-think`：

- 表述模糊，无法形成断言式标题。
- 迁移价值不确定（只像项目内技巧）。
- 连接线索不足（<2 个可用连接）。
- 涉及高影响决策原则（需要边界检验）。

## Mode and Model Selection

- `mode=card`（默认）
- 建议模型优先级：
  - 澄清概念：费曼技巧
  - 检验假设：苏格拉底提问/第一性原理
  - 检查长期后果：二阶思考

## Required Think Output Packet

- `clarified_statement`: 澄清后的一句话洞见
- `applicability`: 适用/不适用边界
- `link_hooks`: 至少 2 条连接线索
- `confidence`: high / medium / low

## Decision Rule

- `high` -> 可转卡
- `medium` -> 需用户确认后转卡
- `low` -> 保留项目笔记或延后
