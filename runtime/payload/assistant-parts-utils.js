const { normalizedRenderableText } = require("./markdown-utils");

function joinUniqueTextChunks(chunks) {
  const unique = [];
  const seen = new Set();
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    const text = typeof chunk === "string" ? chunk.trim() : "";
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    unique.push(text);
  }
  return unique.join("\n\n");
}

function stablePartKey(part, index) {
  if (!part || typeof part !== "object") return `invalid:${index}`;
  if (typeof part.id === "string" && part.id.trim()) return `id:${part.id.trim()}`;
  const type = typeof part.type === "string" && part.type.trim() ? part.type.trim() : "part";
  const messageId = typeof part.messageID === "string" && part.messageID.trim() ? part.messageID.trim() : "";
  const time = part.time && typeof part.time === "object" ? part.time : null;
  const startAt = time ? Number(time.start || time.created || 0) : 0;
  if (startAt > 0) return `${type}:${messageId}:${startAt}`;
  const textPreview = normalizedRenderableText(typeof part.text === "string" ? part.text : "").slice(0, 48);
  return `${type}:${messageId}:${textPreview}:${index}`;
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

function collectPartText(chunksByPart, part, index, text) {
  const value = String(text || "");
  if (!value.trim()) return;
  const key = stablePartKey(part, index);
  if (!chunksByPart.has(key)) {
    chunksByPart.set(key, value);
    return;
  }
  const existing = String(chunksByPart.get(key) || "");
  chunksByPart.set(key, mergeSnapshotText(existing, value));
}

function joinPartTextChunks(chunksByPart) {
  return Array.from(chunksByPart.values())
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

function stringifyForDisplay(value, maxLen = 2200) {
  if (value === undefined || value === null) return "";
  let out = "";
  if (typeof value === "string") {
    out = value;
  } else {
    try {
      out = JSON.stringify(value, null, 2);
    } catch {
      out = String(value);
    }
  }
  if (out.length <= maxLen) return out;
  return `${out.slice(0, maxLen)}\n...(${out.length - maxLen} chars truncated)`;
}

function parseJsonObject(text) {
  if (typeof text !== "string") return null;
  const raw = text.trim();
  if (!raw || (!raw.startsWith("{") && !raw.startsWith("["))) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function makePreviewText(raw, maxLen = 320) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen)}...`;
}

function clampText(value, maxLen = 1200) {
  const raw = String(value || "");
  const limit = Math.max(64, Number(maxLen) || 1200);
  if (raw.length <= limit) return raw;
  return `${raw.slice(0, limit)}...(${raw.length - limit} chars truncated)`;
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
    const arr = value.slice(0, 24).map((item) => compactJsonValue(item, depth + 1));
    if (value.length > arr.length) arr.push(`...(${value.length - arr.length} more)`);
    return arr;
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

function compactPartRaw(part, type) {
  if (!part || typeof part !== "object") return null;
  const base = {
    id: typeof part.id === "string" ? part.id : "",
    type: typeof type === "string" ? type : (typeof part.type === "string" ? part.type : ""),
    messageID: typeof part.messageID === "string" ? part.messageID : "",
    sessionID: typeof part.sessionID === "string" ? part.sessionID : "",
  };
  const time = part.time && typeof part.time === "object" ? part.time : null;
  if (time) {
    base.time = {
      start: Number(time.start || 0) || undefined,
      end: Number(time.end || 0) || undefined,
      created: Number(time.created || 0) || undefined,
      completed: Number(time.completed || 0) || undefined,
    };
  }

  if (base.type === "tool") {
    const state = part.state && typeof part.state === "object" ? part.state : {};
    const input = state.input && typeof state.input === "object" ? state.input : {};
    base.tool = typeof part.tool === "string" ? part.tool : "";
    base.state = {
      status: typeof state.status === "string" ? state.status : "",
      input: compactJsonValue(input, 0),
      error: clampText(state.error || "", 1200),
    };
    return base;
  }

  if (base.type === "patch") {
    base.hash = typeof part.hash === "string" ? part.hash : "";
    base.files = Array.isArray(part.files)
      ? part.files.slice(0, 200).map((item) => clampText(item, 240))
      : [];
    return base;
  }

  if (base.type === "file") {
    base.filename = typeof part.filename === "string" ? part.filename : "";
    base.url = typeof part.url === "string" ? clampText(part.url, 400) : "";
    base.mime = typeof part.mime === "string" ? part.mime : "";
    return base;
  }

  if (base.type === "retry") {
    base.attempt = Number.isFinite(part.attempt) ? Number(part.attempt) : undefined;
    base.error = clampText(extractErrorText(part.error), 1200);
    return base;
  }

  if (base.type === "reasoning") {
    // Reasoning text is stored in block.detail/reasoning field; avoid duplicating large snapshots in raw.
    return base;
  }

  return base;
}

function toPartBlock(part, index) {
  if (!part || typeof part !== "object") return null;
  const type = typeof part.type === "string" ? part.type : "";
  if (!type || type === "text") return null;

  const id = typeof part.id === "string" && part.id ? part.id : `${type}:${index}`;
  const block = {
    id,
    type,
    title: type,
    summary: "",
    detail: "",
    status: "",
    metadata: null,
    raw: compactPartRaw(part, type),
    preview: "",
  };

  if (type === "reasoning") {
    const reasoningText = typeof part.text === "string" ? part.text : "";
    const time = part.time && typeof part.time === "object" ? part.time : {};
    const completed = Number(time.completed || 0) > 0;
    block.title = "思考过程";
    block.status = completed ? "completed" : "running";
    block.summary = "";
    block.detail = reasoningText;
    block.preview = makePreviewText(reasoningText, 220);
    return block;
  }

  if (type === "tool") {
    const toolName = typeof part.tool === "string" ? part.tool : "tool";
    const state = part.state && typeof part.state === "object" ? part.state : {};
    const status = typeof state.status === "string" ? state.status : "pending";
    const input = state.input && typeof state.input === "object" ? state.input : {};
    const displayName =
      (typeof state.title === "string" && state.title.trim()) ||
      (typeof input.skill === "string" && input.skill.trim() ? `Skill: ${input.skill.trim()}` : "") ||
      toolName;

    block.title = displayName;
    block.status = status;
    block.summary = `工具: ${toolName}`;
    block.metadata = state.metadata || null;
    block.tool = toolName;
    block.toolInput = input;
    block.toolOutput = typeof state.output === "string" ? clampText(state.output, 4000) : "";
    block.toolError = typeof state.error === "string" ? clampText(state.error, 1200) : "";
    block.attachments = Array.isArray(state.attachments) ? state.attachments : [];

    const chunks = [];
    if (toolName === "question" && Array.isArray(input.questions) && input.questions.length) {
      const lines = [];
      for (const question of input.questions) {
        if (!question || typeof question !== "object") continue;
        const q = typeof question.question === "string" ? question.question.trim() : "";
        if (!q) continue;
        lines.push(`问题: ${q}`);
        if (Array.isArray(question.options) && question.options.length) {
          lines.push(
            `选项: ${question.options
              .map((opt) => {
                if (opt && typeof opt === "object" && typeof opt.label === "string") {
                  return opt.label;
                }
                return String(opt);
              })
              .join(" / ")}`,
          );
        }
      }
      if (lines.length) {
        chunks.push(lines.join("\n"));
      }
    }

    if (Object.keys(input).length > 0) {
      chunks.push("输入:");
      chunks.push(stringifyForDisplay(input, 1400));
    }

    if (status === "completed") {
      if (typeof state.output === "string" && state.output.trim()) {
        chunks.push("输出:");
        chunks.push(stringifyForDisplay(state.output, 1800));
        block.preview = makePreviewText(state.output, 280);
        const parsedOutput = parseJsonObject(state.output);
        if (parsedOutput) {
          block.parsedOutput = parsedOutput;
        }
      }
      if (Array.isArray(state.attachments) && state.attachments.length) {
        const files = state.attachments
          .map((x) => x && (x.filename || x.url))
          .filter(Boolean)
          .map(String);
        if (files.length) {
          chunks.push("附件:");
          chunks.push(files.map((f) => `- ${f}`).join("\n"));
        }
      }
    } else if (status === "error") {
      const errText = typeof state.error === "string" ? state.error : "";
      if (errText.trim()) {
        chunks.push("错误:");
        chunks.push(errText.trim());
        block.preview = makePreviewText(errText, 220);
      }
    }

    if (!block.preview) {
      const pathLike =
        (typeof input.file_path === "string" && input.file_path) ||
        (typeof input.path === "string" && input.path) ||
        (typeof input.url === "string" && input.url) ||
        (typeof input.command === "string" && input.command) ||
        "";
      if (pathLike) block.preview = makePreviewText(pathLike, 220);
    }
    if (!block.preview && status === "completed") {
      block.preview = "该工具步骤已完成，但本次未返回可展示的 output。";
    }

    block.detail = chunks.join("\n");
    return block;
  }

  if (type === "step-start") {
    block.title = "步骤开始";
    block.status = "running";
    block.summary = typeof part.snapshot === "string" && part.snapshot ? "已创建步骤快照" : "";
    return block;
  }

  if (type === "step-finish") {
    block.title = "步骤完成";
    block.status = "completed";
    const reason = typeof part.reason === "string" ? part.reason : "";
    block.summary = reason || "step finished";
    const tokens = part.tokens && typeof part.tokens === "object" ? part.tokens : {};
    const inputTokens = Number(tokens.input || 0);
    const outputTokens = Number(tokens.output || 0);
    const reasoningTokens = Number(tokens.reasoning || 0);
    const cost = Number(part.cost || 0);
    block.detail = `cost: ${cost}\ntokens: in=${inputTokens}, out=${outputTokens}, reasoning=${reasoningTokens}`;
    return block;
  }

  if (type === "subtask") {
    block.title = `子任务: ${typeof part.agent === "string" ? part.agent : "agent"}`;
    block.status = "running";
    block.summary = typeof part.description === "string" ? part.description : "";
    block.detail = typeof part.prompt === "string" ? part.prompt : "";
    return block;
  }

  if (type === "agent") {
    block.title = `Agent: ${typeof part.name === "string" ? part.name : "unknown"}`;
    block.status = "running";
    block.summary = "正在执行子代理";
    if (part.source && typeof part.source === "object" && typeof part.source.value === "string") {
      block.detail = part.source.value;
    }
    return block;
  }

  if (type === "file") {
    const filename = typeof part.filename === "string" && part.filename ? part.filename : "";
    const url = typeof part.url === "string" ? part.url : "";
    block.title = `文件: ${filename || "attachment"}`;
    block.status = "completed";
    block.summary = typeof part.mime === "string" ? part.mime : "";
    block.detail = url;
    return block;
  }

  if (type === "patch") {
    block.title = "补丁";
    block.status = "completed";
    const hash = typeof part.hash === "string" ? part.hash : "";
    block.summary = hash ? `hash: ${hash.slice(0, 12)}` : "";
    block.detail = Array.isArray(part.files) ? part.files.map((f) => `- ${String(f)}`).join("\n") : "";
    return block;
  }

  if (type === "retry") {
    block.title = `重试 #${Number.isFinite(part.attempt) ? part.attempt : "?"}`;
    block.status = "error";
    block.summary = "请求失败后重试";
    block.detail = extractErrorText(part.error);
    return block;
  }

  if (type === "compaction") {
    block.title = "上下文压缩";
    block.status = "completed";
    block.summary = part.auto ? "自动压缩" : "手动压缩";
    return block;
  }

  if (type === "snapshot") {
    block.title = "会话快照";
    block.status = "completed";
    block.detail = typeof part.snapshot === "string" ? stringifyForDisplay(part.snapshot, 1200) : "";
    return block;
  }

  block.detail = stringifyForDisplay(part, 1000);
  return block;
}

