---
name: ah
description: |
  FLOW 统一入口技能：基于用户意图与全局状态进行路由决策，返回最合适的 ah 子技能或执行顺序。用于用户不确定该调用哪个技能、或希望从一个入口协调多步骤任务的场景。
---

# AH Gateway

`/ah` 只做路由编排，不在网关内展开业务执行。

## FLOW Position

- 输入：用户请求 + 全局状态。
- 输出：单技能路由或多技能有序链路。

## Reusable Resources

- 网关原则：`references/gateway-principles.md`
- 意图映射：`references/routing-matrix.md`
- 优先级仲裁：`references/priority-resolution.md`
- 多意图编排：`references/multi-intent-playbook.md`
- 质量检查：`references/quality-checklist.md`
- 输出模板：`assets/路由结果模板.md`

## Skill Contract

### Inputs

- 用户原始表达。
- 可选：显式命令（如 `/ah-read`）。
- 可选：用户给出的执行顺序偏好。

### Reads

- `Meta/.ai-memory/STATUS.md`
- `references/gateway-principles.md`
- `references/routing-matrix.md`
- `references/priority-resolution.md`
- `references/multi-intent-playbook.md`
- `references/quality-checklist.md`
- `assets/路由结果模板.md`

### Writes

- 默认不写业务文件。
- 可选：在 `STATUS.md` 的“回顾”分区记录一次网关路由标记。

### Calls

- 协议入口：`Read ../ah-memory/SKILL.md`
- 路由目标：`Read ../<target-skill>/SKILL.md`
  - `ah-note/ah-capture/ah-read/ah-card/ah-think/ah-index/ah-project/ah-archive/ah-review/ah-week/ah-month/ah-inbox`

### Return

- 单一路由：目标技能 + 路由理由 + 预期输出。
- 多意图路由：顺序链路 + 当前应先执行的第一个技能。
- 若意图不清或仅输入“请用 ah 处理”：返回“状态感知摘要 + 功能列表（编号）+ 输入数字选择指引”。
- 若用户仅输入数字：按上一轮功能列表编号直达对应技能。

### Failure Handling

- 状态冲突：按 `priority-resolution.md` 输出优先顺序。
- 意图模糊：按 `routing-matrix.md` 给最小澄清问题。
- 目标不可用：给次优技能并说明替代理由。

## Workflow

1. **Parse**：识别显式命令、核心意图、是否为“数字选择输入”。
2. **State Check**：读取 `STATUS.md`，识别 `阻塞/待交接/进行中`。
3. **Route**：按 `routing-matrix.md` 匹配目标技能。
4. **Resolve**：按 `priority-resolution.md` 处理冲突与优先级。
5. **Orchestrate**：多意图时按 `multi-intent-playbook.md` 给顺序链。
6. **Menu Fallback**：若意图不清，输出 4-6 个编号功能项（含首选项），并提示“输入数字继续”。
7. **Return**：按模板返回可执行下一步，不展开业务流程。

## Quality Bar

- 路由必须“状态感知 + 意图感知”，不能只靠关键词。
- 多意图必须给顺序，不把用户留在选择负担里。
- 输出以“下一步可执行”为中心，避免泛泛解释。
- 建议技能不超过 3 个，默认给出 1 个首选。
- 模糊意图时必须提供编号功能列表，允许用户直接输入数字（如 `1`）选择。
