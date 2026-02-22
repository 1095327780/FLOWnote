# FLOWnote

FLOWnote 是一个 Obsidian 社区插件，提供两条能力：

1. 桌面端 AI 会话面板（会话管理、模型切换、技能注入、连接诊断）。
2. 移动端快速捕获（支持链接解析、AI 清理、写入每日笔记）。

## 主要功能

- 会话侧栏：新建、切换、持久化历史会话。
- 聊天面板：流式渲染、重试、取消、权限请求处理。
- 技能系统：扫描 `/.opencode/skills/*/SKILL.md` 并按策略注入。
- 连接诊断：检测可执行文件、启动方式、连接状态。
- 移动捕获：一键记录想法到每日笔记，可选 AI 清理和 URL 解析。

## 安装与升级

## 社区仓库安装
1. Obsidian -> 设置 -> 第三方插件 -> 浏览。
2. 搜索 `FLOWnote` 并安装。
3. 启用插件后打开设置完成初始化。

## 手动安装（开发/测试）
1. 将 `main.js`、`manifest.json`、`styles.css` 放入：  
   `Vault/.obsidian/plugins/flownote/`
2. 重新加载 Obsidian 并启用插件。

## 核心设置

## 桌面端
- `FLOWnote CLI 路径（可选）`：通常留空自动探测。
- `连接启动方式`：自动 / Windows 本机 / WSL。
- `技能注入方式`：`summary`（推荐）/`full`/`off`。

## 移动端
- AI 提供商、API Key、Base URL、模型名。
- 链接解析服务：`TianAPI` / `ShowAPI` / `咕咕数据` 三选一。
- 每日笔记路径与“想法区域标题”。

## 命令

- `打开`
- `发送选中文本`
- `新建会话`
- `快速捕获想法`（移动端）

## 常见问题

## 1) `spawn opencode ENOENT`
- 在设置中先使用自动探测。
- 如失败，手动填写 CLI 绝对路径（例如 `/Users/xxx/.opencode/bin/opencode`）。
- 运行“连接诊断”查看具体失败点。

## 2) 链接解析失败
- 检查所选解析服务 Key 是否可用、是否限流。
- 若未配置解析服务，插件会回退到 AI 或纯文本保留。

## 开发者政策与数据披露

## 账户要求
- 插件本身不要求单独注册 FLOWnote 账户。
- 如启用 AI 或 URL 解析，需用户自行配置第三方服务凭据。

## 联网与第三方服务
- 仅在用户触发相关功能时请求外网。
- 可能访问的服务类别：
  - AI 推理服务（例如 DeepSeek、通义千问、Moonshot、智谱、SiliconFlow 或用户自定义兼容 OpenAI 接口）。
  - URL 解析服务（TianAPI、ShowAPI、咕咕数据）。
  - 本地 FLOWnote/Opencode 运行时服务（桌面端会话能力）。

## 数据存储位置
- 配置与会话状态写入插件 `data.json`（Obsidian 插件标准存储）。
- 移动端捕获内容写入用户指定的每日笔记文件。
- 不会主动写入插件目录外的任意路径。

## 遥测声明
- 插件不包含独立遥测上报或行为统计代码。
- 调试日志仅在开启 `debugLogs` 时输出到控制台。

## 付费项说明
- 插件本身不收费。
- 第三方 AI/解析服务可能产生调用费用，计费规则由服务商决定。

## 外部文件访问说明
- 读取：当前 Vault 文件、技能目录。
- 写入：插件状态文件、用户确认后的目标笔记（如每日笔记）。

## 开发与发布

## 本地检查

```bash
npm run ci
npm run build:release
npm run check:submission
```

## Release 资产

- `release/main.js`
- `release/manifest.json`
- `release/styles.css`

发布到 Obsidian 社区仓库时，GitHub Release 仅上传以上三个文件。
