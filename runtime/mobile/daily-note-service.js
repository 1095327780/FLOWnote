const { normalizePath } = require("obsidian");

const URL_REGEX = /https?:\/\/[^\s)\]>，。！？]+/g;
const URL_TRAILING_ASCII_PUNCTUATION_REGEX = /[.,;:!?]+$/;
const URL_SUMMARY_LINE_REGEX = /^\s*>\s*📎\s*(https?:\/\/\S+|原始URL)\s*-\s*(.+?)\s*$/i;
const INLINE_URL_SUMMARY_REGEX = />\s*📎\s*(https?:\/\/\S+|原始URL)\s*-\s*(.+?)\s*$/i;

const DAILY_NOTE_TEMPLATE = `# {{date}}

## 📋 今日计划
- [ ]

## 📝 今日记录

### 💡 想法和灵感

### 📖 学习笔记

## 🔄 每日回顾
- 今天做了什么：
- 明天计划：
`;

/**
 * Format a date as YYYY-MM-DD.
 * @param {Date} [date]
 * @returns {string}
 */
function formatDateStr(date) {
  const d = date || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Format time as HH:mm.
 * @param {Date} [date]
 * @returns {string}
 */
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

function parseSummaryItemFromMatch(match, linePrefix = "") {
  const rawTarget = String(match && match[1] ? match[1] : "").trim();
  const summary = normalizeSingleLine(match && match[2] ? match[2] : "", "暂无法解析，已保留原始链接");
  const isPlaceholder = /^原始url$/i.test(rawTarget);
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

function stripTrailingUrlPunctuation(rawUrl) {
  return String(rawUrl || "").trim().replace(URL_TRAILING_ASCII_PUNCTUATION_REGEX, "");
}

function inferTitleFromUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return String(parsed.hostname || "").replace(/^www\./i, "").trim();
  } catch (_e) {
    return "";
  }
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

function parseCaptureTextSections(text) {
  const raw = String(text || "").replace(/\r\n?/g, "\n");
  const lines = raw.split("\n");
  const bodyLines = [];
  const summaryItems = [];

  for (const line of lines) {
    const pureMatch = line.match(URL_SUMMARY_LINE_REGEX);
    if (pureMatch) {
      summaryItems.push(parseSummaryItemFromMatch(pureMatch, ""));
      continue;
    }
    const inlineMatch = line.match(INLINE_URL_SUMMARY_REGEX);
    if (inlineMatch) {
      const markerStart = line.search(/>\s*📎\s*(https?:\/\/\S+|原始URL)\s*-\s*/i);
      const prefix = markerStart >= 0 ? line.slice(0, markerStart).trimEnd() : String(line || "").trimEnd();
      if (prefix.trim()) bodyLines.push(prefix);
      summaryItems.push(parseSummaryItemFromMatch(inlineMatch, prefix));
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

function normalizeCaptureParagraph(text) {
  let normalized = String(text || "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!normalized) return "";
  normalized = normalized.replace(/^原文[:：]\s*/i, "");
  normalized = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  return normalized.replace(/\s+/g, " ").trim();
}

function formatResolverInlineSummary(resolverItems) {
  const items = Array.isArray(resolverItems)
    ? resolverItems.filter((item) => item && item.hasSummary)
    : [];
  if (!items.length) return "";

  if (items.length === 1) {
    return `（链接摘要：${normalizeSingleLine(items[0].summary, "暂无法解析，已保留原始链接")}）`;
  }

  const usedLabels = new Map();
  const parts = items.map((item, index) => {
    const base = inferTitleFromUrl(item.url) || `链接${index + 1}`;
    const count = (usedLabels.get(base) || 0) + 1;
    usedLabels.set(base, count);
    const label = count > 1 ? `${base}#${count}` : base;
    return `${label}：${normalizeSingleLine(item.summary, "暂无法解析，已保留原始链接")}`;
  });
  return `（链接摘要：${parts.join("；")}）`;
}

/**
 * Format a capture entry.
 * @param {string} timeStr
 * @param {string} text
 * @returns {string}
 */
function formatCaptureEntry(timeStr, text) {
  const { body, resolverItems } = parseCaptureTextSections(text);
  const paragraph = normalizeCaptureParagraph(body || text) || "（空）";
  const inlineSummary = formatResolverInlineSummary(resolverItems);
  return `- ${timeStr} ${paragraph}${inlineSummary ? ` ${inlineSummary}` : ""}`;
}

/**
 * Ensure parent folders exist for a given file path.
 * @param {import("obsidian").Vault} vault
 * @param {string} filePath
 */
async function ensureFolders(vault, filePath) {
  const parts = filePath.split("/");
  parts.pop(); // remove filename
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const normalized = normalizePath(current);
    const existing = vault.getAbstractFileByPath(normalized);
    if (!existing) {
      try {
        await vault.createFolder(normalized);
      } catch (_e) {
        // folder may have been created concurrently — ignore
      }
    }
  }
}

/**
 * Find or create today's daily note.
 * @param {import("obsidian").Vault} vault
 * @param {string} dailyNotePath - folder path for daily notes
 * @param {string} [dateStr] - override date string (YYYY-MM-DD)
 * @returns {Promise<import("obsidian").TFile>}
 */
async function findOrCreateDailyNote(vault, dailyNotePath, dateStr) {
  const date = dateStr || formatDateStr();
  const filePath = normalizePath(`${dailyNotePath}/${date}.md`);

  const existing = vault.getAbstractFileByPath(filePath);
  if (existing) return existing;

  // Ensure folders exist
  await ensureFolders(vault, filePath);

  // Create from template
  const content = DAILY_NOTE_TEMPLATE.replace(/\{\{date\}\}/g, date);
  return await vault.create(filePath, content);
}

/**
 * Append a capture entry to the idea section of a daily note.
 * @param {import("obsidian").Vault} vault
 * @param {import("obsidian").TFile} file
 * @param {string} entry - formatted entry string (e.g. "- 14:30 some idea")
 * @param {string} sectionHeader - e.g. "### 💡 想法和灵感"
 */
async function appendToIdeaSection(vault, file, entry, sectionHeader) {
  let content = await vault.read(file);
  const headerIdx = content.indexOf(sectionHeader);

  if (headerIdx !== -1) {
    // Section exists — find the end of it (next heading or end of file)
    const afterHeader = headerIdx + sectionHeader.length;
    const restContent = content.slice(afterHeader);

    // Find next heading (any level) or end of content
    const nextHeadingMatch = restContent.match(/\n(#{1,6} )/);
    let insertPos;

    if (nextHeadingMatch) {
      // Insert before the next heading
      insertPos = afterHeader + nextHeadingMatch.index;
    } else {
      // No next heading; append at end
      insertPos = content.length;
    }

    // Find the last "- " entry within the section to insert after it
    const sectionContent = content.slice(afterHeader, insertPos);
    const lastDashIdx = sectionContent.lastIndexOf("\n- ");

    if (lastDashIdx !== -1) {
      // Find end of that line
      const lineStart = afterHeader + lastDashIdx + 1;
      const lineEnd = content.indexOf("\n", lineStart + 1);
      const actualEnd = lineEnd === -1 ? content.length : lineEnd;
      content = content.slice(0, actualEnd) + "\n" + entry + content.slice(actualEnd);
    } else {
      // No existing entries; insert right after the header line
      const headerLineEnd = content.indexOf("\n", headerIdx);
      if (headerLineEnd !== -1) {
        content = content.slice(0, headerLineEnd) + "\n" + entry + content.slice(headerLineEnd);
      } else {
        content = content + "\n" + entry;
      }
    }
  } else {
    // Section doesn't exist — insert after "## 📝 今日记录" line or at end
    const recordIdx = content.indexOf("## 📝 今日记录");
    const insertBlock = "\n" + sectionHeader + "\n" + entry + "\n";

    if (recordIdx !== -1) {
      const lineEnd = content.indexOf("\n", recordIdx);
      if (lineEnd !== -1) {
        content = content.slice(0, lineEnd) + "\n" + insertBlock + content.slice(lineEnd);
      } else {
        content = content + "\n" + insertBlock;
      }
    } else {
      // Fallback: append at end
      content = content + "\n" + insertBlock;
    }
  }

  await vault.modify(file, content);
}

module.exports = {
  DAILY_NOTE_TEMPLATE,
  formatDateStr,
  formatTimeStr,
  formatCaptureEntry,
  findOrCreateDailyNote,
  appendToIdeaSection,
};
