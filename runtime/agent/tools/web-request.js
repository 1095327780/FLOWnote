// web_request tool — Obsidian-native HTTP API calls with custom method,
// headers, and JSON body. This complements web_fetch: web_fetch is for
// readable web pages, web_request is for API-backed skills.
//
// Secret handling:
//   - Skills should pass placeholders such as `Bearer $WEREAD_API_KEY`.
//   - The tool substitutes placeholders from plugin.settings.skillSecrets
//     at execution time.
//   - Tool output masks configured secret values defensively.

const { buildTool } = require("../tool-registry");
const { byteLengthUtf8 } = require("../utils/byte-length");

const DESCRIPTION =
  "Send an HTTP API request with method, headers, and optional JSON body. " +
  "Use this for API-backed skills that need POST / Authorization headers, " +
  "for example WeRead's official skill. Prefer web_fetch for normal web pages. " +
  "Use secret placeholders like `$WEREAD_API_KEY` in headers/body; FLOWnote " +
  "substitutes them from Settings -> Skill management at execution time.";

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description: "Full http:// or https:// API URL.",
    },
    method: {
      type: "string",
      enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      description: "HTTP method. Defaults to GET.",
    },
    headers: {
      type: "object",
      description: "HTTP headers. Values may include secret placeholders like `Bearer $WEREAD_API_KEY`.",
      additionalProperties: { type: "string" },
    },
    json: {
      type: "object",
      description: "JSON request body. Sets Content-Type: application/json when not already provided.",
      additionalProperties: true,
    },
    body: {
      type: "string",
      description: "Raw request body. Use `json` for JSON API calls when possible.",
    },
    maxBytes: {
      type: "integer",
      description: "Maximum bytes of response text to return. Default 60000.",
      minimum: 1024,
      maximum: 500000,
    },
  },
  required: ["url"],
};

const DEFAULT_MAX_BYTES = 60 * 1024;
const REQUEST_TIMEOUT_MS = 25000;
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const DISALLOWED_HEADER_NAMES = new Set(["cookie", "set-cookie", "host", "content-length"]);

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

function normalizeMethod(value) {
  const method = String(value || "GET").trim().toUpperCase();
  return method || "GET";
}

function isDangerousMethod(method) {
  const normalized = normalizeMethod(method);
  return normalized === "DELETE" || normalized === "PATCH" || normalized === "PUT";
}

function normalizeHeaderEntries(headers) {
  if (headers == null) return { ok: true, headers: {} };
  if (typeof headers !== "object" || Array.isArray(headers)) {
    return { ok: false, error: "headers must be an object." };
  }
  const out = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = String(rawName || "").trim();
    if (!name) return { ok: false, error: "headers cannot contain an empty header name." };
    if (!/^[-!#$%&'*+.^_`|~0-9A-Za-z]+$/.test(name)) {
      return { ok: false, error: `Invalid header name: ${name}` };
    }
    if (DISALLOWED_HEADER_NAMES.has(name.toLowerCase())) {
      return { ok: false, error: `Header "${name}" is not allowed.` };
    }
    if (rawValue == null || typeof rawValue === "object") {
      return { ok: false, error: `Header "${name}" must be a string value.` };
    }
    out[name] = String(rawValue);
  }
  return { ok: true, headers: out };
}

function hasHeader(headers, targetName) {
  const wanted = String(targetName || "").toLowerCase();
  return Object.keys(headers || {}).some((name) => name.toLowerCase() === wanted);
}

function normalizeSecrets(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const name = String(key || "").trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    const secret = String(value || "").trim();
    if (secret) out[name] = secret;
  }
  return out;
}

function substituteSecretsInString(value, secrets, missing) {
  return String(value || "").replace(/\$(?:\{([A-Z][A-Z0-9_]*)\}|([A-Z][A-Z0-9_]*))/g, (match, braced, bare) => {
    const name = braced || bare;
    const replacement = secrets[name] || "";
    if (!replacement) {
      missing.add(name);
      return match;
    }
    return replacement;
  });
}

function substituteSecretsDeep(value, secrets, missing) {
  if (typeof value === "string") return substituteSecretsInString(value, secrets, missing);
  if (Array.isArray(value)) return value.map((item) => substituteSecretsDeep(item, secrets, missing));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = substituteSecretsDeep(child, secrets, missing);
    }
    return out;
  }
  return value;
}

function maskKnownSecrets(text, secrets) {
  let out = String(text || "");
  for (const secret of Object.values(secrets || {})) {
    const value = String(secret || "");
    if (value.length < 4) continue;
    out = out.split(value).join("[secret]");
  }
  return out;
}

function responseHeader(headers, name) {
  const wanted = String(name || "").toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === wanted) return String(value || "");
  }
  return "";
}

/**
 * @param {Object} deps
 * @param {Function} deps.requestUrl
 * @param {Function} [deps.getSecrets]
 * @param {number} [deps.maxBytes]
 * @param {number} [deps.timeoutMs]
 */