function blocksFingerprint(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  try {
    return list
      .map((b) => {
        const detail = String(b && b.detail ? b.detail : "");
        const summary = String(b && b.summary ? b.summary : "").replace(/\s+/g, " ").trim();
        const title = String(b && b.title ? b.title : "").replace(/\s+/g, " ").trim();
        return [
          String((b && b.id) || ""),
          String((b && b.type) || ""),
          String((b && b.status) || ""),
          title.slice(0, 64),
          summary.slice(0, 96),
          String(detail.length),
        ].join("|");
      })
      .join("||");
  } catch {
    return String(list.length);
  }
}

function normalizeToolTargetKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.replace(/\\/g, "/").toLowerCase();
}

function resolveToolTargetKey(input) {
  if (!input || typeof input !== "object") return "";

  const directCandidates = [
    input.filePath,
    input.file_path,
    input.filepath,
    input.path,
    input.target,
    input.url,
    input.command,
  ];
  for (const value of directCandidates) {
    if (typeof value !== "string" || !value.trim()) continue;
    return normalizeToolTargetKey(value);
  }

  if (Array.isArray(input.paths) && input.paths.length) {
    const firstPath = input.paths.find((item) => typeof item === "string" && item.trim());
    if (firstPath) return normalizeToolTargetKey(firstPath);
  }

  return "";
}

