const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { parseMethods } = require("../../runtime/view/question/parse-methods");
const { inlinePanelMethods } = require("../../runtime/view/question/inline-panel-methods");
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

test("inline question tabs use roving focus while ordinary Tab remains native", () => {
  const panel = new InlineAskUserQuestionPanel({}, {}, () => {}, null, {
    immediateSelect: false,
  });
  panel.questions = [{}, {}];

  const switched = [];
  panel.switchTab = (index) => switched.push(index);
  let prevented = 0;
  let stopped = 0;
  panel.handleTabKeyDown({
    key: "ArrowRight",
    preventDefault() { prevented += 1; },
    stopPropagation() { stopped += 1; },
  }, 2);
  assert.deepEqual(switched, [0], "ArrowRight should wrap from the submit tab to the first tab");
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);

  prevented = 0;
  stopped = 0;
  const handled = panel.handleNavigationKey({
    key: "Tab",
    preventDefault() { prevented += 1; },
    stopPropagation() { stopped += 1; },
  }, 1);
  assert.equal(handled, false);
  assert.equal(prevented, 0, "Tab should remain available to leave the tab list naturally");
  assert.equal(stopped, 0);
});

test("switching an inline question tab focuses the newly active tab", () => {
  const panel = new InlineAskUserQuestionPanel({}, {}, () => {}, null, {
    immediateSelect: false,
  });
  panel.questions = [{}, {}];
  panel.activeTabIndex = 0;
  let rootFocusCount = 0;
  let activeTabFocusCount = 0;
  panel.rootEl = { focus() { rootFocusCount += 1; } };
  panel.renderTabBar = () => {
    panel.tabElements = [
      { focus() {} },
      { focus() { activeTabFocusCount += 1; } },
      { focus() {} },
    ];
  };
  panel.renderTabContent = () => {};

  panel.switchTab(1);

  assert.equal(activeTabFocusCount, 1);
  assert.equal(rootFocusCount, 0);
});

