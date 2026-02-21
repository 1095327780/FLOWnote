class ProviderAuthUtilsMethods {
  normalizeSearchText(value) {
    return String(value || "").trim().toLowerCase();
  }

  resolveProviderRegion(provider) {
    const text = `${String(provider && provider.id ? provider.id : "")} ${String(provider && provider.name ? provider.name : "")}`
      .toLowerCase();

    const domesticHints = [
      "qwen",
      "dashscope",
      "alibaba",
      "deepseek",
      "moonshot",
      "kimi",
      "zhipu",
      "glm",
      "chatglm",
      "hunyuan",
      "tencent",
      "doubao",
      "volc",
      "bytedance",
      "minimax",
      "baidu",
      "ernie",
      "siliconflow",
      "stepfun",
      "yi",
      "01.ai",
      "智谱",
      "通义",
      "豆包",
      "百川",
      "讯飞",
      "腾讯",
      "百度",
      "阿里",
      "月之暗面",
    ];

    return domesticHints.some((hint) => text.includes(hint)) ? "domestic" : "global";
  }

  buildProviderEntry(provider, connectedSet, authMap) {
    const providerID = String(provider && provider.id ? provider.id : "").trim();
    const providerName = String(provider && provider.name ? provider.name : providerID || "unknown");
    const methodsRaw = Array.isArray(authMap && authMap[providerID]) ? authMap[providerID] : [];
    const oauthMethods = methodsRaw
      .map((m, idx) => ({ index: idx, type: String(m && m.type ? m.type : ""), label: String(m && m.label ? m.label : `OAuth ${idx + 1}`) }))
      .filter((m) => m.type === "oauth");
    const supportsApi = methodsRaw.some((m) => String(m && m.type ? m.type : "") === "api");
    const isConnected = connectedSet instanceof Set ? connectedSet.has(providerID) : false;
    const modelCount = provider && provider.models && typeof provider.models === "object"
      ? Object.keys(provider.models).length
      : 0;
    const methodText = methodsRaw.length
      ? methodsRaw.map((m) => String(m && m.label ? m.label : m && m.type ? m.type : "unknown")).join(" / ")
      : "未提供鉴权方式";
    const region = this.resolveProviderRegion(provider);

    return {
      provider,
      providerID,
      providerName,
      methodsRaw,
      oauthMethods,
      supportsApi,
      isConnected,
      modelCount,
      methodText,
      region,
    };
  }

  providerEntryMatchesQuery(entry, query) {
    if (!query) return true;
    const content = [
      entry.providerName,
      entry.providerID,
      entry.methodText,
      `模型 ${entry.modelCount}`,
      entry.isConnected ? "已连接" : "未连接",
    ]
      .join(" ")
      .toLowerCase();
    return content.includes(query);
  }

}

const providerAuthUtilsMethods = {};
for (const key of Object.getOwnPropertyNames(ProviderAuthUtilsMethods.prototype)) {
  if (key === "constructor") continue;
  providerAuthUtilsMethods[key] = ProviderAuthUtilsMethods.prototype[key];
}

module.exports = { providerAuthUtilsMethods };
