const {
  blocksFingerprint,
  chooseRicherResponse,
  formatSessionStatusText,
  hasRenderablePayload,
  hasTerminalPayload,
  normalizedRenderableText,
  payloadLooksInProgress,
  responseRichnessScore,
} = require("../../assistant-payload-utils");

function buildProgressKey(messageId, payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const text = normalizedRenderableText(p.text || "");
  const blocks = Array.isArray(p.blocks) ? p.blocks : [];
  return `${String(messageId || "")}|${responseRichnessScore(p)}|${text.length}|${blocksFingerprint(blocks)}`;
}

async function pollAssistantPayload(options) {
  const cfg = options && typeof options === "object" ? options : {};
  const quietTimeoutMs = Math.max(10000, Number(cfg.quietTimeoutMs || 120000));
  const maxTotalMs = Math.max(quietTimeoutMs * 3, Number(cfg.maxTotalMs || 10 * 60 * 1000));
  const requireTerminal = cfg.requireTerminal !== false;

  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let messageId = String(cfg.initialMessageId || "");
  let payload = cfg.initialPayload && typeof cfg.initialPayload === "object"
    ? cfg.initialPayload
    : { text: "", reasoning: "", meta: "", blocks: [] };
  let progressKey = buildProgressKey(messageId, payload);
  let pollCount = 0;
  let lastStatus = null;
  let lastMessageCreated = 0;
  let timedOut = false;

  const emit = () => {
    if (typeof cfg.onToken === "function") cfg.onToken(String(payload.text || ""));
    if (typeof cfg.onReasoning === "function") cfg.onReasoning(String(payload.reasoning || ""));
    if (typeof cfg.onBlocks === "function") cfg.onBlocks(Array.isArray(payload.blocks) ? payload.blocks : []);
  };

  const markProgress = () => {
    const nextKey = buildProgressKey(messageId, payload);
    if (nextKey !== progressKey) {
      progressKey = nextKey;
      lastProgressAt = Date.now();
      emit();
    }
  };

  const isComplete = () => {
    if (!hasRenderablePayload(payload)) return false;
    if (!requireTerminal) {
      if (payloadLooksInProgress(payload)) return false;
      return true;
    }
    return hasTerminalPayload(payload) && !payloadLooksInProgress(payload);
  };

  while (Date.now() - startedAt < maxTotalMs && Date.now() - lastProgressAt < quietTimeoutMs) {
    if (cfg.signal && cfg.signal.aborted) {
      throw new Error("用户取消了请求");
    }

    if (messageId && typeof cfg.getByMessageId === "function") {
      try {
        const byId = await cfg.getByMessageId(messageId, cfg.signal);
        if (byId && byId.payload) {
          const before = payload;
          payload = chooseRicherResponse(payload, byId.payload);
          if (byId.messageId) messageId = String(byId.messageId || messageId);
          if (payload !== before) markProgress();
          if (byId.completed && isComplete()) break;
        }
      } catch {
        // ignore by-id failure and continue with latest query
      }
    }

    if (typeof cfg.getLatest === "function") {
      try {
        const latest = await cfg.getLatest(cfg.signal);
        if (latest && latest.payload) {
          if (
            latest.messageId &&
            (!latest.createdAt || Number(latest.createdAt) >= lastMessageCreated)
          ) {
            messageId = String(latest.messageId);
            if (latest.createdAt) lastMessageCreated = Number(latest.createdAt || 0);
          }
          const before = payload;
          payload = chooseRicherResponse(payload, latest.payload);
          if (payload !== before || latest.messageId) markProgress();
          if (latest.completed && isComplete()) break;
        }
      } catch {
        // ignore and keep waiting
      }
    }

    pollCount += 1;
    if (pollCount % 2 === 0 && typeof cfg.getSessionStatus === "function") {
      lastStatus = await cfg.getSessionStatus(cfg.signal);
      if (lastStatus && lastStatus.type === "idle" && hasRenderablePayload(payload)) {
        const staleMs = Date.now() - lastProgressAt;
        if (!payloadLooksInProgress(payload) || staleMs > 1800) break;
      }
    }

    if (isComplete()) break;

    await cfg.sleep(220);
  }

  if (Date.now() - startedAt >= maxTotalMs || Date.now() - lastProgressAt >= quietTimeoutMs) {
    timedOut = true;
  }

  return {
    messageId,
    payload,
    lastStatus,
    timedOut,
    startedAt,
    lastProgressAt,
    quietTimeoutMs,
    maxTotalMs,
  };
}

async function ensureRenderablePayload(options) {
  const cfg = options && typeof options === "object" ? options : {};
  const payload = cfg.payload && typeof cfg.payload === "object"
    ? cfg.payload
    : { text: "", reasoning: "", meta: "", blocks: [] };
  if (hasRenderablePayload(payload)) return payload;

  const status = cfg.lastStatus || (
    typeof cfg.getSessionStatus === "function"
      ? await cfg.getSessionStatus(cfg.signal)
      : null
  );
  const statusText = formatSessionStatusText(status);
  return {
    ...payload,
    text: `(无文本返回：session.status=${statusText}。若长期为 busy，通常是权限或模型鉴权问题，请在 OpenCode 诊断中检查。)`,
  };
}

module.exports = {
  pollAssistantPayload,
  ensureRenderablePayload,
};
