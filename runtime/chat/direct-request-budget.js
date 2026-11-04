// Main-request output limits, independent from context capacity.
function resolveMainTurnTokenBudget(settings, provider) {
  const modelId = provider && provider.userConfig && provider.userConfig.model;
  const models = provider && provider.spec && Array.isArray(provider.spec.models)
    ? provider.spec.models
    : [];
  const activeModel = models.find((model) => model && model.id === modelId);
  const modelMax = Number(activeModel && activeModel.maxOutput);
  const normalizedModelMax = Number.isFinite(modelMax) && modelMax > 0
    ? Math.floor(modelMax)
    : 0;
  const userMax = Number(settings && settings.direct && settings.direct.maxOutputTokens);
  if (Number.isFinite(userMax) && userMax > 0) {
    const normalizedUserMax = Math.floor(userMax);
    return normalizedModelMax > 0
      ? Math.min(normalizedUserMax, normalizedModelMax)
      : normalizedUserMax;
  }
  return normalizedModelMax > 0 ? Math.min(32_768, normalizedModelMax) : 16_384;
}

module.exports = { resolveMainTurnTokenBudget };
