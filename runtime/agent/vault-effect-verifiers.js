function verification(verified, detail = "") {
  return {
    verified: verified === true,
    outcome: verified === true ? "verified" : "postcondition_failed",
    ...(detail ? { detail } : {}),
  };
}

async function readVaultText(vault, path) {
  if (!vault || !path || typeof vault.getFileByPath !== "function") return null;
  const file = vault.getFileByPath(path);
  if (!file) return null;
  if (typeof vault.cachedRead === "function") return String(await vault.cachedRead(file));
  if (typeof vault.read === "function") return String(await vault.read(file));
  return null;
}

function expectedCachedText(ctx, path) {
  const cache = ctx && ctx.fileStateCache;
  if (!cache || typeof cache.get !== "function") return null;
  const entry = cache.get(path);
  return entry && entry.writtenInTurn && typeof entry.content === "string" ? entry.content : null;
}

async function verifyTextEffect({ vault, path, expected, suffix, contains }) {
  const actual = await readVaultText(vault, path);
  if (actual === null) return verification(false, "file_missing_after_effect");
  if (typeof expected === "string") return verification(actual === expected);
  if (typeof suffix === "string") return verification(actual.endsWith(suffix));
  if (typeof contains === "string") return verification(actual.includes(contains));
  return verification(false, "missing_expected_postcondition");
}

function verifyPathExists(vault, path) {
  const get = vault && typeof vault.getAbstractFileByPath === "function"
    ? (value) => vault.getAbstractFileByPath(value)
    : vault && typeof vault.getFileByPath === "function"
      ? (value) => vault.getFileByPath(value)
      : () => null;
  return verification(!!path && !!get(path));
}

function verifyPathTransition(vault, from, to) {
  const get = vault && typeof vault.getAbstractFileByPath === "function"
    ? (value) => vault.getAbstractFileByPath(value)
    : vault && typeof vault.getFileByPath === "function"
      ? (value) => vault.getFileByPath(value)
      : () => null;
  return verification(!!to && !get(from) && !!get(to));
}

async function verifyFrontmatterEffect({ app, path, name, op, value }) {
  const vault = app && app.vault;
  const file = vault && typeof vault.getFileByPath === "function" ? vault.getFileByPath(path) : null;
  if (!file) return verification(false, "file_missing_after_effect");
  let frontmatter = null;
  if (app.fileManager && typeof app.fileManager.processFrontMatter === "function") {
    await app.fileManager.processFrontMatter(file, (current) => { frontmatter = { ...current }; });
  } else if (app.metadataCache && typeof app.metadataCache.getFileCache === "function") {
    const cached = app.metadataCache.getFileCache(file);
    frontmatter = cached && cached.frontmatter ? { ...cached.frontmatter } : null;
  }
  if (!frontmatter) return verification(false, "frontmatter_unavailable");
  if (op === "delete") {
    return verification(!Object.prototype.hasOwnProperty.call(frontmatter, name));
  }
  return verification(
    Object.prototype.hasOwnProperty.call(frontmatter, name)
      && JSON.stringify(frontmatter[name]) === JSON.stringify(value),
  );
}

function throwIfToolAborted(ctx, stage = "before_commit") {
  if (!ctx || !ctx.signal || !ctx.signal.aborted) return;
  const error = new Error(`Tool execution cancelled at ${stage}.`);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  throw error;
}

module.exports = {
  expectedCachedText,
  verifyTextEffect,
  verifyPathExists,
  verifyPathTransition,
  verifyFrontmatterEffect,
  throwIfToolAborted,
};
