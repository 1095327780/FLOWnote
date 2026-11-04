// Measure every provider request, including task-contract preflight and retries.
// Recording at the provider boundary prevents hidden control-plane usage.
function meterProvider(provider, usage, { getPhase, onComplete, now = Date.now } = {}) {
  const metered = Object.create(provider);
  metered.createMessage = async function* (input) {
    const phase = typeof getPhase === "function" ? getPhase() : "main";
    let responseComplete = false;
    const startedAt = now();
    let reportedModel = null;
    usage.observe({ type: "message_start" });
    try {
      for await (const event of provider.createMessage(input)) {
        usage.observe(event);
        if (event && event.message && typeof event.message.model === "string") reportedModel = event.message.model;
        if (event && event.type === "message_stop") responseComplete = true;
        yield event;
      }
    } finally {
      const record = usage.completeTurn({ phase, responseComplete, startedAt, durationMs: Math.max(0, now() - startedAt),
        providerId: String(provider.id || (provider.spec && provider.spec.id) || ""),
        requestedModel: String((provider.userConfig && provider.userConfig.model) || input.model || ""),
        reportedModel });
      if (record && typeof onComplete === "function") await onComplete(record);
    }
  };
  return metered;
}

module.exports = { meterProvider };
