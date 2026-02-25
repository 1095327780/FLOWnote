const {
  toPartBlock,
  blocksFingerprint,
  extractErrorText,
  mergeSnapshotText,
} = require("../../assistant-payload-utils");
const {
  isAssistantMessageCompletedInfo,
  extractSessionIdFromEventProperties,
  extractSessionStatusFromEventProperties,
  extractSessionStatusType,
} = require("./completion-signals");
const { rt } = (() => {
  try {
    return require("../../runtime-locale-state");
  } catch (_e) {
    return {
      rt: (_zh, en, params = {}) => String(en || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, k) => {
        const value = params[k];
        return value === undefined || value === null ? "" : String(value);
      }),
    };
  }
})();

function normalizeTimestampMs(value) {
  const raw = Number(value || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  if (raw >= 1e14) return Math.floor(raw / 1000);
  if (raw >= 1e12) return Math.floor(raw);
  if (raw >= 1e9) return Math.floor(raw * 1000);
  return Math.floor(raw);
}

function createTransportEventReducer(options) {
  const cfg = options && typeof options === "object" ? options : {};
  const sessionId = String(cfg.sessionId || "").trim();
  const startedAt = Number(cfg.startedAt || 0);
  const permissionEventTypes = new Set(
    Array.isArray(cfg.permissionEventTypes) && cfg.permissionEventTypes.length
      ? cfg.permissionEventTypes.map((item) => String(item || "").trim()).filter(Boolean)
      : ["permission.asked"],
  );

  const textByPart = new Map();
  const reasoningByPart = new Map();
  const blockPartById = new Map();
  const partKindById = new Map();
  const promptedPermissionIds = new Set();
  const promptedQuestionIds = new Set();
  const activeQuestionIds = new Set();

  let messageId = "";
  let activeMessageCreatedAt = 0;
  let text = "";
  let reasoning = "";
  let meta = "";
  let blocks = [];
  let blocksKey = blocksFingerprint(blocks);
  let done = false;
  let completionSeen = false;
  let idleSeen = false;

  const call = (fn, ...args) => {
    if (typeof fn !== "function") return;
    fn(...args);
  };

  const joinPartText = (map) =>
    Array.from(map.values())
      .map((v) => String(v || ""))
      .filter((v) => v.length > 0)
      .join("\n\n");

  const updateText = () => {
    const next = joinPartText(textByPart);
    if (next !== text) {
      text = next;
      call(cfg.onToken, text);
    }
  };

  const updateReasoning = () => {
    const next = joinPartText(reasoningByPart);
    if (next !== reasoning) {
      reasoning = next;
      call(cfg.onReasoning, reasoning);
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
      call(cfg.onBlocks, blocks);
    }
  };

  const resetActiveMessageContent = () => {
    textByPart.clear();
    reasoningByPart.clear();
    blockPartById.clear();
    partKindById.clear();
    completionSeen = false;
    idleSeen = false;
    text = "";
    reasoning = "";
    blocks = [];
    blocksKey = blocksFingerprint([]);
    call(cfg.onToken, "");
    call(cfg.onReasoning, "");
    call(cfg.onBlocks, []);
  };

  const consumePermissionEvent = (event) => {
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
    call(cfg.onPermissionRequest, permission || {}, permId);
  };

  const consumeQuestionAsked = (event) => {
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
    activeQuestionIds.add(requestId);
    if (promptedQuestionIds.has(requestId)) return;
    promptedQuestionIds.add(requestId);
    call(cfg.onQuestionRequest, request || {});
  };

  const consumeQuestionResolved = (event) => {
    const props = event.properties && typeof event.properties === "object" ? event.properties : {};
    const requestId = typeof props.requestID === "string" ? props.requestID : "";
    const reqSession = typeof props.sessionID === "string" ? props.sessionID : "";
    if (reqSession && reqSession !== sessionId) return;
    if (requestId) activeQuestionIds.delete(requestId);
    else activeQuestionIds.clear();
    call(cfg.onQuestionResolved, {
      requestId,
      sessionId: reqSession || sessionId,
      rejected: event.type === "question.rejected",
      answers: Array.isArray(props.answers) ? props.answers : [],
    });
  };

  const consumePromptAppend = (event) => {
    const props = event.properties && typeof event.properties === "object" ? event.properties : {};
    const appendText = typeof props.text === "string" ? props.text : "";
    if (!appendText) return;
    call(cfg.onPromptAppend, appendText);
  };

  const consumeToast = (event) => {
    const props = event.properties && typeof event.properties === "object" ? event.properties : {};
    call(cfg.onToast, {
      title: typeof props.title === "string" ? props.title : "",
      message: typeof props.message === "string" ? props.message : "",
      variant: typeof props.variant === "string" ? props.variant : "info",
    });
  };

  const consumeSessionError = (event) => {
    const props = event.properties && typeof event.properties === "object" ? event.properties : {};
    if (props.sessionID && props.sessionID !== sessionId) return;
    const err = extractErrorText(props.error);
    if (err) {
      meta = err;
      if (!text) {
        text = rt("模型返回错误：{err}", "Model returned an error: {err}", { err });
        call(cfg.onToken, text);
      }
    }
    completionSeen = true;
    done = true;
  };

  const consumeMessageUpdated = (event) => {
    const info = event.properties && event.properties.info && typeof event.properties.info === "object"
      ? event.properties.info
      : null;
    if (!info || info.sessionID !== sessionId) return;
    if (info.role !== "assistant") return;
    if (typeof info.id !== "string" || !info.id) return;

    const created = info.time ? normalizeTimestampMs(info.time.created || 0) : 0;
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
        text = rt("模型返回错误：{err}", "Model returned an error: {err}", { err });
        call(cfg.onToken, text);
      }
    }

    if (isAssistantMessageCompletedInfo(info)) {
      completionSeen = true;
      if (idleSeen) done = true;
    }
  };

  const consumeMessagePartUpdated = (event) => {
    const props = event.properties && typeof event.properties === "object" ? event.properties : {};
    const part = props.part && typeof props.part === "object" ? props.part : null;
    if (!part || typeof part.sessionID !== "string" || part.sessionID !== sessionId) return;
    if (part.time) {
      const partStart = normalizeTimestampMs(part.time.start || 0);
      if (partStart > 0 && partStart < startedAt - 1000) return;
    }
    if (!messageId) return;
    if (typeof part.messageID !== "string" || part.messageID !== messageId) return;

    const partId = typeof part.id === "string" && part.id ? part.id : `${part.type || "part"}:${part.messageID || "unknown"}`;
    const delta = typeof props.delta === "string" ? props.delta : "";
    partKindById.set(partId, String(part.type || ""));

    if (part.type === "text") {
      idleSeen = false;
      if (part.ignored === true) {
        textByPart.delete(partId);
      } else {
        const current = textByPart.get(partId) || "";
        let next = current;
        if (delta) next = mergeSnapshotText(next, delta);
        if (typeof part.text === "string") next = mergeSnapshotText(next, part.text);
        if (next !== current) {
          textByPart.set(partId, next);
        }
      }
      updateText();
      return;
    }

    if (part.type === "reasoning") {
      idleSeen = false;
      const current = reasoningByPart.get(partId) || "";
      let next = current;
      if (delta) next = mergeSnapshotText(next, delta);
      if (typeof part.text === "string") next = mergeSnapshotText(next, part.text);
      if (next !== current) {
        reasoningByPart.set(partId, next);
      }
      blockPartById.set(partId, Object.assign({}, part, { text: next || current }));
      updateReasoning();
      updateBlocks();
      return;
    }

    idleSeen = false;
    blockPartById.set(partId, part);
    updateBlocks();
  };

  const consumeMessagePartRemoved = (event) => {
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
  };

  function consume(rawEvent) {
    const event = rawEvent && typeof rawEvent === "object" ? rawEvent : null;
    if (!event || typeof event.type !== "string") return done;

    if (event.type === "message.part.updated") {
      consumeMessagePartUpdated(event);
      return done;
    }

    if (event.type === "message.part.removed") {
      consumeMessagePartRemoved(event);
      return done;
    }

    if (event.type === "message.updated") {
      consumeMessageUpdated(event);
      return done;
    }

    if (permissionEventTypes.has(event.type)) {
      consumePermissionEvent(event);
      return done;
    }

    if (event.type === "question.asked") {
      consumeQuestionAsked(event);
      return done;
    }

    if (event.type === "question.replied" || event.type === "question.rejected") {
      consumeQuestionResolved(event);
      return done;
    }

    if (event.type === "tui.prompt.append") {
      consumePromptAppend(event);
      return done;
    }

    if (event.type === "tui.toast.show") {
      consumeToast(event);
      return done;
    }

    if (event.type === "session.error") {
      consumeSessionError(event);
      return done;
    }

    if (event.type === "session.idle") {
      const sid = extractSessionIdFromEventProperties(event.properties);
      if (sid === sessionId) {
        if (activeQuestionIds.size > 0) return done;
        const hasAnyPayload = Boolean(String(text || "").trim()
          || String(reasoning || "").trim()
          || String(meta || "").trim()
          || (Array.isArray(blocks) && blocks.length > 0));
        if (completionSeen || (!hasAnyPayload && !messageId)) {
          done = true;
        } else {
          idleSeen = true;
        }
      }
      return done;
    }

    if (event.type === "session.status") {
      const sid = extractSessionIdFromEventProperties(event.properties);
      const status = extractSessionStatusType(
        extractSessionStatusFromEventProperties(event.properties),
      );
      if (sid === sessionId && status === "idle") {
        if (activeQuestionIds.size > 0) return done;
        const hasAnyPayload = Boolean(String(text || "").trim()
          || String(reasoning || "").trim()
          || String(meta || "").trim()
          || (Array.isArray(blocks) && blocks.length > 0));
        if (completionSeen || (!hasAnyPayload && !messageId)) {
          done = true;
        } else {
          idleSeen = true;
        }
      }
    }

    return done;
  }

  function snapshot() {
    return {
      messageId,
      text,
      reasoning,
      meta,
      blocks,
      completed: Boolean(done && completionSeen),
    };
  }

  function isDone() {
    return done;
  }

  return {
    consume,
    snapshot,
    isDone,
  };
}

module.exports = {
  createTransportEventReducer,
};
