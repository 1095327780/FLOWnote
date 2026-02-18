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
    raw: part,
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
    block.toolOutput = typeof state.output === "string" ? state.output : "";
    block.toolError = typeof state.error === "string" ? state.error : "";
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
    return JSON.stringify(
      list.map((b) => ({
        id: b.id,
        type: b.type,
        title: b.title,
        status: b.status,
        summary: b.summary,
        detail: b.detail,
      })),
    );
  } catch {
    return String(list.length);
  }
}

function extractAssistantParts(parts) {
  if (!Array.isArray(parts)) return { text: "", reasoning: "", meta: "", blocks: [] };

  const textChunks = [];
  const reasoningChunks = [];
  const metaChunks = [];
  const blocks = [];

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part || typeof part !== "object") continue;
    const type = typeof part.type === "string" ? part.type : "";

    if (type === "text") {
      if (part.ignored === true) continue;
      if (typeof part.text === "string") textChunks.push(part.text);
      continue;
    }

    if (type === "reasoning") {
      if (typeof part.text === "string") reasoningChunks.push(part.text);
      const reasoningBlock = toPartBlock(part, i);
      if (reasoningBlock) blocks.push(reasoningBlock);
      continue;
    }

    if (type === "tool") {
      const state = part.state && typeof part.state === "object" ? part.state : null;
      if (state && state.status === "error" && typeof state.error === "string" && state.error.trim()) {
        const toolName = typeof part.tool === "string" ? part.tool : "tool";
        metaChunks.push(`${toolName}: ${state.error.trim()}`);
      }
    }

    if (type === "retry") {
      const retryError = extractErrorText(part.error);
      if (retryError) metaChunks.push(`retry: ${retryError}`);
    }

    if (!type && typeof part.text === "string") {
      textChunks.push(part.text);
      continue;
    }

    const block = toPartBlock(part, i);
    if (block) {
      blocks.push(block);
    }
  }

  return {
    text: joinUniqueTextChunks(textChunks),
    reasoning: joinUniqueTextChunks(reasoningChunks),
    meta: joinUniqueTextChunks(metaChunks),
    blocks,
  };
}

function extractErrorText(error) {
  if (!error || typeof error !== "object") return "";
  const name = typeof error.name === "string" ? error.name : "AssistantError";
  const data = error.data && typeof error.data === "object" ? error.data : {};

  const message =
    (typeof data.message === "string" && data.message.trim()) ||
    (typeof data.responseBody === "string" && data.responseBody.trim()) ||
    "";
  const provider = typeof data.providerID === "string" && data.providerID ? ` provider=${data.providerID}` : "";
  const status = Number.isFinite(data.statusCode) ? ` status=${data.statusCode}` : "";

  if (message) {
    let hint = "";
    if (/OAuth authentication is currently not allowed/i.test(message)) {
      hint = "（可输入 /models 或点击“模型 /models”打开官方模型选择器；也可在设置里切到 custom-api-key 并填写 Provider/API Key）";
    }
    return `${name}${status}${provider}: ${message}${hint}`;
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
  const role = typeof info.role === "string" ? info.role : "";
  if (role && role !== "assistant") {
    return { text: "", reasoning: "", meta: "", blocks: [] };
  }

  const extracted = extractAssistantParts(Array.isArray(envelope.parts) ? envelope.parts : []);
  let text = extracted.text;
  const reasoning = extracted.reasoning;
  const meta = extracted.meta;
  const blocks = extracted.blocks || [];

  const errorText = extractErrorText(info.error);
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
  if (status.type === "idle") return "idle";
  if (status.type === "busy") return "busy";
  if (status.type === "retry") {
    const attempt = Number.isFinite(status.attempt) ? status.attempt : "?";
    const message = typeof status.message === "string" ? status.message : "";
    return `retry(attempt=${attempt}${message ? `, message=${message}` : ""})`;
  }
  return "unknown";
}

module.exports = {
  joinUniqueTextChunks,
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
