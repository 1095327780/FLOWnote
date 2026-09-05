const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const { terminalUserMessage } = require("../../runtime/view/message/terminal-user-message");
const { I18N_MESSAGES } = require("../../runtime/i18n-messages");

function fakeEl() {
  return {
    children: [],
    dataset: {},
    createDiv(options = {}) {
      const child = fakeEl();
      child.cls = options.cls || "";
      child.text = options.text || "";
      this.children.push(child);
      return child;
    },
    createEl(_tag, options = {}) { return this.createDiv(options); },
    addClass() {},
    removeClass() {},
    setText(value) { this.text = String(value || ""); },
  };
}

function loadMessageListMethods() {
  const originalLoad = Module._load;
  const modulePath = require.resolve("../../runtime/view/message/message-list-methods");
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") return { Notice: class {}, Platform: {}, setIcon() {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[modulePath];
  const loaded = require(modulePath);
  Module._load = originalLoad;
  delete require.cache[modulePath];
  return loaded.messageListMethods;
}

function execution(terminalType) {
  return {
    version: 1,
    events: [
      { seq: 0, time: 1, type: "run_started", runId: "r1" },
      { seq: 1, time: 2, type: terminalType, runId: "r1" },
    ],
  };
}

function interruptedMutationExecution() {
  return {
    version: 1,
    events: [
      { seq: 0, time: 1, type: "run_started", runId: "r1" },
      {
        seq: 1,
        time: 2,
        type: "tool_started",
        runId: "r1",
        toolUseId: "write-1",
        tool: "vault_write",
        capabilities: { effect: "vault_mutation", presentation: "edit", targets: ["Daily.md"] },
      },
      { seq: 2, time: 3, type: "run_interrupted", runId: "r1", reason: "unknown_after_reload" },
    ],
  };
}

test("a failed assistant turn with activity but no prose is projected as a retryable outcome", () => {
  assert.equal(
    terminalUserMessage({ role: "assistant", status: "failed", blocks: [{}] }),
    "terminalFailed",
  );
});

test("a durable suspended execution projects continuation instead of a generic placeholder", () => {
  assert.equal(
    terminalUserMessage({ role: "assistant", blocks: [{}], execution: execution("run_suspended") }),
    "terminalSuspended",
  );
});

test("a completed execution without a final answer is never presented as a normal structured response", () => {
  assert.equal(
    terminalUserMessage({ role: "assistant", blocks: [{}], execution: execution("run_completed") }),
    "terminalMissingFinal",
  );
});

test("legacy structured-only assistant messages tell the user that a final answer is missing", () => {
  assert.equal(
    terminalUserMessage({ role: "assistant", reasoning: "thinking", blocks: [{}] }),
    "terminalMissingFinal",
  );
});

test("explicit terminal statuses take precedence over incomplete or legacy execution details", () => {
  const cases = [
    ["suspended", "terminalSuspended"],
    ["blocked", "terminalBlocked"],
    ["cancelled", "terminalCancelled"],
    ["interrupted", "terminalInterrupted"],
  ];
  for (const [status, expected] of cases) {
    assert.equal(terminalUserMessage({ role: "assistant", status, error: "stale provider error", blocks: [{}] }), expected);
  }
  assert.equal(
    terminalUserMessage({ role: "assistant", error: "network error", blocks: [{}], execution: execution("run_completed") }),
    "terminalFailed",
  );
});

test("an interrupted mutation tells the user its result is unknown", () => {
  assert.equal(
    terminalUserMessage({
      role: "assistant",
      status: "interrupted",
      blocks: [{}],
      execution: interruptedMutationExecution(),
    }),
    "terminalInterruptedMutation",
  );
  assert.equal(
    terminalUserMessage({ role: "assistant", blocks: [{}], execution: interruptedMutationExecution() }),
    "terminalInterruptedMutation",
  );
  assert.equal(
    terminalUserMessage({
      role: "assistant",
      status: "interrupted",
      text: "The write started.",
      blocks: [{}],
      execution: interruptedMutationExecution(),
    }),
    "terminalInterruptedMutation",
  );
});

