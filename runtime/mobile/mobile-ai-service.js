const { requestUrl } = require("obsidian");
const { normalizeSupportedLocale } = require("../i18n-locale-utils");
const { getProviderSpec } = require("../providers/registry");

const PROVIDER_PRESETS = {
  deepseek: {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-flash",
    keyUrl: "https://platform.deepseek.com/api_keys",
    chatPath: "/chat/completions",
    modelsPath: "/models",
    models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
  },
  openai: { name: "OpenAI", baseUrl: "https://api.openai.com", defaultModel: "gpt-5.5", keyUrl: "https://platform.openai.com/api-keys", chatPath: "/v1/chat/completions", modelsPath: "/v1/models" },
  qwen: { name: "Qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode", defaultModel: "qwen3.6-flash", keyUrl: "https://dashscope.console.aliyun.com/apiKey", chatPath: "/v1/chat/completions", modelsPath: "/v1/models" },
  moonshot: { name: "Moonshot (Kimi)", baseUrl: "https://api.moonshot.ai", defaultModel: "kimi-k2.6", keyUrl: "https://platform.kimi.ai/console/api-keys", chatPath: "/v1/chat/completions", modelsPath: "/v1/models" },
  zhipu: { name: "Zhipu (GLM)", baseUrl: "https://open.bigmodel.cn/api/paas", defaultModel: "glm-5.1", keyUrl: "https://open.bigmodel.cn/usercenter/apikeys", chatPath: "/v4/chat/completions", modelsPath: "/v4/models" },
  siliconflow: { name: "SiliconFlow", baseUrl: "https://api.siliconflow.cn", defaultModel: "deepseek-ai/DeepSeek-V3", keyUrl: "https://cloud.siliconflow.cn/account/ak", chatPath: "/v1/chat/completions", modelsPath: "/v1/models" },
  openrouter: { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "openrouter/auto", keyUrl: "https://openrouter.ai/keys", chatPath: "/chat/completions", modelsPath: "/models", models: ["openrouter/auto"] },
  custom: { name: "Custom", baseUrl: "", defaultModel: "", keyUrl: "", chatPath: "/v1/chat/completions", modelsPath: "/v1/models" },
};

const AGENT_TO_CAPTURE_PROVIDER = {
  deepseek: "deepseek",
  qwen: "qwen",
  "moonshot-kimi": "moonshot",
  "zhipu-glm": "zhipu",
  "openai-official": "openai",
  "openai-compat-custom": "custom",
};

const CAPTURE_TO_AGENT_PROVIDER = {
  deepseek: "deepseek",
  qwen: "qwen",
  moonshot: "moonshot-kimi",
  zhipu: "zhipu-glm",
  openai: "openai-official",
  custom: "openai-compat-custom",
};

const CAPTURE_SYSTEM_PROMPT = [
  "你是一个语音转录清理助手。你的任务是把快速捕获的口语化输入整理成可以直接写入日记的清楚文字。",
  "处理范围：",
  "1. 删除语气词、填充词和口头禅，如：嗯、啊、那个、就是、然后、对、哦、emmm、额。",
  "2. 删除明显的重复、自我修正和卡顿片段，如“他自己那自己他自己”“陪陪伴式”。",
  "3. 修正上下文能确定的语音识别错字、同音错词和明显笔误，如“人社”应按语境修为“人设”。",
  "4. 补充必要标点，调整断句；内容较长时可以分成 2-4 个自然段。",
  "5. 保留原文的核心观点、事实、专有名词、数字、URL 和用户自己的表达倾向。",
  "禁止：",
  "1. 不要新增原文没有的观点、例子或结论。",
  "2. 不要总结成标题、要点清单或读书笔记结构，除非原文就是这种结构。",
  "3. 不要改成营销文、正式文章或过度润色的风格。",
  "4. 不要删除有信息量的内容。",
  "直接返回整理后的文本，不要任何解释、前缀或引号。",
].join("\n");

const CAPTURE_SYSTEM_PROMPT_EN = [
  "You are a voice-transcript cleanup assistant. Your task is to turn quick spoken captures into clear text that can be written directly into a daily note.",
  "Allowed cleanup:",
  "1. Remove filler words and verbal tics such as um, uh, like, you know, so, right.",
  "2. Remove obvious repetitions, false starts, and stutters.",
  "3. Fix speech-recognition mistakes, homophone errors, and obvious typos when the intended wording is clear from context.",
  "4. Add necessary punctuation and sentence breaks; split long input into 2-4 natural paragraphs when helpful.",
  "5. Preserve the user's core ideas, facts, proper nouns, numbers, URLs, and personal voice.",
  "Do not:",
  "1. Do not add ideas, examples, or conclusions that are not in the source.",
  "2. Do not convert the capture into a summary, title, bullet list, or essay unless the source already has that structure.",
  "3. Do not over-polish it into marketing or formal prose.",
  "4. Do not remove substantive content.",
  "Return only the cleaned text, with no explanation, prefix, or quotes.",
].join("\n");

