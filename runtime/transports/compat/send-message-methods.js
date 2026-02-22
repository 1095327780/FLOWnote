function createSendMessageMethods(deps = {}) {
  const {
    streamPseudo,
    sleep,
    createLinkedAbortController,
    extractErrorText,
    normalizedRenderableText,
    hasRenderablePayload,
    formatSessionStatusText,
    payloadLooksInProgress,
    extractAssistantPayloadFromEnvelope,
    sessionStatusLooksAuthFailure,
  } = deps;

  function isRecoverableRequestError(error) {
    const message = error instanceof Error ? error.message : String(error || "");
    return /请求超时|timeout|timed out|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|connection reset/i.test(message);
  }

  function delayMs(ms) {
    const waitMs = Number.isFinite(Number(ms)) ? Math.max(0, Number(ms)) : 0;
    if (typeof sleep === "function") return sleep(waitMs);
    return new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  function normalizeTimestampMs(value) {
    const raw = Number(value || 0);
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    if (raw >= 1e14) return Math.floor(raw / 1000);
    if (raw >= 1e12) return Math.floor(raw);
    if (raw >= 1e9) return Math.floor(raw * 1000);
    return Math.floor(raw);
  }

  function summarizeEnvelope(envelope) {
    if (!envelope || typeof envelope !== "object") return null;
    const info = envelope.info && typeof envelope.info === "object" ? envelope.info : {};
    const parts = Array.isArray(envelope.parts) ? envelope.parts : [];
    const partTypes = parts
      .slice(0, 10)
      .map((part) => (part && typeof part === "object" && typeof part.type === "string" ? part.type : "unknown"));
    const time = info.time && typeof info.time === "object" ? info.time : {};
    return {
      id: typeof info.id === "string" ? info.id : "",
      role: typeof info.role === "string" ? info.role : "",
      parentID: typeof info.parentID === "string" ? info.parentID : "",
      createdAt: normalizeTimestampMs(time.created || info.created || 0),
      completedAt: normalizeTimestampMs(time.completed || 0),
      hasError: Boolean(info.error),
      partCount: parts.length,
      partTypes,
    };
  }

  function summarizePayload(payload) {
    if (!payload || typeof payload !== "object") return null;
    return {
      messageId: String(payload.messageId || ""),
      textLen: String(payload.text || "").length,
      reasoningLen: String(payload.reasoning || "").length,
      metaLen: String(payload.meta || "").length,
      blockCount: Array.isArray(payload.blocks) ? payload.blocks.length : 0,
      completed: Boolean(payload.completed),
      inProgress: payloadLooksInProgress(payload),
    };
  }

  function summarizeMessageList(list, startedAt) {
    const rows = Array.isArray(list) ? list : [];
    const normalizedStartedAt = Number(startedAt || 0);
    const mapped = rows.map((item) => {
      const info = item && item.info && typeof item.info === "object" ? item.info : {};
      const role = typeof info.role === "string" ? info.role : "";
      const id = typeof info.id === "string" ? info.id : "";
      const parentID = typeof info.parentID === "string" ? info.parentID : "";
      const time = info.time && typeof info.time === "object" ? info.time : {};
      const createdAt = normalizeTimestampMs(time.created || info.created || 0);
      const hasError = Boolean(info.error);
      const parts = Array.isArray(item && item.parts) ? item.parts : [];
      const partTypes = parts
        .slice(0, 5)
        .map((part) => (part && typeof part === "object" && typeof part.type === "string" ? part.type : "unknown"));
      return { role, id, parentID, createdAt, hasError, partCount: parts.length, partTypes };
    });

    const latestAssistant = mapped
      .filter((row) => row.role === "assistant")
      .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
    const latestAssistantAfterStartedAt = mapped
      .filter((row) => row.role === "assistant")
      .filter((row) => !normalizedStartedAt || !row.createdAt || row.createdAt >= normalizedStartedAt - 1000)
      .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
    const latestUser = mapped
      .filter((row) => row.role === "user")
      .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
    const tail = mapped.slice(Math.max(0, mapped.length - 6));

    return {
      total: mapped.length,
      latestAssistant,
      latestAssistantAfterStartedAt,
      latestUser,
      tail,
    };
  }

  function safeJson(value) {
    try {
      return JSON.stringify(value);
    } catch (error) {
      return JSON.stringify({
        error: `json-stringify-failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  function buildNoRenderableDiagHint(diag) {
    const d = diag && typeof diag === "object" ? diag : null;
    if (!d) return "";
    const total = Number.isFinite(Number(d.total)) ? Number(d.total) : 0;
    const latestAssistantId = String(d.latestAssistantId || "").trim() || "-";
    const latestAssistantAfterStartedAtId = String(d.latestAssistantAfterStartedAtId || "").trim() || "-";
    const latestUserId = String(d.latestUserId || "").trim() || "-";
    return `diag(total=${total},latestAssistant=${latestAssistantId},latestAssistantAfterStart=${latestAssistantAfterStartedAtId},latestUser=${latestUserId})`;
  }

  function extractSessionId(candidate) {
    const payload = candidate && typeof candidate === "object" ? candidate : null;
    if (!payload) return "";
    const direct = String(payload.id || payload.sessionID || payload.sessionId || "").trim();
    if (direct) return direct;
    const nestedCandidates = [payload.session, payload.data, payload.result, payload.payload, payload.item];
    for (const nested of nestedCandidates) {
      if (!nested || typeof nested !== "object") continue;
      const nestedId = String(nested.id || nested.sessionID || nested.sessionId || "").trim();
      if (nestedId) return nestedId;
    }
    return "";
  }

  class SendMessageMethods {
  async sendMessage(options) {
    const requestedSessionId = String(options && options.sessionId ? options.sessionId : "").trim();
    const sessionId = this.resolveSessionAlias(requestedSessionId) || requestedSessionId;
    if (!sessionId) throw new Error("sessionId 不能为空");
    this.log(`sendMessage start ${JSON.stringify({
      sessionId,
      requestedSessionId: requestedSessionId && requestedSessionId !== sessionId ? requestedSessionId : "",
      transport: "compat",
      streaming: Boolean(this.settings.enableStreaming),
    })}`);
    const deliveredQuestionIds = new Set();
    let waitingForQuestion = false;
    let isCommandRequest = false;
    const handleQuestionRequest = (request) => {
      const requestId = String(
        (request && (request.id || request.requestID || request.requestId)) || "",
      ).trim();
      if (requestId && deliveredQuestionIds.has(requestId)) return;
      if (requestId) deliveredQuestionIds.add(requestId);
      waitingForQuestion = deliveredQuestionIds.size > 0;
      if (typeof options.onQuestionRequest === "function") {
        options.onQuestionRequest(request);
      }
    };
    const handleQuestionResolved = (info) => {
      const requestId = String((info && info.requestId) || "").trim();
      if (requestId) deliveredQuestionIds.delete(requestId);
      waitingForQuestion = deliveredQuestionIds.size > 0;
      if (typeof options.onQuestionResolved === "function") {
        options.onQuestionResolved(info);
      }
    };
    const checkWaitingForQuestion = async () => {
      if (deliveredQuestionIds.size > 0) {
        waitingForQuestion = true;
        return true;
      }
      if (isCommandRequest) return false;
      if (waitingForQuestion) {
        waitingForQuestion = await this.hasPendingQuestionsForSession(sessionId, options.signal);
        return waitingForQuestion;
      }
      waitingForQuestion = await this.hasPendingQuestionsForSession(sessionId, options.signal);
      return waitingForQuestion;
    };

    const questionWatch = this.createQuestionWatch(sessionId, options.signal, {
      onQuestionRequest: handleQuestionRequest,
      onQuestionResolved: handleQuestionResolved,
    });
    const emitNoRenderableDiag = (label, payload) => {
      const line = `${label} ${safeJson(payload)}`;
      this.log(line);
      try {
        if (typeof console !== "undefined" && typeof console.error === "function") {
          console.error("[FLOWnote]", line);
        }
      } catch {
      }
    };
    try {
      const startedAt = Date.now();
      const sessionQuery = this.buildSessionDirectoryQuery(sessionId);

    const model = this.parseModel();
    const commandModel = this.parseCommandModel();
    const parsedCommand = this.parseSlashCommand(options.prompt);
    const resolvedCommand = parsedCommand ? await this.resolveCommandForEndpoint(parsedCommand.command) : { use: false, command: "" };
    isCommandRequest = Boolean(parsedCommand && resolvedCommand.use);
    if (isCommandRequest) {
      this.log(`compat command route ${JSON.stringify({
        sessionId,
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
      let eventStreamStopRequested = false;
      let requestError = null;
      const streamHandlers = {
        onToken: options.onToken,
        onReasoning: options.onReasoning,
        onBlocks: options.onBlocks,
        onPermissionRequest: options.onPermissionRequest,
        onQuestionRequest: handleQuestionRequest,
        onQuestionResolved: handleQuestionResolved,
        onPromptAppend: options.onPromptAppend,
        onToast: options.onToast,
      };
      const eventStreamPromise = this.streamAssistantFromEvents(sessionId, startedAt, eventSignal, streamHandlers)
        .catch(async (e) => {
          const message = e instanceof Error ? e.message : String(e);
          if (options.signal && options.signal.aborted) {
            this.log(`event stream aborted by user: ${message}`);
            return null;
          }
          if (
            eventStreamStopRequested
            && /用户取消了请求|aborted|abort|cancelled|canceled/i.test(message)
          ) {
            this.log(`event stream closed after request completion: ${message}`);
            return null;
          }
          this.log(`event stream unavailable: ${message}; fallback to polling stream`);
          try {
            return await this.streamAssistantFromPolling(
              sessionId,
              startedAt,
              options.signal,
              streamHandlers,
              {
                quickFallback: true,
                noMessageTimeoutMs: 1800,
                quietTimeoutMs: 5000,
                maxTotalMs: 8000,
                latestIntervalMs: 700,
                allowQuestionPending: false,
              },
            );
          } catch (pollError) {
            this.log(`polling stream fallback failed: ${pollError instanceof Error ? pollError.message : String(pollError)}`);
            return null;
          }
        });

      try {
        if (isCommandRequest) {
          res = await this.request(
            "POST",
            `/session/${encodeURIComponent(sessionId)}/command`,
            commandBody,
            sessionQuery,
            options.signal,
          );
        } else {
          // Best practice: keep /message response as authoritative final assistant payload.
          res = await this.request(
            "POST",
            `/session/${encodeURIComponent(sessionId)}/message`,
            messageBody,
            sessionQuery,
            options.signal,
          );
        }
      } catch (error) {
        requestError = error;
      } finally {
        linked.detach();
        eventStreamStopRequested = true;
        linked.controller.abort();
      }
      streamed = await eventStreamPromise;

      if (requestError) {
        const canRecoverFromStream = Boolean(
          streamed
          && hasRenderablePayload(streamed)
          && !payloadLooksInProgress(streamed)
          && Boolean(streamed.completed),
        );
        if (!(isRecoverableRequestError(requestError) && canRecoverFromStream)) {
          throw requestError;
        }
        this.log(`request failed but recovered from stream payload: ${requestError instanceof Error ? requestError.message : String(requestError)}`);
      }
    } else if (isCommandRequest) {
      res = await this.request(
        "POST",
        `/session/${encodeURIComponent(sessionId)}/command`,
        commandBody,
        sessionQuery,
        options.signal,
      );
    } else {
      res = await this.request(
        "POST",
        `/session/${encodeURIComponent(sessionId)}/message`,
        messageBody,
        sessionQuery,
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
        sessionId,
        messageBody,
        options.signal,
        finalized.messageId,
      );
      if (recovered && hasRenderablePayload(recovered)) {
        finalized = recovered;
      }
    }

    if (!hasRenderablePayload(finalized) && !isCommandRequest) {
      const reconciled = await this.reconcileAssistantResponseQuick(
        sessionId,
        finalized,
        startedAt,
        options.signal,
        finalized.messageId,
      );
      if (reconciled && hasRenderablePayload(reconciled)) {
        finalized = reconciled;
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

    if (!hasRenderablePayload(finalized) && !isCommandRequest) {
      for (let attempt = 0; attempt < 4 && !hasRenderablePayload(finalized); attempt += 1) {
        if (await checkWaitingForQuestion()) break;
        const reconciled = await this.reconcileAssistantResponseQuick(
          sessionId,
          finalized,
          startedAt,
          options.signal,
          finalized.messageId,
        );
        if (reconciled && hasRenderablePayload(reconciled)) {
          finalized = reconciled;
          break;
        }
        if (attempt < 3) await delayMs(220);
      }
    }

    if (!hasRenderablePayload(finalized)) {
      if (await checkWaitingForQuestion()) {
        const hint = "等待问题回答后继续生成。";
        finalized = {
          messageId: String(finalized.messageId || ""),
          text: hint,
          reasoning: "",
          meta: hint,
          blocks: [],
          completed: false,
        };
      } else {
      const status = await this.getSessionStatus(sessionId, options.signal);
      const statusText = formatSessionStatusText(status);
      const activeModel = String(this.settings && this.settings.defaultModel ? this.settings.defaultModel : "").trim();
      const modelText = activeModel ? `模型 ${activeModel}` : "当前模型";
      let noRenderableDiagHint = "";
      let noRenderableListSummary = null;
      emitNoRenderableDiag("no-renderable snapshot", {
        sessionId,
        startedAt,
        elapsedMs: Math.max(0, Date.now() - Number(startedAt || Date.now())),
        statusText,
        statusRaw: status && typeof status === "object" ? status : null,
        envelope: summarizeEnvelope(envelope),
        finalized: summarizePayload(finalized),
        streamed: summarizePayload(streamed),
      });
      if (sessionStatusLooksAuthFailure(status)) {
        throw new Error(`${modelText} 鉴权失败（session.status=${statusText}）。请检查 Provider 登录或 API Key。`);
      }

      try {
        const fetched = await this.fetchSessionMessages(sessionId, {
          signal: options.signal,
          limit: 20,
          requireRecentTail: true,
        });
        const listPayload = Array.isArray(fetched.list) ? fetched.list : [];
        const listSummary = summarizeMessageList(listPayload, startedAt);
        noRenderableListSummary = listSummary;
        noRenderableDiagHint = buildNoRenderableDiagHint({
          total: listSummary.total,
          latestAssistantId: listSummary.latestAssistant && listSummary.latestAssistant.id,
          latestAssistantAfterStartedAtId:
            listSummary.latestAssistantAfterStartedAt && listSummary.latestAssistantAfterStartedAt.id,
          latestUserId: listSummary.latestUser && listSummary.latestUser.id,
        });
        emitNoRenderableDiag(
          "no-renderable message-list",
          listSummary,
        );
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

      const shouldRetryWithFreshSession = Boolean(
        !isCommandRequest
        && !Boolean(options && options._retryFreshSessionAttempted),
      );
      if (shouldRetryWithFreshSession) {
        this.log(`no-renderable retry decision ${JSON.stringify({
          sessionId,
          statusText,
          total: noRenderableListSummary ? Number(noRenderableListSummary.total || 0) : null,
          strategy: "recreate-session-once",
        })}`);
        try {
          const replacement = await this.createSession("");
          const newSessionIdRaw = extractSessionId(replacement);
          const newSessionId = this.resolveSessionAlias(newSessionIdRaw) || newSessionIdRaw;
          if (newSessionId && newSessionId !== sessionId) {
            this.rememberSessionAlias(requestedSessionId || sessionId, newSessionId, "idle-empty-recreate");
            this.rememberSessionAlias(sessionId, newSessionId, "idle-empty-recreate");
            this.log(`session auto-recreated after idle-empty ${JSON.stringify({
              fromSessionId: sessionId,
              toSessionId: newSessionId,
              replacementRawId: newSessionIdRaw,
            })}`);
            return this.sendMessage({
              ...options,
              sessionId: newSessionId,
              _retryFreshSessionAttempted: true,
            });
          }
          this.log(`session auto-recreate skipped: invalid replacement id ${JSON.stringify({
            fromSessionId: sessionId,
            replacement,
          })}`);
        } catch (retryError) {
          this.log(`session auto-recreate failed: ${retryError instanceof Error ? retryError.message : String(retryError)}`);
        }
      }

      if (noRenderableDiagHint) {
        throw new Error(`${modelText} 未返回可用消息（session.status=${statusText}; ${noRenderableDiagHint}）。`);
      }
      throw new Error(`${modelText} 未返回可用消息（session.status=${statusText}）。`);
      }
    }

    const explicitModelErrorText = String(finalized && finalized.text ? finalized.text : "").trim();
    if (/^模型返回错误：/.test(explicitModelErrorText)) {
      throw new Error(explicitModelErrorText);
    }

    if (payloadLooksInProgress(finalized)) {
      if (!(await checkWaitingForQuestion())) {
        throw new Error("模型响应未完成且已超时，请切换模型或检查该 Provider 鉴权。");
      }
    }
    if (!Boolean(finalized && finalized.completed)) {
      if (!(await checkWaitingForQuestion())) {
        throw new Error("模型响应未收到明确完成信号（message.updated.completed/finish），已终止以避免截断。");
      }
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
        sessionId,
        requestedSessionId: requestedSessionId && requestedSessionId !== sessionId ? requestedSessionId : "",
        hasText: Boolean(normalizedRenderableText(text)),
        textLen: text ? text.length : 0,
        normalizedTextLen: normalizedRenderableText(text).length,
        reasoningLen: reasoning ? reasoning.length : 0,
        blockCount: blocks.length,
        messageId,
      })}`);
      return { messageId, text, reasoning, meta, blocks, sessionId };
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
