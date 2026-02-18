function splitLegacyMixedAssistantText(rawText) {
  const text = typeof rawText === "string" ? rawText : "";
  if (!text) return { changed: false, text: "", reasoning: "" };

  const hasLegacyMarkers = /(^|\n)(step-start|step-finish|reasoning|text|stop)(\n|$)/m.test(text);
  const hasLegacyIds = /(^|\n)(prt_|ses_|msg_)[a-zA-Z0-9]+(\n|$)/m.test(text);
  if (!hasLegacyMarkers && !hasLegacyIds) {
    return { changed: false, text, reasoning: "" };
  }

  const reasoningLines = [];
  const outputLines = [];
  const lines = text.split(/\r?\n/);
  let mode = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (mode === "reasoning") reasoningLines.push("");
      if (mode === "text") outputLines.push("");
      continue;
    }

    if (trimmed === "reasoning") {
      mode = "reasoning";
      continue;
    }

    if (trimmed === "text") {
      mode = "text";
      continue;
    }

    if (trimmed === "step-start" || trimmed === "step-finish" || trimmed === "stop") {
      mode = "";
      continue;
    }

    if (/^(prt|ses|msg)_[a-zA-Z0-9]+$/.test(trimmed)) continue;
    if (/^[a-f0-9]{40}$/i.test(trimmed)) continue;

    if (mode === "reasoning") {
      reasoningLines.push(line);
      continue;
    }

    if (mode === "text") {
      outputLines.push(line);
      continue;
    }
  }

  const parsedText = outputLines.join("\n").trim();
  const parsedReasoning = reasoningLines.join("\n").trim();

  if (!parsedText && !parsedReasoning) {
    return { changed: false, text, reasoning: "" };
  }

  return {
    changed: true,
    text: parsedText || text,
    reasoning: parsedReasoning,
  };
}

function migrateLegacyMessages(runtimeState) {
  const st = runtimeState && typeof runtimeState === "object" ? runtimeState : {};
  if (!st.messagesBySession || typeof st.messagesBySession !== "object") return st;

  for (const [sessionId, list] of Object.entries(st.messagesBySession)) {
    if (!Array.isArray(list)) continue;
    st.messagesBySession[sessionId] = list.map((message) => {
      if (!message || typeof message !== "object") return message;
      if (message.role !== "assistant") return message;
      if (message.reasoning) return message;

      const cleaned = splitLegacyMixedAssistantText(message.text || "");
      if (!cleaned.changed) return message;
      return Object.assign({}, message, {
        text: cleaned.text,
        reasoning: cleaned.reasoning,
      });
    });
  }
  return st;
}

module.exports = {
  migrateLegacyMessages,
};
