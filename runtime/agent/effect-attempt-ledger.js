// Durable at-most-once attempt identities for external mutations.
// Entries contain only collision-resistant fingerprints and lifecycle state;
// request bodies, authorization values, and response prose are never stored.
//
// An attempt is written to the execution journal (and persisted) before the
// request leaves the process. If the process stops before the response is
// recorded, the attempt stays "unknown after send"; a later mutation to the
// same service then needs the user's explicit confirmation.

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

// A claimed attempt that never left the process (recording failed) must not
// suppress a later identical request as a "duplicate".
function releaseEffectAttempt(ledger, entry) {
  if (!Array.isArray(ledger) || !entry || entry.state !== "prepared") return;
  const index = ledger.indexOf(entry);
  if (index >= 0) ledger.splice(index, 1);
}

const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_RESOLVES = 16;

/** Service identity used to group "similar" mutations: the URL origin. */
function effectAttemptScope(url) {
  try {
    const parsed = new URL(String(url || "").trim());
    return parsed.origin.toLowerCase();
  } catch (_error) {
    return "";
  }
}

function effectAttemptEndpoint(url) {
  try {
    const parsed = new URL(String(url || "").trim());
    return `${parsed.origin}${parsed.pathname}`.slice(0, 240);
  } catch (_error) {
    return "";
  }
}

/** Validated durable form of one sending attempt, or null. */
function normalizeEffectAttemptRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.version !== VERSION) return null;
  const fingerprint = String(raw.fingerprint || "");
  const hash = fingerprint.startsWith("sha256:") ? fingerprint.slice(7) : "";
  const tool = String(raw.tool || "").trim().slice(0, 64);
  const scope = String(raw.scope || "").trim().slice(0, 240);
  const method = String(raw.method || "").trim().toUpperCase().slice(0, 16);
  const endpoint = String(raw.endpoint || "").trim().slice(0, 240);
  const resolves = raw.resolves === undefined ? [] : raw.resolves;
  if (!FINGERPRINT_PATTERN.test(fingerprint) || raw.idempotencyKey !== `flownote-${hash}`
    || !tool || !scope || !method || !endpoint
    || !Array.isArray(resolves) || resolves.length > MAX_RESOLVES
    || resolves.some((item) => !FINGERPRINT_PATTERN.test(String(item || "")))) return null;
  return { version: VERSION, fingerprint, idempotencyKey: raw.idempotencyKey, tool, scope, method, endpoint, resolves: [...new Set(resolves)] };
}

function unresolvedAttemptsForScope(unresolved, scope) {
  if (!Array.isArray(unresolved) || !scope) return [];
  return unresolved.filter((attempt) => attempt && attempt.scope === scope);
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
  releaseEffectAttempt,
  effectAttemptScope,
  effectAttemptEndpoint,
  normalizeEffectAttemptRecord,
  unresolvedAttemptsForScope,
  normalizeEffectAttempts,
  projectWebMutationOperation,
  EFFECT_ATTEMPT_STATES: STATES,
};
