// Durable at-most-once attempt identities for external mutations.
// Entries contain only collision-resistant fingerprints and lifecycle state;
// request bodies, authorization values, and response prose are never stored.

const { canonicalJson, sha256HexAsync } = require("../chat/continuation-checkpoint-store");

const VERSION = 1;
const STATES = new Set(["prepared", "sending", "accepted_unverified", "rejected", "unknown_after_send"]);

async function claimEffectAttempt(ledger, tool, operation) {
  if (!Array.isArray(ledger)) return { ok: false, error: "External effect ledger is unavailable." };
  let hash;
  try { hash = await sha256HexAsync(canonicalJson({ tool: String(tool || ""), operation })); }
  catch (_error) { return { ok: false, error: "External effect identity could not be created." }; }
  const fingerprint = `sha256:${hash}`;
  const existing = ledger.find((entry) => entry && entry.fingerprint === fingerprint);
  if (existing) return { ok: true, duplicate: true, entry: existing };
  const entry = {
    version: VERSION,
    fingerprint,
    tool: String(tool || ""),
    state: "prepared",
    idempotencyKey: `flownote-${hash}`,
  };
  ledger.push(entry);
  return { ok: true, duplicate: false, entry };
}

function normalizeEffectAttempts(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.version !== VERSION) return null;
    const fingerprint = String(raw.fingerprint || "");
    const hash = fingerprint.startsWith("sha256:") ? fingerprint.slice(7) : "";
    const tool = String(raw.tool || "");
    const state = String(raw.state || "");
    const idempotencyKey = String(raw.idempotencyKey || "");
    if (!/^[a-f0-9]{64}$/.test(hash) || !tool || !STATES.has(state)
      || idempotencyKey !== `flownote-${hash}` || seen.has(fingerprint)) return null;
    seen.add(fingerprint);
    out.push({ version: VERSION, fingerprint, tool, state, idempotencyKey });
  }
  return out;
}

function projectWebMutationOperation(input) {
  const source = input && typeof input === "object" ? input : {};
  const headers = {};
  for (const [name, value] of Object.entries(source.headers && typeof source.headers === "object" ? source.headers : {})) {
    const normalized = String(name || "").trim().toLowerCase();
    if (!normalized || ["accept", "content-type", "idempotency-key"].includes(normalized)) continue;
    headers[normalized] = String(value);
  }
  return {
    method: String(source.method || "GET").trim().toUpperCase(),
    url: String(source.url || "").trim(),
    headers,
    body: source.json !== undefined ? { json: source.json } : { body: String(source.body || "") },
  };
}

module.exports = {
  claimEffectAttempt,
  normalizeEffectAttempts,
  projectWebMutationOperation,
  EFFECT_ATTEMPT_STATES: STATES,
};
