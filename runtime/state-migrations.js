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

function overlapSuffixPrefix(left, right, maxWindow = 2048) {
  const a = String(left || "");
  const b = String(right || "");
  const max = Math.min(a.length, b.length, Math.max(32, Number(maxWindow) || 2048));
  for (let len = max; len >= 16; len -= 1) {
    if (a.slice(a.length - len) === b.slice(0, len)) return len;
  }
  return 0;
}

function mergeSnapshotText(existingText, incomingText) {
  const existing = String(existingText || "");
  const incoming = String(incomingText || "");
  if (!incoming.trim()) return existing;
  if (!existing.trim()) return incoming;
  if (existing === incoming) return existing;
  if (incoming.includes(existing)) return incoming;
  if (existing.includes(incoming)) return existing;

  const existingTrimmed = existing.trim();
  const incomingTrimmed = incoming.trim();
  if (incomingTrimmed.startsWith(existingTrimmed) || incomingTrimmed.endsWith(existingTrimmed)) return incoming;
  if (existingTrimmed.startsWith(incomingTrimmed) || existingTrimmed.endsWith(incomingTrimmed)) return existing;

  const overlap = overlapSuffixPrefix(existing, incoming);
  if (overlap > 0) return `${existing}${incoming.slice(overlap)}`;
  const reverseOverlap = overlapSuffixPrefix(incoming, existing);
  if (reverseOverlap > 0) return `${incoming}${existing.slice(reverseOverlap)}`;

  return incoming.length >= existing.length ? incoming : existing;
}

function compactInflatedReasoning(reasoningText) {
  const original = typeof reasoningText === "string" ? reasoningText : "";
  if (!original || original.length < 12000) {
    return { changed: false, text: original };
  }

  const segments = original
    .split(/\n{2,}/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length < 3) {
    return { changed: false, text: original };
  }

  let merged = "";
  for (const segment of segments) {
    merged = mergeSnapshotText(merged, segment);
  }

  const compacted = merged.trim();
  if (!compacted) return { changed: false, text: original };
  if (compacted.length >= Math.floor(original.length * 0.9)) {
    return { changed: false, text: original };
  }
  return { changed: true, text: compacted };
}

function clampText(value, maxLen = 1200) {
  const raw = String(value || "");
  const limit = Math.max(64, Number(maxLen) || 1200);
  if (raw.length <= limit) return raw;
  return `${raw.slice(0, limit)}...(${raw.length - limit} chars truncated)`;
}

function normalizePatchPath(pathLike) {
  return String(pathLike || "").trim();
}

function normalizePatchAction(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (["a", "add", "added", "new", "create", "created"].includes(raw)) return "added";
  if (["m", "mod", "modify", "modified", "update", "updated", "change", "changed", "edit", "edited"].includes(raw)) {
    return "modified";
  }
  if (["d", "del", "delete", "deleted", "remove", "removed"].includes(raw)) return "deleted";
  if (["r", "ren", "rename", "renamed", "move", "moved"].includes(raw)) return "renamed";
  if (["c", "copy", "copied"].includes(raw)) return "copied";
  return "";
}

function compactPatchFileEntry(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === "string") {
    const text = normalizePatchPath(entry);
    if (!text) return null;
    return { path: clampText(text, 400) };
  }
  if (typeof entry !== "object") {
    const text = normalizePatchPath(entry);
    return text ? { path: clampText(text, 400) } : null;
  }

  const action = normalizePatchAction(entry.action || entry.status || entry.changeType || entry.op || entry.kind || entry.type);
  const from = normalizePatchPath(entry.from || entry.oldPath || entry.previousPath || entry.source || entry.src || "");
  const to = normalizePatchPath(entry.to || entry.newPath || entry.target || entry.dest || entry.dst || "");
  const path = normalizePatchPath(entry.path || entry.file || entry.filePath || entry.filename || entry.name || to || from || "");

  if (!path && !from && !to) return null;

  const out = {
    path: clampText(path, 400),
  };
  if (action) out.action = action;
  if (from) out.from = clampText(from, 400);
  if (to) out.to = clampText(to, 400);
  return out;
}

function compactJsonValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return clampText(value, 800);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return String(value);
  if (depth >= 3) {
    if (Array.isArray(value)) return `Array(${value.length})`;
    return "Object(...)";
  }
  if (Array.isArray(value)) {
    const out = value.slice(0, 24).map((item) => compactJsonValue(item, depth + 1));
    if (value.length > out.length) out.push(`...(${value.length - out.length} more)`);
    return out;
  }
  const out = {};
  const keys = Object.keys(value).slice(0, 40);
  for (const key of keys) {
    out[key] = compactJsonValue(value[key], depth + 1);
  }
  if (Object.keys(value).length > keys.length) {
    out.__truncated__ = `${Object.keys(value).length - keys.length} keys omitted`;
  }
  return out;
}

