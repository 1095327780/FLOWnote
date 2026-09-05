// Streaming-capable HTTP helper.
//
// Why we can't just use Obsidian's `requestUrl`: it BUFFERS the entire
// response body before resolving — SSE streaming collapses into one
// big yield after the model finishes. We need chunks as they arrive.
//
// Two-tier strategy:
//
//   Tier 1 (desktop Electron): use Node's `https` / `http` module
//   directly. Obsidian plugins run with full Node integration, so we
//   can issue the request from the renderer's Node side and read the
//   IncomingMessage as a streaming Readable. This bypasses both CORS
//   and CSP because it's NOT a browser-origin request.
//
//   Tier 2 (mobile webview, fallback): use the browser `fetch()` with
//   `response.body.getReader()`. Subject to CORS (most chat-completions
//   APIs expose it; Anthropic requires the
//   anthropic-dangerous-direct-browser-access header — set by caller).
//
// If request establishment fails, the caller may fall back to Obsidian's
// `requestUrl`, which is buffered but at least lets the chat complete. Once a
// response is established, body failures are surfaced with typed metadata and
// are never replayed here; recovery belongs to the durable agent checkpoint.

// Lazy Node require — succeeds on desktop, throws on mobile webview.
let nodeHttps = null;
let nodeHttp = null;
let nodeUrl = null;
try { nodeHttps = require("https"); } catch { /* mobile */ }
try { nodeHttp = require("http"); } catch { /* mobile */ }
try { nodeUrl = require("url"); } catch { /* mobile */ }

// A model may legitimately pause between tokens while thinking, but a response
// body that is silent for minutes is no longer useful as a live stream. Keep
// this transport-level policy identical on desktop and mobile. Callers can
// override it for tests or future provider-specific tuning without changing
// the terminal semantics.
// Match the mature SDK convention used by the reference agent stack: ten
// minutes is long enough for large-context model thinking, while still
// preventing a suspended mobile WebView from holding a dead stream for hours.
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 600_000;

class ProviderStreamError extends Error {
  constructor(message, metadata = {}) {
    super(message);
    this.name = "ProviderStreamError";
    this.code = metadata.code || "PROVIDER_STREAM_READ_FAILED";
    this.phase = "response_body";
    this.transport = metadata.transport || "unknown";
    this.retryable = metadata.retryable !== false;
    this.recoverable = true;
    this.replaySafe = false;
    this.recovery = "checkpoint_resume";
    this.receivedChunks = Number.isFinite(metadata.receivedChunks) ? metadata.receivedChunks : 0;
    if (Number.isFinite(metadata.idleTimeoutMs)) this.idleTimeoutMs = metadata.idleTimeoutMs;
    if (metadata.cause !== undefined) this.cause = metadata.cause;
  }
}

function hasNodeHttp() {
  return Boolean(
    nodeHttps && typeof nodeHttps.request === "function"
      && nodeHttp && typeof nodeHttp.request === "function",
  );
}

/**
 * Streaming HTTP request. Returns a response shaped like Obsidian's
 * `requestUrl` result — `{ status, headers, body, text, json }` — but
 * with `body` as an AsyncIterable<string> that yields chunks as the
 * server writes them. HTTP error statuses (4xx/5xx) do NOT throw; the
 * caller inspects `.status`. Network failures and aborts reject.
 *
 * @param {Object} args
 * @param {string} args.url
 * @param {string} [args.method="POST"]
 * @param {Object<string,string>} [args.headers]
 * @param {string} [args.body]
 * @param {AbortSignal} [args.signal]
 * @param {number} [args.idleTimeoutMs]
 * @returns {Promise<{status: number, headers: Object<string,string>, body: AsyncIterable<string>, text: () => Promise<string>, json: () => Promise<*>}>}
 */
async function streamingFetch(args) {
  if (hasNodeHttp()) {
    return nodeStreamingRequest(args);
  }
  if (typeof fetch !== "function") {
    throw new Error("streamingFetch: no transport available");
  }
  return browserStreamingFetch(args);
}

// -----------------------------------------------------------------------
// Tier 1: Node http/https — desktop Electron renderer with nodeIntegration.
// -----------------------------------------------------------------------

