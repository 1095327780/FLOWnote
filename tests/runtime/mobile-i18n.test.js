const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadMobileModulesWithMockObsidian() {
  const originalLoad = Module._load;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") {
      return {
        normalizePath(path) {
          return String(path || "");
        },
        requestUrl: async () => ({
          status: 200,
          json: { choices: [{ message: { content: "ok" } }] },
          text: "",
        }),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const mobileAiPath = require.resolve("../../runtime/mobile/mobile-ai-service");
  const dailyNotePath = require.resolve("../../runtime/mobile/daily-note-service");
  delete require.cache[mobileAiPath];
  delete require.cache[dailyNotePath];

  const mobileAiService = require(mobileAiPath);
  const dailyNoteService = require(dailyNotePath);

  return {
    ...mobileAiService,
    ...dailyNoteService,
    restore() {
      Module._load = originalLoad;
      delete require.cache[mobileAiPath];
      delete require.cache[dailyNotePath];
    },
  };
}

test("mobile ai prompt should switch by locale", () => {
  const fixture = loadMobileModulesWithMockObsidian();
  try {
    const zhPrompt = fixture.getCaptureSystemPrompt("zh-CN");
    const enPrompt = fixture.getCaptureSystemPrompt("en-US");
    assert.match(zhPrompt, /文字清理助手/);
    assert.match(enPrompt, /text cleanup assistant/i);
  } finally {
    fixture.restore();
  }
});

test("daily note template should switch by locale", () => {
  const fixture = loadMobileModulesWithMockObsidian();
  try {
    const zhTpl = fixture.getDailyNoteTemplate("zh-CN");
    const enTpl = fixture.getDailyNoteTemplate("en-US");
    assert.match(zhTpl, /## 📝 记录/);
    assert.match(enTpl, /## 📝 Records/);
  } finally {
    fixture.restore();
  }
});

test("summary fallback should switch by locale", () => {
  const fixture = loadMobileModulesWithMockObsidian();
  try {
    assert.equal(fixture.summaryFallback("zh-CN"), "暂无法解析，已保留原始链接");
    assert.equal(fixture.summaryFallback("fr-FR"), "Unable to resolve, original URL preserved");
  } finally {
    fixture.restore();
  }
});

test("formatCaptureEntry should parse legacy and english URL placeholder", () => {
  const fixture = loadMobileModulesWithMockObsidian();
  try {
    const zhText = "原文：https://example.com hello\n> 📎 原始URL - 暂无法解析，已保留原始链接";
    const enText = "Original: https://example.com hello\n> 📎 OriginalURL - Unable to resolve, original URL preserved";
    const zhEntry = fixture.formatCaptureEntry("10:00", zhText, { locale: "zh-CN" });
    const enEntry = fixture.formatCaptureEntry("10:00", enText, { locale: "en" });
    assert.match(zhEntry, /链接摘要/);
    assert.match(enEntry, /URL Summary/);
  } finally {
    fixture.restore();
  }
});
