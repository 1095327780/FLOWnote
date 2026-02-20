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

function normalizeTimestampMs(value) {
  const raw = Number(value || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  if (raw >= 1e14) return Math.floor(raw / 1000);
  if (raw >= 1e12) return Math.floor(raw);
  if (raw >= 1e9) return Math.floor(raw * 1000);
  return Math.floor(raw);
}

function messageInfo(item) {
  if (!item || typeof item !== "object") return null;
  if (item.info && typeof item.info === "object") return item.info;
  if (item.message && typeof item.message === "object") {
    if (item.message.info && typeof item.message.info === "object") return item.message.info;
    return item.message;
  }
  return item;
}

function messageRole(item) {
  const info = messageInfo(item);
  if (!info || typeof info !== "object") return "";
  if (typeof info.role === "string" && info.role.trim()) return info.role.trim().toLowerCase();
  if (typeof info.type === "string" && info.type.trim()) return info.type.trim().toLowerCase();
  return "";
}

function messageHasError(item) {
  const info = messageInfo(item);
  if (!info || typeof info !== "object") return false;
  if (typeof info.error === "string" && info.error.trim()) return true;
  if (info.error && typeof info.error === "object") return true;
  return false;
}

function messageCreatedAt(item) {
  const info = messageInfo(item);
  if (!info || typeof info !== "object") return 0;
  const time = info.time && typeof info.time === "object" ? info.time : {};
  const created = normalizeTimestampMs(
    time.created || time.updated || info.created || info.updated || 0,
  );
  return created;
}

function findLatestAssistantMessage(messages, startedAt) {
  const list = Array.isArray(messages) ? messages : [];
  const candidates = list
    .filter((item) => messageRole(item) === "assistant")
    .filter((item) => {
      const created = messageCreatedAt(item);
      return !startedAt || created === 0 || created >= startedAt - 1000;
    })
    .sort((a, b) => {
      const ta = messageCreatedAt(a);
      const tb = messageCreatedAt(b);
      return tb - ta;
    });
  if (candidates.length) return candidates[0];

  const errorCandidates = list
    .filter((item) => messageHasError(item))
    .sort((a, b) => {
      const ta = messageCreatedAt(a);
      const tb = messageCreatedAt(b);
      return tb - ta;
    });
  return errorCandidates[0] || null;
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