test("i18n messages should include localized home view copy", () => {
  assert.equal(
    I18N_MESSAGES["zh-CN"] && I18N_MESSAGES["zh-CN"].view && I18N_MESSAGES["zh-CN"].view.welcome.greeting,
    "今天你想整理什么？",
  );
  assert.equal(
    I18N_MESSAGES.en && I18N_MESSAGES.en.view && I18N_MESSAGES.en.view.input.placeholder,
    "Type a message, or type / to trigger skills...",
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
  assert.doesNotMatch(I18N_MESSAGES.ru.settings.agent.regionDesc, /\b(?:International|endpoint)\b/i);
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

test("inline question panel uses localized accessible controls without forced smooth motion", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../runtime/inline-ask-user-question-panel.js"), "utf8");
  assert.match(source, /createEl\("button"/);
  assert.match(source, /aria-checked|aria-selected/);
  assert.match(source, /role:\s*["']tablist["']/);
  assert.match(source, /tabindex:\s*idx === this\.activeTabIndex \? ["']0["'] : ["']-1["']/);
  assert.match(source, /["']aria-labelledby["']/);
  assert.match(source, /this\.copy\("submit"/);
  assert.doesNotMatch(source, /Claude has a question/);
  assert.doesNotMatch(source, /behavior:\s*["']smooth["']/);
});

test("inline question review answers are native controls instead of click-only divs", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../runtime/inline-ask-user-question-panel.js"), "utf8");
  const reviewStart = source.indexOf("\n  renderSubmitTab() {");
  const reviewEnd = source.indexOf("\n  getAnswerText(idx) {", reviewStart);
  const reviewSource = source.slice(reviewStart, reviewEnd);

  assert.match(reviewSource, /reviewEl\.createEl\("button",\s*\{\s*cls:\s*"claudian-ask-review-pair"/);
  assert.doesNotMatch(reviewSource, /reviewEl\.createDiv\(\{\s*cls:\s*"claudian-ask-review-pair"/);
});

test("desktop ask-user modal blocks submit until every question has an answer", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../runtime/modals.js"), "utf8");
  const modalStart = source.indexOf("class AskUserQuestionModal");
  const modalEnd = source.indexOf("class PromptAppendModal", modalStart);
  const modalSource = source.slice(modalStart, modalEnd);

  assert.match(modalSource, /isQuestionAnswered\(index\)/);
  assert.match(modalSource, /okBtn\.disabled\s*=\s*questions\.length === 0/);
  assert.match(modalSource, /questions\.some\(\(_q, index\) => !this\.isQuestionAnswered\(index\)\)\) return/);
  assert.match(modalSource, /st\.selectedLabels\.size > 0/);
  assert.match(modalSource, /st\.otherChecked && st\.otherText\.trim\(\)\.length > 0/);
});

test("closing the inline question restores focus to the composer outside teardown", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../runtime/view/question/inline-panel-methods.js"), "utf8");
  assert.match(source, /focusComposerAfterInlineQuestion/);
  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /clearInlineQuestionWidget\(silent = true, options = \{\}\)/);
});

test("inline question focus restoration runs only when explicitly requested", () => {
  const originalRaf = global.requestAnimationFrame;
  let focusCount = 0;
  global.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };
  const composer = {
    hidden: true,
    removeClass() { this.hidden = false; },
    hasClass() { return this.hidden; },
  };
  const context = {
    ...inlinePanelMethods,
    inlineQuestionWidget: null,
    inlineQuestionKey: "question-1",
    elements: {
      composer,
      input: { isConnected: true, focus() { focusCount += 1; } },
      inlineQuestionHost: { removeClass() {}, empty() {} },
    },
  };
  try {
    inlinePanelMethods.clearInlineQuestionWidget.call(context, true);
    assert.equal(focusCount, 0);
    composer.hidden = true;
    inlinePanelMethods.clearInlineQuestionWidget.call(context, true, { restoreFocus: true });
    assert.equal(focusCount, 1);
  } finally {
    global.requestAnimationFrame = originalRaf;
  }
});

test("mobile stylesheet keeps Obsidian's explicit dark theme authoritative and supports reduced motion", () => {
  const css = fs.readFileSync(path.join(__dirname, "../../styles.css"), "utf8");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(css, /@media \(prefers-color-scheme: light\)/);
  assert.doesNotMatch(css, /SYSTEM LIGHT MODE OVERRIDE \(OS-level signal, theme-agnostic\)/);
  assert.doesNotMatch(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*,\s*\*::before/);
  assert.match(css, /\.is-mobile \.oc-header-actions \.oc-icon-btn,[\s\S]{0,500}width:\s*36px;[\s\S]{0,120}height:\s*36px/);
  assert.match(css, /\.is-mobile \.oc-panel-switch-btn\s*\{[\s\S]{0,250}min-height:\s*34px/);
  assert.match(css, /\.is-mobile \.oc-context-link-btn\s*\{[\s\S]{0,250}min-height:\s*34px/);
  assert.match(css, /\.is-mobile \.oc-send-btn\s*\{[\s\S]{0,300}min-height:\s*38px/);
  assert.match(css, /\.is-mobile \.oc-skill-editor-modal[\s\S]{0,1000}min-width:\s*0/);
  assert.match(css, /\.is-mobile \.oc-template-editor-modal[\s\S]{0,1000}min-width:\s*0/);
  assert.match(css, /\.is-mobile \.oc-composer textarea,[\s\S]{0,500}min-height:\s*38px/);
  assert.doesNotMatch(css, /Mobile interaction contract: controls remain discoverable and thumb-sized/);
  assert.match(css, /\.is-mobile \.oc-session-rename-input,[\s\S]{0,500}font-size:\s*16px;[\s\S]{0,200}min-height:\s*44px/);
  assert.match(css, /\.is-mobile \.oc-model-modal-actions button,[\s\S]{0,500}min-height:\s*44px/);
  assert.match(css, /\.is-mobile \.oc-ask-option label[\s\S]{0,160}min-height:\s*44px/);
});

test("session switching is a native button sibling to rename and delete controls", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../runtime/view/layout/sidebar-methods.js"), "utf8");
  assert.match(source, /createEl\("button",\s*\{\s*cls:\s*"oc-session-item-switch"/);
  assert.match(source, /switchAttrs\["aria-current"\]/);
  assert.doesNotMatch(source, /itemAttrs\s*=\s*\{[^}]*role:\s*"button"/);
  assert.doesNotMatch(source, /item\.addEventListener\("keydown"/);
  assert.match(source, /aria-current/);
});
