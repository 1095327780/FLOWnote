const test = require("node:test");
const assert = require("node:assert/strict");

const { parseMethods } = require("../../runtime/view/question/parse-methods");
const { InlineAskUserQuestionPanel } = require("../../runtime/inline-ask-user-question-panel");
const { I18N_MESSAGES } = require("../../runtime/i18n-messages");

function createParseContext() {
  return { ...parseMethods };
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
});
