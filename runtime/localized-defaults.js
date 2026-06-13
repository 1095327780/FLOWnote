const { normalizeSupportedLocale } = require("./i18n-locale-utils");

const NOTE_PATH_KEYS = [
  "dailyNotes",
  "weeklyReviews",
  "monthlyReviews",
  "yearlyReviews",
  "permanentNotes",
  "topicNotes",
  "literatureNotes",
  "domainPages",
  "activeProjects",
  "archive",
];

const NOTE_PATH_DEFAULTS_BY_LOCALE = {
  "zh-CN": {
    dailyNotes: "01-捕获层/每日笔记",
    weeklyReviews: "01-捕获层/周记",
    monthlyReviews: "01-捕获层/月记",
    yearlyReviews: "01-捕获层/年记",
    permanentNotes: "02-培养层/永久笔记",
    topicNotes: "02-培养层/主题笔记",
    literatureNotes: "02-培养层/文献笔记",
    domainPages: "03-连接层",
    activeProjects: "04-创造层/项目",
    archive: "04-创造层/归档",
  },
  en: {
    dailyNotes: "01-Capture/Daily Notes",
    weeklyReviews: "01-Capture/Weekly Reviews",
    monthlyReviews: "01-Capture/Monthly Reviews",
    yearlyReviews: "01-Capture/Yearly Reviews",
    permanentNotes: "02-Cultivate/Evergreen Notes",
    topicNotes: "02-Cultivate/Topic Notes",
    literatureNotes: "02-Cultivate/Literature Notes",
    domainPages: "03-Connect",
    activeProjects: "04-Create/Projects",
    archive: "04-Create/Archive",
  },
  ru: {
    dailyNotes: "01-Захват/Ежедневные заметки",
    weeklyReviews: "01-Захват/Еженедельные обзоры",
    monthlyReviews: "01-Захват/Ежемесячные обзоры",
    yearlyReviews: "01-Захват/Годовые обзоры",
    permanentNotes: "02-Развитие/Постоянные заметки",
    topicNotes: "02-Развитие/Тематические заметки",
    literatureNotes: "02-Развитие/Литературные заметки",
    domainPages: "03-Связи",
    activeProjects: "04-Создание/Проекты",
    archive: "04-Создание/Архив",
  },
};

const META_TEMPLATES_DIR_BY_LOCALE = {
  "zh-CN": "Meta/模板",
  en: "Meta/Templates",
  ru: "Meta/Шаблоны",
};

function normalizePathValue(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").trim();
}

function getContentLocale(locale, fallback = "zh-CN") {
  return normalizeSupportedLocale(locale, fallback);
}

function getSkillDocLocale(locale) {
  return getContentLocale(locale, "en") === "zh-CN" ? "zh-CN" : "en";
}

function getDefaultNotePaths(locale = "zh-CN") {
  const normalized = getContentLocale(locale, "zh-CN");
  return { ...(NOTE_PATH_DEFAULTS_BY_LOCALE[normalized] || NOTE_PATH_DEFAULTS_BY_LOCALE["zh-CN"]) };
}

function getDefaultDailyNotePath(locale = "zh-CN") {
  return getDefaultNotePaths(locale).dailyNotes;
}

function isKnownDefaultNotePath(key, value) {
  const normalized = normalizePathValue(value);
  if (!normalized) return true;
  return Object.values(NOTE_PATH_DEFAULTS_BY_LOCALE).some((defaults) => defaults[key] === normalized);
}

function normalizeNotePathsForLocale(raw, locale = "zh-CN") {
  const data = raw && typeof raw === "object" ? raw : {};
  const defaults = getDefaultNotePaths(locale);
  const out = { ...defaults };
  for (const key of NOTE_PATH_KEYS) {
    const value = normalizePathValue(data[key]);
    out[key] = value || defaults[key];
  }
  return out;
}

function migrateNotePathsForLocale(raw, previousLocale = "zh-CN", nextLocale = "zh-CN") {
  const data = raw && typeof raw === "object" ? raw : {};
  const previousDefaults = getDefaultNotePaths(previousLocale);
  const nextDefaults = getDefaultNotePaths(nextLocale);
  const out = { ...nextDefaults };
  for (const key of NOTE_PATH_KEYS) {
    const value = normalizePathValue(data[key]);
    if (!value || value === previousDefaults[key] || isKnownDefaultNotePath(key, value)) {
      out[key] = nextDefaults[key];
    } else {
      out[key] = value;
    }
  }
  return out;
}

function migrateMobileCaptureDefaultsForLocale(mobileCapture, previousLocale = "zh-CN", nextLocale = "zh-CN") {
  if (!mobileCapture || typeof mobileCapture !== "object") return mobileCapture;
  const value = normalizePathValue(mobileCapture.dailyNotePath);
  const previousDaily = getDefaultDailyNotePath(previousLocale);
  if (!value || value === previousDaily || isKnownDefaultNotePath("dailyNotes", value)) {
    mobileCapture.dailyNotePath = getDefaultDailyNotePath(nextLocale);
  }
  return mobileCapture;
}

function migrateSettingsLocaleDefaults(settings, previousLocale = "zh-CN", nextLocale = "zh-CN") {
  if (!settings || typeof settings !== "object") return settings;
  settings.notePaths = migrateNotePathsForLocale(settings.notePaths, previousLocale, nextLocale);
  if (settings.mobileCapture && typeof settings.mobileCapture === "object") {
    migrateMobileCaptureDefaultsForLocale(settings.mobileCapture, previousLocale, nextLocale);
  }
  return settings;
}

function getMetaTemplatesDir(locale = "zh-CN") {
  const normalized = getContentLocale(locale, "zh-CN");
  return META_TEMPLATES_DIR_BY_LOCALE[normalized] || META_TEMPLATES_DIR_BY_LOCALE["zh-CN"];
}

module.exports = {
  NOTE_PATH_KEYS,
  NOTE_PATH_DEFAULTS_BY_LOCALE,
  META_TEMPLATES_DIR_BY_LOCALE,
  getContentLocale,
  getSkillDocLocale,
  getDefaultNotePaths,
  getDefaultDailyNotePath,
  getMetaTemplatesDir,
  normalizeNotePathsForLocale,
  migrateNotePathsForLocale,
  migrateMobileCaptureDefaultsForLocale,
  migrateSettingsLocaleDefaults,
};
