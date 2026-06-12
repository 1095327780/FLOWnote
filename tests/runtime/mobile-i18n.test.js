const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadMobileModulesWithMockObsidian(options = {}) {
  const originalLoad = Module._load;
  const requestUrl = typeof options.requestUrl === "function"
    ? options.requestUrl
    : async () => ({
      status: 200,
      json: { choices: [{ message: { content: "ok" } }] },
      text: "",
    });

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") {
      return {
        normalizePath(path) {
          return String(path || "");
        },
        requestUrl,
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
    assert.match(zhPrompt, /语音转录清理助手/);
    assert.match(zhPrompt, /语音识别错字/);
    assert.match(zhPrompt, /不要新增原文没有的观点/);
    assert.match(enPrompt, /voice-transcript cleanup assistant/i);
    assert.match(enPrompt, /speech-recognition mistakes/i);
    const ruPrompt = fixture.getCaptureSystemPrompt("ru-RU");
    assert.match(ruPrompt, /голосовой расшифровки/i);
    assert.match(ruPrompt, /ошибки распознавания речи/i);
  } finally {
    fixture.restore();
  }
});

test("daily note template should switch by locale", () => {
  const fixture = loadMobileModulesWithMockObsidian();
  try {
    const zhTpl = fixture.getDailyNoteTemplate("zh-CN");
    const enTpl = fixture.getDailyNoteTemplate("en-US");
    const ruTpl = fixture.getDailyNoteTemplate("ru-RU");
    assert.match(zhTpl, /## 📝 记录/);
    assert.match(enTpl, /## 📝 Records/);
    assert.match(ruTpl, /## 📝 Записи/);
  } finally {
    fixture.restore();
  }
});

test("summary fallback should switch by locale", () => {
  const fixture = loadMobileModulesWithMockObsidian();
  try {
    assert.equal(fixture.summaryFallback("zh-CN"), "暂无法解析，已保留原始链接");
    assert.equal(fixture.summaryFallback("ru-RU"), "Не удалось обработать, исходная ссылка сохранена");
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
    const ruEntry = fixture.formatCaptureEntry("10:00", enText, { locale: "ru-RU" });
    assert.match(ruEntry, /Краткое описание URL/);
  } finally {
    fixture.restore();
  }
});

test("cleanupCapture should call configured mobile capture provider", async () => {
  let capturedRequest = null;
  const fixture = loadMobileModulesWithMockObsidian({
    requestUrl: async (request) => {
      capturedRequest = request;
      return {
        status: 200,
        json: { choices: [{ message: { content: "开会，记录关键结论" } }] },
        text: "",
      };
    },
  });
  try {
    const result = await fixture.cleanupCapture("嗯，就是开会，记录关键结论", {
      provider: "deepseek",
      apiKey: "sk-test-mobile-capture",
      baseUrl: "",
      model: "",
    }, { locale: "zh-CN" });

    assert.equal(result, "开会，记录关键结论");
    assert.equal(capturedRequest.url, "https://api.deepseek.com/chat/completions");
    assert.equal(capturedRequest.method, "POST");
    assert.equal(capturedRequest.headers.Authorization, "Bearer sk-test-mobile-capture");
    const body = JSON.parse(capturedRequest.body);
    assert.equal(body.model, "deepseek-v4-flash");
    assert.equal(body.messages[0].role, "system");
    assert.match(body.messages[0].content, /语音转录清理助手/);
    assert.match(body.messages[0].content, /重复、自我修正/);
    assert.equal(body.messages[1].content, "嗯，就是开会，记录关键结论");
  } finally {
    fixture.restore();
  }
});

test("listCaptureModels should call provider model endpoint", async () => {
  let capturedRequest = null;
  const fixture = loadMobileModulesWithMockObsidian({
    requestUrl: async (request) => {
      capturedRequest = request;
      return {
        status: 200,
        json: {
          object: "list",
          data: [
            { id: "deepseek-v4-pro", object: "model", owned_by: "deepseek" },
            { id: "deepseek-v4-flash", object: "model", owned_by: "deepseek" },
          ],
        },
        text: "",
      };
    },
  });
  try {
    const models = await fixture.listCaptureModels({
      provider: "deepseek",
      apiKey: "sk-test-mobile-capture",
      baseUrl: "",
      model: "",
    }, { locale: "zh-CN" });

    assert.equal(capturedRequest.url, "https://api.deepseek.com/models");
    assert.equal(capturedRequest.method, "GET");
    assert.equal(capturedRequest.headers.Authorization, "Bearer sk-test-mobile-capture");
    assert.deepEqual(models.map((m) => m.id), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  } finally {
    fixture.restore();
  }
});

test("OpenRouter mobile preset uses the OpenAI-compatible free router endpoint", async () => {
  let capturedRequest = null;
  const fixture = loadMobileModulesWithMockObsidian({
    requestUrl: async (request) => {
      capturedRequest = request;
      return {
        status: 200,
        json: { choices: [{ message: { content: "Cleaned text" } }] },
        text: "",
      };
    },
  });
  try {
    const result = await fixture.cleanupCapture("um quick note", {
      provider: "openrouter",
      apiKey: "sk-or-test",
      baseUrl: "",
      model: "",
    }, { locale: "en" });

    assert.equal(result, "Cleaned text");
    assert.equal(capturedRequest.url, "https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(capturedRequest.body);
    assert.equal(body.model, "openrouter/free");
  } finally {
    fixture.restore();
  }
});

test("capture settings should keep mobile key first and only fall back when empty", () => {
  const fixture = loadMobileModulesWithMockObsidian();
  try {
    const fromMobile = fixture.resolveEffectiveCaptureSettings({
      mobileCapture: {
        provider: "deepseek",
        apiKey: "sk-mobile",
      },
      agentProvider: {
        direct: {
          providerId: "deepseek",
          apiKeys: { deepseek: "sk-agent" },
        },
      },
    });
    assert.equal(fromMobile.apiKey, "sk-mobile");

    const fallback = fixture.resolveEffectiveCaptureSettings({
      mobileCapture: {
        provider: "deepseek",
        apiKey: "",
      },
      agentProvider: {
        direct: {
          providerId: "deepseek",
          apiKeys: { deepseek: "sk-agent" },
        },
      },
    });
    assert.equal(fallback.apiKey, "sk-agent");
  } finally {
    fixture.restore();
  }
});
