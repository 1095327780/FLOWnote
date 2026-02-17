const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { ExecutableResolver } = require("../../diagnostics/executable-resolver");

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

class CompatTransport {
  constructor(options) {
    this.vaultPath = options.vaultPath;
    this.settings = options.settings;
    this.logger = options.logger;
    this.process = null;
    this.baseUrl = "";
    this.bootPromise = null;
    this.resolver = new ExecutableResolver();
  }

  updateSettings(settings) {
    this.settings = settings;
  }

  async resolveExecutable() {
    if (!this.settings.autoDetectCli && this.settings.cliPath) {
      return { ok: true, path: this.settings.cliPath, attempted: [this.settings.cliPath] };
    }
    return this.resolver.resolve(this.settings.cliPath);
  }

  async ensureStarted() {
    if (this.baseUrl) return this.baseUrl;
    if (this.bootPromise) return this.bootPromise;

    this.bootPromise = new Promise(async (resolve, reject) => {
      try {
        const runtimeHome = path.join(this.vaultPath, this.settings.opencodeHomeDir || ".opencode-runtime");
        fs.mkdirSync(runtimeHome, { recursive: true });

        const resolved = await this.resolveExecutable();
        if (!resolved.ok) {
          reject(new Error(`无法启动 OpenCode 服务: ${resolved.hint || "opencode 未找到"}`));
          return;
        }

        const env = {
          ...process.env,
          OPENCODE_HOME: runtimeHome,
        };

        this.process = spawn(resolved.path, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], {
          cwd: this.vaultPath,
          env,
        });

        const onOutput = (chunk) => {
          const text = chunk.toString();
          const match = text.match(/http:\/\/127\.0\.0\.1:\d+/);
          if (match) {
            this.baseUrl = match[0];
            resolve(this.baseUrl);
          }
        };

        this.process.stdout.on("data", onOutput);
        this.process.stderr.on("data", onOutput);

        this.process.on("error", (err) => {
          reject(new Error(`无法启动 OpenCode 服务: ${err.message}`));
        });

        this.process.on("exit", (code) => {
          if (!this.baseUrl) {
            reject(new Error(`OpenCode 服务提前退出，退出码: ${String(code)}`));
          }
        });

        setTimeout(() => {
          if (!this.baseUrl) {
            reject(new Error("等待 OpenCode 服务启动超时（15s）"));
          }
        }, 15000);
      } catch (error) {
        reject(error);
      }
    }).catch((error) => {
      this.bootPromise = null;
      throw error;
    });

    return this.bootPromise;
  }

  async request(method, endpoint, body, query = {}) {
    const baseUrl = await this.ensureStarted();
    const url = new URL(baseUrl + endpoint);

    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && String(v).length > 0) {
        url.searchParams.set(k, String(v));
      }
    }

    const resp = await fetch(url.toString(), {
      method,
      headers: {
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await resp.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    if (!resp.ok) {
      const detail = parsed ? JSON.stringify(parsed) : text;
      throw new Error(`OpenCode 请求失败 (${resp.status}): ${detail}`);
    }

    return parsed;
  }

  parseModel() {
    if (!this.settings.defaultModel || !this.settings.defaultModel.includes("/")) {
      return undefined;
    }

    const [providerID, modelID] = this.settings.defaultModel.split("/");
    if (!providerID || !modelID) return undefined;
    return { providerID, modelID };
  }

  async ensureAuth() {
    if (this.settings.authMode !== "custom-api-key") return;
    if (!this.settings.customApiKey.trim()) {
      throw new Error("当前是自定义 API Key 模式，但 API Key 为空");
    }

    const providerId = this.settings.customProviderId.trim();

    await this.request(
      "POST",
      `/auth/${encodeURIComponent(providerId)}`,
      { type: "api", key: this.settings.customApiKey.trim() },
      { directory: this.vaultPath },
    );

    if (this.settings.customBaseUrl.trim()) {
      await this.request(
        "PATCH",
        "/config",
        {
          provider: {
            [providerId]: {
              options: {
                baseURL: this.settings.customBaseUrl.trim(),
              },
            },
          },
        },
        { directory: this.vaultPath },
      );
    }
  }

  async testConnection() {
    await this.request("GET", "/path", undefined, { directory: this.vaultPath });
    return { ok: true, mode: "compat" };
  }

  async listSessions() {
    const res = await this.request("GET", "/session", undefined, { directory: this.vaultPath });
    return res && res.data ? res.data : res || [];
  }

  async createSession(title) {
    const res = await this.request("POST", "/session", title ? { title } : {}, { directory: this.vaultPath });
    return res && res.data ? res.data : res;
  }

  async listModels() {
    try {
      const res = await this.request("GET", "/config/providers", undefined, { directory: this.vaultPath });
      const providers = res && res.data ? res.data : res || [];
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

  async sendMessage(options) {
    await this.ensureAuth();

    const body = {
      parts: [{ type: "text", text: options.prompt }],
    };

    const model = this.parseModel();
    if (model) body.model = model;

    const res = await this.request(
      "POST",
      `/session/${encodeURIComponent(options.sessionId)}/message`,
      body,
      { directory: this.vaultPath },
    );

    const data = res && res.data ? res.data : res;
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
    if (this.process) {
      this.process.kill();
    }
    this.process = null;
    this.baseUrl = "";
    this.bootPromise = null;
  }
}

module.exports = {
  CompatTransport,
};
