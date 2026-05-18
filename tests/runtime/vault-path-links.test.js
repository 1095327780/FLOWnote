const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractVaultPathMatchesFromText,
  normalizeVaultPathCandidate,
  resolveVaultPathCandidate,
} = require("../../runtime/view/message/vault-path-links");

function makeContext(paths, options = {}) {
  const files = new Map(paths.map((path) => [path, { path }]));
  return {
    app: {
      vault: {
        adapter: {
          basePath: options.basePath || "/Users/shanghao/Documents/Obsidian/shanghao",
        },
        getAbstractFileByPath(path) {
          return files.get(path) || null;
        },
        getFiles() {
          return Array.from(files.values());
        },
      },
      metadataCache: {
        getFirstLinkpathDest(linktext) {
          return files.get(linktext) || null;
        },
      },
    },
    getMarkdownRenderSourcePath() {
      return "";
    },
  };
}

test("normalizeVaultPathCandidate keeps a vault-relative markdown path", () => {
  assert.equal(
    normalizeVaultPathCandidate("01-捕获层/每日笔记/2026-05-18.md"),
    "01-捕获层/每日笔记/2026-05-18.md",
  );
});

test("normalizeVaultPathCandidate strips labels and sentence punctuation", () => {
  assert.equal(
    normalizeVaultPathCandidate("文件：01-捕获层/每日笔记/2026-05-18.md。"),
    "01-捕获层/每日笔记/2026-05-18.md",
  );
});

test("normalizeVaultPathCandidate resolves absolute paths inside the vault", () => {
  assert.equal(
    normalizeVaultPathCandidate(
      "/Users/shanghao/Documents/Obsidian/shanghao/01-捕获层/每日笔记/2026-05-18.md",
      { vaultBasePath: "/Users/shanghao/Documents/Obsidian/shanghao" },
    ),
    "01-捕获层/每日笔记/2026-05-18.md",
  );
});

test("normalizeVaultPathCandidate rejects external URLs", () => {
  assert.equal(normalizeVaultPathCandidate("https://example.com/readme.md"), "");
});

test("extractVaultPathMatchesFromText finds inline completion paths", () => {
  const text = "✅ 今日日记已创建 → `01-捕获层/每日笔记/2026-05-18.md`";
  assert.deepEqual(extractVaultPathMatchesFromText(text), [
    {
      start: 13,
      end: 38,
      path: "01-捕获层/每日笔记/2026-05-18.md",
      text: "01-捕获层/每日笔记/2026-05-18.md",
    },
  ]);
});

test("extractVaultPathMatchesFromText supports Chinese labels and markdown fragments", () => {
  const text = "- 文件：01-捕获层/每日笔记/2026-05-18.md#任务";
  assert.deepEqual(extractVaultPathMatchesFromText(text), [
    {
      start: 5,
      end: 33,
      path: "01-捕获层/每日笔记/2026-05-18.md#任务",
      text: "01-捕获层/每日笔记/2026-05-18.md#任务",
    },
  ]);
});

test("resolveVaultPathCandidate returns a link only for real vault files", () => {
  const context = makeContext(["01-捕获层/每日笔记/2026-05-18.md"]);
  assert.equal(
    resolveVaultPathCandidate(context, "01-捕获层/每日笔记/2026-05-18.md"),
    "01-捕获层/每日笔记/2026-05-18.md",
  );
  assert.equal(
    resolveVaultPathCandidate(context, "01-捕获层/每日笔记/2099-01-01.md"),
    "",
  );
});

test("resolveVaultPathCandidate preserves heading fragments", () => {
  const context = makeContext(["01-捕获层/每日笔记/2026-05-18.md"]);
  assert.equal(
    resolveVaultPathCandidate(context, "01-捕获层/每日笔记/2026-05-18.md#任务"),
    "01-捕获层/每日笔记/2026-05-18.md#任务",
  );
});
