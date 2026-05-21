const { Notice, setIcon } = require("obsidian");
const { tr, normalizeLinkedContextPath } = require("./shared-utils");
const {
  findOrCreateTodayDailyNote,
  getDailyActivityHeatmap,
  getDashboardStats,
  getTodayState,
  listProjects,
  listRecentFiles,
  toggleTaskInFile,
} = require("../../home/home-service");

function getHomeLocale(view) {
  if (view && view.plugin && typeof view.plugin.getEffectiveLocale === "function") {
    return view.plugin.getEffectiveLocale() === "zh-CN" ? "zh-CN" : "en";
  }
  return "zh-CN";
}

function homeText(view, zh, en) {
  return getHomeLocale(view) === "zh-CN" ? zh : en;
}

function formatRelativeTime(timestamp, locale = "zh-CN") {
  const value = Number(timestamp || 0);
  if (!value) return "";
  const diff = Date.now() - value;
  const isZh = locale === "zh-CN";
  if (diff < 60 * 1000) return isZh ? "刚刚" : "Just now";
  if (diff < 60 * 60 * 1000) {
    const minutes = Math.max(1, Math.floor(diff / 60000));
    return isZh ? `${minutes}分钟前` : `${minutes} min ago`;
  }
  if (diff < 24 * 60 * 60 * 1000) {
    const hours = Math.max(1, Math.floor(diff / 3600000));
    return isZh ? `${hours}小时前` : `${hours}h ago`;
  }
  if (diff < 7 * 24 * 60 * 60 * 1000) {
    const days = Math.max(1, Math.floor(diff / 86400000));
    return isZh ? `${days}天前` : `${days}d ago`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatWeekday(dateStr, locale = "zh-CN") {
  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  const dateLocale = locale === "zh-CN" ? "zh-CN" : "en-US";
  return date.toLocaleDateString(dateLocale, { weekday: "short" });
}

function setButtonIcon(button, icon, fallback = "") {
  try {
    setIcon(button, icon);
  } catch {
    if (fallback) button.setText(fallback);
  }
}

function createActionButton(parent, icon, label, onClick, cls = "") {
  const button = parent.createEl("button", { cls: `oc-home-action ${cls}`.trim() });
  button.setAttr("type", "button");
  button.setAttr("aria-label", label);
  button.setAttr("title", label);
  const iconEl = button.createSpan({ cls: "oc-home-action-icon" });
  setButtonIcon(iconEl, icon);
  button.createSpan({ cls: "oc-home-action-label", text: label });
  button.addEventListener("click", onClick);
  return button;
}

function resolveVaultFile(view, fileOrPath) {
  if (fileOrPath && typeof fileOrPath === "object" && fileOrPath.path) return fileOrPath;
  const path = String(fileOrPath || "").trim();
  if (!path || !view.app || !view.app.vault || typeof view.app.vault.getAbstractFileByPath !== "function") return null;
  return view.app.vault.getAbstractFileByPath(path);
}

async function openVaultFile(view, fileOrPath) {
  const file = resolveVaultFile(view, fileOrPath);
  if (!file) {
    new Notice(homeText(view, tr(view, "view.home.fileMissing", "文件不存在"), "File not found"));
    return;
  }
  const workspace = view.app && view.app.workspace;
  const leaf = workspace && typeof workspace.getLeaf === "function"
    ? workspace.getLeaf("tab")
    : workspace && typeof workspace.getRightLeaf === "function"
      ? workspace.getRightLeaf(false)
      : null;
  if (!leaf || typeof leaf.openFile !== "function") {
    new Notice(homeText(view, tr(view, "view.home.openFileUnsupported", "当前设备暂不支持从首页打开文件"), "Opening files from Home is not supported on this device"));
    return;
  }
  await leaf.openFile(file);
  if (workspace && typeof workspace.setActiveLeaf === "function") {
    workspace.setActiveLeaf(leaf);
  }
}

function findHomeDocument(view) {
  const vault = view.app && view.app.vault;
  if (!vault) return null;
  const candidates = [
    "🏠Home.md",
    "🏠 主页.md",
    "🏠 Home.md",
    "Home.md",
    "Clippings/阿浩的Obsidian模板/🏠 主页.md",
  ];
  if (typeof vault.getAbstractFileByPath === "function") {
    for (const path of candidates) {
      const file = vault.getAbstractFileByPath(path);
      if (file) return file;
    }
  }
  if (typeof vault.getMarkdownFiles !== "function") return null;
  return vault.getMarkdownFiles().find((file) => file && /^(🏠\s*)?(主页|Home)\.md$/i.test(file.name || "")) || null;
}

async function openHomeDocument(view) {
  const file = findHomeDocument(view);
  if (!file) {
    new Notice(homeText(view, "未找到 🏠 主页.md", "Home document not found"));
    return;
  }
  await openVaultFile(view, file);
}

async function createAndOpenToday(view) {
  try {
    const file = await findOrCreateTodayDailyNote(view.app, view.plugin.settings || {}, {
      locale: typeof view.plugin.getEffectiveLocale === "function" ? view.plugin.getEffectiveLocale() : "zh-CN",
    });
    await openVaultFile(view, file);
    view.render();
  } catch (error) {
    new Notice(error instanceof Error ? error.message : String(error));
  }
}

function addHomeLinkedContext(view, fileOrPath) {
  const path = normalizeLinkedContextPath(fileOrPath && fileOrPath.path ? fileOrPath.path : fileOrPath);
  if (!path) return;
  const current = typeof view.getLinkedContextFilePaths === "function"
    ? view.getLinkedContextFilePaths()
    : Array.isArray(view.linkedContextFiles)
      ? view.linkedContextFiles.map((item) => normalizeLinkedContextPath(item)).filter(Boolean)
      : [];
  if (!current.includes(path)) {
    current.push(path);
    view.linkedContextFiles = current;
  }
}

async function runHomePrompt(view, promptText, options = {}) {
  const text = String(promptText || "").trim();
  if (!text) return;
  (Array.isArray(options.linkedFiles) ? options.linkedFiles : []).forEach((file) => addHomeLinkedContext(view, file));
  view.activePanel = "chat";
  view.render();
  await view.sendPrompt(text);
}

function prefillHomePrompt(view, promptText, options = {}) {
  (Array.isArray(options.linkedFiles) ? options.linkedFiles : []).forEach((file) => addHomeLinkedContext(view, file));
  view.activePanel = "chat";
  view.render();
  if (typeof view.refreshLinkedContextIndicators === "function") {
    view.refreshLinkedContextIndicators();
  }
  const input = view.elements && view.elements.input;
  if (!input) return;
  input.value = String(promptText || "");
  input.focus();
}

function renderStatCard(parent, item) {
  const card = parent.createDiv({ cls: `oc-home-stat ${item.tone ? `is-${item.tone}` : ""}`.trim() });
  const icon = card.createDiv({ cls: "oc-home-stat-icon" });
  setButtonIcon(icon, item.icon || "circle");
  const body = card.createDiv({ cls: "oc-home-stat-body" });
  body.createDiv({ cls: "oc-home-stat-value", text: String(item.value ?? "0") });
  body.createDiv({ cls: "oc-home-stat-label", text: String(item.label || "") });
  if (item.detail) body.createDiv({ cls: "oc-home-stat-detail", text: String(item.detail) });
}

function renderInlineTaskText(parent, text) {
  const raw = String(text || "");
  const pattern = /\*\*([^*]+)\*\*/g;
  let cursor = 0;
  let match = pattern.exec(raw);
  while (match) {
    if (match.index > cursor) parent.appendText(raw.slice(cursor, match.index));
    parent.createEl("strong", { text: match[1] });
    cursor = match.index + match[0].length;
    match = pattern.exec(raw);
  }
  if (cursor < raw.length) parent.appendText(raw.slice(cursor));
}

function projectAccent(project) {
  const palette = ["#2563eb", "#10b981", "#d97706", "#7c3aed", "#0f766e", "#db2777"];
  const source = `${project && project.domain ? project.domain : ""}|${project && project.category ? project.category : ""}|${project && project.title ? project.title : ""}`;
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  }
  if (project && /高|high/i.test(String(project.priority || ""))) return "#f97316";
  if (project && /已完成|完成|done/i.test(String(project.status || ""))) return "#10b981";
  if (project && /暂停|搁置|paused|hold/i.test(String(project.status || ""))) return "#64748b";
  return palette[hash % palette.length];
}

function normalizeHomeScrollState(value) {
  const source = value && typeof value === "object" ? value : {};
  const top = Number(source.top || 0);
  const left = Number(source.left || 0);
  const statsLeft = Number(source.statsLeft || 0);
  return {
    top: Number.isFinite(top) && top > 0 ? top : 0,
    left: Number.isFinite(left) && left > 0 ? left : 0,
    statsLeft: Number.isFinite(statsLeft) && statsLeft > 0 ? statsLeft : 0,
  };
}

function saveHomeScrollPosition() {
  const current = normalizeHomeScrollState(this.homeScrollState);
  const home = this.elements && this.elements.homeContainer;
  if (home) {
    current.top = Math.max(0, Number(home.scrollTop || 0));
    current.left = Math.max(0, Number(home.scrollLeft || 0));
  }
  const stats = this.elements && this.elements.homeStats;
  if (stats) {
    current.statsLeft = Math.max(0, Number(stats.scrollLeft || 0));
  }
  this.homeScrollState = current;
  return current;
}

function unbindHomeScrollTracking() {
  if (this.homeScrollEl && typeof this.homeScrollHandler === "function") {
    this.homeScrollEl.removeEventListener("scroll", this.homeScrollHandler);
  }
  if (this.homeStatsScrollEl && typeof this.homeStatsScrollHandler === "function") {
    this.homeStatsScrollEl.removeEventListener("scroll", this.homeStatsScrollHandler);
  }
  this.homeScrollEl = null;
  this.homeScrollHandler = null;
  this.homeStatsScrollEl = null;
  this.homeStatsScrollHandler = null;
  if (this.pendingHomeScrollRaf) {
    cancelAnimationFrame(this.pendingHomeScrollRaf);
    this.pendingHomeScrollRaf = 0;
  }
}

function bindHomeScrollTracking(container, statsGrid = null) {
  this.unbindHomeScrollTracking();
  this.elements.homeContainer = container;
  if (statsGrid) this.elements.homeStats = statsGrid;

  const onHomeScroll = () => {
    const current = normalizeHomeScrollState(this.homeScrollState);
    current.top = Math.max(0, Number(container.scrollTop || 0));
    current.left = Math.max(0, Number(container.scrollLeft || 0));
    this.homeScrollState = current;
  };
  container.addEventListener("scroll", onHomeScroll, { passive: true });
  this.homeScrollEl = container;
  this.homeScrollHandler = onHomeScroll;

  if (statsGrid && typeof statsGrid.addEventListener === "function") {
    const onStatsScroll = () => {
      const current = normalizeHomeScrollState(this.homeScrollState);
      current.statsLeft = Math.max(0, Number(statsGrid.scrollLeft || 0));
      this.homeScrollState = current;
    };
    statsGrid.addEventListener("scroll", onStatsScroll, { passive: true });
    this.homeStatsScrollEl = statsGrid;
    this.homeStatsScrollHandler = onStatsScroll;
  }
}

function restoreHomeScrollPosition(container, statsGrid = null) {
  const state = normalizeHomeScrollState(this.homeScrollState);
  if (this.pendingHomeScrollRaf) cancelAnimationFrame(this.pendingHomeScrollRaf);
  this.pendingHomeScrollRaf = requestAnimationFrame(() => {
    this.pendingHomeScrollRaf = 0;
    const home = container || (this.elements && this.elements.homeContainer);
    if (home) {
      const maxTop = Math.max(0, Number(home.scrollHeight || 0) - Number(home.clientHeight || 0));
      const maxLeft = Math.max(0, Number(home.scrollWidth || 0) - Number(home.clientWidth || 0));
      home.scrollTop = Math.min(state.top, maxTop);
      home.scrollLeft = Math.min(state.left, maxLeft);
    }
    const stats = statsGrid || (this.elements && this.elements.homeStats);
    if (stats) {
      const maxStatsLeft = Math.max(0, Number(stats.scrollWidth || 0) - Number(stats.clientWidth || 0));
      stats.scrollLeft = Math.min(state.statsLeft, maxStatsLeft);
    }
  });
}

async function toggleTodayTask(view, today, task) {
  try {
    if (typeof view.saveHomeScrollPosition === "function") {
      view.saveHomeScrollPosition();
    }
    await toggleTaskInFile(view.app, today.file, task.lineIndex);
    view.render();
  } catch (error) {
    new Notice(error instanceof Error ? error.message : String(error));
  }
}

function renderTodayTasks(view, parent, today, taskItems) {
  const section = parent.createDiv({ cls: "oc-home-task-section" });
  const header = section.createDiv({ cls: "oc-home-task-header" });
  header.createDiv({ cls: "oc-home-kicker", text: homeText(view, "今日待办", "Today's Tasks") });
  if (taskItems.length) {
    header.createDiv({ cls: "oc-home-task-hint", text: homeText(view, "点击同步勾选", "Click to sync") });
  }

  const list = section.createDiv({ cls: "oc-home-task-list" });
  if (!taskItems.length) {
    list.createDiv({
      cls: "oc-home-empty-copy",
      text: homeText(view, "今日任务区还没有可勾选的待办。", "No checkbox tasks in today's note yet."),
    });
    return;
  }

  taskItems.forEach((task) => {
    const row = list.createDiv({
      cls: `oc-home-task-row ${task.done ? "is-done" : ""}`.trim(),
    });
    row.setAttr("tabindex", "0");
    row.setAttr("role", "checkbox");
    row.setAttr("aria-checked", task.done ? "true" : "false");
    row.setAttr("title", task.done
      ? homeText(view, "标记为未完成", "Mark as incomplete")
      : homeText(view, "标记为已完成", "Mark as complete"));
    const checkbox = row.createSpan({ cls: "oc-home-task-checkbox", attr: { "aria-hidden": "true" } });
    if (task.done) setButtonIcon(checkbox, "check");
    const text = row.createSpan({ cls: "oc-home-task-text" });
    renderInlineTaskText(text, task.text);
    row.addEventListener("click", () => {
      void toggleTodayTask(view, today, task);
    });
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      void toggleTodayTask(view, today, task);
    });
  });
}