function toolMetaKeyForPart(part, index) {
  const toolName = typeof part.tool === "string" && part.tool.trim()
    ? part.tool.trim().toLowerCase()
    : "tool";
  const state = part.state && typeof part.state === "object" ? part.state : {};
  const input = state.input && typeof state.input === "object" ? state.input : {};
  const targetKey = resolveToolTargetKey(input);
  if (targetKey) return `${toolName}:${targetKey}`;

  const fallbackId = typeof part.id === "string" && part.id.trim() ? part.id.trim() : `${index}`;
  return `${toolName}:id:${fallbackId}`;
}

function collectLatestToolErrorMeta(parts) {
  const latestByTarget = new Map();

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part || typeof part !== "object" || part.type !== "tool") continue;

    const state = part.state && typeof part.state === "object" ? part.state : {};
    const status = typeof state.status === "string" ? state.status.trim().toLowerCase() : "";
    const toolName = typeof part.tool === "string" && part.tool.trim() ? part.tool.trim() : "tool";
    const key = toolMetaKeyForPart(part, i);

    if (status === "completed") {
      latestByTarget.set(key, { status: "completed", toolName, error: "" });
      continue;
    }

    const isErrorStatus = status === "error" || status === "blocked";
    const errorText = typeof state.error === "string" ? state.error.trim() : "";
    if (!isErrorStatus || !errorText) continue;

    latestByTarget.set(key, { status: "error", toolName, error: errorText });
  }

  const chunks = [];
  for (const row of latestByTarget.values()) {
    if (!row || row.status !== "error") continue;
    chunks.push(`${row.toolName}: ${row.error}`);
  }
  return chunks;
}

