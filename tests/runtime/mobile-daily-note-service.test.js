const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadDailyNoteServiceWithMockObsidian() {
  const originalLoad = Module._load;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") {
      return {
        normalizePath(path) {
          return String(path || "");
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const servicePath = require.resolve("../../runtime/mobile/daily-note-service");
  delete require.cache[servicePath];
  const service = require(servicePath);

  return {
    ...service,
    restore() {
      Module._load = originalLoad;
      delete require.cache[servicePath];
    },
  };
}

function createMemoryVault(initialContent) {
  let content = String(initialContent || "");
  return {
    async read() {
      return content;
    },
    async modify(_file, nextContent) {
      content = String(nextContent || "");
    },
    getContent() {
      return content;
    },
  };
}

test("appendToIdeaSection should append capture to ## 记录 section", async () => {
  const fixture = loadDailyNoteServiceWithMockObsidian();
  try {
    const vault = createMemoryVault(`# 2026-03-03

## 记录
- 09:00 旧内容

## 晚间回顾
`);
    await fixture.appendToIdeaSection(vault, { path: "x.md" }, "- 10:00 新捕获", "## 记录");
    const output = vault.getContent();
    const sectionStart = output.indexOf("## 记录");
    const newEntry = output.indexOf("- 10:00 新捕获");
    const oldEntry = output.indexOf("- 09:00 旧内容");
    assert.equal(sectionStart !== -1, true);
    assert.equal(newEntry > sectionStart, true);
    assert.equal(newEntry > oldEntry, true);
  } finally {
    fixture.restore();
  }
});

test("appendToIdeaSection should avoid injecting duplicate ## 记录 header into legacy record section", async () => {
  const fixture = loadDailyNoteServiceWithMockObsidian();
  try {
    const vault = createMemoryVault(`# 2026-03-03

## 📝 今日记录

### 💡 想法和灵感
- 09:00 旧内容

## 🔄 每日回顾
`);
    await fixture.appendToIdeaSection(vault, { path: "x.md" }, "- 10:00 新捕获", "## 记录");
    const output = vault.getContent();
    const marker = "## 📝 今日记录";
    assert.equal(output.includes("\n## 记录\n"), false);
    assert.equal(output.includes(marker), true);
    assert.equal(output.indexOf("- 10:00 新捕获") > output.indexOf(marker), true);
  } finally {
    fixture.restore();
  }
});
