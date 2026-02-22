const obsidianModule = require("obsidian");
const {
  Modal = class {},
  Notice = class {},
  Plugin = class {},
  Platform = { isMobile: false },
  PluginSettingTab = class {},
  Setting = class {},
  normalizePath = (value) => String(value || ""),
  requestUrl = async () => ({ status: 500, text: "", json: null }),
} = obsidianModule;

const DEFAULT_VIEW_TYPE = "flownote-view";

/* =========================================================================
 * Mobile-only code (inlined — mobile Obsidian has no Node.js require)
 * ========================================================================= */

// --- Mobile: settings defaults & normalization ---

const LINK_RESOLVER_PROVIDER_IDS = ["tianapi", "showapi", "gugudata"];

const LINK_RESOLVER_PROVIDER_PRESETS = {
  tianapi: {
    id: "tianapi",
    name: "TianAPI",
    keyField: "tianapiKey",
    keyLabel: "TianAPI Key",
    keyPlaceholder: "tianapi key",
    keyUrl: "https://www.tianapi.com/apiview/66",
    docsUrl: "https://www.tianapi.com/apiview/66",
    hint: "适合基础网页正文抓取；动态页面或强反爬页面可能失败。",
  },
  showapi: {
    id: "showapi",
    name: "ShowAPI（万维易源）",
    keyField: "showapiAppKey",
    keyLabel: "ShowAPI AppKey",
    keyPlaceholder: "showapi appKey",
    keyUrl: "https://www.showapi.com/apiGateway/view/3262/1",
    docsUrl: "https://www.showapi.com/apiGateway/view/3262/1",
    hint: "按调用计费，部分套餐有免费额度；适合作为低门槛选项。",
  },
  gugudata: {
    id: "gugudata",
    name: "咕咕数据",
    keyField: "gugudataAppKey",
    keyLabel: "咕咕数据 AppKey",
    keyPlaceholder: "gugudata appkey",
    keyUrl: "https://www.gugudata.com/api/details/url2markdown",
    docsUrl: "https://www.gugudata.com/api/details/url2markdown",
    hint: "输出 Markdown 质量较稳定；官方建议控制请求频率。",
  },
};

const LINK_RESOLVER_DEFAULTS = {
  enabled: true,
  provider: "tianapi",
  providerOrder: [...LINK_RESOLVER_PROVIDER_IDS],
  tianapiKey: "",
  showapiAppKey: "",
  gugudataAppKey: "",
  timeoutMs: 25000,
  retries: 2,
  maxConcurrency: 2,
  fallbackMode: "ai_then_plain",
};