test("terminal projection preserves real prose and does not create copy for non-assistant or empty messages", () => {
  assert.equal(terminalUserMessage({ role: "assistant", text: "Done", blocks: [{}] }), "");
  assert.equal(terminalUserMessage({ role: "user", blocks: [{}] }), "");
  assert.equal(terminalUserMessage({ role: "assistant" }), "");
});

test("terminal recovery copy is concise and localized for every supported locale", () => {
  assert.equal(I18N_MESSAGES["zh-CN"].view.message.terminalFailed, "这次回复未完成，可重试。");
  assert.equal(I18N_MESSAGES.en.view.message.terminalMissingFinal, "No final answer was returned. Try again.");
  assert.equal(I18N_MESSAGES.ru.view.message.terminalSuspended, "Приостановлено. Можно продолжить.");
  const keys = [
    "terminalFailed",
    "terminalSuspended",
    "terminalBlocked",
    "terminalCancelled",
    "terminalInterrupted",
    "terminalInterruptedMutation",
    "terminalMissingFinal",
  ];
  for (const locale of ["zh-CN", "en", "ru"]) {
    for (const key of keys) assert.ok(I18N_MESSAGES[locale].view.message[key], `${locale} is missing ${key}`);
    assert.doesNotMatch(I18N_MESSAGES[locale].view.message.terminalMissingFinal, /structured output|function.?call|provider_stream_error/i);
  }
});

test("message rendering replaces internal failure details with the localized recovery outcome", () => {
  const messageListMethods = loadMessageListMethods();
  const parent = fakeEl();
  const context = {
    plugin: {
      t(key, _params, options) {
        const value = key.split(".").reduce((current, part) => current && current[part], I18N_MESSAGES["zh-CN"]);
        return value || options.defaultValue;
      },
    },
    visibleAssistantBlocks(blocks) { return Array.isArray(blocks) ? blocks : []; },
    hasReasoningBlock() { return false; },
    renderMarkdownSafely(element, text) { element.renderedText = text; },
    enhanceCodeBlocks() {},
    addTextCopyButton() {},
    ensureReasoningContainer() { return null; },
    removeStandaloneReasoningContainer() {},
    renderAssistantBlocks() {},
    renderAssistantMeta() {},
    reorderAssistantMessageLayout() {},
  };
  messageListMethods.renderMessageItem.call(context, parent, {
    id: "a1",
    role: "assistant",
    status: "failed",
    error: "provider_stream_error",
    blocks: [{ type: "tool" }],
  });
  const row = parent.children[0];
  const body = row.children[1];
  assert.equal(body.children[0].renderedText, "这次回复未完成，可重试。");
  assert.doesNotMatch(JSON.stringify(row), /provider_stream_error/);
});

test("message rendering preserves partial prose and appends the unknown-mutation warning", () => {
  const messageListMethods = loadMessageListMethods();
  const parent = fakeEl();
  const context = {
    plugin: {
      t(key, _params, options) {
        const value = key.split(".").reduce((current, part) => current && current[part], I18N_MESSAGES.en);
        return value || options.defaultValue;
      },
    },
    visibleAssistantBlocks(blocks) { return Array.isArray(blocks) ? blocks : []; },
    hasReasoningBlock() { return false; },
    renderMarkdownSafely(element, text) { element.renderedText = text; },
    enhanceCodeBlocks() {},
    addTextCopyButton() {},
    ensureReasoningContainer() { return null; },
    removeStandaloneReasoningContainer() {},
    renderAssistantBlocks() {},
    renderAssistantMeta() {},
    reorderAssistantMessageLayout() {},
  };
  messageListMethods.renderMessageItem.call(context, parent, {
    id: "a1",
    role: "assistant",
    status: "interrupted",
    text: "The write started.",
    blocks: [{ type: "tool" }],
    execution: interruptedMutationExecution(),
  });

  const rendered = parent.children[0].children[1].children[0].renderedText;
  assert.match(rendered, /The write started\./);
  assert.match(rendered, /change may have taken effect/i);
});
