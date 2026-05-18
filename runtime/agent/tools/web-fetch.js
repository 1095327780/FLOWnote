// web_fetch tool — fetches a URL using Obsidian's requestUrl (which
// goes through Electron's network stack on desktop and bypasses CORS),
// then returns readable text content. No third-party API key needed.
//
// Design choices:
//   - For HTML we run a defensive cleanup pass (strip script/style/nav/
//     header/footer/aside/iframe/noscript) then return body innerText.
//     If the page exposes <article> or <main>, we prefer that.
//   - For text/json/markdown we return the raw payload verbatim.
//   - Output is capped (default 60 KB) so the model context stays small.
//   - Permission gated (ask) because it makes outbound network calls.
//
// The DOM parser is available wherever Obsidian renders (desktop +
// mobile), so this works in both environments. On mobile, requestUrl
// uses the platform's native HTTP client.

const { buildTool } = require("../tool-registry");
const { byteLengthUtf8 } = require("../utils/byte-length");

const DESCRIPTION =
  "Fetch a URL and return its readable text content. " +
  "For HTML pages this returns extracted readable text (scripts/styles/nav/footer removed). " +
  "For JSON / plain text / markdown it returns the raw body. " +
  "Use this when the user pastes a link and asks you to summarize, quote, or extract content. " +
  "Input: `url` (http or https). Optional `maxBytes` to cap output (default 60000).";

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description: "Full http:// or https:// URL to fetch.",
    },
    maxBytes: {
      type: "integer",
      description: "Maximum bytes of extracted text to return. Default 60000.",
      minimum: 1024,
      maximum: 500000,
    },
  },
  required: ["url"],
};

const DEFAULT_MAX_BYTES = 60 * 1024;
const FETCH_TIMEOUT_MS = 25000;

// Block obvious non-public targets so a stray model call can't probe
// the user's local network / metadata service. This is best-effort
// (not airtight against DNS rebinding), but catches the cases that
// matter for an LLM that's typing URLs into the tool.
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
  /^\[::1?\]$/,
  /^\[fc[0-9a-f]{2}:/i,
  /^\[fe80:/i,
  /\.local$/i,
];

function isBlockedHost(hostname) {
  const h = String(hostname || "").trim();
  if (!h) return true;
  return BLOCKED_HOST_PATTERNS.some((re) => re.test(h));
}

function decodeHtmlEntities(input) {
  if (!input) return "";
  return String(input)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) ? String.fromCharCode(n) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      const n = parseInt(code, 16);
      return Number.isFinite(n) ? String.fromCharCode(n) : "";
    });
}

function extractReadableTextFromHtml(html) {
  const raw = String(html || "");
  if (!raw.trim()) return "";

  // Prefer a real DOMParser when available (Electron + mobile both
  // expose it). Falls back to regex stripping when not.
  if (typeof DOMParser !== "undefined") {
    try {
      const doc = new DOMParser().parseFromString(raw, "text/html");
      if (doc && doc.body) {
        const removeSelectors = [
          "script", "style", "noscript", "iframe",
          "nav", "header", "footer", "aside",
          "form", "button", "svg", "canvas",
          "[aria-hidden=\"true\"]",
        ];
        for (const sel of removeSelectors) {
          for (const el of Array.from(doc.querySelectorAll(sel))) {
            el.remove();
          }
        }
        const main = doc.querySelector("article") || doc.querySelector("main");
        const root = main || doc.body;
        const titleEl = doc.querySelector("title");
        const title = titleEl ? String(titleEl.textContent || "").trim() : "";
        const body = String(root.textContent || "")
          .split(/\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .join("\n")
          .replace(/\n{3,}/g, "\n\n");
        return title ? `# ${title}\n\n${body}` : body;
      }
    } catch (_err) {
      // fall through to regex
    }
  }

  // Regex fallback: strip tags, decode entities.
  const stripped = raw
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|article|section)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeHtmlEntities(stripped)
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

function looksLikeHtml(contentType, body) {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("text/html") || ct.includes("application/xhtml")) return true;
  if (ct && !ct.startsWith("text/")) return false;
  const sample = String(body || "").slice(0, 1024).toLowerCase();
  return /<html|<!doctype html|<head|<body/.test(sample);
}

