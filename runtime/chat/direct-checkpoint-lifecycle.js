const { ContinuationCheckpointStore } = require("./continuation-checkpoint-store");

function createContinuationCheckpointStore(plugin, vault, override) {
  if (override !== undefined) return override;
  if (!vault || !vault.adapter) return null;
  const manifest = plugin && plugin.manifest ? plugin.manifest : {};
  const configDir = String(vault.configDir || ".obsidian").replace(/^\/+|\/+$/g, "");
  const pluginId = String(manifest.id || "flownote").trim() || "flownote";
  const dir = String(manifest.dir || `${configDir}/plugins/${pluginId}`).trim();
  try {
    return new ContinuationCheckpointStore({ vault, manifest: { ...manifest, dir } });
  } catch (_error) {
    return null;
  }
}

function checkpointReferenceIsStillNeeded(sessionStore, checkpointRef) {
  if (!sessionStore || typeof sessionStore.state !== "function" || !checkpointRef) return true;
  return collectLiveCheckpointRefs(sessionStore).some((ref) => (
    ref.id === checkpointRef.id && ref.path === checkpointRef.path
  ));
}

function collectLiveCheckpointRefs(sessionStore) {
  if (!sessionStore || typeof sessionStore.state !== "function") return [];
  const state = sessionStore.state();
  const messagesBySession = state && state.messagesBySession;
  if (!messagesBySession || typeof messagesBySession !== "object") return [];
  const refs = [];
  const seen = new Set();
  for (const messages of Object.values(messagesBySession)) {
    for (const message of Array.isArray(messages) ? messages : []) {
      if (
        !message
        || message.role !== "assistant"
        || String(message.status || "") !== "suspended"
        || String(message.continuationConsumedBy || "").trim()
      ) continue;
      const events = message.execution && message.execution.version === 1
        ? message.execution.events
        : [];
      for (const event of Array.isArray(events) ? events : []) {
        if (!event || event.type !== "run_suspended") continue;
        const ref = normalizeLiveCheckpointRef(event.checkpointRef);
        if (!ref) continue;
        const key = `${ref.id}\n${ref.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push(ref);
      }
    }
  }
  return refs;
}

function normalizeLiveCheckpointRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) return null;
  const id = String(value.id || "");
  const hash = id.startsWith("sha256:") ? id.slice(7) : "";
  const path = String(value.path || "").replace(/\\+/g, "/");
  const byteLength = Number(value.byteLength);
  if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(byteLength) || byteLength < 1) return null;
  if (path.startsWith("/") || path.split("/").some((part) => part === "..")) return null;
  if (!path.endsWith(`/continuations/${hash}.json`)) return null;
  return { version: 1, id: `sha256:${hash}`, path, byteLength };
}

async function sweepOrphanedContinuationCheckpoints(plugin, options = {}) {
  if (!plugin || !plugin.sessionStore || !plugin.app || !plugin.app.vault) return null;
  const store = createContinuationCheckpointStore(plugin, plugin.app.vault);
  if (!store || typeof store.sweep !== "function") return null;
  return store.sweep(collectLiveCheckpointRefs(plugin.sessionStore), options);
}

function continuationStoreUnavailableError() {
  const error = new Error("Continuation checkpoint storage is unavailable.");
  error.code = "CONTINUATION_CHECKPOINT_STORE_UNAVAILABLE";
  return error;
}

module.exports = {
  createContinuationCheckpointStore,
  collectLiveCheckpointRefs,
  checkpointReferenceIsStillNeeded,
  sweepOrphanedContinuationCheckpoints,
  continuationStoreUnavailableError,
};
