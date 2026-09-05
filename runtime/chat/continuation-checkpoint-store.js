const { validateContinuationCheckpoint } = require("../agent/continuation-checkpoint");

const REF_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

class ContinuationCheckpointStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ContinuationCheckpointStoreError";
    this.code = code;
  }
}

function checkpointStoreError(code, message) {
  return new ContinuationCheckpointStoreError(code, message);
}

function utf8Bytes(value) {
  const text = String(value || "");
  if (typeof TextEncoder !== "undefined") return Array.from(new TextEncoder().encode(text));
  // Obsidian mobile ships TextEncoder, but keep the adapter layer portable to
  // older WebViews without importing Node's Buffer.
  const encoded = unescape(encodeURIComponent(text)); // eslint-disable-line no-undef
  return Array.from(encoded, (character) => character.charCodeAt(0));
}

function canonicalJson(value, stack = new Set()) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw checkpointStoreError("CHECKPOINT_SERIALIZATION_INVALID", "Checkpoint contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (stack.has(value)) throw checkpointStoreError("CHECKPOINT_SERIALIZATION_INVALID", "Checkpoint contains a circular value.");
    stack.add(value);
    const out = `[${value.map((entry) => canonicalJson(entry, stack)).join(",")}]`;
    stack.delete(value);
    return out;
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw checkpointStoreError("CHECKPOINT_SERIALIZATION_INVALID", "Checkpoint contains a non-JSON value.");
  }
  if (stack.has(value)) throw checkpointStoreError("CHECKPOINT_SERIALIZATION_INVALID", "Checkpoint contains a circular value.");
  stack.add(value);
  const out = `{${Object.keys(value).sort().map((key) => {
    if (value[key] === undefined) throw checkpointStoreError("CHECKPOINT_SERIALIZATION_INVALID", "Checkpoint contains an undefined value.");
    return `${JSON.stringify(key)}:${canonicalJson(value[key], stack)}`;
  }).join(",")}}`;
  stack.delete(value);
  return out;
}

