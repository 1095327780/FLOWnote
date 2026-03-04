const { normalizePath } = require("obsidian");
const { normalizeSupportedLocale } = require("../i18n-locale-utils");

const URL_REGEX = /https?:\/\/[^\s)\]>，。！？]+/g;
const URL_TRAILING_ASCII_PUNCTUATION_REGEX = /[.,;:!?]+$/;
const URL_SUMMARY_LINE_REGEX = /^\s*>\s*📎\s*(https?:\/\/\S+|原始URL|OriginalURL)\s*-\s*(.+?)\s*$/i;
const INLINE_URL_SUMMARY_REGEX = />\s*📎\s*(https?:\/\/\S+|原始URL|OriginalURL)\s*-\s*(.+?)\s*$/i;

const DAILY_NOTE_TEMPLATE = `---
创建时间: {{date}}
类型: 每日笔记
---

# {{date}}

## 今天最重要的事

## 任务

## 记录

## 晚间回顾

## 明日计划
`;

const DAILY_NOTE_TEMPLATE_EN = `---
Created: {{date}}
Type: Daily Note
---

# {{date}}

## Most Important Today

## Tasks

## Records

## Evening Review

## Tomorrow Plan
`;

function isZh(locale) {
  return normalizeSupportedLocale(locale) === "zh-CN";
}

function summaryFallback(locale) {
  return isZh(locale)
    ? "暂无法解析，已保留原始链接"
    : "Unable to resolve, original URL preserved";
}

function summaryPrefix(locale) {
  return isZh(locale) ? "链接摘要" : "URL Summary";
}

function emptyValue(locale) {
  return isZh(locale) ? "（空）" : "(Empty)";
}

function originalPrefix(locale) {
  return isZh(locale) ? "原文" : "Original";
}

function linkLabel(index, locale) {
  return isZh(locale) ? `链接${index}` : `Link ${index}`;
}

function recordHeading(locale) {
  return isZh(locale) ? "## 记录" : "## Records";
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
    "## 记录",
    "## 今日记录",
    "## 📝 今日记录",
    "## records",
    "## today notes",
    "## 📝 today notes",
  ].includes(normalized);
}

function getDailyNoteTemplate(locale) {
  return isZh(locale) ? DAILY_NOTE_TEMPLATE : DAILY_NOTE_TEMPLATE_EN;
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

  const template = String(options.template || getDailyNoteTemplate(locale));
  const content = template.replace(/\{\{date\}\}/g, date);
  return await vault.create(filePath, content);
}

async function appendToIdeaSection(vault, file, entry, sectionHeader) {
  let content = await vault.read(file);
  const headerIdx = content.indexOf(sectionHeader);

  if (headerIdx !== -1) {
    const afterHeader = headerIdx + sectionHeader.length;
    const restContent = content.slice(afterHeader);
    const nextHeadingMatch = restContent.match(/\n(#{1,6} )/);
    let insertPos;

    if (nextHeadingMatch) {
      insertPos = afterHeader + nextHeadingMatch.index;
    } else {
      insertPos = content.length;
    }

    const sectionContent = content.slice(afterHeader, insertPos);
    const lastDashIdx = sectionContent.lastIndexOf("\n- ");

    if (lastDashIdx !== -1) {
      const lineStart = afterHeader + lastDashIdx + 1;
      const lineEnd = content.indexOf("\n", lineStart + 1);
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
      content = content.slice(0, actualEnd) + "\n" + entry + content.slice(actualEnd);
    } else {
      const headerLineEnd = content.indexOf("\n", headerIdx);
      if (headerLineEnd !== -1) {
        content = content.slice(0, headerLineEnd) + "\n" + entry + content.slice(headerLineEnd);
      } else {
        content = content + "\n" + entry;
      }
    }
  } else {
    const recordAnchors = [
      "## 记录",
      "## Records",
      "## 📝 今日记录",
      "## 📝 Today Notes",
      recordHeading("zh-CN"),
      recordHeading("en"),
    ];
    const recordIdx = recordAnchors.reduce((acc, heading) => {
      if (acc !== -1) return acc;
      return content.indexOf(String(heading || ""));
    }, -1);
    const insertBlock = "\n" + sectionHeader + "\n" + entry + "\n";

    if (recordIdx !== -1) {
      const lineEnd = content.indexOf("\n", recordIdx);
      if (lineEnd !== -1) {
        if (isRecordSectionHeading(sectionHeader)) {
          content = content.slice(0, lineEnd) + "\n" + entry + content.slice(lineEnd);
        } else {
          content = content.slice(0, lineEnd) + "\n" + insertBlock + content.slice(lineEnd);
        }
      } else {
        if (isRecordSectionHeading(sectionHeader)) {
          content = content + "\n" + entry;
        } else {
          content = content + "\n" + insertBlock;
        }
      }
    } else {
      content = content + "\n" + insertBlock;
    }
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
  parseCaptureTextSections,
  extractUrlsFromText,
  summaryFallback,
};
