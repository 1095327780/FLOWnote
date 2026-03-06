function waitWithAbort(ms, signal) {
  const waitMs = Math.max(0, Number(ms) || 0);
  if (!signal || typeof signal.addEventListener !== "function") {
    return new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => cleanup();
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(cleanup, waitMs);
  });
}

function extractRequestId(request) {
  return String(
    (request && (request.id || request.requestID || request.requestId)) || "",
  ).trim();
}

function extractSessionId(request) {
  return String(
    (request && (request.sessionID || request.sessionId)) || "",
  ).trim();
}

function linkAbortSignal(parentSignal, controller) {
  if (!parentSignal || typeof parentSignal.addEventListener !== "function") {
    return () => {};
  }
  if (parentSignal.aborted) {
    controller.abort();
    return () => {};
  }
  const onAbort = () => controller.abort();
  parentSignal.addEventListener("abort", onAbort, { once: true });
  return () => {
    parentSignal.removeEventListener("abort", onAbort);
  };
}

function createQuestionTracker(options = {}) {
  const sessionId = String(options.sessionId || "").trim();
  const isCommandRequest = Boolean(options.isCommandRequest);
  const listQuestions = typeof options.listQuestions === "function" ? options.listQuestions : async () => [];
  const onQuestionRequestExternal = typeof options.onQuestionRequest === "function" ? options.onQuestionRequest : null;
  const onQuestionResolvedExternal = typeof options.onQuestionResolved === "function" ? options.onQuestionResolved : null;
  const log = typeof options.log === "function" ? options.log : () => {};
  const pollIntervalMs = Math.max(400, Number(options.pollIntervalMs || 1600));
  const errorRetryMs = Math.max(300, Number(options.errorRetryMs || 900));
  const deliveredQuestionIds = new Set();
  let waitingForQuestion = false;
  let pendingQuestionSyncAt = 0;
  let pendingQuestionSyncResult = false;
  let pendingQuestionSyncPromise = null;

  if (!sessionId || isCommandRequest) {
    return {
      onQuestionRequest: () => {},
      onQuestionResolved: () => {},
      isQuestionPending: async () => false,
      stop: async () => {},
    };
  }

  const handleQuestionRequest = (request) => {
    const requestId = extractRequestId(request);
    if (requestId && deliveredQuestionIds.has(requestId)) return;
    if (requestId) deliveredQuestionIds.add(requestId);
    waitingForQuestion = deliveredQuestionIds.size > 0;
    if (onQuestionRequestExternal) onQuestionRequestExternal(request);
  };

  const handleQuestionResolved = (info) => {
    const requestId = String((info && info.requestId) || "").trim();
    if (requestId) deliveredQuestionIds.delete(requestId);
    waitingForQuestion = deliveredQuestionIds.size > 0;
    if (onQuestionResolvedExternal) onQuestionResolvedExternal(info);
  };

  const syncPendingQuestionsForSession = async (signal, force = false) => {
    if (!force) {
      if (pendingQuestionSyncPromise) return pendingQuestionSyncPromise;
      if (Date.now() - pendingQuestionSyncAt < 450) return pendingQuestionSyncResult;
    }

    const run = (async () => {
      const listed = await listQuestions({ signal });
      const activeRequestIds = new Set();
      for (const request of Array.isArray(listed) ? listed : []) {
        if (!request || typeof request !== "object") continue;
        const reqSession = extractSessionId(request);
        if (reqSession && reqSession !== sessionId) continue;
        const requestId = extractRequestId(request);
        if (!requestId) continue;
        activeRequestIds.add(requestId);
        handleQuestionRequest(request);
      }

      if (deliveredQuestionIds.size) {
        for (const requestId of Array.from(deliveredQuestionIds)) {
          if (!activeRequestIds.has(requestId)) {
            handleQuestionResolved({ requestId, sessionId });
          }
        }
      }

      waitingForQuestion = activeRequestIds.size > 0;
      pendingQuestionSyncResult = waitingForQuestion;
      pendingQuestionSyncAt = Date.now();
      return waitingForQuestion;
    })();

    pendingQuestionSyncPromise = run;
    try {
      return await run;
    } catch (error) {
      if (deliveredQuestionIds.size > 0 || waitingForQuestion) {
        waitingForQuestion = true;
        pendingQuestionSyncResult = true;
        pendingQuestionSyncAt = Date.now();
        return true;
      }
      log(`question sync failed: ${error instanceof Error ? error.message : String(error)}`);
      pendingQuestionSyncResult = false;
      pendingQuestionSyncAt = Date.now();
      return false;
    } finally {
      if (pendingQuestionSyncPromise === run) pendingQuestionSyncPromise = null;
    }
  };

  const isQuestionPending = async (signal) => {
    if (deliveredQuestionIds.size > 0) return syncPendingQuestionsForSession(signal, true);
    if (waitingForQuestion) return syncPendingQuestionsForSession(signal, false);
    return syncPendingQuestionsForSession(signal, false);
  };

  const controller = new AbortController();
  const detachParentSignal = linkAbortSignal(options.signal, controller);
  const hasWatcherHandlers = Boolean(onQuestionRequestExternal || onQuestionResolvedExternal);
  const watcherPromise = hasWatcherHandlers
    ? (async () => {
      let endpointUnavailable = false;
      while (!controller.signal.aborted) {
        try {
          await syncPendingQuestionsForSession(controller.signal, true);
        } catch (error) {
          if (controller.signal.aborted) break;
          const message = error instanceof Error ? error.message : String(error);
          if (/\b404\b|not found|unknown endpoint|\/question/i.test(message)) {
            if (!endpointUnavailable) {
              endpointUnavailable = true;
              log(`question watcher disabled: ${message}`);
            }
            break;
          }
          log(`question watcher poll failed: ${message}`);
          await waitWithAbort(errorRetryMs, controller.signal);
          continue;
        }
        await waitWithAbort(pollIntervalMs, controller.signal);
      }
    })()
    : Promise.resolve();

  return {
    onQuestionRequest: handleQuestionRequest,
    onQuestionResolved: handleQuestionResolved,
    isQuestionPending,
    stop: async () => {
      detachParentSignal();
      controller.abort();
      await watcherPromise;
    },
  };
}

module.exports = {
  createQuestionTracker,
};
