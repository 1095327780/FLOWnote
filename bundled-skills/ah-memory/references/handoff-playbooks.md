# Handoff Playbooks

## ah-read -> ah-card

1. `ah-read` 完成文献提炼后在“卡片笔记”写入 `待交接:ah-card`。
2. 返回建议：`/ah-card`。
3. `ah-card` 启动后优先识别该交接并继续执行。

## ah-review -> ah-card

1. `ah-review` 将待转化洞见写入“卡片笔记”。
2. 状态写 `待交接:ah-card`。
3. `ah-card` 完成后回到 `ah-review` 继续未处理条目。

## ah-project -> ah-archive

1. 项目完成时写入“项目”分区 `待交接:ah-archive`。
2. 返回建议：`/ah-archive`。
3. `ah-archive` 完成归档后将条目标记 `已完成`。
