const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { parseMethods } = require("../../runtime/view/question/parse-methods");
const { InlineAskUserQuestionPanel } = require("../../runtime/inline-ask-user-question-panel");
const { I18N_MESSAGES } = require("../../runtime/i18n-messages");

function createParseContext() {
  return { ...parseMethods };
}

function flattenMessages(obj, prefix = "", out = {}) {
  for (const [key, value] of Object.entries(obj || {})) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      flattenMessages(value, next, out);
    } else if (typeof value === "string") {
      out[next] = value;
    }
  }
  return out;
}

function walkRuntimeJs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkRuntimeJs(full, out);
    else if (entry.isFile() && full.endsWith(".js")) out.push(full);
  }
  return out;
}

test("normalizeQuestionItem should recognize multi-select variants", () => {
  const ctx = createParseContext();
  const fromAllowMultiple = parseMethods.normalizeQuestionItem.call(
    ctx,
    { question: "Q1", options: ["A", "B"], allow_multiple: true },
    0,
  );
  const fromSelectionMode = parseMethods.normalizeQuestionItem.call(
    ctx,
    { question: "Q2", options: ["A", "B"], selection_mode: "multi_select" },
    1,
  );
  const fromMaxSelections = parseMethods.normalizeQuestionItem.call(
    ctx,
    { question: "Q3", options: ["A", "B"], maxSelections: 2 },
    2,
  );

  assert.equal(Boolean(fromAllowMultiple && fromAllowMultiple.multiSelect), true);
  assert.equal(Boolean(fromSelectionMode && fromSelectionMode.multiSelect), true);
  assert.equal(Boolean(fromMaxSelections && fromMaxSelections.multiSelect), true);
});

test("InlineAskUserQuestionPanel should not auto-submit multi-select on first click", () => {
  let resolved = null;
  const panel = new InlineAskUserQuestionPanel({}, {}, (result) => {
    resolved = result;
  }, null, {
    immediateSelect: true,
  });
  panel.questions = [
    {
      question: "请选择功能",
      options: [{ label: "A" }, { label: "B" }],
      multiSelect: true,
    },
  ];
  panel.answers.set(0, new Set());
  panel.customInputs.set(0, "");
  panel.activeTabIndex = 0;
  panel.updateOptionVisuals = () => {};
  panel.updateTabIndicators = () => {};
  panel.switchTab = () => {};

  panel.selectOption(0, "A");
  assert.equal(resolved, null);
  assert.deepEqual([...panel.answers.get(0)], ["A"]);

  panel.selectOption(0, "B");
  assert.equal(resolved, null);
  assert.deepEqual([...panel.answers.get(0)].sort(), ["A", "B"]);
});

test("i18n messages should include localized home view copy", () => {
  assert.equal(
    I18N_MESSAGES["zh-CN"] && I18N_MESSAGES["zh-CN"].view && I18N_MESSAGES["zh-CN"].view.welcome.greeting,
    "今天你想整理什么？",
  );
  assert.equal(
    I18N_MESSAGES.en && I18N_MESSAGES.en.view && I18N_MESSAGES.en.view.input.placeholder,
    "Type your message...",
  );
  assert.equal(I18N_MESSAGES.ru.settings.language.optionRu, "Русский");
  assert.equal(I18N_MESSAGES.ru.view.home.heroHeading, "Начните день здесь");
  assert.equal(I18N_MESSAGES.ru.view.home.quickActions, "Быстрые действия");
  assert.equal(I18N_MESSAGES.ru.settings.agent.providerName, "Провайдер");
  assert.equal(I18N_MESSAGES.ru.settings.skills.heading, "Управление Skills");
  assert.equal(I18N_MESSAGES.ru.settings.templates.labelDaily, "Ежедневная заметка");
  assert.equal(I18N_MESSAGES.en.settings.providerAuth.heading, "Provider Auth Management (OAuth / API Key)");
  assert.equal(I18N_MESSAGES.en.settings.agent.providerLabels["openai-compat-custom"], "Custom OpenAI-compatible");
  assert.equal(I18N_MESSAGES.ru.settings.providerAuth.heading, "Управление авторизацией провайдеров (OAuth / API Key)");
  assert.equal(I18N_MESSAGES.ru.settings.agent.providerLabels["openai-compat-custom"], "Собственный OpenAI-compatible");
  assert.equal(I18N_MESSAGES.ru.mobile.capture.title, "Быстрая запись");
  assert.equal(I18N_MESSAGES.ru.modals.permission.title, "AI хочет внести изменение");
});

