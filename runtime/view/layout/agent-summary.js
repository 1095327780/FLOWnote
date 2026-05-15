// Pure helper: given a plugin instance, returns a compact summary of
// the active agent provider for the chat-view UI to render.
//
// The chat view used to be hard-coded for OpenCode — "OpenCode 连接成功",
// the model picker pulled from OpenCode's catalog, etc. With direct mode
// the source of truth is `plugin.settings.agentProvider`. This helper
// centralises the dispatch so the UI doesn't repeat the if-direct-else-
// opencode check in every render path.

const { getProviderSpec } = require("../../providers/registry");
const { getActiveApiKey } = require("../../agent/agent-settings");

/**
 * @typedef {Object} AgentSummary
 * @property {'direct'|'opencode-legacy'} mode
 * @property {string} providerLabel     human-readable provider name ("DeepSeek")
 * @property {string} modelId           current model id ("deepseek-v4-flash")
 * @property {string} modelLabel        human-readable model name ("DeepSeek V4 Flash")
 * @property {boolean} hasApiKey
 * @property {boolean} configComplete   true when the agent can attempt a call
 * @property {string} [missingReason]   non-empty if config is incomplete
 */

/**
 * @param {Object} plugin Obsidian plugin instance
 * @returns {AgentSummary}
 */
function summarizeActiveAgent(plugin) {
  const settings = (plugin && plugin.settings && plugin.settings.agentProvider) || {};
  const mode = settings.mode === "opencode-legacy" ? "opencode-legacy" : "direct";

  if (mode === "opencode-legacy") {
    // Legacy stays opaque: we don't know which model the CLI is using
    // from inside here — the toolbar will read view.selectedModel for
    // display.
    return {
      mode: "opencode-legacy",
      providerLabel: "OpenCode",
      modelId: "",
      modelLabel: "",
      hasApiKey: false,
      configComplete: true, // can't tell from here; defer to runtime
    };
  }

  const direct = settings.direct || {};
  const spec = getProviderSpec(direct.providerId || "");
  const providerLabel = (spec && spec.displayName) || direct.providerId || "未配置";
  const modelId = String(direct.model || "");
  const modelInfo = spec ? (spec.models || []).find((m) => m && m.id === modelId) : null;
  const modelLabel = (modelInfo && modelInfo.label) || modelId || "未选择模型";
  const hasApiKey = Boolean(getActiveApiKey(settings));

  let configComplete = true;
  let missingReason = "";
  if (!spec) {
    configComplete = false;
    missingReason = "未选择服务商";
  } else if (!modelId) {
    configComplete = false;
    missingReason = "未选择模型";
  } else if (!hasApiKey) {
    configComplete = false;
    missingReason = "未填写 API Key";
  }

  return {
    mode: "direct",
    providerLabel,
    modelId,
    modelLabel,
    hasApiKey,
    configComplete,
    ...(missingReason ? { missingReason } : {}),
  };
}

module.exports = {
  summarizeActiveAgent,
};