const CAPTURE_SYSTEM_PROMPT_RU = [
  "Вы помощник для очистки голосовой расшифровки. Ваша задача - превратить быстрые устные заметки в ясный текст, который можно сразу записать в ежедневную заметку.",
  "Что можно делать:",
  "1. Удалять слова-паразиты и речевые заполнители, например: эм, ну, типа, значит, как бы.",
  "2. Удалять очевидные повторы, фальстарты и запинки.",
  "3. Исправлять ошибки распознавания речи, омонимы и явные опечатки, когда правильная формулировка понятна из контекста.",
  "4. Добавлять нужную пунктуацию и делить текст на предложения; длинный ввод можно разделить на 2-4 естественных абзаца.",
  "5. Сохранять основные мысли, факты, имена собственные, числа, URL и личный стиль пользователя.",
  "Нельзя:",
  "1. Не добавляйте идеи, примеры или выводы, которых нет в исходном тексте.",
  "2. Не превращайте заметку в резюме, заголовок, список или эссе, если исходный текст не имеет такой структуры.",
  "3. Не переписывайте текст в маркетинговом или чрезмерно официальном стиле.",
  "4. Не удаляйте содержательную информацию.",
  "Верните только очищенный текст, без объяснений, префиксов и кавычек.",
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

const URL_SUMMARY_PROMPT_RU = [
  "Вы помощник для краткого описания URL. В пользовательском тексте есть URL, и содержимое страниц уже получено.",
  "Верните исходный текст без изменений и добавьте строки с кратким описанием.",
  "Формат: каждая строка `> 📎 OriginalURL - Краткое описание`",
  "Правила:",
  "- Сохраняйте все исходные URL без изменений",
  "- Описание не длиннее 50 символов",
  "- Не меняйте текст вне URL",
  "- Если данных недостаточно, используйте \"Не удалось обработать, исходная ссылка сохранена\"",
  "- Верните полный обработанный текст без объяснений",
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

const URL_FALLBACK_PROMPT_RU = [
  "Вы помощник для резервной обработки URL.",
  "Задача: выполнить минимальную обработку, когда содержимое страницы недоступно.",
  "Правила:",
  "1. Сохраняйте исходный текст и все URL точно как есть",
  "2. Не переписывайте текст и не выдумывайте содержимое страницы",
  "3. Можно только добавить строки вида `> 📎 OriginalURL - Не удалось обработать, исходная ссылка сохранена`",
  "4. Верните полный обработанный текст напрямую",
].join("\n");

function localeCode(locale) {
  return normalizeSupportedLocale(locale, "en");
}

function getCaptureSystemPrompt(locale) {
  const code = localeCode(locale);
  if (code === "zh-CN") return CAPTURE_SYSTEM_PROMPT;
  if (code === "ru") return CAPTURE_SYSTEM_PROMPT_RU;
  return CAPTURE_SYSTEM_PROMPT_EN;
}

function getUrlSummaryPrompt(locale) {
  const code = localeCode(locale);
  if (code === "zh-CN") return URL_SUMMARY_PROMPT;
  if (code === "ru") return URL_SUMMARY_PROMPT_RU;
  return URL_SUMMARY_PROMPT_EN;
}

function getUrlFallbackPrompt(locale) {
  const code = localeCode(locale);
  if (code === "zh-CN") return URL_FALLBACK_PROMPT;
  if (code === "ru") return URL_FALLBACK_PROMPT_RU;
  return URL_FALLBACK_PROMPT_EN;
}

function getAiProviderDisplayName(providerId, fallbackName, locale = "en") {
  const id = String(providerId || "").trim().toLowerCase();
  const code = localeCode(locale);
  if (id === "custom") return code === "zh-CN" ? "自定义" : code === "ru" ? "Пользовательский" : "Custom";
  if (id === "qwen") return code === "zh-CN" ? "通义千问" : "Qwen";
  if (id === "zhipu") return code === "zh-CN" ? "智谱 (GLM)" : "Zhipu (GLM)";
  return fallbackName || String(providerId || "");
}

function mobileAiMessage(locale, key, params = {}) {
  const code = localeCode(locale);
  const messages = {
    aiMissingConfig: {
      "zh-CN": "AI 服务未配置：缺少 Base URL 或 API Key",
      en: "AI is not configured: missing Base URL or API Key",
      ru: "AI не настроен: отсутствует Base URL или API Key",
    },
    aiRequestFailed: {
      "zh-CN": "AI 请求失败 ({status}): {snippet}",
      en: "AI request failed ({status}): {snippet}",
      ru: "Запрос к AI не удался ({status}): {snippet}",
    },
    aiResponseEmpty: {
      "zh-CN": "AI 返回内容为空",
      en: "AI returned empty content",
      ru: "AI вернул пустой ответ",
    },
    modelListFailed: {
      "zh-CN": "模型列表请求失败 ({status}): {snippet}",
      en: "Model list request failed ({status}): {snippet}",
      ru: "Не удалось получить список моделей ({status}): {snippet}",
    },
    testProbe: {
      "zh-CN": "嗯，这是一个测试",
      en: "um, this is a test",
      ru: "эм, это тест",
    },
    connected: {
      "zh-CN": "连接成功，返回: \"{result}\"",
      en: "Connected. Response: \"{result}\"",
      ru: "Подключено. Ответ: \"{result}\"",
    },
  };
  const template = (messages[key] && (messages[key][code] || messages[key].en)) || key;
  return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name) => {
    const value = params[name];
    return value === undefined || value === null ? "" : String(value);
  });
}

