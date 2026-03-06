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

function createTemplateAwareVault(options = {}) {
  const existing = new Map();
  const created = new Map();
  const folders = [];

  const existingFiles = options.existingFiles && typeof options.existingFiles === "object"
    ? options.existingFiles
    : {};
  for (const [rawPath, rawContent] of Object.entries(existingFiles)) {
    existing.set(String(rawPath || ""), String(rawContent || ""));
  }

  return {
    adapter: {
      async exists(path) {
        const key = String(path || "");
        return existing.has(key) || created.has(key);
      },
      async read(path) {
        const key = String(path || "");
        if (created.has(key)) return created.get(key);
        if (existing.has(key)) return existing.get(key);
        throw new Error(`missing file: ${key}`);
      },
    },
    getAbstractFileByPath(path) {
      const key = String(path || "");
      if (created.has(key) || existing.has(key)) return { path: key };
      return null;
    },
    async read(file) {
      if (!file || !file.path) throw new Error("missing file path");
      const key = String(file.path || "");
      if (created.has(key)) return created.get(key);
      if (existing.has(key)) return existing.get(key);
      throw new Error(`missing file: ${key}`);
    },
    async createFolder(path) {
      folders.push(String(path || ""));
    },
    async create(path, content) {
      const key = String(path || "");
      const value = String(content || "");
      created.set(key, value);
      return { path: key };
    },
    getCreatedContent(path) {
      return created.get(String(path || ""));
    },
    getCreatedPaths() {
      return [...created.keys()];
    },
    getCreatedFolders() {
      return [...folders];
    },
  };
}

test("appendToIdeaSection should append capture to ## 📝 记录 section", async () => {
  const fixture = loadDailyNoteServiceWithMockObsidian();
  try {
    const vault = createMemoryVault(`# 2026-03-03

## 📝 记录
- 09:00 旧内容

## 晚间回顾
`);
    await fixture.appendToIdeaSection(vault, { path: "x.md" }, "- 10:00 新捕获", "## 📝 记录");
    const output = vault.getContent();
    const sectionStart = output.indexOf("## 📝 记录");
    const newEntry = output.indexOf("- 10:00 新捕获");
    const oldEntry = output.indexOf("- 09:00 旧内容");
    assert.equal(sectionStart !== -1, true);
    assert.equal(newEntry > sectionStart, true);
    assert.equal(newEntry > oldEntry, true);
  } finally {
    fixture.restore();
  }
});

test("findOrCreateDailyNote should prefer ah-note skill template when available", async () => {
  const fixture = loadDailyNoteServiceWithMockObsidian();
  try {
    const skillTemplate = `---
创建时间: YYYY-MM-DD
类型: 每日笔记
---

# YYYY-MM-DD 星期X

## 今天最重要的事
写今天唯一最重要的一件事，要求可执行且可在今天推进。
`;
    const vault = createTemplateAwareVault({
      existingFiles: {
        ".opencode/skills/ah-note/assets/每日笔记模板.md": skillTemplate,
      },
    });

    const created = await fixture.findOrCreateDailyNote(vault, "01-捕获层/每日笔记", "2026-03-04", {
      locale: "zh-CN",
      skillsDir: ".opencode/skills",
    });
    const content = vault.getCreatedContent("01-捕获层/每日笔记/2026-03-04.md");
    assert.equal(Boolean(created && created.path), true);
    assert.equal(content.includes("写今天唯一最重要的一件事"), true);
    assert.equal(content.includes("# 2026-03-04 星期三"), true);
    assert.equal(content.includes("YYYY-MM-DD"), false);
    assert.equal(content.includes("星期X"), false);
  } finally {
    fixture.restore();
  }
});

test("findOrCreateDailyNote should fallback to built-in template when skill template is missing", async () => {
  const fixture = loadDailyNoteServiceWithMockObsidian();
  try {
    const vault = createTemplateAwareVault();
    await fixture.findOrCreateDailyNote(vault, "01-捕获层/每日笔记", "2026-03-05", {
      locale: "zh-CN",
      skillsDir: ".opencode/skills",
    });
    const content = vault.getCreatedContent("01-捕获层/每日笔记/2026-03-05.md");
    assert.equal(content.includes("创建时间: 2026-03-05"), true);
    assert.equal(content.includes("## 📝 记录"), true);
  } finally {
    fixture.restore();
  }
});

test("appendToIdeaSection should avoid injecting duplicate record header for legacy target header", async () => {
  const fixture = loadDailyNoteServiceWithMockObsidian();
  try {
    const vault = createMemoryVault(`# 2026-03-03

## 📝 记录
写白天发生的重要进展、想法或事件。

## 🔄 每日回顾
`);
    await fixture.appendToIdeaSection(vault, { path: "x.md" }, "- 10:00 新捕获", "## 记录");
    const output = vault.getContent();
    const marker = "## 📝 记录";
    assert.equal(output.includes("\n## 记录\n"), false);
    assert.equal(output.includes(marker), true);
    assert.equal(output.indexOf("- 10:00 新捕获") > output.indexOf(marker), true);
    assert.equal(
      output.indexOf("写白天发生的重要进展、想法或事件。") < output.indexOf("- 10:00 新捕获"),
      true,
    );
  } finally {
    fixture.restore();
  }
});
