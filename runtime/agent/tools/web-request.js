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
const { pageNotice } = require("./utf8-page");
const { pageReadOutput } = require("./read-output-budget");
const {
  claimEffectAttempt,
  releaseEffectAttempt,
  effectAttemptScope,
  effectAttemptEndpoint,
  unresolvedAttemptsForScope,
  projectWebMutationOperation,
} = require("../effect-attempt-ledger");

const DESCRIPTION =
  "Send an HTTP API request with method, headers, and optional JSON body. " +
  "Use this for API-backed skills that need POST / Authorization headers, " +
  "for example WeRead's official skill. Prefer web_fetch for normal web pages. " +
  "Use secret placeholders like `$WEREAD_API_KEY` in headers/body; FLOWnote " +
  "substitutes them from Settings -> Skill management at execution time. " +
  "By default, returns as much response text as available context allows; " +
  "use maxBytes for a smaller slice and byteOffset to continue a cached response.";

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
      description: "Optional maximum bytes of response text to return.",
      minimum: 1024,
      maximum: 500000,
    },
    byteOffset: { type: "integer", minimum: 0, description: "Continue a cached response at this UTF-8 byte offset; never resends the request." },
  },
  required: ["url"],
};

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

function isCachedContinuation(input) {
  return !!input && Number.isInteger(input.byteOffset) && input.byteOffset > 0;
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

function describeUnresolved(pending) {
  const first = pending[0];
  const more = pending.length > 1 ? ` (and ${pending.length - 1} more)` : "";
  return `An earlier ${first.method} ${first.endpoint}${more} was sent, but its result is unknown (no response was recorded); it may already have taken effect`;
}

function pendingForInput(input, ctx) {
  if (isCachedContinuation(input) || normalizeMethod(input && input.method) === "GET") return [];
  return unresolvedAttemptsForScope(ctx && ctx.unresolvedEffectAttempts, effectAttemptScope(input && input.url));
}

function rememberUnresolved(ctx, entry) {
  if (!ctx || !Array.isArray(ctx.unresolvedEffectAttempts)) return;
  if (ctx.unresolvedEffectAttempts.some((item) => item.fingerprint === entry.fingerprint)) return;
  ctx.unresolvedEffectAttempts.push(entry);
}

function forgetUnresolved(ctx, pending) {
  if (!ctx || !Array.isArray(ctx.unresolvedEffectAttempts) || !pending.length) return;
  const done = new Set(pending.map((item) => item.fingerprint));
  for (let index = ctx.unresolvedEffectAttempts.length - 1; index >= 0; index -= 1) {
    if (done.has(ctx.unresolvedEffectAttempts[index].fingerprint)) ctx.unresolvedEffectAttempts.splice(index, 1);
  }
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
  const byteCap = typeof maxBytes === "number" && maxBytes > 0 ? maxBytes : undefined;
  const timeout = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : REQUEST_TIMEOUT_MS;
  const readSecrets = typeof getSecrets === "function" ? getSecrets : () => ({});
  const localEffectAttempts = [];
  const cachedResponses = new Map();

  return buildTool({
    name: "web_request",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    capabilities: (input) => {
      const method = normalizeMethod(input && input.method);
      const mutation = !isCachedContinuation(input) && method !== "GET";
      return {
        effect: mutation ? "network_mutation" : "observation",
        risk: mutation && isDangerousMethod(method) ? "high" : mutation ? "medium" : "low",
        concurrency: mutation ? "serial" : "parallel",
        presentation: "web",
        targets: input && typeof input.url === "string" ? [input.url] : [],
      };
    },
    isReadOnly: (input) => isCachedContinuation(input) || normalizeMethod(input && input.method) === "GET",
    isDestructive: (input) => !isCachedContinuation(input) && isDangerousMethod(input && input.method),
    isConcurrencySafe: (input) => isCachedContinuation(input) || normalizeMethod(input && input.method) === "GET",

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
      if (input.byteOffset !== undefined && (!Number.isInteger(input.byteOffset) || input.byteOffset < 0)) {
        return { ok: false, error: "byteOffset must be a non-negative integer." };
      }
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

    async checkPermissions(input, ctx) {
      if (isCachedContinuation(input)) return { behavior: "allow" };
      const method = normalizeMethod(input && input.method);
      const target = input && input.url ? String(input.url) : "URL";
      const pending = pendingForInput(input, ctx);
      if (pending.length) {
        const message = `${describeUnresolved(pending)}. Send ${method} ${effectAttemptEndpoint(target) || target} anyway?`;
        return {
          behavior: "ask",
          message,
          summary: message,
          risk: "dangerous",
          requiresExplicitConfirmation: true,
          unresolvedEffect: { method: pending[0].method, endpoint: pending[0].endpoint, count: pending.length },
        };
      }
      return {
        behavior: "ask",
        message: `Send ${method} request to ${target}?`,
        risk: isDangerousMethod(method) ? "dangerous" : "routine",
      };
    },

    async *execute(input, ctx) {
      const url = String(input.url).trim();
      const method = normalizeMethod(input.method);
      const requestedCap = Number.isInteger(input.maxBytes) ? input.maxBytes : byteCap;
      const cap = requestedCap === undefined ? undefined : Math.max(1024, Math.min(500000, requestedCap));
      const cacheKey = JSON.stringify({ url, method, headers: input.headers || {}, json: input.json, body: input.body });

      if (input.byteOffset > 0) {
        const cached = cachedResponses.get(cacheKey);
        if (!cached) {
          yield { type: "result", content: "web_request: no cached response for continuation; byteOffset=0 is required first. Mutating requests will not be replayed automatically.", isError: true };
          return;
        }
        try {
          const page = pageReadOutput(cached.text, { ctx, byteOffset: input.byteOffset, maxBytes: cap });
          const { text: pageText, ...pageMeta } = page;
          yield { type: "result", content: cached.header + pageText + pageNotice("web_request", page, "the same request arguments and "), isError: cached.isError, code: "cached_response", data: { page: pageMeta, originalCode: cached.code } };
        } catch (error) {
          yield { type: "result", content: `web_request: ${error.message}`, isError: true };
        }
        return;
      }

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

      let effectAttempt = null;
      let unresolvedEntry = null;
      if (method !== "GET") {
        const pending = pendingForInput(input, ctx);
        const confirmed = !!(ctx && ctx.explicitEffectConfirmation === true);
        if (pending.length && !confirmed) {
          // Host gate, independent of the permission prompt: never send a
          // change to a service that may already have applied an earlier one.
          yield {
            type: "result",
            content: `web_request: not sent. ${describeUnresolved(pending)}. Ask the user to check that service first; ` +
              "FLOWnote sends another change to it only after the user explicitly confirms.",
            isError: true,
            code: "unresolved_effect_confirmation_required",
          };
          return;
        }
        const ledger = ctx && Array.isArray(ctx.effectAttempts) ? ctx.effectAttempts : localEffectAttempts;
        const claim = await claimEffectAttempt(ledger, "web_request", projectWebMutationOperation(input));
        if (!claim.ok) {
          yield { type: "result", content: `web_request: ${claim.error}`, isError: true, code: "effect_attempt_unavailable" };
          return;
        }
        // An identical request whose first send has an unknown outcome may be
        // retried only with explicit confirmation; it reuses the same key.
        const confirmedRetry = claim.duplicate && confirmed && claim.entry.state === "unknown_after_send"
          && pending.some((item) => item.fingerprint === claim.entry.fingerprint);
        if (claim.duplicate && !confirmedRetry) {
          yield {
            type: "result",
            content: `web_request: duplicate external mutation suppressed; original attempt state is ${claim.entry.state}.`,
            isError: true,
            code: "duplicate_effect_suppressed",
          };
          return;
        }
        effectAttempt = claim.entry;
        unresolvedEntry = {
          fingerprint: effectAttempt.fingerprint,
          tool: "web_request",
          scope: effectAttemptScope(url),
          method,
          endpoint: effectAttemptEndpoint(url),
        };
        if (ctx && typeof ctx.recordEffectAttempt === "function") {
          try {
            await ctx.recordEffectAttempt({
              version: 1,
              fingerprint: effectAttempt.fingerprint,
              idempotencyKey: effectAttempt.idempotencyKey,
              ...unresolvedEntry,
              resolves: pending.map((item) => item.fingerprint),
            });
          } catch (error) {
            releaseEffectAttempt(ledger, effectAttempt);
            const reason = error instanceof Error ? error.message : String(error);
            yield {
              type: "result",
              content: `web_request: not sent; the attempt could not be recorded before sending (${maskKnownSecrets(reason, secrets)}).`,
              isError: true,
              code: "effect_attempt_not_recorded",
            };
            return;
          }
        }
        forgetUnresolved(ctx, pending);
        if (!hasHeader(headers, "idempotency-key")) headers["Idempotency-Key"] = effectAttempt.idempotencyKey;
        effectAttempt.state = "sending";
      }

      let response;
      let timeoutId = null;
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
          new Promise((_resolve, reject) => {
            timeoutId = setTimeout(() => reject(new Error(`Timed out after ${timeout}ms`)), timeout);
          }),
        ]);
      } catch (err) {
        if (effectAttempt) {
          effectAttempt.state = "unknown_after_send";
          rememberUnresolved(ctx, unresolvedEntry);
        }
        const rawMsg = err instanceof Error ? err.message : String(err);
        yield {
          type: "result",
          content: `web_request: request failed - ${maskKnownSecrets(rawMsg, secrets)}`,
          isError: true,
          code: effectAttempt ? "unknown_after_send" : "request_failed",
        };
        return;
      } finally {
        if (timeoutId !== null) clearTimeout(timeoutId);
      }

      const status = Number(response && response.status) || 0;
      const headersOut = (response && response.headers) || {};
      const contentType = responseHeader(headersOut, "content-type") || "unknown content-type";
      const rawBody = String(response && response.text ? response.text : "");
      const cleaned = rawBody.trim() || "(empty body)";

      const safeText = maskKnownSecrets(cleaned, secrets);
      const header = `URL: ${url}\nHTTP ${status} · ${contentType}\n\n`;
      const accepted = status >= 200 && status < 300;
      const rejected = status >= 400 && status < 500;
      if (effectAttempt) effectAttempt.state = accepted
        ? "accepted_unverified"
        : rejected ? "rejected" : "unknown_after_send";
      if (effectAttempt && effectAttempt.state === "unknown_after_send") rememberUnresolved(ctx, unresolvedEntry);
      const code = method === "GET" ? (accepted ? "ok" : "request_failed")
        : accepted ? "accepted_unverified" : rejected ? "request_rejected" : "unknown_after_send";
      cachedResponses.set(cacheKey, { header, text: safeText, isError: !accepted, code });
      if (cachedResponses.size > 4) cachedResponses.delete(cachedResponses.keys().next().value);
      let page;
      try {
        page = pageReadOutput(safeText, { ctx, maxBytes: cap });
      } catch (error) {
        yield {
          type: "result",
          content: `web_request: HTTP ${status} response cached, but ${error.message}`,
          isError: true,
          code: "response_budget_too_small",
          data: { originalCode: code },
        };
        return;
      }
      const { text: pageText, ...pageMeta } = page;
      const content = header + pageText + pageNotice("web_request", page, "the same request arguments and ");
      yield {
        type: "result",
        content,
        isError: !accepted,
        code,
        data: { page: pageMeta },
      };
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
