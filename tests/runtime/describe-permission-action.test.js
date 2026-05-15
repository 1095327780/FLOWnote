const test = require("node:test");
const assert = require("node:assert/strict");

// Pure module — no Obsidian deps — so we can require it directly.
const { describePermissionAction } = require("../../runtime/permission-action-description");

const noT = undefined; // no i18n function → fallback strings (Chinese defaults)

test("vault_write create → user-friendly create sentence", () => {
  const out = describePermissionAction(
    { type: "vault_write", metadata: { path: "notes/x.md", mode: "create" } },
    noT,
  );
  assert.equal(out, "新建笔记 notes/x.md");
});

test("vault_write overwrite mentions replacement", () => {
  const out = describePermissionAction(
    { type: "vault_write", metadata: { path: "notes/x.md", mode: "overwrite" } },
    noT,
  );
  assert.match(out, /覆盖笔记 notes\/x\.md/);
  assert.match(out, /替换原内容/);
});

test("vault_write append → 'append to end' phrasing", () => {
  const out = describePermissionAction(
    { type: "vault_write", metadata: { path: "x.md", mode: "append" } },
    noT,
  );
  assert.match(out, /末尾追加内容/);
});

test("vault_edit → 'edit a portion'", () => {
  const out = describePermissionAction(
    { type: "vault_edit", metadata: { path: "x.md" } },
    noT,
  );
  assert.match(out, /修改笔记 x\.md 的部分内容/);
});

test("vault_move includes both from and to in the sentence", () => {
  const out = describePermissionAction(
    { type: "vault_move", metadata: { from: "old.md", to: "new.md" } },
    noT,
  );
  assert.match(out, /old\.md/);
  assert.match(out, /new\.md/);
  assert.match(out, /移动或重命名/);
});

test("vault_property set → property name in quotes", () => {
  const out = describePermissionAction(
    { type: "vault_property", metadata: { path: "x.md", op: "set", name: "status" } },
    noT,
  );
  assert.match(out, /设置属性「status」/);
  assert.match(out, /x\.md/);
});

test("vault_property delete distinguishes from set", () => {
  const out = describePermissionAction(
    { type: "vault_property", metadata: { path: "x.md", op: "delete", name: "status" } },
    noT,
  );
  assert.match(out, /删除属性/);
});

test("vault_daily create includes the date", () => {
  const out = describePermissionAction(
    { type: "vault_daily", metadata: { mode: "create", date: "2026-05-15" } },
    noT,
  );
  assert.match(out, /2026-05-15/);
  assert.match(out, /创建.*日记/);
});

test("vault_daily without explicit date says '今天'", () => {
  const out = describePermissionAction(
    { type: "vault_daily", metadata: { mode: "create" } },
    noT,
  );
  assert.match(out, /今天/);
});

test("vault_create_dir → user-friendly folder sentence", () => {
  const out = describePermissionAction(
    { type: "vault_create_dir", metadata: { path: "04-创造层/新项目" } },
    noT,
  );
  assert.match(out, /新建文件夹 04-创造层\/新项目/);
});

test("unknown tool falls back to the pattern string if present", () => {
  const out = describePermissionAction(
    { type: "some_future_tool", pattern: "do the thing → here", metadata: {} },
    noT,
  );
  assert.equal(out, "do the thing → here");
});

test("unknown tool with no pattern uses generic fallback", () => {
  const out = describePermissionAction(
    { type: "some_future_tool", metadata: {} },
    noT,
  );
  assert.match(out, /执行/);
  assert.match(out, /some_future_tool/);
});

test("missing tool type still produces a non-empty string", () => {
  const out = describePermissionAction({}, noT);
  assert.equal(typeof out, "string");
  assert.ok(out.length > 0);
});

test("English locale via custom t function returns English fallbacks", () => {
  const tEn = (key, params, opts) => {
    const EN_MAP = {
      "modals.permission.action.write_create": "Create a new note at {path}",
      "modals.permission.action.write_overwrite": "Overwrite {path} (replaces the current contents)",
    };
    let s = EN_MAP[key] || (opts && opts.defaultValue) || key;
    for (const [k, v] of Object.entries(params || {})) {
      s = s.split(`{${k}}`).join(String(v));
    }
    return s;
  };
  const create = describePermissionAction(
    { type: "vault_write", metadata: { path: "x.md", mode: "create" } },
    tEn,
  );
  assert.equal(create, "Create a new note at x.md");
  const overwrite = describePermissionAction(
    { type: "vault_write", metadata: { path: "x.md", mode: "overwrite" } },
    tEn,
  );
  assert.match(overwrite, /Overwrite x\.md/);
});
