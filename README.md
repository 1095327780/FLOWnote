# OpenCode Assistant (Obsidian)

## Source Of Truth

- 生产运行时代码唯一来源：`runtime/`
- `src/` 已移除，禁止重新引入历史代码树
- `main.js` 作为插件入口，动态加载 `runtime/` 模块

## Repo Hygiene

- `data.json` 是运行态数据，不可提交到仓库
- 参考样例：`data.example.json`
- 使用以下脚本做守卫：
  - `npm run guard:repo-hygiene`
  - `npm run guard:source-of-truth`
  - `npm run verify:version-sync`

## 发布前检查清单

每次推送发布相关改动前，按顺序执行：

1. `npm run ci`
2. `git ls-files -- data.json` 输出必须为空
3. `data.example.json` 必须存在且为合法 JSON
4. `main.js`、`manifest.json`、`package.json` 的版本信息保持一致

## 功能

- 会话侧栏（新建/切换）
- 聊天面板（流式增量渲染、重试、取消）
- 技能自动扫描（默认 `.opencode/skills/*/SKILL.md`）
- 技能注入策略（`full` / `summary` / `off`）
- 模型切换与默认模型保存
- 诊断面板（连接状态 + 可执行文件探测路径）
- 默认传输：`compat`（通过 `opencode serve` HTTP 接口）
- 实验传输：`sdk`（需显式开启实验开关）

## ENOENT 故障排查

如果看到：`spawn opencode ENOENT`

1. 打开插件设置，启用“自动探测 OpenCode CLI”。
2. 如果仍失败，在“OpenCode CLI 路径”填绝对路径，例如：
   - `/Users/shanghao/.opencode/bin/opencode`
3. 点击“测试 OpenCode 连接”，查看诊断结果。

## 鉴权模式

- `opencode-default`：使用 OpenCode 本机凭据/默认认证。
- `custom-api-key`：使用自定义 Provider + API Key + 可选 Base URL。

## 开发说明

当前运行时由 `main.js` 入口动态加载 `runtime/` 下的 CommonJS 模块。
发布构建不经过额外打包步骤，直接交付 `main.js + runtime/`。
