const test = require("node:test");
const assert = require("node:assert/strict");

const { blockUtilsInternal } = require("../../runtime/view/message/block-utils");
const { toPartBlock } = require("../../runtime/payload/assistant-parts-utils");

const {
  extractPatchFileEntries,
  summarizePatchChanges,
  patchFileDisplayPath,
  withInferredPatchActions,
  normalizePatchDiffEntry,
  inferPatchActionFromDiff,
  buildPatchLineDiff,
  splitPatchDiffHunks,
  countPatchDiffStats,
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
  assert.equal(summarizePatchChanges(entries), "5 个文件变更");
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
  assert.equal(summarizePatchChanges(entries), "5 个文件变更");
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

test("toPartBlock should map stream-text part to markdown detail block", () => {
  const block = toPartBlock({
    id: "prt_stream_text",
    type: "stream-text",
    text: "第一行\n\n- 列表项",
    time: { start: Date.now() },
  }, 0);

  assert.equal(block.type, "stream-text");
  assert.equal(block.title, "中间输出");
  assert.equal(block.status, "running");
  assert.equal(block.detail, "第一行\n\n- 列表项");
});

test("withInferredPatchActions should keep entries unchanged", () => {
  const entries = [
    { action: "unknown", path: "a.md" },
    { action: "added", path: "b.md" },
  ];
  const message = { blocks: [{ type: "tool", tool: "write" }] };

  const inferred = withInferredPatchActions(entries, message, 1);

  assert.equal(inferred[0].action, "unknown");
  assert.equal(Boolean(inferred[0].inferred), false);
  assert.equal(inferred[1].action, "added");
  assert.equal(Boolean(inferred[1].inferred), false);
  assert.equal(summarizePatchChanges(inferred), "2 个文件变更");
});

test("normalizePatchDiffEntry should normalize file diff payload", () => {
  const normalized = normalizePatchDiffEntry({
    filePath: "src/main.ts",
    before: "a\nb\n",
    after: "a\nb\nc\n",
    additions: "1",
    deletions: 0,
  });
  assert.ok(normalized);
  assert.equal(normalized.file, "src/main.ts");
  assert.equal(normalized.additions, 1);
  assert.equal(normalized.deletions, 0);
  assert.equal(typeof normalized.before, "string");
  assert.equal(typeof normalized.after, "string");
});

test("normalizePatchDiffEntry should keep file diff even when before/after is missing", () => {
  const normalized = normalizePatchDiffEntry({
    file: "src/main.ts",
    additions: 3,
    deletions: 1,
  });
  assert.ok(normalized);
  assert.equal(normalized.file, "src/main.ts");
  assert.equal(normalized.additions, 3);
  assert.equal(normalized.deletions, 1);
});

test("normalizePatchDiffEntry should clamp oversized before/after snapshots", () => {
  const huge = "x".repeat(120000);
  const normalized = normalizePatchDiffEntry({
    file: "src/huge.ts",
    before: huge,
    after: huge,
  });
  assert.ok(normalized);
  assert.equal(typeof normalized.before, "string");
  assert.equal(typeof normalized.after, "string");
  assert.equal(normalized.before.length < huge.length, true);
  assert.equal(normalized.after.length < huge.length, true);
  assert.match(normalized.before, /truncated/i);
});

test("inferPatchActionFromDiff should infer from before/after payload", () => {
  assert.equal(inferPatchActionFromDiff({ before: "", after: "x" }), "added");
  assert.equal(inferPatchActionFromDiff({ before: "x", after: "" }), "deleted");
  assert.equal(inferPatchActionFromDiff({ before: "x", after: "y" }), "modified");
});

test("buildPatchLineDiff should build insert/delete/equal lines", () => {
  const diff = buildPatchLineDiff("a\nb\nc\n", "a\nx\nc\n");
  const types = diff.lines.map((line) => line.type);
  assert.equal(types.includes("equal"), true);
  assert.equal(types.includes("delete"), true);
  assert.equal(types.includes("insert"), true);
  assert.equal(diff.matrixLimited, false);
});

test("buildPatchLineDiff should fallback when matrix exceeds threshold", () => {
  const before = Array.from({ length: 40 }, (_, i) => `before-${i}`).join("\n");
  const after = Array.from({ length: 40 }, (_, i) => `after-${i}`).join("\n");
  const diff = buildPatchLineDiff(before, after, {
    maxMatrixCells: 120,
    maxRenderedLines: 24,
  });
  assert.equal(diff.matrixLimited, true);
  assert.equal(diff.lines.length <= 24, true);
  assert.equal(diff.truncated, true);
});

test("buildPatchLineDiff should return empty lines when before/after is empty", () => {
  const diff = buildPatchLineDiff("", "", { maxRenderedLines: 320 });
  assert.equal(Array.isArray(diff.lines), true);
  assert.equal(diff.lines.length, 0);
  assert.equal(diff.matrixLimited, false);
});

test("splitPatchDiffHunks should split hunks with context lines", () => {
  const diff = buildPatchLineDiff(
    "a\nb\nc\nd\ne\nf\ng\n",
    "a\nb\nx\nd\ne\ny\ng\n",
    { maxMatrixCells: 120000, maxRenderedLines: 320 },
  );
  const hunks = splitPatchDiffHunks(diff.lines, { contextLines: 1 });
  assert.equal(Array.isArray(hunks), true);
  assert.equal(hunks.length >= 1, true);
  assert.equal(hunks[0].oldStart >= 1, true);
  assert.equal(hunks[0].newStart >= 1, true);
});

test("countPatchDiffStats should prefer explicit counts then fallback to line diff", () => {
  const explicit = countPatchDiffStats({ additions: 7, deletions: 2 }, []);
  assert.deepEqual(explicit, { added: 7, removed: 2 });

  const fallback = countPatchDiffStats({}, [
    { type: "equal", text: "a" },
    { type: "insert", text: "b" },
    { type: "delete", text: "c" },
    { type: "insert", text: "d" },
  ]);
  assert.deepEqual(fallback, { added: 2, removed: 1 });
});
