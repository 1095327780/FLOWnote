const { requestUrl } = require("obsidian");
const { normalizeSupportedLocale } = require("../i18n-locale-utils");

const PROVIDER_PRESETS = {
  deepseek: {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
  },
  qwen: {
    name: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
    defaultModel: "qwen-turbo",
  },
  moonshot: {
    name: "Moonshot (Kimi)",
    baseUrl: "https://api.moonshot.cn",
    defaultModel: "moonshot-v1-8k",
  },
  zhipu: {
    name: "智谱 (GLM)",
    baseUrl: "https://open.bigmodel.cn/api/paas",
    defaultModel: "glm-4-flash",
  },
  siliconflow: {
    name: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn",
    defaultModel: "deepseek-ai/DeepSeek-V3",
  },
  custom: {
    name: "自定义",
    baseUrl: "",
    defaultModel: "",
  },
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
  "6. 直接返回清理后的文本，不要任何解释或前缀",
].join("\n");

const CAPTURE_SYSTEM_PROMPT_EN = [
  "You are a text cleanup assistant. Remove filler words from spoken text (such as um, uh, like, you know).",
  "Rules:",
  "1. Only remove filler words",
  "2. Do not rewrite or polish text",
  "3. Do not add new content",
  "4. Keep original meaning and wording",
  "5. Preserve all substantive content",
  "6. Return cleaned text only, no explanation",
].join("\n");

function getCaptureSystemPrompt(locale) {
  return normalizeSupportedLocale(locale) === "zh-CN" ? CAPTURE_SYSTEM_PROMPT : CAPTURE_SYSTEM_PROMPT_EN;
}

/**
 * Call AI to clean up captured text (remove filler words).
 * @param {string} text - raw captured text
 * @param {object} mcSettings - mobileCapture settings object
 * @param {object} [options]
 * @returns {Promise<string>} cleaned text
 */
async function cleanupCapture(text, mcSettings, options = {}) {
  const locale = normalizeSupportedLocale(options.locale || (mcSettings && mcSettings.locale) || "en");
  const providerId = mcSettings.provider || "deepseek";
  const preset = PROVIDER_PRESETS[providerId] || PROVIDER_PRESETS.deepseek;
  const baseUrl = (mcSettings.baseUrl || preset.baseUrl).replace(/\/+$/, "");
  const model = mcSettings.model || preset.defaultModel;
  const apiKey = mcSettings.apiKey;

  if (!baseUrl || !apiKey) {
    throw new Error(locale === "zh-CN"
      ? "AI 服务未配置：缺少 Base URL 或 API Key"
      : "AI is not configured: missing Base URL or API Key");
  }

  const url = `${baseUrl}/v1/chat/completions`;

  const response = await requestUrl({
    url,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      messages: [
        { role: "system", content: getCaptureSystemPrompt(locale) },
        { role: "user", content: text },
      ],
    }),
    throw: false,
    timeout: 30000,
  });

  if (response.status !== 200) {
    if (locale === "zh-CN") {
      throw new Error(`AI 请求失败 (${response.status}): ${JSON.stringify(response.json || response.text).slice(0, 200)}`);
    }
    throw new Error(`AI request failed (${response.status}): ${JSON.stringify(response.json || response.text).slice(0, 200)}`);
  }

  const data = response.json;
  const content =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;

  if (!content) {
    throw new Error(locale === "zh-CN" ? "AI 返回内容为空" : "AI returned empty content");
  }

  return content.trim();
}

/**
 * Quick test of AI connectivity.
 * @param {object} mcSettings
 * @param {object} [options]
 * @returns {Promise<{ok: boolean, message: string}>}
 */
async function testConnection(mcSettings, options = {}) {
  const locale = normalizeSupportedLocale(options.locale || (mcSettings && mcSettings.locale) || "en");
  try {
    const probe = locale === "zh-CN" ? "嗯，这是一个测试" : "um, this is a test";
    const result = await cleanupCapture(probe, mcSettings, { locale });
    return {
      ok: true,
      message: locale === "zh-CN" ? `连接成功，返回: "${result}"` : `Connected. Response: "${result}"`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

module.exports = {
  PROVIDER_PRESETS,
  CAPTURE_SYSTEM_PROMPT,
  CAPTURE_SYSTEM_PROMPT_EN,
  getCaptureSystemPrompt,
  cleanupCapture,
  testConnection,
};
