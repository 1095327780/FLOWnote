const {
  isAssistantMessageEnvelopeCompleted,
} = require("../shared/completion-signals");

function createResponseRecoveryMethods(deps = {}) {
  const {
    URL,
    sleep,
    createLinkedAbortController,
    nodeHttpRequestSse,
    createTransportEventReducer,
    pollAssistantPayload,
    ensureRenderablePayload,
    extractAssistantPayloadFromEnvelope,
    extractErrorText,
    normalizedRenderableText,
    hasRenderablePayload,
    formatSessionStatusText,
    isIntermediateToolCallPayload,
    payloadLooksInProgress,
    hasTerminalPayload,
    chooseRicherResponse,
  } = deps;

  function normalizeTimestampMs(value) {
    const raw = Number(value || 0);
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    if (raw >= 1e14) return Math.floor(raw / 1000);
    if (raw >= 1e12) return Math.floor(raw);
    if (raw >= 1e9) return Math.floor(raw * 1000);
    return Math.floor(raw);
  }

  function envelopeInfo(item) {
    if (!item || typeof item !== "object") return null;
    return item.info && typeof item.info === "object" ? item.info : null;
  }

  function envelopeRole(item) {
    const info = envelopeInfo(item);
    if (!info) return "";
    return typeof info.role === "string" ? info.role.trim().toLowerCase() : "";
  }

  function envelopeCreatedAtMs(item) {
    const info = envelopeInfo(item);
    if (!info) return 0;
    const time = info.time && typeof info.time === "object" ? info.time : {};
    return normalizeTimestampMs(time.created || time.updated || info.created || info.updated || 0);
  }

  function findLatestUserAnchor(messages) {
    const list = Array.isArray(messages) ? messages : [];
    let latest = null;
    let latestCreated = 0;
    for (const item of list) {
      if (envelopeRole(item) !== "user") continue;
      const info = envelopeInfo(item);
      if (!info || typeof info.id !== "string" || !info.id.trim()) continue;
      const created = envelopeCreatedAtMs(item);
      if (!latest || created >= latestCreated) {
        latest = item;
        latestCreated = created;
      }
    }
    return latest;
  }

  function findLatestAssistantAnchoredByUser(messages, userAnchor) {
    const list = Array.isArray(messages) ? messages : [];
    const anchorInfo = envelopeInfo(userAnchor);
    const anchorId = anchorInfo && typeof anchorInfo.id === "string" ? anchorInfo.id.trim() : "";
    const anchorCreated = envelopeCreatedAtMs(userAnchor);
    if (!anchorId && !anchorCreated) return null;

    const assistants = list
      .filter((item) => envelopeRole(item) === "assistant")
      .sort((a, b) => envelopeCreatedAtMs(b) - envelopeCreatedAtMs(a));

    const byParent = assistants.find((item) => {
      const info = envelopeInfo(item);
      const parentId = info && typeof info.parentID === "string" ? info.parentID.trim() : "";
      return Boolean(anchorId && parentId && parentId === anchorId);
    });
    if (byParent) return byParent;

    if (!anchorCreated) return null;
    return assistants.find((item) => {
      const created = envelopeCreatedAtMs(item);
      return Boolean(created && created >= anchorCreated);
    }) || null;
  }

  class ResponseRecoveryMethods {
  isMessageEnvelopeCompleted(envelope) {
    return isAssistantMessageEnvelopeCompleted(envelope);
  }

  async finalizeAssistantResponse(sessionId, responsePayload, startedAt, signal, preferredMessageId = "") {
    const data = responsePayload && responsePayload.data ? responsePayload.data : responsePayload;
    const initialMessageId = preferredMessageId || (data && data.info ? data.info.id : "");
    const initialPayload = extractAssistantPayloadFromEnvelope(data);
    const timeoutCfg = this.getFinalizeTimeoutConfig();
    const quietTimeoutMs = timeoutCfg.quietTimeoutMs;
    const messageListFetchState = this.createMessageListFetchState();

    const polled = await pollAssistantPayload({
      initialMessageId,
      initialPayload,
      signal,
      quietTimeoutMs,
      maxTotalMs: timeoutCfg.maxTotalMs,
      latestIntervalMs: 1100,
      sleep,
      getByMessageId: async (messageId, requestSignal) => {
        const msgRes = await this.request(
          "GET",
          `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`,
          undefined,
          this.buildSessionDirectoryQuery(sessionId),
          requestSignal,
        );
        const messagePayload = this.normalizeMessageEnvelope(msgRes && msgRes.data ? msgRes.data : msgRes);
        const role =
          messagePayload && messagePayload.info && typeof messagePayload.info.role === "string"
            ? messagePayload.info.role
            : "";
        if (role && role !== "assistant") {
          return { payload: null, completed: false, messageId: "" };
        }
        return {
          payload: messagePayload ? extractAssistantPayloadFromEnvelope(messagePayload) : null,
          completed: this.isMessageEnvelopeCompleted(messagePayload),
          messageId,
        };
      },
      getLatest: async (requestSignal) => {
        const fetched = await this.fetchSessionMessages(sessionId, {
          signal: requestSignal,
          limit: 50,
          startedAt,
          state: messageListFetchState,
        });
        const latest = fetched.latest || this.findLatestAssistantMessage(fetched.list, startedAt);
        if (!latest) return null;
        const createdAt =
          latest && latest.info && latest.info.time
            ? Number(latest.info.time.created || 0)
            : 0;
        return {
          payload: extractAssistantPayloadFromEnvelope(latest),
          completed: this.isMessageEnvelopeCompleted(latest),
          messageId: latest && latest.info ? latest.info.id : "",
          createdAt,
        };
      },
      getSessionStatus: (requestSignal) => this.getSessionStatus(sessionId, requestSignal),
      isQuestionPending: (requestSignal) => {
        if (typeof this.hasPendingQuestionsForSession !== "function") return false;
        return this.hasPendingQuestionsForSession(sessionId, requestSignal);
      },
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
      completed: Boolean(polled.completed),
    };
  }

  async streamAssistantFromPolling(sessionId, startedAt, signal, handlers, options = {}) {
    const timeoutCfg = this.getFinalizeTimeoutConfig();
    const pollOptions = options && typeof options === "object" ? options : {};
    const quickFallback = Boolean(pollOptions.quickFallback);
    const quietTimeoutMs = Number.isFinite(Number(pollOptions.quietTimeoutMs)) && Number(pollOptions.quietTimeoutMs) > 0
      ? Number(pollOptions.quietTimeoutMs)
      : quickFallback
        ? Math.min(timeoutCfg.quietTimeoutMs, 5000)
        : timeoutCfg.quietTimeoutMs;
    const maxTotalMs = Number.isFinite(Number(pollOptions.maxTotalMs)) && Number(pollOptions.maxTotalMs) > 0
      ? Number(pollOptions.maxTotalMs)
      : quickFallback
        ? Math.min(timeoutCfg.maxTotalMs, 8000)
        : timeoutCfg.maxTotalMs;
    const latestIntervalMs = Number.isFinite(Number(pollOptions.latestIntervalMs)) && Number(pollOptions.latestIntervalMs) > 0
      ? Number(pollOptions.latestIntervalMs)
      : quickFallback
        ? 700
        : 1100;
    const noMessageTimeoutMs = Number.isFinite(Number(pollOptions.noMessageTimeoutMs))
      && Number(pollOptions.noMessageTimeoutMs) > 0
      ? Number(pollOptions.noMessageTimeoutMs)
      : undefined;
    const allowQuestionPending = pollOptions.allowQuestionPending !== false;
    const messageListFetchState = this.createMessageListFetchState();
    const polled = await pollAssistantPayload({
      signal,
      quietTimeoutMs,
      maxTotalMs,
      latestIntervalMs,
      noMessageTimeoutMs,
      sleep,
      requireTerminal: false,
      onToken: handlers && handlers.onToken,
      onReasoning: handlers && handlers.onReasoning,
      onBlocks: handlers && handlers.onBlocks,
      getByMessageId: async (messageId, requestSignal) => {
        const msgRes = await this.request(
          "GET",
          `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`,
          undefined,
          this.buildSessionDirectoryQuery(sessionId),
          requestSignal,
        );
        const messagePayload = this.normalizeMessageEnvelope(msgRes && msgRes.data ? msgRes.data : msgRes);
        const role =
          messagePayload && messagePayload.info && typeof messagePayload.info.role === "string"
            ? messagePayload.info.role
            : "";
        if (role && role !== "assistant") {
          return { payload: null, completed: false, messageId: "" };
        }
        return {
          payload: messagePayload ? extractAssistantPayloadFromEnvelope(messagePayload) : null,
          completed: this.isMessageEnvelopeCompleted(messagePayload),
          messageId,
        };
      },
      getLatest: async (requestSignal) => {
        const fetched = await this.fetchSessionMessages(sessionId, {
          signal: requestSignal,
          limit: 50,
          startedAt,
          state: messageListFetchState,
        });
        const latest = fetched.latest || this.findLatestAssistantMessage(fetched.list, startedAt);
        if (!latest) return null;
        const createdAt = latest && latest.info && latest.info.time ? Number(latest.info.time.created || 0) : 0;
        return {
          payload: extractAssistantPayloadFromEnvelope(latest),
          completed: this.isMessageEnvelopeCompleted(latest),
          messageId: latest && latest.info ? latest.info.id : "",
          createdAt,
        };
      },
      getSessionStatus: (requestSignal) => this.getSessionStatus(sessionId, requestSignal),
      isQuestionPending: allowQuestionPending
        ? (requestSignal) => {
          if (typeof this.hasPendingQuestionsForSession !== "function") return false;
          return this.hasPendingQuestionsForSession(sessionId, requestSignal);
        }
        : undefined,
    });

    return {
      messageId: polled.messageId || "",
      text: polled.payload && polled.payload.text ? polled.payload.text : "",
      reasoning: polled.payload && polled.payload.reasoning ? polled.payload.reasoning : "",
      meta: polled.payload && polled.payload.meta ? polled.payload.meta : "",
      blocks: polled.payload && Array.isArray(polled.payload.blocks) ? polled.payload.blocks : [],
      completed: Boolean(polled.completed),
    };
  }

  async streamAssistantFromEvents(sessionId, startedAt, signal, handlers) {
    const baseUrl = await this.ensureStarted();
    const sessionDirectory = this.getSessionScopedDirectory(sessionId);
    const expectedDirectory = this.normalizeDirectoryForService(sessionDirectory) || sessionDirectory;
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

    const eventCandidates = this.buildEventStreamUrlCandidates(baseUrl, expectedDirectory);
    let lastError = null;

    for (const candidate of eventCandidates) {
      try {
        await nodeHttpRequestSse(
          candidate.url,
          Math.max(3000, Number(this.settings.requestTimeoutMs) || 120000),
          signal,
          {
            onEvent: (raw) => {
              const root = raw && typeof raw === "object" ? raw : null;
              if (root && typeof root.directory === "string" && root.directory) {
                const eventDir = String(root.directory || "").trim();
                const originDir = String(sessionDirectory || "").trim();
                if (eventDir !== expectedDirectory && eventDir !== originDir) return;
              }

              const event = root && root.payload && typeof root.payload === "object" ? root.payload : root;
              if (!event || typeof event !== "object") return;
              reducer.consume(event);
            },
            shouldStop: () => reducer.isDone(),
          },
          { trace: (line) => this.log(line) },
        );
        return reducer.snapshot();
      } catch (error) {
        if (signal && signal.aborted) throw error;
        lastError = error;
        this.log(
          `event stream endpoint failed (${candidate.path}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (lastError) throw lastError;
    throw new Error("OpenCode 事件流连接失败");
  }

  buildEventStreamUrlCandidates(baseUrl, directory) {
    const paths = ["/event", "/global/event"];
    const seen = new Set();
    const output = [];
    for (const endpointPath of paths) {
      const url = new URL(baseUrl + endpointPath);
      if (directory) url.searchParams.set("directory", directory);
      const normalized = url.toString();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      output.push({ path: endpointPath, url: normalized });
    }
    return output;
  }

  createQuestionWatch(sessionId, signal, handlers) {
    const onQuestionRequest = handlers && typeof handlers.onQuestionRequest === "function"
      ? handlers.onQuestionRequest
      : null;
    const onQuestionResolved = handlers && typeof handlers.onQuestionResolved === "function"
      ? handlers.onQuestionResolved
      : null;
    if (!onQuestionRequest && !onQuestionResolved) {
      return {
        stop: async () => {},
      };
    }

    const linked = createLinkedAbortController(signal);
    const watcherPromise = this.watchPendingQuestions(sessionId, linked.controller.signal, {
      onQuestionRequest,
      onQuestionResolved,
    }).catch((error) => {
      if (linked.controller.signal.aborted) return;
      this.log(`question watcher failed: ${error instanceof Error ? error.message : String(error)}`);
    });

    return {
      stop: async () => {
        linked.detach();
        linked.controller.abort();
        await watcherPromise;
      },
    };
  }

  async watchPendingQuestions(sessionId, signal, handlers = {}) {
    const onQuestionRequest = typeof handlers.onQuestionRequest === "function" ? handlers.onQuestionRequest : null;
    const onQuestionResolved = typeof handlers.onQuestionResolved === "function" ? handlers.onQuestionResolved : null;
    if (!onQuestionRequest && !onQuestionResolved) return;

    const seenByRequestId = new Map();
    let endpointUnavailable = false;

    while (!(signal && signal.aborted)) {
      let listed = [];
      try {
        listed = await this.listQuestions({
          signal,
          sessionId,
          allowDirectoryFallback: false,
        });
      } catch (error) {
        if (signal && signal.aborted) break;
        const message = error instanceof Error ? error.message : String(error);
        if (/\b404\b|not found|unknown endpoint|\/question/i.test(message)) {
          if (!endpointUnavailable) {
            endpointUnavailable = true;
            this.log(`question watcher disabled: ${message}`);
          }
          break;
        }
        this.log(`question watcher poll failed: ${message}`);
        await sleep(1000);
        continue;
      }

      const activeByRequestId = new Map();
      for (const item of Array.isArray(listed) ? listed : []) {
        if (!item || typeof item !== "object") continue;
        const requestId = String(item.id || item.requestID || item.requestId || "").trim();
        if (!requestId) continue;
        const reqSession = String(item.sessionID || item.sessionId || "").trim();
        if (reqSession && reqSession !== sessionId) continue;
        activeByRequestId.set(requestId, item);
      }

      for (const [requestId, request] of activeByRequestId.entries()) {
        if (!seenByRequestId.has(requestId) && onQuestionRequest) {
          onQuestionRequest(request);
        }
      }

      if (onQuestionResolved) {
        for (const requestId of seenByRequestId.keys()) {
          if (activeByRequestId.has(requestId)) continue;
          onQuestionResolved({
            requestId,
            sessionId,
            answers: [],
            rejected: false,
          });
        }
      }

      seenByRequestId.clear();
      for (const [requestId, request] of activeByRequestId.entries()) {
        seenByRequestId.set(requestId, request);
      }

      await sleep(1600);
    }
  }

  isUnknownStatusFallbackText(text) {
    const value = String(text || "").trim();
    if (!value) return false;
    return /^\(无文本返回：session\.status=/i.test(value);
  }

  async trySyncMessageRecovery(sessionId, messageBody, signal, streamedMessageId = "") {
    const body = messageBody && typeof messageBody === "object" ? { ...messageBody } : null;
    if (!body || !Array.isArray(body.parts) || !body.parts.length) return null;
    const messageListFetchState = this.createMessageListFetchState();

    const placeholderId = String(streamedMessageId || "").trim();
    let parentMessageId = "";

    if (placeholderId) {
      try {
        const placeholderRes = await this.request(
          "GET",
          `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(placeholderId)}`,
          undefined,
          this.buildSessionDirectoryQuery(sessionId),
          signal,
        );
        const placeholder = this.normalizeMessageEnvelope(
          placeholderRes && placeholderRes.data ? placeholderRes.data : placeholderRes,
        );
        const info = placeholder && placeholder.info && typeof placeholder.info === "object" ? placeholder.info : null;
        if (info && info.role === "assistant" && typeof info.parentID === "string" && info.parentID.trim()) {
          parentMessageId = info.parentID.trim();
        }
      } catch (error) {
        this.log(`sync recovery inspect failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (parentMessageId && !body.messageID) {
      body.messageID = parentMessageId;
    }

    if (!body.messageID) {
      try {
        const fetched = await this.fetchSessionMessages(sessionId, {
          signal,
          limit: 50,
          requireRecentTail: true,
          state: messageListFetchState,
        });
        const listPayload = Array.isArray(fetched.list) ? fetched.list : [];
        let latestUser = null;
        let latestUserCreated = 0;
        for (const item of listPayload) {
          if (!item || typeof item !== "object") continue;
          const info = item.info && typeof item.info === "object" ? item.info : null;
          if (!info || info.role !== "user" || typeof info.id !== "string" || !info.id.trim()) continue;
          const time = info.time && typeof info.time === "object" ? info.time : {};
          const created = Number(time.created || info.created || info.updated || 0);
          if (created >= latestUserCreated) {
            latestUserCreated = created;
            latestUser = info.id.trim();
          }
        }
        if (latestUser) {
          body.messageID = latestUser;
        }
      } catch (error) {
        this.log(`sync recovery user-anchor failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const pickAssistantEnvelope = (items, anchorMessageId = "") => {
      const list = Array.isArray(items) ? items : [];
      if (!list.length) return null;
      const anchor = String(anchorMessageId || "").trim();
      if (anchor) {
        const anchored = list
          .filter((row) => {
            const info = row && row.info && typeof row.info === "object" ? row.info : null;
            return Boolean(
              info
              && typeof info.parentID === "string"
              && info.parentID.trim()
              && info.parentID.trim() === anchor,
            );
          })
          .sort((a, b) => {
            const ai = a && a.info && typeof a.info === "object" ? a.info : {};
            const bi = b && b.info && typeof b.info === "object" ? b.info : {};
            const at = Number((ai.time && ai.time.created) || ai.created || 0);
            const bt = Number((bi.time && bi.time.created) || bi.created || 0);
            return bt - at;
          });
        if (anchored.length) return anchored[0];
      }
      return this.findLatestAssistantMessage(list, 0);
    };

    try {
      const syncRes = await this.request(
        "POST",
        `/session/${encodeURIComponent(sessionId)}/message`,
        body,
        this.buildSessionDirectoryQuery(sessionId),
        signal,
      );
      const raw = syncRes && syncRes.data ? syncRes.data : syncRes;

      const direct = this.normalizeMessageEnvelope(raw);
      if (
        direct
        && direct.info
        && typeof direct.info === "object"
        && (direct.info.role === "assistant" || direct.info.type === "assistant" || direct.info.error)
      ) {
        const payload = extractAssistantPayloadFromEnvelope(direct);
        return {
          messageId: direct.info && direct.info.id ? String(direct.info.id) : placeholderId,
          text: String(payload.text || ""),
          reasoning: String(payload.reasoning || ""),
          meta: String(payload.meta || ""),
          blocks: Array.isArray(payload.blocks) ? payload.blocks : [],
          completed: true,
        };
      }

      const fromResponseList = pickAssistantEnvelope(this.extractMessageList(raw), body.messageID);
      if (fromResponseList) {
        const payload = extractAssistantPayloadFromEnvelope(fromResponseList);
        return {
          messageId: fromResponseList.info && fromResponseList.info.id
            ? String(fromResponseList.info.id)
            : placeholderId,
          text: String(payload.text || ""),
          reasoning: String(payload.reasoning || ""),
          meta: String(payload.meta || ""),
          blocks: Array.isArray(payload.blocks) ? payload.blocks : [],
          completed: true,
        };
      }

      for (let i = 0; i < 6; i += 1) {
        if (signal && signal.aborted) break;
        await sleep(220);
        const fetched = await this.fetchSessionMessages(sessionId, {
          signal,
          limit: 50,
          requireRecentTail: true,
          state: messageListFetchState,
        });
        const listPayload = Array.isArray(fetched.list) ? fetched.list : [];
        const envelope = pickAssistantEnvelope(listPayload, body.messageID);
        if (!envelope) continue;
        const payload = extractAssistantPayloadFromEnvelope(envelope);
        return {
          messageId: envelope.info && envelope.info.id ? String(envelope.info.id) : placeholderId,
          text: String(payload.text || ""),
          reasoning: String(payload.reasoning || ""),
          meta: String(payload.meta || ""),
          blocks: Array.isArray(payload.blocks) ? payload.blocks : [],
          completed: true,
        };
      }
      return null;
    } catch (error) {
      this.log(`sync recovery failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async reconcileAssistantResponseQuick(sessionId, currentPayload, startedAt, signal, preferredMessageId = "") {
    let merged = currentPayload && typeof currentPayload === "object"
      ? { ...currentPayload }
      : { messageId: "", text: "", reasoning: "", meta: "", blocks: [], completed: false };
    const messageIdHint = String(
      preferredMessageId
      || (merged && typeof merged.messageId === "string" ? merged.messageId : ""),
    ).trim();

    if (messageIdHint) {
      try {
        const msgRes = await this.request(
          "GET",
          `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageIdHint)}`,
          undefined,
          this.buildSessionDirectoryQuery(sessionId),
          signal,
        );
        const messagePayload = this.normalizeMessageEnvelope(msgRes && msgRes.data ? msgRes.data : msgRes);
        const role =
          messagePayload && messagePayload.info && typeof messagePayload.info.role === "string"
            ? messagePayload.info.role
            : "";
        if (!role || role === "assistant") {
          const payload = messagePayload ? extractAssistantPayloadFromEnvelope(messagePayload) : null;
          if (payload) {
            merged = chooseRicherResponse(merged, {
              messageId: messageIdHint,
              text: String(payload.text || ""),
              reasoning: String(payload.reasoning || ""),
              meta: String(payload.meta || ""),
              blocks: Array.isArray(payload.blocks) ? payload.blocks : [],
              completed: this.isMessageEnvelopeCompleted(messagePayload),
            });
          }
        }
      } catch (error) {
        this.log(`quick reconcile by-id failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      const fetched = await this.fetchSessionMessages(sessionId, {
        signal,
        limit: 20,
        startedAt,
        requireRecentTail: true,
        state: this.createMessageListFetchState(),
      });
      const list = Array.isArray(fetched && fetched.list) ? fetched.list : [];
      let latest = fetched.latest || this.findLatestAssistantMessage(list, startedAt);
      if (!latest && list.length) {
        const latestUser = findLatestUserAnchor(list);
        latest = findLatestAssistantAnchoredByUser(list, latestUser) || this.findLatestAssistantMessage(list, 0);
      }
      if (latest) {
        const payload = extractAssistantPayloadFromEnvelope(latest);
        merged = chooseRicherResponse(merged, {
          messageId: latest && latest.info && latest.info.id ? String(latest.info.id) : messageIdHint,
          text: String(payload.text || ""),
          reasoning: String(payload.reasoning || ""),
          meta: String(payload.meta || ""),
          blocks: Array.isArray(payload.blocks) ? payload.blocks : [],
          completed: this.isMessageEnvelopeCompleted(latest),
        });
      }
    } catch (error) {
      this.log(`quick reconcile latest failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return merged;
  }

  }

  const methods = {};
  for (const key of Object.getOwnPropertyNames(ResponseRecoveryMethods.prototype)) {
    if (key === "constructor") continue;
    methods[key] = ResponseRecoveryMethods.prototype[key];
  }
  return methods;
}

module.exports = { createResponseRecoveryMethods };
