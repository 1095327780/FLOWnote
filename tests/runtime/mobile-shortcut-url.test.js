const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildShortcutUrls,
  getVaultName,
  readTextParam,
  isTruthyParam,
} = require("../../runtime/mobile/shortcut-url-utils");

test("shortcut URL templates should include encoded current vault name", () => {
  const plugin = {
    app: {
      vault: {
        getName: () => "阿浩 Notes",
        adapter: { basePath: "/tmp/ignored" },
      },
    },
  };
  const urls = buildShortcutUrls(plugin);
  assert.equal(getVaultName(plugin), "阿浩 Notes");
  assert.equal(urls.open, "obsidian://flownote-open?vault=%E9%98%BF%E6%B5%A9%20Notes");
  assert.equal(urls.capture, "obsidian://flownote-capture?vault=%E9%98%BF%E6%B5%A9%20Notes&text=");
  assert.equal(urls.captureSubmit, "obsidian://flownote-capture?vault=%E9%98%BF%E6%B5%A9%20Notes&submit=true&text=");
  assert.ok(urls.capture.endsWith("&text="));
  assert.ok(urls.captureSubmit.endsWith("&text="));
  assert.ok(urls.chat.endsWith("&text="));
});

test("shortcut URL helpers should fallback to adapter folder name", () => {
  const plugin = {
    app: {
      vault: {
        adapter: { basePath: "/Users/me/Documents/Obsidian/shanghao" },
      },
    },
  };
  assert.equal(getVaultName(plugin), "shanghao");
});

test("shortcut protocol params should parse text aliases and submit flag", () => {
  assert.equal(readTextParam({ text: " hello " }), "hello");
  assert.equal(readTextParam({ content: "world" }), "world");
  assert.equal(readTextParam({ text: "{{text}}" }), "");
  assert.equal(readTextParam({ text: "%7B%7Btext%7D%7D" }), "");
  assert.equal(isTruthyParam("true"), true);
  assert.equal(isTruthyParam("1"), true);
  assert.equal(isTruthyParam("false"), false);
});
