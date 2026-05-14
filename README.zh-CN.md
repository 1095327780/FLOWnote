# FLOWnote

语言： [English](README.md) | **简体中文**

**FLOWnote 是一个让笔记真正"流动"起来的 Obsidian 插件——从随手捕获到产出成果，由 OpenCode 驱动的 AI 工作区配上为知识管理量身定制的技能包，一起搭起这条流水线。**

> **必须先安装 OpenCode**：使用 FLOWnote 的聊天、会话和技能工作流前，请先在电脑上安装 OpenCode。

## 这套系统在解决什么问题

大多数笔记系统都在同一个地方崩掉：想法积压的速度永远快过你处理它的速度，几周后超过 70% 的笔记再也没被打开。FLOWnote 押的是一件很朴素的事——**只要把"把一条想法向前推一步"这件事的摩擦做得足够小，你就真的会日复一日地做下去。** 这个押注，叫做 **FLOW 笔记法**。

```
捕获 → 加工 → 连接 → 输出
 F      L      O      W
 ↓      ↓      ↓      ↓
日记   永久   领域   项目
想法   笔记   页面   产出
```

- **F · 捕获（Feed）**——白天一键扔进今日日记，不挑文件夹、不纠结标签。
- **L · 加工（Lift）**——把碎想法淬炼成永久笔记：原子化、断言式标题、AI 协助找相关链接。
- **O · 连接（Organize）**——"领域页"是你的工作桌；做哪件事就摊开哪张桌子，相关笔记自己浮出来。
- **W · 输出（Work）**——项目自动落地为结构化目录，配合每日/每周/每月/每年复盘把闭环跑起来。

`bundled-skills/` 里的技能包负责所有机械动作（编号、目录、链接维护、索引刷新），你只管想清楚下一步写什么、想什么、做什么。

## 视频教程（B 站）

完整方法论拆解，作者在 B 站发布了 **FLOW 笔记法** 系列：

📺 **[B 站 · FLOW 笔记法合集](https://space.bilibili.com/24543451/lists/7386412?type=season)**

| 期数 | 主题 |
|---|---|
| 第 1 期 | 入门篇——系统全貌 + 每天 15 分钟工作流 |
| 第 2 期 | 阅读篇——从划线到文献笔记 |
| 第 3 期 | 永久笔记篇——原子化、断言式标题、AI 辅助制卡 |
| 第 4 期 | 知识连接篇——主题页 vs 领域页 |
| 第 5 期 | 项目与复盘篇——周/月/年三层复盘 |
| 第 6 期 | AI 总览篇——完整环境配置（制作中） |

## 使用前提

- 电脑已安装 OpenCode（必需）：[OpenCode 官网](https://opencode.ai) / [GitHub](https://github.com/anomalyco/opencode)
- Obsidian v1.5.0+
- 移动端如果需要 AI 清理或链接解析，按需配置第三方 API Key

## 核心能力

### 桌面端 AI 工作区

- 会话侧栏与历史持久化
- 流式回复、重试、取消
- 模型/Provider 切换与 Provider 鉴权处理
- 底层由 OpenCode SDK 负责会话与工具编排
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

- `打开`——打开 FLOWnote 聊天视图
- `发送选中文本`——把当前选中内容发送过去
- `新建会话`——开一个新会话
- `快速捕获想法`（移动端）

## 安装

完整的中文安装与模型配置教程见 `[[FLOWnote 安装与模型配置指南]]`。

### 社区插件安装

审核通过后，在 Community Plugins 搜索 `FLOWnote` 安装。启用 FLOWnote 前，请先确认电脑上的 OpenCode 已安装且可用。

### 手动安装

将以下文件放入：

`<Vault>/.obsidian/plugins/flownote/`

- `main.js`
- `manifest.json`
- `styles.css`

然后在 Obsidian 里重载插件。

## 配置

### 桌面端

1. 先在电脑安装 Node.js，再执行 `npm install -g opencode-ai` 安装 OpenCode，并确认 `opencode` 命令可用
2. 打开 FLOWnote 设置
3. CLI 路径建议先留空自动探测，必要时再填绝对路径
4. 选择启动方式（`auto` / 本机安装）；Windows 不再支持 WSL 安装

### 移动端

即使主要使用移动端快速捕获，FLOWnote 仍要求桌面端已安装 OpenCode。

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

### 笔记库与剪贴板访问

FLOWnote 需要调用以下 Obsidian API 才能跑通技能工作流，每一处调用都可在 `runtime/` 源码中复核：

- **笔记库枚举**（`vault.getFiles`、`vault.getMarkdownFiles`）——用于文件 @-提及选择器，以及让技能按名字定位笔记
- **笔记库读取**（`vault.read`、`vault.cachedRead`）——把选中笔记送入聊天上下文与技能提示词
- **笔记库写入**（`vault.create`、`vault.modify`）——追加捕获内容、保存聊天输出、把技能结果落进你的笔记
- **剪贴板访问**——仅用于聊天视图内的"复制消息/代码"按钮。FLOWnote 不主动读取剪贴板，复制操作均由用户触发

### 本地系统访问

FLOWnote 是带桌面端能力的插件，需要在磁盘上找到 OpenCode CLI。它仅读取以下标准环境变量**用于路径解析**，不做遥测、不做指纹采集：

- `os.homedir()` 与 `process.env.USERPROFILE`——获取用户主目录，用于解析 `~` 开头的路径
- `process.env.APPDATA`、`process.env.LOCALAPPDATA`——Windows 专用，用来查找 OpenCode 与 Node 的默认安装位置
- `process.env.PATH`、`process.env.PATHEXT`——用于搜索 `opencode` 可执行文件

FLOWnote 不调用 `os.hostname`、`os.userInfo`、`os.networkInterfaces`，也不会把上述任何值发到本机以外。

### 遥测

- FLOWnote 不包含独立遥测/行为上报通道
- 调试日志仅在本地控制台输出，受 `debugLogs` 控制

### 可能访问的网络地址（仅在用户启用相关功能后）

- AI 服务（示例）：
  - `api.deepseek.com`、`platform.deepseek.com`
  - `dashscope.aliyuncs.com`、`dashscope.console.aliyun.com`
  - `api.moonshot.cn`、`platform.moonshot.cn`
  - `open.bigmodel.cn`
  - `api.siliconflow.cn`、`cloud.siliconflow.cn`
  - 用户自定义端点
- 链接解析服务：
  - `apis.tianapi.com`、`www.tianapi.com`
  - `route.showapi.com`、`www.showapi.com`
  - `api.gugudata.com`、`www.gugudata.com`
- 桌面端本地 OpenCode 服务通信（`127.0.0.1` / `localhost`）
- OpenCode 官网文档/安装地址（`opencode.ai`）

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

- 感谢 [OpenCode](https://github.com/anomalyco/opencode) 提供运行时与 SDK 基础能力
- 感谢 [Claudian](https://github.com/YishenTu/claudian) 提供最初灵感
- 感谢 [Obsidian](https://obsidian.md) 提供插件 API

## 许可证

FLOWnote 采用 MIT 许可证。