function normalizeProviderOrder(raw, defaults = LINK_RESOLVER_DEFAULTS.providerOrder) {
  const incoming = Array.isArray(raw)
    ? raw
    : String(raw || "")
      .split(/[,\s>，]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  const normalized = [];
  for (const item of incoming) {
    const id = String(item || "").trim().toLowerCase();
    if (!LINK_RESOLVER_PROVIDER_IDS.includes(id)) continue;
    if (normalized.includes(id)) continue;
    normalized.push(id);
  }
  return normalized.length ? normalized : [...defaults];
}

function normalizeResolverProviderId(raw, fallback = LINK_RESOLVER_DEFAULTS.provider) {
  const id = String(raw || "").trim().toLowerCase();
  if (LINK_RESOLVER_PROVIDER_IDS.includes(id)) return id;
  const normalizedFallback = String(fallback || "").trim().toLowerCase();
  if (LINK_RESOLVER_PROVIDER_IDS.includes(normalizedFallback)) return normalizedFallback;
  return LINK_RESOLVER_PROVIDER_IDS[0];
}

function getResolverProviderPreset(providerId) {
  return LINK_RESOLVER_PROVIDER_PRESETS[normalizeResolverProviderId(providerId)]
    || LINK_RESOLVER_PROVIDER_PRESETS[LINK_RESOLVER_DEFAULTS.provider];
}

function normalizeLinkResolver(raw) {
  const lr = raw && typeof raw === "object"
    ? Object.assign({}, LINK_RESOLVER_DEFAULTS, raw)
    : { ...LINK_RESOLVER_DEFAULTS };
  lr.enabled = typeof lr.enabled === "boolean" ? lr.enabled : LINK_RESOLVER_DEFAULTS.enabled;
  lr.providerOrder = normalizeProviderOrder(lr.providerOrder);
  lr.provider = normalizeResolverProviderId(lr.provider, lr.providerOrder[0]);
  lr.tianapiKey = String(lr.tianapiKey || "").trim();
  lr.showapiAppKey = String(lr.showapiAppKey || "").trim();
  lr.gugudataAppKey = String(lr.gugudataAppKey || "").trim();
  lr.timeoutMs = Math.max(5000, Number(lr.timeoutMs) || LINK_RESOLVER_DEFAULTS.timeoutMs);
  lr.retries = Math.min(5, Math.max(0, Number.isFinite(Number(lr.retries)) ? Number(lr.retries) : LINK_RESOLVER_DEFAULTS.retries));
  lr.maxConcurrency = Math.min(
    5,
    Math.max(1, Number.isFinite(Number(lr.maxConcurrency)) ? Number(lr.maxConcurrency) : LINK_RESOLVER_DEFAULTS.maxConcurrency),
  );
  lr.fallbackMode = lr.fallbackMode === "ai_then_plain" ? "ai_then_plain" : LINK_RESOLVER_DEFAULTS.fallbackMode;
  return lr;
}

const MOBILE_CAPTURE_DEFAULTS = {
  provider: "deepseek",
  apiKey: "",
  baseUrl: "",
  model: "",
  dailyNotePath: "01-捕获层/每日笔记",
  ideaSectionHeader: "### 💡 想法和灵感",
  enableAiCleanup: true,
  enableUrlSummary: true,
  linkResolver: { ...LINK_RESOLVER_DEFAULTS },
};

function normalizeMobileSettings(raw) {
  const data = raw && typeof raw === "object" ? { ...raw } : {};
  // Merge mobileCapture
  const mcDefaults = MOBILE_CAPTURE_DEFAULTS;
  if (!data.mobileCapture || typeof data.mobileCapture !== "object") {
    data.mobileCapture = { ...mcDefaults };
  } else {
    data.mobileCapture = Object.assign({}, mcDefaults, data.mobileCapture);
  }
  const mc = data.mobileCapture;
  mc.provider = String(mc.provider || mcDefaults.provider).trim();
  mc.apiKey = String(mc.apiKey || "").trim();
  mc.baseUrl = String(mc.baseUrl || "").trim();
  mc.model = String(mc.model || "").trim();
  mc.dailyNotePath = String(mc.dailyNotePath || mcDefaults.dailyNotePath).trim();
  mc.ideaSectionHeader = String(mc.ideaSectionHeader || mcDefaults.ideaSectionHeader).trim();
  mc.enableAiCleanup = typeof mc.enableAiCleanup === "boolean" ? mc.enableAiCleanup : mcDefaults.enableAiCleanup;
  mc.enableUrlSummary = typeof mc.enableUrlSummary === "boolean" ? mc.enableUrlSummary : mcDefaults.enableUrlSummary;
  mc.linkResolver = normalizeLinkResolver(mc.linkResolver);
  return data;
}

// --- Mobile: AI service ---

const PROVIDER_PRESETS = {
  deepseek: { name: "DeepSeek", baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-chat", keyUrl: "https://platform.deepseek.com/api_keys" },
  qwen: { name: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode", defaultModel: "qwen-turbo", keyUrl: "https://dashscope.console.aliyun.com/apiKey" },
  moonshot: { name: "Moonshot (Kimi)", baseUrl: "https://api.moonshot.cn", defaultModel: "moonshot-v1-8k", keyUrl: "https://platform.moonshot.cn/console/api-keys" },
  zhipu: { name: "智谱 (GLM)", baseUrl: "https://open.bigmodel.cn/api/paas", defaultModel: "glm-4-flash", keyUrl: "https://open.bigmodel.cn/usercenter/apikeys" },
  siliconflow: { name: "SiliconFlow", baseUrl: "https://api.siliconflow.cn", defaultModel: "deepseek-ai/DeepSeek-V3", keyUrl: "https://cloud.siliconflow.cn/account/ak" },
  custom: { name: "自定义", baseUrl: "", defaultModel: "", keyUrl: "" },
};

const CAPTURE_SYSTEM_PROMPT =
  "你是一个文字清理助手。你的唯一任务是去除口语中的语气词和填充词（如：嗯、啊、那个、就是、然后、对、哦、emmm、额 等），\n" +
  "让句子更简洁。\n" +
  "规则：\n" +
  "1. 只去除语气词和填充词\n" +
  "2. 不要改写、润色或美化原文\n" +
  "3. 不要添加任何新内容\n" +
  "4. 不要改变原文的意思和表达方式\n" +
  "5. 保留所有实质内容和原始用词\n" +
  "6. 保留所有 URL 链接，原样输出，绝对不要改动、解释或回复 URL 内容\n" +
  "7. 直接返回清理后的文本，不要任何解释或前缀";

const URL_SUMMARY_PROMPT =
  "你是一个链接摘要助手。用户文本中包含 URL，我已经抓取了对应页面内容。\n" +
  "请输出：保留原文不改动，并在末尾追加摘要列表。\n" +
  "格式：每条一行 `> 📎 原始URL - 摘要`\n" +
  "规则：\n" +
  "- 必须保留原文中的所有原始 URL，不能替换、删改、缩短\n" +
  "- 摘要不超过 50 字\n" +
  "- 不要改动 URL 以外的原文内容\n" +
  "- 如果内容不足，写“暂无法解析，已保留原始链接”\n" +
  "- 直接返回处理后的完整文本，不要解释";

const URL_AI_FALLBACK_PROMPT =
  "你是一个链接降级助手。\n" +
  "任务：在无法获取网页正文时，对原文做最小化处理。\n" +
  "规则：\n" +
  "1. 原文必须完整保留，所有 URL 必须保留原样\n" +
  "2. 不允许改写原文，不允许编造网页内容\n" +
  "3. 仅可在末尾追加提示行，格式 `> 📎 原始URL - 暂无法解析，已保留原始链接`\n" +
  "4. 直接返回处理后的完整文本";

const URL_REGEX = /https?:\/\/[^\s)\]>，。！？]+/g;
const URL_TRAILING_ASCII_PUNCTUATION_REGEX = /[.,;:!?]+$/;
const URL_SUMMARY_LINE_REGEX = /^\s*>\s*📎\s*(https?:\/\/\S+|原始URL)\s*-\s*(.+?)\s*$/i;
const INLINE_URL_SUMMARY_REGEX = />\s*📎\s*(https?:\/\/\S+|原始URL)\s*-\s*(.+?)\s*$/i;

function resolveAiConfig(mcSettings) {
  const providerId = mcSettings.provider || "deepseek";
  const preset = PROVIDER_PRESETS[providerId] || PROVIDER_PRESETS.deepseek;
  const baseUrl = String(mcSettings.baseUrl || preset.baseUrl || "").replace(/\/+$/, "");
  const model = String(mcSettings.model || preset.defaultModel || "").trim();
  const apiKey = String(mcSettings.apiKey || "").trim();
  return { providerId, preset, baseUrl, model, apiKey };
}

function hasAiConfig(mcSettings) {
  const ai = resolveAiConfig(mcSettings);
  return Boolean(ai.baseUrl && ai.apiKey);
}

function pickFirstText(values) {
  for (const value of values) {
    if (typeof value === "string") {
      const text = value.trim();
      if (text) return text;
    }
  }
  return "";
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
  const matches = text.match(URL_REGEX) || [];
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

function truncatePlainSummary(body, maxLen = 50) {
  const normalized = String(body || "")
    .replace(/\s+/g, " ")
    .replace(/[#>*`[\]_]/g, "")
    .trim();
  if (!normalized) return "暂无法解析，已保留原始链接";
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen - 1)}…` : normalized;
}

function buildResolverSummaryLines(urlContents, failedUrls) {
  const lines = [];
  for (const item of urlContents || []) {
    lines.push(`> 📎 ${item.url} - ${truncatePlainSummary(item.body || item.title || "")}`);
  }
  for (const url of failedUrls || []) {
    lines.push(`> 📎 ${url} - 暂无法解析，已保留原始链接`);
  }
  return lines;
}

function normalizeSingleLine(text, fallback = "") {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || fallback;
}

function parseSummaryItemFromMatch(match, linePrefix = "") {
  const rawTarget = String(match && match[1] ? match[1] : "").trim();
  const summary = normalizeSingleLine(match && match[2] ? match[2] : "", "暂无法解析，已保留原始链接");
  const isPlaceholder = /^原始url$/i.test(rawTarget);
  const directUrl = isPlaceholder ? "" : stripTrailingUrlPunctuation(rawTarget);
  const hints = extractUrlsFromText(String(linePrefix || ""));
  const urlHint = hints.length ? hints[hints.length - 1] : "";
  return {
    url: directUrl,
    urlHint,
    summary,
    hasSummary: true,
  };
}

function parseCaptureTextSections(text) {
  const raw = String(text || "").replace(/\r\n?/g, "\n");
  const lines = raw.split("\n");
  const bodyLines = [];
  const summaryItems = [];

  for (const line of lines) {
    const pureMatch = line.match(URL_SUMMARY_LINE_REGEX);
    if (pureMatch) {
      summaryItems.push(parseSummaryItemFromMatch(pureMatch, ""));
      continue;
    }
    const inlineMatch = line.match(INLINE_URL_SUMMARY_REGEX);
    if (inlineMatch) {
      const markerStart = line.search(/>\s*📎\s*(https?:\/\/\S+|原始URL)\s*-\s*/i);
      const prefix = markerStart >= 0 ? line.slice(0, markerStart).trimEnd() : String(line || "").trimEnd();
      if (prefix.trim()) bodyLines.push(prefix);
      summaryItems.push(parseSummaryItemFromMatch(inlineMatch, prefix));
      continue;
    }
    bodyLines.push(line);
  }

  const body = bodyLines.join("\n").trim();
  const orderedUrls = extractUrlsFromText(body);
  const resolvedSummaryItems = [];
  const summaryByUrl = new Map();
  for (const item of summaryItems) {
    let targetUrl = String(item && item.url ? item.url : "").trim();
    if (!targetUrl) {
      const hint = String(item && item.urlHint ? item.urlHint : "").trim();
      if (hint && orderedUrls.includes(hint)) {
        targetUrl = hint;
      } else {
        targetUrl = orderedUrls.find((url) => !summaryByUrl.has(url)) || "";
      }
    }
    if (!targetUrl) continue;
    const resolved = { url: targetUrl, summary: item.summary, hasSummary: true };
    resolvedSummaryItems.push(resolved);
    if (!summaryByUrl.has(targetUrl)) summaryByUrl.set(targetUrl, item.summary);
  }

  const resolverItems = [];
  const seen = new Set();
  for (const url of orderedUrls) {
    const explicitSummary = summaryByUrl.get(url) || "";
    resolverItems.push({
      url,
      summary: explicitSummary,
      hasSummary: Boolean(explicitSummary),
    });
    seen.add(url);
  }
  for (const item of resolvedSummaryItems) {
    if (seen.has(item.url)) continue;
    resolverItems.push(item);
    seen.add(item.url);
  }

  return {
    body: body || raw.trim(),
    resolverItems,
  };
}

function normalizeCaptureParagraph(text) {
  let normalized = String(text || "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!normalized) return "";
  normalized = normalized.replace(/^原文[:：]\s*/i, "");
  normalized = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  return normalized.replace(/\s+/g, " ").trim();
}

function formatResolverInlineSummary(resolverItems) {
  const items = Array.isArray(resolverItems)
    ? resolverItems.filter((item) => item && item.hasSummary)
    : [];
  if (!items.length) return "";

  if (items.length === 1) {
    return `（链接摘要：${normalizeSingleLine(items[0].summary, "暂无法解析，已保留原始链接")}）`;
  }

  const usedLabels = new Map();
  const parts = items.map((item, index) => {
    const base = inferTitleFromUrl(item.url) || `链接${index + 1}`;
    const count = (usedLabels.get(base) || 0) + 1;
    usedLabels.set(base, count);
    const label = count > 1 ? `${base}#${count}` : base;
    return `${label}：${normalizeSingleLine(item.summary, "暂无法解析，已保留原始链接")}`;
  });
  return `（链接摘要：${parts.join("；")}）`;
}

