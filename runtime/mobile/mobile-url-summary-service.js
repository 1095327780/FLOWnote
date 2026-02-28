const { requestUrl } = require("obsidian");
const { normalizeSupportedLocale } = require("../i18n-locale-utils");
const {
  hasAiConfig,
  resolveAiConfig,
  summarizeTextWithAi,
  pickFirstText,
} = require("./mobile-ai-service");
const {
  LINK_RESOLVER_PROVIDER_IDS,
  normalizeLinkResolver,
  getResolverProviderPreset,
  getResolverProviderKey,
} = require("./mobile-settings-utils");

const URL_REGEX = /https?:\/\/[^\s)\]>，。！？]+/g;
const URL_TRAILING_ASCII_PUNCTUATION_REGEX = /[.,;:!?]+$/;

const LOCALE_MESSAGES = {
  "zh-CN": {
    errors: {
      resolverBodyEmpty: "正文为空",
      resolverUnsupported: "不支持的解析服务: {providerId}",
      resolverInvalidJson: "响应不是有效 JSON",
      resolverFailed: "解析失败",
      resolverFailedGeneral: "链接解析失败",
      resolverRateLimited: "频率受限",
      resolverTimeout: "服务超时",
      resolverUnavailable: "服务不可用",
    },
    url: {
      statusProviderMissing: "⚠️ {providerName} key missing, fallback to AI",
      statusNoResolverOrAi: "⚠️ Resolver and AI not configured, fallback to plain text",
      statusAiSummary: "🤖 Generating URL summary...",
      statusFallbackAi: "⚠️ {hint}, fallback to AI",
      statusFallbackPlain: "⚠️ {hint}, fallback to plain text",
      statusResolverNoAi: "⚠️ URL resolved but AI not configured, fallback to plain text",
      statusAiSummaryFailed: "⚠️ AI summary failed, fallback to plain text",
      statusPartialResolverFailed: "⚠️ Some URLs failed, partial result applied",
    },
    parser: {
      summaryFallback: "暂无法解析，已保留原始链接",
      untitled: "（未命名）",
    },
  },
  en: {
    errors: {
      resolverBodyEmpty: "Response body is empty",
      resolverUnsupported: "Unsupported resolver provider: {providerId}",
      resolverInvalidJson: "Response is not valid JSON",
      resolverFailed: "Resolver failed",
      resolverFailedGeneral: "URL resolver failed",
      resolverRateLimited: "Rate limited",
      resolverTimeout: "Resolver timeout",
      resolverUnavailable: "Resolver unavailable",
    },
    url: {
      statusProviderMissing: "⚠️ {providerName} key missing, fallback to AI",
      statusNoResolverOrAi: "⚠️ Resolver and AI not configured, fallback to plain text",
      statusAiSummary: "🤖 Generating URL summary...",
      statusFallbackAi: "⚠️ {hint}, fallback to AI",
      statusFallbackPlain: "⚠️ {hint}, fallback to plain text",
      statusResolverNoAi: "⚠️ URL resolved but AI not configured, fallback to plain text",
      statusAiSummaryFailed: "⚠️ AI summary failed, fallback to plain text",
      statusPartialResolverFailed: "⚠️ Some URLs failed, partial result applied",
    },
    parser: {
      summaryFallback: "Unable to resolve, original URL preserved",
      untitled: "(Untitled)",
    },
  },
};

function isZh(locale) {
  return normalizeSupportedLocale(locale) === "zh-CN";
}

function resolveLocalePack(locale) {
  return isZh(locale) ? LOCALE_MESSAGES["zh-CN"] : LOCALE_MESSAGES.en;
}

function interpolate(message, params = {}) {
  return String(message || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, key) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) return "";
    const value = params[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

function t(locale, path, params = {}) {
  const pack = resolveLocalePack(locale);
  const keys = String(path || "").split(".");
  let cursor = pack;
  for (const key of keys) {
    if (!cursor || typeof cursor !== "object" || !(key in cursor)) return path;
    cursor = cursor[key];
  }
  return interpolate(cursor, params);
}

function inferTitleFromUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return String(parsed.hostname || "").replace(/^www\./i, "").trim();
  } catch (_e) {
    return "";
  }
}

