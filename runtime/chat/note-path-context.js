const { NOTE_PATH_DEFAULTS_BY_LOCALE, getDefaultNotePaths } = require("../localized-defaults");

// Default bundled layout; configured overrides are authoritative.
const DEFAULT_NOTE_PATH_LAYOUT = getDefaultNotePaths("zh-CN");
const NOTE_PATH_LABELS = {
  dailyNotes:       "Daily notes 每日笔记",
  weeklyReviews:    "Weekly reviews 周记",
  monthlyReviews:   "Monthly reviews 月记",
  yearlyReviews:    "Yearly reviews 年记",
  permanentNotes:   "Permanent notes 永久笔记",
  topicNotes:       "Topic notes 主题笔记 (📍)",
  literatureNotes:  "Literature notes 文献笔记 (《》)",
  domainPages:      "Domain pages 领域页 (🌱)",
  activeProjects:   "Active projects 项目",
  archive:          "Archive 归档",
};

function formatNotePathOverrides(notePaths, locale = "zh-CN") {
  const live = (notePaths && typeof notePaths === "object") ? notePaths : {};
  const defaults = getDefaultNotePaths(locale);
  // Always emit the full table so the model has a single source of
  // truth, even if every value matches the default — it's only ~10
  // lines and dramatically reduces "AI guessed the wrong path" cases.
  const lines = [
    "Note path conventions (USE THESE EXACT FOLDERS when reading or writing the listed note kinds; OVERRIDE any path mentioned inside a skill body):",
  ];
  for (const key of Object.keys(DEFAULT_NOTE_PATH_LAYOUT)) {
    const dflt = defaults[key] || DEFAULT_NOTE_PATH_LAYOUT[key];
    const v = String((live[key] || "")).replace(/\\/g, "/").replace(/\/+$/, "").trim() || dflt;
    const label = NOTE_PATH_LABELS[key] || key;
    const tag = v !== dflt ? "  (user-customized)" : "";
    lines.push(`  - ${label}: ${v}${tag}`);
  }
  const defaultAliases = Object.values(NOTE_PATH_DEFAULTS_BY_LOCALE)
    .flatMap((defaultsForLocale) => Object.values(defaultsForLocale || {}))
    .filter(Boolean);
  lines.push(
    "",
    `When a skill body contains a hardcoded default path, treat it as an alias for the matching row above. Known default aliases include: ${[...new Set(defaultAliases)].join("; ")}. If the table above lists a different value for that note kind, use the table's value. If a skill body contains placeholders like "{{notePaths.dailyNotes}}" or "{{notePaths.activeProjects}}", replace them mentally with the matching folder from this table. Never invent a new folder.`,
  );
  return lines.join("\n");
}

module.exports = { formatNotePathOverrides };
