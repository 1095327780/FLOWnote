---
name: ah-project
description: 项目创建技能。用于新建项目并生成统一目录结构、总览文件和领域关联。
---

# ah-project

创建符合 Flow 标准的项目结构与项目总览。

## 必须遵守

- Memory 默认最小读取：`STATUS + current project context`。
- 模板：
  - `assets/templates/项目模板.md`
  - `assets/templates/项目执行日志模板.md`
  - `assets/templates/项目思考模板.md`
  - `assets/templates/项目资源索引模板.md`
  - `assets/templates/项目产出模板.md`
- 关键分叉：`question gate: project_scaffold`
- 禁止编造已有项目编号，必须先扫描真实目录。

## `project_scaffold` 规则

1. 完整分层（默认）：
   - `📍 项目总览.md`
   - `01-规划与范围/`
   - `02-执行日志/`
   - `03-思考记录/`
   - `04-资料与引用/`
   - `05-产出草稿/`
   - `06-复盘归档/`
   - `_assets/`
2. 轻量结构：`📍 项目总览.md` + `_assets/`

未明确选择时默认“完整分层”。

## 流程

1. 收集项目信息（名称、目标、截止日期、领域）。
2. 扫描 `04-创造层/Projects/` 计算下一个编号。
3. 按 `project_scaffold` 创建目录。
4. 用模板生成 `📍 项目总览.md` 与基础子文档（可选）。
5. 更新领域页项目链接与 memory project 层。

## 按需读取 References

- 目录脚手架、命名与覆盖安全策略：`references/project-scaffold-details.md`

## 输出

- 项目路径与已创建结构。
- 下一步建议：执行日志用 `ah-capture/ah-review`，深思考用 `ah-think`。