test("i18n messages should keep zh/en/ru key structure aligned", () => {
  const locales = ["zh-CN", "en", "ru"];
  const flattened = Object.fromEntries(locales.map((locale) => [locale, flattenMessages(I18N_MESSAGES[locale])]));
  const allKeys = [...new Set(locales.flatMap((locale) => Object.keys(flattened[locale])))].sort();

  for (const locale of locales) {
    const missing = allKeys.filter((key) => !Object.prototype.hasOwnProperty.call(flattened[locale], key));
    assert.deepEqual(missing, [], `${locale} should define every i18n key`);
  }
  assert.equal(Object.keys(flattened["zh-CN"]).length, Object.keys(flattened.en).length);
  assert.equal(Object.keys(flattened.en).length, Object.keys(flattened.ru).length);
});

test("i18n messages should not leak translated scripts into the wrong locale", () => {
  const enMessages = flattenMessages(I18N_MESSAGES.en);
  const ruMessages = flattenMessages(I18N_MESSAGES.ru);
  const cjk = /[\u3400-\u9fff]/;
  const cyrillic = /[\u0400-\u04ff]/;
  const allowedCjkKeys = new Set([
    "settings.language.optionZhCN",
    "view.home.homeDocumentMissing",
  ]);

  const enCjk = Object.entries(enMessages)
    .filter(([key, value]) => cjk.test(value) && !allowedCjkKeys.has(key))
    .map(([key]) => key)
    .sort();
  const ruCjk = Object.entries(ruMessages)
    .filter(([key, value]) => cjk.test(value) && !allowedCjkKeys.has(key))
    .map(([key]) => key)
    .sort();
  const enCyrillic = Object.entries(enMessages)
    .filter(([key, value]) => cyrillic.test(value) && key !== "settings.language.optionRu")
    .map(([key]) => key)
    .sort();

  assert.deepEqual(enCjk, []);
  assert.deepEqual(ruCjk, []);
  assert.deepEqual(enCyrillic, []);
});

test("runtime translation calls should have zh/en/ru message coverage", () => {
  const runtimeRoot = path.join(__dirname, "../../runtime");
  const localeMessages = {
    "zh-CN": flattenMessages(I18N_MESSAGES["zh-CN"]),
    en: flattenMessages(I18N_MESSAGES.en),
    ru: flattenMessages(I18N_MESSAGES.ru),
  };
  const keys = new Map();
  const callRegex = /\b(?:t|tr)\(\s*(?:[^,\n]+,\s*)?["']([a-z][a-zA-Z0-9_.-]+)["']/g;
  for (const file of walkRuntimeJs(runtimeRoot)) {
    const rel = path.relative(path.join(__dirname, "../.."), file);
    const source = fs.readFileSync(file, "utf8");
    let match;
    while ((match = callRegex.exec(source))) {
      const key = match[1];
      if (!keys.has(key)) keys.set(key, []);
      keys.get(key).push(rel);
    }
  }

  const ignored = /^(settings\.mobileCapture\.resolverProvider\.|url\.|parser\.|sk-\.\.\.|settings\.agent\.apiKeyPlaceholder$|mobile\.settings\.providerKeyLinkPrefix$)/;
  for (const [locale, messages] of Object.entries(localeMessages)) {
    const missing = [...keys.keys()]
      .filter((key) => !ignored.test(key))
      .filter((key) => !Object.prototype.hasOwnProperty.call(messages, key))
      .sort();

    assert.deepEqual(missing, [], `${locale} should cover every runtime translation call`);
  }
});
