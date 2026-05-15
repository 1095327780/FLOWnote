// One-time silent migration of the skill directory from the OpenCode-era
// `.opencode/skills/` to FLOWnote-native `.flownote/skills/`, per
// design-doc §8.2.
//
// Behavior:
//   * Idempotent — if `.flownote/skills/` already exists, return without
//     touching anything.
//   * Source `.opencode/skills/` is LEFT IN PLACE so users who keep the
//     opencode-legacy provider mode still see their skills.
//   * Auto-updates `settings.skillsDir` only when it still equals the
//     OpenCode-era default; otherwise the user has customized the path
//     and we don't override their choice.
//   * Failures never throw outward — the caller logs and continues
//     plugin load.

const OLD_DIR = ".opencode/skills";
const NEW_DIR = ".flownote/skills";

/**
 * @param {Object} plugin   Obsidian plugin instance (must expose `.app.vault`
 *                          and `.settings`)
 * @param {Object} [opts]
 * @param {string} [opts.oldDir]
 * @param {string} [opts.newDir]
 * @returns {Promise<{migrated: boolean, reason?: string, copied?: number}>}
 */
async function migrateSkillDir(plugin, opts = {}) {
  if (!plugin || !plugin.app || !plugin.app.vault) {
    return { migrated: false, reason: "no plugin/vault" };
  }
  const adapter = plugin.app.vault.adapter;
  if (!adapter || typeof adapter.exists !== "function") {
    return { migrated: false, reason: "no vault adapter" };
  }
  const oldDir = opts.oldDir || OLD_DIR;
  const newDir = opts.newDir || NEW_DIR;

  const newExists = await adapter.exists(newDir);
  if (newExists) return { migrated: false, reason: "target exists" };

  const oldExists = await adapter.exists(oldDir);
  if (!oldExists) return { migrated: false, reason: "source missing" };

  const copied = await copyDirRecursive(adapter, oldDir, newDir);

  // Bump settings.skillsDir IF the user is still on the OpenCode-era default.
  // Anything else — we assume the user customized it on purpose.
  if (plugin.settings) {
    const current = String(plugin.settings.skillsDir || "").trim();
    if (!current || current === OLD_DIR) {
      plugin.settings.skillsDir = newDir;
      if (typeof plugin.saveSettings === "function") {
        try { await plugin.saveSettings(); } catch { /* swallow */ }
      }
      // Drop the cached SkillRegistry so the next agent turn re-scans.
      plugin.__flownoteSkillCache = null;
    }
  }

  return { migrated: true, copied };
}

/**
 * Recursive copy of an Obsidian adapter directory.
 *
 * The Vault adapter API is intentionally small. We use:
 *   adapter.list(path)         → { folders: string[], files: string[] }
 *   adapter.read(path)         → string
 *   adapter.write(path, data)  → void
 *   adapter.mkdir(path)        → void  (creates intermediates)
 *
 * Returns the count of files copied (folders not counted).
 *
 * @param {Object} adapter
 * @param {string} src
 * @param {string} dst
 * @returns {Promise<number>}
 */
async function copyDirRecursive(adapter, src, dst) {
  await adapter.mkdir(dst);
  let copied = 0;
  /** @type {Array<[string, string]>} */
  const stack = [[src, dst]];
  while (stack.length > 0) {
    const [srcDir, dstDir] = stack.pop();
    let listing;
    try {
      listing = await adapter.list(srcDir);
    } catch {
      continue;
    }
    if (!listing) continue;
    const files = Array.isArray(listing.files) ? listing.files : [];
    const folders = Array.isArray(listing.folders) ? listing.folders : [];
    for (const srcPath of files) {
      const relName = baseName(srcPath);
      const dstPath = joinPath(dstDir, relName);
      try {
        const data = await adapter.read(srcPath);
        await adapter.write(dstPath, data);
        copied += 1;
      } catch {
        // skip unreadable file; continue
      }
    }
    for (const srcSub of folders) {
      const relName = baseName(srcSub);
      const dstSub = joinPath(dstDir, relName);
      try { await adapter.mkdir(dstSub); } catch { /* ignore */ }
      stack.push([srcSub, dstSub]);
    }
  }
  return copied;
}

function baseName(p) {
  const s = String(p || "").replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i < 0 ? s : s.slice(i + 1);
}

function joinPath(a, b) {
  return `${String(a).replace(/\/+$/, "")}/${String(b).replace(/^\/+/, "")}`;
}

module.exports = {
  migrateSkillDir,
  copyDirRecursive,
  OLD_DIR,
  NEW_DIR,
};
