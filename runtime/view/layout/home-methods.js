const { Notice, setIcon } = require("obsidian");
const { getIntlLocale, normalizeSupportedLocale } = require("../../i18n-locale-utils");
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

const HOME_DATA_TIMEOUT_MS = 8000;

function formatRelativeTime(timestamp, locale = "zh-CN") {
  const value = Number(timestamp || 0);
  if (!value) return "";
  const diff = Date.now() - value;
  const normalizedLocale = normalizeSupportedLocale(locale, "en");
  if (normalizedLocale === "zh-CN") {
    if (diff < 60 * 1000) return "刚刚";
    if (diff < 60 * 60 * 1000) return `${Math.max(1, Math.floor(diff / 60000))}分钟前`;
    if (diff < 24 * 60 * 60 * 1000) return `${Math.max(1, Math.floor(diff / 3600000))}小时前`;
    if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.max(1, Math.floor(diff / 86400000))}天前`;
  } else {
    const rtf = new Intl.RelativeTimeFormat(getIntlLocale(normalizedLocale), { numeric: "auto" });
    if (diff < 60 * 1000) return rtf.format(0, "second");
    if (diff < 60 * 60 * 1000) return rtf.format(-Math.max(1, Math.floor(diff / 60000)), "minute");
    if (diff < 24 * 60 * 60 * 1000) return rtf.format(-Math.max(1, Math.floor(diff / 3600000)), "hour");
    if (diff < 7 * 24 * 60 * 60 * 1000) return rtf.format(-Math.max(1, Math.floor(diff / 86400000)), "day");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(getIntlLocale(normalizedLocale), { month: "short", day: "numeric" });
}

function formatWeekday(dateStr, locale = "zh-CN") {
  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(getIntlLocale(locale), { weekday: "short" });
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

function bindKeyboardActivation(element, callback, label = "") {
  if (!element || typeof callback !== "function") return;
  element.setAttr("role", "button");
  element.setAttr("tabindex", "0");
  if (label) element.setAttr("aria-label", label);
  element.addEventListener("click", callback);
  element.addEventListener("keydown", (event) => {
    if (event.target !== element || event.isComposing) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    callback(event);
  });
}

function homeText(view, key, fallback, params = {}) {
  return tr(view, `view.home.${key}`, fallback, params);
}

function currentDateKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function fallbackDailySummary() {
  return {
    focus: "",
    record: "",
    tasks: { open: 0, done: 0, total: 0, completionRate: 0 },
    taskItems: [],
  };
}

function fallbackTodayState() {
  return {
    dateStr: currentDateKey(),
    path: "",
    exists: false,
    file: null,
    summary: fallbackDailySummary(),
  };
}

function fallbackDashboardStats() {
  return {
    activeProjects: 0,
    highPriorityProjects: 0,
    weeklyNew: 0,
    recentActive: 0,
    knowledgeAssets: 0,
    evergreenNotes: 0,
    literatureNotes: 0,
    topicNotes: 0,
    domainNotes: 0,
    dailyNotes: 0,
    tasks: { open: 0, done: 0, total: 0, completionRate: 0 },
  };
}

function fallbackHeatmap(range = {}) {
  return {
    days: 0,
    startDate: range.startDate || "",
    endDate: range.endDate || "",
    total: 0,
    activeDays: 0,
    maxCount: 0,
    cells: [],
  };
}

function logHomeDataIssue(label, error) {
  try {
    console.warn(`[FLOWnote] Home ${label} unavailable`, error);
  } catch {}
}

function resolveHomeData(label, producer, fallback) {
  let value;
  try {
    value = producer();
  } catch (error) {
    logHomeDataIssue(label, error);
    return Promise.resolve(typeof fallback === "function" ? fallback() : fallback);
  }

  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      logHomeDataIssue(label, new Error(`Timed out after ${HOME_DATA_TIMEOUT_MS}ms`));
      resolve(typeof fallback === "function" ? fallback() : fallback);
    }, HOME_DATA_TIMEOUT_MS);
  });

  return Promise.race([
    Promise.resolve(value)
      .catch((error) => {
        logHomeDataIssue(label, error);
        return typeof fallback === "function" ? fallback() : fallback;
      }),
    timeout,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function recentTypeKey(type) {
  const text = String(type || "");
  if (text === "每日笔记") return "recentTypeDaily";
  if (text === "永久笔记") return "recentTypeEvergreen";
  if (text === "文献笔记") return "recentTypeLiterature";
  if (text === "主题页") return "recentTypeTopic";
  if (text === "领域页") return "recentTypeDomain";
  if (text === "项目") return "recentTypeProject";
  return "recentTypeNote";
}

function localizeRecentType(view, type) {
  return homeText(view, recentTypeKey(type), String(type || "笔记"));
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
    new Notice(homeText(view, "fileMissing", "文件不存在"));
    return;
  }
  const workspace = view.app && view.app.workspace;
  const leaf = workspace && typeof workspace.getLeaf === "function"
    ? workspace.getLeaf("tab")
    : workspace && typeof workspace.getRightLeaf === "function"
      ? workspace.getRightLeaf(false)
      : null;
  if (!leaf || typeof leaf.openFile !== "function") {
    new Notice(homeText(view, "openFileUnsupported", "当前设备暂不支持从首页打开文件"));
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
    new Notice(homeText(view, "homeDocumentMissing", "未找到 🏠 主页.md"));
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
  header.createDiv({ cls: "oc-home-kicker", text: homeText(view, "taskHeading", "今日待办") });
  if (taskItems.length) {
    header.createDiv({ cls: "oc-home-task-hint", text: homeText(view, "taskSyncHint", "点击同步勾选") });
  }

  const list = section.createDiv({ cls: "oc-home-task-list" });
  if (!taskItems.length) {
    list.createDiv({ cls: "oc-home-empty-copy", text: homeText(view, "taskEmpty", "今日任务区还没有可勾选的待办。") });
    return;
  }

  taskItems.forEach((task) => {
    const row = list.createEl("button", {
      cls: `oc-home-task-row ${task.done ? "is-done" : ""}`.trim(),
      attr: { type: "button" },
    });
    const taskAction = task.done ? homeText(view, "taskMarkTodo", "标记为未完成") : homeText(view, "taskMarkDone", "标记为已完成");
    row.setAttr("aria-pressed", task.done ? "true" : "false");
    row.setAttr("title", taskAction);
    const checkbox = row.createSpan({ cls: "oc-home-task-checkbox", attr: { "aria-hidden": "true" } });
    if (task.done) setButtonIcon(checkbox, "check");
    const text = row.createSpan({ cls: "oc-home-task-text" });
    renderInlineTaskText(text, task.text);
    row.addEventListener("click", () => {
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
  title.createSpan({ text: homeText(view, "todayTitle", "今日") });
  header.createDiv({
    cls: `oc-home-pill ${today.exists ? "is-ok" : "is-warn"}`,
    text: today.exists ? homeText(view, "statusCreated", "已创建") : homeText(view, "statusPending", "待创建"),
  });

  card.createDiv({ cls: "oc-home-date", text: today.dateStr });

  if (!today.exists) {
    card.createDiv({
      cls: "oc-home-empty-copy",
      text: homeText(view, "todayMissingCopy", "今天的日记还没创建。先把今日聚焦立起来，后面的记录和复盘才有承接点。"),
    });
    const actions = card.createDiv({ cls: "oc-home-card-actions" });
    createActionButton(actions, "plus", homeText(view, "createDaily", "创建今日日记"), () => createAndOpenToday(view), "is-primary");
    createActionButton(actions, "message-square", homeText(view, "planTodayWithFlow", "和 FLOWnote 规划今天"), () => prefillHomePrompt(view, "/ah-note "), "");
    return;
  }

  const summary = today.summary || {};
  const focusText = summary.focus || homeText(view, "focusEmpty", "还没有写下今日聚焦");
  const tasks = summary.tasks || { open: 0, done: 0, total: 0, completionRate: 0 };
  const taskItems = Array.isArray(summary.taskItems) ? summary.taskItems : [];
  const completionRate = Math.max(0, Math.min(100, Number(tasks.completionRate || 0)));
  card.toggleClass("has-tasks", taskItems.length > 0);

  const focus = card.createDiv({ cls: "oc-home-focus" });
  focus.createDiv({ cls: "oc-home-kicker", text: homeText(view, "focusTitle", "今日聚焦") });
  focus.createDiv({ cls: "oc-home-focus-text", text: focusText });

  if (taskItems.length > 0) {
    const progress = card.createDiv({ cls: "oc-home-today-progress" });
    progress.setAttr("aria-label", homeText(view, "todayProgressAria", "今日待办完成率 {rate}%", { rate: completionRate }));
    const progressTrack = progress.createDiv({ cls: "oc-home-today-progress-track" });
    const progressFill = progressTrack.createDiv({ cls: "oc-home-today-progress-fill" });
    progressFill.style.width = `${completionRate}%`;
    progress.createDiv({ cls: "oc-home-today-progress-value", text: `${completionRate}%` });
    renderTodayTasks(view, card, today, taskItems);
  } else {
    card.createDiv({
      cls: "oc-home-task-empty-inline",
      text: homeText(view, "taskEmpty", "今天还没有待办。"),
    });
  }

  const actions = card.createDiv({ cls: "oc-home-card-actions" });
  createActionButton(actions, "file-text", homeText(view, "openDaily", "打开日记"), () => openVaultFile(view, today.file), "is-primary");
  createActionButton(actions, "message-square", homeText(view, "pushToday", "推进今天"), () => prefillHomePrompt(
    view,
    homeText(view, "pushTodayPrompt", "基于今日日记，帮我梳理今天下一步最应该推进什么，并给出一个简洁的行动清单。"),
    { linkedFiles: [today.file] },
  ), "");
  createActionButton(actions, "pen-line", homeText(view, "continueCapture", "继续记录"), () => prefillHomePrompt(view, `/ah-capture `), "");
}

function renderProjectCard(view, parent, project) {
  const item = parent.createDiv({
    cls: `oc-home-project ${/高|high/i.test(String(project.priority || "")) ? "is-high-priority" : ""}`.trim(),
  });
  item.style.setProperty("--home-project-accent", projectAccent(project));
  const projectMain = item.createDiv({ cls: "oc-home-project-main" });
  const title = projectMain.createDiv({ cls: "oc-home-project-title", text: project.title || homeText(view, "unnamedProject", "未命名项目") });
  title.setAttr("title", project.title || "");
  const tags = projectMain.createDiv({ cls: "oc-home-project-tags" });
  const tagValues = [project.domain, project.category].map((tag) => String(tag || "").trim()).filter(Boolean);
  [...new Set(tagValues)].slice(0, 2).forEach((tag) => tags.createSpan({ cls: "oc-home-project-tag", text: tag }));
  tags.createDiv({ cls: `oc-home-project-status ${project.isActive ? "is-active" : ""}`.trim(), text: project.status || homeText(view, "defaultProjectStatus", "进行中") });
  if (project.priority) tags.createDiv({ cls: `oc-home-pill ${/高|high/i.test(project.priority) ? "is-hot" : ""}`, text: project.priority });
  const chatBtn = item.createEl("button", { cls: "oc-home-project-chat" });
  chatBtn.setAttr("type", "button");
  chatBtn.setAttr("aria-label", homeText(view, "chatProject", "聊这个项目"));
  chatBtn.setAttr("title", homeText(view, "chatProject", "聊这个项目"));
  setButtonIcon(chatBtn, "message-square");
  chatBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    prefillHomePrompt(
      view,
      homeText(view, "chatProjectPrompt", "基于「{title}」项目总览，帮我判断当前最应该推进的下一步，并给出 3 条具体行动建议。", {
        title: project.title || homeText(view, "thisProject", "这个项目"),
      }),
      { linkedFiles: [project.file] },
    );
  });
  const bar = projectMain.createDiv({ cls: "oc-home-progress" });
  const completionRate = Math.max(0, Math.min(100, project.tasks.completionRate || 0));
  const fill = bar.createDiv({ cls: "oc-home-progress-fill" });
  fill.style.width = `${completionRate}%`;
  bar.createSpan({ cls: "oc-home-progress-label", text: `${completionRate}%` });
  const progressMeta = projectMain.createDiv({ cls: "oc-home-project-progress-meta" });
  progressMeta.createSpan({ text: homeText(view, "projectProgressMeta", "待办 {open} · 完成 {done}", {
    open: project.tasks.open,
    done: project.tasks.done,
  }) });
  if (project.dueDate) progressMeta.createSpan({ text: project.dueDate });
  bindKeyboardActivation(
    projectMain,
    () => openVaultFile(view, project.file),
    project.title || homeText(view, "unnamedProject", "未命名项目"),
  );
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

function heatmapLabel(view, state) {
  return homeText(view, "heatmapYear", "{year}年", { year: state.year });
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
  title.createSpan({ text: homeText(view, "heatmapTitle", "记录热力图") });
  const actions = header.createDiv({ cls: "oc-home-heatmap-actions" });
  const period = actions.createDiv({ cls: "oc-home-heatmap-period" });
  const prev = period.createEl("button", { cls: "oc-home-heatmap-nav" });
  prev.setAttr("type", "button");
  prev.setAttr("aria-label", homeText(view, "previousYear", "上一年"));
  setButtonIcon(prev, "chevron-left", "<");
  prev.addEventListener("click", () => shiftHeatmapPeriod(view, -1));
  period.createSpan({ cls: "oc-home-heatmap-label", text: heatmapLabel(view, state) });
  const next = period.createEl("button", { cls: "oc-home-heatmap-nav" });
  next.setAttr("type", "button");
  next.setAttr("aria-label", homeText(view, "nextYear", "下一年"));
  setButtonIcon(next, "chevron-right", ">");
  next.addEventListener("click", () => shiftHeatmapPeriod(view, 1));
  actions.createDiv({ cls: "oc-home-pill", text: homeText(view, "recordCount", "{count} 条记录", { count: heatmap.total }) });

  const graph = card.createDiv({ cls: "oc-home-heatmap-wrap" });
  const grid = graph.createDiv({ cls: `oc-home-heatmap-grid is-${state.mode}` });
  const maxCount = Number(heatmap.maxCount || 0);
  (Array.isArray(heatmap.cells) ? heatmap.cells : []).forEach((cell) => {
    const level = heatmapLevel(cell, maxCount);
    const cellLabel = homeText(view, "heatmapCell", "{date} · {count} 条记录", { date: cell.date, count: cell.count || 0 });
    const cellClass = `oc-home-heatmap-cell is-level-${level}`;
    if (cell.file) {
      const square = grid.createEl("button", {
        cls: `${cellClass} is-clickable`,
        attr: {
          type: "button",
          title: cellLabel,
          "aria-label": cellLabel,
        },
      });
      square.addEventListener("click", () => openVaultFile(view, cell.file));
      return;
    }
    grid.createSpan({
      cls: cellClass,
      attr: { title: cellLabel, "aria-hidden": "true" },
    });
  });
  const footer = card.createDiv({ cls: "oc-home-heatmap-footer" });
  footer.createSpan({ text: homeText(view, "heatmapFooter", "{activeDays} 天有记录 · {startDate} 至 {endDate}", {
    activeDays: heatmap.activeDays,
    startDate: heatmap.startDate,
    endDate: heatmap.endDate,
  }) });
  const legend = footer.createSpan({ cls: "oc-home-heatmap-legend" });
  legend.createSpan({ text: homeText(view, "heatmapLow", "少") });
  for (let i = 0; i <= 4; i += 1) {
    legend.createSpan({ cls: `oc-home-heatmap-cell is-level-${i}` });
  }
  legend.createSpan({ text: homeText(view, "heatmapHigh", "多") });
}

function renderRecentItem(view, parent, item) {
  const locale = view && view.plugin && typeof view.plugin.getEffectiveLocale === "function"
    ? view.plugin.getEffectiveLocale()
    : "zh-CN";
  const row = parent.createDiv({ cls: "oc-home-recent-item" });
  const icon = row.createDiv({ cls: "oc-home-recent-icon" });
  const typeIcon = /项目|Project/i.test(item.type) ? "folder-kanban" : /永久笔记|Permanent/i.test(item.type) ? "badge-check" : "file-text";
  setButtonIcon(icon, typeIcon);
  const body = row.createDiv({ cls: "oc-home-recent-body" });
  body.createDiv({ cls: "oc-home-recent-title", text: item.title || item.path });
  body.createDiv({ cls: "oc-home-recent-meta", text: homeText(view, "recentMeta", "{type} · {time}", {
    type: localizeRecentType(view, item.type),
    time: formatRelativeTime(item.mtime, locale),
  }) });
  bindKeyboardActivation(row, () => openVaultFile(view, item.file), item.title || item.path);
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
    title.createSpan({ text: homeText(view, "quickActions", "快捷动作") });
  }

  const grid = host.createDiv({ cls: `oc-home-action-grid ${isInline ? "oc-home-action-grid-hero" : ""}`.trim() });
  createActionButton(grid, "home", homeText(view, "openHome", "打开主页文档"), () => openHomeDocument(view), "is-soft is-icon-only");
  createActionButton(grid, "sun", homeText(view, "planToday", "规划今天"), () => runHomePrompt(view, "/ah-note"), "is-soft");
  createActionButton(grid, "inbox", homeText(view, "quickCapture", "快速捕获"), () => prefillHomePrompt(view, "/ah-capture "), "is-soft");
  createActionButton(grid, "check-circle-2", homeText(view, "dailyReview", "每日回顾"), () => runHomePrompt(view, "/ah-review"), "is-soft");
  createActionButton(grid, "folder-plus", homeText(view, "newProject", "新建项目"), () => prefillHomePrompt(view, "/ah-project "), "is-soft");
}

function renderHomeError(view, container, error) {
  container.empty();
  const card = container.createDiv({ cls: "oc-home-card oc-home-error" });
  const title = card.createDiv({ cls: "oc-home-card-title" });
  const icon = title.createSpan({ cls: "oc-home-card-icon" });
  setButtonIcon(icon, "triangle-alert");
  title.createSpan({ text: homeText(view, "loadFailed", "主页加载失败") });
  card.createDiv({ cls: "oc-home-empty-copy", text: error instanceof Error ? error.message : String(error || "Unknown error") });
}

function renderHomeDashboard(container) {
  const currentRun = Date.now();
  const locale = this.plugin && typeof this.plugin.getEffectiveLocale === "function"
    ? this.plugin.getEffectiveLocale()
    : "zh-CN";
  this.homeRenderRun = currentRun;
  const homeSettings = { ...(this.plugin.settings || {}), uiLanguage: locale };
  const heatmapState = currentHeatmapState(this);
  const heatmapRange = heatmapRangeFromState(heatmapState);
  container.empty();
  container.addClass("oc-home");
  this.bindHomeScrollTracking(container);
  container.createDiv({ cls: "oc-home-loading", text: homeText(this, "loading", "正在读取知识库状态...") });

  Promise.all([
    resolveHomeData("dashboard stats", () => getDashboardStats(this.app, homeSettings), fallbackDashboardStats),
    resolveHomeData("today state", () => getTodayState(this.app, homeSettings), fallbackTodayState),
    resolveHomeData("projects", () => listProjects(this.app, homeSettings), []),
    resolveHomeData("recent files", () => listRecentFiles(this.app, homeSettings), []),
    resolveHomeData("activity heatmap", () => getDailyActivityHeatmap(this.app, homeSettings, heatmapRange), () => fallbackHeatmap(heatmapRange)),
  ])
    .then(([stats, today, projects, recent, heatmap]) => {
      if (this.homeRenderRun !== currentRun) return;
      container.empty();

      const hero = container.createDiv({ cls: "oc-home-hero" });
      const heroText = hero.createDiv({ cls: "oc-home-hero-text" });
      heroText.createDiv({ cls: "oc-home-eyebrow", text: "FLOWnote" });
      heroText.createDiv({ cls: "oc-home-heading", text: homeText(this, "heroHeading", "今天从这里开始") });
      heroText.createDiv({
        cls: "oc-home-subtitle",
        text: today.exists ? homeText(this, "heroSubtitleExists", "专注当下，持续创造。") : homeText(this, "heroSubtitleMissing", "先创建今日日记，再把记录和复盘串起来。"),
      });
      const heroPanel = hero.createDiv({ cls: "oc-home-hero-panel" });
      const datePanel = heroPanel.createDiv({ cls: "oc-home-hero-date" });
      datePanel.createSpan({ cls: "oc-home-hero-date-main", text: today.dateStr });
      const weekday = formatWeekday(today.dateStr, locale);
      if (weekday) datePanel.createSpan({ cls: "oc-home-hero-date-sub", text: weekday });
      datePanel.createSpan({ cls: `oc-home-hero-date-pill ${today.exists ? "is-ok" : "is-warn"}`, text: today.exists ? homeText(this, "dailyCreatedPill", "今日日记已创建") : homeText(this, "dailyPendingPill", "今日日记待创建") });
      renderQuickActions(this, heroPanel, { inline: true });

      const statsGrid = container.createDiv({ cls: "oc-home-stats" });
      this.bindHomeScrollTracking(container, statsGrid);
      renderStatCard(statsGrid, {
        icon: today.exists ? "calendar-check" : "calendar-plus",
        value: today.exists ? homeText(this, "statusCreated", "已创建") : homeText(this, "statusPending", "待创建"),
        label: homeText(this, "statTodayLabel", "今日记录"),
        detail: today.dateStr,
        tone: today.exists ? "ok" : "warn",
      });
      renderStatCard(statsGrid, {
        icon: "folder-kanban",
        value: stats.activeProjects,
        label: homeText(this, "statActiveProjects", "进行中项目"),
        detail: homeText(this, "statHighPriorityDetail", "{count} 个高优先级", { count: stats.highPriorityProjects }),
        tone: "project",
      });
      renderStatCard(statsGrid, {
        icon: "sparkles",
        value: stats.weeklyNew,
        label: homeText(this, "statWeeklyNew", "本周新增"),
        detail: homeText(this, "statRecentActiveDetail", "{count} 篇最近活跃", { count: stats.recentActive }),
        tone: "growth",
      });
      renderStatCard(statsGrid, {
        icon: "brain",
        value: stats.knowledgeAssets,
        label: homeText(this, "statKnowledgeAssets", "知识资产"),
        detail: homeText(this, "statKnowledgeDetail", "{evergreen} 永久 · {literature} 文献", {
          evergreen: stats.evergreenNotes,
          literature: stats.literatureNotes,
        }),
        tone: "knowledge",
      });
      renderStatCard(statsGrid, {
        icon: "list-checks",
        value: `${stats.tasks.completionRate}%`,
        label: homeText(this, "statTaskCompletion", "任务完成率"),
        detail: homeText(this, "statTaskDetail", "{open} 待办 · {done} 完成", {
          open: stats.tasks.open,
          done: stats.tasks.done,
        }),
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
      projectTitle.createSpan({ text: homeText(this, "projectsTitle", "所有项目") });
      projectHeader.createDiv({ cls: "oc-home-pill", text: homeText(this, "projectCount", "{count} 个项目", { count: projects.length }) });
      const projectList = projectCard.createDiv({ cls: "oc-home-project-list" });
      if (projects.length) {
        projects.forEach((project) => renderProjectCard(this, projectList, project));
      } else {
        projectList.createDiv({ cls: "oc-home-empty-copy", text: homeText(this, "projectsEmpty", "暂无项目。可以用 /ah-project 创建一个新的项目。") });
      }

      const recentCard = side.createDiv({ cls: "oc-home-card" });
      const recentHeader = recentCard.createDiv({ cls: "oc-home-card-header" });
      const recentTitle = recentHeader.createDiv({ cls: "oc-home-card-title" });
      const recentIcon = recentTitle.createSpan({ cls: "oc-home-card-icon" });
      setButtonIcon(recentIcon, "clock-3");
      recentTitle.createSpan({ text: homeText(this, "recentTitle", "最近活动") });
      const recentList = recentCard.createDiv({ cls: "oc-home-recent-list" });
      if (recent.length) {
        recent.slice(0, 8).forEach((item) => renderRecentItem(this, recentList, item));
      } else {
        recentList.createDiv({ cls: "oc-home-empty-copy", text: homeText(this, "recentEmpty", "暂无最近活动。") });
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
