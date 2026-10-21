// Host measurement of what one agent turn actually changed in the vault.
//
// Tool results and model prose describe intent; this module measures the
// vault itself. Every write API handed to tools is instrumented so the state
// of a path is captured before its first mutation. Obsidian vault events catch
// writes that bypass those APIs (another agent runtime writing to disk, link
// updates after a rename, other plugins). The measured net change is the only
// source for "files changed in this turn".

const { contentFingerprint } = require("./file-state-cache");

const MAX_SNAPSHOT_TEXT = 1_000_000;
const DIFF_CONTEXT_LINES = 3;
const MAX_EXCERPT_CHARS = 12_000;
const EVENT_TYPES = ["create", "modify", "delete", "rename"];

// Each mapper returns the path-like arguments a call may change.
const VAULT_MUTATORS = Object.freeze({
  create: (path) => [path],
  createBinary: (path) => [path],
  createFolder: (path) => [path],
  modify: (file) => [file],
  modifyBinary: (file) => [file],
  append: (file) => [file],
  process: (file) => [file],
  delete: (file) => [file],
  trash: (file) => [file],
  rename: (file, newPath) => [file, newPath],
  copy: (_file, newPath) => [newPath],
});
const FILE_MANAGER_MUTATORS = Object.freeze({
  processFrontMatter: (file) => [file],
  renameFile: (file, newPath) => [file, newPath],
  trashFile: (file) => [file],
});
const RENAME_METHODS = new Set(["rename", "renameFile"]);