function safeJsonParse(rawText) {
  if (typeof rawText !== "string" || !rawText.trim()) return null;
  try {
    return JSON.parse(rawText);
  } catch (_e) {
    return null;
  }
}

function getResponsePayload(response) {
  if (response && response.json && typeof response.json === "object") return response.json;
  return safeJsonParse(response && response.text ? response.text : "");
}

function normalizeResolverText(input, maxLen = 2400) {
  const text = typeof input === "string" ? input.trim() : "";
  return text ? text.slice(0, maxLen) : "";
}

function stripTrailingUrlPunctuation(rawUrl) {
  return String(rawUrl || "").trim().replace(URL_TRAILING_ASCII_PUNCTUATION_REGEX, "");
}

function extractUrlsFromText(text) {
  const matches = String(text || "").match(URL_REGEX) || [];
  const seen = new Set();
  const urls = [];
  for (const raw of matches) {
    const cleaned = stripTrailingUrlPunctuation(raw);
    if (!cleaned || seen.has(cleaned)) continue;
    let parsed;
    try {
      parsed = new URL(cleaned);
    } catch (_e) {
      continue;
    }
    const protocol = String(parsed.protocol || "").toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") continue;
    seen.add(cleaned);
    urls.push(cleaned);
  }
  return urls;
}

function ensureUrlsPreserved(originalText, candidateText) {
  const output = String(candidateText || "").trim();
  if (!output) return "";
  const urls = extractUrlsFromText(originalText);
  for (const url of urls) {
    if (!output.includes(url)) return "";
  }
  return output;
}

function appendLinesToText(text, lines) {
  const clean = Array.isArray(lines)
    ? lines.map((line) => String(line || "").trim()).filter(Boolean)
    : [];
  if (!clean.length) return String(text || "");
  const base = String(text || "").trimEnd();
  return `${base}\n\n${clean.join("\n")}`;
}