function createWebRequestTool({ requestUrl, getSecrets, maxBytes, timeoutMs } = {}) {
  if (typeof requestUrl !== "function") {
    throw new Error("createWebRequestTool: requestUrl function is required");
  }
  const byteCap = typeof maxBytes === "number" && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
  const timeout = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : REQUEST_TIMEOUT_MS;
  const readSecrets = typeof getSecrets === "function" ? getSecrets : () => ({});

  return buildTool({
    name: "web_request",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    isReadOnly: (input) => normalizeMethod(input && input.method) === "GET",
    isDestructive: (input) => isDangerousMethod(input && input.method),
    isConcurrencySafe: (input) => normalizeMethod(input && input.method) === "GET",

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
        return { ok: false, error: `Refusing to request private/internal host: ${parsed.hostname}` };
      }
      if (/\$(?:\{?[A-Z][A-Z0-9_]*\}?)/.test(String(input.url))) {
        return { ok: false, error: "Secret placeholders are not supported in URLs." };
      }
      const method = normalizeMethod(input.method);
      if (!ALLOWED_METHODS.has(method)) {
        return { ok: false, error: `Unsupported HTTP method: ${method}` };
      }
      if (input.json !== undefined && input.body !== undefined) {
        return { ok: false, error: "Use either json or body, not both." };
      }
      if (method === "GET" && (input.json !== undefined || input.body !== undefined)) {
        return { ok: false, error: "GET requests cannot include a body." };
      }
      const headerResult = normalizeHeaderEntries(input.headers);
      if (!headerResult.ok) return { ok: false, error: headerResult.error };
      return { ok: true };
    },

    userFacingName(input) {
      const method = normalizeMethod(input && input.method);
      try {
        const parsed = new URL(String(input.url || ""));
        return `${method} ${parsed.hostname}`;
      } catch {
        return `${method} ${input && input.url ? input.url : ""}`.trim();
      }
    },

    async checkPermissions(input) {
      const method = normalizeMethod(input && input.method);
      const target = input && input.url ? String(input.url) : "URL";
      return {
        behavior: "ask",
        message: `Send ${method} request to ${target}?`,
        risk: isDangerousMethod(method) ? "dangerous" : "routine",
      };
    },

    async *execute(input) {
      const url = String(input.url).trim();
      const method = normalizeMethod(input.method);
      const requestedCap = Number.isInteger(input.maxBytes) ? input.maxBytes : byteCap;
      const cap = Math.max(1024, Math.min(500000, requestedCap));

      const secrets = normalizeSecrets(readSecrets() || {});
      const missing = new Set();
      const headerResult = normalizeHeaderEntries(input.headers);
      if (!headerResult.ok) {
        yield { type: "result", content: `web_request: ${headerResult.error}`, isError: true };
        return;
      }
      const headers = substituteSecretsDeep(headerResult.headers, secrets, missing);
      let body;
      if (input.json !== undefined) {
        const jsonBody = substituteSecretsDeep(input.json, secrets, missing);
        body = JSON.stringify(jsonBody);
        if (!hasHeader(headers, "content-type")) headers["Content-Type"] = "application/json";
        if (!hasHeader(headers, "accept")) headers["Accept"] = "application/json, text/plain;q=0.9, */*;q=0.8";
      } else if (input.body !== undefined) {
        body = substituteSecretsInString(input.body, secrets, missing);
      }
      if (missing.size > 0) {
        const names = Array.from(missing).sort();
        yield {
          type: "result",
          content:
            `web_request: missing secret ${names.join(", ")}. ` +
            "Add it in FLOWnote Settings -> Skill management.",
          isError: true,
        };
        return;
      }

      let response;
      try {
        const request = {
          url,
          method,
          headers,
          throw: false,
        };
        if (body !== undefined) request.body = body;
        const requestPromise = requestUrl(request);
        response = await Promise.race([
          requestPromise,
          new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error(`Timed out after ${timeout}ms`)), timeout),
          ),
        ]);
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        yield {
          type: "result",
          content: `web_request: request failed - ${maskKnownSecrets(rawMsg, secrets)}`,
          isError: true,
        };
        return;
      }

      const status = Number(response && response.status) || 0;
      const headersOut = (response && response.headers) || {};
      const contentType = responseHeader(headersOut, "content-type") || "unknown content-type";
      const rawBody = String(response && response.text ? response.text : "");
      const cleaned = rawBody.trim() || "(empty body)";

      let payload = cleaned;
      let truncatedNotice = "";
      if (byteLengthUtf8(cleaned) > cap) {
        payload = cleaned.slice(0, cap);
        truncatedNotice = `\n\n[web_request: truncated at ${cap} bytes]`;
      }
      payload = maskKnownSecrets(payload, secrets);

      const content = `URL: ${url}\nHTTP ${status} · ${contentType}\n\n${payload}${truncatedNotice}`;
      yield { type: "result", content, isError: status < 200 || status >= 400 };
    },
  });
}

module.exports = {
  createWebRequestTool,
  __internals: {
    isBlockedHost,
    isDangerousMethod,
    normalizeSecrets,
    substituteSecretsInString,
    substituteSecretsDeep,
    maskKnownSecrets,
  },
};