function looksLikeJson(contentType) {
  return /\bjson\b/i.test(String(contentType || ""));
}

/**
 * @param {Object} deps
 * @param {Function} deps.requestUrl  Obsidian requestUrl (or fake) — `{url, method?, headers?, throw?}` → `{status, text, headers}`
 * @param {number}  [deps.maxBytes]
 * @param {number}  [deps.timeoutMs]
 */
function createWebFetchTool({ requestUrl, maxBytes, timeoutMs } = {}) {
  if (typeof requestUrl !== "function") {
    throw new Error("createWebFetchTool: requestUrl function is required");
  }
  const byteCap = typeof maxBytes === "number" && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
  const timeout = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : FETCH_TIMEOUT_MS;

  return buildTool({
    name: "web_fetch",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,

    async validate(input) {
      if (!input || typeof input.url !== "string" || !input.url.trim()) {
        return { ok: false, error: "Missing url." };
      }
      let parsed;
      try {
        parsed = new URL(input.url.trim());
      } catch {
        return { ok: false, error: "Invalid url." };
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, error: "Only http(s) URLs are supported." };
      }
      if (isBlockedHost(parsed.hostname)) {
        return { ok: false, error: `Refusing to fetch private/internal host: ${parsed.hostname}` };
      }
      return { ok: true };
    },

    userFacingName(input) {
      try {
        return new URL(String(input.url)).hostname;
      } catch {
        return String(input && input.url ? input.url : "");
      }
    },

    // Network call → require explicit user approval the first time. The
    // permission layer remembers session-wide allows so the user only
    // sees one prompt per session per host (handled upstream).
    async checkPermissions(input) {
      return { behavior: "ask", message: `Fetch ${input && input.url ? input.url : "URL"}?` };
    },

    async *execute(input) {
      const url = String(input.url).trim();
      const requestedCap = Number.isInteger(input.maxBytes) ? input.maxBytes : byteCap;
      const cap = Math.max(1024, Math.min(500000, requestedCap));

      let response;
      try {
        const fetchPromise = requestUrl({
          url,
          method: "GET",
          headers: {
            // Pretend to be a generic browser so blogs/cms don't refuse us.
            "User-Agent": "Mozilla/5.0 (compatible; FLOWnote/0.5; +https://github.com)",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          throw: false,
        });
        response = await Promise.race([
          fetchPromise,
          new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error(`Timed out after ${timeout}ms`)), timeout),
          ),
        ]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield { type: "result", content: `web_fetch: request failed — ${msg}`, isError: true };
        return;
      }

      const status = Number(response && response.status) || 0;
      const headers = (response && response.headers) || {};
      const contentType = String(
        headers["content-type"] || headers["Content-Type"] || "",
      );

      if (status < 200 || status >= 400) {
        const snippet = String(response && response.text ? response.text : "").slice(0, 400);
        yield {
          type: "result",
          content: `web_fetch: HTTP ${status} from ${url}${snippet ? `\n${snippet}` : ""}`,
          isError: true,
        };
        return;
      }

      const rawBody = String(response && response.text ? response.text : "");
      let extracted;
      if (looksLikeJson(contentType)) {
        extracted = rawBody.trim();
      } else if (looksLikeHtml(contentType, rawBody)) {
        extracted = extractReadableTextFromHtml(rawBody);
      } else {
        extracted = rawBody;
      }
      const cleaned = extracted.trim() || "(empty body)";

      let payload = cleaned;
      let truncatedNotice = "";
      if (byteLengthUtf8(cleaned) > cap) {
        payload = cleaned.slice(0, cap);
        truncatedNotice = `\n\n[web_fetch: truncated at ${cap} bytes — re-call with a different page or higher maxBytes if you need more]`;
      }

      yield {
        type: "result",
        content: `URL: ${url}\nHTTP ${status} · ${contentType || "unknown content-type"}\n\n${payload}${truncatedNotice}`,
      };
    },
  });
}

module.exports = {
  createWebFetchTool,
  // Exposed for tests.
  __internals: {
    extractReadableTextFromHtml,
    decodeHtmlEntities,
    isBlockedHost,
  },
};