function truncatePlainSummary(body, maxLen = 50, locale = "zh-CN") {
  const normalized = String(body || "")
    .replace(/\s+/g, " ")
    .replace(/[#>*`[\]_]/g, "")
    .trim();
  if (!normalized) return t(locale, "parser.summaryFallback");
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen - 1)}…` : normalized;
}

function buildResolverSummaryLines(urlContents, failedUrls, locale = "zh-CN") {
  const lines = [];
  for (const item of urlContents || []) {
    lines.push(`> 📎 ${item.url} - ${truncatePlainSummary(item.body || item.title || "", 50, locale)}`);
  }
  for (const url of failedUrls || []) {
    lines.push(`> 📎 ${url} - ${t(locale, "parser.summaryFallback")}`);
  }
  return lines;
}

async function sleepMs(ms) {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function mapWithConcurrency(items, limit, mapper) {
  const output = new Array(items.length);
  const workerCount = Math.max(1, Math.min(items.length, Number(limit) || 1));
  let cursor = 0;
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      output[idx] = await mapper(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return output;
}

function parseTianapiPayload(payload, locale = "zh-CN") {
  const code = Number(payload && payload.code);
  if (Number.isFinite(code) && code !== 200) {
    return { ok: false, error: pickFirstText([payload && payload.msg, payload && payload.message]) || `code=${code}` };
  }
  const result = payload && payload.result && typeof payload.result === "object" ? payload.result : {};
  const title = pickFirstText([result.title, result.name, payload && payload.title]);
  const body = normalizeResolverText(
    pickFirstText([result.content, result.text, result.desc, result.markdown, payload && payload.content, payload && payload.text]),
  );
  if (!body) return { ok: false, error: t(locale, "errors.resolverBodyEmpty") };
  return { ok: true, title: title || inferTitleFromUrl(result.url || payload && payload.url), body };
}

function parseShowapiPayload(payload, locale = "zh-CN") {
  const code = Number(payload && payload.showapi_res_code);
  if (Number.isFinite(code) && code !== 0) {
    return { ok: false, error: pickFirstText([payload && payload.showapi_res_error, payload && payload.message]) || `code=${code}` };
  }
  const bodyPayload = payload && payload.showapi_res_body && typeof payload.showapi_res_body === "object"
    ? payload.showapi_res_body
    : {};
  const title = pickFirstText([bodyPayload.title, payload && payload.title]);
  const body = normalizeResolverText(
    pickFirstText([bodyPayload.output, bodyPayload.content, bodyPayload.text, bodyPayload.markdown]),
  );
  if (!body) return { ok: false, error: t(locale, "errors.resolverBodyEmpty") };
  return { ok: true, title: title || inferTitleFromUrl(bodyPayload.url || payload && payload.url), body };
}

function parseGugudataPayload(payload, locale = "zh-CN") {
  const codeRaw = payload && (payload.code ?? payload.status ?? payload.errCode ?? payload.errcode);
  if (codeRaw !== undefined && codeRaw !== null && codeRaw !== "") {
    const code = String(codeRaw).trim().toLowerCase();
    const success = code === "0" || code === "200" || code === "ok" || code === "success" || code === "true";
    if (!success) {
      return { ok: false, error: pickFirstText([payload && payload.msg, payload && payload.message, payload && payload.error]) || `code=${code}` };
    }
  }
  const dataObj = payload && payload.data && typeof payload.data === "object"
    ? payload.data
    : payload && payload.result && typeof payload.result === "object"
      ? payload.result
      : payload && payload.Data && typeof payload.Data === "object"
        ? payload.Data
        : {};
  const title = pickFirstText([dataObj.title, dataObj.name, payload && payload.title]);
  const body = normalizeResolverText(
    pickFirstText([
      dataObj.markdown,
      dataObj.content,
      dataObj.text,
      dataObj.desc,
      payload && payload.markdown,
      payload && payload.content,
      payload && payload.text,
    ]),
  );
  if (!body) return { ok: false, error: t(locale, "errors.resolverBodyEmpty") };
  return { ok: true, title: title || inferTitleFromUrl(dataObj.url || payload && payload.url), body };
}

async function resolveUrlWithProvider(url, providerId, appKey, timeoutMs, locale = "zh-CN") {
  const pid = String(providerId || "").trim().toLowerCase();
  if (!LINK_RESOLVER_PROVIDER_IDS.includes(pid)) {
    return { ok: false, status: 0, error: t(locale, "errors.resolverUnsupported", { providerId: pid }) };
  }

  let request;
  if (pid === "tianapi") {
    request = {
      url: `https://apis.tianapi.com/htmltext/index?key=${encodeURIComponent(appKey)}&url=${encodeURIComponent(url)}`,
      method: "GET",
    };
  } else if (pid === "showapi") {
    request = {
      url: "https://route.showapi.com/3262-1",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `showapi_appid=2409036&showapi_sign=${encodeURIComponent(appKey)}&url=${encodeURIComponent(url)}`,
    };
  } else {
    request = {
      url: "https://api.gugudata.com/url2md",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${appKey}`,
      },
      body: JSON.stringify({ url }),
    };
  }

  let response;
  try {
    response = await requestUrl({
      ...request,
      throw: false,
      timeout: timeoutMs,
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const payload = getResponsePayload(response);
  if (!payload || typeof payload !== "object") {
    if (response.status !== 200) {
      return {
        ok: false,
        status: response.status,
        error: String(response.text || "").slice(0, 200),
      };
    }
    return { ok: false, status: response.status, error: t(locale, "errors.resolverInvalidJson") };
  }

  let parsed;
  if (pid === "tianapi") parsed = parseTianapiPayload(payload, locale);
  else if (pid === "showapi") parsed = parseShowapiPayload(payload, locale);
  else parsed = parseGugudataPayload(payload, locale);

  if (!parsed.ok) {
    return {
      ok: false,
      status: response.status,
      error: parsed.error,
      payload,
    };
  }

  return {
    ok: true,
    status: response.status,
    title: parsed.title,
    body: parsed.body,
    payload,
  };
}

async function resolveUrlsWithContextByResolver(text, mcSettings, options = {}) {
  const locale = normalizeSupportedLocale(options.locale || "en");
  const urlList = extractUrlsFromText(text);
  if (!urlList.length) return { urls: [], failures: [] };

  const mc = mcSettings && typeof mcSettings === "object" ? mcSettings : {};
  const linkResolver = normalizeLinkResolver(mc.linkResolver);
  if (!linkResolver.enabled) return { urls: [], failures: [] };

  const providerOrder = Array.isArray(linkResolver.providerOrder) && linkResolver.providerOrder.length
    ? linkResolver.providerOrder
    : [linkResolver.provider || LINK_RESOLVER_PROVIDER_IDS[0]];

  const timeoutMs = Math.max(5000, Number(linkResolver.timeoutMs) || 25000);
  const retries = Math.max(0, Math.min(5, Number(linkResolver.retries) || 2));
  const concurrency = Math.max(1, Math.min(5, Number(linkResolver.maxConcurrency) || 2));

  const results = await mapWithConcurrency(urlList, concurrency, async (url) => {
    for (const providerId of providerOrder) {
      const key = getResolverProviderKey(linkResolver, providerId);
      if (!key) continue;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        const result = await resolveUrlWithProvider(url, providerId, key, timeoutMs, locale);
        if (result.ok) {
          return {
            ok: true,
            provider: providerId,
            url,
            title: result.title,
            body: result.body,
          };
        }

        const errorText = String(result.error || "").toLowerCase();
        const shouldRetry = attempt < retries && /timeout|timed out|network|ecconn|econn|socket|429|rate/i.test(errorText);
        if (shouldRetry) {
          await sleepMs(200 * (attempt + 1));
          continue;
        }

        if (attempt >= retries) {
          return {
            ok: false,
            provider: providerId,
            url,
            error: String(result.error || t(locale, "errors.resolverFailed")),
          };
        }
      }
    }
    return {
      ok: false,
      provider: providerOrder[0] || "",
      url,
      error: t(locale, "errors.resolverFailed"),
    };
  });

  const urls = [];
  const failures = [];
  for (const result of results) {
    if (result && result.ok) urls.push(result);
    else if (result) failures.push(result);
  }

  return { urls, failures };
}

function buildResolverFailureHint(failures, locale = "zh-CN") {
  if (!Array.isArray(failures) || failures.length === 0) return t(locale, "errors.resolverFailedGeneral");
  const text = failures.map((item) => String(item && item.error ? item.error : "").toLowerCase()).join(" ");
  if (/(429|rate|limit|quota|频率|限流)/i.test(text)) return t(locale, "errors.resolverRateLimited");
  if (/(timeout|timed out|超时)/i.test(text)) return t(locale, "errors.resolverTimeout");
  return t(locale, "errors.resolverUnavailable");
}

async function enrichUrlsWithContextByAi(text, urlContents, mcSettings, options = {}) {
  const locale = normalizeSupportedLocale(options.locale || "en");
  if (!urlContents.length) return "";

  const context = urlContents
    .map((item) => {
      if (isZh(locale)) {
        return `--- URL: ${item.url} ---\n标题: ${item.title || t(locale, "parser.untitled")}\n内容摘要:\n${item.body}`;
      }
      return `--- URL: ${item.url} ---\nTitle: ${item.title || t(locale, "parser.untitled")}\nSummary:\n${item.body}`;
    })
    .join("\n\n");

  const prompt = `${text}\n\n${context}`;
  let aiText = "";
  try {
    aiText = await summarizeTextWithAi(prompt, mcSettings, { locale, useFallbackPrompt: false });
  } catch (_error) {
    return "";
  }

  const preserved = ensureUrlsPreserved(text, aiText);
  return preserved || "";
}

async function enrichUrlsInText(text, mcSettings, options = {}) {
  const locale = normalizeSupportedLocale(options.locale || "en");
  const onStatus = typeof options.onStatus === "function" ? options.onStatus : () => {};

  const urls = extractUrlsFromText(text);
  if (!urls.length) return { text, statusHint: "" };

  const mc = mcSettings && typeof mcSettings === "object" ? mcSettings : {};
  const linkResolver = normalizeLinkResolver(mc.linkResolver);
  const aiReady = hasAiConfig(mc);

  if (!linkResolver.enabled && !aiReady) {
    return { text, statusHint: t(locale, "url.statusNoResolverOrAi") };
  }

  const selectedProviderId = String(linkResolver.provider || LINK_RESOLVER_PROVIDER_IDS[0]).trim().toLowerCase();
  const selectedProviderPreset = getResolverProviderPreset(selectedProviderId);
  const selectedProviderKey = getResolverProviderKey(linkResolver, selectedProviderId);
  const selectedProviderName = selectedProviderPreset.name;

  if (!selectedProviderKey) {
    if (aiReady) {
      const hint = t(locale, "url.statusProviderMissing", { providerName: selectedProviderName });
      const fallbackLines = buildResolverSummaryLines([], urls, locale);
      onStatus(hint);
      const aiText = await summarizeTextWithAi(
        appendLinesToText(text, fallbackLines),
        mc,
        { locale, useFallbackPrompt: true },
      ).catch(() => "");
      const preserved = ensureUrlsPreserved(text, aiText);
      if (preserved) return { text: preserved, statusHint: "" };
      return { text: appendLinesToText(text, fallbackLines), statusHint: hint };
    }
    return { text, statusHint: t(locale, "url.statusNoResolverOrAi") };
  }

  onStatus(t(locale, "url.statusAiSummary"));
  const { urls: resolvedUrls, failures } = await resolveUrlsWithContextByResolver(text, mc, { locale });

  if (!resolvedUrls.length) {
    const failureHint = buildResolverFailureHint(failures, locale);
    if (aiReady) {
      const hint = t(locale, "url.statusFallbackAi", { hint: failureHint });
      const fallbackLines = buildResolverSummaryLines([], urls, locale);
      const aiText = await summarizeTextWithAi(
        appendLinesToText(text, fallbackLines),
        mc,
        { locale, useFallbackPrompt: true },
      ).catch(() => "");
      const preserved = ensureUrlsPreserved(text, aiText);
      if (preserved) return { text: preserved, statusHint: "" };
      return { text: appendLinesToText(text, fallbackLines), statusHint: hint };
    }
    return {
      text: appendLinesToText(text, buildResolverSummaryLines([], urls, locale)),
      statusHint: t(locale, "url.statusFallbackPlain", { hint: failureHint }),
    };
  }

  const failedUrls = failures.map((item) => item.url).filter(Boolean);
  if (!aiReady) {
    return {
      text: appendLinesToText(text, buildResolverSummaryLines(resolvedUrls, failedUrls, locale)),
      statusHint: t(locale, "url.statusResolverNoAi"),
    };
  }

  const summarized = await enrichUrlsWithContextByAi(text, resolvedUrls, mc, { locale });
  if (!summarized) {
    return {
      text: appendLinesToText(text, buildResolverSummaryLines(resolvedUrls, failedUrls, locale)),
      statusHint: t(locale, "url.statusAiSummaryFailed"),
    };
  }

  if (failures.length > 0) {
    return {
      text: appendLinesToText(summarized, buildResolverSummaryLines([], failedUrls, locale)),
      statusHint: t(locale, "url.statusPartialResolverFailed"),
    };
  }

  return { text: summarized, statusHint: "" };
}

module.exports = {
  extractUrlsFromText,
  stripTrailingUrlPunctuation,
  ensureUrlsPreserved,
  appendLinesToText,
  buildResolverSummaryLines,
  parseTianapiPayload,
  parseShowapiPayload,
  parseGugudataPayload,
  resolveUrlWithProvider,
  resolveUrlsWithContextByResolver,
  buildResolverFailureHint,
  enrichUrlsWithContextByAi,
  enrichUrlsInText,
};
