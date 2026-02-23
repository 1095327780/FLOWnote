# FLOWnote

语言： [English](README.md) | **简体中文**

FLOWnote 是一个由 OpenCode 驱动的 AI 笔记管理插件。

它的目标是提供完整闭环：

- 捕获 -> 培养 -> 连接 -> 创造
- 日常执行 + 周/月复盘
- 通过技能系统完成结构化知识管理，而不只是通用聊天

## FLOWnote 的独特点

FLOWnote 参考了 [Claudian](https://github.com/YishenTu/claudian)（将 Claude Code 集成到 Obsidian）。

FLOWnote 的路线不同：

- 集成的是 **OpenCode** 运行时
- 内置一套面向知识管理的 **领域技能包**
- 强调 **笔记管理闭环**，而不是只提供 Agent 入口

一句话：FLOWnote 不只是“把 OpenCode 接进 Obsidian”，而是“OpenCode + 一整套知识管理技能工作流”。

## 核心能力

### 桌面端 AI 工作区

- 会话侧栏与历史持久化
- 流式回复、重试、取消
- 模型/Provider 切换与 Provider 鉴权处理
- 连接诊断（可执行文件路径、启动方式、连接失败定位）

### 内置技能（自动同步）

- 插件内置技能位于 `bundled-skills/`
- 启动时会自动同步到 Vault 技能目录（默认 `.opencode/skills`）
- FLOWnote 仅启用内置技能 ID（避免混入非预期技能）
- 技能注入模式：`summary`（推荐）、`full`、`off`

### 移动端快速捕获

- 一键捕获到每日笔记
- 可选 AI 文本清理（口语转记录）
- 链接解析与降级链路：
  - 解析服务三选一：`TianAPI` / `ShowAPI` / `Gugudata`
  - 解析失败且已配置 AI：回退 AI
  - 无解析服务且无 AI Key：保留纯文本
- 所有方案都保留原始 URL
- 已包含 iOS 键盘遮挡兜底

## 内置技能清单

| 技能 | 作用 |
|---|---|
| `ah` | 统一入口：菜单 + 意图路由 |
| `ah-note` | 创建今日日记并初始化计划 |
| `ah-capture` | 低摩擦记录想法到每日笔记 |
| `ah-inbox` | 批量整理想法并分流（卡片/任务/已处理） |
| `ah-read` | 阅读划线整理与文献笔记处理 |
| `ah-card` | 洞见转永久笔记并推荐知识链接 |
| `ah-think` | 思维模型工具箱（费曼、第一性原理、逆向等） |
| `ah-review` | 每日回顾与反思流程 |
| `ah-week` | 周回顾（统计 + 残留想法处理） |
| `ah-month` | 月回顾与策略复盘 |
| `ah-project` | 项目结构自动创建 |
| `ah-archive` | 项目归档与经验提炼 |
| `ah-index` | 知识库 AI 索引维护 |
| `ah-memory` | 跨技能记忆与进度状态规范 |

## 命令

- `打开`
- `发送选中文本`
- `新建会话`
- `快速捕获想法`（移动端）

## 安装

### 社区插件安装

审核通过后，在 Community Plugins 搜索 `FLOWnote` 安装。

### 手动安装

将以下文件放入：

`<Vault>/.obsidian/plugins/flownote/`

- `main.js`
- `manifest.json`
- `styles.css`

然后在 Obsidian 里重载插件。

## 配置

### 桌面端

1. 本地安装 OpenCode
2. 打开 FLOWnote 设置
3. CLI 路径建议先留空自动探测，必要时再填绝对路径
4. 按环境选择启动方式（`auto` / Windows 本机 / WSL）

### 移动端

1. 配置 AI Provider（或自定义 OpenAI 兼容地址）
2. 如需链接解析，配置解析服务 Provider 与 Key
3. 设置每日笔记路径与想法区域标题

## 隐私、数据与联网披露

### 账户要求

- FLOWnote 本身不要求单独注册账号
- 第三方 AI/解析服务需用户自行配置凭据

### 数据存储

- 插件状态保存在 `data.json`（Obsidian 标准方式）
- 捕获内容写入用户笔记（如每日笔记）

### 遥测

- FLOWnote 不包含独立遥测/行为上报通道
- 调试日志仅在本地控制台输出，受 `debugLogs` 控制

### 可能访问的网络地址（仅在用户启用相关功能后）

- AI 服务（示例）：
  - `api.deepseek.com`
  - `dashscope.aliyuncs.com`
  - `api.moonshot.cn`
  - `open.bigmodel.cn`
  - `api.siliconflow.cn`
  - 用户自定义端点
- 链接解析服务：
  - `apis.tianapi.com`
  - `route.showapi.com`
  - `api.gugudata.com`
- 桌面端本地 OpenCode 服务通信

### 费用说明

- FLOWnote 插件本身免费
- 第三方 API 可能按服务商规则收费

## 开发

```bash
npm run ci
npm run build:release
npm run check:submission
```

Release 产物位于 `release/`：

- `release/main.js`
- `release/manifest.json`
- `release/styles.css`

## 致谢

- 本项目受 [Claudian](https://github.com/YishenTu/claudian) 启发
- Claudian 采用 MIT 许可，FLOWnote 也采用 MIT 许可