function renderTodayCard(view, parent, today) {
  const card = parent.createDiv({ cls: "oc-home-card oc-home-today-card" });
  const header = card.createDiv({ cls: "oc-home-card-header" });
  const title = header.createDiv({ cls: "oc-home-card-title" });
  const icon = title.createSpan({ cls: "oc-home-card-icon" });
  setButtonIcon(icon, "calendar-days");
  title.createSpan({ text: homeText(view, "今日", "Today") });
  header.createDiv({
    cls: `oc-home-pill ${today.exists ? "is-ok" : "is-warn"}`,
    text: today.exists ? homeText(view, "已创建", "Created") : homeText(view, "待创建", "Not Created"),
  });

  card.createDiv({ cls: "oc-home-date", text: today.dateStr });

  if (!today.exists) {
    card.createDiv({
      cls: "oc-home-empty-copy",
      text: homeText(
        view,
        "今天的日记还没创建。先把今日聚焦立起来，后面的记录和复盘才有承接点。",
        "Today's note has not been created yet. Start with a focus, then capture and review from there.",
      ),
    });
    const actions = card.createDiv({ cls: "oc-home-card-actions" });
    createActionButton(actions, "plus", homeText(view, "创建今日日记", "Create Today"), () => createAndOpenToday(view), "is-primary");
    createActionButton(actions, "message-square", homeText(view, "和 FLOWnote 规划今天", "Plan with FLOWnote"), () => prefillHomePrompt(view, "/ah-note "), "");
    return;
  }

  const summary = today.summary || {};
  const focusText = summary.focus || homeText(view, "还没有写下今日聚焦", "No focus written yet");
  const tasks = summary.tasks || { open: 0, done: 0, total: 0, completionRate: 0 };
  const taskItems = Array.isArray(summary.taskItems) ? summary.taskItems : [];
  const completionRate = Math.max(0, Math.min(100, Number(tasks.completionRate || 0)));

  const focus = card.createDiv({ cls: "oc-home-focus" });
  focus.createDiv({ cls: "oc-home-kicker", text: homeText(view, "今日聚焦", "Today's Focus") });
  focus.createDiv({ cls: "oc-home-focus-text", text: focusText });

  const progress = card.createDiv({ cls: "oc-home-today-progress" });
  progress.setAttr("aria-label", homeText(view, `今日待办完成率 ${completionRate}%`, `Today's task completion ${completionRate}%`));
  const progressTrack = progress.createDiv({ cls: "oc-home-today-progress-track" });
  const progressFill = progressTrack.createDiv({ cls: "oc-home-today-progress-fill" });
  progressFill.style.width = `${completionRate}%`;
  progress.createDiv({ cls: "oc-home-today-progress-value", text: `${completionRate}%` });

  renderTodayTasks(view, card, today, taskItems);

  const actions = card.createDiv({ cls: "oc-home-card-actions" });
  createActionButton(actions, "file-text", homeText(view, "打开日记", "Open Note"), () => openVaultFile(view, today.file), "is-primary");
  createActionButton(actions, "message-square", homeText(view, "推进今天", "Move Today"), () => prefillHomePrompt(
    view,
    homeText(
      view,
      "基于今日日记，帮我梳理今天下一步最应该推进什么，并给出一个简洁的行动清单。",
      "Based on today's note, help me decide the most important next step and give me a concise action list.",
    ),
    { linkedFiles: [today.file] },
  ), "");
  createActionButton(actions, "pen-line", homeText(view, "继续记录", "Keep Capturing"), () => prefillHomePrompt(view, `/ah-capture `), "");
}

