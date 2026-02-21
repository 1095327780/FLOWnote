const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeSessionTitleInput,
  isPlaceholderSessionTitle,
  deriveSessionTitleFromPrompt,
  resolveSessionDisplayTitle,
} = require("../../runtime/domain/session-title");
const { SessionStore } = require("../../runtime/session-store");

test("session title domain should normalize and detect placeholder titles", () => {
  assert.equal(normalizeSessionTitleInput("  New   session  "), "New session");
  assert.equal(isPlaceholderSessionTitle("新会话"), true);
  assert.equal(isPlaceholderSessionTitle("未命名会话 - 2026/02/21"), true);
  assert.equal(isPlaceholderSessionTitle("项目周报整理"), false);
});

test("session title domain should derive title from prompt and resolve display title", () => {
  const derived = deriveSessionTitleFromPrompt("/ah-note 今天复盘项目里程碑并整理风险项");
  assert.equal(derived, "今天复盘项目里程碑并整理风险项");

  const display = resolveSessionDisplayTitle({
    title: "New session - 2026-02-21T03:59:31.476Z",
    lastUserPrompt: "请帮我总结本周产品迭代和下周计划",
  });
  assert.equal(display, "请帮我总结本周产品迭代和下周计划");
});

test("session store static title helpers should stay in sync with domain helpers", () => {
  const prompt = "/skill-selector 继续推进插件架构重构计划";
  assert.equal(SessionStore.normalizeSessionTitleInput("  A   B  "), normalizeSessionTitleInput("  A   B  "));
  assert.equal(SessionStore.isPlaceholderTitle("untitled"), isPlaceholderSessionTitle("untitled"));
  assert.equal(SessionStore.deriveTitleFromPrompt(prompt), deriveSessionTitleFromPrompt(prompt));
});
