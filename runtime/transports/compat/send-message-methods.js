function createSendMessageMethods(deps = {}) {
  const {
    streamPseudo,
    createLinkedAbortController,
    extractErrorText,
    normalizedRenderableText,
    hasRenderablePayload,
    formatSessionStatusText,
    payloadLooksInProgress,
    extractAssistantPayloadFromEnvelope,
    sessionStatusLooksAuthFailure,
  } = deps;

  class SendMessageMethods {
  async sendMessage(options) {
    this.log(`sendMessage start ${JSON.stringify({
      sessionId: options.sessionId,
      transport: "compat",
      streaming: Boolean(this.settings.enableStreaming),
    })}`);
    await this.ensureAuth();
    const questionWatch = this.createQuestionWatch(options.sessionId, options.signal, {
      onQuestionRequest: options.onQuestionRequest,
      onQuestionResolved: options.onQuestionResolved,
    });
    try {
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

    let res = null;
    let streamed = null;
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
        this.log(`event stream unavailable: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });

      try {
        if (isCommandRequest) {
          res = await this.request(
            "POST",
            `/session/${encodeURIComponent(options.sessionId)}/command`,
            commandBody,
            { directory: this.vaultPath },
            options.signal,
          );
        } else {
          // Best practice: keep /message response as authoritative final assistant payload.
          res = await this.request(
            "POST",
            `/session/${encodeURIComponent(options.sessionId)}/message`,
            messageBody,
            { directory: this.vaultPath },
            options.signal,
          );
        }
      } finally {
        linked.detach();
        linked.controller.abort();
      }
      streamed = await eventStreamPromise;
    } else if (isCommandRequest) {
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

    const data = res && res.data ? res.data : res;
    let envelope = this.normalizeMessageEnvelope(data);
    if (!envelope) {
      const list = this.extractMessageList(data);
      const latest = this.findLatestAssistantMessage(list, startedAt);
      if (latest) envelope = latest;
    }

    let finalized = {
      messageId: "",
      text: "",
      reasoning: "",
      meta: "",
      blocks: [],
      completed: false,
    };
    if (envelope) {
      const payload = extractAssistantPayloadFromEnvelope(envelope);
      finalized = {
        messageId: envelope.info && envelope.info.id ? String(envelope.info.id) : "",
        text: String(payload && payload.text ? payload.text : ""),
        reasoning: String(payload && payload.reasoning ? payload.reasoning : ""),
        meta: String(payload && payload.meta ? payload.meta : ""),
        blocks: payload && Array.isArray(payload.blocks) ? payload.blocks : [],
        completed: this.isMessageEnvelopeCompleted(envelope),
      };
    }

    if (!hasRenderablePayload(finalized) && !isCommandRequest) {
      const recovered = await this.trySyncMessageRecovery(
        options.sessionId,
        messageBody,
        options.signal,
        finalized.messageId,
      );
      if (recovered && hasRenderablePayload(recovered)) {
        finalized = recovered;
      }
    }

    if (!hasRenderablePayload(finalized) && streamed && hasRenderablePayload(streamed)) {
      finalized = {
        messageId: String(streamed.messageId || finalized.messageId || ""),
        text: String(streamed.text || ""),
        reasoning: String(streamed.reasoning || ""),
        meta: String(streamed.meta || ""),
        blocks: Array.isArray(streamed.blocks) ? streamed.blocks : [],
        completed: Boolean(streamed.completed),
      };
    }

    if (!hasRenderablePayload(finalized)) {
      const status = await this.getSessionStatus(options.sessionId, options.signal);
      const statusText = formatSessionStatusText(status);
      const activeModel = String(this.settings && this.settings.defaultModel ? this.settings.defaultModel : "").trim();
      const modelText = activeModel ? `模型 ${activeModel}` : "当前模型";
      if (sessionStatusLooksAuthFailure(status)) {
        throw new Error(`${modelText} 鉴权失败（session.status=${statusText}）。请检查 Provider 登录或 API Key。`);
      }

      try {
        const fetched = await this.fetchSessionMessages(options.sessionId, {
          signal: options.signal,
          limit: 20,
          requireRecentTail: true,
        });
        const listPayload = Array.isArray(fetched.list) ? fetched.list : [];
        const latestErrorEnvelope = [...listPayload]
          .reverse()
          .find((item) => {
            const info = item && item.info && typeof item.info === "object" ? item.info : null;
            return Boolean(info && info.error);
          }) || null;
        if (latestErrorEnvelope) {
          const info = latestErrorEnvelope.info && typeof latestErrorEnvelope.info === "object"
            ? latestErrorEnvelope.info
            : {};
          const err = extractErrorText(info.error);
          if (err) {
            throw new Error(`模型返回错误：${err}`);
          }
        }
      } catch (error) {
        if (error instanceof Error && /^模型返回错误：/.test(error.message)) throw error;
        this.log(`no-renderable inspect failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      throw new Error(`${modelText} 未返回可用消息（session.status=${statusText}）。`);
    }

    if (payloadLooksInProgress(finalized)) {
      throw new Error("模型响应未完成且已超时，请切换模型或检查该 Provider 鉴权。");
    }
    if (!Boolean(finalized && finalized.completed)) {
      throw new Error("模型响应未收到明确完成信号（message.updated.completed/finish），已终止以避免截断。");
    }

    const messageId = finalized.messageId;
    const text = finalized.text || "";
    const reasoning = finalized.reasoning || "";
    const meta = finalized.meta || "";
    const blocks = Array.isArray(finalized.blocks) ? finalized.blocks : [];

    if (this.settings.enableStreaming) {
      // Always reconcile the UI with authoritative final response from /message or /command.
      if (options.onReasoning) options.onReasoning(reasoning);
      if (options.onToken) options.onToken(text);
      if (options.onBlocks) options.onBlocks(blocks);
    } else {
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
    } finally {
      await questionWatch.stop();
    }
  }

  }

  const methods = {};
  for (const key of Object.getOwnPropertyNames(SendMessageMethods.prototype)) {
    if (key === "constructor") continue;
    methods[key] = SendMessageMethods.prototype[key];
  }
  return methods;
}

module.exports = { createSendMessageMethods };