function nodeStreamingRequest(args) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = nodeUrl && typeof nodeUrl.URL === "function"
        ? new nodeUrl.URL(String(args.url || ""))
        : new URL(String(args.url || ""));
    } catch (e) {
      reject(new Error(`streamingFetch: invalid url ${args.url}`));
      return;
    }
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? nodeHttps : nodeHttp;
    const opts = {
      method: args.method || "POST",
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: `${parsed.pathname || "/"}${parsed.search || ""}`,
      headers: args.headers || {},
    };

    const req = lib.request(opts, (res) => {
      const status = typeof res.statusCode === "number" ? res.statusCode : 0;
      const headers = res.headers && typeof res.headers === "object" ? res.headers : {};

      let bodyConsumed = false;
      const collectAll = () => new Promise((resolveText, rejectText) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolveText(Buffer.concat(chunks).toString("utf8"));
        });
        res.on("error", rejectText);
      });

      resolve({
        status,
        headers,
        body: makeNodeStreamIterable(res, () => { bodyConsumed = true; }, {
          signal: args.signal,
          idleTimeoutMs: args.idleTimeoutMs,
        }),
        async text() {
          if (bodyConsumed) throw new Error("response body already consumed");
          bodyConsumed = true;
          return collectAll();
        },
        async json() {
          if (bodyConsumed) throw new Error("response body already consumed");
          bodyConsumed = true;
          const t = await collectAll();
          return JSON.parse(t);
        },
      });
    });

    req.on("error", (err) => reject(err));

    if (args.signal && typeof args.signal.addEventListener === "function") {
      if (args.signal.aborted) {
        try { req.destroy(createAbortError(args.signal.reason)); } catch { /* ignore */ }
      } else {
        args.signal.addEventListener("abort", () => {
          try { req.destroy(createAbortError(args.signal.reason)); } catch { /* ignore */ }
        }, { once: true });
      }
    }

    if (args.body != null) {
      req.write(args.body);
    }
    req.end();
  });
}

/**
 * Wrap a Node Readable stream in an AsyncIterable<string>. Node's
 * IncomingMessage is already async-iterable; we decode each chunk and
 * mark the response as "body consumed" so a later .text() throws.
 */
function makeNodeStreamIterable(readable, onConsumed, options = {}) {
  return (async function* () {
    const iterator = readable[Symbol.asyncIterator]();
    let receivedChunks = 0;
    try {
      while (true) {
        const result = await readStreamPart(() => iterator.next(), {
          signal: options.signal,
          idleTimeoutMs: options.idleTimeoutMs,
          transport: "node",
          receivedChunks,
          onInterrupt(reason) {
            if (readable && typeof readable.destroy === "function") readable.destroy(reason);
          },
        });
        if (!result || result.done) break;
        const chunk = result.value;
        if (chunk == null) continue;
        receivedChunks += 1;
        if (typeof chunk === "string") yield chunk;
        else if (typeof Buffer !== "undefined" && Buffer.isBuffer(chunk)) yield chunk.toString("utf8");
        else if (chunk instanceof Uint8Array) yield new TextDecoder().decode(chunk);
        else yield String(chunk);
      }
    } catch (error) {
      throw normalizeStreamReadError(error, {
        signal: options.signal,
        transport: "node",
        receivedChunks,
      });
    } finally {
      if (typeof onConsumed === "function") onConsumed();
    }
  })();
}

// -----------------------------------------------------------------------
// Tier 2: browser fetch — mobile webview fallback.
// -----------------------------------------------------------------------

async function browserStreamingFetch(args) {
  const resp = await fetch(String(args.url || ""), {
    method: args.method || "POST",
    headers: args.headers || {},
    body: args.body,
    signal: args.signal,
  });
  const headers = {};
  if (resp.headers && typeof resp.headers.forEach === "function") {
    resp.headers.forEach((value, key) => { headers[key] = String(value); });
  }
  let consumed = false;
  const stream = resp.body || null;
  const body = stream && typeof stream.getReader === "function"
    ? makeBrowserStreamIterable(stream, () => { consumed = true; }, {
      signal: args.signal,
      idleTimeoutMs: args.idleTimeoutMs,
    })
    : null;
  return {
    status: typeof resp.status === "number" ? resp.status : 0,
    headers,
    body,
    async text() {
      if (consumed) throw new Error("response body already consumed");
      consumed = true;
      return resp.text();
    },
    async json() {
      if (consumed) throw new Error("response body already consumed");
      consumed = true;
      return resp.json();
    },
  };
}