function resolveAiConfig(mcSettings) {
  const providerId = mcSettings.provider || "deepseek";
  const preset = PROVIDER_PRESETS[providerId] || PROVIDER_PRESETS.deepseek;
  const baseUrl = String(mcSettings.baseUrl || preset.baseUrl || "").replace(/\/+$/, "");
  const model = String(mcSettings.model || preset.defaultModel || "").trim();
  const apiKey = String(mcSettings.apiKey || "").trim();
  return { providerId, preset, baseUrl, model, apiKey };
}

function joinApiPath(baseUrl, path) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const suffix = String(path || "").trim();
  if (!base) return suffix;
  if (!suffix) return base;
  return `${base}/${suffix.replace(/^\/+/, "")}`;
}

function getChatCompletionsUrl(ai) {
  const preset = ai && ai.preset ? ai.preset : {};
  return joinApiPath(ai && ai.baseUrl, preset.chatPath || "/v1/chat/completions");
}

function getModelsUrl(ai) {
  const preset = ai && ai.preset ? ai.preset : {};
  return joinApiPath(ai && ai.baseUrl, preset.modelsPath || "/v1/models");
}

function resolveEffectiveCaptureSettings(settingsOrCapture) {
  const source = settingsOrCapture && typeof settingsOrCapture === "object" ? settingsOrCapture : {};
  const hasNestedCapture = source.mobileCapture && typeof source.mobileCapture === "object";
  const capture = hasNestedCapture ? source.mobileCapture : source;
  const out = { ...(capture || {}) };

  const agent = hasNestedCapture && source.agentProvider && typeof source.agentProvider === "object"
    ? source.agentProvider
    : null;
  const direct = agent && agent.direct && typeof agent.direct === "object" ? agent.direct : null;
  const activeAgentProviderId = String(direct && direct.providerId || "").trim();

  if (direct && activeAgentProviderId && activeAgentProviderId !== "ollama") {
    const mappedProviderId = AGENT_TO_CAPTURE_PROVIDER[activeAgentProviderId];
    if (mappedProviderId) {
      const preset = PROVIDER_PRESETS[mappedProviderId] || PROVIDER_PRESETS.deepseek;
      out.provider = mappedProviderId;
      out.apiKey = String(
        (direct.apiKeys && typeof direct.apiKeys === "object" && direct.apiKeys[activeAgentProviderId])
        || "",
      ).trim();
      out.model = String(direct.model || preset.defaultModel || "").trim();
      out.baseUrl = activeAgentProviderId === "openai-compat-custom"
        ? String(direct.baseUrlOverride || "").trim()
        : "";
      return out;
    }
  }

  const providerId = String(out.provider || "deepseek").trim();
  out.provider = providerId;
  return out;
}

