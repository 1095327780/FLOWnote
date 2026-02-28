# Project Sync Apply

## 目标

承接 `ah-project` 新建结果，强制将项目入口同步到相关领域页（🌱）。

## 输入字段

- `project_path`
- `project_title`
- `project_id`
- `domain`
- 可选：`domain_hints`
- `sync_mode`（必须是 `strict`）

## 执行步骤（Strict）

1. 按 `path-conventions.md` 获取领域页候选（`03-连接层/🌱*.md`）。
2. 用 `domain_hints` 优先匹配；无 hints 时用 `domain/project_title` 匹配。
3. 在命中领域页按固定分节写入项目入口：
   - 主锚点：`## 🚀 关联项目`
   - 子分节：`### 活跃项目`（仅允许存在一份）
4. 执行去重检查后再追加项目链接。
5. 输出 `hit/skip/miss` 与原因；若页面已有重复标题，追加 `warning`。

## 匹配优先级

- 显式 hints 优先。
- 领域名精确匹配优先于关键词模糊匹配。
- 多命中时最多写入前 1-2 个最相关领域页。

## 幂等规则

- 必须应用 `safe-sync-write-protocol.md` 的去重键规则。
- 页面任意位置存在同一项目链接键时直接 `skip`。
- 禁止重复创建 `### 活跃项目` 等同名标题。
- 仅做增量写入，不重排原页面结构。

## 未命中处理

- 保留项目创建结果，不回滚目录。
- 记录到巡检报告“待同步项”。
- 返回建议：新建领域页或人工确认领域归属。
- 必要时在状态中保留 `待交接:ah-index`。
