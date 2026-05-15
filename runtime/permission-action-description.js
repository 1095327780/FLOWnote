// Builds a single user-friendly sentence describing what the agent
// wants to do (e.g. "覆盖笔记 notes/x.md（替换原内容）" /
// "Overwrite notes/x.md (replaces current contents)"). Pure — no
// Obsidian / DOM deps so it can be unit-tested without a shim.
//
// The Modal calls this and renders the result as the main body of the
// permission-request UI. Tools that don't have a custom phrase here
// fall through to the tool's own one-line summary, which is still
// readable but more programmer-y.

const { interpolateTemplate } = require("./i18n-runtime");

/**
 * @param {Function | undefined} t        plugin.t (i18n function)
 * @param {string} key
 * @param {string} fallback
 * @param {Object} [params]
 * @returns {string}
 */
function tr(t, key, fallback, params = {}) {
  if (typeof t === "function") {
    return t(key, params, { defaultValue: fallback });
  }
  return interpolateTemplate(fallback, params);
}

/**
 * @param {Object} permission   { type: toolName, pattern: summary, metadata: input, ... }
 * @param {Function} [t]        plugin.t
 * @returns {string}
 */
function describePermissionAction(permission, t) {
  const tool = String(permission && permission.type || "").toLowerCase();
  const input = (permission && permission.metadata) || {};
  const tr_ = (key, fallback, params) => tr(t, key, fallback, params || {});

  const path = typeof input.path === "string" ? input.path : "";

  switch (tool) {
    case "vault_write": {
      const mode = String(input.mode || "create");
      if (mode === "create")
        return tr_("modals.permission.action.write_create", "新建笔记 {path}", { path });
      if (mode === "overwrite")
        return tr_("modals.permission.action.write_overwrite", "覆盖笔记 {path}（替换原内容）", { path });
      if (mode === "append")
        return tr_("modals.permission.action.write_append", "在笔记 {path} 末尾追加内容", { path });
      return tr_("modals.permission.action.write_other", "写入 {path}", { path });
    }
    case "vault_edit":
      return tr_("modals.permission.action.edit", "修改笔记 {path} 的部分内容", { path });
    case "vault_move": {
      const from = typeof input.from === "string" ? input.from : "?";
      const to = typeof input.to === "string" ? input.to : "?";
      return tr_("modals.permission.action.move", "把 {from} 移动或重命名为 {to}", { from, to });
    }
    case "vault_property": {
      const op = String(input.op || "get");
      const name = String(input.name || "");
      if (op === "set")
        return tr_("modals.permission.action.property_set", "在 {path} 设置属性「{name}」", { path, name });
      if (op === "delete")
        return tr_("modals.permission.action.property_delete", "在 {path} 删除属性「{name}」", { path, name });
      return tr_("modals.permission.action.property_other", "修改 {path} 的属性「{name}」", { path, name });
    }
    case "vault_daily": {
      const mode = String(input.mode || "read");
      const date = typeof input.date === "string" ? input.date : "";
      const dateLabel = date || tr_("modals.permission.action.today", "今天");
      if (mode === "create")
        return tr_("modals.permission.action.daily_create", "创建{date}的日记", { date: dateLabel });
      if (mode === "append")
        return tr_("modals.permission.action.daily_append", "在{date}的日记末尾追加内容", { date: dateLabel });
      return tr_("modals.permission.action.daily_other", "操作{date}的日记", { date: dateLabel });
    }
    case "vault_create_dir":
      return tr_("modals.permission.action.create_dir", "新建文件夹 {path}", { path });
    default: {
      if (permission && typeof permission.pattern === "string" && permission.pattern.trim()) {
        return permission.pattern.trim();
      }
      return tr_("modals.permission.action.generic", "执行 {tool} 操作", { tool: tool || "未知" });
    }
  }
}

module.exports = {
  describePermissionAction,
};
