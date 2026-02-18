const path = require("path");
const { pathToFileURL } = require("url");
const { createLinkedAbortController } = require("./http-utils");
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
  payloadLooksInProgress,
  hasTerminalPayload,
  chooseRicherResponse,
} = require("./assistant-payload-utils");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SdkTransport {
  constructor(options) {
    this.vaultPath = options.vaultPath;
    this.settings = options.settings;
    this.logger = typeof options.logger === "function" ? options.logger : () => {};
    this.client = null;
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

  async ensureClient() {
    if (this.client) return this.client;

    let mod = null;
    const importErrors = [];
    try {
      mod = await import("@opencode-ai/sdk/v2/client");
    } catch (e) {
      importErrors.push(`@opencode-ai/sdk/v2/client: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!mod) {
      const local = path.join(this.vaultPath, ".opencode/node_modules/@opencode-ai/sdk/dist/v2/client.js");
      try {
        mod = await import(pathToFileURL(local).href);
      } catch (e) {
        importErrors.push(`${local}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (!mod || typeof mod.createOpencodeClient !== "function") {
      const details = importErrors.length ? `；${importErrors.join(" | ")}` : "";
      throw new Error(`OpenCode SDK(v2) 加载失败：createOpencodeClient 不可用${details}`);
    }

    this.client = mod.createOpencodeClient({
      directory: this.vaultPath,
      throwOnError: true,
      timeout: this.settings.requestTimeoutMs,
    });

    return this.client;
  }

  parseModel() {
    return parseModel(this.settings.defaultModel);
  }

  parseCommandModel() {
    return parseCommandModel(this.settings.defaultModel);
  }

  async testConnection() {
    const client = await this.ensureClient();
    await client.path.get({ directory: this.vaultPath });
    return { ok: true, mode: "sdk" };
  }

  async listSessions() {
    const client = await this.ensureClient();
    const res = await client.session.list({ directory: this.vaultPath });
    return res.data || [];
  }

  async createSession(title) {
    const client = await this.ensureClient();
    const res = await client.session.create(title ? { directory: this.vaultPath, title } : { directory: this.vaultPath });
    return res.data;
  }

  async listModels() {
    try {
      const client = await this.ensureClient();
      const res = await client.config.providers({ directory: this.vaultPath });
      const providers = res.data || [];
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
      const client = await this.ensureClient();
      const res = await client.command.list({ directory: this.vaultPath });
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

  parseSlashCommand(prompt) {
    return parseSlashCommand(prompt);
  }

  async ensureAuth() {
    if (this.settings.authMode !== "custom-api-key") return;
    if (!this.settings.customApiKey.trim()) throw new Error("当前是自定义 API Key 模式，但 API Key 为空");

    const client = await this.ensureClient();
    const providerId = this.settings.customProviderId.trim();

    await client.auth.set({
      providerID: providerId,
      auth: { type: "api", key: this.settings.customApiKey.trim() },
    });

    if (this.settings.customBaseUrl.trim()) {
      await client.config.update({
        directory: this.vaultPath,
        config: {
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

  async getSessionStatus(sessionId, signal) {
    try {
      const client = await this.ensureClient();
      const res = await client.session.status({ directory: this.vaultPath }, { signal });
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

  async pollAssistantResult(client, sessionId, startedAt, signal, preferredMessageId = "", handlers) {
    const quietTimeoutMs = Math.max(10000, Number(this.settings.requestTimeoutMs) || 120000);
    const polled = await pollAssistantPayload({
      initialMessageId: preferredMessageId,
      initialPayload: { text: "", reasoning: "", meta: "", blocks: [] },
      signal,
      quietTimeoutMs,
      maxTotalMs: Math.max(quietTimeoutMs * 2, 5 * 60 * 1000),
      sleep,
      onToken: handlers && handlers.onToken,
      onReasoning: handlers && handlers.onReasoning,
      onBlocks: handlers && handlers.onBlocks,
      getByMessageId: async (messageId, requestSignal) => {
        const byId = await client.session.message(
          { sessionID: sessionId, messageID: messageId, directory: this.vaultPath },
          { signal: requestSignal },
        );
        const byIdPayload = byId && byId.data ? byId.data : byId;
        const role =
          byIdPayload && byIdPayload.info && typeof byIdPayload.info.role === "string"
            ? byIdPayload.info.role
            : "";
        if (role && role !== "assistant") {
          return { payload: null, completed: false, messageId: "" };
        }
        const completedAt = byIdPayload && byIdPayload.info && byIdPayload.info.time
          ? Number(byIdPayload.info.time.completed || 0)
          : 0;
        return {
          payload: extractAssistantPayloadFromEnvelope(byIdPayload),
          completed: completedAt > 0,
          messageId,
        };
      },
      getLatest: async (requestSignal) => {
        const listRes = await client.session.messages(
          { sessionID: sessionId, directory: this.vaultPath, limit: 50 },
          { signal: requestSignal },
        );
        const listPayload = listRes && listRes.data ? listRes.data : listRes;
        const latest = this.findLatestAssistantMessage(listPayload, startedAt);
        if (!latest) return null;
        const completedAt = latest && latest.info && latest.info.time
          ? Number(latest.info.time.completed || 0)
          : 0;
        const createdAt = latest && latest.info && latest.info.time
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

    const payload = await ensureRenderablePayload({
      payload: polled.payload,
      lastStatus: polled.lastStatus,
      getSessionStatus: (requestSignal) => this.getSessionStatus(sessionId, requestSignal),
      signal,
    });

    return {
      messageId: polled.messageId || "",
      text: payload.text || "",
      reasoning: payload.reasoning || "",
      meta: payload.meta || "",
      blocks: Array.isArray(payload.blocks) ? payload.blocks : [],
    };
  }

  async streamAssistantFromEvents(client, sessionId, startedAt, signal, handlers) {
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
      permissionEventTypes: ["permission.asked"],
    });

    const eventStream = await client.event.subscribe(
      { directory: this.vaultPath },
      { signal, sseMaxRetryAttempts: 3 },
    );

    for await (const raw of eventStream.stream) {
      if (signal && signal.aborted) throw new Error("用户取消了请求");

      const root = raw && typeof raw === "object" ? raw : null;
      const event = root && root.payload && typeof root.payload === "object" ? root.payload : root;
      if (!event || typeof event !== "object") continue;

      reducer.consume(event);
      if (reducer.isDone()) break;
    }

    return reducer.snapshot();
  }

  async sendMessage(options) {
    this.log(`sendMessage start ${JSON.stringify({ sessionId: options.sessionId, transport: "sdk" })}`);
    const client = await this.ensureClient();
    await this.ensureAuth();
    const startedAt = Date.now();
    const model = this.parseModel();
    const commandModel = this.parseCommandModel();
    const parsedCommand = this.parseSlashCommand(options.prompt);
    const resolvedCommand = parsedCommand ? await this.resolveCommandForEndpoint(parsedCommand.command) : { use: false, command: "" };

    let streamed = null;
    let directResponse = null;
    let usedRealStreaming = false;

    if (this.settings.enableStreaming) {
      usedRealStreaming = true;
      const linked = createLinkedAbortController(options.signal);
      const eventSignal = linked.controller.signal;
      const streamPromise = this.streamAssistantFromEvents(client, options.sessionId, startedAt, eventSignal, {
        onToken: options.onToken,
        onReasoning: options.onReasoning,
        onBlocks: options.onBlocks,
        onPermissionRequest: options.onPermissionRequest,
        onQuestionRequest: options.onQuestionRequest,
        onQuestionResolved: options.onQuestionResolved,
        onPromptAppend: options.onPromptAppend,
        onToast: options.onToast,
      }).catch((e) => {
        this.log(`sdk event stream fallback: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });

      try {
        if (parsedCommand && resolvedCommand.use) {
          await client.session.command(
            {
              sessionID: options.sessionId,
              directory: this.vaultPath,
              command: resolvedCommand.command,
              arguments: parsedCommand.arguments,
              model: commandModel,
            },
            { signal: options.signal },
          );
        } else {
          const effectivePrompt = parsedCommand ? options.prompt.replace(/^\//, "").trim() : options.prompt;
          await client.session.promptAsync(
            {
              sessionID: options.sessionId,
              directory: this.vaultPath,
              noReply: false,
              model,
              parts: [{ type: "text", text: effectivePrompt || options.prompt }],
            },
            { signal: options.signal },
          );
        }
        streamed = await streamPromise;
      } finally {
        linked.detach();
        linked.controller.abort();
      }
    } else if (parsedCommand && resolvedCommand.use) {
      const commandRes = await client.session.command(
        {
          sessionID: options.sessionId,
          directory: this.vaultPath,
          command: resolvedCommand.command,
          arguments: parsedCommand.arguments,
          model: commandModel,
        },
        { signal: options.signal },
      );
      const data = commandRes && commandRes.data ? commandRes.data : commandRes;
      const payload = extractAssistantPayloadFromEnvelope(data);
      directResponse = {
        messageId: data && data.info ? data.info.id : "",
        text: payload.text || "",
        reasoning: payload.reasoning || "",
        meta: payload.meta || "",
        blocks: Array.isArray(payload.blocks) ? payload.blocks : [],
      };
    } else {
      const promptRes = await client.session.prompt(
        {
          sessionID: options.sessionId,
          directory: this.vaultPath,
          noReply: false,
          model,
          parts: [{ type: "text", text: options.prompt }],
        },
        { signal: options.signal },
      );
      const data = promptRes && promptRes.data ? promptRes.data : promptRes;
      const payload = extractAssistantPayloadFromEnvelope(data);
      directResponse = {
        messageId: data && data.info ? data.info.id : "",
        text: payload.text || "",
        reasoning: payload.reasoning || "",
        meta: payload.meta || "",
        blocks: Array.isArray(payload.blocks) ? payload.blocks : [],
      };
    }

    let finalized = streamed || directResponse;
    if (
      !finalized ||
      !hasRenderablePayload(finalized) ||
      (usedRealStreaming && !hasTerminalPayload(finalized))
    ) {
      const preferredMessageId = finalized && typeof finalized.messageId === "string" ? finalized.messageId : "";
      const polled = await this.pollAssistantResult(
        client,
        options.sessionId,
        startedAt,
        options.signal,
        preferredMessageId,
        usedRealStreaming ? null : options,
      ).catch((e) => {
        this.log(`sdk poll fallback failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });
      finalized = chooseRicherResponse(finalized, polled);
    }

    const ensuredPayload = await ensureRenderablePayload({
      payload: finalized || { text: "", reasoning: "", meta: "", blocks: [] },
      getSessionStatus: (requestSignal) => this.getSessionStatus(options.sessionId, requestSignal),
      signal: options.signal,
    });
    finalized = {
      ...(finalized || { messageId: "" }),
      text: ensuredPayload.text || "",
      reasoning: ensuredPayload.reasoning || "",
      meta: ensuredPayload.meta || "",
      blocks: Array.isArray(ensuredPayload.blocks) ? ensuredPayload.blocks : [],
    };

    if (!usedRealStreaming && this.settings.enableStreaming) {
      if (finalized.reasoning && options.onReasoning) options.onReasoning(finalized.reasoning);
      if (options.onToken) options.onToken(finalized.text || "");
      if (Array.isArray(finalized.blocks) && finalized.blocks.length && options.onBlocks) {
        options.onBlocks(finalized.blocks);
      }
    }

    this.log(`sendMessage done ${JSON.stringify({
      sessionId: options.sessionId,
      transport: "sdk",
      hasText: Boolean(normalizedRenderableText(finalized.text || "")),
      textLen: String(finalized.text || "").length,
      normalizedTextLen: normalizedRenderableText(finalized.text || "").length,
      reasoningLen: String(finalized.reasoning || "").length,
      blockCount: Array.isArray(finalized.blocks) ? finalized.blocks.length : 0,
      messageId: finalized.messageId || "",
    })}`);

    return {
      messageId: finalized.messageId || "",
      text: finalized.text || "",
      reasoning: finalized.reasoning || "",
      meta: finalized.meta || "",
      blocks: Array.isArray(finalized.blocks) ? finalized.blocks : [],
    };
  }

  async replyPermission(options) {
    const client = await this.ensureClient();
    const response = String(options && options.response ? options.response : "").trim();
    if (!["once", "always", "reject"].includes(response)) return { ok: false };

    try {
      await client.permission.reply(
        {
          requestID: options.permissionId,
          directory: this.vaultPath,
          reply: response,
        },
        { signal: options.signal },
      );
    } catch (e) {
      if (!options.sessionId) throw e;
      await client.permission.respond(
        {
          sessionID: options.sessionId,
          permissionID: options.permissionId,
          directory: this.vaultPath,
          response,
        },
        { signal: options.signal },
      );
    }
    return { ok: true };
  }

  async listQuestions(options = {}) {
    const client = await this.ensureClient();
    const signal = options && options.signal ? options.signal : undefined;
    const res = await client.question.list({ directory: this.vaultPath }, { signal });
    const payload = res && res.data ? res.data : res;
    return Array.isArray(payload) ? payload : [];
  }

  async replyQuestion(options) {
    const client = await this.ensureClient();
    const requestID = String(options && options.requestId ? options.requestId : "").trim();
    if (!requestID) return { ok: false };

    const answers = Array.isArray(options && options.answers ? options.answers : [])
      ? options.answers.map((row) => {
        if (!Array.isArray(row)) return [];
        return row
          .map((item) => String(item || "").trim())
          .filter(Boolean);
      })
      : [];

    await client.question.reply(
      {
        requestID,
        directory: this.vaultPath,
        answers,
      },
      { signal: options && options.signal ? options.signal : undefined },
    );
    return { ok: true };
  }

  async setDefaultModel(options) {
    const client = await this.ensureClient();
    await this.ensureAuth();

    const modelID = String(options.model || "").trim();
    if (!modelID) return { ok: true, model: "" };

    await client.config.update({
      directory: this.vaultPath,
      config: { model: modelID },
    });

    return { ok: true, model: modelID };
  }

  async switchModel(options) {
    return this.setDefaultModel(options);
  }

  async stop() {
    this.client = null;
  }
}


module.exports = { SdkTransport };
