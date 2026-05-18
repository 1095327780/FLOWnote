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
// If both tiers fail the caller falls back to Obsidian's `requestUrl`,
// which is buffered but at least lets the chat complete.

// Lazy Node require — succeeds on desktop, throws on mobile webview.
let nodeHttps = null;
let nodeHttp = null;
let nodeUrl = null;
try { nodeHttps = require("https"); } catch { /* mobile */ }
try { nodeHttp = require("http"); } catch { /* mobile */ }
try { nodeUrl = require("url"); } catch { /* mobile */ }

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
        body: makeNodeStreamIterable(res, () => { bodyConsumed = true; }),
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
        try { req.destroy(new Error("aborted")); } catch { /* ignore */ }
      } else {
        args.signal.addEventListener("abort", () => {
          try { req.destroy(new Error("aborted")); } catch { /* ignore */ }
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
function makeNodeStreamIterable(readable, onConsumed) {
  return (async function* () {
    try {
      for await (const chunk of readable) {
        if (chunk == null) continue;
        if (typeof chunk === "string") yield chunk;
        else if (typeof Buffer !== "undefined" && Buffer.isBuffer(chunk)) yield chunk.toString("utf8");
        else if (chunk instanceof Uint8Array) yield new TextDecoder().decode(chunk);
        else yield String(chunk);
      }
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
    ? makeBrowserStreamIterable(stream, () => { consumed = true; })
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

function makeBrowserStreamIterable(stream, onConsumed) {
  return (async function* () {
    const reader = stream.getReader();
    const decoder = typeof TextDecoder === "function" ? new TextDecoder() : null;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
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
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
      if (typeof onConsumed === "function") onConsumed();
    }
  })();
}

module.exports = { streamingFetch };