function getResolverProviderKey(linkResolver, providerId) {
  if (providerId === "tianapi") return String(linkResolver.tianapiKey || "").trim();
  if (providerId === "showapi") return String(linkResolver.showapiAppKey || "").trim();
  if (providerId === "gugudata") return String(linkResolver.gugudataAppKey || "").trim();
  return "";
}

function setResolverProviderKey(linkResolver, providerId, nextValue) {
  const value = String(nextValue || "").trim();
  if (providerId === "tianapi") {
    linkResolver.tianapiKey = value;
    return;
  }
  if (providerId === "showapi") {
    linkResolver.showapiAppKey = value;
    return;
  }
  if (providerId === "gugudata") {
    linkResolver.gugudataAppKey = value;
  }
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

function parseTianapiPayload(payload) {
  const code = Number(payload && payload.code);
  if (Number.isFinite(code) && code !== 200) {
    return { ok: false, error: pickFirstText([payload && payload.msg, payload && payload.message]) || `code=${code}` };
  }
  const result = payload && payload.result && typeof payload.result === "object" ? payload.result : {};
  const title = pickFirstText([result.title, result.name, payload && payload.title]);
  const body = normalizeResolverText(
    pickFirstText([result.content, result.text, result.desc, result.markdown, payload && payload.content, payload && payload.text]),
  );
  if (!body) return { ok: false, error: "正文为空" };
  return { ok: true, title: title || inferTitleFromUrl(result.url || payload && payload.url), body };
}

function parseShowapiPayload(payload) {
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
  if (!body) return { ok: false, error: "正文为空" };
  return { ok: true, title: title || inferTitleFromUrl(bodyPayload.url || payload && payload.url), body };
}

function parseGugudataPayload(payload) {
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
  const title = pickFirstText([dataObj.title, payload && payload.title]);
  const body = normalizeResolverText(
    pickFirstText([
      dataObj.markdown,
      dataObj.output,
      dataObj.content,
      dataObj.text,
      payload && payload.markdown,
      payload && payload.content,
      payload && payload.output,
    ]),
  );
  if (!body) return { ok: false, error: "正文为空" };
  return { ok: true, title: title || inferTitleFromUrl(dataObj.url || payload && payload.url), body };
}

async function resolveUrlWithProvider(providerId, targetUrl, apiKey, timeoutMs) {
  let requestUrlValue = "";
  if (providerId === "tianapi") {
    requestUrlValue = `https://apis.tianapi.com/htmltext/index?key=${encodeURIComponent(apiKey)}&url=${encodeURIComponent(targetUrl)}`;
  } else if (providerId === "showapi") {
    requestUrlValue = `https://route.showapi.com/3262-1?appKey=${encodeURIComponent(apiKey)}&url=${encodeURIComponent(targetUrl)}`;
  } else if (providerId === "gugudata") {
    requestUrlValue = `https://api.gugudata.com/websitetools/url2markdown?appkey=${encodeURIComponent(apiKey)}&url=${encodeURIComponent(targetUrl)}`;
  } else {
    return { ok: false, status: 0, error: `不支持的解析服务: ${providerId}` };
  }

  try {
    const response = await requestUrl({
      url: requestUrlValue,
      method: "GET",
      headers: { Accept: "application/json,text/plain,*/*" },
      throw: false,
      timeout: timeoutMs,
    });
    if (response.status !== 200) {
      return { ok: false, status: response.status, error: `HTTP ${response.status}` };
    }

    const payload = getResponsePayload(response);
    if (!payload || typeof payload !== "object") {
      return { ok: false, status: response.status, error: "响应不是有效 JSON" };
    }

    if (providerId === "tianapi") return parseTianapiPayload(payload);
    if (providerId === "showapi") return parseShowapiPayload(payload);
    return parseGugudataPayload(payload);
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function resolveUrlContent(targetUrl, mcSettings) {
  const linkResolver = normalizeLinkResolver(mcSettings && mcSettings.linkResolver);
  const providerId = normalizeResolverProviderId(linkResolver.provider, linkResolver.providerOrder && linkResolver.providerOrder[0]);
  const key = getResolverProviderKey(linkResolver, providerId);
  if (!key) return { ok: false, reason: "missing_provider_key", providerId, failures: [] };

  const failures = [];
  for (let attempt = 0; attempt <= linkResolver.retries; attempt += 1) {
    const result = await resolveUrlWithProvider(providerId, targetUrl, key, linkResolver.timeoutMs);
    if (result.ok) {
      const title = pickFirstText([result.title, inferTitleFromUrl(targetUrl)]);
      return { ok: true, providerId, title, body: result.body, failures };
    }

    if (attempt >= linkResolver.retries) {
      failures.push({
        providerId,
        status: Number(result.status) || 0,
        error: String(result.error || "解析失败"),
      });
      break;
    }
    const backoffMs = 500 * (2 ** attempt);
    await sleepMs(backoffMs);
  }
  return { ok: false, reason: "all_failed", failures };
}

function buildResolverFailureHint(failures) {
  if (!Array.isArray(failures) || failures.length === 0) return "链接解析失败";
  if (failures.some((f) => Number(f.status) === 429 || /429|rate|limit|频率|限流/i.test(String(f.error || "")))) {
    return "频率受限";
  }
  if (failures.some((f) => Number(f.status) === 408 || /timeout|timed out|超时/i.test(String(f.error || "")))) {
    return "服务超时";
  }
  return "服务不可用";
}

async function requestAiCompletion(messages, mcSettings, options = {}) {
  const throwOnError = Boolean(options.throwOnError);
  const timeoutMs = Math.max(5000, Number(options.timeoutMs) || 30000);
  const ai = resolveAiConfig(mcSettings);
  if (!ai.baseUrl || !ai.apiKey) {
    if (throwOnError) throw new Error("AI 服务未配置：缺少 Base URL 或 API Key");
    return "";
  }

  try {
    const response = await requestUrl({
      url: `${ai.baseUrl}/v1/chat/completions`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ai.apiKey}`,
      },
      body: JSON.stringify({
        model: ai.model,
        temperature: 0.1,
        messages,
      }),
      throw: false,
      timeout: timeoutMs,
    });
    if (response.status !== 200) {
      if (throwOnError) {
        throw new Error(`AI 请求失败 (${response.status}): ${JSON.stringify(response.json || response.text).slice(0, 200)}`);
      }
      return "";
    }

    const data = response.json;
    const content =
      data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;
    const normalized = typeof content === "string" ? content.trim() : "";
    if (!normalized && throwOnError) throw new Error("AI 返回内容为空");
    return normalized;
  } catch (e) {
    if (throwOnError) throw e;
    return "";
  }
}

async function cleanupCapture(text, mcSettings) {
  const cleaned = await requestAiCompletion(
    [
      { role: "system", content: CAPTURE_SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
    mcSettings,
    { throwOnError: true, timeoutMs: 30000 },
  );
  return ensureUrlsPreserved(text, cleaned) || text;
}

async function testConnection(mcSettings) {
  try {
    const result = await cleanupCapture("嗯，这是一个测试", mcSettings);
    return { ok: true, message: `连接成功，返回: "${result}"` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

async function enrichUrlsWithContextByAi(text, urlContents, mcSettings) {
  const contextBlock = urlContents
    .map((item) => `--- URL: ${item.url} ---\n标题: ${item.title || "（无标题）"}\n内容摘要:\n${item.body}`)
    .join("\n\n");
  const userMessage = `原文：\n${text}\n\n以下是各链接的页面内容：\n${contextBlock}`;
  const output = await requestAiCompletion(
    [
      { role: "system", content: URL_SUMMARY_PROMPT },
      { role: "user", content: userMessage },
    ],
    mcSettings,
    { throwOnError: false, timeoutMs: 30000 },
  );
  return ensureUrlsPreserved(text, output);
}

async function enrichUrlsWithAiFallback(text, mcSettings) {
  const output = await requestAiCompletion(
    [
      { role: "system", content: URL_AI_FALLBACK_PROMPT },
      { role: "user", content: text },
    ],
    mcSettings,
    { throwOnError: false, timeoutMs: 20000 },
  );
  return ensureUrlsPreserved(text, output);
}

async function enrichUrlsInText(text, mcSettings, options = {}) {
  const onStatus = typeof options.onStatus === "function" ? options.onStatus : () => {};
  const urls = extractUrlsFromText(text);
  if (urls.length === 0) return { text, statusHint: "" };

  const linkResolver = normalizeLinkResolver(mcSettings && mcSettings.linkResolver);
  if (!linkResolver.enabled) return { text, statusHint: "" };
  const selectedProvider = normalizeResolverProviderId(linkResolver.provider, linkResolver.providerOrder && linkResolver.providerOrder[0]);
  const selectedKey = getResolverProviderKey(linkResolver, selectedProvider);
  const selectedProviderName = getResolverProviderPreset(selectedProvider).name;
  const aiReady = hasAiConfig(mcSettings);

  if (!selectedKey) {
    if (aiReady) {
      const hint = `⚠️ ${selectedProviderName} 未配置 Key，已回退 AI`;
      onStatus(hint);
      const fallback = await enrichUrlsWithAiFallback(text, mcSettings);
      const fallbackText = fallback || appendLinesToText(text, buildResolverSummaryLines([], urls));
      return { text: fallbackText, statusHint: hint };
    }
    return {
      text: appendLinesToText(text, buildResolverSummaryLines([], urls)),
      statusHint: "⚠️ 未配置解析或 AI，已回退纯文本",
    };
  }

  onStatus("🔗 解析链接内容…");
  const resolved = await mapWithConcurrency(urls, linkResolver.maxConcurrency, async (url) => {
    const result = await resolveUrlContent(url, mcSettings);
    return { url, result };
  });

  const urlContents = [];
  const failures = [];
  const failedUrls = [];
  for (const item of resolved) {
    if (item && item.result && item.result.ok) {
      urlContents.push({
        url: item.url,
        title: item.result.title,
        body: item.result.body,
      });
      continue;
    }
    failedUrls.push(item.url);
    const failed = item && item.result ? item.result : {};
    if (Array.isArray(failed.failures) && failed.failures.length) {
      failures.push(...failed.failures);
    } else {
      failures.push({
        providerId: "unknown",
        status: 0,
        error: failed.reason || "解析失败",
      });
    }
  }

  if (urlContents.length === 0) {
    const failureHint = buildResolverFailureHint(failures);
    if (aiReady) {
      const hint = `⚠️ ${failureHint}，已回退 AI`;
      onStatus(hint);
      const fallback = await enrichUrlsWithAiFallback(text, mcSettings);
      const fallbackText = fallback || appendLinesToText(text, buildResolverSummaryLines([], urls));
      return { text: fallbackText, statusHint: hint };
    }
    return {
      text: appendLinesToText(text, buildResolverSummaryLines([], urls)),
      statusHint: `⚠️ ${failureHint}，已回退纯文本`,
    };
  }

  if (!aiReady) {
    return {
      text: appendLinesToText(text, buildResolverSummaryLines(urlContents, failedUrls)),
      statusHint: "⚠️ 已解析链接但未配置 AI，已回退纯文本",
    };
  }

  onStatus("🤖 生成链接摘要…");
  const summarized = await enrichUrlsWithContextByAi(text, urlContents, mcSettings);
  if (!summarized) {
    return {
      text: appendLinesToText(text, buildResolverSummaryLines(urlContents, failedUrls)),
      statusHint: "⚠️ AI 摘要失败，已回退纯文本",
    };
  }

  if (failures.length > 0) {
    return {
      text: appendLinesToText(summarized, buildResolverSummaryLines([], failedUrls)),
      statusHint: "⚠️ 部分链接解析失败，已使用可用结果",
    };
  }
  return { text: summarized, statusHint: "" };
}

// --- Mobile: daily note service ---

const DAILY_NOTE_TEMPLATE = `# {{date}}

## 📋 今日计划
- [ ]

## 📝 今日记录

### 💡 想法和灵感

### 📖 学习笔记

## 🔄 每日回顾
- 今天做了什么：
- 明天计划：
`;

function formatDateStr(date) {
  const d = date || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatTimeStr(date) {
  const d = date || new Date();
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function formatCaptureEntry(timeStr, text) {
  const { body, resolverItems } = parseCaptureTextSections(text);
  const paragraph = normalizeCaptureParagraph(body || text) || "（空）";
  const inlineSummary = formatResolverInlineSummary(resolverItems);
  return `- ${timeStr} ${paragraph}${inlineSummary ? ` ${inlineSummary}` : ""}`;
}

async function ensureFolders(vault, filePath) {
  const parts = filePath.split("/");
  parts.pop();
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const normalized = normalizePath(current);
    if (!vault.getAbstractFileByPath(normalized)) {
      try { await vault.createFolder(normalized); } catch (_e) { /* concurrent */ }
    }
  }
}

async function findOrCreateDailyNote(vault, dailyNotePath, dateStr) {
  const date = dateStr || formatDateStr();
  const filePath = normalizePath(`${dailyNotePath}/${date}.md`);

  const existing = vault.getAbstractFileByPath(filePath);
  if (existing) return existing;

  await ensureFolders(vault, filePath);
  const content = DAILY_NOTE_TEMPLATE.replace(/\{\{date\}\}/g, date);
  return await vault.create(filePath, content);
}

async function appendToIdeaSection(vault, file, entry, sectionHeader) {
  let content = await vault.read(file);
  const headerIdx = content.indexOf(sectionHeader);

  if (headerIdx !== -1) {
    const afterHeader = headerIdx + sectionHeader.length;
    const restContent = content.slice(afterHeader);
    const nextHeadingMatch = restContent.match(/\n(#{1,6} )/);
    let insertPos;

    if (nextHeadingMatch) {
      insertPos = afterHeader + nextHeadingMatch.index;
    } else {
      insertPos = content.length;
    }

    const sectionContent = content.slice(afterHeader, insertPos);
    const lastDashIdx = sectionContent.lastIndexOf("\n- ");

    if (lastDashIdx !== -1) {
      const lineStart = afterHeader + lastDashIdx + 1;
      const lineEnd = content.indexOf("\n", lineStart + 1);
      let actualEnd = lineEnd === -1 ? content.length : lineEnd;
      // Skip continuation lines (blockquotes / indented lines belonging to the same entry)
      while (actualEnd < content.length) {
        const nextLineEnd = content.indexOf("\n", actualEnd + 1);
        const nextLine = content.slice(actualEnd + 1, nextLineEnd === -1 ? content.length : nextLineEnd);
        if (nextLine.startsWith("  >") || (nextLine.startsWith("  ") && !nextLine.startsWith("- "))) {
          actualEnd = nextLineEnd === -1 ? content.length : nextLineEnd;
        } else {
          break;
        }
      }
      content = content.slice(0, actualEnd) + "\n" + entry + content.slice(actualEnd);
    } else {
      const headerLineEnd = content.indexOf("\n", headerIdx);
      if (headerLineEnd !== -1) {
        content = content.slice(0, headerLineEnd) + "\n" + entry + content.slice(headerLineEnd);
      } else {
        content = content + "\n" + entry;
      }
    }
  } else {
    const recordIdx = content.indexOf("## 📝 今日记录");
    const insertBlock = "\n" + sectionHeader + "\n" + entry + "\n";

    if (recordIdx !== -1) {
      const lineEnd = content.indexOf("\n", recordIdx);
      if (lineEnd !== -1) {
        content = content.slice(0, lineEnd) + "\n" + insertBlock + content.slice(lineEnd);
      } else {
        content = content + "\n" + insertBlock;
      }
    } else {
      content = content + "\n" + insertBlock;
    }
  }

  await vault.modify(file, content);
}

// --- Mobile: capture modal ---

let captureInFlight = false;

class CaptureModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("oc-capture-modal");

    // --- Header (lightweight sheet-style) ---
    contentEl.createEl("div", { cls: "oc-capture-drag-handle" });
    contentEl.createEl("div", { cls: "oc-capture-title", text: "💡 快速捕获" });

    // --- Input ---
    const inputEl = contentEl.createEl("textarea", {
      cls: "oc-capture-input",
      attr: { placeholder: "此刻在想什么…", rows: "4" },
    });

    // --- Status ---
    const statusEl = contentEl.createEl("div", { cls: "oc-capture-status" });

    // --- Footer (hint + actions) ---
    const footerEl = contentEl.createEl("div", { cls: "oc-capture-footer" });
    footerEl.createEl("span", {
      cls: "oc-capture-hint",
      text: Platform.isMobile ? "" : "⌘/Ctrl + Enter 发送",
    });
    const actionsEl = footerEl.createEl("div", { cls: "oc-capture-actions" });
    const cancelBtn = actionsEl.createEl("button", {
      text: "取消",
      cls: "oc-capture-btn oc-capture-btn-cancel",
    });
    const submitBtn = actionsEl.createEl("button", {
      text: "记录",
      cls: "oc-capture-btn oc-capture-btn-submit",
    });

    cancelBtn.addEventListener("click", () => this.close());

    const doCapture = async () => {
      if (captureInFlight) return;
      const raw = inputEl.value.trim();
      if (!raw) { new Notice("请输入内容"); return; }

      captureInFlight = true;
      submitBtn.disabled = true;
      cancelBtn.disabled = true;
      submitBtn.textContent = "记录中…";

      try {
        const mc = this.plugin.settings.mobileCapture;
        let finalText = raw;

        if (mc.enableAiCleanup && hasAiConfig(mc)) {
          statusEl.textContent = "🤖 AI 清理中…";
          try {
            finalText = await cleanupCapture(raw, mc);
          } catch (e) {
            statusEl.textContent = "⚠️ AI 清理失败，使用原文";
            finalText = raw;
          }
        }

        if (mc.enableUrlSummary !== false) {
          const hasUrl = URL_REGEX.test(finalText);
          URL_REGEX.lastIndex = 0;
          if (hasUrl) {
            statusEl.textContent = "🔗 解析链接内容…";
            try {
              const enriched = await enrichUrlsInText(finalText, mc, {
                onStatus: (hint) => {
                  if (hint) statusEl.textContent = hint;
                },
              });
              finalText = enriched.text;
              if (enriched.statusHint) statusEl.textContent = enriched.statusHint;
            } catch (e) {
              statusEl.textContent = `⚠️ 链接解析失败，已回退原文：${e instanceof Error ? e.message : String(e)}`;
            }
          }
        }

        statusEl.textContent = "📝 写入日记…";
        const vault = this.app.vault;
        const dailyNote = await findOrCreateDailyNote(vault, mc.dailyNotePath);

        const timeStr = formatTimeStr();
        const entry = formatCaptureEntry(timeStr, finalText);
        await appendToIdeaSection(vault, dailyNote, entry, mc.ideaSectionHeader);

        new Notice("✅ 想法已捕获");
        this.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        statusEl.textContent = `❌ ${msg}`;
        new Notice(`捕获失败: ${msg}`);
      } finally {
        captureInFlight = false;
        submitBtn.disabled = false;
        cancelBtn.disabled = false;
        submitBtn.textContent = "记录";
      }
    };

    submitBtn.addEventListener("click", doCapture);
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        doCapture();
      }
    });

    // --- Keyboard avoidance for mobile ---
    // Use visualViewport to reposition modal above virtual keyboard.
    // Wrapped in rAF to ensure the modal DOM is fully attached.
    if (Platform.isMobile && typeof visualViewport !== "undefined") {
      const vv = visualViewport;
      requestAnimationFrame(() => {
        const modalEl = contentEl.closest(".modal");
        if (!modalEl) return;
        const onViewportChange = () => {
          const kbHeight = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
          modalEl.style.setProperty("bottom", kbHeight > 0 ? `${kbHeight}px` : "0", "important");
          modalEl.style.setProperty("top", "auto", "important");
        };
        vv.addEventListener("resize", onViewportChange);
        vv.addEventListener("scroll", onViewportChange);
        this._vpCleanup = () => {
          vv.removeEventListener("resize", onViewportChange);
          vv.removeEventListener("scroll", onViewportChange);
          modalEl.style.removeProperty("bottom");
          modalEl.style.removeProperty("top");
        };
      });
    }

    setTimeout(() => inputEl.focus(), 80);
  }

  onClose() {
    if (this._vpCleanup) { this._vpCleanup(); this._vpCleanup = null; }
    this.contentEl.empty();
  }
}

// --- Mobile: settings tab ---

class MobileSettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    if (typeof this.setHeading === "function") this.setHeading();
    containerEl.createEl("p", { text: "配置 AI 服务和日记路径，用于移动端快速捕获想法。" });

    const mc = this.plugin.settings.mobileCapture;
    mc.linkResolver = normalizeLinkResolver(mc.linkResolver);
    const lr = mc.linkResolver;
    const preset = PROVIDER_PRESETS[mc.provider] || PROVIDER_PRESETS.deepseek;
    const resolverProvider = getResolverProviderPreset(lr.provider);

    new Setting(containerEl)
      .setName("AI 提供商")
      .setDesc("选择一个预设提供商，或选择自定义填写地址。")
      .addDropdown((d) => {
        for (const [id, p] of Object.entries(PROVIDER_PRESETS)) {
          d.addOption(id, p.name);
        }
        d.setValue(mc.provider).onChange(async (v) => {
          mc.provider = v;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    const apiKeySetting = new Setting(containerEl)
      .setName("API Key")
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.style.width = "100%";
        text.setPlaceholder("sk-...").setValue(mc.apiKey).onChange(async (v) => {
          mc.apiKey = v.trim();
          await this.plugin.saveSettings();
        });
      });
    {
      const descFrag = document.createDocumentFragment();
      descFrag.appendText("用于 AI 清理与链接解析失败时的 AI 回退。留空则不走 AI。");
      if (preset.keyUrl) {
        descFrag.appendText(" ");
        const link = descFrag.createEl("a", { text: `前往 ${preset.name} 获取 →`, href: preset.keyUrl });
        link.setAttr("target", "_blank");
      }
      apiKeySetting.setDesc(descFrag);
    }
    const effectiveUrl = mc.baseUrl || preset.baseUrl || "(未设置)";
    new Setting(containerEl)
      .setName("Base URL（可选）")
      .setDesc(`留空使用预设地址。当前生效: ${effectiveUrl}`)
      .addText((text) => {
        text.setPlaceholder(preset.baseUrl || "https://api.example.com").setValue(mc.baseUrl).onChange(async (v) => {
          mc.baseUrl = v.trim();
          await this.plugin.saveSettings();
        });
      });

    const effectiveModel = mc.model || preset.defaultModel || "(未设置)";
    new Setting(containerEl)
      .setName("模型名（可选）")
      .setDesc(`留空使用预设模型。当前生效: ${effectiveModel}`)
      .addText((text) => {
        text.setPlaceholder(preset.defaultModel || "model-name").setValue(mc.model).onChange(async (v) => {
          mc.model = v.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("启用 AI 清理")
      .setDesc("开启后自动去除语气词（嗯、啊、那个等）。关闭则直接记录原文。")
      .addToggle((toggle) => {
        toggle.setValue(mc.enableAiCleanup).onChange(async (v) => {
          mc.enableAiCleanup = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("启用链接解析")
      .setDesc("优先走国内解析服务（天聚/万维易源/咕咕数据），失败后自动回退 AI，再回退纯文本。")
      .addToggle((toggle) => {
        toggle.setValue(mc.enableUrlSummary !== false).onChange(async (v) => {
          mc.enableUrlSummary = v;
          if (mc.linkResolver && typeof mc.linkResolver === "object") {
            mc.linkResolver.enabled = v;
          }
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("解析服务总开关")
      .setDesc("关闭后不请求任何链接解析服务。")
      .addToggle((toggle) => {
        toggle.setValue(lr.enabled).onChange(async (v) => {
          lr.enabled = v;
          mc.enableUrlSummary = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("链接解析服务商")
      .setDesc("三选一配置即可，插件只会使用当前选中的服务商。")
      .addDropdown((d) => {
        for (const id of LINK_RESOLVER_PROVIDER_IDS) {
          const provider = getResolverProviderPreset(id);
          d.addOption(id, provider.name);
        }
        d.setValue(resolverProvider.id).onChange(async (v) => {
          lr.provider = normalizeResolverProviderId(v);
          await this.plugin.saveSettings();
          this.display();
        });
      });

    const resolverKeySetting = new Setting(containerEl)
      .setName(resolverProvider.keyLabel)
      .setDesc(resolverProvider.hint)
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder(resolverProvider.keyPlaceholder)
          .setValue(getResolverProviderKey(lr, resolverProvider.id))
          .onChange(async (v) => {
          setResolverProviderKey(lr, resolverProvider.id, v);
          await this.plugin.saveSettings();
        });
      });
    {
      const descFrag = document.createDocumentFragment();
      descFrag.appendText("配置入口：");
      const keyLink = descFrag.createEl("a", { text: "申请/购买 Key", href: resolverProvider.keyUrl });
      keyLink.setAttr("target", "_blank");
      descFrag.appendText(" · ");
      const docLink = descFrag.createEl("a", { text: "接口文档", href: resolverProvider.docsUrl });
      docLink.setAttr("target", "_blank");
      descFrag.appendText("。若目标网页反爬或动态加载失败，将自动降级到 AI，再降级到原文保留。");
      resolverKeySetting.setDesc(descFrag);
    }

    new Setting(containerEl)
      .setName("解析超时(ms)")
      .setDesc("单次解析请求超时，默认 25000。")
      .addText((text) => {
        text.setPlaceholder("25000").setValue(String(lr.timeoutMs)).onChange(async (v) => {
          lr.timeoutMs = Math.max(5000, Number(v) || LINK_RESOLVER_DEFAULTS.timeoutMs);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("失败重试次数")
      .setDesc("单服务重试次数，默认 2。")
      .addText((text) => {
        text.setPlaceholder("2").setValue(String(lr.retries)).onChange(async (v) => {
          lr.retries = Math.min(5, Math.max(0, Number(v) || LINK_RESOLVER_DEFAULTS.retries));
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("最大并发")
      .setDesc("并发解析 URL 上限，默认 2。")
      .addText((text) => {
        text.setPlaceholder("2").setValue(String(lr.maxConcurrency)).onChange(async (v) => {
          lr.maxConcurrency = Math.min(5, Math.max(1, Number(v) || LINK_RESOLVER_DEFAULTS.maxConcurrency));
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("每日笔记路径")
      .setDesc("日记文件夹的相对路径（不含文件名）。")
      .addText((text) => {
        text.setPlaceholder("01-捕获层/每日笔记").setValue(mc.dailyNotePath).onChange(async (v) => {
          mc.dailyNotePath = v.trim() || "01-捕获层/每日笔记";
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("想法区域标题")
      .setDesc("日记中用于存放想法的区域标题。")
      .addText((text) => {
        text.setPlaceholder("### 💡 想法和灵感").setValue(mc.ideaSectionHeader).onChange(async (v) => {
          mc.ideaSectionHeader = v.trim() || "### 💡 想法和灵感";
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("测试连接")
      .setDesc("验证 AI 服务是否可用。")
      .addButton((b) => {
        b.setButtonText("测试").onClick(async () => {
          if (!mc.apiKey) { new Notice("请先填写 API Key"); return; }
          b.setDisabled(true);
          b.setButtonText("测试中...");
          try {
            const result = await testConnection(mc);
            new Notice(result.ok ? `✅ ${result.message}` : `❌ ${result.message}`);
          } catch (e) {
            new Notice(`❌ ${e instanceof Error ? e.message : String(e)}`);
          } finally {
            b.setDisabled(false);
            b.setButtonText("测试");
          }
        });
      });
  }
}

/* =========================================================================
 * Plugin class
 * ========================================================================= */

class FLOWnoteAssistantPlugin extends Plugin {
  constructor(app, manifest) {
    super(app, manifest);
    this.__pluginFacadeMethodsLoaded = false;
  }

  ensureFacadeMethodsLoaded() {
    if (this.__pluginFacadeMethodsLoaded) return;

    const {
      createModuleLoaderMethods,
    } = require("./runtime/plugin/module-loader-methods");
    const {
      runtimeStateMethods,
    } = require("./runtime/plugin/runtime-state-methods");
    const {
      modelCatalogMethods,
    } = require("./runtime/plugin/model-catalog-methods");
    const {
      createBundledSkillsMethods,
    } = require("./runtime/plugin/bundled-skills-methods");
    const {
      sessionBootstrapMethods,
    } = require("./runtime/plugin/session-bootstrap-methods");

    const moduleLoaderMethods = createModuleLoaderMethods({
      defaultViewType: DEFAULT_VIEW_TYPE,
    });
    const bundledSkillsMethods = createBundledSkillsMethods({
      pluginDirname: this.manifest && this.manifest.dir
        ? String(this.manifest.dir)
        : (typeof __dirname === "string" ? __dirname : ""),
    });

    Object.assign(
      FLOWnoteAssistantPlugin.prototype,
      moduleLoaderMethods,
      runtimeStateMethods,
      modelCatalogMethods,
      bundledSkillsMethods,
      sessionBootstrapMethods,
    );

    this.__pluginFacadeMethodsLoaded = true;
  }

  async onload() {
    if (Platform.isMobile) {
      await this._onloadMobile();
      return;
    }

    try {
      this.ensureFacadeMethodsLoaded();

      this.runtimeStateMigrationDirty = false;
      this.transportModeMigrationDirty = false;
      this.bootstrapInflight = null;
      this.bootstrapLocalDone = false;
      this.bootstrapRemoteDone = false;
      this.bootstrapRemoteAt = 0;

      const runtime = this.ensureRuntimeModules();
      await this.loadPersistedData();

      this.sessionStore = new runtime.SessionStore(this);

      const vaultPath = this.getVaultPath();
      this.skillService = new runtime.SkillService(vaultPath, this.settings);
      this.opencodeClient = new runtime.FLOWnoteClient({
        vaultPath,
        settings: this.settings,
        logger: (line) => this.log(line),
        getPreferredLaunch: () => this.getPreferredLaunchProfile(),
        onLaunchSuccess: (profile) => this.rememberLaunchProfile(profile),
        SdkTransport: runtime.SdkTransport,
        CompatTransport: runtime.CompatTransport,
      });
      this.diagnosticsService = new runtime.DiagnosticsService(this, runtime.ExecutableResolver);

      this.registerView(this.getViewType(), (leaf) => new runtime.FLOWnoteAssistantView(leaf, this));

      this.addRibbonIcon("bot", "FLOWnote", () => this.activateView());

      this.addCommand({
        id: "open-flownote",
        name: "打开",
        callback: () => this.activateView(),
      });

      this.addCommand({
        id: "flownote-send-selected-text",
        name: "发送选中文本",
        editorCallback: async (editor) => {
          const text = editor.getSelection().trim();
          if (!text) return new Notice("请先选择文本");

          await this.activateView();
          const view = this.getAssistantView();
          if (view) await view.sendPrompt(text);
        },
      });

      this.addCommand({
        id: "flownote-new-session",
        name: "新建会话",
        callback: async () => {
          const session = await this.createSession("");
          this.sessionStore.setActiveSession(session.id);
          await this.persistState();
          const view = this.getAssistantView();
          if (view) view.render();
        },
      });

      this.addSettingTab(new runtime.FLOWnoteSettingsTab(this.app, this));
      await this.bootstrapData({ waitRemote: false });
      if (this.runtimeStateMigrationDirty || this.transportModeMigrationDirty) {
        this.runtimeStateMigrationDirty = false;
        this.transportModeMigrationDirty = false;
        void this.persistState().catch((e) => {
          this.log(`persist migrated runtime state failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[FLOWnote] load failed", e);
      new Notice(`FLOWnote 加载失败: ${msg}`);
    }
  }

  async onunload() {
    if (this.opencodeClient) await this.opencodeClient.stop();
    if (typeof this.getViewType === "function") {
      this.app.workspace.detachLeavesOfType(this.getViewType());
    }
  }

  log(line) {
    if (!this.settings || !this.settings.debugLogs) return;
    console.log("[FLOWnote]", line);
  }

  getVaultPath() {
    const adapter = this.app.vault.adapter;
    const byMethod = adapter && typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "";
    const byField = adapter && adapter.basePath ? adapter.basePath : "";
    const resolved = byMethod || byField;
    if (!resolved) throw new Error("仅支持本地文件系统 Vault");
    return resolved;
  }

  /* --- Mobile-only methods (no require, no Node.js) --- */

  async _onloadMobile() {
    try {
      await this._loadMobileData();

      this.addRibbonIcon("lightbulb", "快速捕获想法", () => this._openCaptureModal());

      this.addCommand({
        id: "mobile-quick-capture",
        name: "快速捕获想法",
        callback: () => this._openCaptureModal(),
      });

      this.addSettingTab(new MobileSettingsTab(this.app, this));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[FLOWnote] mobile load failed", e);
      new Notice(`FLOWnote 移动端加载失败: ${msg}`);
    }
  }

  _openCaptureModal() {
    new CaptureModal(this.app, this).open();
  }

  async _loadMobileData() {
    const raw = await this.loadData();
    const data = raw && typeof raw === "object" ? raw : {};
    this.settings = normalizeMobileSettings(data.settings || {});
  }

  async saveSettings() {
    // On desktop this method is overridden by the session-bootstrap mixin.
    // This implementation only runs on mobile.
    const raw = (await this.loadData()) || {};
    raw.settings = this.settings;
    await this.saveData(raw);
  }
}

module.exports = FLOWnoteAssistantPlugin;