function displayProjectStatus(view, status) {
  const raw = String(status || "").trim();
  if (getHomeLocale(view) === "zh-CN") return raw || "进行中";
  if (/已完成|完成|done/i.test(raw)) return "Done";
  if (/归档|archived/i.test(raw)) return "Archived";
  if (/暂停|搁置|paused|hold/i.test(raw)) return "Paused";
  if (/进行中|active|in[- ]?progress|doing/i.test(raw)) return "In Progress";
  return raw || "In Progress";
}

function displayPriority(view, priority) {
  const raw = String(priority || "").trim();
  if (!raw || getHomeLocale(view) === "zh-CN") return raw;
  if (/高|high/i.test(raw)) return "High";
  if (/中|medium/i.test(raw)) return "Medium";
  if (/低|low/i.test(raw)) return "Low";
  return raw;
}

function renderProjectCard(view, parent, project) {
  const item = parent.createDiv({
    cls: `oc-home-project ${/高|high/i.test(String(project.priority || "")) ? "is-high-priority" : ""}`.trim(),
  });
  item.style.setProperty("--home-project-accent", projectAccent(project));
  const title = item.createDiv({ cls: "oc-home-project-title", text: project.title || homeText(view, "未命名项目", "Untitled Project") });
  title.setAttr("title", project.title || "");
  const tags = item.createDiv({ cls: "oc-home-project-tags" });
  const tagValues = [project.domain, project.category].map((tag) => String(tag || "").trim()).filter(Boolean);
  [...new Set(tagValues)].slice(0, 2).forEach((tag) => tags.createSpan({ cls: "oc-home-project-tag", text: tag }));
  tags.createDiv({ cls: `oc-home-project-status ${project.isActive ? "is-active" : ""}`.trim(), text: displayProjectStatus(view, project.status) });
  if (project.priority) tags.createDiv({ cls: `oc-home-pill ${/高|high/i.test(project.priority) ? "is-hot" : ""}`, text: displayPriority(view, project.priority) });
  const chatBtn = tags.createEl("button", { cls: "oc-home-project-chat" });
  chatBtn.setAttr("type", "button");
  chatBtn.setAttr("aria-label", homeText(view, "聊这个项目", "Chat about this project"));
  chatBtn.setAttr("title", homeText(view, "聊这个项目", "Chat about this project"));
  setButtonIcon(chatBtn, "message-square");
  chatBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    prefillHomePrompt(
      view,
      homeText(
        view,
        `基于「${project.title || "这个项目"}」项目总览，帮我判断当前最应该推进的下一步，并给出 3 条具体行动建议。`,
        `Based on the project overview for "${project.title || "this project"}", identify the next best step and give me 3 concrete actions.`,
      ),
      { linkedFiles: [project.file] },
    );
  });
  const bar = item.createDiv({ cls: "oc-home-progress" });
  const completionRate = Math.max(0, Math.min(100, project.tasks.completionRate || 0));
  const fill = bar.createDiv({ cls: "oc-home-progress-fill" });
  fill.style.width = `${completionRate}%`;
  bar.createSpan({ cls: "oc-home-progress-label", text: `${completionRate}%` });
  const progressMeta = item.createDiv({ cls: "oc-home-project-progress-meta" });
  progressMeta.createSpan({ text: homeText(view, `待办 ${project.tasks.open} · 完成 ${project.tasks.done}`, `${project.tasks.open} open · ${project.tasks.done} done`) });
  if (project.dueDate) progressMeta.createSpan({ text: project.dueDate });
  item.addEventListener("click", () => openVaultFile(view, project.file));
}

