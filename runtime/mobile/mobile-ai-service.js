const { requestUrl } = require("obsidian");

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

/**
 * Call AI to clean up captured text (remove filler words).
 * @param {string} text - raw captured text
 * @param {object} mcSettings - mobileCapture settings object
 * @returns {Promise<string>} cleaned text
 */
async function cleanupCapture(text, mcSettings) {
  const providerId = mcSettings.provider || "deepseek";
  const preset = PROVIDER_PRESETS[providerId] || PROVIDER_PRESETS.deepseek;
  const baseUrl = (mcSettings.baseUrl || preset.baseUrl).replace(/\/+$/, "");
  const model = mcSettings.model || preset.defaultModel;
  const apiKey = mcSettings.apiKey;

  if (!baseUrl || !apiKey) {
    throw new Error("AI 服务未配置：缺少 Base URL 或 API Key");
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
        { role: "system", content: CAPTURE_SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    }),
    throw: false,
    timeout: 30000,
  });

  if (response.status !== 200) {
    throw new Error(`AI 请求失败 (${response.status}): ${JSON.stringify(response.json || response.text).slice(0, 200)}`);
  }

  const data = response.json;
  const content =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;

  if (!content) {
    throw new Error("AI 返回内容为空");
  }

  return content.trim();
}

/**
 * Quick test of AI connectivity.
 * @param {object} mcSettings
 * @returns {Promise<{ok: boolean, message: string}>}
 */
async function testConnection(mcSettings) {
  try {
    const result = await cleanupCapture("嗯，这是一个测试", mcSettings);
    return { ok: true, message: `连接成功，返回: "${result}"` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

module.exports = {
  PROVIDER_PRESETS,
  CAPTURE_SYSTEM_PROMPT,
  cleanupCapture,
  testConnection,
};
