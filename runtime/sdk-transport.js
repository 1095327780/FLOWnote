const path = require("path");
const { pathToFileURL } = require("url");
const { createLinkedAbortController } = require("./http-utils");
const {
  toPartBlock,
  blocksFingerprint,
  extractErrorText,
  extractAssistantPayloadFromEnvelope,
  formatSessionStatusText,
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
    this.client = null;
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
    if (normalized === "model" && names.has("models")) return { use: true, command: "models" };
    if (normalized === "models" && names.has("model")) return { use: true, command: "model" };
    return { use: false, command: normalized };
  }

  parseSlashCommand(prompt) {
    const text = String(prompt || "").trim();
    if (!text.startsWith("/")) return null;
    if (text.length <= 1) return null;

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

  async pollAssistantResult(client, sessionId, startedAt, signal, preferredMessageId = "", handlers) {
    const quietTimeoutMs = Math.max(10000, Number(this.settings.requestTimeoutMs) || 120000);
    const maxTotalMs = Math.max(quietTimeoutMs * 2, 5 * 60 * 1000);
    const started = Date.now();
    let lastProgressAt = started;
    let messageId = preferredMessageId;
    let payload = { text: "", reasoning: "", meta: "", blocks: [] };
    let payloadKey = `${normalizedRenderableText(payload.text)}|${payload.reasoning}|${blocksFingerprint(payload.blocks)}`;
    let lastStatus = null;

    const onPayloadChange = () => {
      const nextKey = `${normalizedRenderableText(payload.text)}|${payload.reasoning}|${blocksFingerprint(payload.blocks)}`;
      if (nextKey === payloadKey) return;
      payloadKey = nextKey;
      lastProgressAt = Date.now();
      if (handlers && typeof handlers.onToken === "function") handlers.onToken(String(payload.text || ""));
      if (handlers && typeof handlers.onReasoning === "function") handlers.onReasoning(String(payload.reasoning || ""));
      if (handlers && typeof handlers.onBlocks === "function") handlers.onBlocks(Array.isArray(payload.blocks) ? payload.blocks : []);
    };

    while (Date.now() - started < maxTotalMs && Date.now() - lastProgressAt < quietTimeoutMs) {
      if (signal && signal.aborted) throw new Error("用户取消了请求");

      if (messageId) {
        try {
          const byId = await client.session.message(
            { sessionID: sessionId, messageID: messageId, directory: this.vaultPath },
            { signal },
          );
          const byIdPayload = byId && byId.data ? byId.data : byId;
          const byIdRole =
            byIdPayload && byIdPayload.info && typeof byIdPayload.info.role === "string"
              ? byIdPayload.info.role
              : "";
          if (byIdRole && byIdRole !== "assistant") {
            messageId = "";
          } else {
          payload = chooseRicherResponse(payload, extractAssistantPayloadFromEnvelope(byIdPayload));
          onPayloadChange();
          const completedAt = byIdPayload && byIdPayload.info && byIdPayload.info.time
            ? Number(byIdPayload.info.time.completed || 0)
            : 0;
          if (completedAt > 0 && hasRenderablePayload(payload) && !payloadLooksInProgress(payload)) break;
          }
        } catch {
          // ignore by-id failure and continue with latest query
        }
      }

      try {
        const listRes = await client.session.messages(
          { sessionID: sessionId, directory: this.vaultPath, limit: 50 },
          { signal },
        );
        const listPayload = listRes && listRes.data ? listRes.data : listRes;
        const latest = this.findLatestAssistantMessage(listPayload, startedAt);
        if (latest) {
          if (!messageId && latest.info && latest.info.id) {
            messageId = latest.info.id;
            lastProgressAt = Date.now();
          }
          payload = chooseRicherResponse(payload, extractAssistantPayloadFromEnvelope(latest));
          onPayloadChange();
          const completedAt = latest && latest.info && latest.info.time
            ? Number(latest.info.time.completed || 0)
            : 0;
          if (completedAt > 0 && hasRenderablePayload(payload) && !payloadLooksInProgress(payload)) break;
        }
      } catch {
        // ignore and keep waiting
      }

      lastStatus = await this.getSessionStatus(sessionId, signal);
      if (lastStatus && lastStatus.type === "idle" && hasRenderablePayload(payload)) {
        const staleMs = Date.now() - lastProgressAt;
        if (!payloadLooksInProgress(payload) || staleMs > 1800) break;
      }

      await sleep(220);
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
      blocks: Array.isArray(payload.blocks) ? payload.blocks : [],
    };
  }

  async streamAssistantFromEvents(client, sessionId, startedAt, signal, handlers) {
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

    const joinPartText = (map) =>
      Array.from(map.values())
        .map((v) => String(v || ""))
        .filter((v) => v.length > 0)
        .join("\n\n");

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
        if (handlers && typeof handlers.onBlocks === "function") handlers.onBlocks(blocks);
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

    const eventStream = await client.event.subscribe(
      { directory: this.vaultPath },
      { signal, sseMaxRetryAttempts: 3 },
    );

    for await (const raw of eventStream.stream) {
      if (signal && signal.aborted) throw new Error("用户取消了请求");

      const root = raw && typeof raw === "object" ? raw : null;
      const event = root && root.payload && typeof root.payload === "object" ? root.payload : root;
      if (!event || typeof event.type !== "string") continue;

      if (event.type === "message.part.updated") {
        const props = event.properties && typeof event.properties === "object" ? event.properties : {};
        const part = props.part && typeof props.part === "object" ? props.part : null;
        if (!part || typeof part.sessionID !== "string" || part.sessionID !== sessionId) continue;
        if (part.time && Number(part.time.start || 0) > 0 && Number(part.time.start || 0) < startedAt - 1000) continue;
        if (!messageId) continue;
        if (typeof part.messageID !== "string" || part.messageID !== messageId) continue;

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
          continue;
        }

        if (part.type === "reasoning") {
          const current = reasoningByPart.get(partId) || "";
          const next = delta ? current + delta : typeof part.text === "string" ? part.text : current;
          reasoningByPart.set(partId, next);
          blockPartById.set(partId, Object.assign({}, part, { text: next }));
          updateReasoning();
          updateBlocks();
          continue;
        }

        blockPartById.set(partId, part);
        updateBlocks();
        continue;
      }

      if (event.type === "message.part.removed") {
        const props = event.properties && typeof event.properties === "object" ? event.properties : {};
        const sid = typeof props.sessionID === "string" ? props.sessionID : "";
        if (sid && sid !== sessionId) continue;
        const partId = typeof props.partID === "string" ? props.partID : "";
        if (!partId) continue;
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
        continue;
      }

      if (event.type === "message.updated") {
        const info = event.properties && event.properties.info && typeof event.properties.info === "object" ? event.properties.info : null;
        if (!info || info.sessionID !== sessionId) continue;
        if (info.role !== "assistant") continue;
        const created = info.time ? Number(info.time.created || 0) : 0;
        if (created > 0 && created < startedAt - 1000) continue;
        if (typeof info.id !== "string" || !info.id) continue;

        if (!messageId || created >= activeMessageCreatedAt) {
          if (messageId && messageId !== info.id) {
            resetActiveMessageContent();
          }
          messageId = info.id;
          activeMessageCreatedAt = created;
        }
        if (info.id !== messageId) continue;

        const err = extractErrorText(info.error);
        if (err) {
          meta = err;
          if (!text) {
            text = `模型返回错误：${err}`;
            if (handlers && typeof handlers.onToken === "function") handlers.onToken(text);
          }
        }

        if (info.time && Number(info.time.completed || 0) > 0) {
          const snapshot = { text, reasoning, meta, blocks };
          if (hasTerminalPayload(snapshot) && !payloadLooksInProgress(snapshot)) {
            done = true;
          }
        }
        if (done) break;
        continue;
      }

      if (event.type === "permission.asked") {
        const permission = event.properties && typeof event.properties === "object" ? event.properties : {};
        const permId = typeof permission.id === "string" ? permission.id : "";
        const permSession = typeof permission.sessionID === "string" ? permission.sessionID : "";
        if (!permId || (permSession && permSession !== sessionId)) continue;
        if (promptedPermissionIds.has(permId)) continue;
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
        continue;
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
        if (!requestId || (reqSession && reqSession !== sessionId)) continue;
        if (promptedQuestionIds.has(requestId)) continue;
        promptedQuestionIds.add(requestId);
        if (handlers && typeof handlers.onQuestionRequest === "function") {
          handlers.onQuestionRequest(request || {});
        }
        continue;
      }

      if (event.type === "question.replied" || event.type === "question.rejected") {
        const props = event.properties && typeof event.properties === "object" ? event.properties : {};
        const requestId = typeof props.requestID === "string" ? props.requestID : "";
        const reqSession = typeof props.sessionID === "string" ? props.sessionID : "";
        if (reqSession && reqSession !== sessionId) continue;
        if (handlers && typeof handlers.onQuestionResolved === "function") {
          handlers.onQuestionResolved({
            requestId,
            sessionId: reqSession || sessionId,
            rejected: event.type === "question.rejected",
            answers: Array.isArray(props.answers) ? props.answers : [],
          });
        }
        continue;
      }

      if (event.type === "tui.prompt.append") {
        const props = event.properties && typeof event.properties === "object" ? event.properties : {};
        const appendText = typeof props.text === "string" ? props.text : "";
        if (appendText && handlers && typeof handlers.onPromptAppend === "function") {
          handlers.onPromptAppend(appendText);
        }
        continue;
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
        continue;
      }

      if (event.type === "session.error") {
        const props = event.properties && typeof event.properties === "object" ? event.properties : {};
        if (props.sessionID && props.sessionID !== sessionId) continue;
        const err = extractErrorText(props.error);
        if (err) {
          meta = err;
          if (!text) {
            text = `模型返回错误：${err}`;
            if (handlers && typeof handlers.onToken === "function") handlers.onToken(text);
          }
        }
        done = true;
        break;
      }

      if (event.type === "session.idle") {
        const sid = event.properties && event.properties.sessionID;
        if (sid === sessionId) {
          done = true;
          break;
        }
        continue;
      }

      if (event.type === "session.status") {
        const sid = event.properties && event.properties.sessionID;
        const status = event.properties && event.properties.status && event.properties.status.type;
        if (sid === sessionId && status === "idle") {
          done = true;
          break;
        }
      }
    }

    return { messageId, text, reasoning, meta, blocks };
  }

  async sendMessage(options) {
    console.log("[opencode-assistant] sendMessage start", { sessionId: options.sessionId, transport: "sdk" });
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

    if (!finalized) {
      const status = await this.getSessionStatus(options.sessionId, options.signal);
      const statusText = formatSessionStatusText(status);
      finalized = {
        messageId: "",
        text: `(无文本返回：session.status=${statusText}。若长期为 busy，通常是权限或模型鉴权问题，请在 OpenCode 诊断中检查。)`,
        reasoning: "",
        meta: "",
        blocks: [],
      };
    }

    if (!usedRealStreaming && this.settings.enableStreaming) {
      if (finalized.reasoning && options.onReasoning) options.onReasoning(finalized.reasoning);
      if (options.onToken) options.onToken(finalized.text || "");
      if (Array.isArray(finalized.blocks) && finalized.blocks.length && options.onBlocks) {
        options.onBlocks(finalized.blocks);
      }
    }

    console.log("[opencode-assistant] sendMessage done", {
      sessionId: options.sessionId,
      transport: "sdk",
      hasText: Boolean(normalizedRenderableText(finalized.text || "")),
      textLen: String(finalized.text || "").length,
      normalizedTextLen: normalizedRenderableText(finalized.text || "").length,
      reasoningLen: String(finalized.reasoning || "").length,
      blockCount: Array.isArray(finalized.blocks) ? finalized.blocks.length : 0,
      messageId: finalized.messageId || "",
    });

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
