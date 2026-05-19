const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadHomeServiceWithMockObsidian() {
  const originalLoad = Module._load;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") {
      return {
        normalizePath(path) {
          return String(path || "").replace(/\/+/g, "/").replace(/^\.\//, "");
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const homePath = require.resolve("../../runtime/home/home-service");
  const dailyPath = require.resolve("../../runtime/mobile/daily-note-service");
  delete require.cache[homePath];
  delete require.cache[dailyPath];
  const service = require(homePath);

  return {
    ...service,
    restore() {
      Module._load = originalLoad;
      delete require.cache[homePath];
      delete require.cache[dailyPath];
    },
  };
}

function makeFile(path, content, stat = {}) {
  const parts = String(path || "").split("/");
  const name = parts[parts.length - 1] || path;
  const basename = name.replace(/\.md$/i, "");
  return {
    path,
    name,
    basename,
    extension: "md",
    parent: { path: parts.slice(0, -1).join("/") },
    stat: {
      ctime: stat.ctime || 0,
      mtime: stat.mtime || 0,
    },
    content,
  };
}

function createApp(files) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  return {
    vault: {
      getMarkdownFiles() {
        return files;
      },
      getAbstractFileByPath(path) {
        return byPath.get(String(path || "")) || null;
      },
      async cachedRead(file) {
        return String(file && file.content ? file.content : "");
      },
      async modify(file, content) {
        file.content = String(content || "");
      },
    },
    metadataCache: {
      getFileCache(file) {
        return file.frontmatter ? { frontmatter: file.frontmatter } : {};
      },
    },
  };
}

test("summarizeDailyNote extracts focus, record, and task stats", () => {
  const service = loadHomeServiceWithMockObsidian();
  try {
    const summary = service.summarizeDailyNote(`# 2026-05-19

## ⭐ 今天最重要的事
- 完成主页 MVP

## ✅ 任务
- [ ] 做数据服务
- [x] 调研插件

## 📝 记录
- 早上确认首页要好看
`);
    assert.equal(summary.focus, "完成主页 MVP");
    assert.equal(summary.record, "早上确认首页要好看");
    assert.deepEqual(summary.tasks, { open: 1, done: 1, total: 2, completionRate: 50 });
    assert.deepEqual(summary.taskItems.map((item) => ({
      lineIndex: item.lineIndex,
      text: item.text,
      done: item.done,
    })), [
      { lineIndex: 6, text: "做数据服务", done: false },
      { lineIndex: 7, text: "调研插件", done: true },
    ]);
  } finally {
    service.restore();
  }
});

test("toggleTaskLineInContent should update the target markdown checkbox only", () => {
  const service = loadHomeServiceWithMockObsidian();
  try {
    const content = [
      "## ✅ 任务",
      "- [ ] 做数据服务",
      "- [x] 调研插件",
      "",
    ].join("\n");
    const toggled = service.toggleTaskLineInContent(content, 1);
    assert.equal(toggled.changed, true);
    assert.equal(toggled.task.done, true);
    assert.equal(toggled.content, [
      "## ✅ 任务",
      "- [x] 做数据服务",
      "- [x] 调研插件",
      "",
    ].join("\n"));
  } finally {
    service.restore();
  }
});

test("toggleTaskInFile should persist checkbox changes through vault.modify", async () => {
  const service = loadHomeServiceWithMockObsidian();
  try {
    const file = makeFile("01-捕获层/每日笔记/2026-05-19.md", [
      "## ✅ 任务",
      "- [ ] 完成主页交互",
    ].join("\n"));
    const app = createApp([file]);
    const task = await service.toggleTaskInFile(app, file, 1);
    assert.equal(task.done, true);
    assert.match(file.content, /- \[x\] 完成主页交互/);
  } finally {
    service.restore();
  }
});

test("listActiveProjects reads real project overview files and task counts", async () => {
  const service = loadHomeServiceWithMockObsidian();
  try {
    const app = createApp([
      makeFile("04-创造层/项目/26-02 Flow工作法Obsidian插件/📍 项目总览.md", `---
状态: 进行中
优先级: 高
所属领域: [效率工具]
---

# 📍 Flow工作法Obsidian插件
- [ ] 移动端适配
- [x] 框架搭建
`, { mtime: 20 }),
      makeFile("04-创造层/项目/25-01 已完成/📍 项目总览.md", `---
状态: 已完成
---
# 已完成
`, { mtime: 30 }),
    ]);
    const projects = await service.listActiveProjects(app, {});
    assert.equal(projects.length, 1);
    assert.equal(projects[0].title, "Flow工作法Obsidian插件");
    assert.equal(projects[0].priority, "高");
    assert.equal(projects[0].tasks.open, 1);
    assert.equal(projects[0].tasks.done, 1);
  } finally {
    service.restore();
  }
});

test("listProjects includes inactive projects and derives category tags", async () => {
  const service = loadHomeServiceWithMockObsidian();
  try {
    const app = createApp([
      makeFile("04-创造层/项目/02-产品开发/26-02 Flow工作法Obsidian插件/📍 项目总览.md", `---
状态: 进行中
优先级: 高
---
# 📍 Flow工作法Obsidian插件
- [ ] 移动端适配
`, { mtime: 20 }),
      makeFile("04-创造层/项目/01-内容创作/26-01 已完成项目/📍 项目总览.md", `---
状态: 已完成
---
# 📍 已完成项目
- [x] 发布
`, { mtime: 30 }),
    ]);
    const projects = await service.listProjects(app, {});
    assert.equal(projects.length, 2);
    assert.equal(projects[0].title, "Flow工作法Obsidian插件");
    assert.equal(projects[0].isActive, true);
    assert.equal(projects[0].category, "产品开发");
    assert.equal(projects[0].domain, "产品开发");
    assert.equal(projects[1].status, "已完成");
    assert.equal(projects[1].isActive, false);
  } finally {
    service.restore();
  }
});

test("daily activity heatmap counts record entries from daily notes", async () => {
  const service = loadHomeServiceWithMockObsidian();
  try {
    const now = new Date("2026-05-19T12:00:00").getTime();
    const app = createApp([
      makeFile("01-捕获层/每日笔记/2026-05-18.md", `# 2026-05-18

## 📝 记录
- 记录 A
- 记录 B

## ✅ 任务
- [ ] 不计入记录
`, { ctime: now, mtime: now }),
      makeFile("01-捕获层/每日笔记/2026-05-19.md", `# 2026-05-19

## 📝 记录
今天想法
`, { ctime: now, mtime: now }),
    ]);
    const heatmap = await service.getDailyActivityHeatmap(app, {}, { now, days: 28 });
    assert.equal(heatmap.total, 3);
    assert.equal(heatmap.activeDays, 2);
    assert.equal(heatmap.maxCount, 2);
    const yesterday = heatmap.cells.find((cell) => cell.date === "2026-05-18");
    assert.equal(yesterday.count, 2);

    const month = await service.getDailyActivityHeatmap(app, {}, { startDate: "2026-05-01", endDate: "2026-05-31" });
    assert.equal(month.days, 31);
    assert.equal(month.startDate, "2026-05-01");
    assert.equal(month.endDate, "2026-05-31");
    assert.equal(month.total, 3);
  } finally {
    service.restore();
  }
});

test("getDashboardStats counts note assets and weekly activity", async () => {
  const service = loadHomeServiceWithMockObsidian();
  try {
    const now = new Date("2026-05-19T12:00:00").getTime();
    const app = createApp([
      makeFile("01-捕获层/每日笔记/2026-05-19.md", "# 今日\n- [ ] 今日任务", { ctime: now, mtime: now }),
      makeFile("02-培养层/永久笔记/原子化笔记让知识可以灵活组合.md", "- [x] done", { ctime: now, mtime: now }),
      makeFile("02-培养层/文献笔记/《卡片笔记写作法》阅读笔记.md", "", { ctime: now - 2 * 86400000, mtime: now }),
      makeFile("02-培养层/主题笔记/📍 知识管理.md", "", { ctime: now - 20 * 86400000, mtime: now - 20 * 86400000 }),
      makeFile("04-创造层/项目/26-02 Flow工作法Obsidian插件/📍 项目总览.md", `---
状态: 进行中
优先级: 高
---
- [ ] 移动端适配
`, { ctime: now - 1 * 86400000, mtime: now }),
    ]);
    const stats = await service.getDashboardStats(app, {}, { now, dateStr: "2026-05-19" });
    assert.equal(stats.today.exists, true);
    assert.equal(stats.activeProjects, 1);
    assert.equal(stats.highPriorityProjects, 1);
    assert.equal(stats.knowledgeAssets, 3);
    assert.equal(stats.weeklyNew, 4);
    assert.equal(stats.tasks.open, 2);
    assert.equal(stats.tasks.done, 1);
    assert.equal(stats.tasks.completionRate, 33);
  } finally {
    service.restore();
  }
});