function compactBlockRaw(raw, type) {
  if (!raw || typeof raw !== "object") return raw;
  const normalizedType = String(type || raw.type || "").toLowerCase();
  const base = {
    id: typeof raw.id === "string" ? raw.id : "",
    type: normalizedType || (typeof raw.type === "string" ? raw.type : ""),
    messageID: typeof raw.messageID === "string" ? raw.messageID : "",
    sessionID: typeof raw.sessionID === "string" ? raw.sessionID : "",
  };
  const time = raw.time && typeof raw.time === "object" ? raw.time : null;
  if (time) {
    base.time = {
      start: Number(time.start || 0) || undefined,
      end: Number(time.end || 0) || undefined,
      created: Number(time.created || 0) || undefined,
      completed: Number(time.completed || 0) || undefined,
    };
  }

  if (normalizedType === "tool") {
    const state = raw.state && typeof raw.state === "object" ? raw.state : {};
    const input = state.input && typeof state.input === "object" ? state.input : {};
    base.tool = typeof raw.tool === "string" ? raw.tool : "";
    base.state = {
      status: typeof state.status === "string" ? state.status : "",
      input: compactJsonValue(input, 0),
      error: clampText(state.error || "", 1200),
    };
    return base;
  }

  if (normalizedType === "patch") {
    base.hash = typeof raw.hash === "string" ? raw.hash : "";
    base.files = Array.isArray(raw.files)
      ? raw.files
        .slice(0, 200)
        .map((item) => compactPatchFileEntry(item))
        .filter(Boolean)
      : [];
    return base;
  }

  if (normalizedType === "file") {
    base.filename = typeof raw.filename === "string" ? raw.filename : "";
    base.url = typeof raw.url === "string" ? clampText(raw.url, 400) : "";
    base.mime = typeof raw.mime === "string" ? raw.mime : "";
    return base;
  }

  if (normalizedType === "retry") {
    base.attempt = Number.isFinite(raw.attempt) ? Number(raw.attempt) : undefined;
    base.error = clampText(raw.error || "", 1200);
    return base;
  }

  return base;
}

function compactMessageBlocks(message) {
  const blocks = Array.isArray(message && message.blocks) ? message.blocks : null;
  if (!blocks || !blocks.length) return { changed: false, blocks };

  let changed = false;
  const nextBlocks = blocks.map((block) => {
    if (!block || typeof block !== "object") return block;
    if (!block.raw || typeof block.raw !== "object") return block;
    let rawSize = 0;
    try {
      rawSize = JSON.stringify(block.raw).length;
    } catch {
      rawSize = 0;
    }
    const type = String(block.type || "").toLowerCase();
    if (rawSize <= 3000 && type !== "reasoning") return block;

    const compactedRaw = compactBlockRaw(block.raw, type);
    let isSame = false;
    try {
      isSame = JSON.stringify(compactedRaw) === JSON.stringify(block.raw);
    } catch {
      isSame = false;
    }
    if (isSame) return block;
    changed = true;
    return Object.assign({}, block, { raw: compactedRaw });
  });

  return { changed, blocks: nextBlocks };
}

function migrateLegacyMessages(runtimeState) {
  const st = runtimeState && typeof runtimeState === "object" ? runtimeState : {};
  if (!st.messagesBySession || typeof st.messagesBySession !== "object") return st;

  for (const [sessionId, list] of Object.entries(st.messagesBySession)) {
    if (!Array.isArray(list)) continue;
    const normalizedList = list.length > 200 ? list.slice(-200) : list;
    st.messagesBySession[sessionId] = normalizedList.map((message) => {
      if (!message || typeof message !== "object") return message;
      if (message.role !== "assistant") return message;

      let next = message;
      let changed = false;

      const cleaned = splitLegacyMixedAssistantText(next.text || "");
      if (cleaned.changed) {
        next = Object.assign({}, next, {
          text: cleaned.text,
          reasoning: cleaned.reasoning,
        });
        changed = true;
      }

      const compactedReasoning = compactInflatedReasoning(next.reasoning || "");
      if (compactedReasoning.changed) {
        if (!changed) next = Object.assign({}, next);
        next.reasoning = compactedReasoning.text;
        changed = true;
      }

      const compactedBlocks = compactMessageBlocks(next);
      if (compactedBlocks.changed) {
        if (!changed) next = Object.assign({}, next);
        next.blocks = compactedBlocks.blocks;
        changed = true;
      }

      return changed ? next : message;
    });
  }
  return st;
}

module.exports = {
  migrateLegacyMessages,
};