function heatmapLevel(cell, maxCount) {
  const count = Number(cell && cell.count ? cell.count : 0);
  if (count <= 0) return 0;
  if (maxCount <= 1) return 2;
  const ratio = count / maxCount;
  if (ratio >= 0.75) return 4;
  if (ratio >= 0.45) return 3;
  if (ratio >= 0.2) return 2;
  return 1;
}

function currentHeatmapState(view) {
  const now = new Date();
  const raw = view.homeHeatmapState && typeof view.homeHeatmapState === "object" ? view.homeHeatmapState : {};
  const year = Number.isInteger(Number(raw.year)) ? Number(raw.year) : now.getFullYear();
  const normalized = {
    mode: "year",
    year: Math.min(9999, Math.max(1970, year)),
    month: now.getMonth() + 1,
  };
  view.homeHeatmapState = normalized;
  return normalized;
}

function formatDateKey(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function heatmapRangeFromState(state) {
  const year = Number(state.year);
  return {
    startDate: formatDateKey(year, 1, 1),
    endDate: formatDateKey(year, 12, 31),
  };
}

function heatmapLabel(state, view) {
  return homeText(view, `${state.year}年`, `${state.year}`);
}

function rerenderHomeAfterHeatmapChange(view) {
  if (typeof view.saveHomeScrollPosition === "function") view.saveHomeScrollPosition();
  view.render();
}

function shiftHeatmapPeriod(view, delta) {
  const state = currentHeatmapState(view);
  view.homeHeatmapState = { ...state, year: state.year + delta };
  rerenderHomeAfterHeatmapChange(view);
}

function renderActivityHeatmap(view, parent, heatmap) {
  const state = currentHeatmapState(view);
  const card = parent.createDiv({ cls: "oc-home-card oc-home-heatmap-card" });
  const header = card.createDiv({ cls: "oc-home-card-header" });
  const title = header.createDiv({ cls: "oc-home-card-title" });
  const icon = title.createSpan({ cls: "oc-home-card-icon" });
  setButtonIcon(icon, "activity");
  title.createSpan({ text: homeText(view, "记录热力图", "Record Heatmap") });
  const actions = header.createDiv({ cls: "oc-home-heatmap-actions" });
  const period = actions.createDiv({ cls: "oc-home-heatmap-period" });
  const prev = period.createEl("button", { cls: "oc-home-heatmap-nav" });
  prev.setAttr("type", "button");
  prev.setAttr("aria-label", homeText(view, "上一年", "Previous year"));
  setButtonIcon(prev, "chevron-left", "<");
  prev.addEventListener("click", () => shiftHeatmapPeriod(view, -1));
  period.createSpan({ cls: "oc-home-heatmap-label", text: heatmapLabel(state, view) });
  const next = period.createEl("button", { cls: "oc-home-heatmap-nav" });
  next.setAttr("type", "button");
  next.setAttr("aria-label", homeText(view, "下一年", "Next year"));
  setButtonIcon(next, "chevron-right", ">");
  next.addEventListener("click", () => shiftHeatmapPeriod(view, 1));
  actions.createDiv({ cls: "oc-home-pill", text: homeText(view, `${heatmap.total} 条记录`, `${heatmap.total} records`) });

  const graph = card.createDiv({ cls: "oc-home-heatmap-wrap" });
  const grid = graph.createDiv({ cls: `oc-home-heatmap-grid is-${state.mode}` });
  const maxCount = Number(heatmap.maxCount || 0);
  (Array.isArray(heatmap.cells) ? heatmap.cells : []).forEach((cell) => {
    const level = heatmapLevel(cell, maxCount);
    const square = grid.createDiv({ cls: `oc-home-heatmap-cell is-level-${level}` });
    square.setAttr("title", homeText(view, `${cell.date} · ${cell.count || 0} 条记录`, `${cell.date} · ${cell.count || 0} records`));
    square.setAttr("aria-label", homeText(view, `${cell.date} · ${cell.count || 0} 条记录`, `${cell.date} · ${cell.count || 0} records`));
    if (cell.file) {
      square.addClass("is-clickable");
      square.addEventListener("click", () => openVaultFile(view, cell.file));
    }
  });
  const footer = card.createDiv({ cls: "oc-home-heatmap-footer" });
  footer.createSpan({ text: homeText(view, `${heatmap.activeDays} 天有记录 · ${heatmap.startDate} 至 ${heatmap.endDate}`, `${heatmap.activeDays} active days · ${heatmap.startDate} to ${heatmap.endDate}`) });
  const legend = footer.createSpan({ cls: "oc-home-heatmap-legend" });
  legend.createSpan({ text: homeText(view, "少", "Less") });
  for (let i = 0; i <= 4; i += 1) {
    legend.createSpan({ cls: `oc-home-heatmap-cell is-level-${i}` });
  }
  legend.createSpan({ text: homeText(view, "多", "More") });
}

function renderRecentItem(view, parent, item) {
  const row = parent.createDiv({ cls: "oc-home-recent-item" });
  const icon = row.createDiv({ cls: "oc-home-recent-icon" });
  const typeIcon = /项目|Project/i.test(item.type) ? "folder-kanban" : /永久笔记|Permanent/i.test(item.type) ? "badge-check" : "file-text";
  setButtonIcon(icon, typeIcon);
  const body = row.createDiv({ cls: "oc-home-recent-body" });
  body.createDiv({ cls: "oc-home-recent-title", text: item.title || item.path });
  body.createDiv({ cls: "oc-home-recent-meta", text: `${item.type} · ${formatRelativeTime(item.mtime, getHomeLocale(view))}` });
  row.addEventListener("click", () => openVaultFile(view, item.file));
}

function renderQuickActions(view, parent, options = {}) {
  const isInline = Boolean(options.inline);
  const host = isInline ? parent : parent.createDiv({ cls: "oc-home-card oc-home-actions-card" });
  if (!isInline) {
    const card = host;
    const header = card.createDiv({ cls: "oc-home-card-header" });
    const title = header.createDiv({ cls: "oc-home-card-title" });
    const icon = title.createSpan({ cls: "oc-home-card-icon" });
    setButtonIcon(icon, "zap");
    title.createSpan({ text: homeText(view, "快捷动作", "Quick Actions") });
  }

  const grid = host.createDiv({ cls: `oc-home-action-grid ${isInline ? "oc-home-action-grid-hero" : ""}`.trim() });
  createActionButton(grid, "home", homeText(view, "打开主页文档", "Open Home"), () => openHomeDocument(view), "is-soft is-icon-only");
  createActionButton(grid, "sun", homeText(view, "规划今天", "Plan Today"), () => runHomePrompt(view, "/ah-note"), "is-soft");
  createActionButton(grid, "inbox", homeText(view, "快速捕获", "Quick Capture"), () => prefillHomePrompt(view, "/ah-capture "), "is-soft");
  createActionButton(grid, "check-circle-2", homeText(view, "每日回顾", "Daily Review"), () => runHomePrompt(view, "/ah-review"), "is-soft");
  createActionButton(grid, "folder-plus", homeText(view, "新建项目", "New Project"), () => prefillHomePrompt(view, "/ah-project "), "is-soft");
}

function renderHomeError(view, container, error) {
  container.empty();
  const card = container.createDiv({ cls: "oc-home-card oc-home-error" });
  const title = card.createDiv({ cls: "oc-home-card-title" });
  const icon = title.createSpan({ cls: "oc-home-card-icon" });
  setButtonIcon(icon, "triangle-alert");
  title.createSpan({ text: homeText(view, "主页加载失败", "Home Failed to Load") });
  card.createDiv({ cls: "oc-home-empty-copy", text: error instanceof Error ? error.message : String(error || "Unknown error") });
}

function renderHomeDashboard(container) {
  const currentRun = Date.now();
  this.homeRenderRun = currentRun;
  const heatmapState = currentHeatmapState(this);
  const heatmapRange = heatmapRangeFromState(heatmapState);
  container.empty();
  container.addClass("oc-home");
  this.bindHomeScrollTracking(container);
  const homeSettings = { ...(this.plugin.settings || {}), uiLanguage: getHomeLocale(this) };
  container.createDiv({ cls: "oc-home-loading", text: homeText(this, "正在读取知识库状态...", "Reading vault status...") });

  Promise.all([
    getDashboardStats(this.app, homeSettings),
    getTodayState(this.app, homeSettings),
    listProjects(this.app, homeSettings),
    Promise.resolve(listRecentFiles(this.app, homeSettings)),
    getDailyActivityHeatmap(this.app, homeSettings, heatmapRange),
  ])
    .then(([stats, today, projects, recent, heatmap]) => {
      if (this.homeRenderRun !== currentRun) return;
      container.empty();

      const hero = container.createDiv({ cls: "oc-home-hero" });
      const heroText = hero.createDiv({ cls: "oc-home-hero-text" });
      heroText.createDiv({ cls: "oc-home-eyebrow", text: "FLOWnote" });
      heroText.createDiv({ cls: "oc-home-heading", text: homeText(this, "今天从这里开始", "Start Here Today") });
      heroText.createDiv({
        cls: "oc-home-subtitle",
        text: today.exists
          ? homeText(this, "专注当下，持续创造。", "Focus now, keep creating.")
          : homeText(this, "先创建今日日记，再把记录和复盘串起来。", "Create today's note first, then connect capture and review."),
      });
      const heroPanel = hero.createDiv({ cls: "oc-home-hero-panel" });
      const datePanel = heroPanel.createDiv({ cls: "oc-home-hero-date" });
      datePanel.createSpan({ cls: "oc-home-hero-date-main", text: today.dateStr });
      const weekday = formatWeekday(today.dateStr, getHomeLocale(this));
      if (weekday) datePanel.createSpan({ cls: "oc-home-hero-date-sub", text: weekday });
      datePanel.createSpan({
        cls: `oc-home-hero-date-pill ${today.exists ? "is-ok" : "is-warn"}`,
        text: today.exists ? homeText(this, "今日日记已创建", "Today's Note Created") : homeText(this, "今日日记待创建", "Today's Note Missing"),
      });
      renderQuickActions(this, heroPanel, { inline: true });

      const statsGrid = container.createDiv({ cls: "oc-home-stats" });
      this.bindHomeScrollTracking(container, statsGrid);
      renderStatCard(statsGrid, {
        icon: today.exists ? "calendar-check" : "calendar-plus",
        value: today.exists ? homeText(this, "已创建", "Created") : homeText(this, "待创建", "Missing"),
        label: homeText(this, "今日记录", "Today's Note"),
        detail: today.dateStr,
        tone: today.exists ? "ok" : "warn",
      });
      renderStatCard(statsGrid, {
        icon: "folder-kanban",
        value: stats.activeProjects,
        label: homeText(this, "进行中项目", "Active Projects"),
        detail: homeText(this, `${stats.highPriorityProjects} 个高优先级`, `${stats.highPriorityProjects} high priority`),
        tone: "project",
      });
      renderStatCard(statsGrid, {
        icon: "sparkles",
        value: stats.weeklyNew,
        label: homeText(this, "本周新增", "New This Week"),
        detail: homeText(this, `${stats.recentActive} 篇最近活跃`, `${stats.recentActive} recently active`),
        tone: "growth",
      });
      renderStatCard(statsGrid, {
        icon: "brain",
        value: stats.knowledgeAssets,
        label: homeText(this, "知识资产", "Knowledge Assets"),
        detail: homeText(this, `${stats.evergreenNotes} 永久 · ${stats.literatureNotes} 文献`, `${stats.evergreenNotes} permanent · ${stats.literatureNotes} literature`),
        tone: "knowledge",
      });
      renderStatCard(statsGrid, {
        icon: "list-checks",
        value: `${stats.tasks.completionRate}%`,
        label: homeText(this, "任务完成率", "Task Completion"),
        detail: homeText(this, `${stats.tasks.open} 待办 · ${stats.tasks.done} 完成`, `${stats.tasks.open} open · ${stats.tasks.done} done`),
        tone: "task",
      });

      const grid = container.createDiv({ cls: "oc-home-grid" });
      const primary = grid.createDiv({ cls: "oc-home-column oc-home-column-primary" });
      const side = grid.createDiv({ cls: "oc-home-column oc-home-column-side" });

      renderTodayCard(this, primary, today);
      renderActivityHeatmap(this, primary, heatmap);

      const projectCard = primary.createDiv({ cls: "oc-home-card" });
      const projectHeader = projectCard.createDiv({ cls: "oc-home-card-header" });
      const projectTitle = projectHeader.createDiv({ cls: "oc-home-card-title" });
      const projectIcon = projectTitle.createSpan({ cls: "oc-home-card-icon" });
      setButtonIcon(projectIcon, "folder-kanban");
      projectTitle.createSpan({ text: homeText(this, "所有项目", "All Projects") });
      projectHeader.createDiv({ cls: "oc-home-pill", text: homeText(this, `${projects.length} 个项目`, `${projects.length} projects`) });
      const projectList = projectCard.createDiv({ cls: "oc-home-project-list" });
      if (projects.length) {
        projects.forEach((project) => renderProjectCard(this, projectList, project));
      } else {
        projectList.createDiv({
          cls: "oc-home-empty-copy",
          text: homeText(this, "暂无项目。可以用 /ah-project 创建一个新的项目。", "No projects yet. Use /ah-project to create one."),
        });
      }

      const recentCard = side.createDiv({ cls: "oc-home-card" });
      const recentHeader = recentCard.createDiv({ cls: "oc-home-card-header" });
      const recentTitle = recentHeader.createDiv({ cls: "oc-home-card-title" });
      const recentIcon = recentTitle.createSpan({ cls: "oc-home-card-icon" });
      setButtonIcon(recentIcon, "clock-3");
      recentTitle.createSpan({ text: homeText(this, "最近活动", "Recent Activity") });
      const recentList = recentCard.createDiv({ cls: "oc-home-recent-list" });
      if (recent.length) {
        recent.slice(0, 8).forEach((item) => renderRecentItem(this, recentList, item));
      } else {
        recentList.createDiv({ cls: "oc-home-empty-copy", text: homeText(this, "暂无最近活动。", "No recent activity yet.") });
      }
      this.restoreHomeScrollPosition(container, statsGrid);
    })
    .catch((error) => {
      if (this.homeRenderRun !== currentRun) return;
      renderHomeError(this, container, error);
      this.restoreHomeScrollPosition(container);
    });
}

const homeMethods = {
  saveHomeScrollPosition,
  bindHomeScrollTracking,
  unbindHomeScrollTracking,
  restoreHomeScrollPosition,
  renderHomeDashboard,
};

module.exports = { homeMethods };
