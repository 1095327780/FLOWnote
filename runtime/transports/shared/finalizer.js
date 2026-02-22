const {
  blocksFingerprint,
  chooseRicherResponse,
  formatSessionStatusText,
  hasRenderablePayload,
  normalizedRenderableText,
  payloadLooksInProgress,
  responseRichnessScore,
} = require("../../assistant-payload-utils");
const {
  extractSessionStatusHint,
  isSessionStatusTerminal,
} = require("./completion-signals");

function buildProgressKey(messageId, payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const text = normalizedRenderableText(p.text || "");
  const reasoning = String(p.reasoning || "").trim();
  const blocks = Array.isArray(p.blocks) ? p.blocks : [];
  const typeStatusSummary = (() => {
    const counter = new Map();
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const type = String(block.type || "block").trim() || "block";
      const status = String(block.status || "").trim().toLowerCase() || "-";
      const key = `${type}:${status}`;
      counter.set(key, Number(counter.get(key) || 0) + 1);
    }
    return Array.from(counter.entries())
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([key, count]) => `${key}=${count}`)
      .join(",");
  })();
  return [
    String(messageId || ""),
    `score=${responseRichnessScore(p)}`,
    `text=${text.length}`,
    `reasoning=${reasoning.length}`,
    `blocks=${blocks.length}`,
    `shape=${typeStatusSummary}`,
    `fp=${blocksFingerprint(blocks)}`,
  ].join("|");
}

function statusIndicatesTerminalNoWork(status) {
  return isSessionStatusTerminal(status);
}

function extractStatusHint(status) {
  return extractSessionStatusHint(status);
}

function buildStatusErrorPayload(statusHint, payload) {
  const hint = String(statusHint || "").trim();
  if (!hint) return payload;
  const current = payload && typeof payload === "object" ? payload : {};
  if (hasRenderablePayload(current)) return current;
  return {
    text: `模型返回错误：${hint}`,
    reasoning: "",
    meta: hint,
    blocks: [],
  };
}

async function pollAssistantPayload(options) {
  const cfg = options && typeof options === "object" ? options : {};
  const quietTimeoutMs = Math.max(10000, Number(cfg.quietTimeoutMs || 120000));
  const maxTotalMs = Math.max(quietTimeoutMs * 3, Number(cfg.maxTotalMs || 10 * 60 * 1000));
  const latestIntervalMs = Math.max(220, Number(cfg.latestIntervalMs || 1100));
  const defaultNoMessageTimeoutMs = Math.max(
    12000,
    Math.min(45000, Math.floor(quietTimeoutMs * 0.5)),
  );
  const configuredNoMessageTimeoutMs = Number(cfg.noMessageTimeoutMs);
  const noMessageTimeoutMs = Number.isFinite(configuredNoMessageTimeoutMs) && configuredNoMessageTimeoutMs > 0
    ? configuredNoMessageTimeoutMs
    : defaultNoMessageTimeoutMs;
  const terminalNoPayloadGraceMs = Math.max(2500, Math.min(noMessageTimeoutMs, 20000));
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
  let completionSeen = false;
  let byIdSeen = false;
  let lastLatestAt = 0;
  let questionPending = false;
  let lastQuestionCheckAt = 0;

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
    if (payloadLooksInProgress(payload)) return false;
    return completionSeen;
  };

  const checkQuestionPending = async (force = false) => {
    if (typeof cfg.isQuestionPending !== "function") return false;
    const now = Date.now();
    if (!force && now - lastQuestionCheckAt < 800) return questionPending;
    lastQuestionCheckAt = now;
    try {
      questionPending = Boolean(await cfg.isQuestionPending(cfg.signal));
    } catch {
      questionPending = false;
    }
    return questionPending;
  };

  while (Date.now() - startedAt < maxTotalMs && Date.now() - lastProgressAt < quietTimeoutMs) {
    if (cfg.signal && cfg.signal.aborted) {
      throw new Error("用户取消了请求");
    }
    pollCount += 1;

    if (
      pollCount % 4 === 0
      && !messageId
      && !hasRenderablePayload(payload)
      && await checkQuestionPending()
    ) {
      lastProgressAt = Date.now();
    }

    let byIdUpdated = false;

    if (messageId && typeof cfg.getByMessageId === "function") {
      try {
        const byId = await cfg.getByMessageId(messageId, cfg.signal);
        if (byId && byId.payload) {
          byIdSeen = true;
          const before = payload;
          payload = chooseRicherResponse(payload, byId.payload);
          if (byId.completed) completionSeen = true;
          if (byId.messageId) messageId = String(byId.messageId || messageId);
          if (payload !== before) {
            markProgress();
            byIdUpdated = true;
          }
        }
      } catch {
        // ignore by-id failure and continue with latest query
      }
    }

    const now = Date.now();
    const shouldFetchLatest = typeof cfg.getLatest === "function" && (
      !messageId
      || !byIdSeen
      || !hasRenderablePayload(payload)
      || !byIdUpdated
      || (now - lastLatestAt >= latestIntervalMs)
    );
    if (shouldFetchLatest) {
      lastLatestAt = now;
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
          if (latest.completed) completionSeen = true;
          if (payload !== before || latest.messageId) markProgress();
        }
      } catch {
        // ignore and keep waiting
      }
    }

    if (pollCount % 2 === 0 && typeof cfg.getSessionStatus === "function") {
      lastStatus = await cfg.getSessionStatus(cfg.signal);
      const statusHint = extractStatusHint(lastStatus);
      if (/401|unauthorized|user not found|forbidden|invalid api key|authentication/i.test(statusHint)) {
        payload = buildStatusErrorPayload(statusHint, payload);
        markProgress();
        break;
      }
      if (statusIndicatesTerminalNoWork(lastStatus)) {
        const hasRenderable = hasRenderablePayload(payload);
        if (!hasRenderable) {
          if (await checkQuestionPending(true)) {
            lastProgressAt = Date.now();
          } else {
          const elapsedMs = Date.now() - startedAt;
          const allowShortTimeoutFastExit = noMessageTimeoutMs <= 2000;
          if (messageId || allowShortTimeoutFastExit || elapsedMs >= terminalNoPayloadGraceMs) {
            break;
          }
          }
        } else {
          // Keep waiting for explicit assistant completion signal.
        }
      }
    }

    if (
      !messageId &&
      !hasRenderablePayload(payload) &&
      Date.now() - startedAt >= noMessageTimeoutMs
    ) {
      if (await checkQuestionPending()) {
        lastProgressAt = Date.now();
      } else if (statusIndicatesTerminalNoWork(lastStatus)) {
        break;
      } else if (!lastStatus && typeof cfg.getSessionStatus !== "function") {
        break;
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
    completed: completionSeen,
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
    text: `(无文本返回：session.status=${statusText}。可能是模型仍在排队/执行，或当前模型不可用；请在 OpenCode 诊断中查看状态详情。)`,
  };
}

module.exports = {
  pollAssistantPayload,
  ensureRenderablePayload,
};
