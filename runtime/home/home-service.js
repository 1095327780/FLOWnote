const { normalizePath } = require("obsidian");
const {
  findOrCreateDailyNote,
  formatDateStr,
} = require("../mobile/daily-note-service");
const {
  NOTE_PATH_DEFAULTS_BY_LOCALE,
  getDefaultDailyNotePath,
  getDefaultNotePaths,
} = require("../localized-defaults");

const DEFAULT_HOME_SETTINGS = {
  projectPath: "04-创造层/项目",
  recentLimit: 8,
  weeklyWindowDays: 7,
  heatmapDays: 84,
};
const DAILY_TASK_HEADING_PATTERNS = [/任务/, /Tasks/i, /Задачи/i, /План/i];

function configuredNotePaths(settings = {}) {
  const locale = settings && settings.uiLanguage ? settings.uiLanguage : "zh-CN";
  return { ...getDefaultNotePaths(locale), ...((settings && settings.notePaths) || {}) };
}

function notePathPrefixes(settings = {}, key) {
  const paths = configuredNotePaths(settings);
  const values = [paths[key]];
  for (const defaults of Object.values(NOTE_PATH_DEFAULTS_BY_LOCALE)) {
    if (defaults && defaults[key]) values.push(defaults[key]);
  }
  return [...new Set(values.map((value) => normalizePath(String(value || "").trim())).filter(Boolean))];
}

function pathUnderAnyPrefix(path, prefixes) {
  const value = normalizePath(String(path || ""));
  return prefixes.some((prefix) => value === prefix || value.startsWith(`${prefix}/`));
}

function normalizeHomeSettings(settings = {}) {
  const raw = settings && typeof settings === "object" ? settings : {};
  const home = raw.home && typeof raw.home === "object" ? raw.home : {};
  const paths = configuredNotePaths(raw);
  return {
    projectPath: normalizePath(String(home.projectPath || paths.activeProjects || DEFAULT_HOME_SETTINGS.projectPath).trim() || DEFAULT_HOME_SETTINGS.projectPath),
    recentLimit: Math.min(24, Math.max(3, Number(home.recentLimit) || DEFAULT_HOME_SETTINGS.recentLimit)),
    weeklyWindowDays: Math.min(31, Math.max(1, Number(home.weeklyWindowDays) || DEFAULT_HOME_SETTINGS.weeklyWindowDays)),
    heatmapDays: Math.min(366, Math.max(28, Number(home.heatmapDays) || DEFAULT_HOME_SETTINGS.heatmapDays)),
  };
}

function resolveDailyNotePath(settings = {}, dateStr = formatDateStr()) {
  const mc = settings && settings.mobileCapture && typeof settings.mobileCapture === "object"
    ? settings.mobileCapture
    : {};
  const dailyNotePath = normalizePath(String(mc.dailyNotePath || getDefaultDailyNotePath(settings.uiLanguage || "zh-CN")).trim() || getDefaultDailyNotePath(settings.uiLanguage || "zh-CN"));
  return normalizePath(`${dailyNotePath}/${dateStr}.md`);
}

function safeFiles(app) {
  const vault = app && app.vault;
  if (!vault || typeof vault.getMarkdownFiles !== "function") return [];
  return vault.getMarkdownFiles().filter(Boolean);
}

async function readFileText(app, file) {
  if (!app || !app.vault || !file) return "";
  try {
    if (typeof app.vault.cachedRead === "function") return String(await app.vault.cachedRead(file) || "");
    if (typeof app.vault.read === "function") return String(await app.vault.read(file) || "");
  } catch {
    return "";
  }
  return "";
}

function getFrontmatterFromCache(app, file) {
  try {
    const cache = app && app.metadataCache && typeof app.metadataCache.getFileCache === "function"
      ? app.metadataCache.getFileCache(file)
      : null;
    return cache && cache.frontmatter && typeof cache.frontmatter === "object" ? cache.frontmatter : {};
  } catch {
    return {};
  }
}

