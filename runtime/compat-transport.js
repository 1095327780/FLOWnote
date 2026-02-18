const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { ExecutableResolver } = require("./executable-resolver");
const {
  nodeHttpRequestJson,
  nodeHttpRequestSse,
  createLinkedAbortController,
} = require("./http-utils");
const {
  toPartBlock,
  blocksFingerprint,
  extractAssistantParts,
  extractErrorText,
  extractAssistantPayloadFromEnvelope,
  formatSessionStatusText,
  normalizedRenderableText,
  hasRenderablePayload,
  isIntermediateToolCallPayload,
  payloadLooksInProgress,
  hasTerminalPayload,
  responseRichnessScore,
  chooseRicherResponse,
} = require("./assistant-payload-utils");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function streamPseudo(text, onToken, signal) {
  if (!onToken) return;
  const tokens = text.match(/.{1,16}/g) || [text];
  let current = "";

  for (const t of tokens) {
    if (signal && signal.aborted) throw new Error("用户取消了请求");
    current += t;
    onToken(current);
    await sleep(20);
  }
}

class CompatTransport {
  constructor(options) {
    this.vaultPath = options.vaultPath;
    this.settings = options.settings;
    this.process = null;
    this.baseUrl = "";
    this.bootPromise = null;
    this.resolver = new ExecutableResolver();
    this.commandCache = {
      at: 0,
      items: [],
    };
  }

