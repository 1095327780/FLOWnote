function encodeShortcutParam(value) {
  return encodeURIComponent(String(value || ""));
}

function getVaultName(plugin) {
  try {
    if (plugin && plugin.app && plugin.app.vault && typeof plugin.app.vault.getName === "function") {
      const name = String(plugin.app.vault.getName() || "").trim();
      if (name) return name;
    }
  } catch (_e) {
    // Fall through to adapter path fallback.
  }
  try {
    const basePath = plugin && plugin.app && plugin.app.vault && plugin.app.vault.adapter
      ? String(plugin.app.vault.adapter.basePath || "")
      : "";
    const normalized = basePath.replace(/\\/g, "/").replace(/\/+$/, "");
    const tail = normalized.split("/").filter(Boolean).pop();
    if (tail) return tail;
  } catch (_e) {
    // Ignore.
  }
  return "";
}

function getShortcutVaultParam(plugin) {
  const vault = getVaultName(plugin);
  return vault ? `vault=${encodeShortcutParam(vault)}` : "";
}

function withQuery(action, params) {
  const query = (params || []).filter(Boolean).join("&");
  return `obsidian://${action}${query ? `?${query}` : ""}`;
}

function buildShortcutUrls(plugin) {
  const vaultParam = getShortcutVaultParam(plugin);
  const textPrefix = withQuery("flownote-capture", [vaultParam, "text="]);
  const chatPrefix = withQuery("flownote-chat", [vaultParam, "text="]);
  return {
    vaultName: getVaultName(plugin),
    open: withQuery("flownote-open", [vaultParam]),
    capture: textPrefix,
    captureSubmit: withQuery("flownote-capture", [vaultParam, "submit=true", "text="]),
    chat: chatPrefix,
    newSession: withQuery("flownote-new-session", [vaultParam]),
  };
}

function isTruthyParam(value) {
  const text = String(value || "").trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "y";
}

function readTextParam(params) {
  const candidates = [
    params && params.text,
    params && params.content,
    params && params.input,
    params && params.query,
  ];
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (!text) continue;
    if (/^\{\{[^}]+\}\}$/.test(text)) continue;
    if (/^%7B%7B[^%]+%7D%7D$/i.test(text)) continue;
    return text;
  }
  return "";
}

module.exports = {
  buildShortcutUrls,
  encodeShortcutParam,
  getVaultName,
  isTruthyParam,
  readTextParam,
};
