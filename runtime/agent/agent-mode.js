// A shared vault may retain the desktop's OpenCode preference. Mobile has
// no CLI bridge, so all runtime and UI consumers must use its effective mode
// without changing the preference that will sync back to the desktop.
function getEffectiveAgentMode(agentSettings, platform) {
  if (platform === undefined) {
    try {
      platform = require("obsidian").Platform;
    } catch (_error) {
      // Pure Node consumers have no Obsidian platform; use desktop semantics.
      platform = null;
    }
  }
  if (platform && platform.isMobile) return "direct";
  return agentSettings && agentSettings.mode === "opencode-legacy"
    ? "opencode-legacy"
    : "direct";
}

module.exports = { getEffectiveAgentMode };
