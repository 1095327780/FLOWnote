const { normalizePath } = require("obsidian");
const {
  getIntlLocale,
  getLocalizedMarkdownTokenOrder,
  normalizeSupportedLocale,
} = require("../i18n-locale-utils");

const URL_REGEX = /https?:\/\/[^\s)\]>，。！？]+/g;
const URL_TRAILING_ASCII_PUNCTUATION_REGEX = /[.,;:!?]+$/;
const URL_SUMMARY_LINE_REGEX = /^\s*>\s*📎\s*(https?:\/\/\S+|原始URL|OriginalURL)\s*-\s*(.+?)\s*$/i;
const INLINE_URL_SUMMARY_REGEX = />\s*📎\s*(https?:\/\/\S+|原始URL|OriginalURL)\s*-\s*(.+?)\s*$/i;
const DEFAULT_SKILLS_DIR = ".opencode/skills";

const DAILY_NOTE_TEMPLATE = `---
创建时间: {{date}}
类型: 每日笔记
---

# 📅 {{date}} 星期X

## ⭐ 今天最重要的事
写今天唯一最重要的一件事，要求可执行且可在今天推进。

## ✅ 任务
写今天任务清单，第一条对齐"今天最重要的事"。

## 📝 记录
写白天发生的重要进展、想法或事件。

## 🌙 晚间回顾
写做得好的地方、可改进处和明天最想推进的一件事。

## 📅 明日计划
写明天预计推进的 1-3 件重要事项，供次日创建日记时承接。
`;

const DAILY_NOTE_TEMPLATE_EN = `---
Created: {{date}}
Type: Daily Note
---

# 📅 {{date}} Weekday

## ⭐ Most Important Today
Write the single most important thing to move forward today.

## ✅ Tasks
List today's tasks, with the first one aligned to your most important focus.

## 📝 Records
Capture key progress, ideas, or events from the day.

## 🌙 Evening Review
Reflect on what worked, what can improve, and one priority for tomorrow.

## 📅 Tomorrow Plan
List 1-3 important items to carry into tomorrow's daily note.
`;

const DAILY_NOTE_TEMPLATE_RU = `---
Создано: {{date}}
Тип: Ежедневная заметка
---

# 📅 {{date}} Weekday

## ⭐ Главное сегодня
Запишите одну самую важную задачу, которую нужно продвинуть сегодня.

## ✅ Задачи
Составьте список задач на день; первая должна быть связана с главным фокусом.

## 📝 Записи
Фиксируйте важный прогресс, идеи или события дня.

## 🌙 Вечерний обзор
Отметьте, что получилось, что можно улучшить, и один приоритет на завтра.

## 📅 План на завтра
Запишите 1-3 важных пункта, которые стоит перенести в завтрашнюю заметку.
`;

const DAILY_NOTE_TEMPLATE_BY_LOCALE = {
  "zh-CN": DAILY_NOTE_TEMPLATE,
  en: DAILY_NOTE_TEMPLATE_EN,
  ru: DAILY_NOTE_TEMPLATE_RU,
};

const DAILY_NOTE_LABELS = {
  "zh-CN": {
    summaryFallback: "暂无法解析，已保留原始链接",
    summaryPrefix: "链接摘要",
    emptyValue: "（空）",
    originalPrefix: "原文",
    linkLabel: (index) => `链接${index}`,
    recordHeading: "## 📝 记录",
  },
  en: {
    summaryFallback: "Unable to resolve, original URL preserved",
    summaryPrefix: "URL Summary",
    emptyValue: "(Empty)",
    originalPrefix: "Original",
    linkLabel: (index) => `Link ${index}`,
    recordHeading: "## 📝 Records",
  },
  ru: {
    summaryFallback: "Не удалось обработать, исходная ссылка сохранена",
    summaryPrefix: "Краткое описание URL",
    emptyValue: "(Пусто)",
    originalPrefix: "Оригинал",
    linkLabel: (index) => `Ссылка ${index}`,
    recordHeading: "## 📝 Записи",
  },
};

function labelsForLocale(locale) {
  const normalized = normalizeSupportedLocale(locale, "en");
  return DAILY_NOTE_LABELS[normalized] || DAILY_NOTE_LABELS.en;
}

function summaryFallback(locale) {
  return labelsForLocale(locale).summaryFallback;
}