function buildMobileAgentSettingsOverride(pluginSettings) {
  const settings = pluginSettings && typeof pluginSettings === "object" ? pluginSettings : {};
  const agent = settings.agentProvider && typeof settings.agentProvider === "object" ? settings.agentProvider : null;
  const direct = agent && agent.direct && typeof agent.direct === "object" ? agent.direct : null;
  if (!agent || !direct || String(direct.providerId || "").trim() !== "ollama") return null;

  const capture = resolveEffectiveCaptureSettings(settings);
  const captureProviderId = String(capture.provider || "").trim();
  const agentProviderId = CAPTURE_TO_AGENT_PROVIDER[captureProviderId];
  if (!agentProviderId) return null;
  const spec = getProviderSpec(agentProviderId);
  if (!spec) return null;

  const preset = PROVIDER_PRESETS[captureProviderId] || {};
  const apiKey = String(capture.apiKey || "").trim();
  const baseUrlOverride = captureProviderId === "custom" ? String(capture.baseUrl || "").trim() : "";
  if (!apiKey && !spec.apiKeyOptional) return null;
  if (agentProviderId === "openai-compat-custom" && !baseUrlOverride) return null;

  const model = String(capture.model || preset.defaultModel || spec.defaultModel || "").trim();
  if (!model) return null;

  const providerMode = spec.modes && spec.modes.api ? "api" : spec.defaultMode;
  return {
    ...agent,
    mode: "direct",
    direct: {
      ...(agent.direct || {}),
      providerId: agentProviderId,
      providerMode,
      model,
      baseUrlOverride,
      region: "",
      stream: direct.stream,
      apiKeys: {
        ...(direct.apiKeys || {}),
        [agentProviderId]: apiKey,
      },
    },
  };
}

function hasAiConfig(mcSettings) {
  const ai = resolveAiConfig(resolveEffectiveCaptureSettings(mcSettings || {}));
  return Boolean(ai.baseUrl && (ai.apiKey || ai.preset.apiKeyOptional));
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
    throw new Error(mobileAiMessage(locale, "aiMissingConfig"));
  }
  const headers = { "Content-Type": "application/json" };
  if (ai.apiKey || !ai.preset.apiKeyOptional) {
    headers.Authorization = `Bearer ${ai.apiKey}`;
  }

  const response = await requestUrl({
    url: getChatCompletionsUrl(ai),
    method: "POST",
    headers,
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
    throw new Error(mobileAiMessage(locale, "aiRequestFailed", { status: response.status, snippet }));
  }

  const data = response.json;
  const content = pickFirstText([
    data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content,
  ]);
  if (!content) {
    throw new Error(mobileAiMessage(locale, "aiResponseEmpty"));
  }
  return content;
}

async function listCaptureModels(mcSettings, options = {}) {
  const locale = normalizeSupportedLocale(options.locale || "en");
  const ai = resolveAiConfig(resolveEffectiveCaptureSettings(mcSettings || {}));
  if (!ai.baseUrl || !ai.apiKey) {
    throw new Error(mobileAiMessage(locale, "aiMissingConfig"));
  }
  const headers = { "Content-Type": "application/json" };
  if (ai.apiKey || !ai.preset.apiKeyOptional) {
    headers.Authorization = `Bearer ${ai.apiKey}`;
  }

  const response = await requestUrl({
    url: getModelsUrl(ai),
    method: "GET",
    headers,
    throw: false,
    timeout: Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 30000,
  });
  if (response.status !== 200) {
    const snippet = JSON.stringify(response.json || response.text).slice(0, 200);
    throw new Error(mobileAiMessage(locale, "modelListFailed", { status: response.status, snippet }));
  }
  const data = response.json;
  const items = data && Array.isArray(data.data) ? data.data : [];
  const models = [];
  for (const item of items) {
    const id = item && typeof item.id === "string" ? item.id.trim() : "";
    if (id) models.push({ id, label: id });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
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
    const probe = mobileAiMessage(locale, "testProbe");
    const result = await cleanupCapture(probe, mcSettings, { locale });
    return {
      ok: true,
      message: mobileAiMessage(locale, "connected", { result }),
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

module.exports = {
  PROVIDER_PRESETS,
  CAPTURE_SYSTEM_PROMPT,
  CAPTURE_SYSTEM_PROMPT_EN,
  CAPTURE_SYSTEM_PROMPT_RU,
  getAiProviderDisplayName,
  getCaptureSystemPrompt,
  getUrlSummaryPrompt,
  getUrlFallbackPrompt,
  resolveAiConfig,
  getChatCompletionsUrl,
  getModelsUrl,
  resolveEffectiveCaptureSettings,
  buildMobileAgentSettingsOverride,
  hasAiConfig,
  pickFirstText,
  requestAiCompletion,
  listCaptureModels,
  cleanupCapture,
  summarizeTextWithAi,
  testConnection,
};