function parseFrontmatter(content) {
  const text = String(content || "");
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const out = {};
  match[1].split(/\r?\n/).forEach((line) => {
    const item = String(line || "").trim();
    if (!item || item.startsWith("#")) return;
    const colon = item.indexOf(":");
    if (colon <= 0) return;
    const key = item.slice(0, colon).trim();
    let value = item.slice(colon + 1).trim();
    if (!key) return;
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value.slice(1, -1).split(",").map((part) => part.trim()).filter(Boolean);
    }
    out[key] = value;
  });
  return out;
}

function frontmatterValue(frontmatter, keys, fallback = "") {
  const fm = frontmatter && typeof frontmatter === "object" ? frontmatter : {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(fm, key)) {
      const value = fm[key];
      if (Array.isArray(value)) return value.join(", ");
      const text = String(value ?? "").trim();
      if (text) return text;
    }
  }
  return fallback;
}

function displayNameFromPath(pathValue) {
  const path = String(pathValue || "");
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

function uniqueNormalizedPaths(paths) {
  const seen = new Set();
  const out = [];
  for (const raw of paths) {
    const path = normalizePath(String(raw || "").trim()).replace(/\/+$/, "");
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

function titleFromContentOrFile(content, file) {
  const heading = String(content || "").match(/^#\s+(.+)$/m);
  if (heading && heading[1]) return heading[1].replace(/^📍\s*/, "").trim();
  const parent = String(file && file.parent && file.parent.path ? file.parent.path : "")
    .split("/")
    .filter(Boolean)
    .pop();
  if (parent) return parent.replace(/^📍\s*/, "").trim();
  return String(file && file.basename ? file.basename : displayNameFromPath(file && file.path)).replace(/\.md$/i, "");
}

function taskStatsFromContent(content) {
  const lines = String(content || "").split(/\r?\n/);
  let open = 0;
  let done = 0;
  lines.forEach((line) => {
    if (/^\s*[-*]\s+\[[ xX]\]\s+/.test(line)) {
      if (/^\s*[-*]\s+\[[xX]\]\s+/.test(line)) done += 1;
      else open += 1;
    }
  });
  return {
    open,
    done,
    total: open + done,
    completionRate: open + done > 0 ? Math.round((done / (open + done)) * 100) : 0,
  };
}

function extractSectionLineRange(content, headingPatterns) {
  const text = String(content || "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const patterns = (Array.isArray(headingPatterns) ? headingPatterns : [headingPatterns])
    .map((item) => item instanceof RegExp ? item : new RegExp(String(item || ""), "i"));

  let start = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!match) continue;
    const title = String(match[2] || "").trim();
    if (patterns.some((pattern) => pattern.test(title))) {
      start = i + 1;
      startLevel = match[1].length;
      break;
    }
  }
  if (start < 0) return null;

  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    const match = lines[i].match(/^(#{1,6})\s+/);
    if (match && match[1].length <= startLevel) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function extractSection(content, headingPatterns) {
  const text = String(content || "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const range = extractSectionLineRange(text, headingPatterns);
  if (!range) return "";

  const out = [];
  for (let i = range.start; i < range.end; i += 1) {
    out.push(lines[i]);
  }
  return out.join("\n").trim();
}

function parseTaskLine(line, lineIndex) {
  const match = String(line || "").match(/^(\s*[-*]\s+\[)([ xX])(\]\s+)(.+)$/);
  if (!match) return null;
  const text = String(match[4] || "")
    .replace(/\s+\^[A-Za-z0-9_-]+\s*$/, "")
    .replace(/(^|\s)✅(?=\s|$)/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!text) return null;
  const done = /x/i.test(match[2]);
  return {
    id: `task-${lineIndex}-${done ? "done" : "open"}-${text.slice(0, 48)}`,
    lineIndex,
    lineNumber: lineIndex + 1,
    text,
    done,
  };
}

function listTaskItemsFromContent(content, options = {}) {
  const limit = Math.min(20, Math.max(1, Number(options.limit) || 8));
  const text = String(content || "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const range = extractSectionLineRange(text, options.headingPatterns || DAILY_TASK_HEADING_PATTERNS);
  const start = range ? range.start : 0;
  const end = range ? range.end : lines.length;
  const tasks = [];

  for (let i = start; i < end; i += 1) {
    const task = parseTaskLine(lines[i], i);
    if (task) tasks.push(task);
    if (tasks.length >= limit) break;
  }
  return tasks;
}

function toggleTaskLineInContent(content, lineIndex) {
  const text = String(content || "");
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const index = Number(lineIndex);
  if (!Number.isInteger(index) || index < 0 || index >= lines.length) {
    return { changed: false, content: text, task: null };
  }

  const original = lines[index];
  const match = String(original || "").match(/^(\s*[-*]\s+\[)([ xX])(\]\s+.+)$/);
  if (!match) return { changed: false, content: text, task: null };

  const nextMark = /x/i.test(match[2]) ? " " : "x";
  lines[index] = `${match[1]}${nextMark}${match[3]}`;
  const nextContent = lines.join(newline);
  return {
    changed: nextContent !== text,
    content: nextContent,
    task: parseTaskLine(lines[index], index),
  };
}

async function toggleTaskInFile(app, file, lineIndex) {
  if (!app || !app.vault || !file) throw new Error("无法更新任务：文件不存在");
  if (typeof app.vault.modify !== "function") throw new Error("无法更新任务：当前 vault 不支持写入");
  const content = await readFileText(app, file);
  const result = toggleTaskLineInContent(content, lineIndex);
  if (!result.changed) throw new Error("无法更新任务：任务行已变化，请刷新后重试");
  await app.vault.modify(file, result.content);
  return result.task;
}

function firstUsefulLine(section) {
  const lines = String(section || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s+\[[ xX]\]\s*/, "").replace(/^\s*[-*]\s*/, "").trim())
    .filter((line) => line && !/^写/.test(line) && !/^待/.test(line) && !/^TODO$/i.test(line));
  return lines[0] || "";
}

function summarizeDailyNote(content) {
  const text = String(content || "");
  const focus = firstUsefulLine(extractSection(text, [/今天最重要/, /今日聚焦/, /Most Important/i, /Фокус/i, /Главное сегодня/i]));
  const record = firstUsefulLine(extractSection(text, [/记录/, /Records/i, /Today Notes/i, /Записи/i, /Ежедневные заметки/i]));
  const tasks = taskStatsFromContent(extractSection(text, DAILY_TASK_HEADING_PATTERNS) || text);
  const taskItems = listTaskItemsFromContent(text, { headingPatterns: DAILY_TASK_HEADING_PATTERNS, limit: 8 });
  return {
    focus,
    record,
    tasks,
    taskItems,
  };
}

async function getTodayState(app, settings = {}, options = {}) {
  const dateStr = String(options.dateStr || formatDateStr());
  const path = resolveDailyNotePath(settings, dateStr);
  const file = app && app.vault && typeof app.vault.getAbstractFileByPath === "function"
    ? app.vault.getAbstractFileByPath(path)
    : null;
  if (!file) {
    return {
      dateStr,
      path,
      exists: false,
      file: null,
      summary: summarizeDailyNote(""),
    };
  }
  const content = await readFileText(app, file);
  return {
    dateStr,
    path,
    exists: true,
    file,
    summary: summarizeDailyNote(content),
  };
}

async function findOrCreateTodayDailyNote(app, settings = {}, options = {}) {
  const dateStr = String(options.dateStr || formatDateStr());
  const mc = settings && settings.mobileCapture && typeof settings.mobileCapture === "object"
    ? settings.mobileCapture
    : {};
  const dailyNotePath = String(mc.dailyNotePath || getDefaultDailyNotePath(settings.uiLanguage || "zh-CN")).trim() || getDefaultDailyNotePath(settings.uiLanguage || "zh-CN");
  return findOrCreateDailyNote(app.vault, dailyNotePath, dateStr, {
    locale: options.locale || settings.uiLanguage || "zh-CN",
    skillsDir: settings.skillsDir || ".flownote/skills",
  });
}

function resolveProjectRoots(settings = {}) {
  const homeSettings = normalizeHomeSettings(settings);
  return uniqueNormalizedPaths([
    homeSettings.projectPath,
    ...notePathPrefixes(settings, "activeProjects"),
  ]);
}

function projectRootForPath(path, roots) {
  const value = String(path || "");
  return roots.find((root) => value.startsWith(`${root}/`)) || "";
}

function projectCategoryFromPath(path, root) {
  const relative = String(path || "").slice(String(root || "").length).replace(/^\/+/, "");
  const parts = relative.split("/").filter(Boolean);
  if (parts.length <= 2) return "";
  return parts[0].replace(/^\d{2}-/, "").trim();
}

function normalizeProjectStatus(status) {
  const text = String(status || "").trim();
  if (/已完成|完成|done|completed|выполн|готов/i.test(text)) return "已完成";
  if (/归档|archived|архив/i.test(text)) return "归档";
  if (/暂停|搁置|paused|hold|пауза|приостанов/i.test(text)) return "暂停";
  if (/进行中|active|in[- ]?progress|doing|актив|в работе|в процессе/i.test(text)) return "进行中";
  return text || "进行中";
}

function isActiveProjectStatus(status) {
  return /进行中|active|in[- ]?progress|doing|актив|в работе|в процессе/i.test(status) &&
    !/已完成|完成|归档|done|completed|archived|выполн|готов|архив/i.test(status);
}

async function listProjects(app, settings = {}, options = {}) {
  const roots = resolveProjectRoots(settings);
  const projectFiles = safeFiles(app)
    .filter((file) => {
      const path = String(file.path || "");
      return projectRootForPath(path, roots) && /(^|\/)📍 项目总览\.md$/.test(path);
    });

  const projects = [];
  for (const file of projectFiles) {
    const root = projectRootForPath(file.path, roots);
    const content = await readFileText(app, file);
    const fm = {
      ...parseFrontmatter(content),
      ...getFrontmatterFromCache(app, file),
    };
    const statusFromBody = (content.match(/🏷️\s*状态[：:]\s*([^\n]+)/) || [])[1] || "";
    const status = normalizeProjectStatus(frontmatterValue(fm, ["状态", "status"], statusFromBody || "进行中"));
    const isActive = isActiveProjectStatus(status);
    if (options && options.activeOnly && !isActive) continue;
    const tasks = taskStatsFromContent(content);
    const category = projectCategoryFromPath(file.path, root);
    projects.push({
      file,
      path: file.path,
      title: titleFromContentOrFile(content, file),
      status,
      isActive,
      priority: frontmatterValue(fm, ["优先级", "priority"], ""),
      dueDate: frontmatterValue(fm, ["截止日期", "due", "计划完成"], ""),
      domain: frontmatterValue(fm, ["所属领域", "domain"], category),
      category,
      tasks,
      mtime: Number(file.stat && file.stat.mtime ? file.stat.mtime : 0),
    });
  }

  projects.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    const priorityRank = (value) => /高|high/i.test(String(value || "")) ? 0 : /中|medium/i.test(String(value || "")) ? 1 : 2;
    const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
    if (byPriority !== 0) return byPriority;
    return b.mtime - a.mtime;
  });
  return projects;
}

async function listActiveProjects(app, settings = {}) {
  return listProjects(app, settings, { activeOnly: true });
}

function dateKeyFromDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateKey(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

function addDateDays(date, days) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + Number(days || 0));
  return next;
}

function daysBetweenInclusive(startDate, endDate) {
  const start = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const end = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
}

function countDailyCaptures(content) {
  const recordSection = extractSection(content, [/记录/, /Records/i, /Today Notes/i]);
  const source = recordSection || String(content || "");
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (/^---$/.test(line)) return false;
      if (/^#{1,6}\s+/.test(line)) return false;
      if (/^\s*[-*]\s+\[[ xX]\]\s+/.test(line)) return false;
      if (/^(created|updated|tags|状态|优先级|所属领域)\s*[:：]/i.test(line)) return false;
      return true;
    });
  return lines.length;
}

async function getDailyActivityHeatmap(app, settings = {}, options = {}) {
  const homeSettings = normalizeHomeSettings(settings);
  const now = options.now ? new Date(Number(options.now)) : new Date();
  let endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let startDate = addDateDays(endDate, -(Math.min(366, Math.max(28, Number(options.days || homeSettings.heatmapDays))) - 1));
  const explicitStart = parseDateKey(options.startDate);
  const explicitEnd = parseDateKey(options.endDate);
  if (explicitStart && explicitEnd) {
    startDate = explicitStart <= explicitEnd ? explicitStart : explicitEnd;
    endDate = explicitStart <= explicitEnd ? explicitEnd : explicitStart;
  }
  let days = daysBetweenInclusive(startDate, endDate);
  if (days > 366) {
    startDate = addDateDays(endDate, -365);
    days = 366;
  }
  const dailyRoot = resolveDailyNotePath(settings, "2099-01-01").replace(/\/2099-01-01\.md$/, "");
  const byDate = new Map();
  const files = safeFiles(app).filter((file) => {
    const path = String(file.path || "");
    return path.startsWith(`${dailyRoot}/`) && /(^|\/)\d{4}-\d{2}-\d{2}\.md$/.test(path);
  });

  for (const file of files) {
    const match = String(file.basename || file.path || "").match(/(\d{4}-\d{2}-\d{2})/);
    if (!match) continue;
    const count = countDailyCaptures(await readFileText(app, file));
    byDate.set(match[1], {
      date: match[1],
      count,
      file,
      path: file.path,
    });
  }

  const cells = [];
  let total = 0;
  let activeDays = 0;
  let maxCount = 0;
  for (let i = 0; i < days; i += 1) {
    const date = new Date(startDate);
    date.setDate(startDate.getDate() + i);
    const key = dateKeyFromDate(date);
    const entry = byDate.get(key) || { date: key, count: 0, file: null, path: "" };
    const count = Number(entry.count || 0);
    total += count;
    if (count > 0) activeDays += 1;
    maxCount = Math.max(maxCount, count);
    cells.push({
      date: key,
      count,
      file: entry.file || null,
      path: entry.path || resolveDailyNotePath(settings, key),
      weekday: date.getDay(),
      month: date.getMonth() + 1,
      day: date.getDate(),
    });
  }

  return {
    days,
    startDate: dateKeyFromDate(startDate),
    endDate: dateKeyFromDate(endDate),
    total,
    activeDays,
    maxCount,
    cells,
  };
}

function isSystemPath(path) {
  return /(^|\/)(\.git|\.obsidian|\.opencode|node_modules|release|runtime\/vendor)(\/|$)/.test(String(path || ""));
}

function classifyFile(path, settings = {}) {
  const value = String(path || "");
  if (pathUnderAnyPrefix(value, notePathPrefixes(settings, "dailyNotes"))) return "每日笔记";
  if (pathUnderAnyPrefix(value, notePathPrefixes(settings, "permanentNotes"))) return "永久笔记";
  if (pathUnderAnyPrefix(value, notePathPrefixes(settings, "literatureNotes"))) return "文献笔记";
  if (pathUnderAnyPrefix(value, notePathPrefixes(settings, "topicNotes"))) return "主题页";
  if (pathUnderAnyPrefix(value, notePathPrefixes(settings, "domainPages"))) return "领域页";
  if (pathUnderAnyPrefix(value, notePathPrefixes(settings, "activeProjects"))) return "项目";
  return "笔记";
}

function listRecentFiles(app, settings = {}) {
  const homeSettings = normalizeHomeSettings(settings);
  return safeFiles(app)
    .filter((file) => !isSystemPath(file.path))
    .sort((a, b) => Number(b.stat && b.stat.mtime ? b.stat.mtime : 0) - Number(a.stat && a.stat.mtime ? a.stat.mtime : 0))
    .slice(0, homeSettings.recentLimit)
    .map((file) => ({
      file,
      path: file.path,
      title: String(file.basename || displayNameFromPath(file.path)).replace(/\.md$/i, ""),
      type: classifyFile(file.path, settings),
      mtime: Number(file.stat && file.stat.mtime ? file.stat.mtime : 0),
    }));
}

async function getDashboardStats(app, settings = {}, options = {}) {
  const homeSettings = normalizeHomeSettings(settings);
  const files = safeFiles(app).filter((file) => !isSystemPath(file.path));
  const now = Number(options.now || Date.now());
  const since = now - homeSettings.weeklyWindowDays * 24 * 60 * 60 * 1000;
  const todayState = await getTodayState(app, settings, options);
  const activeProjects = await listActiveProjects(app, settings);

  const counts = {
    dailyNotes: 0,
    evergreenNotes: 0,
    literatureNotes: 0,
    topicNotes: 0,
    domainNotes: 0,
    weeklyNew: 0,
    recentActive: 0,
  };
  let openTasks = 0;
  let doneTasks = 0;

  for (const file of files) {
    const path = String(file.path || "");
    if (pathUnderAnyPrefix(path, notePathPrefixes(settings, "dailyNotes"))) counts.dailyNotes += 1;
    if (pathUnderAnyPrefix(path, notePathPrefixes(settings, "permanentNotes"))) counts.evergreenNotes += 1;
    if (pathUnderAnyPrefix(path, notePathPrefixes(settings, "literatureNotes"))) counts.literatureNotes += 1;
    if (pathUnderAnyPrefix(path, notePathPrefixes(settings, "topicNotes"))) counts.topicNotes += 1;
    if (pathUnderAnyPrefix(path, notePathPrefixes(settings, "domainPages"))) counts.domainNotes += 1;
    const ctime = Number(file.stat && file.stat.ctime ? file.stat.ctime : 0);
    const mtime = Number(file.stat && file.stat.mtime ? file.stat.mtime : 0);
    if (ctime >= since) counts.weeklyNew += 1;
    if (mtime >= since) counts.recentActive += 1;

    if (path.endsWith(".md")) {
      const tasks = taskStatsFromContent(await readFileText(app, file));
      openTasks += tasks.open;
      doneTasks += tasks.done;
    }
  }

  const totalTasks = openTasks + doneTasks;
  return {
    today: todayState,
    activeProjects: activeProjects.length,
    highPriorityProjects: activeProjects.filter((project) => /高|high/i.test(project.priority)).length,
    weeklyNew: counts.weeklyNew,
    recentActive: counts.recentActive,
    knowledgeAssets: counts.evergreenNotes + counts.literatureNotes + counts.topicNotes,
    evergreenNotes: counts.evergreenNotes,
    literatureNotes: counts.literatureNotes,
    topicNotes: counts.topicNotes,
    domainNotes: counts.domainNotes,
    dailyNotes: counts.dailyNotes,
    tasks: {
      open: openTasks,
      done: doneTasks,
      total: totalTasks,
      completionRate: totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0,
    },
  };
}

module.exports = {
  DEFAULT_HOME_SETTINGS,
  normalizeHomeSettings,
  resolveDailyNotePath,
  summarizeDailyNote,
  taskStatsFromContent,
  listTaskItemsFromContent,
  countDailyCaptures,
  toggleTaskLineInContent,
  toggleTaskInFile,
  getTodayState,
  findOrCreateTodayDailyNote,
  listProjects,
  listActiveProjects,
  listRecentFiles,
  getDailyActivityHeatmap,
  getDashboardStats,
};