function makeBrowserStreamIterable(stream, onConsumed, options = {}) {
  return (async function* () {
    const reader = stream.getReader();
    const decoder = typeof TextDecoder === "function" ? new TextDecoder() : null;
    let receivedChunks = 0;
    try {
      while (true) {
        const { done, value } = await readStreamPart(() => reader.read(), {
          signal: options.signal,
          idleTimeoutMs: options.idleTimeoutMs,
          transport: "browser",
          receivedChunks,
          onInterrupt(reason) {
            if (reader && typeof reader.cancel === "function") reader.cancel(reason);
          },
        });
        if (done) break;
        if (!value) continue;
        receivedChunks += 1;
        if (typeof value === "string") {
          yield value;
        } else if (decoder) {
          yield decoder.decode(value, { stream: true });
        } else {
          yield String.fromCharCode.apply(null, value);
        }
      }
      if (decoder) {
        const tail = decoder.decode();
        if (tail) yield tail;
      }
    } catch (error) {
      throw normalizeStreamReadError(error, {
        signal: options.signal,
        transport: "browser",
        receivedChunks,
      });
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
      if (typeof onConsumed === "function") onConsumed();
    }
  })();
}

function readStreamPart(read, options) {
  const idleTimeoutMs = normalizeIdleTimeout(options && options.idleTimeoutMs);
  const signal = options && options.signal;
  const transport = (options && options.transport) || "unknown";
  const receivedChunks = Number.isFinite(options && options.receivedChunks)
    ? options.receivedChunks
    : 0;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const interrupt = (reason) => {
      if (!options || typeof options.onInterrupt !== "function") return;
      try {
        const result = options.onInterrupt(reason);
        if (result && typeof result.catch === "function") result.catch(() => {});
      } catch { /* interruption is best-effort; preserve the original reason */ }
    };
    const onAbort = () => {
      const error = createAbortError(signal && signal.reason);
      interrupt(error);
      settle(reject, error);
    };

    if (signal && signal.aborted) {
      onAbort();
      return;
    }
    if (signal && typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    timer = setTimeout(() => {
      const error = new ProviderStreamError(
        `Provider response stream was idle for ${idleTimeoutMs}ms.`,
        {
          code: "PROVIDER_STREAM_IDLE_TIMEOUT",
          transport,
          idleTimeoutMs,
          receivedChunks,
        },
      );
      interrupt(error);
      settle(reject, error);
    }, idleTimeoutMs);

    Promise.resolve()
      .then(read)
      .then(
        (result) => settle(resolve, result),
        (error) => settle(reject, normalizeStreamReadError(error, {
          signal,
          transport,
          receivedChunks,
        })),
      );
  });
}

function normalizeIdleTimeout(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

function normalizeStreamReadError(error, metadata = {}) {
  if (isCancellation(error, metadata.signal)) {
    return error && error.name === "AbortError" && error.code === "ABORT_ERR"
      ? error
      : createAbortError(error || (metadata.signal && metadata.signal.reason));
  }
  if (error instanceof ProviderStreamError) return error;
  const message = error instanceof Error && error.message
    ? error.message
    : String(error || "Unknown stream read failure");
  return new ProviderStreamError(`Provider response stream failed: ${message}`, {
    code: "PROVIDER_STREAM_READ_FAILED",
    transport: metadata.transport,
    receivedChunks: metadata.receivedChunks,
    cause: error,
  });
}

function isCancellation(error, signal) {
  if (signal && signal.aborted) return true;
  if (!error || typeof error !== "object") return false;
  return error.name === "AbortError" || error.code === "ABORT_ERR" || error.code === "ERR_CANCELED";
}

function createAbortError(reason) {
  if (reason && reason.name === "AbortError" && reason.code === "ABORT_ERR") return reason;
  const error = new Error(
    typeof reason === "string" && reason.trim() ? reason : "The operation was aborted.",
  );
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  if (reason !== undefined) error.cause = reason;
  return error;
}

module.exports = {
  streamingFetch,
  ProviderStreamError,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  // Export transport wrappers so their cross-platform contract stays directly
  // testable without replacing Node globals or making real network requests.
  makeBrowserStreamIterable,
  makeNodeStreamIterable,
};
