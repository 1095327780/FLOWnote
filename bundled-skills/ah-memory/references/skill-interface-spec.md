# Skill 接口规范

所有 ah-* 技能接入记忆系统时，统一遵循以下接口。

## 一、启动阶段（Phase 0）

每个技能启动时必须：

1. 读取 `Meta/.ai-memory/STATUS.md`。
2. 只解析与当前技能相关的区块。
3. 如存在待处理项，先提示用户继续或新开。

推荐提示：

```text
📋 发现待处理事项：
1. {{任务描述}}（来源：{{时间/来源}}）

继续处理还是开始新任务？
- A. 继续
- B. 新任务
```

## 二、执行阶段

在关键节点更新任务专属文件：

- `ah-read`：每完成一个批次或章节
- `ah-card`：每完成一张卡片
- `ah-project`：每完成一个里程碑
- `ah-review` / `ah-inbox`：每完成一轮批处理

`ah-read` 额外要求：

- 记录当前章节、章节范围与下一章节指针。
- 同步 `STATUS.md` 时同时写入批次进度与章节进度。

路径统一位于 `Meta/.ai-memory/` 下：

```text
reading/
cards/
projects/
legacy/
reviews/
```

## 三、结束阶段（Checkpoint）

每个技能结束时必须：

1. 更新任务专属文件的最终状态。
2. 整合更新 `Meta/.ai-memory/STATUS.md`。
3. 若产生新待办，写入对应区块。
4. 输出下一步建议（如需要跨技能接力）。

## 四、跨技能状态传递

- `ah-read -> ah-card`：写入“待整理卡片笔记”。
- `ah-inbox -> ah-card`：新增待制卡来源条目。
- `ah-project -> ah-archive`：标记项目为“待归档”。
- `ah-review -> ah-note/ah-week/ah-month`：写入缓冲任务区。

## 五、错误处理

### STATUS 文件不存在

1. 创建 `Meta/.ai-memory/`。
2. 按模板创建 `STATUS.md`。
3. 继续流程并在输出中说明已自动初始化。

### 任务专属文件不存在

1. 按对应模板创建。
2. 写入最小必要字段后继续执行。
3. 若父目录不存在（如 `reading/`、`cards/`、`projects/`、`legacy/`、`reviews/`），先创建目录再写入。

### 状态不一致

1. 以实际任务文件为准。
2. 回写修正 `STATUS.md`。
3. 在输出中明确说明修复内容。
