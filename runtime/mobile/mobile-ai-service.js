const { requestUrl } = require("obsidian");
const { normalizeSupportedLocale } = require("../i18n-locale-utils");

const PROVIDER_PRESETS = {
  deepseek: { name: "DeepSeek", baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-chat", keyUrl: "https://platform.deepseek.com/api_keys" },
  qwen: { name: "Qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode", defaultModel: "qwen-turbo", keyUrl: "https://dashscope.console.aliyun.com/apiKey" },
  moonshot: { name: "Moonshot (Kimi)", baseUrl: "https://api.moonshot.cn", defaultModel: "moonshot-v1-8k", keyUrl: "https://platform.moonshot.cn/console/api-keys" },
  zhipu: { name: "Zhipu (GLM)", baseUrl: "https://open.bigmodel.cn/api/paas", defaultModel: "glm-4-flash", keyUrl: "https://open.bigmodel.cn/usercenter/apikeys" },
  siliconflow: { name: "SiliconFlow", baseUrl: "https://api.siliconflow.cn", defaultModel: "deepseek-ai/DeepSeek-V3", keyUrl: "https://cloud.siliconflow.cn/account/ak" },
  custom: { name: "Custom", baseUrl: "", defaultModel: "", keyUrl: "" },
};

const CAPTURE_SYSTEM_PROMPT = [
  "你是一个文字清理助手。你的唯一任务是去除口语中的语气词和填充词（如：嗯、啊、那个、就是、然后、对、哦、emmm、额 等），",
  "让句子更简洁。",
  "规则：",
  "1. 只去除语气词和填充词",
  "2. 不要改写、润色或美化原文",
  "3. 不要添加任何新内容",
  "4. 不要改变原文的意思和表达方式",
  "5. 保留所有实质内容和原始用词",
  "6. 保留所有 URL 原样不变",
  "7. 直接返回清理后的文本，不要任何解释或前缀",
].join("\n");

const CAPTURE_SYSTEM_PROMPT_EN = [
  "You are a text cleanup assistant. Your only task is to remove filler words from spoken text (such as um, uh, like, you know, etc.) and keep the sentence concise.",
  "Rules:",
  "1. Only remove filler words",
  "2. Do not rewrite, polish, or beautify the text",
  "3. Do not add new content",
  "4. Keep original meaning and wording",
  "5. Preserve all substantive content",
  "6. Preserve all URLs exactly as-is",
  "7. Return cleaned text only, no explanation",
].join("\n");

const URL_SUMMARY_PROMPT = [
  "你是一个 URL 摘要助手。用户文本中包含 URL，且页面内容已抓取。",
  "输出时保留原文不变，并追加摘要行。",
  "格式：每行 `> 📎 原始URL - 摘要`",
  "规则：",
  "- 保留所有 URL 原样",
  "- 摘要不超过 50 字",
  "- 不改动 URL 之外内容",
  "- 内容不足时用“暂无法解析，已保留原始链接”",
  "- 直接返回完整处理后的文本",
].join("\n");

const URL_SUMMARY_PROMPT_EN = [
  "You are a URL summary assistant. User text includes URLs and page content has been fetched.",
  "Output the original text unchanged, and append summary lines.",
  "Format: each line is `> 📎 OriginalURL - Summary`",
  "Rules:",
  "- Keep all original URLs unchanged",
  "- Summary <= 50 chars",
  "- Do not alter non-URL content",
  "- If insufficient content, use \"Unable to resolve, original URL preserved\"",
  "- Return full processed text without explanation",
].join("\n");

const URL_FALLBACK_PROMPT = [
  "你是一个 URL 兜底助手。",
  "任务：当页面内容不可用时，仅做最小处理。",
  "规则：",
  "1. 保留原文和所有 URL 原样",
  "2. 不改写，不虚构页面内容",
  "3. 只允许追加 `> 📎 原始URL - 暂无法解析，已保留原始链接`",
  "4. 直接返回完整文本",
].join("\n");

const URL_FALLBACK_PROMPT_EN = [
  "You are a URL fallback assistant.",
  "Task: apply minimal processing when page content is unavailable.",
  "Rules:",
  "1. Preserve original text and all URLs exactly",
  "2. Do not rewrite or fabricate page content",
  "3. You may only append lines like `> 📎 OriginalURL - Unable to resolve, original URL preserved`",
  "4. Return processed full text directly",
].join("\n");

function isZh(locale) {
  return normalizeSupportedLocale(locale) === "zh-CN";
}

function getCaptureSystemPrompt(locale) {
  return isZh(locale) ? CAPTURE_SYSTEM_PROMPT : CAPTURE_SYSTEM_PROMPT_EN;
}

function getUrlSummaryPrompt(locale) {
  return isZh(locale) ? URL_SUMMARY_PROMPT : URL_SUMMARY_PROMPT_EN;
}

function getUrlFallbackPrompt(locale) {
  return isZh(locale) ? URL_FALLBACK_PROMPT : URL_FALLBACK_PROMPT_EN;
}

function getAiProviderDisplayName(providerId, fallbackName, locale = "en") {
  const id = String(providerId || "").trim().toLowerCase();
  if (id === "custom") return isZh(locale) ? "自定义" : "Custom";
  if (id === "qwen") return isZh(locale) ? "通义千问" : "Qwen";
  if (id === "zhipu") return isZh(locale) ? "智谱 (GLM)" : "Zhipu (GLM)";
  return fallbackName || String(providerId || "");
}

function resolveAiConfig(mcSettings) {
  const providerId = mcSettings.provider || "deepseek";
  const preset = PROVIDER_PRESETS[providerId] || PROVIDER_PRESETS.deepseek;
  const baseUrl = String(mcSettings.baseUrl || preset.baseUrl || "").replace(/\/+$/, "");
  const model = String(mcSettings.model || preset.defaultModel || "").trim();
  const apiKey = String(mcSettings.apiKey || "").trim();
  return { providerId, preset, baseUrl, model, apiKey };
}

function hasAiConfig(mcSettings) {
  const ai = resolveAiConfig(mcSettings || {});
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

async function requestAiCompletion(messages, mcSettings, options = {}) {
  const locale = normalizeSupportedLocale(options.locale || "en");
  const ai = resolveAiConfig(mcSettings || {});
  if (!ai.baseUrl || !ai.apiKey) {
    throw new Error(isZh(locale)
      ? "AI 服务未配置：缺少 Base URL 或 API Key"
      : "AI is not configured: missing Base URL or API Key");
  }

  const response = await requestUrl({
    url: `${ai.baseUrl}/v1/chat/completions`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ai.apiKey}`,
    },
    body: JSON.stringify({
      model: ai.model,
      temperature: Number.isFinite(Number(options.temperature)) ? Number(options.temperature) : 0.1,
      messages,
    }),
    throw: false,
    timeout: Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 30000,
  });

  if (response.status !== 200) {
    const snippet = JSON.stringify(response.json || response.text).slice(0, 200);
    if (isZh(locale)) throw new Error(`AI 请求失败 (${response.status}): ${snippet}`);
    throw new Error(`AI request failed (${response.status}): ${snippet}`);
  }

  const data = response.json;
  const content = pickFirstText([
    data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content,
  ]);
  if (!content) {
    throw new Error(isZh(locale) ? "AI 返回内容为空" : "AI returned empty content");
  }
  return content;
}

async function cleanupCapture(text, mcSettings, options = {}) {
  const locale = normalizeSupportedLocale(options.locale || "en");
  const content = await requestAiCompletion([
    { role: "system", content: getCaptureSystemPrompt(locale) },
    { role: "user", content: String(text || "") },
  ], mcSettings, { locale, temperature: 0.1, timeoutMs: 30000 });
  return content.trim();
}

async function summarizeTextWithAi(text, mcSettings, options = {}) {
  const locale = normalizeSupportedLocale(options.locale || "en");
  const systemPrompt = options.useFallbackPrompt ? getUrlFallbackPrompt(locale) : getUrlSummaryPrompt(locale);
  const content = await requestAiCompletion([
    { role: "system", content: systemPrompt },
    { role: "user", content: String(text || "") },
  ], mcSettings, { locale, temperature: 0.1, timeoutMs: 45000 });
  return content.trim();
}

async function testConnection(mcSettings, options = {}) {
  const locale = normalizeSupportedLocale(options.locale || "en");
  try {
    const probe = isZh(locale) ? "嗯，这是一个测试" : "um, this is a test";
    const result = await cleanupCapture(probe, mcSettings, { locale });
    return {
      ok: true,
      message: isZh(locale) ? `连接成功，返回: "${result}"` : `Connected. Response: "${result}"`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

module.exports = {
  PROVIDER_PRESETS,
  CAPTURE_SYSTEM_PROMPT,
  CAPTURE_SYSTEM_PROMPT_EN,
  getAiProviderDisplayName,
  getCaptureSystemPrompt,
  getUrlSummaryPrompt,
  getUrlFallbackPrompt,
  resolveAiConfig,
  hasAiConfig,
  pickFirstText,
  requestAiCompletion,
  cleanupCapture,
  summarizeTextWithAi,
  testConnection,
};
