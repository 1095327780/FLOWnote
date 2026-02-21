const test = require("node:test");
const assert = require("node:assert/strict");

const { blockUtilsInternal } = require("../../runtime/view/message/block-utils");
const { toPartBlock } = require("../../runtime/payload/assistant-parts-utils");

const {
  extractPatchFileEntries,
  summarizePatchChanges,
  patchFileDisplayPath,
} = blockUtilsInternal;

test("extractPatchFileEntries should classify structured patch entries", () => {
  const entries = extractPatchFileEntries({
    raw: {
      files: [
        { action: "add", path: "a.txt" },
        { status: "M", filePath: "b.txt" },
        { type: "delete", path: "c.txt" },
        { action: "rename", from: "old.txt", to: "new.txt" },
        { action: "copy", from: "base.txt", to: "copy.txt" },
      ],
    },
  });

  assert.deepEqual(entries.map((entry) => entry.action), [
    "added",
    "modified",
    "deleted",
    "renamed",
    "copied",
  ]);
  assert.equal(patchFileDisplayPath(entries[3]), "old.txt -> new.txt");
  assert.equal(summarizePatchChanges(entries), "新增1 · 修改1 · 删除1 · 重命名1 · 复制1");
});

test("extractPatchFileEntries should classify string patch entries", () => {
  const entries = extractPatchFileEntries({
    raw: {
      files: [
        "A src/new.js",
        "M src/edit.js",
        "D src/removed.js",
        "R src/old.js -> src/new-name.js",
        "src/unknown.js",
      ],
    },
  });

  assert.deepEqual(entries.map((entry) => entry.action), [
    "added",
    "modified",
    "deleted",
    "renamed",
    "unknown",
  ]);
  assert.equal(summarizePatchChanges(entries), "新增1 · 修改1 · 删除1 · 重命名1 · 未知1");
});

test("extractPatchFileEntries should merge rename from/to detail lines", () => {
  const entries = extractPatchFileEntries(
    { raw: { files: [] } },
    "- rename from src/old.ts\n- rename to src/new.ts",
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, "renamed");
  assert.equal(patchFileDisplayPath(entries[0]), "src/old.ts -> src/new.ts");
});

test("toPartBlock should preserve structured patch file metadata and readable detail", () => {
  const block = toPartBlock({
    id: "prt_patch",
    type: "patch",
    hash: "abcdef1234567890",
    files: [
      { action: "added", path: "src/new-file.js" },
      { action: "renamed", from: "src/old.js", to: "src/new.js" },
    ],
  }, 0);

  assert.ok(block && block.raw && Array.isArray(block.raw.files));
  assert.equal(typeof block.raw.files[0], "object");
  assert.equal(block.raw.files[0].action, "added");
  assert.match(block.detail, /src\/new-file\.js/);
  assert.match(block.detail, /src\/old\.js -> src\/new\.js/);
  assert.equal(block.detail.includes("[object Object]"), false);
});