function normalizePath(value) {
  return String(value || "")
    .replace(/\\+/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .trim();
}

function pathOf(value) {
  if (typeof value === "string") return normalizePath(value);
  if (value && typeof value.path === "string") return normalizePath(value.path);
  return "";
}

function lookupEntry(vault, path) {
  if (!vault || !path) return null;
  if (typeof vault.getAbstractFileByPath === "function") return vault.getAbstractFileByPath(path) || null;
  if (typeof vault.getFileByPath === "function") {
    const file = vault.getFileByPath(path);
    if (file) return file;
  }
  if (typeof vault.getFolderByPath === "function") {
    const folder = vault.getFolderByPath(path);
    if (folder) return { ...folder, children: Array.isArray(folder.children) ? folder.children : [] };
  }
  return null;
}

async function snapshotPath(vault, path) {
  const entry = lookupEntry(vault, path);
  if (!entry) return { exists: false };
  if (Array.isArray(entry.children)) return { exists: true, kind: "folder" };
  try {
    const raw = typeof vault.read === "function" ? await vault.read(entry) : await vault.cachedRead(entry);
    const text = typeof raw === "string" ? raw : String(raw === undefined || raw === null ? "" : raw);
    return {
      exists: true,
      kind: "file",
      hash: contentFingerprint(text),
      text: text.length <= MAX_SNAPSHOT_TEXT ? text : null,
    };
  } catch (_error) {
    // Unreadable content cannot prove equality; treat it as distinct state.
    return { exists: true, kind: "file", hash: `unreadable:${Date.now()}:${Math.random()}`, text: null };
  }
}

function splitLines(text) {
  return String(text || "").replace(/\r/g, "").split("\n");
}

// Keep only the changed region plus context so persisted message blocks stay
// small. `startLine` lets the renderer show real line numbers.
function diffExcerpt(beforeText, afterText) {
  if (typeof beforeText !== "string" || typeof afterText !== "string") return null;
  const before = beforeText ? splitLines(beforeText) : [];
  const after = afterText ? splitLines(afterText) : [];
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;
  const start = Math.max(0, prefix - DIFF_CONTEXT_LINES);
  const beforeEnd = Math.min(before.length, before.length - suffix + DIFF_CONTEXT_LINES);
  const afterEnd = Math.min(after.length, after.length - suffix + DIFF_CONTEXT_LINES);
  const excerptBefore = before.slice(start, beforeEnd).join("\n");
  const excerptAfter = after.slice(start, afterEnd).join("\n");
  if (excerptBefore.length + excerptAfter.length > MAX_EXCERPT_CHARS) return null;
  return {
    before: excerptBefore,
    after: excerptAfter,
    startLine: start + 1,
    added: Math.max(0, after.length - suffix - prefix),
    removed: Math.max(0, before.length - suffix - prefix),
  };
}

function compareSnapshots(path, pre, post) {
  if (!pre || !post) return null;
  if (!pre.exists && post.exists) {
    if (post.kind === "folder") return { path, op: "created", kind: "folder" };
    return { path, op: "created", kind: "file", diff: diffExcerpt("", post.text) };
  }
  if (pre.exists && !post.exists) {
    if (pre.kind === "folder") return { path, op: "deleted", kind: "folder" };
    return { path, op: "deleted", kind: "file" };
  }
  if (!pre.exists || !post.exists) return null;
  if (pre.kind === "folder" || post.kind === "folder") {
    return pre.kind === post.kind ? null : { path, op: "modified", kind: post.kind };
  }
  if (pre.hash === post.hash) return null;
  return { path, op: "modified", kind: "file", diff: diffExcerpt(pre.text, post.text) };
}

function opFromEvents(ops, exists) {
  if (!exists) return "deleted";
  if (ops.has("create")) return "created";
  return "modified";
}

function pairRenames(changes, renames) {
  const out = changes.slice();
  for (const rename of renames) {
    const fromIndex = out.findIndex((change) => change.path === rename.from && change.op === "deleted");
    const toIndex = out.findIndex((change) => change.path === rename.to && change.op === "created");
    if (fromIndex === -1 || toIndex === -1) continue;
    const from = out[fromIndex];
    const to = out[toIndex];
    const merged = {
      path: rename.to,
      from: rename.from,
      op: "renamed",
      kind: to.kind || from.kind,
      toolUseIds: [...new Set([...(from.toolUseIds || []), ...(to.toolUseIds || [])])],
      source: to.source || from.source,
    };
    out[toIndex] = merged;
    out.splice(fromIndex, 1);
  }
  return out;
}

/**
 * @param {Object} args
 * @param {Object} args.vault  The real Obsidian Vault. Events subscribe here.
 * @param {boolean} [args.observeEvents=true]
 * @param {boolean} [args.attributeUnwindowedEvents=false]
 *   true when another runtime (OpenCode) performs the writes, so every vault
 *   event during the turn belongs to the agent. Direct mode keeps events that
 *   happen outside a tool window apart as external (e.g. the user typing).
 */
function createVaultChangeRecorder({ vault, observeEvents = true, attributeUnwindowedEvents = false } = {}) {
  if (!vault) throw new Error("createVaultChangeRecorder: vault required");
  const baseline = new Map();
  const order = [];
  const attribution = new Map();
  const windows = new Map();
  const observed = new Map();
  const renames = [];
  const eventRefs = [];
  let activeToolUseId = null;
  let observing = false;

  function attribute(path, toolUseId) {
    if (!toolUseId) return;
    if (!attribution.has(path)) attribution.set(path, new Set());
    attribution.get(path).add(toolUseId);
  }

  function remember(path) {
    if (!path) return Promise.resolve();
    let created = false;
    if (!baseline.has(path)) {
      order.push(path);
      baseline.set(path, snapshotPath(vault, path));
      created = true;
    }
    const waits = [baseline.get(path)];
    const window = activeToolUseId ? windows.get(activeToolUseId) : null;
    if (window && !window.pre.has(path)) {
      window.pre.set(path, created ? baseline.get(path) : snapshotPath(vault, path));
    }
    if (window) waits.push(window.pre.get(path));
    attribute(path, activeToolUseId);
    return Promise.all(waits);
  }

  function wrap(target, mutators) {
    return new Proxy(target, {
      get(object, key) {
        const value = Reflect.get(object, key, object);
        if (typeof value !== "function") return value;
        const mapper = Object.prototype.hasOwnProperty.call(mutators, key) ? mutators[key] : null;
        if (!mapper) return value.bind(object);
        return async (...args) => {
          const paths = mapper(...args).map(pathOf).filter(Boolean);
          await Promise.all(paths.map(remember));
          if (RENAME_METHODS.has(key) && paths.length === 2) {
            renames.push({ from: paths[0], to: paths[1], toolUseId: activeToolUseId });
          }
          return value.apply(object, args);
        };
      },
    });
  }

  function instrumentApp(app) {
    if (!app) return app;
    const vaultProxy = app.vault ? wrap(app.vault, VAULT_MUTATORS) : app.vault;
    const fileManagerProxy = app.fileManager ? wrap(app.fileManager, FILE_MANAGER_MUTATORS) : app.fileManager;
    return new Proxy(app, {
      get(object, key) {
        if (key === "vault") return vaultProxy;
        if (key === "fileManager") return fileManagerProxy;
        const value = Reflect.get(object, key, object);
        return typeof value === "function" ? value.bind(object) : value;
      },
    });
  }

  function onVaultEvent(type, file, oldPath) {
    const path = pathOf(file);
    const paths = type === "rename" ? [pathOf(oldPath), path] : [path];
    for (const candidate of paths) {
      if (!candidate) continue;
      const record = observed.get(candidate) || { ops: new Set(), toolUseIds: new Set(), external: false };
      record.ops.add(type === "rename" && candidate === paths[0] ? "delete" : type === "rename" ? "create" : type);
      if (activeToolUseId) record.toolUseIds.add(activeToolUseId);
      else record.external = true;
      observed.set(candidate, record);
    }
    if (type === "rename" && paths[0] && path) {
      renames.push({ from: paths[0], to: path, toolUseId: activeToolUseId });
    }
  }

  function start() {
    if (observing || !observeEvents || typeof vault.on !== "function") return;
    observing = true;
    for (const type of EVENT_TYPES) {
      eventRefs.push(vault.on(type, (file, oldPath) => onVaultEvent(type, file, oldPath)));
    }
  }

  function stop() {
    if (!observing) return;
    observing = false;
    for (const ref of eventRefs.splice(0)) {
      try {
        if (typeof vault.offref === "function") vault.offref(ref);
      } catch (_error) {
        // Unsubscribing is best effort; the recorder ignores late events.
      }
    }
  }

  function beginTool(toolUseId) {
    const id = String(toolUseId || "");
    if (!id) return;
    activeToolUseId = id;
    windows.set(id, { pre: new Map() });
  }

  /** Net change of every path touched while this tool was active. */
  async function endTool(toolUseId) {
    const id = String(toolUseId || "");
    if (activeToolUseId === id) activeToolUseId = null;
    const window = windows.get(id);
    if (!window) return [];
    const changes = [];
    for (const [path, prePromise] of window.pre) {
      const change = compareSnapshots(path, await prePromise, await snapshotPath(vault, path));
      if (change) changes.push({ ...change, toolUseIds: [id], source: "host_write" });
    }
    for (const [path, record] of observed) {
      if (window.pre.has(path) || !record.toolUseIds.has(id)) continue;
      const post = await snapshotPath(vault, path);
      changes.push({ path, op: opFromEvents(record.ops, post.exists), kind: post.kind || "file", toolUseIds: [id], source: "vault_event" });
    }
    return pairRenames(changes, renames.filter((rename) => rename.toolUseId === id));
  }

  /**
   * Net vault change of the whole turn, compared with the state each path had
   * when this turn first touched it. Stops event observation.
   */
  async function finalize({ settleMs = 0 } = {}) {
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
    stop();
    return snapshot();
  }

  /** Net change so far, without ending observation. */
  async function snapshot() {
    const changes = [];
    const external = [];
    for (const path of order) {
      const change = compareSnapshots(path, await baseline.get(path), await snapshotPath(vault, path));
      if (!change) continue;
      const record = observed.get(path);
      const toolUseIds = new Set([...(attribution.get(path) || []), ...((record && record.toolUseIds) || [])]);
      changes.push({ ...change, toolUseIds: [...toolUseIds], source: "host_write" });
    }
    for (const [path, record] of observed) {
      if (baseline.has(path)) continue;
      const post = await snapshotPath(vault, path);
      const change = {
        path,
        op: opFromEvents(record.ops, post.exists),
        kind: post.kind || "file",
        toolUseIds: [...record.toolUseIds],
        source: "vault_event",
      };
      if (change.op === "created" && post.kind === "file") change.diff = diffExcerpt("", post.text);
      if (record.toolUseIds.size > 0 || attributeUnwindowedEvents) changes.push(change);
      else external.push(change);
    }
    return { changes: pairRenames(changes, renames), external };
  }

  return { instrumentApp, beginTool, endTool, start, stop, snapshot, finalize };
}

/** Compact, model-safe view of measured changes (no content). */
function describeChanges(changes) {
  return (Array.isArray(changes) ? changes : []).map((change) => {
    const base = { path: change.path, op: change.op };
    if (change.from) base.from = change.from;
    if (change.kind === "folder") base.kind = "folder";
    return base;
  });
}

module.exports = {
  createVaultChangeRecorder,
  describeChanges,
  diffExcerpt,
  __internals: { compareSnapshots, snapshotPath, pairRenames },
};