function summaryPrefix(locale) {
  return labelsForLocale(locale).summaryPrefix;
}

function emptyValue(locale) {
  return labelsForLocale(locale).emptyValue;
}

function originalPrefix(locale) {
  return labelsForLocale(locale).originalPrefix;
}

function linkLabel(index, locale) {
  return labelsForLocale(locale).linkLabel(index);
}

function recordHeading(locale) {
  return labelsForLocale(locale).recordHeading;
}

function normalizeHeadingForCompare(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isRecordSectionHeading(value) {
  const normalized = normalizeHeadingForCompare(value);
  if (!normalized) return false;
  return [
    "## 📝 记录",
    "## 记录",
    "## 今日记录",
    "## 📝 今日记录",
    "## 📝 records",
    "## records",
    "## today notes",
    "## 📝 today notes",
    "## 📝 записи",
    "## записи",
  ].includes(normalized);
}

function listRecordSectionAnchors() {
  return [
    "## 📝 记录",
    "## 记录",
    "## 今日记录",
    "## 📝 今日记录",
    "## 📝 Records",
    "## Records",
    "## Today Notes",
    "## 📝 Today Notes",
    "## 📝 Записи",
    "## Записи",
    recordHeading("zh-CN"),
    recordHeading("en"),
    recordHeading("ru"),
  ];
}

function resolveSectionHeaderMatch(content, sectionHeader) {
  const requested = String(sectionHeader || "").trim();
  if (requested) {
    const index = content.indexOf(requested);
    if (index !== -1) return { index, heading: requested };
  }

  if (!isRecordSectionHeading(requested)) return null;
  let best = null;
  for (const heading of [...new Set(listRecordSectionAnchors().filter(Boolean))]) {
    const index = content.indexOf(heading);
    if (index === -1) continue;
    if (!best || index < best.index) best = { index, heading };
  }
  return best;
}

function resolveSectionBounds(content, headerMatch) {
  const headerIndex = Number(headerMatch && Number.isFinite(headerMatch.index) ? headerMatch.index : -1);
  if (headerIndex < 0) return null;
  const heading = String(headerMatch && headerMatch.heading ? headerMatch.heading : "");
  const afterHeader = headerIndex + heading.length;
  const restContent = content.slice(afterHeader);
  const nextHeadingMatch = restContent.match(/\n#{1,6}\s/);
  const sectionEnd = nextHeadingMatch ? afterHeader + nextHeadingMatch.index : content.length;
  const headerLineEnd = content.indexOf("\n", headerIndex);
  return {
    afterHeader,
    sectionEnd,
    headerLineEnd: headerLineEnd === -1 ? afterHeader : headerLineEnd,
  };
}

function appendEntryAtPosition(content, entry, insertPos) {
  const before = content.slice(0, insertPos);
  const after = content.slice(insertPos);
  const prefix = before.length && !before.endsWith("\n") ? "\n" : "";
  const suffix = after.length && !after.startsWith("\n") ? "\n" : "";
  return `${before}${prefix}${entry}${suffix}${after}`;
}

function getDailyNoteTemplate(locale) {
  const normalized = normalizeSupportedLocale(locale, "en");
  return DAILY_NOTE_TEMPLATE_BY_LOCALE[normalized] || DAILY_NOTE_TEMPLATE_EN;
}

function getWeekdayByDateStr(dateStr) {
  const match = String(dateStr || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;
  return date.getDay();
}

function renderDailyNoteTemplate(template, dateStr, locale = "zh-CN") {
  const localeCode = normalizeSupportedLocale(locale || "en");
  const date = String(dateStr || "");
  let rendered = String(template || "");
  if (!rendered.trim()) return rendered;

  rendered = rendered.replace(/\{\{\s*date\s*\}\}/gi, date);
  rendered = rendered.replace(/YYYY-MM-DD/g, date);

  const weekday = getWeekdayByDateStr(date);
  if (weekday !== null) {
    const zhWeekdays = ["日", "一", "二", "三", "四", "五", "六"];
    const weekdayZh = zhWeekdays[weekday] || "X";
    const parsedDate = new Date(`${date}T00:00:00`);
    const weekdayLocalized = parsedDate.toLocaleDateString(getIntlLocale(localeCode), { weekday: "long" });
    rendered = rendered.replace(/星期[一二三四五六日天Xx]/g, `星期${weekdayZh}`);
    rendered = rendered.replace(/\bWeekday\b/g, localeCode === "zh-CN" ? `星期${weekdayZh}` : weekdayLocalized);
  }

  return rendered;
}

function localizedTemplateCandidates(basePath, locale = "en") {
  const normalizedLocale = normalizeSupportedLocale(locale || "en");
  const canonicalBase = normalizePath(String(basePath || ""));
  if (!canonicalBase || !canonicalBase.endsWith(".md")) return [];
  const suffixless = canonicalBase.slice(0, -".md".length);
  const tokenOrder = getLocalizedMarkdownTokenOrder(normalizedLocale);
  const candidates = [];
  for (const token of tokenOrder) {
    if (token === "base") candidates.push(`${suffixless}.md`);
    else candidates.push(`${suffixless}.${token}.md`);
  }
  return [...new Set(candidates.map((value) => normalizePath(value)).filter(Boolean))];
}

async function readVaultTextByPath(vault, path) {
  const targetPath = normalizePath(String(path || ""));
  if (!targetPath || !vault) return "";

  const adapter = vault.adapter;
  if (adapter && typeof adapter.exists === "function" && typeof adapter.read === "function") {
    try {
      if (await adapter.exists(targetPath)) {
        const raw = await adapter.read(targetPath);
        return String(raw || "");
      }
    } catch {
      // fallback to vault.read if adapter read is unavailable in current runtime.
    }
  }

  if (typeof vault.getAbstractFileByPath === "function" && typeof vault.read === "function") {
    try {
      const file = vault.getAbstractFileByPath(targetPath);
      if (file) {
        const raw = await vault.read(file);
        return String(raw || "");
      }
    } catch {
      // ignore and fallback to empty
    }
  }

  return "";
}

async function resolveSkillDailyNoteTemplate(vault, options = {}) {
  const locale = normalizeSupportedLocale(options.locale || "en");
  const skillsDir = normalizePath(String(options.skillsDir || DEFAULT_SKILLS_DIR).trim() || DEFAULT_SKILLS_DIR);
  const canonicalPaths = [
    `${skillsDir}/ah-note/assets/每日笔记模板.md`,
    // Compatibility fallback for template-map targets that may use assets/templates/.
    `${skillsDir}/ah-note/assets/templates/每日笔记模板.md`,
  ];
  const legacyLocalePaths = [
    `${skillsDir}/ah-note/assets/Daily Note Template.md`,
    `${skillsDir}/ah-note/assets/Daily-Note-Template.md`,
    `${skillsDir}/ah-note/assets/templates/Daily Note Template.md`,
    `${skillsDir}/ah-note/assets/templates/Daily-Note-Template.md`,
  ];
  const orderedPaths = locale === "zh-CN"
    ? [...canonicalPaths, ...legacyLocalePaths]
    : [...legacyLocalePaths, ...canonicalPaths];
  const candidates = orderedPaths.flatMap((basePath) => localizedTemplateCandidates(basePath, locale));

  for (const candidate of [...new Set(candidates)]) {
    const text = await readVaultTextByPath(vault, candidate);
    if (String(text || "").trim()) return text;
  }
  return "";
}

function formatDateStr(date) {
  const d = date || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatTimeStr(date) {
  const d = date || new Date();
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function normalizeSingleLine(text, fallback = "") {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || fallback;
}

function stripTrailingUrlPunctuation(rawUrl) {
  return String(rawUrl || "").trim().replace(URL_TRAILING_ASCII_PUNCTUATION_REGEX, "");
}

function extractUrlsFromText(text) {
  const matches = String(text || "").match(URL_REGEX) || [];
  const seen = new Set();
  const urls = [];
  for (const raw of matches) {
    const cleaned = stripTrailingUrlPunctuation(raw);
    if (!cleaned || seen.has(cleaned)) continue;
    try {
      const parsed = new URL(cleaned);
      const protocol = String(parsed.protocol || "").toLowerCase();
      if (protocol !== "http:" && protocol !== "https:") continue;
    } catch (_e) {
      continue;
    }
    seen.add(cleaned);
    urls.push(cleaned);
  }
  return urls;
}

function parseSummaryItemFromMatch(match, linePrefix = "", locale = "zh-CN") {
  const rawTarget = String(match && match[1] ? match[1] : "").trim();
  const summary = normalizeSingleLine(match && match[2] ? match[2] : "", summaryFallback(locale));
  const isPlaceholder = /^(原始url|originalurl)$/i.test(rawTarget);
  const directUrl = isPlaceholder ? "" : stripTrailingUrlPunctuation(rawTarget);
  const hints = extractUrlsFromText(String(linePrefix || ""));
  const urlHint = hints.length ? hints[hints.length - 1] : "";
  return {
    url: directUrl,
    urlHint,
    summary,
    hasSummary: true,
  };
}

function inferTitleFromUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return String(parsed.hostname || "").replace(/^www\./i, "").trim();
  } catch (_e) {
    return "";
  }
}

function parseCaptureTextSections(text, locale = "zh-CN") {
  const raw = String(text || "").replace(/\r\n?/g, "\n");
  const lines = raw.split("\n");
  const bodyLines = [];
  const summaryItems = [];

  for (const line of lines) {
    const pureMatch = line.match(URL_SUMMARY_LINE_REGEX);
    if (pureMatch) {
      summaryItems.push(parseSummaryItemFromMatch(pureMatch, "", locale));
      continue;
    }
    const inlineMatch = line.match(INLINE_URL_SUMMARY_REGEX);
    if (inlineMatch) {
      const markerStart = line.search(/>\s*📎\s*(https?:\/\/\S+|原始URL|OriginalURL)\s*-\s*/i);
      const prefix = markerStart >= 0 ? line.slice(0, markerStart).trimEnd() : String(line || "").trimEnd();
      if (prefix.trim()) bodyLines.push(prefix);
      summaryItems.push(parseSummaryItemFromMatch(inlineMatch, prefix, locale));
      continue;
    }
    bodyLines.push(line);
  }

  const body = bodyLines.join("\n").trim();
  const orderedUrls = extractUrlsFromText(body);
  const resolvedSummaryItems = [];
  const summaryByUrl = new Map();
  for (const item of summaryItems) {
    let targetUrl = String(item && item.url ? item.url : "").trim();
    if (!targetUrl) {
      const hint = String(item && item.urlHint ? item.urlHint : "").trim();
      if (hint && orderedUrls.includes(hint)) {
        targetUrl = hint;
      } else {
        targetUrl = orderedUrls.find((url) => !summaryByUrl.has(url)) || "";
      }
    }
    if (!targetUrl) continue;
    const resolved = { url: targetUrl, summary: item.summary, hasSummary: true };
    resolvedSummaryItems.push(resolved);
    if (!summaryByUrl.has(targetUrl)) summaryByUrl.set(targetUrl, item.summary);
  }

  const resolverItems = [];
  const seen = new Set();
  for (const url of orderedUrls) {
    const explicitSummary = summaryByUrl.get(url) || "";
    resolverItems.push({
      url,
      summary: explicitSummary,
      hasSummary: Boolean(explicitSummary),
    });
    seen.add(url);
  }
  for (const item of resolvedSummaryItems) {
    if (seen.has(item.url)) continue;
    resolverItems.push(item);
    seen.add(item.url);
  }

  return {
    body: body || raw.trim(),
    resolverItems,
  };
}

function normalizeCaptureParagraph(text, locale = "zh-CN") {
  let normalized = String(text || "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!normalized) return "";
  const prefix = originalPrefix(locale);
  normalized = normalized.replace(new RegExp(`^(${prefix}|原文|Original)[:：]\\s*`, "i"), "");
  normalized = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  return normalized.replace(/\s+/g, " ").trim();
}

function formatResolverInlineSummary(resolverItems, locale = "zh-CN") {
  const items = Array.isArray(resolverItems)
    ? resolverItems.filter((item) => item && item.hasSummary)
    : [];
  if (!items.length) return "";

  if (items.length === 1) {
    return `(${summaryPrefix(locale)}: ${normalizeSingleLine(items[0].summary, summaryFallback(locale))})`;
  }

  const usedLabels = new Map();
  const parts = items.map((item, index) => {
    const base = inferTitleFromUrl(item.url) || linkLabel(index + 1, locale);
    const count = (usedLabels.get(base) || 0) + 1;
    usedLabels.set(base, count);
    const label = count > 1 ? `${base}#${count}` : base;
    return `${label}: ${normalizeSingleLine(item.summary, summaryFallback(locale))}`;
  });
  return `(${summaryPrefix(locale)}: ${parts.join("; ")})`;
}

function formatCaptureEntry(timeStr, text, options = {}) {
  const locale = normalizeSupportedLocale(options.locale || "en");
  const { body, resolverItems } = parseCaptureTextSections(text, locale);
  const paragraph = normalizeCaptureParagraph(body || text, locale) || emptyValue(locale);
  const inlineSummary = formatResolverInlineSummary(resolverItems, locale);
  return `- ${timeStr} ${paragraph}${inlineSummary ? ` ${inlineSummary}` : ""}`;
}

async function ensureFolders(vault, filePath) {
  const parts = filePath.split("/");
  parts.pop();
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const normalized = normalizePath(current);
    const existing = vault.getAbstractFileByPath(normalized);
    if (!existing) {
      try {
        await vault.createFolder(normalized);
      } catch (_e) {
      }
    }
  }
}

async function findOrCreateDailyNote(vault, dailyNotePath, dateStr, options = {}) {
  const locale = normalizeSupportedLocale(options.locale || "en");
  const date = dateStr || formatDateStr();
  const filePath = normalizePath(`${dailyNotePath}/${date}.md`);

  const existing = vault.getAbstractFileByPath(filePath);
  if (existing) return existing;

  await ensureFolders(vault, filePath);

  let template = String(options.template || "");
  if (!template.trim()) {
    template = await resolveSkillDailyNoteTemplate(vault, {
      locale,
      skillsDir: options.skillsDir,
    });
  }
  if (!template.trim()) template = getDailyNoteTemplate(locale);
  const content = renderDailyNoteTemplate(template, date, locale);
  return await vault.create(filePath, content);
}

async function appendToIdeaSection(vault, file, entry, sectionHeader) {
  let content = await vault.read(file);
  const headerMatch = resolveSectionHeaderMatch(content, sectionHeader);

  if (headerMatch) {
    const bounds = resolveSectionBounds(content, headerMatch);
    const sectionContent = content.slice(bounds.afterHeader, bounds.sectionEnd);
    const lastDashIdx = sectionContent.lastIndexOf("\n- ");
    const bulletStart = lastDashIdx !== -1
      ? bounds.afterHeader + lastDashIdx + 1
      : sectionContent.startsWith("- ")
        ? bounds.afterHeader
        : -1;

    if (bulletStart !== -1) {
      const lineEnd = content.indexOf("\n", bulletStart + 1);
      let actualEnd = lineEnd === -1 ? content.length : lineEnd;
      while (actualEnd < content.length) {
        const nextLineEnd = content.indexOf("\n", actualEnd + 1);
        const nextLine = content.slice(actualEnd + 1, nextLineEnd === -1 ? content.length : nextLineEnd);
        if (nextLine.startsWith("  >") || (nextLine.startsWith("  ") && !nextLine.startsWith("- "))) {
          actualEnd = nextLineEnd === -1 ? content.length : nextLineEnd;
        } else {
          break;
        }
      }
      content = appendEntryAtPosition(content, entry, actualEnd);
    } else {
      const hasExistingSectionBody = sectionContent.trim().length > 0;
      const insertPos = hasExistingSectionBody
        ? bounds.sectionEnd
        : bounds.headerLineEnd + 1;
      content = appendEntryAtPosition(content, entry, insertPos);
    }
  } else {
    const requestedHeader = String(sectionHeader || "").trim();
    const headerText = requestedHeader || recordHeading("zh-CN");
    const prefix = content.length
      ? content.endsWith("\n")
        ? "\n"
        : "\n\n"
      : "";
    content = `${content}${prefix}${headerText}\n${entry}\n`;
  }

  await vault.modify(file, content);
}

module.exports = {
  DAILY_NOTE_TEMPLATE,
  DAILY_NOTE_TEMPLATE_EN,
  formatDateStr,
  formatTimeStr,
  formatCaptureEntry,
  findOrCreateDailyNote,
  appendToIdeaSection,
  getDailyNoteTemplate,
  renderDailyNoteTemplate,
  resolveSkillDailyNoteTemplate,
  parseCaptureTextSections,
  extractUrlsFromText,
  summaryFallback,
};
