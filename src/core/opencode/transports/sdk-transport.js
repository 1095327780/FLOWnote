const path = require("path");
const { pathToFileURL } = require("url");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractText(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => {
      if (!part) return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

async function streamPseudo(text, onToken, signal) {
  if (!onToken) return;
  const tokens = text.match(/.{1,16}/g) || [text];
  let current = "";

  for (const token of tokens) {
    if (signal && signal.aborted) {
      throw new Error("用户取消了请求");
    }
    current += token;
    onToken(current);
    await sleep(20);
  }
}

class SdkTransport {
  constructor(options) {
    this.vaultPath = options.vaultPath;
    this.settings = options.settings;
    this.logger = options.logger;
    this.client = null;
    this.sdkLoaded = false;
  }

  updateSettings(settings) {
    this.settings = settings;
  }

  async ensureClient() {
    if (this.client) return this.client;

    const localSdkPath = path.join(this.vaultPath, ".opencode/node_modules/@opencode-ai/sdk/dist/client.js");
    const localUrl = pathToFileURL(localSdkPath).href;

    let mod;
    try {
      mod = await import(localUrl);
      this.sdkLoaded = true;
    } catch {
      mod = await import("@opencode-ai/sdk/client");
      this.sdkLoaded = true;
    }

    const factory = mod.createOpencodeClient;
    if (typeof factory !== "function") {
      throw new Error("OpenCode SDK 加载失败：createOpencodeClient 不可用");
    }

    this.client = factory({
      directory: this.vaultPath,
      throwOnError: true,
      timeout: this.settings.requestTimeoutMs,
    });

    return this.client;
  }

  parseModel() {
    if (!this.settings.defaultModel || !this.settings.defaultModel.includes("/")) {
      return undefined;
    }

    const [providerID, modelID] = this.settings.defaultModel.split("/");
    if (!providerID || !modelID) return undefined;
    return { providerID, modelID };
  }

  async testConnection() {
    const client = await this.ensureClient();
    await client.path.get({ query: { directory: this.vaultPath } });
    return { ok: true, mode: "sdk" };
  }

  async listSessions() {
    const client = await this.ensureClient();
    const res = await client.session.list({ query: { directory: this.vaultPath } });
    return res.data || [];
  }

  async createSession(title) {
    const client = await this.ensureClient();
    const res = await client.session.create({
      query: { directory: this.vaultPath },
      body: title ? { title } : {},
    });
    return res.data;
  }

  async listModels() {
    const client = await this.ensureClient();
    try {
      const res = await client.config.providers({ query: { directory: this.vaultPath } });
      const providers = res.data || [];
      const out = [];
      for (const p of providers) {
        const models = p.models || {};
        for (const key of Object.keys(models)) {
          out.push(`${p.id}/${key}`);
        }
      }
      return out.sort();
    } catch {
      return [];
    }
  }

  async ensureAuth() {
    if (this.settings.authMode !== "custom-api-key") return;
    if (!this.settings.customApiKey.trim()) {
      throw new Error("当前是自定义 API Key 模式，但 API Key 为空");
    }

    const client = await this.ensureClient();
    const providerId = this.settings.customProviderId.trim();

    await client.auth.set({
      path: { id: providerId },
      query: { directory: this.vaultPath },
      body: {
        type: "api",
        key: this.settings.customApiKey.trim(),
      },
    });

    if (this.settings.customBaseUrl.trim()) {
      await client.config.update({
        query: { directory: this.vaultPath },
        body: {
          provider: {
            [providerId]: {
              options: {
                baseURL: this.settings.customBaseUrl.trim(),
              },
            },
          },
        },
      });
    }
  }

  async sendMessage(options) {
    const client = await this.ensureClient();
    await this.ensureAuth();

    const payload = {
      parts: [{ type: "text", text: options.prompt }],
    };

    const model = this.parseModel();
    if (model) payload.model = model;

    const res = await client.session.prompt({
      path: { id: options.sessionId },
      query: { directory: this.vaultPath },
      body: payload,
    });

    const data = res.data || {};
    let text = "";
    let hasStructuredContent = false;

    if (data.message?.content && Array.isArray(data.message.content)) {
      hasStructuredContent = true;
      const parts = [];
      for (const block of data.message.content) {
        if (block.type === "thinking" && block.thinking) {
          parts.push(`<thinking>\n${block.thinking}\n</thinking>`);
        } else if (block.type === "text" && block.text) {
          parts.push(block.text);
        }
      }
      text = parts.join("\n\n");
    }

    if (!hasStructuredContent || !text) {
      text = extractText(data.parts || []);
    }

    if (this.settings.enableStreaming) {
      await streamPseudo(text, options.onToken, options.signal);
    }

    return {
      messageId: data.info ? data.info.id : "",
      text,
    };
  }

  async stop() {
    this.client = null;
  }
}

module.exports = {
  SdkTransport,
};
