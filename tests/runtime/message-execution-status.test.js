const test = require("node:test");
const assert = require("node:assert/strict");

const { executionStatusLabel } = require("../../runtime/view/message/execution-status");

function view(locale) {
  return { plugin: { getEffectiveLocale: () => locale } };
}

test("execution status labels are concise user recovery copy, not runtime terminology", () => {
  assert.equal(executionStatusLabel(view("zh-CN"), "cancelled"), "已取消");
  assert.equal(executionStatusLabel(view("zh-CN"), "suspended"), "已暂停，可继续");
  assert.equal(executionStatusLabel(view("zh-CN"), "blocked"), "未完成，请检查失败项");
  assert.equal(executionStatusLabel(view("zh-CN"), "interrupted"), "运行中断，请检查更改");
  assert.equal(executionStatusLabel(view("en"), "failed"), "Not completed");
  assert.equal(executionStatusLabel(view("en"), "blocked"), "Not completed — check failed steps");
  assert.equal(executionStatusLabel(view("en"), "suspended"), "Paused — ready to continue");
  assert.equal(executionStatusLabel(view("en"), "completed"), "");
});
