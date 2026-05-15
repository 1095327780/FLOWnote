const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSystemPrompt,
  getLocalISODate,
  describeToday,
} = require("../../../runtime/chat/direct-agent-runner");

test("getLocalISODate uses local-timezone YYYY-MM-DD, zero-padded", () => {
  // Pick a date with a single-digit month/day to exercise padStart.
  const d = new Date(2026, 0, 5, 14, 0, 0); // Jan 5 2026, local
  assert.equal(getLocalISODate(d), "2026-01-05");
});

test("getLocalISODate(now=undefined) returns the current date in expected format", () => {
  const s = getLocalISODate();
  assert.match(s, /^\d{4}-\d{2}-\d{2}$/);
});

test("describeToday appends the Chinese weekday label", () => {
  // 2026-05-15 is a Friday → 星期五.
  const d = new Date(2026, 4, 15, 12, 0, 0);
  assert.equal(describeToday(d), "2026-05-15 (星期五)");
});

test("buildSystemPrompt omits the Context block when no opts given", () => {
  const out = buildSystemPrompt([]);
  assert.doesNotMatch(out, /Context:/);
});

test("buildSystemPrompt includes currentDate when opts.todayLabel is set", () => {
  const out = buildSystemPrompt([], { todayLabel: "2026-05-15 (星期五)" });
  assert.match(out, /# currentDate/);
  assert.match(out, /2026-05-15 \(星期五\)/);
  assert.match(out, /相对时间/);
});

test("buildSystemPrompt includes vault block when opts.vaultName is set", () => {
  const out = buildSystemPrompt([], { vaultName: "shanghao" });
  assert.match(out, /# vault/);
  assert.match(out, /当前 Obsidian 库名：shanghao/);
});

test("buildSystemPrompt appends the skill listing after Context", () => {
  const out = buildSystemPrompt(
    [{ name: "ah-card", description: "Card crafter", body: "" }],
    { todayLabel: "2026-05-15 (星期五)" },
  );
  const ctxIdx = out.indexOf("# currentDate");
  const skillIdx = out.indexOf("Available skills");
  assert.ok(ctxIdx > 0 && skillIdx > 0, "both sections must be present");
  assert.ok(skillIdx > ctxIdx, "skills must come after Context");
  assert.match(out, /- ah-card:/);
});

test("buildSystemPrompt with empty skills + opts still produces context", () => {
  const out = buildSystemPrompt([], { todayLabel: "2026-05-15 (星期五)" });
  assert.match(out, /# currentDate/);
  assert.doesNotMatch(out, /Available skills/);
});
