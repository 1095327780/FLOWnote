function normalizeSessionTitleInput(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isPlaceholderSessionTitle(title) {
  const normalized = normalizeSessionTitleInput(title).toLowerCase();
  if (!normalized) return true;
  if (
    normalized === "新会话"
    || normalized === "未命名会话"
    || normalized === "new session"
    || normalized === "untitled"
    || normalized === "untitled session"
  ) {
    return true;
  }
  return /^(new session|untitled(?: session)?|新会话|未命名会话)(?:\s*[-:：].*)?$/.test(normalized);
}

function deriveSessionTitleFromPrompt(prompt) {
  let text = normalizeSessionTitleInput(prompt);
  if (!text) return "";

  if (text.startsWith("/")) {
    const firstSpace = text.indexOf(" ");
    if (firstSpace > 1) {
      const rest = normalizeSessionTitleInput(text.slice(firstSpace + 1));
      text = rest || text.slice(1);
    } else {
      text = text.slice(1);
    }
  }

  text = text.replace(/^[\s:：\-—]+/, "");
  if (!text) return "";

  const maxLen = 28;
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

function resolveSessionDisplayTitle(session, fallback = "未命名会话") {
  if (!session || typeof session !== "object") return fallback;
  const current = normalizeSessionTitleInput(session.title);
  if (current && !isPlaceholderSessionTitle(current)) return current;
  const inferred = deriveSessionTitleFromPrompt(session.lastUserPrompt || "");
  return inferred || current || fallback;
}

module.exports = {
  normalizeSessionTitleInput,
  isPlaceholderSessionTitle,
  deriveSessionTitleFromPrompt,
  resolveSessionDisplayTitle,
};