// Synchronous SHA-256, deliberately implemented here instead of Node crypto:
// the same module is loaded by Obsidian desktop and mobile adapters.
function sha256Hex(text) {
  const bytes = utf8Bytes(text);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while ((bytes.length % 64) !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  [high, low].forEach((word) => bytes.push((word >>> 24) & 255, (word >>> 16) & 255, (word >>> 8) & 255, word & 255));

  const hashes = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const constants = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array(64);
    for (let index = 0; index < 16; index += 1) {
      const base = offset + (index * 4);
      words[index] = ((bytes[base] << 24) | (bytes[base + 1] << 16) | (bytes[base + 2] << 8) | bytes[base + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15]; const y = words[index - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hashes;
    for (let index = 0; index < 64; index += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + constants[index] + words[index]) >>> 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    hashes[0] = (hashes[0] + a) >>> 0; hashes[1] = (hashes[1] + b) >>> 0;
    hashes[2] = (hashes[2] + c) >>> 0; hashes[3] = (hashes[3] + d) >>> 0;
    hashes[4] = (hashes[4] + e) >>> 0; hashes[5] = (hashes[5] + f) >>> 0;
    hashes[6] = (hashes[6] + g) >>> 0; hashes[7] = (hashes[7] + h) >>> 0;
  }
  return hashes.map((word) => word.toString(16).padStart(8, "0")).join("");
}

async function sha256HexAsync(text) {
  const subtle = typeof globalThis !== "undefined"
    && globalThis.crypto
    && globalThis.crypto.subtle
    && typeof globalThis.crypto.subtle.digest === "function"
    ? globalThis.crypto.subtle
    : null;
  if (!subtle) return sha256Hex(text);
  const digest = await subtle.digest("SHA-256", new Uint8Array(utf8Bytes(text)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizedDir(value) {
  const dir = String(value || "").trim().replace(/\\+/g, "/").replace(/^\/+|\/+$/g, "");
  if (!dir || dir.split("/").some((part) => !part || part === "." || part === "..")) {
    throw checkpointStoreError("CHECKPOINT_STORE_UNAVAILABLE", "Continuation checkpoint storage is unavailable.");
  }
  return dir;
}

function normalizeRef(ref, baseDir) {
  if (!ref || typeof ref !== "object" || Array.isArray(ref) || ref.version !== REF_VERSION) {
    throw checkpointStoreError("CHECKPOINT_REFERENCE_INVALID", "Continuation checkpoint reference is invalid.");
  }
  const id = String(ref.id || "");
  const hash = id.startsWith("sha256:") ? id.slice("sha256:".length) : "";
  const path = String(ref.path || "");
  const byteLength = Number(ref.byteLength);
  if (!SHA256_PATTERN.test(hash) || !Number.isSafeInteger(byteLength) || byteLength < 1
    || path !== `${baseDir}/continuations/${hash}.json`) {
    throw checkpointStoreError("CHECKPOINT_REFERENCE_INVALID", "Continuation checkpoint reference is invalid.");
  }
  return { version: REF_VERSION, id: `sha256:${hash}`, path, byteLength };
}

class ContinuationCheckpointStore {
  constructor({ vault, manifest } = {}) {
    this.adapter = vault && vault.adapter;
    this.baseDir = normalizedDir(manifest && manifest.dir);
  }

  requireAdapter(method) {
    if (!this.adapter || typeof this.adapter[method] !== "function") {
      throw checkpointStoreError("CHECKPOINT_STORE_UNAVAILABLE", "Continuation checkpoint storage is unavailable.");
    }
    return this.adapter;
  }

  async ensureDirectory() {
    const adapter = this.requireAdapter("mkdir");
    this.requireAdapter("exists");
    const directory = `${this.baseDir}/continuations`;
    if (await adapter.exists(directory)) return directory;
    try { await adapter.mkdir(directory); } catch (error) {
      if (!await adapter.exists(directory)) throw error;
    }
    return directory;
  }

  async store(checkpoint) {
    const validation = validateContinuationCheckpoint(checkpoint);
    if (!validation.ok) throw checkpointStoreError("CHECKPOINT_INVALID", validation.error);
    const text = canonicalJson(checkpoint);
    // WebCrypto performs the expensive digest away from the JavaScript main
    // thread on current Obsidian desktop and mobile WebViews.
    const hash = await sha256HexAsync(text);
    const ref = {
      version: REF_VERSION,
      id: `sha256:${hash}`,
      path: `${this.baseDir}/continuations/${hash}.json`,
      byteLength: utf8Bytes(text).length,
    };
    const adapter = this.requireAdapter("write");
    this.requireAdapter("exists");
    await this.ensureDirectory();
    if (!await adapter.exists(ref.path)) await adapter.write(ref.path, text);
    return ref;
  }

  async load(ref) {
    const normalized = normalizeRef(ref, this.baseDir);
    const adapter = this.requireAdapter("read");
    this.requireAdapter("exists");
    if (!await adapter.exists(normalized.path)) {
      throw checkpointStoreError("CHECKPOINT_UNAVAILABLE", "Continuation checkpoint is unavailable.");
    }
    let text;
    try { text = await adapter.read(normalized.path); } catch (_error) {
      throw checkpointStoreError("CHECKPOINT_UNAVAILABLE", "Continuation checkpoint is unavailable.");
    }
    if (typeof text !== "string" || utf8Bytes(text).length !== normalized.byteLength || await sha256HexAsync(text) !== normalized.id.slice(7)) {
      throw checkpointStoreError("CHECKPOINT_INTEGRITY_INVALID", "Continuation checkpoint failed integrity validation.");
    }
    let checkpoint;
    try { checkpoint = JSON.parse(text); } catch (_error) {
      throw checkpointStoreError("CHECKPOINT_INVALID", "Continuation checkpoint is invalid.");
    }
    const validation = validateContinuationCheckpoint(checkpoint);
    if (!validation.ok) throw checkpointStoreError("CHECKPOINT_INVALID", validation.error);
    return JSON.parse(JSON.stringify(checkpoint));
  }

  async remove(ref) {
    try {
      const normalized = normalizeRef(ref, this.baseDir);
      const adapter = this.requireAdapter("remove");
      this.requireAdapter("exists");
      if (!await adapter.exists(normalized.path)) return false;
      await adapter.remove(normalized.path);
      return true;
    } catch (_error) {
      return false;
    }
  }

  /**
   * Mark-and-sweep orphaned content-addressed blobs after durable session
   * state has loaded. A grace window protects a blob in the short interval
   * between file creation and committing its SessionStore reference.
   */
  async sweep(liveRefs, options = {}) {
    const result = { scanned: 0, kept: 0, removed: 0, deferred: 0, failed: 0 };
    const adapter = this.requireAdapter("list");
    this.requireAdapter("exists");
    this.requireAdapter("remove");
    const directory = `${this.baseDir}/continuations`;
    if (!await adapter.exists(directory)) return result;

    const livePaths = new Set();
    for (const ref of Array.isArray(liveRefs) ? liveRefs : []) {
      try { livePaths.add(normalizeRef(ref, this.baseDir).path); } catch (_error) { /* invalid refs are never roots */ }
    }
    let listing;
    try { listing = await adapter.list(directory); } catch (_error) { return { ...result, failed: 1 }; }
    const files = Array.isArray(listing && listing.files) ? listing.files : [];
    const minimumAgeMs = Math.max(0, Number(options.minimumAgeMs === undefined ? 300_000 : options.minimumAgeMs) || 0);
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
    const filePattern = new RegExp(`^${escapeRegExp(directory)}/[a-f0-9]{64}\\.json$`);

    for (const rawPath of files) {
      const path = String(rawPath || "").replace(/\\+/g, "/");
      if (!filePattern.test(path)) continue;
      result.scanned += 1;
      if (livePaths.has(path)) {
        result.kept += 1;
        continue;
      }
      if (minimumAgeMs > 0) {
        if (typeof adapter.stat !== "function") {
          result.deferred += 1;
          continue;
        }
        let stat = null;
        try { stat = await adapter.stat(path); } catch (_error) { stat = null; }
        const modifiedAt = Number(stat && (stat.mtime || stat.ctime || 0));
        if (!Number.isFinite(modifiedAt) || modifiedAt <= 0 || now - modifiedAt < minimumAgeMs) {
          result.deferred += 1;
          continue;
        }
      }
      try {
        await adapter.remove(path);
        result.removed += 1;
      } catch (_error) {
        result.failed += 1;
      }
    }
    return result;
  }
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  ContinuationCheckpointStore,
  ContinuationCheckpointStoreError,
  canonicalJson,
  sha256Hex,
  sha256HexAsync,
};
