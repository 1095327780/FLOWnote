---
type: home
created: YYYY-MM-DD
updated: YYYY-MM-DD
version: 4.2
cssclasses:
  - flownote-home
---

# FLOWnote Home

> [!info]+ Plugin note
> This home document uses the **Dataview** plugin to calculate daily notes, projects, and recent activity automatically. If you want a page banner, install **Banners** as an optional plugin. This notice is added only when the home document is first created; later updates should not reinsert it after you delete it.

<!-- FLOWNOTE_HOME_AUTOMATED_START -->

## Today

```dataviewjs
const cfg = {
  daily: "{{notePaths.dailyNotes}}",
  highlights: "{{notePaths.highlights}}",
  permanent: "{{notePaths.permanentNotes}}",
  literature: "{{notePaths.literatureNotes}}",
  topics: "{{notePaths.topicNotes}}",
  domains: "{{notePaths.domainPages}}",
  projects: "{{notePaths.activeProjects}}",
  archives: "{{notePaths.archive}}",
  memory: "{{metaPaths.memory}}"
};

const today = dv.date("today");
const todayPath = `${cfg.daily}/${today.toFormat("yyyy-MM-dd")}`;
const todayPage = dv.page(todayPath);
const tasks = todayPage?.file?.tasks ?? [];
const openTasks = tasks.filter(t => !t.completed);
const doneTasks = tasks.filter(t => t.completed);
const capturesToday = todayPage ? todayPage.file.lists.length : 0;

dv.header(3, `${today.toFormat("yyyy-MM-dd")} · Week ${today.weekNumber}`);
dv.paragraph(`[[${todayPath}|Open today's note]] · Open tasks ${openTasks.length} · Done ${doneTasks.length} · Captures ${capturesToday}`);

if (openTasks.length) {
  dv.taskList(openTasks.slice(0, 8), false);
} else {
  dv.paragraph("No open tasks for today.");
}
```

## Directory Entry

```dataviewjs
const folders = [
  ["Capture", "Daily Notes", "{{notePaths.dailyNotes}}"],
  ["Capture", "Highlights", "{{notePaths.highlights}}"],
  ["Capture", "Weekly Reviews", "{{notePaths.weeklyReviews}}"],
  ["Capture", "Monthly Reviews", "{{notePaths.monthlyReviews}}"],
  ["Cultivate", "Permanent Notes", "{{notePaths.permanentNotes}}"],
  ["Cultivate", "Literature Notes", "{{notePaths.literatureNotes}}"],
  ["Cultivate", "Topic Notes", "{{notePaths.topicNotes}}"],
  ["Connect", "Areas", "{{notePaths.domainPages}}"],
  ["Create", "Projects", "{{notePaths.activeProjects}}"],
  ["Create", "Archives", "{{notePaths.archive}}"]
];

function pageCount(folder) {
  return dv.pages(`"${folder}"`).where(p => p.file.ext === "md").length;
}

dv.table(
  ["Layer", "Directory", "Notes", "Path"],
  folders.map(([layer, name, folder]) => [
    layer,
    name,
    pageCount(folder),
    `\`${folder}\``
  ])
);
```

## Active Projects

```dataviewjs
const projectRoot = "{{notePaths.activeProjects}}";
const overviewNames = new Set(["Project Overview", "📍 项目总览"]);

function projectFolderName(page) {
  const rel = page.file.path
    .replace(`${projectRoot}/`, "")
    .replace(/\/(Project Overview|📍 项目总览)\.md$/, "");
  return rel.split("/").filter(Boolean).join(" / ");
}

const projects = dv.pages(`"${projectRoot}"`)
  .where(p => p.file.ext === "md")
  .where(p => overviewNames.has(p.file.name))
  .where(p => p.file.path !== `${projectRoot}/Project Overview.md`)
  .where(p => p.file.path !== `${projectRoot}/📍 项目总览.md`)
  .where(p => !p.file.path.includes("/Archives/"))
  .where(p => !p.file.path.includes("/归档/"))
  .sort(p => p.file.mtime, "desc");

if (!projects.length) {
  dv.paragraph("No active projects.");
} else {
  dv.table(
    ["Project", "Status", "Priority", "Updated"],
    projects.map(p => [
      dv.fileLink(p.file.path, false, projectFolderName(p)),
      p.status ?? p.状态 ?? "Active",
      p.priority ?? p.优先级 ?? "—",
      p.file.mtime.toFormat("MM-dd")
    ])
  );
}
```

## Recent Activity

```dataviewjs
const hiddenPrefixes = [".", "{{metaPaths.memory}}", "{{metaPaths.legacyMemory}}", "Clippings/", "{{notePaths.archive}}/"];
const pages = dv.pages()
  .where(p => p.file.ext === "md")
  .where(p => !hiddenPrefixes.some(prefix => p.file.path.startsWith(prefix)))
  .where(p => p.file.path !== dv.current().file.path)
  .sort(p => p.file.mtime, "desc")
  .slice(0, 12);

dv.list(pages.map(p => `${p.file.link} · ${p.file.mtime.toFormat("MM-dd HH:mm")}`));
```

## Knowledge Map

```dataviewjs
const cfg = {
  daily: "{{notePaths.dailyNotes}}",
  highlights: "{{notePaths.highlights}}",
  permanent: "{{notePaths.permanentNotes}}",
  literature: "{{notePaths.literatureNotes}}",
  topics: "{{notePaths.topicNotes}}",
  domains: "{{notePaths.domainPages}}",
  projects: "{{notePaths.activeProjects}}"
};

const overviewNames = new Set(["Project Overview", "📍 项目总览"]);
const count = (folder) => dv.pages(`"${folder}"`).where(p => p.file.ext === "md").length;
const projects = dv.pages(`"${cfg.projects}"`)
  .where(p => p.file.ext === "md" && overviewNames.has(p.file.name))
  .where(p => p.file.path !== `${cfg.projects}/Project Overview.md`)
  .where(p => p.file.path !== `${cfg.projects}/📍 项目总览.md`)
  .where(p => !p.file.path.includes("/Archives/"))
  .length;

dv.table(
  ["Daily", "Highlights", "Permanent", "Literature", "Topics", "Areas", "Projects"],
  [[
    count(cfg.daily),
    count(cfg.highlights),
    count(cfg.permanent),
    count(cfg.literature),
    count(cfg.topics),
    count(cfg.domains),
    projects
  ]]
);
```

## AI Workflows

| Scenario | Command | Scenario | Command |
|---|---|---|---|
| Create today's note | `/ah-note` | Capture into today's note | `/ah-capture` |
| Create a permanent note | `/ah-card` | Process reading notes | `/ah-read` |
| Create a project | `/ah-project` | Daily review | `/ah-review` |
| Weekly review | `/ah-week` | Monthly review | `/ah-month` |
| Update home and index | `/ah-init` | Unsure what to use | `/ah` |

<!-- FLOWNOTE_HOME_AUTOMATED_END -->
