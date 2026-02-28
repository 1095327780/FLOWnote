const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadMobileServicesWithMockObsidian() {
  const originalLoad = Module._load;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") {
      return {
        normalizePath(pathValue) {
          return String(pathValue || "");
        },
        requestUrl: async () => ({
          status: 500,
          text: "resolver failed",
          json: null,
        }),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const dailyPath = require.resolve("../../runtime/mobile/daily-note-service");
  const urlPath = require.resolve("../../runtime/mobile/mobile-url-summary-service");
  delete require.cache[dailyPath];
  delete require.cache[urlPath];

  const daily = require(dailyPath);
  const url = require(urlPath);

  return {
    ...daily,
    ...url,
    restore() {
      Module._load = originalLoad;
      delete require.cache[dailyPath];
      delete require.cache[urlPath];
    },
  };
}

test("url summary fallback should preserve URL and append fallback line when resolver fails", async () => {
  const fixture = loadMobileServicesWithMockObsidian();
  try {
    const input = "记录一下这个链接 https://example.com/page";
    const result = await fixture.enrichUrlsInText(input, {
      enableUrlSummary: true,
      provider: "deepseek",
      apiKey: "",
      baseUrl: "",
      model: "",
      linkResolver: {
        enabled: true,
        provider: "tianapi",
        providerOrder: ["tianapi"],
        tianapiKey: "fake-key",
        timeoutMs: 1000,
        retries: 0,
        maxConcurrency: 1,
      },
    }, { locale: "zh-CN" });

    assert.match(result.text, /https:\/\/example\.com\/page/);
    assert.match(result.text, />\s*📎\s*https:\/\/example\.com\/page\s*-\s*暂无法解析，已保留原始链接/);
  } finally {
    fixture.restore();
  }
});

test("formatCaptureEntry should keep URL summary output structure", () => {
  const fixture = loadMobileServicesWithMockObsidian();
  try {
    const text = "Original: https://example.com docs\n> 📎 OriginalURL - Unable to resolve, original URL preserved";
    const entry = fixture.formatCaptureEntry("09:30", text, { locale: "en" });
    assert.match(entry, /^- 09:30 /);
    assert.match(entry, /URL Summary/);
  } finally {
    fixture.restore();
  }
});