function extractAssistantParts(parts) {
  if (!Array.isArray(parts)) return { text: "", reasoning: "", meta: "", blocks: [] };

  const textChunks = new Map();
  const reasoningChunks = new Map();
  const metaChunks = [];
  const blocks = [];

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part || typeof part !== "object") continue;
    const type = typeof part.type === "string" ? part.type : "";

    if (type === "text") {
      if (part.ignored === true) continue;
      if (typeof part.text === "string") collectPartText(textChunks, part, i, part.text);
      continue;
    }

    if (type === "reasoning") {
      if (typeof part.text === "string") collectPartText(reasoningChunks, part, i, part.text);
      const reasoningBlock = toPartBlock(part, i);
      if (reasoningBlock) blocks.push(reasoningBlock);
      continue;
    }

    if (type === "retry") {
      const retryError = extractErrorText(part.error);
      if (retryError) metaChunks.push(`retry: ${retryError}`);
    }

    if (!type && typeof part.text === "string") {
      collectPartText(textChunks, part, i, part.text);
      continue;
    }

    const block = toPartBlock(part, i);
    if (block) {
      blocks.push(block);
    }
  }

  return {
    text: joinPartTextChunks(textChunks),
    reasoning: joinPartTextChunks(reasoningChunks),
    meta: joinUniqueTextChunks([...metaChunks, ...collectLatestToolErrorMeta(parts)]),
    blocks,
  };
}

