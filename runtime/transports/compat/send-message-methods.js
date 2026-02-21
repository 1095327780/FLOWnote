function createSendMessageMethods(deps = {}) {
  const {
    streamPseudo,
    createLinkedAbortController,
    extractErrorText,
    normalizedRenderableText,
    hasRenderablePayload,
    formatSessionStatusText,
    payloadLooksInProgress,
    hasTerminalPayload,
    chooseRicherResponse,
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
      const streamWaitMs = Math.max(
        20000,
        Math.min(60000, Math.floor((Number(this.settings.requestTimeoutMs) || 120000) / 2)),
      );
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
      finalized = streamed || {
        messageId: "", text: "", reasoning: "", meta: "", blocks: [], completed: false,
      };
      const streamedMessageId = String(finalized && finalized.messageId ? finalized.messageId : "").trim();
      const streamedHasRenderable = hasRenderablePayload(finalized);
      if (!streamedMessageId && !streamedHasRenderable) {
        const status = await this.getSessionStatus(options.sessionId, options.signal);
        const statusText = formatSessionStatusText(status);
        const activeModel = String(this.settings && this.settings.defaultModel ? this.settings.defaultModel : "").trim();
        const modelText = activeModel ? `模型 ${activeModel}` : "当前模型";
        if (sessionStatusLooksAuthFailure(status)) {
          throw new Error(`${modelText} 鉴权失败（session.status=${statusText}）。请检查 Provider 登录或 API Key。`);
        }
        if (!isCommandRequest) {
          const recovered = await this.trySyncMessageRecovery(
            options.sessionId,
            messageBody,
            options.signal,
            streamedMessageId,
          );
          if (recovered && hasRenderablePayload(recovered)) {
            finalized = chooseRicherResponse(finalized, recovered);
          }
        }
        if (!hasRenderablePayload(finalized)) {
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
                finalized = chooseRicherResponse(finalized, {
                  messageId: info && info.id ? String(info.id) : streamedMessageId,
                  text: `模型返回错误：${err}`,
                  reasoning: "",
                  meta: err,
                  blocks: [],
                  completed: true,
                });
              }
            }
            const tail = listPayload
              .slice(-5)
              .map((item) => {
                const info = item && item.info && typeof item.info === "object" ? item.info : {};
                const role = String(info.role || info.type || "unknown");
                const id = String(info.id || "");
                const t = info.time && typeof info.time === "object" ? info.time : {};
                const created = Number(t.created || info.created || 0);
                const hasError = info && info.error ? ":error" : "";
                return `${role}:${id || "-"}:${created || 0}${hasError}`;
              })
              .join(", ");
            this.log(`no-renderable-after-async session=${options.sessionId} status=${statusText} messageCount=${listPayload.length} tail=[${tail}]`);
          } catch (error) {
            this.log(`no-renderable-after-async inspect failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (!hasRenderablePayload(finalized) && status && status.type === "idle") {
          throw new Error(`${modelText} 未返回可用消息（session.status=${statusText}）。请切换模型或检查登录配置。`);
        }
      }
      finalized = await this.reconcileAssistantResponseQuick(
        options.sessionId,
        finalized,
        startedAt,
        options.signal,
        streamedMessageId,
      );

      // Streaming is only the live channel; always reconcile with persisted server state once.
      try {
        const fetchedFinal = await this.finalizeAssistantResponse(
          options.sessionId,
          null,
          startedAt,
          options.signal,
          streamedMessageId,
        );
        const currentText = finalized && typeof finalized === "object" ? String(finalized.text || "") : "";
        const nextText = fetchedFinal && typeof fetchedFinal === "object" ? String(fetchedFinal.text || "") : "";
        const shouldKeepCurrent =
          hasRenderablePayload(finalized)
          && !this.isUnknownStatusFallbackText(currentText)
          && this.isUnknownStatusFallbackText(nextText);
        if (!shouldKeepCurrent) {
          finalized = chooseRicherResponse(finalized, fetchedFinal);
        }
      } catch (error) {
        let recovered = null;
        if (!isCommandRequest) {
          recovered = await this.trySyncMessageRecovery(
            options.sessionId,
            messageBody,
            options.signal,
            streamedMessageId,
          );
        }
        if (recovered && hasRenderablePayload(recovered) && !payloadLooksInProgress(recovered)) {
          finalized = chooseRicherResponse(finalized, recovered);
        } else {
          const canKeepStreamedResult =
            hasRenderablePayload(finalized)
            && hasTerminalPayload(finalized)
            && !payloadLooksInProgress(finalized);
          if (!canKeepStreamedResult) throw error;
          this.log(`finalize reconcile skipped, keep streamed result: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (!isCommandRequest && this.isUnknownStatusFallbackText(finalized && finalized.text)) {
        const recovered = await this.trySyncMessageRecovery(
          options.sessionId,
          messageBody,
          options.signal,
          streamedMessageId,
        );
        if (recovered && hasRenderablePayload(recovered)) {
          finalized = chooseRicherResponse(finalized, recovered);
        }
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
