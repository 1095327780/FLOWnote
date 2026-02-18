function parseModel(defaultModel) {
  const model = String(defaultModel || "").trim();
  if (!model.includes("/")) return undefined;
  const [providerID, modelID] = model.split("/");
  if (!providerID || !modelID) return undefined;
  return { providerID, modelID };
}

function parseCommandModel(defaultModel) {
  const model = String(defaultModel || "").trim();
  if (!model.includes("/")) return undefined;
  return model;
}

function normalizeSlashCommandName(commandName) {
  const normalized = String(commandName || "").trim().replace(/^\//, "").toLowerCase();
  if (normalized === "modle") return "model";
  return normalized;
}

function availableCommandSet(list) {
  const set = new Set();
  for (const item of list || []) {
    const name = String(item && item.name ? item.name : "")
      .replace(/^\//, "")
      .trim()
      .toLowerCase();
    if (name) set.add(name);
  }
  return set;
}

function resolveCommandFromSet(commandName, names) {
  const normalized = normalizeSlashCommandName(commandName);
  if (!normalized) return { use: false, command: "" };

  if (names.has(normalized)) {
    return { use: true, command: normalized };
  }
  if (normalized === "model" && names.has("models")) return { use: true, command: "models" };
  if (normalized === "models" && names.has("model")) return { use: true, command: "model" };
  return { use: false, command: normalized };
}

function parseSlashCommand(prompt) {
  const text = String(prompt || "").trim();
  if (!text.startsWith("/")) return null;
  if (text.length <= 1) return null;

  const withoutSlash = text.slice(1).trim();
  if (!withoutSlash) return null;
  const firstSpace = withoutSlash.indexOf(" ");
  if (firstSpace < 0) {
    return { command: withoutSlash, arguments: "" };
  }

  return {
    command: withoutSlash.slice(0, firstSpace).trim(),
    arguments: withoutSlash.slice(firstSpace + 1).trim(),
  };
}

function findLatestAssistantMessage(messages, startedAt) {
  const list = Array.isArray(messages) ? messages : [];
  const candidates = list
    .filter((item) => item && item.info && item.info.role === "assistant")
    .filter((item) => {
      const created = item && item.info && item.info.time ? Number(item.info.time.created || 0) : 0;
      return !startedAt || created >= startedAt - 1000;
    })
    .sort((a, b) => {
      const ta = a && a.info && a.info.time ? Number(a.info.time.created || 0) : 0;
      const tb = b && b.info && b.info.time ? Number(b.info.time.created || 0) : 0;
      return tb - ta;
    });
  return candidates[0] || null;
}

module.exports = {
  parseModel,
  parseCommandModel,
  normalizeSlashCommandName,
  availableCommandSet,
  resolveCommandFromSet,
  parseSlashCommand,
  findLatestAssistantMessage,
};
