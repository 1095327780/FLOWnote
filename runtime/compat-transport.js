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
  parseModel,
  parseCommandModel,
  availableCommandSet,
  resolveCommandFromSet,
  parseSlashCommand,
  findLatestAssistantMessage,
} = require("./transports/shared/command-utils");
const { createTransportEventReducer } = require("./transports/shared/event-reducer");
const {
  pollAssistantPayload,
  ensureRenderablePayload,
} = require("./transports/shared/finalizer");
const {
  extractAssistantPayloadFromEnvelope,
  normalizedRenderableText,
  hasRenderablePayload,
  formatSessionStatusText,
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
    this.logger = typeof options.logger === "function" ? options.logger : () => {};
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
    this.logger(line);
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
    return parseModel(this.settings.defaultModel);
  }

  parseCommandModel() {
    return parseCommandModel(this.settings.defaultModel);
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
    return findLatestAssistantMessage(messages, startedAt);
  }

  async ensureAuth() {
    if (this.settings.authMode !== "custom-api-key") return;
    if (!this.settings.customApiKey.trim()) throw new Error("当前是自定义 API Key 模式，但 API Key 为空");

    const providerId = this.settings.customProviderId.trim();
    await this.setProviderApiKeyAuth({
      providerID: providerId,
      key: this.settings.customApiKey.trim(),
    });

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

  async listProviders() {
    const res = await this.request("GET", "/provider", undefined, { directory: this.vaultPath });
    const payload = res && res.data ? res.data : res || {};
    const all = Array.isArray(payload.all) ? payload.all : [];
    const connected = Array.isArray(payload.connected) ? payload.connected : [];
    const defaults = payload && typeof payload.default === "object" && payload.default ? payload.default : {};
    return {
      all,
      connected,
      default: defaults,
    };
  }

  async listProviderAuthMethods() {
    const res = await this.request("GET", "/provider/auth", undefined, { directory: this.vaultPath });
    const payload = res && res.data ? res.data : res || {};
    return payload && typeof payload === "object" ? payload : {};
  }

  async authorizeProviderOauth(options = {}) {
    const providerID = String(options.providerID || "").trim();
    if (!providerID) throw new Error("providerID 不能为空");

    const method = Number(options.method);
    if (!Number.isFinite(method) || method < 0) throw new Error("OAuth method 无效");

    const res = await this.request(
      "POST",
      `/provider/${encodeURIComponent(providerID)}/oauth/authorize`,
      { method: Number(method) },
      { directory: this.vaultPath },
      options.signal,
    );
    return res && res.data ? res.data : res;
  }

  async completeProviderOauth(options = {}) {
    const providerID = String(options.providerID || "").trim();
    if (!providerID) throw new Error("providerID 不能为空");

    const method = Number(options.method);
    if (!Number.isFinite(method) || method < 0) throw new Error("OAuth method 无效");

    const body = { method: Number(method) };
    const code = String(options.code || "").trim();
    if (code) body.code = code;

    const res = await this.request(
      "POST",
      `/provider/${encodeURIComponent(providerID)}/oauth/callback`,
      body,
      { directory: this.vaultPath },
      options.signal,
    );
    const payload = res && Object.prototype.hasOwnProperty.call(res, "data") ? res.data : res;
    return payload === undefined ? true : Boolean(payload);
  }

  async setProviderApiKeyAuth(options = {}) {
    const providerID = String(options.providerID || "").trim();
    if (!providerID) throw new Error("providerID 不能为空");

    const key = String(options.key || "").trim();
    if (!key) throw new Error("API Key 不能为空");

    await this.request(
      "PUT",
      `/auth/${encodeURIComponent(providerID)}`,
      { type: "api", key },
      undefined,
      options.signal,
    );
    return true;
  }

  async clearProviderAuth(options = {}) {
    const providerID = String(options.providerID || "").trim();
    if (!providerID) throw new Error("providerID 不能为空");

    await this.request(
      "DELETE",
      `/auth/${encodeURIComponent(providerID)}`,
      undefined,
      undefined,
      options.signal,
    );
    return true;
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

  async resolveCommandForEndpoint(commandName) {
    const list = await this.listCommands();
    const names = availableCommandSet(list);
    return resolveCommandFromSet(commandName, names);
  }

  getFinalizeTimeoutConfig() {
    const configured = Math.max(10000, Number(this.settings.requestTimeoutMs) || 120000);
    const quietTimeoutMs = Math.min(configured, 30000);
    const maxTotalMs = Math.min(Math.max(quietTimeoutMs * 2, 30000), 90000);
    return { quietTimeoutMs, maxTotalMs };
  }

  async finalizeAssistantResponse(sessionId, responsePayload, startedAt, signal, preferredMessageId = "") {
    const data = responsePayload && responsePayload.data ? responsePayload.data : responsePayload;
    const initialMessageId = preferredMessageId || (data && data.info ? data.info.id : "");
    const initialPayload = extractAssistantPayloadFromEnvelope(data);
    const timeoutCfg = this.getFinalizeTimeoutConfig();
    const quietTimeoutMs = timeoutCfg.quietTimeoutMs;

    const polled = await pollAssistantPayload({
      initialMessageId,
      initialPayload,
      signal,
      quietTimeoutMs,
      maxTotalMs: timeoutCfg.maxTotalMs,
      sleep,
      getByMessageId: async (messageId, requestSignal) => {
        const msgRes = await this.request(
          "GET",
          `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`,
          undefined,
          { directory: this.vaultPath },
          requestSignal,
        );
        const messagePayload = msgRes && msgRes.data ? msgRes.data : msgRes;
        const role =
          messagePayload && messagePayload.info && typeof messagePayload.info.role === "string"
            ? messagePayload.info.role
            : "";
        if (role && role !== "assistant") {
          return { payload: null, completed: false, messageId: "" };
        }
        const completedAt =
          messagePayload && messagePayload.info && messagePayload.info.time
            ? Number(messagePayload.info.time.completed || 0)
            : 0;
        return {
          payload: extractAssistantPayloadFromEnvelope(messagePayload),
          completed: completedAt > 0,
          messageId,
        };
      },
      getLatest: async (requestSignal) => {
        const listRes = await this.request(
          "GET",
          `/session/${encodeURIComponent(sessionId)}/message`,
          undefined,
          { directory: this.vaultPath, limit: 50 },
          requestSignal,
        );
        const listPayload = listRes && listRes.data ? listRes.data : listRes;
        const latest = this.findLatestAssistantMessage(listPayload, startedAt);
        if (!latest) return null;
        const completedAt =
          latest && latest.info && latest.info.time
            ? Number(latest.info.time.completed || 0)
            : 0;
        const createdAt =
          latest && latest.info && latest.info.time
            ? Number(latest.info.time.created || 0)
            : 0;
        return {
          payload: extractAssistantPayloadFromEnvelope(latest),
          completed: completedAt > 0,
          messageId: latest && latest.info ? latest.info.id : "",
          createdAt,
        };
      },
      getSessionStatus: (requestSignal) => this.getSessionStatus(sessionId, requestSignal),
    });

    const hadRenderablePayload = hasRenderablePayload(polled.payload);
    if (polled.timedOut && !hadRenderablePayload) {
      const statusText = formatSessionStatusText(polled.lastStatus);
      const activeModel = String(this.settings && this.settings.defaultModel ? this.settings.defaultModel : "").trim();
      const modelText = activeModel ? `模型 ${activeModel}` : "当前模型";
      throw new Error(`${modelText} 长时间无响应，可能不受当前账号/API Key 支持（session.status=${statusText}）。请切换模型或检查登录配置。`);
    }

    let payload = await ensureRenderablePayload({
      payload: polled.payload,
      lastStatus: polled.lastStatus,
      getSessionStatus: (requestSignal) => this.getSessionStatus(sessionId, requestSignal),
      signal,
    });

    if (polled.timedOut) {
      this.log(`finalize timeout ${JSON.stringify({
        sessionId,
        messageId: polled.messageId,
        idleMs: Date.now() - Number(polled.lastProgressAt || polled.startedAt || Date.now()),
        quietTimeoutMs: polled.quietTimeoutMs,
        maxTotalMs: polled.maxTotalMs,
        textLen: String(payload.text || "").length,
        reasoningLen: String(payload.reasoning || "").length,
        blockCount: Array.isArray(payload.blocks) ? payload.blocks.length : 0,
        terminal: hasTerminalPayload(payload),
        inProgress: payloadLooksInProgress(payload),
      })}`);
    }

    if (isIntermediateToolCallPayload(payload) && normalizedRenderableText(payload.text || "").length <= 1) {
      payload = { ...payload, text: "" };
    }

    return {
      messageId: polled.messageId || "",
      text: payload.text || "",
      reasoning: payload.reasoning || "",
      meta: payload.meta || "",
      blocks: payload.blocks || [],
    };
  }

  async streamAssistantFromPolling(sessionId, startedAt, signal, handlers) {
    const timeoutCfg = this.getFinalizeTimeoutConfig();
    const quietTimeoutMs = timeoutCfg.quietTimeoutMs;
    const polled = await pollAssistantPayload({
      signal,
      quietTimeoutMs,
      maxTotalMs: timeoutCfg.maxTotalMs,
      sleep,
      requireTerminal: false,
      onToken: handlers && handlers.onToken,
      onReasoning: handlers && handlers.onReasoning,
      onBlocks: handlers && handlers.onBlocks,
      getLatest: async (requestSignal) => {
        const listRes = await this.request(
          "GET",
          `/session/${encodeURIComponent(sessionId)}/message`,
          undefined,
          { directory: this.vaultPath, limit: 50 },
          requestSignal,
        );
        const listPayload = listRes && listRes.data ? listRes.data : listRes;
        const latest = this.findLatestAssistantMessage(listPayload, startedAt);
        if (!latest) return null;
        const completedAt = latest && latest.info && latest.info.time ? Number(latest.info.time.completed || 0) : 0;
        const createdAt = latest && latest.info && latest.info.time ? Number(latest.info.time.created || 0) : 0;
        return {
          payload: extractAssistantPayloadFromEnvelope(latest),
          completed: completedAt > 0,
          messageId: latest && latest.info ? latest.info.id : "",
          createdAt,
        };
      },
      getSessionStatus: (requestSignal) => this.getSessionStatus(sessionId, requestSignal),
    });

    return {
      messageId: polled.messageId || "",
      text: polled.payload && polled.payload.text ? polled.payload.text : "",
      reasoning: polled.payload && polled.payload.reasoning ? polled.payload.reasoning : "",
      meta: polled.payload && polled.payload.meta ? polled.payload.meta : "",
      blocks: polled.payload && Array.isArray(polled.payload.blocks) ? polled.payload.blocks : [],
    };
  }

  async streamAssistantFromEvents(sessionId, startedAt, signal, handlers) {
    const baseUrl = await this.ensureStarted();
    const eventUrl = new URL(baseUrl + "/event");
    eventUrl.searchParams.set("directory", this.vaultPath);
    const reducer = createTransportEventReducer({
      sessionId,
      startedAt,
      onToken: handlers && handlers.onToken,
      onReasoning: handlers && handlers.onReasoning,
      onBlocks: handlers && handlers.onBlocks,
      onPermissionRequest: (permission, permissionId) => {
        if (!handlers || typeof handlers.onPermissionRequest !== "function") return;
        Promise.resolve(handlers.onPermissionRequest(permission || {}))
          .then((response) => {
            if (!response || !["once", "always", "reject"].includes(response)) return;
            return this.replyPermission({
              sessionId,
              permissionId,
              response,
              signal,
            });
          })
          .catch((e) => {
            this.log(`permission handler failed: ${e instanceof Error ? e.message : String(e)}`);
          });
      },
      onQuestionRequest: handlers && handlers.onQuestionRequest,
      onQuestionResolved: handlers && handlers.onQuestionResolved,
      onPromptAppend: handlers && handlers.onPromptAppend,
      onToast: handlers && handlers.onToast,
      permissionEventTypes: ["permission.updated", "permission.asked"],
    });

    await nodeHttpRequestSse(
      eventUrl.toString(),
      Math.max(3000, Number(this.settings.requestTimeoutMs) || 120000),
      signal,
      {
        onEvent: (raw) => {
          const root = raw && typeof raw === "object" ? raw : null;
          if (root && typeof root.directory === "string" && root.directory && root.directory !== this.vaultPath) return;

          const event = root && root.payload && typeof root.payload === "object" ? root.payload : root;
          if (!event || typeof event !== "object") return;
          reducer.consume(event);
        },
        shouldStop: () => reducer.isDone(),
      },
    );

    return reducer.snapshot();
  }

  async sendMessage(options) {
    this.log(`sendMessage start ${JSON.stringify({
      sessionId: options.sessionId,
      transport: "compat",
      streaming: Boolean(this.settings.enableStreaming),
    })}`);
    await this.ensureAuth();
    const startedAt = Date.now();

    const model = this.parseModel();
    const commandModel = this.parseCommandModel();
    const parsedCommand = this.parseSlashCommand(options.prompt);
    const resolvedCommand = parsedCommand ? await this.resolveCommandForEndpoint(parsedCommand.command) : { use: false, command: "" };
    const isCommandRequest = Boolean(parsedCommand && resolvedCommand.use);
    if (isCommandRequest) {
      this.log(`compat command route ${JSON.stringify({
        sessionId: options.sessionId,
        command: resolvedCommand.command,
      })}`);
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
      const streamWaitMs = Math.max(8000, Math.min(45000, Number(this.settings.requestTimeoutMs) || 120000));
      let streamTimeoutHandle = null;
      const streamTimeoutPromise = new Promise((resolve) => {
        streamTimeoutHandle = setTimeout(() => {
          this.log(`event stream soft-timeout (${streamWaitMs}ms), fallback to polling`);
          linked.controller.abort();
          resolve(null);
        }, streamWaitMs);
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
        streamed = await Promise.race([eventStreamPromise, streamTimeoutPromise]);
        if (streamTimeoutHandle) clearTimeout(streamTimeoutHandle);
      } finally {
        if (streamTimeoutHandle) clearTimeout(streamTimeoutHandle);
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
        );
        finalized = chooseRicherResponse(finalized, fetchedFinal);
      }
    } else {
      finalized = await this.finalizeAssistantResponse(options.sessionId, res, startedAt, options.signal);
    }

    if (payloadLooksInProgress(finalized)) {
      throw new Error("模型响应未完成且已超时，请切换模型或检查该 Provider 鉴权。");
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

    this.log(`sendMessage done ${JSON.stringify({
      sessionId: options.sessionId,
      hasText: Boolean(normalizedRenderableText(text)),
      textLen: text ? text.length : 0,
      normalizedTextLen: normalizedRenderableText(text).length,
      reasoningLen: reasoning ? reasoning.length : 0,
      blockCount: blocks.length,
      messageId,
    })}`);
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

  parseSlashCommand(prompt) {
    return parseSlashCommand(prompt);
  }

  async stop() {
    if (this.process) this.process.kill();
    this.process = null;
    this.baseUrl = "";
    this.bootPromise = null;
  }
}


module.exports = { CompatTransport };