function extractErrorText(error) {
  const appendHint = (message) => {
    const msg = String(message || "").trim();
    if (!msg) return "";
    if (/OAuth authentication is currently not allowed/i.test(msg)) {
      return `${msg}（可输入 /models 或通过模型下拉选择官方模型；如需第三方模型请在设置的 Provider 登录管理里完成连接）`;
    }
    if (/(status\s*=\s*401|code['"]?\s*[:=]\s*401|unauthorized|user not found)/i.test(msg)) {
      return `${msg}（鉴权失败：请在设置 → Provider 登录管理里重新登录当前 Provider。若在 Windows WSL 运行，请确认在同一 WSL 发行版下完成登录后再刷新 Provider 状态）`;
    }
    return msg;
  };

  if (typeof error === "string") {
    return appendHint(error);
  }
  if (!error || typeof error !== "object") return "";

  const name = typeof error.name === "string" ? error.name : "AssistantError";
  const data = error.data && typeof error.data === "object" ? error.data : {};
  const root = error && typeof error === "object" ? error : {};

  const message =
    (typeof data.message === "string" && data.message.trim()) ||
    (typeof root.message === "string" && root.message.trim()) ||
    (typeof data.responseBody === "string" && data.responseBody.trim()) ||
    (typeof root.responseBody === "string" && root.responseBody.trim()) ||
    "";
  const providerId =
    (typeof data.providerID === "string" && data.providerID.trim()) ||
    (typeof root.providerID === "string" && root.providerID.trim()) ||
    "";
  const provider = providerId ? ` provider=${providerId}` : "";
  const statusCode =
    (Number.isFinite(data.statusCode) && Number(data.statusCode)) ||
    (Number.isFinite(root.statusCode) && Number(root.statusCode)) ||
    (Number.isFinite(root.status) && Number(root.status)) ||
    0;
  const status = statusCode ? ` status=${statusCode}` : "";

  if (message) {
    return `${name}${status}${provider}: ${appendHint(message)}`;
  }
  try {
    return `${name}${status}${provider}: ${JSON.stringify(error)}`;
  } catch {
    return `${name}${status}${provider}`;
  }
}

function looksLikeInternalPromptLeak(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  if (/\[analyze-mode\]/i.test(value) && /ANALYSIS MODE\./i.test(value)) return true;
  if (/你当前要遵循技能/.test(value) && /技能摘要[:：]/.test(value) && /用户请求如下[:：]/.test(value)) return true;
  return false;
}

function extractAssistantPayloadFromEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") return { text: "", reasoning: "", meta: "", blocks: [] };

  const info = envelope.info && typeof envelope.info === "object" ? envelope.info : {};
  const role = typeof info.role === "string" ? info.role.trim().toLowerCase() : "";
  const errorText = extractErrorText(info.error);
  if (role && role !== "assistant") {
    if (errorText) {
      return { text: `模型返回错误：${errorText}`, reasoning: "", meta: errorText, blocks: [] };
    }
    return { text: "", reasoning: "", meta: "", blocks: [] };
  }

  const extracted = extractAssistantParts(Array.isArray(envelope.parts) ? envelope.parts : []);
  let text = extracted.text;
  const reasoning = extracted.reasoning;
  const meta = extracted.meta;
  const blocks = extracted.blocks || [];

  if (!text && errorText) {
    text = `模型返回错误：${errorText}`;
  }

  if (!text && info.summary && typeof info.summary === "object") {
    const title = typeof info.summary.title === "string" ? info.summary.title.trim() : "";
    const body = typeof info.summary.body === "string" ? info.summary.body.trim() : "";
    const out = [title, body].filter(Boolean).join("\n\n");
    if (out) text = out;
  }

  if (text && looksLikeInternalPromptLeak(text)) {
    text = "";
  }

  return { text, reasoning, meta, blocks };
}

function formatSessionStatusText(status) {
  if (!status || typeof status !== "object") return "unknown";
  const nested = status.status && typeof status.status === "object"
    ? status.status
    : status.state && typeof status.state === "object"
      ? status.state
      : null;
  const typeRaw =
    (typeof status.type === "string" && status.type.trim()) ||
    (typeof status.status === "string" && status.status.trim()) ||
    (typeof status.state === "string" && status.state.trim()) ||
    (nested && typeof nested.type === "string" && nested.type.trim()) ||
    (nested && typeof nested.status === "string" && nested.status.trim()) ||
    (nested && typeof nested.state === "string" && nested.state.trim()) ||
    "";
  const type = String(typeRaw || "").toLowerCase();
  const messageRaw =
    (typeof status.message === "string" && status.message.trim()) ||
    (typeof status.error === "string" && status.error.trim()) ||
    (typeof status.reason === "string" && status.reason.trim()) ||
    (nested && typeof nested.message === "string" && nested.message.trim()) ||
    (nested && typeof nested.error === "string" && nested.error.trim()) ||
    (nested && typeof nested.reason === "string" && nested.reason.trim()) ||
    "";
  const message = String(messageRaw || "").replace(/\s+/g, " ").trim();
  if (type === "idle") return "idle";
  if (type === "busy") return "busy";
  if (type === "retry") {
    const attempt = Number.isFinite(status.attempt)
      ? status.attempt
      : nested && Number.isFinite(nested.attempt)
        ? nested.attempt
        : "?";
    return `retry(attempt=${attempt}${message ? `, message=${message}` : ""})`;
  }
  if (type) return message ? `${type}(message=${message})` : type;
  if (message) return `unknown(message=${message})`;
  return "unknown";
}

module.exports = {
  joinUniqueTextChunks,
  mergeSnapshotText,
  stringifyForDisplay,
  parseJsonObject,
  makePreviewText,
  toPartBlock,
  blocksFingerprint,
  extractAssistantParts,
  extractErrorText,
  looksLikeInternalPromptLeak,
  extractAssistantPayloadFromEnvelope,
  formatSessionStatusText,
  normalizedRenderableText,
};
