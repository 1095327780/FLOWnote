// Associate only host-identified runs/continuations. Never infer a workflow from chat prose.
function resolveWorkflowUsageId({ storedMessages = [], sessionId, runId, resumeFromRunId } = {}) {
  if (resumeFromRunId) {
    const previous = storedMessages.find(message => message && (message.id === resumeFromRunId
      || (message.stats && message.stats.runId === resumeFromRunId)));
    if (previous && previous.stats && previous.stats.workflowId) return previous.stats.workflowId;
  }
  return `${sessionId || "session"}:${runId}`;
}

function workflowUsageSummary({ storedMessages = [], workflowId, runId, requests = [] } = {}) {
  const byId = new Map();
  for (const message of storedMessages) {
    const stats = message && message.stats;
    if (!stats || stats.workflowId !== workflowId || stats.runId === runId) continue;
    for (const request of stats.requestUsage || []) {
      if (request.requestId) byId.set(request.requestId, request);
    }
  }
  for (const request of requests) {
    const requestId = `${runId}:${request.requestIndex}`;
    byId.set(requestId, { ...request, requestId, workflowId, runId,
      uncachedInputTokens: request.cacheReported === true && request.reported && request.reported.input
        ? Math.max(0, request.inputTokens - request.cachedInputTokens - (request.cacheWriteInputTokens || 0)) : null });
  }
  const all = [...byId.values()];
  const totals = { requestCount: all.length, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
    cacheWriteInputTokens: 0, reasoningTokens: 0, unreportedCacheRequests: 0, incompleteResponses: 0,
    unreportedInputRequests: 0, unreportedOutputRequests: 0 };
  for (const request of all) {
    for (const key of ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteInputTokens", "reasoningTokens"]) {
      totals[key] += Number.isFinite(request[key]) ? request[key] : 0;
    }
    if (request.cacheReported !== true) totals.unreportedCacheRequests++;
    if (request.responseComplete !== true) totals.incompleteResponses++;
    if (!request.reported || !request.reported.input) totals.unreportedInputRequests++;
    if (!request.reported || !request.reported.output) totals.unreportedOutputRequests++;
  }
  return { requests: all, totals, accounting: "Reported tokens only; missing usage is unknown. Reasoning is a subset of output, not an extra billed quantity. Provider bills and tariff estimates require separate reconciliation." };
}

module.exports = { resolveWorkflowUsageId, workflowUsageSummary };