  log(line) {
    console.log(`[opencode-assistant] ${line}`);
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

        this.process = spawn(
          resolved.path,
          ["serve", "--hostname", "127.0.0.1", "--port", "0", "--cors", "app://obsidian.md", "--print-logs"],
          {
          cwd: this.vaultPath,
          env: { ...process.env, OPENCODE_HOME: runtimeHome },
          },
        );

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
        this.process.on("error", (err) => reject(new Error(`无法启动 OpenCode 服务: ${err.message}`)));
        this.process.on("exit", (code) => {
          if (!this.baseUrl) reject(new Error(`OpenCode 服务提前退出，退出码: ${String(code)}`));
        });

        setTimeout(() => {
          if (!this.baseUrl) reject(new Error("等待 OpenCode 服务启动超时（15s）"));
        }, 15000);
      } catch (e) {
        reject(e);
      }
    }).catch((e) => {
      this.bootPromise = null;
      throw e;
    });

    return this.bootPromise;
  }

  async request(method, endpoint, body, query = {}, signal) {
    const baseUrl = await this.ensureStarted();
    const url = new URL(baseUrl + endpoint);

    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && String(v).length > 0) {
        url.searchParams.set(k, String(v));
      }
    }

    const resp = await nodeHttpRequestJson(url.toString(), method, body, this.settings.requestTimeoutMs, signal);
    const text = resp.text;
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    if (resp.status < 200 || resp.status >= 300) {
      const detail = parsed ? JSON.stringify(parsed) : text;
      throw new Error(`OpenCode 请求失败 (${resp.status}): ${detail}`);
    }

    return parsed;
  }

  parseModel() {
    if (!this.settings.defaultModel.includes("/")) return undefined;
    const [providerID, modelID] = this.settings.defaultModel.split("/");
    if (!providerID || !modelID) return undefined;
    return { providerID, modelID };
  }

  parseCommandModel() {
    const model = String(this.settings.defaultModel || "").trim();
    if (!model.includes("/")) return undefined;
    return model;
  }

  async getSessionStatus(sessionId, signal) {
    try {
      const res = await this.request("GET", "/session/status", undefined, { directory: this.vaultPath }, signal);
      const payload = res && res.data ? res.data : res;
      if (!payload || typeof payload !== "object") return null;
      return payload[sessionId] || null;
    } catch {
      return null;
    }
  }

  findLatestAssistantMessage(messages, startedAt) {
    const list = Array.isArray(messages) ? messages : [];
    const candidates = list
      .filter((item) => item && item.info && item.info.role === "assistant")
      .filter((item) => {
        const created = item && item.info && item.info.time ? Number(item.info.time.created || 0) : 0;
        return !startedAt || created >= startedAt - 1000;
      })
      .sort((a, b) => {
        const ta = a && a.info && a.info.time ? Number(a.info.time.created || 0) : 0;
        const tb = b && b.info && b.info.time ? Number(b.info.time.created || 0) : 0;
        return tb - ta;
      });
    return candidates[0] || null;
  }

  async ensureAuth() {
    if (this.settings.authMode !== "custom-api-key") return;
    if (!this.settings.customApiKey.trim()) throw new Error("当前是自定义 API Key 模式，但 API Key 为空");

    const providerId = this.settings.customProviderId.trim();
    await this.request("PUT", `/auth/${encodeURIComponent(providerId)}`, { type: "api", key: this.settings.customApiKey.trim() }, { directory: this.vaultPath });

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
    const payload = res && res.data ? res.data : res || [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.sessions)) return payload.sessions;
    return [];
  }

  async createSession(title) {
    const res = await this.request("POST", "/session", title ? { title } : {}, { directory: this.vaultPath });
    return res && res.data ? res.data : res;
  }

  async listModels() {
    try {
      const res = await this.request("GET", "/config/providers", undefined, { directory: this.vaultPath });
      const payload = res && res.data ? res.data : res || [];
      const providers = Array.isArray(payload) ? payload : Array.isArray(payload.providers) ? payload.providers : [];
      const out = [];
      for (const p of providers) {
        const models = p.models || {};
        for (const key of Object.keys(models)) out.push(`${p.id}/${key}`);
      }
      return out.sort();
    } catch {
      return [];
    }
  }

  async listCommands() {
    const now = Date.now();
    if (now - this.commandCache.at < 30000 && this.commandCache.items.length) {
      return this.commandCache.items;
    }

    try {
      const res = await this.request("GET", "/command", undefined, { directory: this.vaultPath });
      const payload = res && res.data ? res.data : res || [];
      const items = Array.isArray(payload) ? payload : Array.isArray(payload.commands) ? payload.commands : [];
      this.commandCache = {
        at: now,
        items: Array.isArray(items) ? items : [],
      };
      return this.commandCache.items;
    } catch {
      return [];
    }
  }

  normalizeSlashCommandName(commandName) {
    const normalized = String(commandName || "").trim().replace(/^\//, "").toLowerCase();
    if (normalized === "modle") return "model";
    return normalized;
  }

  availableCommandSet(list) {
    const set = new Set();
    for (const item of list || []) {
      const name = String(item && item.name ? item.name : "")
        .replace(/^\//, "")
        .trim()
        .toLowerCase();
      if (name) set.add(name);
    }
    return set;
  }

  async resolveCommandForEndpoint(commandName) {
    const normalized = this.normalizeSlashCommandName(commandName);
    if (!normalized) return { use: false, command: "" };

    const list = await this.listCommands();
    const names = this.availableCommandSet(list);

    if (names.has(normalized)) {
      return { use: true, command: normalized };
    }

    // Alias fallback: only when target command is confirmed in server list.
    if (normalized === "model" && names.has("models")) return { use: true, command: "models" };
    if (normalized === "models" && names.has("model")) return { use: true, command: "model" };

    return { use: false, command: normalized };
  }

  async finalizeAssistantResponse(sessionId, responsePayload, startedAt, signal, preferredMessageId = "") {
    const finalizeStartedAt = Date.now();
    const data = responsePayload && responsePayload.data ? responsePayload.data : responsePayload;
    let messageId = preferredMessageId || (data && data.info ? data.info.id : "");
    let payload = extractAssistantPayloadFromEnvelope(data);
    const quietTimeoutMs = Math.max(10000, Number(this.settings.requestTimeoutMs) || 120000);
    const maxTotalMs = Math.max(quietTimeoutMs * 3, 10 * 60 * 1000);
    const loopStartedAt = Date.now();
    let lastProgressAt = loopStartedAt;
    let progressKey = `${messageId}|${responseRichnessScore(payload)}|${normalizedRenderableText(payload.text || "").length}|${blocksFingerprint(payload.blocks || [])}`;
    let pollCount = 0;
    let lastStatus = null;
    let lastMessageCreated = 0;

    const markProgress = () => {
      const nextKey = `${messageId}|${responseRichnessScore(payload)}|${normalizedRenderableText(payload.text || "").length}|${blocksFingerprint(payload.blocks || [])}`;
      if (nextKey !== progressKey) {
        progressKey = nextKey;
        lastProgressAt = Date.now();
      }
    };

    const tryLoadByMessageId = async () => {
      if (!messageId) return { completed: false };
      try {
        const msgRes = await this.request(
          "GET",
          `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`,
          undefined,
          { directory: this.vaultPath },
          signal,
        );
        const messagePayload = msgRes && msgRes.data ? msgRes.data : msgRes;
        const role =
          messagePayload && messagePayload.info && typeof messagePayload.info.role === "string"
            ? messagePayload.info.role
            : "";
        if (role && role !== "assistant") {
          messageId = "";
          return { completed: false };
        }
        const extracted = extractAssistantPayloadFromEnvelope(messagePayload);
        payload = chooseRicherResponse(payload, extracted);
        markProgress();
        const completedAt =
          messagePayload && messagePayload.info && messagePayload.info.time
            ? Number(messagePayload.info.time.completed || 0)
            : 0;
        return { completed: completedAt > 0 };
      } catch {
        return { completed: false };
      }
    };

    const tryLoadLatest = async () => {
      const listRes = await this.request(
        "GET",
        `/session/${encodeURIComponent(sessionId)}/message`,
        undefined,
        { directory: this.vaultPath, limit: 50 },
        signal,
      );
      const listPayload = listRes && listRes.data ? listRes.data : listRes;
      const latest = this.findLatestAssistantMessage(listPayload, startedAt);
      if (!latest) return { completed: false };

      const latestCreated =
        latest && latest.info && latest.info.time
          ? Number(latest.info.time.created || 0)
          : 0;
      if (latestCreated >= lastMessageCreated && latest.info && latest.info.id) {
        messageId = latest.info.id;
        lastMessageCreated = latestCreated;
        markProgress();
      }
      const extracted = extractAssistantPayloadFromEnvelope(latest);
      payload = chooseRicherResponse(payload, extracted);
      markProgress();
      const completedAt =
        latest && latest.info && latest.info.time
          ? Number(latest.info.time.completed || 0)
          : 0;
      return { completed: completedAt > 0 };
    };

    while (Date.now() - loopStartedAt < maxTotalMs && Date.now() - lastProgressAt < quietTimeoutMs) {
      if (signal && signal.aborted) {
        throw new Error("用户取消了请求");
      }

      const byId = await tryLoadByMessageId();
      if (byId.completed && hasRenderablePayload(payload) && hasTerminalPayload(payload) && !payloadLooksInProgress(payload)) {
        break;
      }

      const latest = await tryLoadLatest();
      if (latest.completed && hasRenderablePayload(payload) && hasTerminalPayload(payload) && !payloadLooksInProgress(payload)) {
        break;
      }

      pollCount += 1;
      if (pollCount % 2 === 0) {
        lastStatus = await this.getSessionStatus(sessionId, signal);
        if (lastStatus && lastStatus.type === "idle") {
          const staleMs = Date.now() - lastProgressAt;
          if (hasRenderablePayload(payload) && (!payloadLooksInProgress(payload) || staleMs > 1800)) {
            break;
          }
        }
      }

      if (hasTerminalPayload(payload) && !payloadLooksInProgress(payload)) {
        break;
      }

      await sleep(220);
    }

    if (Date.now() - loopStartedAt >= maxTotalMs || Date.now() - lastProgressAt >= quietTimeoutMs) {
      console.log("[opencode-assistant] finalize timeout", {
        sessionId,
        messageId,
        elapsedMs: Date.now() - finalizeStartedAt,
        idleMs: Date.now() - lastProgressAt,
        quietTimeoutMs,
        maxTotalMs,
        textLen: String(payload.text || "").length,
        reasoningLen: String(payload.reasoning || "").length,
        blockCount: Array.isArray(payload.blocks) ? payload.blocks.length : 0,
        terminal: hasTerminalPayload(payload),
        inProgress: payloadLooksInProgress(payload),
      });
    }

    if (isIntermediateToolCallPayload(payload) && normalizedRenderableText(payload.text || "").length <= 1) {
      payload.text = "";
    }

    if (!hasRenderablePayload(payload)) {
      const status = lastStatus || (await this.getSessionStatus(sessionId, signal));
      const statusText = formatSessionStatusText(status);
      payload.text = `(无文本返回：session.status=${statusText}。若长期为 busy，通常是权限或模型鉴权问题，请在 OpenCode 诊断中检查。)`;
    }

    return {
      messageId,
      text: payload.text || "",
      reasoning: payload.reasoning || "",
      meta: payload.meta || "",
      blocks: payload.blocks || [],
    };
  }

  async streamAssistantFromPolling(sessionId, startedAt, signal, handlers) {
    const quietTimeoutMs = Math.max(10000, Number(this.settings.requestTimeoutMs) || 120000);
    const maxTotalMs = Math.max(quietTimeoutMs * 3, 10 * 60 * 1000);
    const started = Date.now();
    let lastProgressAt = started;
    let messageId = "";
    let text = "";
    let reasoning = "";
    let meta = "";
    let blocks = [];
    let blocksKey = blocksFingerprint(blocks);
    let pollCount = 0;

    while (Date.now() - started < maxTotalMs && Date.now() - lastProgressAt < quietTimeoutMs) {
      if (signal && signal.aborted) {
        throw new Error("用户取消了请求");
      }

      const listRes = await this.request(
        "GET",
        `/session/${encodeURIComponent(sessionId)}/message`,
        undefined,
        { directory: this.vaultPath, limit: 50 },
        signal,
      );
      const listPayload = listRes && listRes.data ? listRes.data : listRes;
      const latest = this.findLatestAssistantMessage(listPayload, startedAt);
      if (latest) {
        if (!messageId && latest.info && latest.info.id) {
          messageId = latest.info.id;
          lastProgressAt = Date.now();
        }

        const extracted = extractAssistantPayloadFromEnvelope(latest);
        if (typeof extracted.meta === "string" && extracted.meta.trim()) {
          if (meta !== extracted.meta.trim()) {
            meta = extracted.meta.trim();
            lastProgressAt = Date.now();
          }
        }
        const nextBlocks = Array.isArray(extracted.blocks) ? extracted.blocks : [];
        const nextBlocksKey = blocksFingerprint(nextBlocks);
        if (nextBlocksKey !== blocksKey) {
          blocks = nextBlocks;
          blocksKey = nextBlocksKey;
          lastProgressAt = Date.now();
          if (handlers && typeof handlers.onBlocks === "function") {
            handlers.onBlocks(blocks);
          }
        }
        if (extracted.reasoning !== reasoning) {
          reasoning = extracted.reasoning;
          lastProgressAt = Date.now();
          if (handlers && typeof handlers.onReasoning === "function") {
            handlers.onReasoning(reasoning);
          }
        }
        if (extracted.text !== text) {
          text = extracted.text;
          lastProgressAt = Date.now();
          if (handlers && typeof handlers.onToken === "function") {
            handlers.onToken(text);
          }
        }

        const completedAt = latest && latest.info && latest.info.time ? Number(latest.info.time.completed || 0) : 0;
        if (completedAt > 0 && (text || reasoning || meta || blocks.length)) {
          const currentPayload = { text, reasoning, meta, blocks };
          if (!payloadLooksInProgress(currentPayload)) {
            return { messageId, text, reasoning, meta, blocks };
          }
        }
      }

      pollCount += 1;
      if (pollCount % 2 === 0) {
        const status = await this.getSessionStatus(sessionId, signal);
        if (status && status.type === "idle" && (text || reasoning || meta || messageId || blocks.length)) {
          const currentPayload = { text, reasoning, meta, blocks };
          const staleMs = Date.now() - lastProgressAt;
          if (!payloadLooksInProgress(currentPayload) || staleMs > 1800) {
            return { messageId, text, reasoning, meta, blocks };
          }
        }
      }

      await sleep(220);
    }

    return { messageId, text, reasoning, meta, blocks };
  }

  async streamAssistantFromEvents(sessionId, startedAt, signal, handlers) {
    const baseUrl = await this.ensureStarted();
    const eventUrl = new URL(baseUrl + "/event");
    eventUrl.searchParams.set("directory", this.vaultPath);

    const textByPart = new Map();
    const reasoningByPart = new Map();
    const blockPartById = new Map();
    const partKindById = new Map();
    const promptedPermissionIds = new Set();
    const promptedQuestionIds = new Set();

    let messageId = "";
    let activeMessageCreatedAt = 0;
    let text = "";
    let reasoning = "";
    let meta = "";
    let blocks = [];
    let blocksKey = blocksFingerprint(blocks);
    let done = false;

    const joinPartText = (map) => {
      return Array.from(map.values())
        .map((v) => String(v || ""))
        .filter((v) => v.length > 0)
        .join("\n\n");
    };

    const updateText = () => {
      const next = joinPartText(textByPart);
      if (next !== text) {
        text = next;
        if (handlers && typeof handlers.onToken === "function") handlers.onToken(text);
      }
    };

    const updateReasoning = () => {
      const next = joinPartText(reasoningByPart);
      if (next !== reasoning) {
        reasoning = next;
        if (handlers && typeof handlers.onReasoning === "function") handlers.onReasoning(reasoning);
      }
    };

    const updateBlocks = () => {
      const nextBlocks = Array.from(blockPartById.values())
        .map((part, idx) => toPartBlock(part, idx))
        .filter(Boolean);
      const nextBlocksKey = blocksFingerprint(nextBlocks);
      if (nextBlocksKey !== blocksKey) {
        blocks = nextBlocks;
        blocksKey = nextBlocksKey;
        if (handlers && typeof handlers.onBlocks === "function") {
          handlers.onBlocks(blocks);
        }
      }
    };

    const resetActiveMessageContent = () => {
      textByPart.clear();
      reasoningByPart.clear();
      blockPartById.clear();
      partKindById.clear();
      text = "";
      reasoning = "";
      blocks = [];
      blocksKey = blocksFingerprint([]);
      if (handlers && typeof handlers.onToken === "function") handlers.onToken("");
      if (handlers && typeof handlers.onReasoning === "function") handlers.onReasoning("");
      if (handlers && typeof handlers.onBlocks === "function") handlers.onBlocks([]);
    };

    await nodeHttpRequestSse(
      eventUrl.toString(),
      Math.max(3000, Number(this.settings.requestTimeoutMs) || 120000),
      signal,
      {
        onEvent: (raw) => {
          const root = raw && typeof raw === "object" ? raw : null;
          if (root && typeof root.directory === "string" && root.directory && root.directory !== this.vaultPath) return;

          const event = root && root.payload && typeof root.payload === "object" ? root.payload : root;
          if (!event || typeof event.type !== "string") return;

          if (event.type === "message.part.updated") {
            const props = event.properties && typeof event.properties === "object" ? event.properties : {};
            const part = props.part && typeof props.part === "object" ? props.part : null;
            if (!part || typeof part.sessionID !== "string" || part.sessionID !== sessionId) return;
            if (part.time && Number(part.time.start || 0) > 0 && Number(part.time.start || 0) < startedAt - 1000) return;
            if (!messageId) return;
            if (typeof part.messageID !== "string" || part.messageID !== messageId) return;

            const partId = typeof part.id === "string" && part.id ? part.id : `${part.type || "part"}:${part.messageID || "unknown"}`;
            const delta = typeof props.delta === "string" ? props.delta : "";
            partKindById.set(partId, String(part.type || ""));

            if (part.type === "text") {
              if (part.ignored === true) {
                textByPart.delete(partId);
              } else {
                const current = textByPart.get(partId) || "";
                const next = delta ? current + delta : typeof part.text === "string" ? part.text : current;
                textByPart.set(partId, next);
              }
              updateText();
              return;
            }

            if (part.type === "reasoning") {
              const current = reasoningByPart.get(partId) || "";
              const next = delta ? current + delta : typeof part.text === "string" ? part.text : current;
              reasoningByPart.set(partId, next);
              blockPartById.set(partId, Object.assign({}, part, { text: next }));
              updateReasoning();
              updateBlocks();
              return;
            }
            blockPartById.set(partId, part);
            updateBlocks();
            return;
          }

          if (event.type === "message.part.removed") {
            const props = event.properties && typeof event.properties === "object" ? event.properties : {};
            const sid = typeof props.sessionID === "string" ? props.sessionID : "";
            if (sid && sid !== sessionId) return;
            const partId = typeof props.partID === "string" ? props.partID : "";
            if (!partId) return;
            const partType = String(partKindById.get(partId) || "");
            if (partType === "text") {
              textByPart.delete(partId);
              updateText();
            } else if (partType === "reasoning") {
              // Keep historical reasoning blocks visible to match terminal behavior.
              updateReasoning();
            } else {
              // Keep historical tool/step cards instead of deleting them.
              updateBlocks();
            }
            return;
          }

          if (event.type === "message.updated") {
            const info = event.properties && event.properties.info && typeof event.properties.info === "object" ? event.properties.info : null;
            if (!info || info.sessionID !== sessionId) return;
            if (info.role !== "assistant") return;
            if (typeof info.id !== "string" || !info.id) return;
            const created = info.time ? Number(info.time.created || 0) : 0;
            if (created > 0 && created < startedAt - 1000) return;

            if (!messageId || created >= activeMessageCreatedAt) {
              if (messageId && messageId !== info.id) {
                resetActiveMessageContent();
              }
              messageId = info.id;
              activeMessageCreatedAt = created;
            }
            if (info.id !== messageId) return;
            const err = extractErrorText(info.error);
            if (err) {
              meta = err;
              if (!text) {
                text = `模型返回错误：${err}`;
                if (handlers && typeof handlers.onToken === "function") handlers.onToken(text);
              }
            }

            const completed = info.time && Number(info.time.completed || 0) > 0;
            if (completed) {
              const snapshot = { text, reasoning, meta, blocks };
              if (hasTerminalPayload(snapshot) && !payloadLooksInProgress(snapshot)) {
                done = true;
              }
            }
            return;
          }

          if (event.type === "permission.updated" || event.type === "permission.asked") {
            const props = event.properties && typeof event.properties === "object" ? event.properties : {};
            const permission = props.request && typeof props.request === "object" ? props.request : props;
            const permId =
              (permission && typeof permission.id === "string" && permission.id) ||
              (typeof props.permissionID === "string" && props.permissionID) ||
              "";
            const permSession =
              (permission && typeof permission.sessionID === "string" && permission.sessionID) ||
              (typeof props.sessionID === "string" && props.sessionID) ||
              "";
            if (!permId || (permSession && permSession !== sessionId)) return;
            if (promptedPermissionIds.has(permId)) return;
            promptedPermissionIds.add(permId);

            if (handlers && typeof handlers.onPermissionRequest === "function") {
              Promise.resolve(handlers.onPermissionRequest(permission || {}))
                .then((response) => {
                  if (!response || !["once", "always", "reject"].includes(response)) return;
                  return this.replyPermission({
                    sessionId,
                    permissionId: permId,
                    response,
                    signal,
                  });
                })
                .catch((e) => {
                  this.log(`permission handler failed: ${e instanceof Error ? e.message : String(e)}`);
                });
            }
            return;
          }

          if (event.type === "question.asked") {
            const props = event.properties && typeof event.properties === "object" ? event.properties : {};
            const request = props.request && typeof props.request === "object" ? props.request : props;
            const requestId =
              (request && typeof request.id === "string" && request.id) ||
              (typeof props.requestID === "string" && props.requestID) ||
              "";
            const reqSession =
              (request && typeof request.sessionID === "string" && request.sessionID) ||
              (typeof props.sessionID === "string" && props.sessionID) ||
              "";
            if (!requestId || (reqSession && reqSession !== sessionId)) return;
            if (promptedQuestionIds.has(requestId)) return;
            promptedQuestionIds.add(requestId);
            if (handlers && typeof handlers.onQuestionRequest === "function") {
              handlers.onQuestionRequest(request || {});
            }
            return;
          }

          if (event.type === "question.replied" || event.type === "question.rejected") {
            const props = event.properties && typeof event.properties === "object" ? event.properties : {};
            const requestId = typeof props.requestID === "string" ? props.requestID : "";
            const reqSession = typeof props.sessionID === "string" ? props.sessionID : "";
            if (reqSession && reqSession !== sessionId) return;
            if (handlers && typeof handlers.onQuestionResolved === "function") {
              handlers.onQuestionResolved({
                requestId,
                sessionId: reqSession || sessionId,
                rejected: event.type === "question.rejected",
                answers: Array.isArray(props.answers) ? props.answers : [],
              });
            }
            return;
          }

          if (event.type === "tui.prompt.append") {
            const props = event.properties && typeof event.properties === "object" ? event.properties : {};
            const appendText = typeof props.text === "string" ? props.text : "";
            if (appendText && handlers && typeof handlers.onPromptAppend === "function") {
              handlers.onPromptAppend(appendText);
            }
            return;
          }

          if (event.type === "tui.toast.show") {
            const props = event.properties && typeof event.properties === "object" ? event.properties : {};
            if (handlers && typeof handlers.onToast === "function") {
              handlers.onToast({
                title: typeof props.title === "string" ? props.title : "",
                message: typeof props.message === "string" ? props.message : "",
                variant: typeof props.variant === "string" ? props.variant : "info",
              });
            }
            return;
          }

          if (event.type === "session.error") {
            const props = event.properties && typeof event.properties === "object" ? event.properties : {};
            if (props.sessionID && props.sessionID !== sessionId) return;
            const err = extractErrorText(props.error);
            if (err) {
              meta = err;
              if (!text) {
                text = `模型返回错误：${err}`;
                if (handlers && typeof handlers.onToken === "function") handlers.onToken(text);
              }
            }
            done = true;
            return;
          }

          if (event.type === "session.idle") {
            const sid = event.properties && event.properties.sessionID;
            if (sid === sessionId) done = true;
            return;
          }

          if (event.type === "session.status") {
            const sid = event.properties && event.properties.sessionID;
            const status = event.properties && event.properties.status && event.properties.status.type;
            if (sid === sessionId && status === "idle") done = true;
          }
        },
        shouldStop: () => done,
      },
    );

    return { messageId, text, reasoning, meta, blocks };
  }

  async sendMessage(options) {
    console.log("[opencode-assistant] sendMessage start", {
      sessionId: options.sessionId,
      transport: "compat",
      streaming: Boolean(this.settings.enableStreaming),
    });
    await this.ensureAuth();
    const startedAt = Date.now();

    const model = this.parseModel();
    const commandModel = this.parseCommandModel();
    const parsedCommand = this.parseSlashCommand(options.prompt);
    const resolvedCommand = parsedCommand ? await this.resolveCommandForEndpoint(parsedCommand.command) : { use: false, command: "" };
    const isCommandRequest = Boolean(parsedCommand && resolvedCommand.use);
    if (isCommandRequest) {
      console.log("[opencode-assistant] compat command route", {
        sessionId: options.sessionId,
        command: resolvedCommand.command,
      });
    }

    let res;
    let streamed = null;
    let usedRealStreaming = false;
    const commandBody = isCommandRequest
      ? {
        command: resolvedCommand.command,
        arguments: parsedCommand.arguments,
      }
      : null;
    if (commandBody && commandModel) commandBody.model = commandModel;

    const effectivePrompt = parsedCommand ? options.prompt.replace(/^\//, "").trim() : options.prompt;
    const messageBody = {
      noReply: false,
      parts: [{ type: "text", text: effectivePrompt || options.prompt }],
    };
    if (model) messageBody.model = model;

    if (this.settings.enableStreaming) {
      usedRealStreaming = true;
      const linked = createLinkedAbortController(options.signal);
      const eventSignal = linked.controller.signal;
      const eventStreamPromise = this.streamAssistantFromEvents(options.sessionId, startedAt, eventSignal, {
        onToken: options.onToken,
        onReasoning: options.onReasoning,
        onBlocks: options.onBlocks,
        onPermissionRequest: options.onPermissionRequest,
        onQuestionRequest: options.onQuestionRequest,
        onQuestionResolved: options.onQuestionResolved,
        onPromptAppend: options.onPromptAppend,
        onToast: options.onToast,
      }).catch((e) => {
        this.log(`event stream fallback: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });

      try {
        if (isCommandRequest) {
          // 保持与终端行为一致：命令执行期间也实时订阅事件流。
          await this.request(
            "POST",
            `/session/${encodeURIComponent(options.sessionId)}/command`,
            commandBody,
            { directory: this.vaultPath },
            options.signal,
          );
        } else {
          await this.request(
            "POST",
            `/session/${encodeURIComponent(options.sessionId)}/prompt_async`,
            messageBody,
            { directory: this.vaultPath },
            options.signal,
          );
        }
        streamed = await eventStreamPromise;
      } finally {
        linked.detach();
        linked.controller.abort();
      }

      if (
        !streamed ||
        (!normalizedRenderableText(streamed.text) &&
          !String(streamed.reasoning || "").trim() &&
          !(Array.isArray(streamed.blocks) && streamed.blocks.length))
      ) {
        streamed = await this.streamAssistantFromPolling(options.sessionId, startedAt, options.signal, {
          onToken: options.onToken,
          onReasoning: options.onReasoning,
          onBlocks: options.onBlocks,
        });
      }
    } else if (isCommandRequest) {
      // 非流式时命令走 /command，结果由 finalize 统一收敛。
      res = await this.request(
        "POST",
        `/session/${encodeURIComponent(options.sessionId)}/command`,
        commandBody,
        { directory: this.vaultPath },
        options.signal,
      );
    } else {
      res = await this.request(
        "POST",
        `/session/${encodeURIComponent(options.sessionId)}/message`,
        messageBody,
        { directory: this.vaultPath },
        options.signal,
      );
    }

    let finalized = null;
    if (usedRealStreaming) {
      finalized = streamed || { messageId: "", text: "", reasoning: "", meta: "", blocks: [] };
      if (!hasTerminalPayload(finalized) || payloadLooksInProgress(finalized)) {
        const streamedMessageId = finalized && typeof finalized.messageId === "string" ? finalized.messageId : "";
        const fetchedFinal = await this.finalizeAssistantResponse(
          options.sessionId,
          null,
          startedAt,
          options.signal,
          streamedMessageId,
        ).catch((e) => {
          this.log(`finalize after stream failed: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        });
        finalized = chooseRicherResponse(finalized, fetchedFinal);
      }
    } else {
      finalized = await this.finalizeAssistantResponse(options.sessionId, res, startedAt, options.signal);
    }

    const messageId = finalized.messageId;
    const text = finalized.text || "";
    const reasoning = finalized.reasoning || "";
    const meta = finalized.meta || "";
    const blocks = Array.isArray(finalized.blocks) ? finalized.blocks : [];

    if (this.settings.enableStreaming && !usedRealStreaming) {
      if (reasoning && options.onReasoning) {
        await streamPseudo(reasoning, options.onReasoning, options.signal);
      }
      await streamPseudo(text, options.onToken, options.signal);
      if (blocks.length && options.onBlocks) {
        options.onBlocks(blocks);
      }
    }

    console.log("[opencode-assistant] sendMessage done", {
      sessionId: options.sessionId,
      hasText: Boolean(normalizedRenderableText(text)),
      textLen: text ? text.length : 0,
      normalizedTextLen: normalizedRenderableText(text).length,
      reasoningLen: reasoning ? reasoning.length : 0,
      blockCount: blocks.length,
      messageId,
    });
    return { messageId, text, reasoning, meta, blocks };
  }

  async replyPermission(options) {
    const response = String(options && options.response ? options.response : "").trim();
    if (!["once", "always", "reject"].includes(response)) return { ok: false };
    await this.request(
      "POST",
      `/session/${encodeURIComponent(options.sessionId)}/permissions/${encodeURIComponent(options.permissionId)}`,
      { response },
      { directory: this.vaultPath },
      options.signal,
    );
    return { ok: true };
  }

  async listQuestions(options = {}) {
    const res = await this.request(
      "GET",
      "/question",
      undefined,
      { directory: this.vaultPath },
      options && options.signal ? options.signal : undefined,
    );
    const payload = res && res.data ? res.data : res;
    return Array.isArray(payload) ? payload : [];
  }

  async replyQuestion(options) {
    const requestId = String(options && options.requestId ? options.requestId : "").trim();
    if (!requestId) return { ok: false };
    const answers = Array.isArray(options && options.answers ? options.answers : [])
      ? options.answers.map((row) => {
        if (!Array.isArray(row)) return [];
        return row
          .map((item) => String(item || "").trim())
          .filter(Boolean);
      })
      : [];

    await this.request(
      "POST",
      `/question/${encodeURIComponent(requestId)}/reply`,
      { answers },
      { directory: this.vaultPath },
      options && options.signal ? options.signal : undefined,
    );
    return { ok: true };
  }

  async setDefaultModel(options) {
    await this.ensureAuth();
    const modelID = String(options.model || "").trim();
    if (!modelID) return { ok: true, model: "" };

    await this.request(
      "PATCH",
      "/config",
      {
        model: modelID,
      },
      { directory: this.vaultPath },
      options.signal,
    );

    return { ok: true, model: modelID };
  }

  async switchModel(options) {
    return this.setDefaultModel(options);
  }

  async waitForMessageText(sessionId, messageId, signal) {
    const timeoutMs = Math.max(2000, Math.min(15000, Number(this.settings.requestTimeoutMs) || 120000));
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      if (signal && signal.aborted) {
        throw new Error("用户取消了请求");
      }
      const msg = await this.request(
        "GET",
        `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`,
        undefined,
        { directory: this.vaultPath },
      );
      const payload = msg && msg.data ? msg.data : msg;
      const extracted = extractAssistantParts(payload && payload.parts ? payload.parts : []);
      const text = extracted.text;
      if (text) return text;
      await sleep(250);
    }

    return "";
  }

  async waitForLatestAssistantText(sessionId, startedAt, signal) {
    const timeoutMs = Math.max(2000, Math.min(15000, Number(this.settings.requestTimeoutMs) || 120000));
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      if (signal && signal.aborted) {
        throw new Error("用户取消了请求");
      }
      const res = await this.request(
        "GET",
        `/session/${encodeURIComponent(sessionId)}/message`,
        undefined,
        { directory: this.vaultPath, limit: 50 },
      );
      const payload = res && res.data ? res.data : res;
      const list = Array.isArray(payload) ? payload : [];

      const candidates = list
        .filter((item) => item && item.info && item.info.role === "assistant")
        .filter((item) => {
          const t = item.info && item.info.time ? item.info.time.created || 0 : 0;
          return !startedAt || t >= startedAt - 1000;
        })
        .sort((a, b) => {
          const ta = a.info && a.info.time ? a.info.time.created || 0 : 0;
          const tb = b.info && b.info.time ? b.info.time.created || 0 : 0;
          return tb - ta;
        });

      for (const item of candidates) {
        const extracted = extractAssistantParts(item.parts || []);
        const text = extracted.text;
        if (text) return text;
      }

      await sleep(250);
    }

    return "";
  }

  parseSlashCommand(prompt) {
    const text = String(prompt || "").trim();
    if (!text.startsWith("/")) return null;
    if (text.length <= 1) return null;

    // /ah foo bar -> { command: "ah", arguments: "foo bar" }
    const withoutSlash = text.slice(1).trim();
    if (!withoutSlash) return null;
    const firstSpace = withoutSlash.indexOf(" ");
    if (firstSpace < 0) {
      return { command: withoutSlash, arguments: "" };
    }

    return {
      command: withoutSlash.slice(0, firstSpace).trim(),
      arguments: withoutSlash.slice(firstSpace + 1).trim(),
    };
  }

  async stop() {
    if (this.process) this.process.kill();
    this.process = null;
    this.baseUrl = "";
    this.bootPromise = null;
  }
}


module.exports = { CompatTransport };
