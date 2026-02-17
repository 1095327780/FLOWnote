console.log("[opencode-assistant] runtime main.js v0.3.33 loaded");

const {
  ItemView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  MarkdownRenderer,
  Modal,
  setIcon,
} = require("obsidian");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const { execFile, spawn } = require("child_process");
const { pathToFileURL } = require("url");

const VIEW_TYPE = "opencode-assistant-view";

const DEFAULT_SETTINGS = {
  transportMode: "sdk",
  cliPath: "",
  autoDetectCli: true,
  skillsDir: ".opencode/skills",
  skillInjectMode: "summary",
  defaultModel: "",
  authMode: "opencode-default",
  customProviderId: "openai",
  customApiKey: "",
  customBaseUrl: "",
  requestTimeoutMs: 120000,
  enableStreaming: true,
  debugLogs: false,
  opencodeHomeDir: ".opencode-runtime",
};

function migrateLegacySettings(raw) {
  const data = raw || {};

  if (typeof data.useCustomApiKey === "boolean") {
    data.authMode = data.useCustomApiKey ? "custom-api-key" : "opencode-default";
    delete data.useCustomApiKey;
  }

  if (!data.transportMode) data.transportMode = "sdk";

  if (data.prependSkillPrompt === false && !data.skillInjectMode) data.skillInjectMode = "off";
  if (data.prependSkillPrompt === true && !data.skillInjectMode) data.skillInjectMode = "summary";
  delete data.prependSkillPrompt;

  return data;
}

function normalizeSettings(raw) {
  const merged = Object.assign({}, DEFAULT_SETTINGS, migrateLegacySettings(raw));

  if (!["sdk", "compat"].includes(merged.transportMode)) merged.transportMode = "sdk";
  if (!["summary", "full", "off"].includes(merged.skillInjectMode)) merged.skillInjectMode = "summary";
  if (!["opencode-default", "custom-api-key"].includes(merged.authMode)) merged.authMode = "opencode-default";

  merged.requestTimeoutMs = Math.max(10000, Number(merged.requestTimeoutMs) || DEFAULT_SETTINGS.requestTimeoutMs);
  merged.cliPath = String(merged.cliPath || "").trim();
  merged.skillsDir = String(merged.skillsDir || DEFAULT_SETTINGS.skillsDir).trim();
  merged.defaultModel = String(merged.defaultModel || "").trim();
  merged.customProviderId = String(merged.customProviderId || "openai").trim();
  merged.customApiKey = String(merged.customApiKey || "").trim();
  merged.customBaseUrl = String(merged.customBaseUrl || "").trim();

  return merged;
}

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function splitPathEntries(envPath) {
  const sep = process.platform === "win32" ? ";" : ":";
  return String(envPath || "").split(sep).filter(Boolean);
}

function findInPath(binaryName) {
  const out = [];
  for (const p of splitPathEntries(process.env.PATH)) {
    const base = path.join(p, binaryName);
    out.push(base);
    if (process.platform === "win32") {
      out.push(`${base}.exe`);
      out.push(`${base}.cmd`);
    }
  }
  return out;
}

function which(binaryName) {
  const cmd = process.platform === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    execFile(cmd, [binaryName], { timeout: 2000 }, (error, stdout) => {
      if (error) return resolve([]);
      resolve(
        String(stdout || "")
          .split(/\r?\n/)
          .map((x) => x.trim())
          .filter(Boolean),
      );
    });
  });
}

class ExecutableResolver {
  async resolve(cliPath) {
    const attempted = [];
    const candidates = [];

    if (cliPath) candidates.push(expandHome(cliPath));
    candidates.push(...findInPath("opencode"));
    candidates.push(expandHome("~/.opencode/bin/opencode"));
    candidates.push(...(await which("opencode")));

    const unique = [...new Set(candidates.filter(Boolean))];

    for (const c of unique) {
      attempted.push(c);
      if (!fs.existsSync(c)) continue;
      if (!isExecutable(c)) continue;
      return { ok: true, path: c, attempted };
    }

    return {
      ok: false,
      path: "",
      attempted,
      hint: `未找到可执行文件。请在设置里填写绝对路径，例如 ${expandHome("~/.opencode/bin/opencode")}`,
    };
  }
}

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { attrs: {}, body: md };

  const attrs = {};
  const lines = m[1].split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    const i = line.indexOf(":");
    if (i <= 0) continue;

    const key = line.slice(0, i).trim();
    const rawValue = line.slice(i + 1).trim();

    const blockScalar = rawValue.match(/^([>|])([+-])?$/);
    if (blockScalar) {
      const block = [];
      idx += 1;
      while (idx < lines.length) {
        const next = lines[idx];
        if (!/^\s+/.test(next)) {
          idx -= 1;
          break;
        }
        block.push(next.replace(/^\s+/, ""));
        idx += 1;
      }
      attrs[key] = block.join("\n").trim();
      continue;
    }

    attrs[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }

  return { attrs, body: md.slice(m[0].length) };
}

function summarizeBody(body) {
  return body
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 18)
    .join("\n");
}

function copyDirectoryRecursive(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry || String(entry.name || "").startsWith(".")) continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
      continue;
    }

    if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

class SkillService {
  constructor(vaultPath, settings) {
    this.vaultPath = vaultPath;
    this.settings = settings;
    this.cache = [];
    this.allowedSkillIds = null;
  }

  updateSettings(settings) {
    this.settings = settings;
  }

  setAllowedSkillIds(skillIds) {
    if (!skillIds) {
      this.allowedSkillIds = null;
      return;
    }

    const ids = Array.isArray(skillIds) ? skillIds : Array.from(skillIds);
    const normalized = ids
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    this.allowedSkillIds = new Set(normalized);
  }

  loadSkills() {
    const root = path.join(this.vaultPath, this.settings.skillsDir);
    if (!fs.existsSync(root)) {
      this.cache = [];
      return this.cache;
    }

    const entries = fs.readdirSync(root, { withFileTypes: true });
    const allow = this.allowedSkillIds instanceof Set
      ? this.allowedSkillIds
      : null;
    const skills = [];

    for (const e of entries) {
      if (!e || String(e.name || "").startsWith(".")) continue;
      if (!e.isDirectory()) continue;
      if (allow && !allow.has(e.name)) continue;
      const file = path.join(root, e.name, "SKILL.md");
      if (!fs.existsSync(file)) continue;

      const raw = fs.readFileSync(file, "utf8");
      const parsed = parseFrontmatter(raw);
      skills.push({
        id: e.name,
        name: parsed.attrs.name || e.name,
        description: parsed.attrs.description || "",
        metadata: parsed.attrs,
        content: raw,
        summary: summarizeBody(parsed.body),
        path: file,
      });
    }

    skills.sort((a, b) => a.name.localeCompare(b.name));
    this.cache = skills;
    return skills;
  }

  getSkills() {
    return this.cache;
  }

  buildInjectedPrompt(skill, mode, userPrompt) {
    if (!skill || mode === "off") return userPrompt;

    if (mode === "full") {
      return [
        `你当前要遵循技能 ${skill.name}。`,
        "技能文档如下：",
        skill.content,
        "用户请求如下：",
        userPrompt,
      ].join("\n\n");
    }

    return [
      `你当前要遵循技能 ${skill.name}。`,
      `技能说明：${skill.description || "无"}`,
      "技能摘要：",
      skill.summary,
      "用户请求如下：",
      userPrompt,
    ].join("\n\n");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  if (!type || type === "text" || type === "reasoning") return null;

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

    // Fallback for loose/legacy payloads that contain text without type.
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

function normalizedRenderableText(text) {
  return String(text || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

function normalizeMarkdownSpacing(text) {
  const raw = String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+\n/g, "\n\n");
  if (!raw.trim()) return "";

  const segments = raw.split(/(```[\s\S]*?```)/g);
  const normalized = segments.map((segment) => {
    if (!segment) return "";
    if (segment.startsWith("```")) return segment;

    let out = segment;
    out = out.replace(/\n{3,}/g, "\n\n");
    out = out.replace(/\n{2,}(?=[ \t]*(?:[-*+]|\d+\.)\s)/g, "\n");
    out = out.replace(/(^|\n)([ \t]*(?:[-*+]|\d+\.)[^\n]*)\n{2,}(?=[ \t]*(?:[-*+]|\d+\.)\s)/g, "$1$2\n");
    out = out.replace(/\n{3,}/g, "\n\n");
    return out;
  });

  return normalized.join("").trim();
}

function normalizeMarkdownForDisplay(text) {
  return normalizeMarkdownSpacing(normalizedRenderableText(text));
}

function hasRenderablePayload(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const textLen = normalizedRenderableText(p.text || "").length;
  const reasoningLen = String(p.reasoning || "").trim().length;
  const blocksLen = Array.isArray(p.blocks) ? p.blocks.length : 0;
  return textLen > 0 || reasoningLen > 0 || blocksLen > 0;
}

function hasSufficientPayload(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const textLen = normalizedRenderableText(p.text || "").length;
  const reasoningLen = String(p.reasoning || "").trim().length;
  const blocksLen = Array.isArray(p.blocks) ? p.blocks.length : 0;
  if (textLen > 1) return true;
  if (blocksLen > 0) return true;
  if (reasoningLen > 40) return true;
  return false;
}

function isIntermediateToolCallPayload(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const text = normalizedRenderableText(p.text || "");
  const blocks = Array.isArray(p.blocks) ? p.blocks : [];
  const hasToolBlock = blocks.some((b) => b && b.type === "tool");
  const hasToolCallsFinish = blocks.some(
    (b) => b && b.type === "step-finish" && String(b.summary || "").trim().toLowerCase() === "tool-calls",
  );
  if (!hasToolBlock || !hasToolCallsFinish) return false;
  if (!text) return true;
  if (/^\d+$/.test(text)) return true;
  if (text.length <= 1) return true;
  return false;
}

function hasTerminalStepFinish(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const blocks = Array.isArray(p.blocks) ? p.blocks : [];
  for (const b of blocks) {
    if (!b || b.type !== "step-finish") continue;
    const reason = String(b.summary || "").trim().toLowerCase();
    if (!reason) continue;
    if (reason === "tool-calls") continue;
    return true;
  }
  return false;
}

function payloadLooksInProgress(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const blocks = Array.isArray(p.blocks) ? p.blocks : [];
  const hasTool = blocks.some((b) => b && b.type === "tool");
  const hasStepStart = blocks.some((b) => b && b.type === "step-start");
  const hasTerminalFinish = hasTerminalStepFinish(payload);
  const hasToolCallsFinish = blocks.some(
    (b) => b && b.type === "step-finish" && String(b.summary || "").trim().toLowerCase() === "tool-calls",
  );
  if (hasTerminalFinish) return false;
  if (hasToolCallsFinish) return true;
  if (hasTool) return true;
  if (hasStepStart) return true;
  return false;
}

function hasTerminalPayload(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  if (hasTerminalStepFinish(p)) return true;
  if (payloadLooksInProgress(p)) return false;
  if (normalizedRenderableText(p.text || "").length > 1) return true;
  return false;
}

function responseRichnessScore(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const text = normalizedRenderableText(p.text || "");
  const reasoning = String(p.reasoning || "").trim();
  const blocks = Array.isArray(p.blocks) ? p.blocks : [];
  const meta = String(p.meta || "").trim();
  const hasFallbackText = /^\(无文本返回：session\.status=/.test(text);
  const terminal = hasTerminalPayload(p);
  const inProgress = payloadLooksInProgress(p);

  let score = 0;
  score += Math.min(text.length, 400) * 1.4;
  score += Math.min(reasoning.length, 300) * 0.45;
  score += Math.min(blocks.length, 10) * 8;
  score += Math.min(meta.length, 200) * 0.15;
  if (terminal) score += 120;
  if (inProgress) score -= 40;
  if (hasFallbackText) score -= 30;
  return score;
}

function mergeBlockLists(primaryBlocks, secondaryBlocks) {
  const out = [];
  const indexByKey = new Map();
  const statusRank = (value) => {
    const status = String(value || "").trim().toLowerCase();
    if (status === "error") return 4;
    if (status === "completed") return 3;
    if (status === "running") return 2;
    if (status === "pending") return 1;
    return 0;
  };
  const lists = [Array.isArray(primaryBlocks) ? primaryBlocks : [], Array.isArray(secondaryBlocks) ? secondaryBlocks : []];
  for (const list of lists) {
    for (let idx = 0; idx < list.length; idx += 1) {
      const block = list[idx];
      if (!block || typeof block !== "object") continue;
      const key = String(block.id || "") || `${String(block.type || "block")}::${String(block.title || "")}::${String(block.summary || "")}::${idx}`;
      if (!indexByKey.has(key)) {
        indexByKey.set(key, out.length);
        out.push(block);
        continue;
      }

      const existingIndex = Number(indexByKey.get(key));
      const existing = out[existingIndex];
      const existingRank = statusRank(existing && existing.status);
      const nextRank = statusRank(block.status);
      const existingDetailLen = String(existing && existing.detail ? existing.detail : "").length;
      const nextDetailLen = String(block.detail || "").length;
      const shouldReplace = nextRank > existingRank || (nextRank === existingRank && nextDetailLen > existingDetailLen);
      if (shouldReplace) {
        out[existingIndex] = block;
      }
    }
  }
  return out;
}

function mergeAssistantPayload(preferred, fallback) {
  if (!fallback) return preferred;
  if (!preferred) return fallback;

  const p = preferred && typeof preferred === "object" ? preferred : {};
  const f = fallback && typeof fallback === "object" ? fallback : {};
  const pMessageId = String(p.messageId || "").trim();
  const fMessageId = String(f.messageId || "").trim();
  if (pMessageId && fMessageId && pMessageId !== fMessageId) {
    return preferred;
  }

  return {
    messageId: pMessageId || fMessageId || "",
    text: normalizedRenderableText(p.text || "") ? String(p.text || "") : String(f.text || ""),
    reasoning: String(p.reasoning || "").trim() ? String(p.reasoning || "") : String(f.reasoning || ""),
    meta: String(p.meta || "").trim() ? String(p.meta || "") : String(f.meta || ""),
    blocks: mergeBlockLists(p.blocks, f.blocks),
  };
}

function chooseRicherResponse(primary, secondary) {
  if (!secondary) return primary;
  if (!primary) return secondary;

  const p = primary && typeof primary === "object" ? primary : {};
  const s = secondary && typeof secondary === "object" ? secondary : {};
  const pTextLen = normalizedRenderableText(p.text || "").length;
  const sTextLen = normalizedRenderableText(s.text || "").length;
  const pTerminal = hasTerminalPayload(p);
  const sTerminal = hasTerminalPayload(s);

  // 优先保留真正可交付给用户的终态文本，避免被“工具调用中间态”覆盖。
  if (sTerminal && !pTerminal) return mergeAssistantPayload(secondary, primary);
  if (pTerminal && !sTerminal) return mergeAssistantPayload(primary, secondary);
  if (sTextLen > 0 && pTextLen === 0) return mergeAssistantPayload(secondary, primary);
  if (pTextLen > 0 && sTextLen === 0) return mergeAssistantPayload(primary, secondary);

  const pScore = responseRichnessScore(primary);
  const sScore = responseRichnessScore(secondary);
  return sScore >= pScore
    ? mergeAssistantPayload(secondary, primary)
    : mergeAssistantPayload(primary, secondary);
}

async function streamPseudo(text, onToken, signal) {
  if (!onToken) return;
  const tokens = text.match(/.{1,16}/g) || [text];
  let current = "";

  for (const t of tokens) {
    if (signal && signal.aborted) throw new Error("用户取消了请求");
    current += t;
    onToken(current);
    await sleep(20);
  }
}

function nodeHttpRequestJson(url, method, body, timeoutMs, signal) {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === "https:";
  const client = isHttps ? https : http;

  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = {
    accept: "application/json, text/plain, */*",
  };
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      fn(value);
    };

    let onAbort = null;

    console.log(`[opencode-assistant] HTTP ${method} ${parsed.pathname}${parsed.search}`);
    const req = client.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          console.log(`[opencode-assistant] HTTP ${method} ${parsed.pathname} -> ${res.statusCode}`);
          finish(resolve, {
            status: Number(res.statusCode || 0),
            text,
          });
        });
      },
    );

    req.on("error", (err) => finish(reject, err));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时 (${timeoutMs}ms)`));
    });

    if (signal) {
      onAbort = () => req.destroy(new Error("用户取消了请求"));
      if (signal.aborted) {
        req.destroy(new Error("用户取消了请求"));
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function nodeHttpRequestSse(url, timeoutMs, signal, handlers) {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === "https:";
  const client = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      fn(value);
    };

    const consumeSseChunk = (chunk) => {
      const textChunk = String(chunk || "").replace(/\r/g, "");
      if (!textChunk) return;
      buffer += textChunk;

      let splitIndex = buffer.indexOf("\n\n");
      while (splitIndex >= 0) {
        const block = buffer.slice(0, splitIndex);
        buffer = buffer.slice(splitIndex + 2);
        splitIndex = buffer.indexOf("\n\n");

        if (!block.trim()) continue;
        const lines = block.split("\n");
        const dataLines = [];
        let eventName = "";
        let eventId = "";
        let retry = "";

        for (const line of lines) {
          if (line.startsWith("data:")) {
            dataLines.push(line.replace(/^data:\s*/, ""));
          } else if (line.startsWith("event:")) {
            eventName = line.replace(/^event:\s*/, "");
          } else if (line.startsWith("id:")) {
            eventId = line.replace(/^id:\s*/, "");
          } else if (line.startsWith("retry:")) {
            retry = line.replace(/^retry:\s*/, "");
          }
        }

        if (!dataLines.length) continue;
        const rawData = dataLines.join("\n");
        let payload = rawData;
        try {
          payload = JSON.parse(rawData);
        } catch {
          payload = rawData;
        }

        if (handlers && typeof handlers.onEvent === "function") {
          handlers.onEvent(payload, { event: eventName, id: eventId, retry });
        }

        if (handlers && typeof handlers.shouldStop === "function" && handlers.shouldStop()) {
          finish(resolve);
          req.destroy();
          return;
        }
      }
    };

    let onAbort = null;
    const req = client.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers: {
          accept: "text/event-stream",
        },
      },
      (res) => {
        const status = Number(res.statusCode || 0);
        if (status < 200 || status >= 300) {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            finish(reject, new Error(`SSE 请求失败 (${status}): ${body}`));
          });
          return;
        }

        res.on("data", consumeSseChunk);
        res.on("end", () => finish(resolve));
        res.on("error", (err) => finish(reject, err));
      },
    );

    req.on("error", (err) => finish(reject, err));
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`SSE 超时 (${timeoutMs}ms)`)));

    if (signal) {
      onAbort = () => req.destroy(new Error("用户取消了请求"));
      if (signal.aborted) {
        req.destroy(new Error("用户取消了请求"));
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    req.end();
  });
}

function createLinkedAbortController(signal) {
  const controller = new AbortController();
  let off = () => {};

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      const onAbort = () => controller.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      off = () => signal.removeEventListener("abort", onAbort);
    }
  }

  return { controller, detach: off };
}

class SdkTransport {
  constructor(options) {
    this.vaultPath = options.vaultPath;
    this.settings = options.settings;
    this.client = null;
    this.commandCache = {
      at: 0,
      items: [],
    };
  }

  log(line) {
    console.log(`[opencode-assistant] ${line}`);
  }

  updateSettings(settings) {
    this.settings = settings;
  }

  async ensureClient() {
    if (this.client) return this.client;

    let mod = null;
    const importErrors = [];
    try {
      mod = await import("@opencode-ai/sdk/v2/client");
    } catch (e) {
      importErrors.push(`@opencode-ai/sdk/v2/client: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!mod) {
      const local = path.join(this.vaultPath, ".opencode/node_modules/@opencode-ai/sdk/dist/v2/client.js");
      try {
        mod = await import(pathToFileURL(local).href);
      } catch (e) {
        importErrors.push(`${local}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (!mod || typeof mod.createOpencodeClient !== "function") {
      const details = importErrors.length ? `；${importErrors.join(" | ")}` : "";
      throw new Error(`OpenCode SDK(v2) 加载失败：createOpencodeClient 不可用${details}`);
    }

    this.client = mod.createOpencodeClient({
      directory: this.vaultPath,
      throwOnError: true,
      timeout: this.settings.requestTimeoutMs,
    });

    return this.client;
  }

  parseModel() {
    if (!this.settings.defaultModel.includes("/")) return undefined;
    const [providerID, modelID] = this.settings.defaultModel.split("/");
    if (!providerID || !modelID) return undefined;
    return { providerID, modelID };
  }

  parseCommandModel() {
    const model = String(this.settings.defaultModel || "").trim();
    if (!model.includes("/")) return undefined;
    return model;
  }

  async testConnection() {
    const client = await this.ensureClient();
    await client.path.get({ directory: this.vaultPath });
    return { ok: true, mode: "sdk" };
  }

  async listSessions() {
    const client = await this.ensureClient();
    const res = await client.session.list({ directory: this.vaultPath });
    return res.data || [];
  }

  async createSession(title) {
    const client = await this.ensureClient();
    const res = await client.session.create(title ? { directory: this.vaultPath, title } : { directory: this.vaultPath });
    return res.data;
  }

  async listModels() {
    try {
      const client = await this.ensureClient();
      const res = await client.config.providers({ directory: this.vaultPath });
      const providers = res.data || [];
      const out = [];
      for (const p of providers) {
        const models = p.models || {};
        for (const key of Object.keys(models)) out.push(`${p.id}/${key}`);
      }
      return out.sort();
    } catch {
      return [];
    }
  }

  async listCommands() {
    const now = Date.now();
    if (now - this.commandCache.at < 30000 && this.commandCache.items.length) {
      return this.commandCache.items;
    }

    try {
      const client = await this.ensureClient();
      const res = await client.command.list({ directory: this.vaultPath });
      const payload = res && res.data ? res.data : res || [];
      const items = Array.isArray(payload) ? payload : Array.isArray(payload.commands) ? payload.commands : [];
      this.commandCache = {
        at: now,
        items: Array.isArray(items) ? items : [],
      };
      return this.commandCache.items;
    } catch {
      return [];
    }
  }

  normalizeSlashCommandName(commandName) {
    const normalized = String(commandName || "").trim().replace(/^\//, "").toLowerCase();
    if (normalized === "modle") return "model";
    return normalized;
  }

  availableCommandSet(list) {
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

  async resolveCommandForEndpoint(commandName) {
    const normalized = this.normalizeSlashCommandName(commandName);
    if (!normalized) return { use: false, command: "" };

    const list = await this.listCommands();
    const names = this.availableCommandSet(list);

    if (names.has(normalized)) {
      return { use: true, command: normalized };
    }
    if (normalized === "model" && names.has("models")) return { use: true, command: "models" };
    if (normalized === "models" && names.has("model")) return { use: true, command: "model" };
    return { use: false, command: normalized };
  }

  parseSlashCommand(prompt) {
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

  async ensureAuth() {
    if (this.settings.authMode !== "custom-api-key") return;
    if (!this.settings.customApiKey.trim()) throw new Error("当前是自定义 API Key 模式，但 API Key 为空");

    const client = await this.ensureClient();
    const providerId = this.settings.customProviderId.trim();

    await client.auth.set({
      providerID: providerId,
      auth: { type: "api", key: this.settings.customApiKey.trim() },
    });

    if (this.settings.customBaseUrl.trim()) {
      await client.config.update({
        directory: this.vaultPath,
        config: {
          provider: {
            [providerId]: {
              options: {
                baseURL: this.settings.customBaseUrl.trim(),
              },
            },
          },
        },
      });
    }
  }

  async getSessionStatus(sessionId, signal) {
    try {
      const client = await this.ensureClient();
      const res = await client.session.status({ directory: this.vaultPath }, { signal });
      const payload = res && res.data ? res.data : res;
      if (!payload || typeof payload !== "object") return null;
      return payload[sessionId] || null;
    } catch {
      return null;
    }
  }

  findLatestAssistantMessage(messages, startedAt) {
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

  async pollAssistantResult(client, sessionId, startedAt, signal, preferredMessageId = "", handlers) {
    const quietTimeoutMs = Math.max(10000, Number(this.settings.requestTimeoutMs) || 120000);
    const maxTotalMs = Math.max(quietTimeoutMs * 2, 5 * 60 * 1000);
    const started = Date.now();
    let lastProgressAt = started;
    let messageId = preferredMessageId;
    let payload = { text: "", reasoning: "", meta: "", blocks: [] };
    let payloadKey = `${normalizedRenderableText(payload.text)}|${payload.reasoning}|${blocksFingerprint(payload.blocks)}`;
    let lastStatus = null;

    const onPayloadChange = () => {
      const nextKey = `${normalizedRenderableText(payload.text)}|${payload.reasoning}|${blocksFingerprint(payload.blocks)}`;
      if (nextKey === payloadKey) return;
      payloadKey = nextKey;
      lastProgressAt = Date.now();
      if (handlers && typeof handlers.onToken === "function") handlers.onToken(String(payload.text || ""));
      if (handlers && typeof handlers.onReasoning === "function") handlers.onReasoning(String(payload.reasoning || ""));
      if (handlers && typeof handlers.onBlocks === "function") handlers.onBlocks(Array.isArray(payload.blocks) ? payload.blocks : []);
    };

    while (Date.now() - started < maxTotalMs && Date.now() - lastProgressAt < quietTimeoutMs) {
      if (signal && signal.aborted) throw new Error("用户取消了请求");

      if (messageId) {
        try {
          const byId = await client.session.message(
            { sessionID: sessionId, messageID: messageId, directory: this.vaultPath },
            { signal },
          );
          const byIdPayload = byId && byId.data ? byId.data : byId;
          const byIdRole =
            byIdPayload && byIdPayload.info && typeof byIdPayload.info.role === "string"
              ? byIdPayload.info.role
              : "";
          if (byIdRole && byIdRole !== "assistant") {
            messageId = "";
          } else {
          payload = chooseRicherResponse(payload, extractAssistantPayloadFromEnvelope(byIdPayload));
          onPayloadChange();
          const completedAt = byIdPayload && byIdPayload.info && byIdPayload.info.time
            ? Number(byIdPayload.info.time.completed || 0)
            : 0;
          if (completedAt > 0 && hasRenderablePayload(payload) && !payloadLooksInProgress(payload)) break;
          }
        } catch {
          // ignore by-id failure and continue with latest query
        }
      }

      try {
        const listRes = await client.session.messages(
          { sessionID: sessionId, directory: this.vaultPath, limit: 50 },
          { signal },
        );
        const listPayload = listRes && listRes.data ? listRes.data : listRes;
        const latest = this.findLatestAssistantMessage(listPayload, startedAt);
        if (latest) {
          if (!messageId && latest.info && latest.info.id) {
            messageId = latest.info.id;
            lastProgressAt = Date.now();
          }
          payload = chooseRicherResponse(payload, extractAssistantPayloadFromEnvelope(latest));
          onPayloadChange();
          const completedAt = latest && latest.info && latest.info.time
            ? Number(latest.info.time.completed || 0)
            : 0;
          if (completedAt > 0 && hasRenderablePayload(payload) && !payloadLooksInProgress(payload)) break;
        }
      } catch {
        // ignore and keep waiting
      }

      lastStatus = await this.getSessionStatus(sessionId, signal);
      if (lastStatus && lastStatus.type === "idle" && hasRenderablePayload(payload)) {
        const staleMs = Date.now() - lastProgressAt;
        if (!payloadLooksInProgress(payload) || staleMs > 1800) break;
      }

      await sleep(220);
    }

    if (!hasRenderablePayload(payload)) {
      const status = lastStatus || (await this.getSessionStatus(sessionId, signal));
      const statusText = formatSessionStatusText(status);
      payload.text = `(无文本返回：session.status=${statusText}。若长期为 busy，通常是权限或模型鉴权问题，请在 OpenCode 诊断中检查。)`;
    }

    return {
      messageId,
      text: payload.text || "",
      reasoning: payload.reasoning || "",
      meta: payload.meta || "",
      blocks: Array.isArray(payload.blocks) ? payload.blocks : [],
    };
  }

  async streamAssistantFromEvents(client, sessionId, startedAt, signal, handlers) {
    const textByPart = new Map();
    const reasoningByPart = new Map();
    const blockPartById = new Map();
    const partKindById = new Map();
    const promptedPermissionIds = new Set();
    const promptedQuestionIds = new Set();
    let messageId = "";
    let activeMessageCreatedAt = 0;
    let text = "";
    let reasoning = "";
    let meta = "";
    let blocks = [];
    let blocksKey = blocksFingerprint(blocks);
    let done = false;

    const joinPartText = (map) =>
      Array.from(map.values())
        .map((v) => String(v || ""))
        .filter((v) => v.length > 0)
        .join("\n\n");

    const updateText = () => {
      const next = joinPartText(textByPart);
      if (next !== text) {
        text = next;
        if (handlers && typeof handlers.onToken === "function") handlers.onToken(text);
      }
    };

    const updateReasoning = () => {
      const next = joinPartText(reasoningByPart);
      if (next !== reasoning) {
        reasoning = next;
        if (handlers && typeof handlers.onReasoning === "function") handlers.onReasoning(reasoning);
      }
    };

    const updateBlocks = () => {
      const nextBlocks = Array.from(blockPartById.values())
        .map((part, idx) => toPartBlock(part, idx))
        .filter(Boolean);
      const nextBlocksKey = blocksFingerprint(nextBlocks);
      if (nextBlocksKey !== blocksKey) {
        blocks = nextBlocks;
        blocksKey = nextBlocksKey;
        if (handlers && typeof handlers.onBlocks === "function") handlers.onBlocks(blocks);
      }
    };

    const resetActiveMessageContent = () => {
      textByPart.clear();
      reasoningByPart.clear();
      blockPartById.clear();
      partKindById.clear();
      text = "";
      reasoning = "";
      blocks = [];
      blocksKey = blocksFingerprint([]);
      if (handlers && typeof handlers.onToken === "function") handlers.onToken("");
      if (handlers && typeof handlers.onReasoning === "function") handlers.onReasoning("");
      if (handlers && typeof handlers.onBlocks === "function") handlers.onBlocks([]);
    };

    const eventStream = await client.event.subscribe(
      { directory: this.vaultPath },
      { signal, sseMaxRetryAttempts: 3 },
    );

    for await (const raw of eventStream.stream) {
      if (signal && signal.aborted) throw new Error("用户取消了请求");

      const root = raw && typeof raw === "object" ? raw : null;
      const event = root && root.payload && typeof root.payload === "object" ? root.payload : root;
      if (!event || typeof event.type !== "string") continue;

      if (event.type === "message.part.updated") {
        const props = event.properties && typeof event.properties === "object" ? event.properties : {};
        const part = props.part && typeof props.part === "object" ? props.part : null;
        if (!part || typeof part.sessionID !== "string" || part.sessionID !== sessionId) continue;
        if (part.time && Number(part.time.start || 0) > 0 && Number(part.time.start || 0) < startedAt - 1000) continue;
        if (!messageId) continue;
        if (typeof part.messageID !== "string" || part.messageID !== messageId) continue;

        const partId = typeof part.id === "string" && part.id ? part.id : `${part.type || "part"}:${part.messageID || "unknown"}`;
        const delta = typeof props.delta === "string" ? props.delta : "";
        partKindById.set(partId, String(part.type || ""));

        if (part.type === "text") {
          if (part.ignored === true) {
            textByPart.delete(partId);
          } else {
            const current = textByPart.get(partId) || "";
            const next = delta ? current + delta : typeof part.text === "string" ? part.text : current;
            textByPart.set(partId, next);
          }
          updateText();
          continue;
        }

        if (part.type === "reasoning") {
          const current = reasoningByPart.get(partId) || "";
          const next = delta ? current + delta : typeof part.text === "string" ? part.text : current;
          reasoningByPart.set(partId, next);
          updateReasoning();
          continue;
        }

        blockPartById.set(partId, part);
        updateBlocks();
        continue;
      }

      if (event.type === "message.part.removed") {
        const props = event.properties && typeof event.properties === "object" ? event.properties : {};
        const sid = typeof props.sessionID === "string" ? props.sessionID : "";
        if (sid && sid !== sessionId) continue;
        const partId = typeof props.partID === "string" ? props.partID : "";
        if (!partId) continue;
        const partType = String(partKindById.get(partId) || "");
        if (partType === "text") {
          textByPart.delete(partId);
          updateText();
        } else if (partType === "reasoning") {
          // Keep historical reasoning blocks visible to match terminal behavior.
          updateReasoning();
        } else {
          // Keep historical tool/step cards instead of deleting them.
          updateBlocks();
        }
        continue;
      }

      if (event.type === "message.updated") {
        const info = event.properties && event.properties.info && typeof event.properties.info === "object" ? event.properties.info : null;
        if (!info || info.sessionID !== sessionId) continue;
        if (info.role !== "assistant") continue;
        const created = info.time ? Number(info.time.created || 0) : 0;
        if (created > 0 && created < startedAt - 1000) continue;
        if (typeof info.id !== "string" || !info.id) continue;

        if (!messageId || created >= activeMessageCreatedAt) {
          if (messageId && messageId !== info.id) {
            resetActiveMessageContent();
          }
          messageId = info.id;
          activeMessageCreatedAt = created;
        }
        if (info.id !== messageId) continue;

        const err = extractErrorText(info.error);
        if (err) {
          meta = err;
          if (!text) {
            text = `模型返回错误：${err}`;
            if (handlers && typeof handlers.onToken === "function") handlers.onToken(text);
          }
        }

        if (info.time && Number(info.time.completed || 0) > 0) {
          const snapshot = { text, reasoning, meta, blocks };
          if (hasTerminalPayload(snapshot) && !payloadLooksInProgress(snapshot)) {
            done = true;
          }
        }
        if (done) break;
        continue;
      }

      if (event.type === "permission.asked") {
        const permission = event.properties && typeof event.properties === "object" ? event.properties : {};
        const permId = typeof permission.id === "string" ? permission.id : "";
        const permSession = typeof permission.sessionID === "string" ? permission.sessionID : "";
        if (!permId || (permSession && permSession !== sessionId)) continue;
        if (promptedPermissionIds.has(permId)) continue;
        promptedPermissionIds.add(permId);

        if (handlers && typeof handlers.onPermissionRequest === "function") {
          Promise.resolve(handlers.onPermissionRequest(permission || {}))
            .then((response) => {
              if (!response || !["once", "always", "reject"].includes(response)) return;
              return this.replyPermission({
                sessionId,
                permissionId: permId,
                response,
                signal,
              });
            })
            .catch((e) => {
              this.log(`permission handler failed: ${e instanceof Error ? e.message : String(e)}`);
            });
        }
        continue;
      }

      if (event.type === "question.asked") {
        const props = event.properties && typeof event.properties === "object" ? event.properties : {};
        const request = props.request && typeof props.request === "object" ? props.request : props;
        const requestId =
          (request && typeof request.id === "string" && request.id) ||
          (typeof props.requestID === "string" && props.requestID) ||
          "";
        const reqSession =
          (request && typeof request.sessionID === "string" && request.sessionID) ||
          (typeof props.sessionID === "string" && props.sessionID) ||
          "";
        if (!requestId || (reqSession && reqSession !== sessionId)) continue;
        if (promptedQuestionIds.has(requestId)) continue;
        promptedQuestionIds.add(requestId);
        if (handlers && typeof handlers.onQuestionRequest === "function") {
          handlers.onQuestionRequest(request || {});
        }
        continue;
      }

      if (event.type === "question.replied" || event.type === "question.rejected") {
        const props = event.properties && typeof event.properties === "object" ? event.properties : {};
        const requestId = typeof props.requestID === "string" ? props.requestID : "";
        const reqSession = typeof props.sessionID === "string" ? props.sessionID : "";
        if (reqSession && reqSession !== sessionId) continue;
        if (handlers && typeof handlers.onQuestionResolved === "function") {
          handlers.onQuestionResolved({
            requestId,
            sessionId: reqSession || sessionId,
            rejected: event.type === "question.rejected",
            answers: Array.isArray(props.answers) ? props.answers : [],
          });
        }
        continue;
      }

      if (event.type === "tui.prompt.append") {
        const props = event.properties && typeof event.properties === "object" ? event.properties : {};
        const appendText = typeof props.text === "string" ? props.text : "";
        if (appendText && handlers && typeof handlers.onPromptAppend === "function") {
          handlers.onPromptAppend(appendText);
        }
        continue;
      }

      if (event.type === "tui.toast.show") {
        const props = event.properties && typeof event.properties === "object" ? event.properties : {};
        if (handlers && typeof handlers.onToast === "function") {
          handlers.onToast({
            title: typeof props.title === "string" ? props.title : "",
            message: typeof props.message === "string" ? props.message : "",
            variant: typeof props.variant === "string" ? props.variant : "info",
          });
        }
        continue;
      }

      if (event.type === "session.error") {
        const props = event.properties && typeof event.properties === "object" ? event.properties : {};
        if (props.sessionID && props.sessionID !== sessionId) continue;
        const err = extractErrorText(props.error);
        if (err) {
          meta = err;
          if (!text) {
            text = `模型返回错误：${err}`;
            if (handlers && typeof handlers.onToken === "function") handlers.onToken(text);
          }
        }
        done = true;
        break;
      }

      if (event.type === "session.idle") {
        const sid = event.properties && event.properties.sessionID;
        if (sid === sessionId) {
          done = true;
          break;
        }
        continue;
      }

      if (event.type === "session.status") {
        const sid = event.properties && event.properties.sessionID;
        const status = event.properties && event.properties.status && event.properties.status.type;
        if (sid === sessionId && status === "idle") {
          done = true;
          break;
        }
      }
    }

    return { messageId, text, reasoning, meta, blocks };
  }

  async sendMessage(options) {
    console.log("[opencode-assistant] sendMessage start", { sessionId: options.sessionId, transport: "sdk" });
    const client = await this.ensureClient();
    await this.ensureAuth();
    const startedAt = Date.now();
    const model = this.parseModel();
    const commandModel = this.parseCommandModel();
    const parsedCommand = this.parseSlashCommand(options.prompt);
    const resolvedCommand = parsedCommand ? await this.resolveCommandForEndpoint(parsedCommand.command) : { use: false, command: "" };

    let streamed = null;
    let directResponse = null;
    let usedRealStreaming = false;

    if (this.settings.enableStreaming) {
      usedRealStreaming = true;
      const linked = createLinkedAbortController(options.signal);
      const eventSignal = linked.controller.signal;
      const streamPromise = this.streamAssistantFromEvents(client, options.sessionId, startedAt, eventSignal, {
        onToken: options.onToken,
        onReasoning: options.onReasoning,
        onBlocks: options.onBlocks,
        onPermissionRequest: options.onPermissionRequest,
        onQuestionRequest: options.onQuestionRequest,
        onQuestionResolved: options.onQuestionResolved,
        onPromptAppend: options.onPromptAppend,
        onToast: options.onToast,
      }).catch((e) => {
        this.log(`sdk event stream fallback: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });

      try {
        if (parsedCommand && resolvedCommand.use) {
          await client.session.command(
            {
              sessionID: options.sessionId,
              directory: this.vaultPath,
              command: resolvedCommand.command,
              arguments: parsedCommand.arguments,
              model: commandModel,
            },
            { signal: options.signal },
          );
        } else {
          const effectivePrompt = parsedCommand ? options.prompt.replace(/^\//, "").trim() : options.prompt;
          await client.session.promptAsync(
            {
              sessionID: options.sessionId,
              directory: this.vaultPath,
              noReply: false,
              model,
              parts: [{ type: "text", text: effectivePrompt || options.prompt }],
            },
            { signal: options.signal },
          );
        }
        streamed = await streamPromise;
      } finally {
        linked.detach();
        linked.controller.abort();
      }
    } else if (parsedCommand && resolvedCommand.use) {
      const commandRes = await client.session.command(
        {
          sessionID: options.sessionId,
          directory: this.vaultPath,
          command: resolvedCommand.command,
          arguments: parsedCommand.arguments,
          model: commandModel,
        },
        { signal: options.signal },
      );
      const data = commandRes && commandRes.data ? commandRes.data : commandRes;
      const payload = extractAssistantPayloadFromEnvelope(data);
      directResponse = {
        messageId: data && data.info ? data.info.id : "",
        text: payload.text || "",
        reasoning: payload.reasoning || "",
        meta: payload.meta || "",
        blocks: Array.isArray(payload.blocks) ? payload.blocks : [],
      };
    } else {
      const promptRes = await client.session.prompt(
        {
          sessionID: options.sessionId,
          directory: this.vaultPath,
          noReply: false,
          model,
          parts: [{ type: "text", text: options.prompt }],
        },
        { signal: options.signal },
      );
      const data = promptRes && promptRes.data ? promptRes.data : promptRes;
      const payload = extractAssistantPayloadFromEnvelope(data);
      directResponse = {
        messageId: data && data.info ? data.info.id : "",
        text: payload.text || "",
        reasoning: payload.reasoning || "",
        meta: payload.meta || "",
        blocks: Array.isArray(payload.blocks) ? payload.blocks : [],
      };
    }

    let finalized = streamed || directResponse;
    if (
      !finalized ||
      !hasRenderablePayload(finalized) ||
      (usedRealStreaming && !hasTerminalPayload(finalized))
    ) {
      const preferredMessageId = finalized && typeof finalized.messageId === "string" ? finalized.messageId : "";
      const polled = await this.pollAssistantResult(
        client,
        options.sessionId,
        startedAt,
        options.signal,
        preferredMessageId,
        usedRealStreaming ? null : options,
      ).catch((e) => {
        this.log(`sdk poll fallback failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });
      finalized = chooseRicherResponse(finalized, polled);
    }

    if (!finalized) {
      const status = await this.getSessionStatus(options.sessionId, options.signal);
      const statusText = formatSessionStatusText(status);
      finalized = {
        messageId: "",
        text: `(无文本返回：session.status=${statusText}。若长期为 busy，通常是权限或模型鉴权问题，请在 OpenCode 诊断中检查。)`,
        reasoning: "",
        meta: "",
        blocks: [],
      };
    }

    if (!usedRealStreaming && this.settings.enableStreaming) {
      if (finalized.reasoning && options.onReasoning) options.onReasoning(finalized.reasoning);
      if (options.onToken) options.onToken(finalized.text || "");
      if (Array.isArray(finalized.blocks) && finalized.blocks.length && options.onBlocks) {
        options.onBlocks(finalized.blocks);
      }
    }

    console.log("[opencode-assistant] sendMessage done", {
      sessionId: options.sessionId,
      transport: "sdk",
      hasText: Boolean(normalizedRenderableText(finalized.text || "")),
      textLen: String(finalized.text || "").length,
      normalizedTextLen: normalizedRenderableText(finalized.text || "").length,
      reasoningLen: String(finalized.reasoning || "").length,
      blockCount: Array.isArray(finalized.blocks) ? finalized.blocks.length : 0,
      messageId: finalized.messageId || "",
    });

    return {
      messageId: finalized.messageId || "",
      text: finalized.text || "",
      reasoning: finalized.reasoning || "",
      meta: finalized.meta || "",
      blocks: Array.isArray(finalized.blocks) ? finalized.blocks : [],
    };
  }

  async replyPermission(options) {
    const client = await this.ensureClient();
    const response = String(options && options.response ? options.response : "").trim();
    if (!["once", "always", "reject"].includes(response)) return { ok: false };

    try {
      await client.permission.reply(
        {
          requestID: options.permissionId,
          directory: this.vaultPath,
          reply: response,
        },
        { signal: options.signal },
      );
    } catch (e) {
      if (!options.sessionId) throw e;
      await client.permission.respond(
        {
          sessionID: options.sessionId,
          permissionID: options.permissionId,
          directory: this.vaultPath,
          response,
        },
        { signal: options.signal },
      );
    }
    return { ok: true };
  }

  async listQuestions(options = {}) {
    const client = await this.ensureClient();
    const signal = options && options.signal ? options.signal : undefined;
    const res = await client.question.list({ directory: this.vaultPath }, { signal });
    const payload = res && res.data ? res.data : res;
    return Array.isArray(payload) ? payload : [];
  }

  async replyQuestion(options) {
    const client = await this.ensureClient();
    const requestID = String(options && options.requestId ? options.requestId : "").trim();
    if (!requestID) return { ok: false };

    const answers = Array.isArray(options && options.answers ? options.answers : [])
      ? options.answers.map((row) => {
        if (!Array.isArray(row)) return [];
        return row
          .map((item) => String(item || "").trim())
          .filter(Boolean);
      })
      : [];

    await client.question.reply(
      {
        requestID,
        directory: this.vaultPath,
        answers,
      },
      { signal: options && options.signal ? options.signal : undefined },
    );
    return { ok: true };
  }

  async setDefaultModel(options) {
    const client = await this.ensureClient();
    await this.ensureAuth();

    const modelID = String(options.model || "").trim();
    if (!modelID) return { ok: true, model: "" };

    await client.config.update({
      directory: this.vaultPath,
      config: { model: modelID },
    });

    return { ok: true, model: modelID };
  }

  async switchModel(options) {
    return this.setDefaultModel(options);
  }

  async stop() {
    this.client = null;
  }
}

class CompatTransport {
  constructor(options) {
    this.vaultPath = options.vaultPath;
    this.settings = options.settings;
    this.process = null;
    this.baseUrl = "";
    this.bootPromise = null;
    this.resolver = new ExecutableResolver();
    this.commandCache = {
      at: 0,
      items: [],
    };
  }

  log(line) {
    console.log(`[opencode-assistant] ${line}`);
  }

  updateSettings(settings) {
    this.settings = settings;
  }

  async resolveExecutable() {
    if (!this.settings.autoDetectCli && this.settings.cliPath) {
      return { ok: true, path: this.settings.cliPath, attempted: [this.settings.cliPath] };
    }
    return this.resolver.resolve(this.settings.cliPath);
  }

  async ensureStarted() {
    if (this.baseUrl) return this.baseUrl;
    if (this.bootPromise) return this.bootPromise;

    this.bootPromise = new Promise(async (resolve, reject) => {
      try {
        const runtimeHome = path.join(this.vaultPath, this.settings.opencodeHomeDir || ".opencode-runtime");
        fs.mkdirSync(runtimeHome, { recursive: true });

        const resolved = await this.resolveExecutable();
        if (!resolved.ok) {
          reject(new Error(`无法启动 OpenCode 服务: ${resolved.hint || "opencode 未找到"}`));
          return;
        }

        this.process = spawn(
          resolved.path,
          ["serve", "--hostname", "127.0.0.1", "--port", "0", "--cors", "app://obsidian.md", "--print-logs"],
          {
          cwd: this.vaultPath,
          env: { ...process.env, OPENCODE_HOME: runtimeHome },
          },
        );

        const onOutput = (chunk) => {
          const text = chunk.toString();
          const match = text.match(/http:\/\/127\.0\.0\.1:\d+/);
          if (match) {
            this.baseUrl = match[0];
            resolve(this.baseUrl);
          }
        };

        this.process.stdout.on("data", onOutput);
        this.process.stderr.on("data", onOutput);
        this.process.on("error", (err) => reject(new Error(`无法启动 OpenCode 服务: ${err.message}`)));
        this.process.on("exit", (code) => {
          if (!this.baseUrl) reject(new Error(`OpenCode 服务提前退出，退出码: ${String(code)}`));
        });

        setTimeout(() => {
          if (!this.baseUrl) reject(new Error("等待 OpenCode 服务启动超时（15s）"));
        }, 15000);
      } catch (e) {
        reject(e);
      }
    }).catch((e) => {
      this.bootPromise = null;
      throw e;
    });

    return this.bootPromise;
  }

  async request(method, endpoint, body, query = {}, signal) {
    const baseUrl = await this.ensureStarted();
    const url = new URL(baseUrl + endpoint);

    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && String(v).length > 0) {
        url.searchParams.set(k, String(v));
      }
    }

    const resp = await nodeHttpRequestJson(url.toString(), method, body, this.settings.requestTimeoutMs, signal);
    const text = resp.text;
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    if (resp.status < 200 || resp.status >= 300) {
      const detail = parsed ? JSON.stringify(parsed) : text;
      throw new Error(`OpenCode 请求失败 (${resp.status}): ${detail}`);
    }

    return parsed;
  }

  parseModel() {
    if (!this.settings.defaultModel.includes("/")) return undefined;
    const [providerID, modelID] = this.settings.defaultModel.split("/");
    if (!providerID || !modelID) return undefined;
    return { providerID, modelID };
  }

  parseCommandModel() {
    const model = String(this.settings.defaultModel || "").trim();
    if (!model.includes("/")) return undefined;
    return model;
  }

  async getSessionStatus(sessionId, signal) {
    try {
      const res = await this.request("GET", "/session/status", undefined, { directory: this.vaultPath }, signal);
      const payload = res && res.data ? res.data : res;
      if (!payload || typeof payload !== "object") return null;
      return payload[sessionId] || null;
    } catch {
      return null;
    }
  }

  findLatestAssistantMessage(messages, startedAt) {
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

  async ensureAuth() {
    if (this.settings.authMode !== "custom-api-key") return;
    if (!this.settings.customApiKey.trim()) throw new Error("当前是自定义 API Key 模式，但 API Key 为空");

    const providerId = this.settings.customProviderId.trim();
    await this.request("PUT", `/auth/${encodeURIComponent(providerId)}`, { type: "api", key: this.settings.customApiKey.trim() }, { directory: this.vaultPath });

    if (this.settings.customBaseUrl.trim()) {
      await this.request(
        "PATCH",
        "/config",
        {
          provider: {
            [providerId]: {
              options: {
                baseURL: this.settings.customBaseUrl.trim(),
              },
            },
          },
        },
        { directory: this.vaultPath },
      );
    }
  }

  async testConnection() {
    await this.request("GET", "/path", undefined, { directory: this.vaultPath });
    return { ok: true, mode: "compat" };
  }

  async listSessions() {
    const res = await this.request("GET", "/session", undefined, { directory: this.vaultPath });
    const payload = res && res.data ? res.data : res || [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.sessions)) return payload.sessions;
    return [];
  }

  async createSession(title) {
    const res = await this.request("POST", "/session", title ? { title } : {}, { directory: this.vaultPath });
    return res && res.data ? res.data : res;
  }

  async listModels() {
    try {
      const res = await this.request("GET", "/config/providers", undefined, { directory: this.vaultPath });
      const payload = res && res.data ? res.data : res || [];
      const providers = Array.isArray(payload) ? payload : Array.isArray(payload.providers) ? payload.providers : [];
      const out = [];
      for (const p of providers) {
        const models = p.models || {};
        for (const key of Object.keys(models)) out.push(`${p.id}/${key}`);
      }
      return out.sort();
    } catch {
      return [];
    }
  }

  async listCommands() {
    const now = Date.now();
    if (now - this.commandCache.at < 30000 && this.commandCache.items.length) {
      return this.commandCache.items;
    }

    try {
      const res = await this.request("GET", "/command", undefined, { directory: this.vaultPath });
      const payload = res && res.data ? res.data : res || [];
      const items = Array.isArray(payload) ? payload : Array.isArray(payload.commands) ? payload.commands : [];
      this.commandCache = {
        at: now,
        items: Array.isArray(items) ? items : [],
      };
      return this.commandCache.items;
    } catch {
      return [];
    }
  }

  normalizeSlashCommandName(commandName) {
    const normalized = String(commandName || "").trim().replace(/^\//, "").toLowerCase();
    if (normalized === "modle") return "model";
    return normalized;
  }

  availableCommandSet(list) {
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

  async resolveCommandForEndpoint(commandName) {
    const normalized = this.normalizeSlashCommandName(commandName);
    if (!normalized) return { use: false, command: "" };

    const list = await this.listCommands();
    const names = this.availableCommandSet(list);

    if (names.has(normalized)) {
      return { use: true, command: normalized };
    }

    // Alias fallback: only when target command is confirmed in server list.
    if (normalized === "model" && names.has("models")) return { use: true, command: "models" };
    if (normalized === "models" && names.has("model")) return { use: true, command: "model" };

    return { use: false, command: normalized };
  }

  async finalizeAssistantResponse(sessionId, responsePayload, startedAt, signal, preferredMessageId = "") {
    const finalizeStartedAt = Date.now();
    const data = responsePayload && responsePayload.data ? responsePayload.data : responsePayload;
    let messageId = preferredMessageId || (data && data.info ? data.info.id : "");
    let payload = extractAssistantPayloadFromEnvelope(data);
    const quietTimeoutMs = Math.max(10000, Number(this.settings.requestTimeoutMs) || 120000);
    const maxTotalMs = Math.max(quietTimeoutMs * 3, 10 * 60 * 1000);
    const loopStartedAt = Date.now();
    let lastProgressAt = loopStartedAt;
    let progressKey = `${messageId}|${responseRichnessScore(payload)}|${normalizedRenderableText(payload.text || "").length}|${blocksFingerprint(payload.blocks || [])}`;
    let pollCount = 0;
    let lastStatus = null;
    let lastMessageCreated = 0;

    const markProgress = () => {
      const nextKey = `${messageId}|${responseRichnessScore(payload)}|${normalizedRenderableText(payload.text || "").length}|${blocksFingerprint(payload.blocks || [])}`;
      if (nextKey !== progressKey) {
        progressKey = nextKey;
        lastProgressAt = Date.now();
      }
    };

    const tryLoadByMessageId = async () => {
      if (!messageId) return { completed: false };
      try {
        const msgRes = await this.request(
          "GET",
          `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`,
          undefined,
          { directory: this.vaultPath },
          signal,
        );
        const messagePayload = msgRes && msgRes.data ? msgRes.data : msgRes;
        const role =
          messagePayload && messagePayload.info && typeof messagePayload.info.role === "string"
            ? messagePayload.info.role
            : "";
        if (role && role !== "assistant") {
          messageId = "";
          return { completed: false };
        }
        const extracted = extractAssistantPayloadFromEnvelope(messagePayload);
        payload = chooseRicherResponse(payload, extracted);
        markProgress();
        const completedAt =
          messagePayload && messagePayload.info && messagePayload.info.time
            ? Number(messagePayload.info.time.completed || 0)
            : 0;
        return { completed: completedAt > 0 };
      } catch {
        return { completed: false };
      }
    };

    const tryLoadLatest = async () => {
      const listRes = await this.request(
        "GET",
        `/session/${encodeURIComponent(sessionId)}/message`,
        undefined,
        { directory: this.vaultPath, limit: 50 },
        signal,
      );
      const listPayload = listRes && listRes.data ? listRes.data : listRes;
      const latest = this.findLatestAssistantMessage(listPayload, startedAt);
      if (!latest) return { completed: false };

      const latestCreated =
        latest && latest.info && latest.info.time
          ? Number(latest.info.time.created || 0)
          : 0;
      if (latestCreated >= lastMessageCreated && latest.info && latest.info.id) {
        messageId = latest.info.id;
        lastMessageCreated = latestCreated;
        markProgress();
      }
      const extracted = extractAssistantPayloadFromEnvelope(latest);
      payload = chooseRicherResponse(payload, extracted);
      markProgress();
      const completedAt =
        latest && latest.info && latest.info.time
          ? Number(latest.info.time.completed || 0)
          : 0;
      return { completed: completedAt > 0 };
    };

    while (Date.now() - loopStartedAt < maxTotalMs && Date.now() - lastProgressAt < quietTimeoutMs) {
      if (signal && signal.aborted) {
        throw new Error("用户取消了请求");
      }

      const byId = await tryLoadByMessageId();
      if (byId.completed && hasRenderablePayload(payload) && hasTerminalPayload(payload) && !payloadLooksInProgress(payload)) {
        break;
      }

      const latest = await tryLoadLatest();
      if (latest.completed && hasRenderablePayload(payload) && hasTerminalPayload(payload) && !payloadLooksInProgress(payload)) {
        break;
      }

      pollCount += 1;
      if (pollCount % 2 === 0) {
        lastStatus = await this.getSessionStatus(sessionId, signal);
        if (lastStatus && lastStatus.type === "idle") {
          const staleMs = Date.now() - lastProgressAt;
          if (hasRenderablePayload(payload) && (!payloadLooksInProgress(payload) || staleMs > 1800)) {
            break;
          }
        }
      }

      if (hasTerminalPayload(payload) && !payloadLooksInProgress(payload)) {
        break;
      }

      await sleep(220);
    }

    if (Date.now() - loopStartedAt >= maxTotalMs || Date.now() - lastProgressAt >= quietTimeoutMs) {
      console.log("[opencode-assistant] finalize timeout", {
        sessionId,
        messageId,
        elapsedMs: Date.now() - finalizeStartedAt,
        idleMs: Date.now() - lastProgressAt,
        quietTimeoutMs,
        maxTotalMs,
        textLen: String(payload.text || "").length,
        reasoningLen: String(payload.reasoning || "").length,
        blockCount: Array.isArray(payload.blocks) ? payload.blocks.length : 0,
        terminal: hasTerminalPayload(payload),
        inProgress: payloadLooksInProgress(payload),
      });
    }

    if (isIntermediateToolCallPayload(payload) && normalizedRenderableText(payload.text || "").length <= 1) {
      payload.text = "";
    }

    if (!hasRenderablePayload(payload)) {
      const status = lastStatus || (await this.getSessionStatus(sessionId, signal));
      const statusText = formatSessionStatusText(status);
      payload.text = `(无文本返回：session.status=${statusText}。若长期为 busy，通常是权限或模型鉴权问题，请在 OpenCode 诊断中检查。)`;
    }

    return {
      messageId,
      text: payload.text || "",
      reasoning: payload.reasoning || "",
      meta: payload.meta || "",
      blocks: payload.blocks || [],
    };
  }

  async streamAssistantFromPolling(sessionId, startedAt, signal, handlers) {
    const quietTimeoutMs = Math.max(10000, Number(this.settings.requestTimeoutMs) || 120000);
    const maxTotalMs = Math.max(quietTimeoutMs * 3, 10 * 60 * 1000);
    const started = Date.now();
    let lastProgressAt = started;
    let messageId = "";
    let text = "";
    let reasoning = "";
    let meta = "";
    let blocks = [];
    let blocksKey = blocksFingerprint(blocks);
    let pollCount = 0;

    while (Date.now() - started < maxTotalMs && Date.now() - lastProgressAt < quietTimeoutMs) {
      if (signal && signal.aborted) {
        throw new Error("用户取消了请求");
      }

      const listRes = await this.request(
        "GET",
        `/session/${encodeURIComponent(sessionId)}/message`,
        undefined,
        { directory: this.vaultPath, limit: 50 },
        signal,
      );
      const listPayload = listRes && listRes.data ? listRes.data : listRes;
      const latest = this.findLatestAssistantMessage(listPayload, startedAt);
      if (latest) {
        if (!messageId && latest.info && latest.info.id) {
          messageId = latest.info.id;
          lastProgressAt = Date.now();
        }

        const extracted = extractAssistantPayloadFromEnvelope(latest);
        if (typeof extracted.meta === "string" && extracted.meta.trim()) {
          if (meta !== extracted.meta.trim()) {
            meta = extracted.meta.trim();
            lastProgressAt = Date.now();
          }
        }
        const nextBlocks = Array.isArray(extracted.blocks) ? extracted.blocks : [];
        const nextBlocksKey = blocksFingerprint(nextBlocks);
        if (nextBlocksKey !== blocksKey) {
          blocks = nextBlocks;
          blocksKey = nextBlocksKey;
          lastProgressAt = Date.now();
          if (handlers && typeof handlers.onBlocks === "function") {
            handlers.onBlocks(blocks);
          }
        }
        if (extracted.reasoning !== reasoning) {
          reasoning = extracted.reasoning;
          lastProgressAt = Date.now();
          if (handlers && typeof handlers.onReasoning === "function") {
            handlers.onReasoning(reasoning);
          }
        }
        if (extracted.text !== text) {
          text = extracted.text;
          lastProgressAt = Date.now();
          if (handlers && typeof handlers.onToken === "function") {
            handlers.onToken(text);
          }
        }

        const completedAt = latest && latest.info && latest.info.time ? Number(latest.info.time.completed || 0) : 0;
        if (completedAt > 0 && (text || reasoning || meta || blocks.length)) {
          const currentPayload = { text, reasoning, meta, blocks };
          if (!payloadLooksInProgress(currentPayload)) {
            return { messageId, text, reasoning, meta, blocks };
          }
        }
      }

      pollCount += 1;
      if (pollCount % 2 === 0) {
        const status = await this.getSessionStatus(sessionId, signal);
        if (status && status.type === "idle" && (text || reasoning || meta || messageId || blocks.length)) {
          const currentPayload = { text, reasoning, meta, blocks };
          const staleMs = Date.now() - lastProgressAt;
          if (!payloadLooksInProgress(currentPayload) || staleMs > 1800) {
            return { messageId, text, reasoning, meta, blocks };
          }
        }
      }

      await sleep(220);
    }

    return { messageId, text, reasoning, meta, blocks };
  }

  async streamAssistantFromEvents(sessionId, startedAt, signal, handlers) {
    const baseUrl = await this.ensureStarted();
    const eventUrl = new URL(baseUrl + "/event");
    eventUrl.searchParams.set("directory", this.vaultPath);

    const textByPart = new Map();
    const reasoningByPart = new Map();
    const blockPartById = new Map();
    const partKindById = new Map();
    const promptedPermissionIds = new Set();
    const promptedQuestionIds = new Set();

    let messageId = "";
    let activeMessageCreatedAt = 0;
    let text = "";
    let reasoning = "";
    let meta = "";
    let blocks = [];
    let blocksKey = blocksFingerprint(blocks);
    let done = false;

    const joinPartText = (map) => {
      return Array.from(map.values())
        .map((v) => String(v || ""))
        .filter((v) => v.length > 0)
        .join("\n\n");
    };

    const updateText = () => {
      const next = joinPartText(textByPart);
      if (next !== text) {
        text = next;
        if (handlers && typeof handlers.onToken === "function") handlers.onToken(text);
      }
    };

    const updateReasoning = () => {
      const next = joinPartText(reasoningByPart);
      if (next !== reasoning) {
        reasoning = next;
        if (handlers && typeof handlers.onReasoning === "function") handlers.onReasoning(reasoning);
      }
    };

    const updateBlocks = () => {
      const nextBlocks = Array.from(blockPartById.values())
        .map((part, idx) => toPartBlock(part, idx))
        .filter(Boolean);
      const nextBlocksKey = blocksFingerprint(nextBlocks);
      if (nextBlocksKey !== blocksKey) {
        blocks = nextBlocks;
        blocksKey = nextBlocksKey;
        if (handlers && typeof handlers.onBlocks === "function") {
          handlers.onBlocks(blocks);
        }
      }
    };

    const resetActiveMessageContent = () => {
      textByPart.clear();
      reasoningByPart.clear();
      blockPartById.clear();
      partKindById.clear();
      text = "";
      reasoning = "";
      blocks = [];
      blocksKey = blocksFingerprint([]);
      if (handlers && typeof handlers.onToken === "function") handlers.onToken("");
      if (handlers && typeof handlers.onReasoning === "function") handlers.onReasoning("");
      if (handlers && typeof handlers.onBlocks === "function") handlers.onBlocks([]);
    };

    await nodeHttpRequestSse(
      eventUrl.toString(),
      Math.max(3000, Number(this.settings.requestTimeoutMs) || 120000),
      signal,
      {
        onEvent: (raw) => {
          const root = raw && typeof raw === "object" ? raw : null;
          if (root && typeof root.directory === "string" && root.directory && root.directory !== this.vaultPath) return;

          const event = root && root.payload && typeof root.payload === "object" ? root.payload : root;
          if (!event || typeof event.type !== "string") return;

          if (event.type === "message.part.updated") {
            const props = event.properties && typeof event.properties === "object" ? event.properties : {};
            const part = props.part && typeof props.part === "object" ? props.part : null;
            if (!part || typeof part.sessionID !== "string" || part.sessionID !== sessionId) return;
            if (part.time && Number(part.time.start || 0) > 0 && Number(part.time.start || 0) < startedAt - 1000) return;
            if (!messageId) return;
            if (typeof part.messageID !== "string" || part.messageID !== messageId) return;

            const partId = typeof part.id === "string" && part.id ? part.id : `${part.type || "part"}:${part.messageID || "unknown"}`;
            const delta = typeof props.delta === "string" ? props.delta : "";
            partKindById.set(partId, String(part.type || ""));

            if (part.type === "text") {
              if (part.ignored === true) {
                textByPart.delete(partId);
              } else {
                const current = textByPart.get(partId) || "";
                const next = delta ? current + delta : typeof part.text === "string" ? part.text : current;
                textByPart.set(partId, next);
              }
              updateText();
              return;
            }

            if (part.type === "reasoning") {
              const current = reasoningByPart.get(partId) || "";
              const next = delta ? current + delta : typeof part.text === "string" ? part.text : current;
              reasoningByPart.set(partId, next);
              updateReasoning();
              return;
            }
            blockPartById.set(partId, part);
            updateBlocks();
            return;
          }

          if (event.type === "message.part.removed") {
            const props = event.properties && typeof event.properties === "object" ? event.properties : {};
            const sid = typeof props.sessionID === "string" ? props.sessionID : "";
            if (sid && sid !== sessionId) return;
            const partId = typeof props.partID === "string" ? props.partID : "";
            if (!partId) return;
            const partType = String(partKindById.get(partId) || "");
            if (partType === "text") {
              textByPart.delete(partId);
              updateText();
            } else if (partType === "reasoning") {
              // Keep historical reasoning blocks visible to match terminal behavior.
              updateReasoning();
            } else {
              // Keep historical tool/step cards instead of deleting them.
              updateBlocks();
            }
            return;
          }

          if (event.type === "message.updated") {
            const info = event.properties && event.properties.info && typeof event.properties.info === "object" ? event.properties.info : null;
            if (!info || info.sessionID !== sessionId) return;
            if (info.role !== "assistant") return;
            if (typeof info.id !== "string" || !info.id) return;
            const created = info.time ? Number(info.time.created || 0) : 0;
            if (created > 0 && created < startedAt - 1000) return;

            if (!messageId || created >= activeMessageCreatedAt) {
              if (messageId && messageId !== info.id) {
                resetActiveMessageContent();
              }
              messageId = info.id;
              activeMessageCreatedAt = created;
            }
            if (info.id !== messageId) return;
            const err = extractErrorText(info.error);
            if (err) {
              meta = err;
              if (!text) {
                text = `模型返回错误：${err}`;
                if (handlers && typeof handlers.onToken === "function") handlers.onToken(text);
              }
            }

            const completed = info.time && Number(info.time.completed || 0) > 0;
            if (completed) {
              const snapshot = { text, reasoning, meta, blocks };
              if (hasTerminalPayload(snapshot) && !payloadLooksInProgress(snapshot)) {
                done = true;
              }
            }
            return;
          }

          if (event.type === "permission.updated" || event.type === "permission.asked") {
            const props = event.properties && typeof event.properties === "object" ? event.properties : {};
            const permission = props.request && typeof props.request === "object" ? props.request : props;
            const permId =
              (permission && typeof permission.id === "string" && permission.id) ||
              (typeof props.permissionID === "string" && props.permissionID) ||
              "";
            const permSession =
              (permission && typeof permission.sessionID === "string" && permission.sessionID) ||
              (typeof props.sessionID === "string" && props.sessionID) ||
              "";
            if (!permId || (permSession && permSession !== sessionId)) return;
            if (promptedPermissionIds.has(permId)) return;
            promptedPermissionIds.add(permId);

            if (handlers && typeof handlers.onPermissionRequest === "function") {
              Promise.resolve(handlers.onPermissionRequest(permission || {}))
                .then((response) => {
                  if (!response || !["once", "always", "reject"].includes(response)) return;
                  return this.replyPermission({
                    sessionId,
                    permissionId: permId,
                    response,
                    signal,
                  });
                })
                .catch((e) => {
                  this.log(`permission handler failed: ${e instanceof Error ? e.message : String(e)}`);
                });
            }
            return;
          }

          if (event.type === "question.asked") {
            const props = event.properties && typeof event.properties === "object" ? event.properties : {};
            const request = props.request && typeof props.request === "object" ? props.request : props;
            const requestId =
              (request && typeof request.id === "string" && request.id) ||
              (typeof props.requestID === "string" && props.requestID) ||
              "";
            const reqSession =
              (request && typeof request.sessionID === "string" && request.sessionID) ||
              (typeof props.sessionID === "string" && props.sessionID) ||
              "";
            if (!requestId || (reqSession && reqSession !== sessionId)) return;
            if (promptedQuestionIds.has(requestId)) return;
            promptedQuestionIds.add(requestId);
            if (handlers && typeof handlers.onQuestionRequest === "function") {
              handlers.onQuestionRequest(request || {});
            }
            return;
          }

          if (event.type === "question.replied" || event.type === "question.rejected") {
            const props = event.properties && typeof event.properties === "object" ? event.properties : {};
            const requestId = typeof props.requestID === "string" ? props.requestID : "";
            const reqSession = typeof props.sessionID === "string" ? props.sessionID : "";
            if (reqSession && reqSession !== sessionId) return;
            if (handlers && typeof handlers.onQuestionResolved === "function") {
              handlers.onQuestionResolved({
                requestId,
                sessionId: reqSession || sessionId,
                rejected: event.type === "question.rejected",
                answers: Array.isArray(props.answers) ? props.answers : [],
              });
            }
            return;
          }

          if (event.type === "tui.prompt.append") {
            const props = event.properties && typeof event.properties === "object" ? event.properties : {};
            const appendText = typeof props.text === "string" ? props.text : "";
            if (appendText && handlers && typeof handlers.onPromptAppend === "function") {
              handlers.onPromptAppend(appendText);
            }
            return;
          }

          if (event.type === "tui.toast.show") {
            const props = event.properties && typeof event.properties === "object" ? event.properties : {};
            if (handlers && typeof handlers.onToast === "function") {
              handlers.onToast({
                title: typeof props.title === "string" ? props.title : "",
                message: typeof props.message === "string" ? props.message : "",
                variant: typeof props.variant === "string" ? props.variant : "info",
              });
            }
            return;
          }

          if (event.type === "session.error") {
            const props = event.properties && typeof event.properties === "object" ? event.properties : {};
            if (props.sessionID && props.sessionID !== sessionId) return;
            const err = extractErrorText(props.error);
            if (err) {
              meta = err;
              if (!text) {
                text = `模型返回错误：${err}`;
                if (handlers && typeof handlers.onToken === "function") handlers.onToken(text);
              }
            }
            done = true;
            return;
          }

          if (event.type === "session.idle") {
            const sid = event.properties && event.properties.sessionID;
            if (sid === sessionId) done = true;
            return;
          }

          if (event.type === "session.status") {
            const sid = event.properties && event.properties.sessionID;
            const status = event.properties && event.properties.status && event.properties.status.type;
            if (sid === sessionId && status === "idle") done = true;
          }
        },
        shouldStop: () => done,
      },
    );

    return { messageId, text, reasoning, meta, blocks };
  }

  async sendMessage(options) {
    console.log("[opencode-assistant] sendMessage start", {
      sessionId: options.sessionId,
      transport: "compat",
      streaming: Boolean(this.settings.enableStreaming),
    });
    await this.ensureAuth();
    const startedAt = Date.now();

    const model = this.parseModel();
    const commandModel = this.parseCommandModel();
    const parsedCommand = this.parseSlashCommand(options.prompt);
    const resolvedCommand = parsedCommand ? await this.resolveCommandForEndpoint(parsedCommand.command) : { use: false, command: "" };
    const isCommandRequest = Boolean(parsedCommand && resolvedCommand.use);
    if (isCommandRequest) {
      console.log("[opencode-assistant] compat command route", {
        sessionId: options.sessionId,
        command: resolvedCommand.command,
      });
    }

    let res;
    let streamed = null;
    let usedRealStreaming = false;
    const commandBody = isCommandRequest
      ? {
        command: resolvedCommand.command,
        arguments: parsedCommand.arguments,
      }
      : null;
    if (commandBody && commandModel) commandBody.model = commandModel;

    const effectivePrompt = parsedCommand ? options.prompt.replace(/^\//, "").trim() : options.prompt;
    const messageBody = {
      noReply: false,
      parts: [{ type: "text", text: effectivePrompt || options.prompt }],
    };
    if (model) messageBody.model = model;

    if (this.settings.enableStreaming) {
      usedRealStreaming = true;
      const linked = createLinkedAbortController(options.signal);
      const eventSignal = linked.controller.signal;
      const eventStreamPromise = this.streamAssistantFromEvents(options.sessionId, startedAt, eventSignal, {
        onToken: options.onToken,
        onReasoning: options.onReasoning,
        onBlocks: options.onBlocks,
        onPermissionRequest: options.onPermissionRequest,
        onQuestionRequest: options.onQuestionRequest,
        onQuestionResolved: options.onQuestionResolved,
        onPromptAppend: options.onPromptAppend,
        onToast: options.onToast,
      }).catch((e) => {
        this.log(`event stream fallback: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });

      try {
        if (isCommandRequest) {
          // 保持与终端行为一致：命令执行期间也实时订阅事件流。
          await this.request(
            "POST",
            `/session/${encodeURIComponent(options.sessionId)}/command`,
            commandBody,
            { directory: this.vaultPath },
            options.signal,
          );
        } else {
          await this.request(
            "POST",
            `/session/${encodeURIComponent(options.sessionId)}/prompt_async`,
            messageBody,
            { directory: this.vaultPath },
            options.signal,
          );
        }
        streamed = await eventStreamPromise;
      } finally {
        linked.detach();
        linked.controller.abort();
      }

      if (
        !streamed ||
        (!normalizedRenderableText(streamed.text) &&
          !String(streamed.reasoning || "").trim() &&
          !(Array.isArray(streamed.blocks) && streamed.blocks.length))
      ) {
        streamed = await this.streamAssistantFromPolling(options.sessionId, startedAt, options.signal, {
          onToken: options.onToken,
          onReasoning: options.onReasoning,
          onBlocks: options.onBlocks,
        });
      }
    } else if (isCommandRequest) {
      // 非流式时命令走 /command，结果由 finalize 统一收敛。
      res = await this.request(
        "POST",
        `/session/${encodeURIComponent(options.sessionId)}/command`,
        commandBody,
        { directory: this.vaultPath },
        options.signal,
      );
    } else {
      res = await this.request(
        "POST",
        `/session/${encodeURIComponent(options.sessionId)}/message`,
        messageBody,
        { directory: this.vaultPath },
        options.signal,
      );
    }

    let finalized = null;
    if (usedRealStreaming) {
      finalized = streamed || { messageId: "", text: "", reasoning: "", meta: "", blocks: [] };
      if (!hasTerminalPayload(finalized) || payloadLooksInProgress(finalized)) {
        const streamedMessageId = finalized && typeof finalized.messageId === "string" ? finalized.messageId : "";
        const fetchedFinal = await this.finalizeAssistantResponse(
          options.sessionId,
          null,
          startedAt,
          options.signal,
          streamedMessageId,
        ).catch((e) => {
          this.log(`finalize after stream failed: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        });
        finalized = chooseRicherResponse(finalized, fetchedFinal);
      }
    } else {
      finalized = await this.finalizeAssistantResponse(options.sessionId, res, startedAt, options.signal);
    }

    const messageId = finalized.messageId;
    const text = finalized.text || "";
    const reasoning = finalized.reasoning || "";
    const meta = finalized.meta || "";
    const blocks = Array.isArray(finalized.blocks) ? finalized.blocks : [];

    if (this.settings.enableStreaming && !usedRealStreaming) {
      if (reasoning && options.onReasoning) {
        await streamPseudo(reasoning, options.onReasoning, options.signal);
      }
      await streamPseudo(text, options.onToken, options.signal);
      if (blocks.length && options.onBlocks) {
        options.onBlocks(blocks);
      }
    }

    console.log("[opencode-assistant] sendMessage done", {
      sessionId: options.sessionId,
      hasText: Boolean(normalizedRenderableText(text)),
      textLen: text ? text.length : 0,
      normalizedTextLen: normalizedRenderableText(text).length,
      reasoningLen: reasoning ? reasoning.length : 0,
      blockCount: blocks.length,
      messageId,
    });
    return { messageId, text, reasoning, meta, blocks };
  }

  async replyPermission(options) {
    const response = String(options && options.response ? options.response : "").trim();
    if (!["once", "always", "reject"].includes(response)) return { ok: false };
    await this.request(
      "POST",
      `/session/${encodeURIComponent(options.sessionId)}/permissions/${encodeURIComponent(options.permissionId)}`,
      { response },
      { directory: this.vaultPath },
      options.signal,
    );
    return { ok: true };
  }

  async listQuestions(options = {}) {
    const res = await this.request(
      "GET",
      "/question",
      undefined,
      { directory: this.vaultPath },
      options && options.signal ? options.signal : undefined,
    );
    const payload = res && res.data ? res.data : res;
    return Array.isArray(payload) ? payload : [];
  }

  async replyQuestion(options) {
    const requestId = String(options && options.requestId ? options.requestId : "").trim();
    if (!requestId) return { ok: false };
    const answers = Array.isArray(options && options.answers ? options.answers : [])
      ? options.answers.map((row) => {
        if (!Array.isArray(row)) return [];
        return row
          .map((item) => String(item || "").trim())
          .filter(Boolean);
      })
      : [];

    await this.request(
      "POST",
      `/question/${encodeURIComponent(requestId)}/reply`,
      { answers },
      { directory: this.vaultPath },
      options && options.signal ? options.signal : undefined,
    );
    return { ok: true };
  }

  async setDefaultModel(options) {
    await this.ensureAuth();
    const modelID = String(options.model || "").trim();
    if (!modelID) return { ok: true, model: "" };

    await this.request(
      "PATCH",
      "/config",
      {
        model: modelID,
      },
      { directory: this.vaultPath },
      options.signal,
    );

    return { ok: true, model: modelID };
  }

  async switchModel(options) {
    return this.setDefaultModel(options);
  }

  async waitForMessageText(sessionId, messageId, signal) {
    const timeoutMs = Math.max(2000, Math.min(15000, Number(this.settings.requestTimeoutMs) || 120000));
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      if (signal && signal.aborted) {
        throw new Error("用户取消了请求");
      }
      const msg = await this.request(
        "GET",
        `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`,
        undefined,
        { directory: this.vaultPath },
      );
      const payload = msg && msg.data ? msg.data : msg;
      const extracted = extractAssistantParts(payload && payload.parts ? payload.parts : []);
      const text = extracted.text;
      if (text) return text;
      await sleep(250);
    }

    return "";
  }

  async waitForLatestAssistantText(sessionId, startedAt, signal) {
    const timeoutMs = Math.max(2000, Math.min(15000, Number(this.settings.requestTimeoutMs) || 120000));
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      if (signal && signal.aborted) {
        throw new Error("用户取消了请求");
      }
      const res = await this.request(
        "GET",
        `/session/${encodeURIComponent(sessionId)}/message`,
        undefined,
        { directory: this.vaultPath, limit: 50 },
      );
      const payload = res && res.data ? res.data : res;
      const list = Array.isArray(payload) ? payload : [];

      const candidates = list
        .filter((item) => item && item.info && item.info.role === "assistant")
        .filter((item) => {
          const t = item.info && item.info.time ? item.info.time.created || 0 : 0;
          return !startedAt || t >= startedAt - 1000;
        })
        .sort((a, b) => {
          const ta = a.info && a.info.time ? a.info.time.created || 0 : 0;
          const tb = b.info && b.info.time ? b.info.time.created || 0 : 0;
          return tb - ta;
        });

      for (const item of candidates) {
        const extracted = extractAssistantParts(item.parts || []);
        const text = extracted.text;
        if (text) return text;
      }

      await sleep(250);
    }

    return "";
  }

  parseSlashCommand(prompt) {
    const text = String(prompt || "").trim();
    if (!text.startsWith("/")) return null;
    if (text.length <= 1) return null;

    // /ah foo bar -> { command: "ah", arguments: "foo bar" }
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

  async stop() {
    if (this.process) this.process.kill();
    this.process = null;
    this.baseUrl = "";
    this.bootPromise = null;
  }
}

class OpenCodeClient {
  constructor(options) {
    this.settings = options.settings;
    this.logger = options.logger || (() => {});
    this.sdk = new SdkTransport(options);
    this.compat = new CompatTransport(options);
    this.lastMode = "compat";
    this.lastError = "";
  }

  updateSettings(settings) {
    this.settings = settings;
    this.sdk.updateSettings(settings);
    this.compat.updateSettings(settings);
  }

  primary() {
    // In Obsidian renderer runtime, SDK path can hit file:// import restrictions.
    // Force compat transport for reliability.
    return this.compat;
  }

  fallback() {
    return null;
  }

  async withTransport(actionName, fn) {
    const primary = this.primary();
    try {
      const out = await fn(primary);
      this.logger(`action=${actionName} mode=compat ok`);
      this.lastMode = "compat";
      this.lastError = "";
      return out;
    } catch (e1) {
      const fb = this.fallback();
      if (!fb) {
        this.logger(`action=${actionName} mode=compat err=${e1 instanceof Error ? e1.message : String(e1)}`);
        this.lastError = e1 instanceof Error ? e1.message : String(e1);
        throw e1;
      }

      try {
        const out = await fn(fb);
        this.lastMode = "compat";
        this.lastError = "";
        return out;
      } catch (e2) {
        this.lastError = `[${actionName}] SDK失败: ${e1 instanceof Error ? e1.message : String(e1)} | Compat失败: ${e2 instanceof Error ? e2.message : String(e2)}`;
        throw e2;
      }
    }
  }

  testConnection() {
    return this.withTransport("testConnection", (t) => t.testConnection());
  }
  listSessions() {
    return this.withTransport("listSessions", (t) => t.listSessions());
  }
  createSession(title) {
    return this.withTransport("createSession", (t) => t.createSession(title));
  }
  listModels() {
    return this.withTransport("listModels", (t) => t.listModels());
  }
  setDefaultModel(options) {
    return this.withTransport("setDefaultModel", (t) => {
      if (typeof t.setDefaultModel === "function") return t.setDefaultModel(options);
      if (typeof t.switchModel === "function") return t.switchModel(options);
      return { ok: true, model: String(options && options.model ? options.model : "") };
    });
  }
  switchModel(options) {
    return this.setDefaultModel(options);
  }
  sendMessage(options) {
    return this.withTransport("sendMessage", (t) => t.sendMessage(options));
  }
  listQuestions(options = {}) {
    return this.withTransport("listQuestions", (t) => {
      if (typeof t.listQuestions === "function") return t.listQuestions(options);
      return [];
    });
  }
  replyQuestion(options) {
    return this.withTransport("replyQuestion", (t) => {
      if (typeof t.replyQuestion === "function") return t.replyQuestion(options);
      return { ok: false };
    });
  }
  replyPermission(options) {
    return this.withTransport("replyPermission", (t) => {
      if (typeof t.replyPermission === "function") return t.replyPermission(options);
      return { ok: false };
    });
  }
  async stop() {
    await this.sdk.stop();
    await this.compat.stop();
  }
}

class SessionStore {
  constructor(plugin) {
    this.plugin = plugin;
  }

  state() {
    if (!this.plugin.runtimeState) {
      this.plugin.runtimeState = { sessions: [], activeSessionId: "", messagesBySession: {} };
    }
    return this.plugin.runtimeState;
  }

  upsertSession(session) {
    const st = this.state();
    const i = st.sessions.findIndex((s) => s.id === session.id);
    if (i >= 0) st.sessions[i] = Object.assign({}, st.sessions[i], session);
    else st.sessions.unshift(session);

    st.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  setActiveSession(id) {
    this.state().activeSessionId = id;
  }

  appendMessage(sessionId, message) {
    const st = this.state();
    const list = st.messagesBySession[sessionId] || [];
    list.push(message);
    st.messagesBySession[sessionId] = list.slice(-200);

    const session = st.sessions.find((s) => s.id === sessionId);
    if (session) {
      session.updatedAt = Date.now();
      if (message.role === "user") session.lastUserPrompt = message.text;
    }
  }

  updateAssistantDraft(sessionId, draftId, text, reasoning, meta, blocks) {
    const list = this.state().messagesBySession[sessionId] || [];
    const t = list.find((x) => x.id === draftId);
    if (!t) return;
    if (typeof text === "string") t.text = text;
    if (typeof reasoning === "string") t.reasoning = reasoning;
    if (typeof meta === "string") t.meta = meta;
    if (Array.isArray(blocks)) t.blocks = blocks;
  }

  finalizeAssistantDraft(sessionId, draftId, text, error) {
    const list = this.state().messagesBySession[sessionId] || [];
    const t = list.find((x) => x.id === draftId);
    const payload =
      text && typeof text === "object"
        ? text
        : {
          text: String(text || ""),
          reasoning: "",
          meta: "",
          blocks: [],
        };
    if (t) {
      t.text = String(payload.text || "");
      t.reasoning = String(payload.reasoning || "");
      t.meta = String(payload.meta || "");
      t.blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
      t.error = error || "";
      t.pending = false;
    }
  }

  getActiveMessages() {
    const st = this.state();
    return st.messagesBySession[st.activeSessionId] || [];
  }
}

class DiagnosticsService {
  constructor(plugin) {
    this.plugin = plugin;
    this.resolver = new ExecutableResolver();
    this.lastResult = null;
  }

  async run() {
    const executable = await this.resolver.resolve(this.plugin.settings.cliPath);

    let connection = { ok: false, mode: this.plugin.settings.transportMode, error: "" };
    try {
      const result = await this.plugin.opencodeClient.testConnection();
      connection = { ok: true, mode: result.mode || this.plugin.settings.transportMode, error: "" };
    } catch (e) {
      connection = { ok: false, mode: this.plugin.settings.transportMode, error: e instanceof Error ? e.message : String(e) };
    }

    this.lastResult = { at: Date.now(), executable, connection };
    return this.lastResult;
  }

  getLastResult() {
    return this.lastResult;
  }
}

class DiagnosticsModal extends Modal {
  constructor(app, result) {
    super(app);
    this.result = result;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("oc-diagnostics-modal");
    contentEl.createEl("h2", { text: "OpenCode 诊断" });

    if (!this.result) {
      contentEl.createEl("p", { text: "尚未运行诊断。" });
      return;
    }

    const conn = this.result.connection;
    const exe = this.result.executable;

    contentEl.createEl("h3", { text: "连接状态" });
    contentEl.createEl("p", { text: conn.ok ? `正常 (${conn.mode})` : `失败 (${conn.mode})` });
    if (conn.error) contentEl.createEl("pre", { text: conn.error });

    contentEl.createEl("h3", { text: "可执行文件探测" });
    contentEl.createEl("p", { text: exe.ok ? `找到: ${exe.path}` : "未找到" });
    if (exe.hint) contentEl.createEl("p", { text: exe.hint });

    const attempts = contentEl.createEl("details");
    attempts.createEl("summary", { text: `已尝试路径 (${(exe.attempted || []).length})` });
    attempts.createEl("pre", { text: (exe.attempted || []).join("\n") || "(无)" });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class PermissionRequestModal extends Modal {
  constructor(app, permission, onResolve) {
    super(app);
    this.permission = permission || {};
    this.onResolve = onResolve;
    this.resolved = false;
  }

  resolveAndClose(value) {
    if (this.resolved) return;
    this.resolved = true;
    if (typeof this.onResolve === "function") this.onResolve(value);
    this.close();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("oc-perm-modal");
    contentEl.createEl("h2", { text: "OpenCode 权限请求" });

    const title =
      (typeof this.permission.title === "string" && this.permission.title.trim()) ||
      "模型请求执行受限操作";
    contentEl.createDiv({ cls: "oc-perm-title", text: title });

    const meta = [];
    if (typeof this.permission.type === "string" && this.permission.type) {
      meta.push(`类型: ${this.permission.type}`);
    }
    if (this.permission.pattern) {
      meta.push(`模式: ${stringifyForDisplay(this.permission.pattern, 400)}`);
    }
    if (meta.length) {
      contentEl.createEl("pre", { cls: "oc-perm-meta", text: meta.join("\n") });
    }

    const details = contentEl.createEl("details", { cls: "oc-perm-details" });
    details.createEl("summary", { text: "查看完整 metadata" });
    details.createEl("pre", {
      text: stringifyForDisplay(this.permission.metadata || {}, 2400) || "(empty)",
    });

    const actions = contentEl.createDiv({ cls: "oc-perm-actions" });
    const rejectBtn = actions.createEl("button", { cls: "mod-muted", text: "拒绝" });
    const onceBtn = actions.createEl("button", { cls: "mod-cta", text: "本次允许" });
    const alwaysBtn = actions.createEl("button", { text: "始终允许(本会话)" });

    rejectBtn.addEventListener("click", () => this.resolveAndClose("reject"));
    onceBtn.addEventListener("click", () => this.resolveAndClose("once"));
    alwaysBtn.addEventListener("click", () => this.resolveAndClose("always"));
  }

  onClose() {
    if (!this.resolved && typeof this.onResolve === "function") {
      this.onResolve(null);
    }
    this.contentEl.empty();
  }
}

class PromptAppendModal extends Modal {
  constructor(app, promptText, onSubmit) {
    super(app);
    this.promptText = String(promptText || "");
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("oc-prompt-modal");
    contentEl.createEl("h2", { text: "模型请求补充输入" });
    contentEl.createDiv({
      cls: "oc-prompt-desc",
      text: "OpenCode 通过 question/tool 触发了补充输入请求。你可以编辑后放入输入框继续。",
    });

    const input = contentEl.createEl("textarea", {
      cls: "oc-prompt-input",
      text: this.promptText,
    });

    const actions = contentEl.createDiv({ cls: "oc-prompt-actions" });
    const cancelBtn = actions.createEl("button", { cls: "mod-muted", text: "取消" });
    const useBtn = actions.createEl("button", { cls: "mod-cta", text: "填入输入框" });

    cancelBtn.addEventListener("click", () => this.close());
    useBtn.addEventListener("click", () => {
      if (typeof this.onSubmit === "function") this.onSubmit(String(input.value || ""));
      this.close();
    });

    setTimeout(() => input.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

const HINTS_TEXT = "Enter to select · Tab/Arrow keys to navigate · Esc to cancel";
const HINTS_TEXT_IMMEDIATE = "Enter to select · Arrow keys to navigate · Esc to cancel";

class InlineAskUserQuestionPanel {
  constructor(containerEl, input, resolve, signal, config) {
    this.containerEl = containerEl;
    this.input = input || {};
    this.resolveCallback = typeof resolve === "function" ? resolve : () => {};
    this.signal = signal;
    this.resolved = false;
    this.config = {
      title: (config && config.title) || "Claude has a question",
      headerEl: config && config.headerEl ? config.headerEl : null,
      showCustomInput: config && typeof config.showCustomInput === "boolean" ? config.showCustomInput : true,
      immediateSelect: config && typeof config.immediateSelect === "boolean" ? config.immediateSelect : false,
    };

    this.questions = [];
    this.answers = new Map();
    this.customInputs = new Map();
    this.activeTabIndex = 0;
    this.focusedItemIndex = 0;
    this.isInputFocused = false;
    this.rootEl = null;
    this.tabBar = null;
    this.contentArea = null;
    this.tabElements = [];
    this.currentItems = [];
    this.abortHandler = null;
    this.boundKeyDown = this.handleKeyDown.bind(this);
  }

  render() {
    this.rootEl = this.containerEl.createDiv({ cls: "claudian-ask-question-inline" });

    const titleEl = this.rootEl.createDiv({ cls: "claudian-ask-inline-title" });
    titleEl.setText(this.config.title);

    if (this.config.headerEl) {
      this.rootEl.appendChild(this.config.headerEl);
    }

    this.questions = this.parseQuestions();
    if (!this.questions.length) {
      this.handleResolve(null);
      return;
    }

    if (this.config.immediateSelect && (this.questions.length !== 1 || !Array.isArray(this.questions[0].options) || !this.questions[0].options.length)) {
      this.config.immediateSelect = false;
    }

    for (let i = 0; i < this.questions.length; i += 1) {
      this.answers.set(i, new Set());
      this.customInputs.set(i, "");
    }

    if (!this.config.immediateSelect) {
      this.tabBar = this.rootEl.createDiv({ cls: "claudian-ask-tab-bar" });
      this.renderTabBar();
    }
    this.contentArea = this.rootEl.createDiv({ cls: "claudian-ask-content" });
    this.renderTabContent();

    this.rootEl.setAttribute("tabindex", "0");
    this.rootEl.addEventListener("keydown", this.boundKeyDown);

    requestAnimationFrame(() => {
      if (!this.rootEl) return;
      this.rootEl.focus();
      this.rootEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });

    if (this.signal) {
      this.abortHandler = () => this.handleResolve(null);
      this.signal.addEventListener("abort", this.abortHandler, { once: true });
    }
  }

  destroy(silent = false) {
    if (silent) {
      if (this.resolved) return;
      this.resolved = true;
      if (this.rootEl) this.rootEl.removeEventListener("keydown", this.boundKeyDown);
      if (this.signal && this.abortHandler) {
        this.signal.removeEventListener("abort", this.abortHandler);
        this.abortHandler = null;
      }
      if (this.rootEl) this.rootEl.remove();
      return;
    }
    this.handleResolve(null);
  }

  parseQuestions() {
    const raw = this.input && Array.isArray(this.input.questions) ? this.input.questions : [];
    return raw
      .filter((q) => (
        q &&
        typeof q === "object" &&
        typeof q.question === "string"
      ))
      .map((q, idx) => ({
        question: String(q.question || ""),
        header: typeof q.header === "string" ? q.header.slice(0, 12) : `Q${idx + 1}`,
        options: this.deduplicateOptions((Array.isArray(q.options) ? q.options : []).map((o) => this.coerceOption(o))),
        multiSelect: Boolean(q.multiSelect),
      }))
      .filter((q) => String(q.question || "").trim().length > 0);
  }

  coerceOption(opt) {
    if (opt && typeof opt === "object") {
      const obj = opt;
      const label = this.extractLabel(obj);
      const description = typeof obj.description === "string" ? obj.description : "";
      return { label, description };
    }
    return { label: typeof opt === "string" ? opt : String(opt), description: "" };
  }

  deduplicateOptions(options) {
    const seen = new Set();
    return options.filter((o) => {
      if (!o || typeof o.label !== "string") return false;
      const label = o.label.trim();
      if (!label) return false;
      if (seen.has(label)) return false;
      seen.add(label);
      o.label = label;
      return true;
    });
  }

  extractLabel(obj) {
    if (typeof obj.label === "string") return obj.label;
    if (typeof obj.value === "string") return obj.value;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.name === "string") return obj.name;
    return String(obj);
  }

  renderTabBar() {
    if (!this.tabBar) return;
    this.tabBar.empty();
    this.tabElements = [];

    for (let idx = 0; idx < this.questions.length; idx += 1) {
      const answered = this.isQuestionAnswered(idx);
      const tab = this.tabBar.createSpan({ cls: "claudian-ask-tab" });
      tab.createSpan({ text: this.questions[idx].header, cls: "claudian-ask-tab-label" });
      tab.createSpan({ text: answered ? " ✓" : "", cls: "claudian-ask-tab-tick" });
      tab.setAttribute("title", this.questions[idx].question);
      if (idx === this.activeTabIndex) tab.addClass("is-active");
      if (answered) tab.addClass("is-answered");
      tab.addEventListener("click", () => this.switchTab(idx));
      this.tabElements.push(tab);
    }

    const allAnswered = this.questions.every((_, i) => this.isQuestionAnswered(i));
    const submitTab = this.tabBar.createSpan({ cls: "claudian-ask-tab" });
    submitTab.createSpan({ text: allAnswered ? "✓ " : "", cls: "claudian-ask-tab-submit-check" });
    submitTab.createSpan({ text: "Submit", cls: "claudian-ask-tab-label" });
    if (this.activeTabIndex === this.questions.length) submitTab.addClass("is-active");
    submitTab.addEventListener("click", () => this.switchTab(this.questions.length));
    this.tabElements.push(submitTab);
  }

  isQuestionAnswered(idx) {
    return this.answers.get(idx).size > 0 || this.customInputs.get(idx).trim().length > 0;
  }

  switchTab(index) {
    const clamped = Math.max(0, Math.min(index, this.questions.length));
    if (clamped === this.activeTabIndex) return;
    this.activeTabIndex = clamped;
    this.focusedItemIndex = 0;
    this.isInputFocused = false;
    if (!this.config.immediateSelect) this.renderTabBar();
    this.renderTabContent();
    if (this.rootEl) this.rootEl.focus();
  }

  renderTabContent() {
    if (!this.contentArea) return;
    this.contentArea.empty();
    this.currentItems = [];
    if (this.activeTabIndex < this.questions.length) {
      this.renderQuestionTab(this.activeTabIndex);
    } else {
      this.renderSubmitTab();
    }
  }

  renderQuestionTab(idx) {
    const q = this.questions[idx];
    const isMulti = q.multiSelect;
    const selected = this.answers.get(idx);

    this.contentArea.createDiv({
      text: q.question,
      cls: "claudian-ask-question-text",
    });

    const listEl = this.contentArea.createDiv({ cls: "claudian-ask-list" });
    for (let optIdx = 0; optIdx < q.options.length; optIdx += 1) {
      const option = q.options[optIdx];
      const isFocused = optIdx === this.focusedItemIndex;
      const isSelected = selected.has(option.label);

      const row = listEl.createDiv({ cls: "claudian-ask-item" });
      if (isFocused) row.addClass("is-focused");
      if (isSelected) row.addClass("is-selected");

      row.createSpan({ text: isFocused ? "›" : " ", cls: "claudian-ask-cursor" });
      row.createSpan({ text: `${optIdx + 1}. `, cls: "claudian-ask-item-num" });
      if (isMulti) this.renderMultiSelectCheckbox(row, isSelected);

      const labelBlock = row.createDiv({ cls: "claudian-ask-item-content" });
      const labelRow = labelBlock.createDiv({ cls: "claudian-ask-label-row" });
      labelRow.createSpan({ text: option.label, cls: "claudian-ask-item-label" });
      if (!isMulti && isSelected) {
        labelRow.createSpan({ text: " ✓", cls: "claudian-ask-check-mark" });
      }
      if (option.description) {
        labelBlock.createDiv({ text: option.description, cls: "claudian-ask-item-desc" });
      }

      row.addEventListener("click", () => {
        this.focusedItemIndex = optIdx;
        this.updateFocusIndicator();
        this.selectOption(idx, option.label);
      });
      this.currentItems.push(row);
    }

    if (this.config.showCustomInput) {
      const customIdx = q.options.length;
      const customFocused = customIdx === this.focusedItemIndex;
      const customText = this.customInputs.get(idx) || "";
      const hasCustomText = customText.trim().length > 0;

      const customRow = listEl.createDiv({ cls: "claudian-ask-item claudian-ask-custom-item" });
      if (customFocused) customRow.addClass("is-focused");
      customRow.createSpan({ text: customFocused ? "›" : " ", cls: "claudian-ask-cursor" });
      customRow.createSpan({ text: `${customIdx + 1}. `, cls: "claudian-ask-item-num" });
      if (isMulti) this.renderMultiSelectCheckbox(customRow, hasCustomText);

      const inputEl = customRow.createEl("input", {
        type: "text",
        cls: "claudian-ask-custom-text",
        placeholder: "Type something.",
        value: customText,
      });
      inputEl.addEventListener("input", () => {
        this.customInputs.set(idx, inputEl.value);
        if (!isMulti && inputEl.value.trim()) {
          selected.clear();
          this.updateOptionVisuals(idx);
        }
        this.updateTabIndicators();
      });
      inputEl.addEventListener("focus", () => {
        this.isInputFocused = true;
      });
      inputEl.addEventListener("blur", () => {
        this.isInputFocused = false;
      });
      this.currentItems.push(customRow);
    }

    this.contentArea.createDiv({
      text: this.config.immediateSelect ? HINTS_TEXT_IMMEDIATE : HINTS_TEXT,
      cls: "claudian-ask-hints",
    });
  }

  renderSubmitTab() {
    this.contentArea.createDiv({
      text: "Review your answers",
      cls: "claudian-ask-review-title",
    });

    const reviewEl = this.contentArea.createDiv({ cls: "claudian-ask-review" });
    for (let idx = 0; idx < this.questions.length; idx += 1) {
      const q = this.questions[idx];
      const answerText = this.getAnswerText(idx);

      const pairEl = reviewEl.createDiv({ cls: "claudian-ask-review-pair" });
      pairEl.createDiv({ text: `${idx + 1}.`, cls: "claudian-ask-review-num" });
      const bodyEl = pairEl.createDiv({ cls: "claudian-ask-review-body" });
      bodyEl.createDiv({ text: q.question, cls: "claudian-ask-review-q-text" });
      bodyEl.createDiv({
        text: answerText || "Not answered",
        cls: answerText ? "claudian-ask-review-a-text" : "claudian-ask-review-empty",
      });
      pairEl.addEventListener("click", () => this.switchTab(idx));
    }

    this.contentArea.createDiv({
      text: "Ready to submit your answers?",
      cls: "claudian-ask-review-prompt",
    });

    const actionsEl = this.contentArea.createDiv({ cls: "claudian-ask-list" });
    const allAnswered = this.questions.every((_, i) => this.isQuestionAnswered(i));

    const submitRow = actionsEl.createDiv({ cls: "claudian-ask-item" });
    if (this.focusedItemIndex === 0) submitRow.addClass("is-focused");
    if (!allAnswered) submitRow.addClass("is-disabled");
    submitRow.createSpan({ text: this.focusedItemIndex === 0 ? "›" : " ", cls: "claudian-ask-cursor" });
    submitRow.createSpan({ text: "1. ", cls: "claudian-ask-item-num" });
    submitRow.createSpan({ text: "Submit answers", cls: "claudian-ask-item-label" });
    submitRow.addEventListener("click", () => {
      this.focusedItemIndex = 0;
      this.updateFocusIndicator();
      this.handleSubmit();
    });
    this.currentItems.push(submitRow);

    const cancelRow = actionsEl.createDiv({ cls: "claudian-ask-item" });
    if (this.focusedItemIndex === 1) cancelRow.addClass("is-focused");
    cancelRow.createSpan({ text: this.focusedItemIndex === 1 ? "›" : " ", cls: "claudian-ask-cursor" });
    cancelRow.createSpan({ text: "2. ", cls: "claudian-ask-item-num" });
    cancelRow.createSpan({ text: "Cancel", cls: "claudian-ask-item-label" });
    cancelRow.addEventListener("click", () => {
      this.focusedItemIndex = 1;
      this.handleResolve(null);
    });
    this.currentItems.push(cancelRow);

    this.contentArea.createDiv({
      text: HINTS_TEXT,
      cls: "claudian-ask-hints",
    });
  }

  getAnswerText(idx) {
    const selected = this.answers.get(idx);
    const custom = this.customInputs.get(idx);
    const parts = [];
    if (selected.size > 0) parts.push([...selected].join(", "));
    if (custom.trim()) parts.push(custom.trim());
    return parts.join(", ");
  }

  selectOption(qIdx, label) {
    const q = this.questions[qIdx];
    const selected = this.answers.get(qIdx);
    const isMulti = q.multiSelect;

    if (isMulti) {
      if (selected.has(label)) selected.delete(label);
      else selected.add(label);
    } else {
      selected.clear();
      selected.add(label);
      this.customInputs.set(qIdx, "");
    }

    this.updateOptionVisuals(qIdx);
    if (this.config.immediateSelect) {
      const result = {};
      result[q.question] = label;
      this.handleResolve(result);
      return;
    }

    this.updateTabIndicators();
    if (!isMulti) this.switchTab(this.activeTabIndex + 1);
  }

  renderMultiSelectCheckbox(parent, checked) {
    parent.createSpan({
      text: checked ? "[✓] " : "[ ] ",
      cls: `claudian-ask-check${checked ? " is-checked" : ""}`,
    });
  }

  updateOptionVisuals(qIdx) {
    const q = this.questions[qIdx];
    const selected = this.answers.get(qIdx);
    const isMulti = q.multiSelect;

    for (let i = 0; i < q.options.length; i += 1) {
      const item = this.currentItems[i];
      if (!item) continue;
      const isSelected = selected.has(q.options[i].label);
      item.toggleClass("is-selected", isSelected);

      if (isMulti) {
        const checkSpan = item.querySelector(".claudian-ask-check");
        if (checkSpan) {
          checkSpan.textContent = isSelected ? "[✓] " : "[ ] ";
          checkSpan.toggleClass("is-checked", isSelected);
        }
      } else {
        const labelRow = item.querySelector(".claudian-ask-label-row");
        const existingMark = item.querySelector(".claudian-ask-check-mark");
        if (isSelected && !existingMark && labelRow) {
          labelRow.createSpan({ text: " ✓", cls: "claudian-ask-check-mark" });
        } else if (!isSelected && existingMark) {
          existingMark.remove();
        }
      }
    }
  }

  updateFocusIndicator() {
    for (let i = 0; i < this.currentItems.length; i += 1) {
      const item = this.currentItems[i];
      const cursor = item.querySelector(".claudian-ask-cursor");
      if (i === this.focusedItemIndex) {
        item.addClass("is-focused");
        if (cursor) cursor.textContent = "›";
        item.scrollIntoView({ block: "nearest" });
        if (item.classList && item.classList.contains("claudian-ask-custom-item")) {
          const input = item.querySelector(".claudian-ask-custom-text");
          if (input) {
            input.focus();
            this.isInputFocused = true;
          }
        }
      } else {
        item.removeClass("is-focused");
        if (cursor) cursor.textContent = " ";
        if (item.classList && item.classList.contains("claudian-ask-custom-item")) {
          const input = item.querySelector(".claudian-ask-custom-text");
          if (input && document.activeElement === input) {
            input.blur();
            this.isInputFocused = false;
          }
        }
      }
    }
  }

  updateTabIndicators() {
    for (let idx = 0; idx < this.questions.length; idx += 1) {
      const tab = this.tabElements[idx];
      if (!tab) continue;
      const tick = tab.querySelector(".claudian-ask-tab-tick");
      const answered = this.isQuestionAnswered(idx);
      tab.toggleClass("is-answered", answered);
      if (tick) tick.textContent = answered ? " ✓" : "";
    }

    const submitTab = this.tabElements[this.questions.length];
    if (submitTab) {
      const submitCheck = submitTab.querySelector(".claudian-ask-tab-submit-check");
      const allAnswered = this.questions.every((_, i) => this.isQuestionAnswered(i));
      if (submitCheck) submitCheck.textContent = allAnswered ? "✓ " : "";
    }
  }

  handleNavigationKey(e, maxFocusIndex) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        e.stopPropagation();
        this.focusedItemIndex = Math.min(this.focusedItemIndex + 1, maxFocusIndex);
        this.updateFocusIndicator();
        return true;
      case "ArrowUp":
        e.preventDefault();
        e.stopPropagation();
        this.focusedItemIndex = Math.max(this.focusedItemIndex - 1, 0);
        this.updateFocusIndicator();
        return true;
      case "ArrowLeft":
        if (this.config.immediateSelect) return false;
        e.preventDefault();
        e.stopPropagation();
        this.switchTab(this.activeTabIndex - 1);
        return true;
      case "Tab":
        if (this.config.immediateSelect) return false;
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) this.switchTab(this.activeTabIndex - 1);
        else this.switchTab(this.activeTabIndex + 1);
        return true;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        this.handleResolve(null);
        return true;
      default:
        return false;
    }
  }

  handleKeyDown(e) {
    if (this.isInputFocused) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.isInputFocused = false;
        if (document.activeElement) document.activeElement.blur();
        if (this.rootEl) this.rootEl.focus();
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        this.isInputFocused = false;
        if (document.activeElement) document.activeElement.blur();
        if (e.key === "Tab" && e.shiftKey) this.switchTab(this.activeTabIndex - 1);
        else this.switchTab(this.activeTabIndex + 1);
        return;
      }
      return;
    }

    if (this.config.immediateSelect) {
      const q = this.questions[this.activeTabIndex];
      const maxIdx = q.options.length - 1;
      if (this.handleNavigationKey(e, maxIdx)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (this.focusedItemIndex <= maxIdx) {
          this.selectOption(this.activeTabIndex, q.options[this.focusedItemIndex].label);
        }
      }
      return;
    }

    const isSubmitTab = this.activeTabIndex === this.questions.length;
    const q = this.questions[this.activeTabIndex];
    const maxFocusIndex = isSubmitTab ? 1 : (this.config.showCustomInput ? q.options.length : q.options.length - 1);
    if (this.handleNavigationKey(e, maxFocusIndex)) return;

    if (isSubmitTab) {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (this.focusedItemIndex === 0) this.handleSubmit();
        else this.handleResolve(null);
      }
      return;
    }

    if (e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      this.switchTab(this.activeTabIndex + 1);
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (this.focusedItemIndex < q.options.length) {
        this.selectOption(this.activeTabIndex, q.options[this.focusedItemIndex].label);
      } else if (this.config.showCustomInput) {
        this.isInputFocused = true;
        const input = this.contentArea.querySelector(".claudian-ask-custom-text");
        if (input) input.focus();
      }
    }
  }

  handleSubmit() {
    const allAnswered = this.questions.every((_, i) => this.isQuestionAnswered(i));
    if (!allAnswered) return;

    const result = {};
    for (let i = 0; i < this.questions.length; i += 1) {
      result[this.questions[i].question] = this.getAnswerText(i);
    }
    this.handleResolve(result);
  }

  handleResolve(result) {
    if (this.resolved) return;
    this.resolved = true;
    if (this.rootEl) this.rootEl.removeEventListener("keydown", this.boundKeyDown);
    if (this.signal && this.abortHandler) {
      this.signal.removeEventListener("abort", this.abortHandler);
      this.abortHandler = null;
    }
    if (this.rootEl) this.rootEl.remove();
    this.resolveCallback(result);
  }
}

class ModelSelectorModal extends Modal {
  constructor(app, options) {
    super(app);
    this.options = options || {};
    this.filterText = "";
    this.listEl = null;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("oc-model-modal");

    contentEl.createEl("h2", { text: "选择模型" });
    contentEl.createDiv({
      cls: "oc-model-modal-subtitle",
      text: "使用官方模型列表（来自 OpenCode provider 配置）",
    });

    const search = contentEl.createEl("input", {
      cls: "oc-model-search",
      attr: { type: "text", placeholder: "搜索 provider/model…" },
    });
    search.addEventListener("input", () => {
      this.filterText = String(search.value || "").trim().toLowerCase();
      this.renderList();
    });

    const actions = contentEl.createDiv({ cls: "oc-model-modal-actions" });
    const refreshBtn = actions.createEl("button", { text: "刷新列表" });
    refreshBtn.addEventListener("click", async () => {
      if (typeof this.options.onRefresh !== "function") return;
      refreshBtn.disabled = true;
      refreshBtn.setText("刷新中...");
      try {
        const refreshed = await this.options.onRefresh();
        if (Array.isArray(refreshed)) this.options.models = refreshed;
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.setText("刷新列表");
        this.renderList();
      }
    });

    const clearBtn = actions.createEl("button", { text: "恢复默认" });
    clearBtn.addEventListener("click", async () => {
      if (typeof this.options.onSelect === "function") await this.options.onSelect("");
      this.close();
    });

    this.listEl = contentEl.createDiv({ cls: "oc-model-list" });
    this.renderList();
  }

  renderList() {
    if (!this.listEl) return;
    this.listEl.empty();

    const models = Array.isArray(this.options.models) ? this.options.models : [];
    const filtered = models.filter((item) => {
      if (!this.filterText) return true;
      return String(item || "").toLowerCase().includes(this.filterText);
    });

    if (!filtered.length) {
      this.listEl.createDiv({ cls: "oc-model-empty", text: "未找到匹配模型" });
      return;
    }

    filtered.forEach((model) => {
      const row = this.listEl.createDiv({ cls: "oc-model-item" });
      if (model === this.options.currentModel) row.addClass("is-active");
      row.createDiv({ cls: "oc-model-item-id", text: model });
      row.createDiv({ cls: "oc-model-item-meta", text: model === this.options.currentModel ? "当前使用" : "点击切换" });

      row.addEventListener("click", async () => {
        if (typeof this.options.onSelect === "function") await this.options.onSelect(model);
        this.close();
      });
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

class OpenCodeAssistantView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.root = null;
    this.elements = {};
    this.currentAbort = null;
    this.selectedModel = "";
    this.isSidebarCollapsed = false;
    this.questionAnswerStates = new Map();
    this.questionSubmitAt = new Map();
    this.pendingQuestionRequests = new Map();
    this.inlineQuestionWidget = null;
    this.inlineQuestionKey = "";
    this.lastQuestionResolveLogAt = 0;
    this.silentAbortBudget = 0;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "OpenCode 助手";
  }

  getIcon() {
    return "bot";
  }

  async onOpen() {
    this.selectedModel = this.plugin.settings.defaultModel || "";
    try {
      await this.plugin.bootstrapData();
    } catch (e) {
      new Notice(`初始化失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.render();
  }

  onClose() {
    this.clearInlineQuestionWidget(true);
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }
  }

  openSettings() {
    this.app.setting.open();
    this.app.setting.openTabById(this.plugin.manifest.id);
  }

  buildIconButton(parent, icon, label, onClick, cls = "") {
    const btn = parent.createEl("button", { cls: `oc-icon-btn ${cls}`.trim() });
    setIcon(btn, icon);
    btn.setAttr("aria-label", label);
    btn.setAttr("title", label);
    btn.addEventListener("click", onClick);
    return btn;
  }

  createSvgNode(tag, attrs = {}) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, String(v)));
    return node;
  }

  renderSidebarToggleIcon(button) {
    if (!button) return;
    button.innerHTML = "";

    const svg = this.createSvgNode("svg", {
      class: "oc-side-toggle-icon",
      viewBox: "0 0 20 20",
      "aria-hidden": "true",
      focusable: "false",
    });

    svg.appendChild(this.createSvgNode("rect", {
      x: "2.75",
      y: "3.25",
      width: "14.5",
      height: "13.5",
      rx: "2",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.3",
    }));
    svg.appendChild(this.createSvgNode("line", {
      x1: "7.2",
      y1: "3.7",
      x2: "7.2",
      y2: "16.3",
      stroke: "currentColor",
      "stroke-width": "1.2",
    }));
    svg.appendChild(this.createSvgNode("path", {
      d: this.isSidebarCollapsed ? "M10.4 6.8L13.6 10L10.4 13.2" : "M12.8 6.8L9.6 10L12.8 13.2",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.7",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }));

    button.appendChild(svg);
  }

  getSkillPrimaryDescription(skill) {
    if (!skill) return "选择技能后会显示主要功能说明。";

    const cleanInline = (line) => String(line || "")
      .trim()
      .replace(/^[-*]\s+/, "")
      .replace(/^>\s+/, "")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .trim();

    const directRaw = String(skill.description || "").trim();
    const isBlockMarker = /^([>|][+-]?)$/.test(directRaw);
    if (!isBlockMarker && directRaw) {
      const directLines = directRaw
        .split(/\r?\n/)
        .map((line) => cleanInline(line))
        .filter((line) => line && !/^[-:| ]+$/.test(line));
      if (directLines.length) return directLines[0];
    }

    const lines = String(skill.summary || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        if (!line.startsWith("|")) return line.replace(/^[-*]\s+/, "");
        const cells = line
          .split("|")
          .map((cell) => cell.trim().replace(/^[-*]\s+/, ""))
          .filter(Boolean);
        const picked = cells.find((cell) => (
          !/^[-:]+$/.test(cell) &&
          !/^(name|名称|命令|command|技能|skill|功能|作用|描述|description)$/i.test(cell) &&
          !cell.startsWith("/")
        ));
        return picked || "";
      })
      .map((line) => cleanInline(line))
      .filter((line) => (
        line &&
        !/^#{1,6}\s/.test(line) &&
        !/^```/.test(line) &&
        !/^[-:| ]+$/.test(line)
      ));

    return lines[0] || "暂无技能说明";
  }

  scrollMessagesTo(target) {
    const messages = this.elements.messages;
    if (!messages) return;
    if (target === "top") messages.scrollTop = 0;
    else messages.scrollTop = messages.scrollHeight;
  }

  toggleSidebarCollapsed() {
    this.isSidebarCollapsed = !this.isSidebarCollapsed;
    this.render();
  }

  activeSessionLabel() {
    const st = this.plugin.sessionStore.state();
    const session = st.sessions.find((s) => s.id === st.activeSessionId);
    if (!session) return "未选择会话";
    return session.title || "未命名会话";
  }

  parseModelSlashCommand(text) {
    const input = String(text || "").trim();
    if (!input.startsWith("/")) return null;

    const raw = input.slice(1).trim();
    if (!raw) return null;

    const firstSpace = raw.indexOf(" ");
    const cmd = (firstSpace >= 0 ? raw.slice(0, firstSpace) : raw).trim().toLowerCase();
    const args = (firstSpace >= 0 ? raw.slice(firstSpace + 1) : "").trim();

    if (!["models", "model", "modle"].includes(cmd)) return null;
    return { command: "models", args };
  }

  parseSkillSelectorSlashCommand(text) {
    const input = String(text || "").trim();
    if (!input.startsWith("/")) return null;

    const raw = input.slice(1).trim();
    if (!raw) return null;

    const firstSpace = raw.indexOf(" ");
    const cmd = (firstSpace >= 0 ? raw.slice(0, firstSpace) : raw).trim().toLowerCase();
    if (!["skills", "skill"].includes(cmd)) return null;
    return { command: "skills" };
  }

  resolveSkillFromPrompt(userText) {
    const input = String(userText || "").trim();
    if (!input.startsWith("/")) return { skill: null, promptText: input };

    const raw = input.slice(1).trim();
    if (!raw) return { skill: null, promptText: input };

    const firstSpace = raw.indexOf(" ");
    const cmd = (firstSpace >= 0 ? raw.slice(0, firstSpace) : raw).trim();
    const cmdLower = cmd.toLowerCase();
    if (!cmdLower) return { skill: null, promptText: input };
    if (["models", "model", "modle", "skills", "skill"].includes(cmdLower)) {
      return { skill: null, promptText: input };
    }

    const skills = this.plugin.skillService.getSkills();
    const skill = skills.find((item) => {
      const id = String(item.id || "").toLowerCase();
      const name = String(item.name || "").toLowerCase();
      return id === cmdLower || name === cmdLower;
    });

    if (!skill) return { skill: null, promptText: input };

    const rest = (firstSpace >= 0 ? raw.slice(firstSpace + 1) : "").trim();
    const promptText = rest || `请按技能 ${skill.name || skill.id} 处理当前任务。`;
    return { skill, promptText };
  }

  openSkillSelector() {
    const skills = this.plugin.skillService.getSkills();
    if (!skills.length) {
      new Notice("当前未发现可用技能，请先检查 Skills 目录设置。");
      return;
    }
    const select = this.elements.skillSelect;
    if (!select || select.disabled) {
      new Notice("技能下拉尚未初始化，请稍后再试。");
      return;
    }
    select.focus();
    if (typeof select.showPicker === "function") {
      try {
        select.showPicker();
        return;
      } catch {
      }
    }
    this.setRuntimeStatus("请从技能下拉列表中选择技能。", "info");
  }

  async refreshModelList() {
    const models = await this.plugin.opencodeClient.listModels();
    this.plugin.cachedModels = Array.isArray(models) ? models : [];
    return this.plugin.cachedModels;
  }

  async ensureActiveSession() {
    const st = this.plugin.sessionStore.state();
    if (st.activeSessionId) return st.activeSessionId;
    const session = await this.plugin.createSession("新会话");
    this.plugin.sessionStore.setActiveSession(session.id);
    await this.plugin.persistState();
    return session.id;
  }

  appendAssistantMessage(sessionId, text, error = "") {
    this.plugin.sessionStore.appendMessage(sessionId, {
      id: uid("msg"),
      role: "assistant",
      text: String(text || ""),
      error: String(error || ""),
      pending: false,
      createdAt: Date.now(),
    });
  }

  async applyModelSelection(modelID, options = {}) {
    const normalized = String(modelID || "").trim();
    const previous = String(this.selectedModel || "");
    const previousSetting = String(this.plugin.settings.defaultModel || "");

    this.selectedModel = normalized;
    this.plugin.settings.defaultModel = normalized;
    await this.plugin.saveSettings();

    if (this.elements.modelSelect) {
      this.elements.modelSelect.value = normalized;
    }

    try {
      if (normalized) {
        await this.plugin.opencodeClient.setDefaultModel({ model: normalized });
        if (!options.silentNotice) new Notice(`已切换模型：${normalized}`);
        return `已切换模型：${normalized}`;
      }

      if (!options.silentNotice) new Notice("已恢复默认模型（由 OpenCode 自动选择）");
      return "已恢复默认模型（由 OpenCode 自动选择）";
    } catch (e) {
      this.selectedModel = previous;
      this.plugin.settings.defaultModel = previousSetting;
      await this.plugin.saveSettings();
      if (this.elements.modelSelect) this.elements.modelSelect.value = previous;
      throw e;
    }
  }

  async openModelSelector(sessionId) {
    const models = this.plugin.cachedModels && this.plugin.cachedModels.length
      ? this.plugin.cachedModels
      : await this.refreshModelList();

    new ModelSelectorModal(this.app, {
      models,
      currentModel: this.selectedModel,
      onRefresh: async () => this.refreshModelList(),
      onSelect: async (picked) => {
        try {
          const text = await this.applyModelSelection(picked);
          this.appendAssistantMessage(sessionId, text, "");
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.appendAssistantMessage(sessionId, `模型切换失败: ${msg}`, msg);
          new Notice(`模型切换失败: ${msg}`);
        } finally {
          await this.plugin.persistState();
          this.renderMessages();
          this.renderSidebar(this.root.querySelector(".oc-side"));
        }
      },
    }).open();
  }

  async handleModelSlashCommand(userText, parsed) {
    const sessionId = await this.ensureActiveSession();
    this.plugin.sessionStore.appendMessage(sessionId, {
      id: uid("msg"),
      role: "user",
      text: userText,
      createdAt: Date.now(),
    });

    if (!parsed.args) {
      this.appendAssistantMessage(sessionId, "已打开模型选择器。请选择一个模型。", "");
      await this.plugin.persistState();
      this.renderMessages();
      this.renderSidebar(this.root.querySelector(".oc-side"));
      await this.openModelSelector(sessionId);
      return;
    }

    try {
      const text = await this.applyModelSelection(parsed.args, { silentNotice: true });
      this.appendAssistantMessage(sessionId, text, "");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.appendAssistantMessage(sessionId, `模型切换失败: ${msg}`, msg);
      new Notice(`模型切换失败: ${msg}`);
    }

    await this.plugin.persistState();
    this.renderMessages();
    this.renderSidebar(this.root.querySelector(".oc-side"));
  }

  render() {
    this.clearInlineQuestionWidget(true);
    const container = this.contentEl || this.containerEl.children[1] || this.containerEl;
    container.empty();
    container.addClass("oc-root", "oc-surface");
    this.root = container;

    const shell = container.createDiv({ cls: "oc-shell" });
    const header = shell.createDiv({ cls: "oc-header" });
    this.renderHeader(header);

    const body = shell.createDiv({ cls: "oc-body" });
    body.toggleClass("is-side-collapsed", this.isSidebarCollapsed);
    const side = body.createDiv({ cls: "oc-side" });
    const main = body.createDiv({ cls: "oc-main" });

    this.elements.body = body;
    this.elements.side = side;
    this.elements.main = main;

    this.renderSidebar(side);
    this.renderMain(main);
  }

  renderHeader(header) {
    header.empty();

    const brand = header.createDiv({ cls: "oc-brand" });
    const logo = brand.createDiv({ cls: "oc-brand-logo" });
    setIcon(logo, "bot");
    brand.createDiv({ cls: "oc-brand-title", text: "OpenCode Assistant" });
  }

  renderSidebar(side) {
    side.empty();
    side.toggleClass("is-collapsed", this.isSidebarCollapsed);

    const header = side.createDiv({ cls: "oc-side-header" });
    header.createEl("h3", { text: "会话" });

    const sideActions = header.createDiv({ cls: "oc-side-actions" });
    const toggleBtn = sideActions.createEl("button", { cls: "oc-side-toggle" });
    toggleBtn.setAttr("aria-label", this.isSidebarCollapsed ? "展开会话列表" : "收起会话列表");
    toggleBtn.setAttr("title", this.isSidebarCollapsed ? "展开会话列表" : "收起会话列表");
    this.renderSidebarToggleIcon(toggleBtn);
    toggleBtn.addEventListener("click", () => this.toggleSidebarCollapsed());

    if (this.isSidebarCollapsed) {
      return;
    }

    const addBtn = sideActions.createEl("button", { cls: "oc-side-add", text: "新建" });
    addBtn.addEventListener("click", async () => {
      try {
        const session = await this.plugin.createSession("新会话");
        this.plugin.sessionStore.setActiveSession(session.id);
        await this.plugin.persistState();
        this.render();
      } catch (e) {
        new Notice(e instanceof Error ? e.message : String(e));
      }
    });

    const sessions = this.plugin.sessionStore.state().sessions;
    const active = this.plugin.sessionStore.state().activeSessionId;
    side.createDiv({ cls: "oc-side-count", text: `${sessions.length} 个会话` });
    const list = side.createDiv({ cls: "oc-session-list" });

    if (!sessions.length) {
      list.createDiv({ cls: "oc-empty", text: "暂无会话，点击“新建”开始。" });
      return;
    }

    sessions.forEach((s) => {
      const item = list.createDiv({ cls: "oc-session-item" });
      if (s.id === active) item.addClass("is-active");
      item.addEventListener("click", async () => {
        this.plugin.sessionStore.setActiveSession(s.id);
        await this.plugin.persistState();
        this.render();
      });

      item.createDiv({ cls: "oc-session-title", text: s.title || "未命名会话" });
      if (s.lastUserPrompt) {
        item.createDiv({ cls: "oc-session-preview", text: s.lastUserPrompt });
      }

      item.createDiv({ cls: "oc-session-meta", text: s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "" });
    });

    side.createDiv({
      cls: "oc-side-footer",
      text: "兼容 OpenCode 会话、技能注入、模型切换与诊断。",
    });
  }

  renderMain(main) {
    main.empty();

    const toolbar = main.createDiv({ cls: "oc-toolbar" });
    const toolbarLeft = toolbar.createDiv({ cls: "oc-toolbar-left" });
    const toolbarRight = toolbar.createDiv({ cls: "oc-toolbar-right" });

    this.elements.statusPill = toolbarLeft.createDiv({ cls: "oc-status-pill", text: "Checking..." });

    const modelSelect = toolbarLeft.createEl("select", { cls: "oc-select" });
    this.elements.modelSelect = modelSelect;
    modelSelect.createEl("option", { value: "", text: "模型: 默认（官方）" });
    (this.plugin.cachedModels || []).forEach((m) => modelSelect.createEl("option", { value: m, text: `模型: ${m}` }));
    if (this.selectedModel) modelSelect.value = this.selectedModel;
    modelSelect.addEventListener("change", async () => {
      try {
        await this.applyModelSelection(modelSelect.value);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        modelSelect.value = this.selectedModel || "";
        new Notice(`模型切换失败: ${msg}`);
      }
    });

    const retryBtn = toolbarRight.createEl("button", { cls: "oc-toolbar-btn", text: "重试上条" });
    retryBtn.addEventListener("click", async () => {
      const active = this.plugin.sessionStore.state().activeSessionId;
      const messages = this.plugin.sessionStore.state().messagesBySession[active] || [];
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      if (!lastUser) return new Notice("没有可重试的用户消息");
      await this.sendPrompt(lastUser.text);
    });

    const diagBtn = toolbarRight.createEl("button", { cls: "oc-toolbar-btn", text: "诊断" });
    diagBtn.addEventListener("click", async () => {
      const result = await this.plugin.diagnosticsService.run();
      new DiagnosticsModal(this.app, result).open();
      this.applyStatus(result);
    });

    const settingsBtn = this.buildIconButton(toolbarRight, "settings", "设置", () => this.openSettings());
    settingsBtn.addClass("oc-toolbar-btn");

    const messagesWrapper = main.createDiv({ cls: "oc-messages-wrapper" });
    this.elements.messages = messagesWrapper.createDiv({ cls: "oc-messages oc-messages-focusable", attr: { tabindex: "0" } });
    this.elements.inlineQuestionHost = messagesWrapper.createDiv({ cls: "oc-inline-question-host" });
    this.renderMessages();

    const navSidebar = messagesWrapper.createDiv({ cls: "oc-nav-sidebar visible" });
    const topBtn = navSidebar.createEl("button", { cls: "oc-nav-btn oc-nav-btn-top" });
    setIcon(topBtn, "chevrons-up");
    topBtn.addEventListener("click", () => this.scrollMessagesTo("top"));
    const bottomBtn = navSidebar.createEl("button", { cls: "oc-nav-btn oc-nav-btn-bottom" });
    setIcon(bottomBtn, "chevrons-down");
    bottomBtn.addEventListener("click", () => this.scrollMessagesTo("bottom"));

    const contextFooter = main.createDiv({ cls: "oc-context-footer" });
    contextFooter.createDiv({ cls: "oc-context-session", text: `当前会话：${this.activeSessionLabel()}` });

    const composer = main.createDiv({ cls: "oc-composer" });
    this.elements.composer = composer;
    const navRow = composer.createDiv({ cls: "oc-input-nav-row" });
    const quick = navRow.createDiv({ cls: "oc-quick" });

    const skillPicker = quick.createDiv({ cls: "oc-skill-picker" });
    const skillSelect = skillPicker.createEl("select", { cls: "oc-skill-select" });
    this.elements.skillSelect = skillSelect;
    skillSelect.createEl("option", { value: "", text: "技能 /skills" });

    const skillDescription = skillPicker.createDiv({
      cls: "oc-skill-select-desc",
      text: "选择技能后会显示主要功能说明。",
    });
    this.elements.skillDescription = skillDescription;

    const skills = this.plugin.skillService.getSkills();
    skills.forEach((skill) => {
      const mainFeature = this.getSkillPrimaryDescription(skill);
      skillSelect.createEl("option", {
        value: skill.id,
        text: `${skill.name || skill.id} (/${skill.id}) - ${mainFeature}`,
      });
    });

    if (!skills.length) {
      skillSelect.disabled = true;
      skillDescription.setText("当前未发现可用技能，请检查 Skills 目录设置。");
    } else {
      skillSelect.addEventListener("change", () => {
        const selectedId = String(skillSelect.value || "");
        const picked = skills.find((skill) => String(skill.id) === selectedId);
        if (!picked) {
          skillDescription.setText("选择技能后会显示主要功能说明。");
          return;
        }

        skillDescription.setText(this.getSkillPrimaryDescription(picked));
        if (this.elements.input) {
          this.elements.input.value = `/${picked.id} `;
          this.elements.input.focus();
        }
        this.setRuntimeStatus(`已填入技能命令：/${picked.id}`, "info");
      });
    }

    const modelCmdBtn = quick.createEl("button", { cls: "oc-quick-btn", text: "模型 /models" });
    modelCmdBtn.addEventListener("click", async () => {
      const sessionId = await this.ensureActiveSession();
      await this.openModelSelector(sessionId);
    });
    navRow.createDiv({ cls: "oc-nav-row-meta", text: "Ctrl/Cmd + Enter 发送" });

    const inputWrapper = composer.createDiv({ cls: "oc-input-wrapper" });
    this.elements.input = inputWrapper.createEl("textarea", {
      cls: "oc-input",
      attr: { placeholder: "输入消息…支持技能注入和模型切换" },
    });
    this.elements.input.addEventListener("keydown", (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
        ev.preventDefault();
        this.handleSend();
      }
    });

    const inputToolbar = inputWrapper.createDiv({ cls: "oc-input-toolbar" });
    inputToolbar.createDiv({ cls: "oc-input-meta", text: "OpenCode Compat Runtime" });

    const actions = inputToolbar.createDiv({ cls: "oc-actions" });
    this.elements.sendBtn = actions.createEl("button", { cls: "mod-cta oc-send-btn", text: "发送" });
    this.elements.cancelBtn = actions.createEl("button", { cls: "mod-muted oc-cancel-btn", text: "取消" });
    this.elements.cancelBtn.disabled = true;

    this.elements.sendBtn.addEventListener("click", () => this.handleSend());
    this.elements.cancelBtn.addEventListener("click", () => this.cancelSending());

    composer.createDiv({
      cls: "oc-hint",
      text: "支持会话切换、技能命令、模型切换、连接诊断和错误恢复。可通过技能下拉或 /skills 快速填入命令，/models、/model、/modle 会触发模型选择器。若看到 ENOENT，请在设置页填入 OpenCode 绝对路径。",
    });
    this.elements.runtimeStatus = composer.createDiv({ cls: "oc-runtime-status is-hidden", text: "" });

    this.renderInlineQuestionPanel(this.plugin.sessionStore.getActiveMessages());
    this.plugin.diagnosticsService.run().then((r) => this.applyStatus(r));
  }

  applyStatus(result) {
    if (!this.elements.statusPill) return;
    this.elements.statusPill.removeClass("ok", "error", "warn");

    if (!result || !result.connection) {
      this.elements.statusPill.addClass("warn");
      this.elements.statusPill.setText("Unknown");
      return;
    }

    if (result.connection.ok) {
      this.elements.statusPill.addClass("ok");
      this.elements.statusPill.setText(`Connected (${result.connection.mode})`);
      return;
    }

    this.elements.statusPill.addClass("error");
    this.elements.statusPill.setText("Connection Error");
  }

  renderMessages() {
    const container = this.elements.messages;
    if (!container) return;
    container.empty();

    const messages = this.plugin.sessionStore.getActiveMessages();
    this.pruneQuestionAnswerStates(messages);
    if (!messages.length) {
      const welcome = container.createDiv({ cls: "oc-welcome" });
      welcome.createDiv({ cls: "oc-welcome-greeting", text: "今天想整理什么？" });
      welcome.createDiv({ cls: "oc-empty", text: "发送一条消息，或先从技能下拉中选择一个技能。" });
      this.renderInlineQuestionPanel(messages);
      return;
    }

    messages.forEach((m) => this.renderMessageItem(container, m));
    container.scrollTop = container.scrollHeight;
    this.renderInlineQuestionPanel(messages);
  }

  renderUserActions(row, message) {
    const actions = row.createDiv({ cls: "oc-user-msg-actions" });

    const copyBtn = actions.createEl("button", { cls: "oc-inline-action" });
    setIcon(copyBtn, "copy");
    copyBtn.setAttr("aria-label", "复制消息");
    copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(message.text || "");
      new Notice("用户消息已复制");
    });

    const retryBtn = actions.createEl("button", { cls: "oc-inline-action" });
    setIcon(retryBtn, "rotate-ccw");
    retryBtn.setAttr("aria-label", "基于此消息重试");
    retryBtn.addEventListener("click", async () => {
      await this.sendPrompt(message.text || "");
    });
  }

  attachCodeCopyButtons(container) {
    if (!container) return;
    container.querySelectorAll("pre").forEach((pre) => {
      if (pre.querySelector(".oc-copy-btn")) return;
      const btn = document.createElement("button");
      btn.className = "oc-copy-btn";
      btn.textContent = "复制";
      btn.addEventListener("click", async () => {
        const code = pre.querySelector("code");
        await navigator.clipboard.writeText(code ? code.innerText : pre.innerText);
        new Notice("代码已复制");
      });
      pre.prepend(btn);
    });
  }

  ensureReasoningContainer(row, openByDefault) {
    let details = row.querySelector(".oc-message-reasoning");
    if (!details) {
      details = document.createElement("details");
      details.addClass("oc-message-reasoning");
      details.createEl("summary", { text: "思考过程（可折叠）" });
      details.createDiv({ cls: "oc-message-reasoning-body" });
      const body = row.querySelector(".oc-message-content");
      if (body && body.parentElement === row) {
        row.insertBefore(details, body);
      } else {
        row.appendChild(details);
      }
    }
    if (openByDefault) details.open = true;
    return details.querySelector(".oc-message-reasoning-body");
  }

  ensureBlocksContainer(row) {
    let container = row.querySelector(".oc-part-list");
    if (!container) {
      container = row.createDiv({ cls: "oc-part-list" });
    }
    return container;
  }

  reorderAssistantMessageLayout(row) {
    if (!row) return;
    const body = row.querySelector(".oc-message-content");
    if (!body || body.parentElement !== row) return;

    const reasoning = row.querySelector(".oc-message-reasoning");
    if (reasoning && reasoning.parentElement === row) {
      row.insertBefore(reasoning, body);
    }

    const parts = row.querySelector(".oc-part-list");
    if (parts && parts.parentElement === row) {
      row.insertBefore(parts, body);
    }

    const meta = row.querySelector(".oc-message-meta");
    if (meta && meta.parentElement === row) {
      row.insertBefore(meta, body);
    }

    row.appendChild(body);
  }

  normalizeBlockStatus(status) {
    const value = String(status || "").trim().toLowerCase();
    if (["completed", "running", "pending", "error"].includes(value)) return value;
    return "pending";
  }

  blockTypeLabel(type) {
    const value = String(type || "").trim();
    const map = {
      tool: "工具调用",
      subtask: "子任务",
      agent: "子代理",
      file: "文件",
      patch: "补丁",
      retry: "重试",
      compaction: "压缩",
      snapshot: "快照",
    };
    return map[value] || value || "输出";
  }

  blockStatusLabel(status) {
    const value = this.normalizeBlockStatus(status);
    if (value === "completed") return "已完成";
    if (value === "running") return "进行中";
    if (value === "error") return "失败";
    return "等待中";
  }

  toolDisplayName(block) {
    if (!block || typeof block !== "object") return "";
    if (typeof block.tool === "string" && block.tool.trim()) return block.tool.trim();
    const summary = typeof block.summary === "string" ? block.summary.trim() : "";
    const summaryMatch = summary.match(/^工具:\s*(.+)$/);
    if (summaryMatch && summaryMatch[1]) return summaryMatch[1].trim();
    const title = typeof block.title === "string" ? block.title.trim() : "";
    return title;
  }

  visibleAssistantBlocks(rawBlocks) {
    const blocks = Array.isArray(rawBlocks) ? rawBlocks : [];
    return blocks.filter((block) => {
      if (!block || typeof block !== "object") return false;
      const type = String(block.type || "").trim().toLowerCase();
      if (!type) return false;
      if (type === "step-start" || type === "step-finish") return false;
      return true;
    });
  }

  runtimeStatusFromBlocks(rawBlocks) {
    const blocks = this.visibleAssistantBlocks(rawBlocks);
    const tools = blocks.filter((block) => block && String(block.type || "").trim().toLowerCase() === "tool");
    if (!tools.length) return null;

    const names = [...new Set(tools.map((block) => this.toolDisplayName(block)).filter(Boolean))];
    const shortNames = names.slice(0, 3).join(", ");
    const suffix = names.length > 3 ? "…" : "";
    const statusText = shortNames || "工具";
    const running = tools.some((block) => {
      const status = this.normalizeBlockStatus(block && block.status);
      return status === "running" || status === "pending";
    });
    if (running) {
      return { tone: "working", text: `正在调用：${statusText}${suffix}` };
    }

    const failed = tools.some((block) => this.normalizeBlockStatus(block && block.status) === "error");
    if (failed) {
      return { tone: "error", text: `工具执行失败：${statusText}${suffix}` };
    }

    return { tone: "working", text: `工具调用完成，正在整理回复…` };
  }

  findMessageRow(messageId) {
    if (!this.elements.messages || !messageId) return null;
    const rows = this.elements.messages.querySelectorAll(".oc-message");
    for (const row of rows) {
      if (row && row.dataset && row.dataset.messageId === messageId) return row;
    }
    return null;
  }

  parseMaybeJsonObject(raw) {
    if (typeof raw !== "string") return null;
    const text = raw.trim();
    if (!text || (!text.startsWith("{") && !text.startsWith("["))) return null;
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  splitQuestionOptionString(raw) {
    const text = String(raw || "").trim();
    if (!text) return [];
    const byLines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (byLines.length > 1) return byLines;
    if (text.includes(" / ")) {
      return text
        .split(" / ")
        .map((part) => part.trim())
        .filter(Boolean);
    }
    if (text.includes("、")) {
      return text
        .split("、")
        .map((part) => part.trim())
        .filter(Boolean);
    }
    return [text];
  }

  normalizeQuestionOption(raw) {
    if (raw && typeof raw === "object") {
      const obj = raw;
      const label =
        (typeof obj.label === "string" && obj.label.trim()) ||
        (typeof obj.value === "string" && obj.value.trim()) ||
        (typeof obj.text === "string" && obj.text.trim()) ||
        (typeof obj.name === "string" && obj.name.trim()) ||
        "";
      const description =
        (typeof obj.description === "string" && obj.description.trim()) ||
        (typeof obj.desc === "string" && obj.desc.trim()) ||
        (typeof obj.hint === "string" && obj.hint.trim()) ||
        "";
      if (!label) return null;
      return { label, description };
    }
    const label = String(raw || "").trim();
    if (!label) return null;
    return { label, description: "" };
  }

  parseQuestionOptions(rawOptions) {
    const collected = [];
    const pushOption = (value) => {
      const normalized = this.normalizeQuestionOption(value);
      if (normalized) collected.push(normalized);
    };

    if (Array.isArray(rawOptions)) {
      rawOptions.forEach((value) => pushOption(value));
    } else if (rawOptions && typeof rawOptions === "object") {
      const obj = rawOptions;
      if (Array.isArray(obj.options)) {
        obj.options.forEach((value) => pushOption(value));
      } else if (Array.isArray(obj.choices)) {
        obj.choices.forEach((value) => pushOption(value));
      } else if (Array.isArray(obj.items)) {
        obj.items.forEach((value) => pushOption(value));
      } else {
        Object.entries(obj).forEach(([key, value]) => {
          if (typeof value === "string" && value.trim()) {
            pushOption({ label: key, description: value.trim() });
            return;
          }
          if (value === true || value === false || typeof value === "number") {
            pushOption({ label: key, description: String(value) });
            return;
          }
          pushOption(value);
        });
      }
    } else if (typeof rawOptions === "string") {
      this.splitQuestionOptionString(rawOptions).forEach((value) => pushOption(value));
    }

    const deduped = [];
    const seen = new Set();
    for (const option of collected) {
      const label = String(option.label || "").trim();
      if (!label || seen.has(label)) continue;
      seen.add(label);
      deduped.push({
        label,
        description: String(option.description || "").trim(),
      });
    }
    return deduped;
  }

  normalizeQuestionItem(rawItem, index) {
    const obj = rawItem && typeof rawItem === "object"
      ? rawItem
      : { question: String(rawItem || "") };

    const question =
      (typeof obj.question === "string" && obj.question.trim()) ||
      (typeof obj.prompt === "string" && obj.prompt.trim()) ||
      (typeof obj.ask === "string" && obj.ask.trim()) ||
      (typeof obj.query === "string" && obj.query.trim()) ||
      (typeof obj.content === "string" && obj.content.trim()) ||
      (typeof obj.text === "string" && obj.text.trim()) ||
      (typeof obj.title === "string" && obj.title.trim()) ||
      (typeof obj.name === "string" && obj.name.trim()) ||
      "";
    if (!question) return null;

    const options = this.parseQuestionOptions(
      obj.options !== undefined
        ? obj.options
        : obj.choices !== undefined
          ? obj.choices
          : obj.items !== undefined
            ? obj.items
            : obj.answers !== undefined
              ? obj.answers
              : obj.selections !== undefined
                ? obj.selections
                : obj.values !== undefined
                  ? obj.values
                  : obj.select_options !== undefined
                    ? obj.select_options
                    : obj.selectOptions !== undefined
                      ? obj.selectOptions
                      : obj.candidates,
    );

    return {
      question,
      header: (typeof obj.header === "string" && obj.header.trim()) || `Q${index + 1}`,
      options,
      multiSelect: Boolean(obj.multiSelect || obj.multiple || obj.allowMultiple),
    };
  }

  normalizeQuestionInput(rawInput) {
    const parsedFromString = this.parseMaybeJsonObject(rawInput);
    const input = parsedFromString || rawInput;

    let rawQuestions = [];
    if (Array.isArray(input)) {
      rawQuestions = input;
    } else if (input && typeof input === "object") {
      if (Array.isArray(input.questions)) {
        rawQuestions = input.questions;
      } else if (typeof input.questions === "string") {
        const parsedQuestions = this.parseMaybeJsonObject(input.questions);
        if (Array.isArray(parsedQuestions)) rawQuestions = parsedQuestions;
      } else if (input.questions && typeof input.questions === "object") {
        rawQuestions = Object.values(input.questions);
      } else if (typeof input.question === "string" || typeof input.prompt === "string" || typeof input.text === "string") {
        rawQuestions = [input];
      }
    }

    const normalized = [];
    const seenQuestion = new Set();
    for (let i = 0; i < rawQuestions.length; i += 1) {
      const item = this.normalizeQuestionItem(rawQuestions[i], i);
      if (!item) continue;
      const qKey = String(item.question || "").trim();
      if (!qKey || seenQuestion.has(qKey)) continue;
      seenQuestion.add(qKey);
      normalized.push(item);
    }
    return normalized;
  }

  parseQuestionsFromDetailText(detailText) {
    const text = String(detailText || "").trim();
    if (!text) return [];
    const lines = text.split(/\r?\n/);
    const questions = [];
    let current = null;

    const pushCurrent = () => {
      if (!current || !String(current.question || "").trim()) return;
      current.options = this.parseQuestionOptions(current.options);
      questions.push(current);
      current = null;
    };

    for (const rawLine of lines) {
      const line = String(rawLine || "").trim();
      if (!line) continue;
      if (line.startsWith("问题:")) {
        pushCurrent();
        current = {
          question: line.replace(/^问题:\s*/, "").trim(),
          header: `Q${questions.length + 1}`,
          options: [],
          multiSelect: false,
        };
        continue;
      }
      if (line.startsWith("选项:")) {
        if (!current) continue;
        const optionText = line.replace(/^选项:\s*/, "").trim();
        current.options = this.splitQuestionOptionString(optionText);
      }
    }
    pushCurrent();

    return questions.filter((item) => item && String(item.question || "").trim());
  }

  extractQuestionItemsFromBlock(block) {
    if (!block || typeof block !== "object") return [];
    const sources = [];
    if (block.toolInput !== undefined) sources.push(block.toolInput);
    if (block.raw && block.raw.state && block.raw.state.input !== undefined) sources.push(block.raw.state.input);
    if (block.raw && block.raw.input !== undefined) sources.push(block.raw.input);

    for (const source of sources) {
      const normalized = this.normalizeQuestionInput(source);
      if (normalized.length) return normalized;
    }
    if (typeof block.detail === "string" && block.detail.trim()) {
      const fromDetail = this.parseQuestionsFromDetailText(block.detail);
      if (fromDetail.length) return fromDetail;
    }
    return [];
  }

  questionTextSignature(questions) {
    const list = Array.isArray(questions) ? questions : [];
    return list
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        return String(item.question || "").trim().toLowerCase();
      })
      .filter(Boolean)
      .join("||");
  }

  questionRequestMapKey(sessionId, requestId) {
    const sid = String(sessionId || "").trim();
    const rid = String(requestId || "").trim();
    if (!sid || !rid) return "";
    return `${sid}::${rid}`;
  }

  getQuestionRequestInteractionKey(sessionId, requestId) {
    const sid = String(sessionId || "").trim();
    const rid = String(requestId || "").trim();
    if (!sid || !rid) return "";
    return `${sid}::question-request::${rid}`;
  }

  normalizeQuestionRequest(raw) {
    if (!raw || typeof raw !== "object") return null;
    const obj = raw;
    const requestId =
      (typeof obj.id === "string" && obj.id.trim()) ||
      (typeof obj.requestID === "string" && obj.requestID.trim()) ||
      "";
    const sessionId =
      (typeof obj.sessionID === "string" && obj.sessionID.trim()) ||
      (typeof obj.sessionId === "string" && obj.sessionId.trim()) ||
      "";
    if (!requestId || !sessionId) return null;

    const questions = this.normalizeQuestionInput(obj.questions !== undefined ? obj.questions : obj.input);
    const tool = obj.tool && typeof obj.tool === "object" ? obj.tool : {};
    return {
      id: requestId,
      sessionId,
      questions,
      questionSignature: this.questionTextSignature(questions),
      tool: {
        messageID: typeof tool.messageID === "string" ? tool.messageID : "",
        callID: typeof tool.callID === "string" ? tool.callID : "",
      },
      updatedAt: Date.now(),
    };
  }

  upsertPendingQuestionRequest(raw) {
    const normalized = this.normalizeQuestionRequest(raw);
    if (!normalized) return null;
    const key = this.questionRequestMapKey(normalized.sessionId, normalized.id);
    if (!key) return null;

    const previous = this.pendingQuestionRequests.get(key);
    this.pendingQuestionRequests.set(
      key,
      previous
        ? {
          ...previous,
          ...normalized,
          updatedAt: Date.now(),
        }
        : normalized,
    );
    return this.pendingQuestionRequests.get(key) || null;
  }

  removePendingQuestionRequest(sessionId, requestId) {
    const key = this.questionRequestMapKey(sessionId, requestId);
    if (!key) return;
    this.pendingQuestionRequests.delete(key);
  }

  findPendingQuestionRequest(interaction) {
    const sessionId = String((interaction && interaction.sessionId) || "").trim();
    if (!sessionId || !(this.pendingQuestionRequests instanceof Map) || !this.pendingQuestionRequests.size) {
      return null;
    }

    const pending = [];
    for (const request of this.pendingQuestionRequests.values()) {
      if (!request || request.sessionId !== sessionId) continue;
      pending.push(request);
    }
    if (!pending.length) return null;

    const interactionMessageId = String(
      (interaction && interaction.message && (interaction.message.id || interaction.message.messageID || interaction.message.messageId)) || "",
    ).trim();
    const interactionCallId = String(
      (interaction && interaction.block && (interaction.block.id || (interaction.block.raw && interaction.block.raw.id))) || "",
    ).trim();
    const interactionSig = this.questionTextSignature(interaction && interaction.questions ? interaction.questions : []);

    pending.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));

    const byToolStrict = pending.find((request) => {
      const tool = request.tool || {};
      if (!tool.callID || !interactionCallId) return false;
      if (tool.callID !== interactionCallId) return false;
      if (tool.messageID && interactionMessageId && tool.messageID !== interactionMessageId) return false;
      return true;
    });
    if (byToolStrict) return byToolStrict;

    const byToolMessage = pending.find((request) => {
      const tool = request.tool || {};
      return Boolean(tool.messageID && interactionMessageId && tool.messageID === interactionMessageId);
    });
    if (byToolMessage) return byToolMessage;

    const bySignature = pending.find((request) => request.questionSignature && request.questionSignature === interactionSig);
    if (bySignature) return bySignature;

    return pending[0] || null;
  }

  getQuestionInteractionKey(message, block, messageIndex = -1, blockIndex = -1) {
    const sessionId = String((this.plugin.sessionStore.state().activeSessionId || "")).trim() || "active-session";
    const messageId = String(
      (message && (message.id || message.messageId || message.messageID || message.createdAt)) ||
      (messageIndex >= 0 ? `m${messageIndex}` : ""),
    ).trim();
    const blockId = String(
      (block && (block.id || (block.raw && block.raw.id) || (block.raw && block.raw.partID))) ||
      (blockIndex >= 0 ? `b${blockIndex}` : `question:${String((block && block.tool) || "question")}`),
    ).trim();
    if (!messageId || !blockId) return "";
    return `${sessionId}::${messageId}::${blockId}`;
  }

  getQuestionAnswerState(key, totalQuestions) {
    const total = Math.max(1, Number(totalQuestions) || 1);
    if (!key) return { total, answers: {}, submitted: false, sending: false };
    const existing = this.questionAnswerStates.get(key);
    if (existing && Number(existing.total) === total) {
      return existing;
    }
    const next = { total, answers: {}, submitted: false, sending: false };
    this.questionAnswerStates.set(key, next);
    return next;
  }

  buildQuestionAnswerPayload(questions, state) {
    const list = Array.isArray(questions) ? questions : [];
    const answers = state && state.answers ? state.answers : {};
    const lines = [];
    for (let index = 0; index < list.length; index += 1) {
      const question = list[index] && typeof list[index] === "object" ? list[index] : {};
      const answer = answers[index];
      if (!answer || typeof answer.value !== "string" || !answer.value.trim()) continue;
      const qid =
        (typeof question.id === "string" && question.id.trim()) ||
        `question_${index + 1}`;
      const custom = typeof answer.custom === "string" ? answer.custom.trim() : "";
      const content = custom ? `${answer.value.trim()} | ${custom}` : answer.value.trim();
      lines.push(`${qid}: ${content}`);
    }
    return lines.join("\n");
  }

  tokenizeQuestionAnswer(rawAnswer) {
    const text = String(rawAnswer || "").trim();
    if (!text) return [];
    return text
      .split(/\s*,\s*/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  buildQuestionAnswerArrays(questions, result, state) {
    const list = Array.isArray(questions) ? questions : [];
    const resultMap = result && typeof result === "object" ? result : {};
    const stateAnswers = state && state.answers && typeof state.answers === "object" ? state.answers : {};

    return list.map((question, index) => {
      const q = question && typeof question === "object" ? question : {};
      const qText = String(q.question || "").trim();
      const optionLabels = new Set(
        (Array.isArray(q.options) ? q.options : [])
          .map((opt) => {
            if (opt && typeof opt === "object") return String(opt.label || "").trim();
            return String(opt || "").trim();
          })
          .filter(Boolean),
      );

      const answerText = qText && typeof resultMap[qText] === "string"
        ? String(resultMap[qText] || "")
        : "";
      const tokens = this.tokenizeQuestionAnswer(answerText);
      const selected = [];
      const extras = [];

      for (const token of tokens) {
        if (optionLabels.has(token)) selected.push(token);
        else extras.push(token);
      }

      if (!tokens.length) {
        const stateAnswer = stateAnswers[index];
        if (stateAnswer && typeof stateAnswer === "object") {
          const base = typeof stateAnswer.value === "string" ? stateAnswer.value.trim() : "";
          const custom = typeof stateAnswer.custom === "string" ? stateAnswer.custom.trim() : "";
          if (base) selected.push(base);
          if (custom) extras.push(custom);
        }
      }

      const merged = [...selected, ...extras]
        .map((item) => String(item || "").trim())
        .filter(Boolean);
      if (!merged.length && answerText.trim()) return [answerText.trim()];
      return merged;
    });
  }

  pruneQuestionAnswerStates(messages) {
    if (!(this.questionAnswerStates instanceof Map) || !this.questionAnswerStates.size) return;
    const activeMessages = Array.isArray(messages) ? messages : [];
    const activeSessionId = String((this.plugin.sessionStore.state().activeSessionId || "")).trim();
    const keepKeys = new Set();
    for (let mi = 0; mi < activeMessages.length; mi += 1) {
      const message = activeMessages[mi];
      if (!message || message.role !== "assistant") continue;
      const blocks = this.visibleAssistantBlocks(message.blocks);
      for (let bi = 0; bi < blocks.length; bi += 1) {
        const block = blocks[bi];
        if (!block || block.type !== "tool" || block.tool !== "question") continue;
        const questions = this.extractQuestionItemsFromBlock(block);
        if (!questions.length) continue;
        const key = this.getQuestionInteractionKey(message, block, mi, bi);
        if (key) keepKeys.add(key);
      }
    }
    if (activeSessionId && this.pendingQuestionRequests instanceof Map) {
      for (const request of this.pendingQuestionRequests.values()) {
        if (!request || request.sessionId !== activeSessionId) continue;
        const questions = Array.isArray(request.questions) ? request.questions : [];
        if (!questions.length) continue;
        const requestKey = this.getQuestionRequestInteractionKey(activeSessionId, request.id);
        if (requestKey) keepKeys.add(requestKey);
      }
    }
    for (const key of this.questionAnswerStates.keys()) {
      if (!keepKeys.has(key)) this.questionAnswerStates.delete(key);
    }
    if (this.questionSubmitAt instanceof Map) {
      for (const key of this.questionSubmitAt.keys()) {
        if (!keepKeys.has(key)) this.questionSubmitAt.delete(key);
      }
    }
  }

  async submitQuestionAnswers(interactionKey, questions, state, directPayload = "", options = {}) {
    if (!state || state.submitted || state.sending) return;
    if (interactionKey) {
      const now = Date.now();
      const lastAt = Number(this.questionSubmitAt.get(interactionKey) || 0);
      if (now - lastAt < 1200) return;
      this.questionSubmitAt.set(interactionKey, now);
    }
    const payload = String(directPayload || "").trim() || this.buildQuestionAnswerPayload(questions, state);
    if (!payload.trim()) return;

    state.sending = true;
    state.submitted = true;
    this.renderMessages();

    try {
      const sessionId = typeof options.sessionId === "string" ? options.sessionId.trim() : "";
      let requestId = typeof options.requestId === "string" ? options.requestId.trim() : "";
      const providedAnswers = Array.isArray(options.questionAnswers) ? options.questionAnswers : null;

      if (!requestId) {
        const pending = this.findPendingQuestionRequest({
          key: interactionKey,
          sessionId,
          questions,
          message: options.message || null,
          block: options.block || null,
        });
        if (pending && pending.id) requestId = pending.id;
      }

      if (!requestId) {
        const listed = await this.plugin.opencodeClient.listQuestions({ signal: this.currentAbort ? this.currentAbort.signal : undefined });
        if (Array.isArray(listed)) {
          for (const req of listed) this.upsertPendingQuestionRequest(req);
        }
        const refreshed = this.findPendingQuestionRequest({
          key: interactionKey,
          sessionId,
          questions,
          message: options.message || null,
          block: options.block || null,
        });
        if (refreshed && refreshed.id) requestId = refreshed.id;
      }

      if (!requestId) {
        throw new Error("未找到可回复的 question 请求 ID");
      }

      const answers = providedAnswers && providedAnswers.length
        ? providedAnswers
        : this.buildQuestionAnswerArrays(questions, null, state);
      await this.plugin.opencodeClient.replyQuestion({
        requestId,
        sessionId,
        answers,
        signal: this.currentAbort ? this.currentAbort.signal : undefined,
      });
      this.removePendingQuestionRequest(sessionId, requestId);
      this.setRuntimeStatus("已提交问题回答，等待模型继续执行…", "info");
    } catch (e) {
      state.submitted = false;
      const msg = e instanceof Error ? e.message : String(e);
      this.setRuntimeStatus(`提交回答失败：${msg}`, "error");
    } finally {
      state.sending = false;
      if (interactionKey) this.questionAnswerStates.set(interactionKey, state);
      this.renderMessages();
    }
  }

  clearInlineQuestionWidget(silent = true) {
    if (this.inlineQuestionWidget && typeof this.inlineQuestionWidget.destroy === "function") {
      this.inlineQuestionWidget.destroy(silent);
    }
    this.inlineQuestionWidget = null;
    this.inlineQuestionKey = "";
    if (this.elements.inlineQuestionHost) {
      this.elements.inlineQuestionHost.empty();
    }
    if (this.elements.composer) {
      this.elements.composer.removeClass("is-inline-hidden");
    }
  }

  formatInlineQuestionPayload(questions, result) {
    const list = Array.isArray(questions) ? questions : [];
    const answerMap = result && typeof result === "object" ? result : {};
    const lines = [];
    for (const question of list) {
      if (!question || typeof question !== "object") continue;
      const qText = typeof question.question === "string" ? question.question.trim() : "";
      if (!qText) continue;
      const answer = typeof answerMap[qText] === "string" ? answerMap[qText].trim() : "";
      if (!answer) continue;
      if (list.length === 1) lines.push(answer);
      else lines.push(`${qText}: ${answer}`);
    }

    if (!lines.length) {
      for (const raw of Object.values(answerMap)) {
        const answer = typeof raw === "string" ? raw.trim() : "";
        if (answer) lines.push(answer);
      }
    }
    return lines.join("\n");
  }

  async submitInlineQuestionResult(interaction, result) {
    if (!interaction || !interaction.key) return;
    const state = interaction.state || this.getQuestionAnswerState(interaction.key, interaction.questions.length);
    if (state.submitted || state.sending) return;

    const payload = this.formatInlineQuestionPayload(interaction.questions, result);
    if (!String(payload || "").trim()) return;
    const questionAnswers = this.buildQuestionAnswerArrays(interaction.questions, result, state);

    await this.submitQuestionAnswers(interaction.key, interaction.questions, state, payload, {
      sessionId: interaction.sessionId,
      requestId: interaction.requestId || "",
      questionAnswers,
      message: interaction.message || null,
      block: interaction.block || null,
    });
  }

  findActiveQuestionInteraction(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const activeSessionId = String((this.plugin.sessionStore.state().activeSessionId || "")).trim();
    const unresolved = [];
    for (let mi = list.length - 1; mi >= 0; mi -= 1) {
      const message = list[mi];
      if (!message || message.role !== "assistant") continue;
      const blocks = this.visibleAssistantBlocks(message.blocks);
      for (let bi = blocks.length - 1; bi >= 0; bi -= 1) {
        const block = blocks[bi];
        if (!block || block.type !== "tool" || block.tool !== "question") continue;
        const questions = this.extractQuestionItemsFromBlock(block);
        if (!questions.length) {
          unresolved.push({
            reason: "empty-questions",
            messageId: String((message && message.id) || ""),
            blockId: String((block && block.id) || ""),
            toolInputKeys: block && block.toolInput && typeof block.toolInput === "object"
              ? Object.keys(block.toolInput)
              : [],
          });
          continue;
        }
        const key = this.getQuestionInteractionKey(message, block, mi, bi);
        if (!key) {
          unresolved.push({
            reason: "missing-key",
            messageId: String((message && message.id) || ""),
            blockId: String((block && block.id) || ""),
            questionCount: questions.length,
          });
          continue;
        }
        const state = this.getQuestionAnswerState(key, questions.length);
        if (state.submitted) {
          unresolved.push({
            reason: "already-submitted",
            key,
            questionCount: questions.length,
          });
          continue;
        }
        const pendingRequest = this.findPendingQuestionRequest({
          key,
          sessionId: activeSessionId,
          message,
          block,
          questions,
        });
        return {
          key,
          sessionId: activeSessionId,
          message,
          block,
          questions,
          state,
          requestId: pendingRequest && pendingRequest.id ? pendingRequest.id : "",
        };
      }
    }

    if (activeSessionId && this.pendingQuestionRequests instanceof Map) {
      const pending = [];
      for (const request of this.pendingQuestionRequests.values()) {
        if (!request || request.sessionId !== activeSessionId) continue;
        if (!Array.isArray(request.questions) || !request.questions.length) continue;
        pending.push(request);
      }
      if (pending.length) {
        pending.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
        for (const request of pending) {
          const key = this.getQuestionRequestInteractionKey(activeSessionId, request.id);
          if (!key) continue;
          const state = this.getQuestionAnswerState(key, request.questions.length);
          if (state.submitted) continue;
          return {
            key,
            sessionId: activeSessionId,
            message: null,
            block: null,
            questions: request.questions,
            state,
            requestId: request.id,
          };
        }
      }
    }

    const now = Date.now();
    if (unresolved.length && now - Number(this.lastQuestionResolveLogAt || 0) > 1200) {
      this.lastQuestionResolveLogAt = now;
      console.log("[opencode-assistant] question interaction unresolved", unresolved.slice(0, 5));
    }
    return null;
  }

  renderInlineQuestionPanel(messages) {
    if (!this.elements.inlineQuestionHost || !this.elements.composer) return;
    if (this.inlineQuestionWidget && this.inlineQuestionWidget.rootEl && !this.inlineQuestionWidget.rootEl.isConnected) {
      this.inlineQuestionWidget = null;
      this.inlineQuestionKey = "";
    }
    const interaction = this.findActiveQuestionInteraction(messages);
    if (!interaction) {
      this.clearInlineQuestionWidget(true);
      return;
    }

    this.elements.composer.addClass("is-inline-hidden");
    if (this.inlineQuestionWidget && this.inlineQuestionKey === interaction.key) {
      return;
    }

    this.clearInlineQuestionWidget(true);
    this.inlineQuestionKey = interaction.key;
    console.log("[opencode-assistant] inline question panel", {
      key: interaction.key,
      count: Array.isArray(interaction.questions) ? interaction.questions.length : 0,
    });
    this.inlineQuestionWidget = new InlineAskUserQuestionPanel(
      this.elements.inlineQuestionHost,
      { questions: interaction.questions },
      (result) => {
        if (!result) {
          this.clearInlineQuestionWidget(true);
          this.setRuntimeStatus("已取消提问回答", "info");
          return;
        }
        void this.submitInlineQuestionResult(interaction, result);
      },
      this.currentAbort ? this.currentAbort.signal : undefined,
      {
        title: "OpenCode has a question",
        showCustomInput: true,
        immediateSelect: interaction.questions.length === 1 && Array.isArray(interaction.questions[0].options) && interaction.questions[0].options.length > 0,
      },
    );
    this.inlineQuestionWidget.render();
  }

  prefillComposerInput(text, options = {}) {
    const inputEl = this.elements.input;
    if (!inputEl) return;
    const content = String(text || "").trim();
    if (!content) return;
    const current = String(inputEl.value || "");
    inputEl.value = current && !current.endsWith("\n") ? `${current}\n${content}` : `${current}${content}`;
    inputEl.focus();
    if (options.sendNow) {
      void this.handleSend();
    }
  }

  hasVisibleQuestionToolCard() {
    const messages = this.plugin.sessionStore.getActiveMessages();
    return Boolean(this.findActiveQuestionInteraction(messages));
  }

  renderAssistantBlocks(row, message) {
    const blocks = this.visibleAssistantBlocks(message.blocks);
    const container = this.ensureBlocksContainer(row);
    container.empty();
    if (!blocks.length) {
      container.toggleClass("is-empty", true);
      return;
    }
    container.toggleClass("is-empty", false);

    blocks.forEach((block) => {
      const card = container.createDiv({ cls: "oc-part-card" });
      const status = this.normalizeBlockStatus(block && block.status);
      card.addClass(`is-${status}`);
      card.setAttr("data-part-type", String((block && block.type) || ""));

      const head = card.createDiv({ cls: "oc-part-head" });
      head.createDiv({
        cls: "oc-part-type",
        text: this.blockTypeLabel(block && block.type),
      });
      head.createDiv({
        cls: "oc-part-status",
        text: this.blockStatusLabel(status),
      });

      const title = typeof block.title === "string" ? block.title.trim() : "";
      if (title) {
        card.createDiv({ cls: "oc-part-title", text: title });
      }

      const summary = typeof block.summary === "string" ? block.summary.trim() : "";
      if (summary) {
        card.createDiv({ cls: "oc-part-summary", text: summary });
      }
      const preview = typeof block.preview === "string" ? block.preview.trim() : "";
      if (preview) {
        card.createDiv({ cls: "oc-part-preview", text: preview });
      }

      if (block && block.type === "tool" && block.tool === "question" && this.extractQuestionItemsFromBlock(block).length) {
        card.createDiv({
          cls: "oc-question-inline-note",
          text: "请在下方面板中回答。",
        });
      }

      const detail = typeof block.detail === "string" ? block.detail.trim() : "";
      if (detail) {
        const details = card.createEl("details", { cls: "oc-part-details" });
        details.createEl("summary", { text: "查看详情" });
        details.createEl("pre", { cls: "oc-part-detail", text: detail });
      }
    });
  }

  showPermissionRequestModal(permission) {
    return new Promise((resolve) => {
      const modal = new PermissionRequestModal(this.app, permission, (answer) => resolve(answer || null));
      modal.open();
    });
  }

  showPromptAppendModal(appendText) {
    const modal = new PromptAppendModal(this.app, appendText, (value) => {
      this.prefillComposerInput(value);
    });
    modal.open();
  }

  handleToastEvent(toast) {
    const title = typeof toast.title === "string" ? toast.title.trim() : "";
    const message = typeof toast.message === "string" ? toast.message.trim() : "";
    const text = [title, message].filter(Boolean).join("：") || "OpenCode 提示";
    new Notice(text, 4000);
  }

  renderAssistantMeta(row, message) {
    const metaText = typeof message.meta === "string" ? message.meta.trim() : "";
    if (!metaText) return;
    const pre = row.createEl("pre", { cls: "oc-message-meta", text: metaText });
    if (/error|failed|失败|status=\d{3}/i.test(metaText)) {
      pre.addClass("is-error");
    }
  }

  renderMessageItem(parent, message) {
    const row = parent.createDiv({ cls: ["oc-message", `oc-message-${message.role}`] });
    row.dataset.messageId = message.id || "";
    if (message.pending) row.addClass("is-pending");

    const head = row.createDiv({ cls: "oc-msg-head" });
    head.createDiv({ cls: "oc-msg-role", text: message.role.toUpperCase() });
    if (message.error) head.createDiv({ cls: "oc-msg-error", text: message.error });

    const body = row.createDiv({ cls: "oc-message-content" });

    if (message.pending) {
      body.setText(message.text || "...");
      if (message.role === "assistant" && message.reasoning) {
        const reasoningBody = this.ensureReasoningContainer(row, true);
        if (reasoningBody) reasoningBody.textContent = message.reasoning;
      }
      if (message.role === "assistant") {
        this.renderAssistantBlocks(row, message);
        this.renderAssistantMeta(row, message);
        this.reorderAssistantMessageLayout(row);
      }
      return;
    }

    const textForRender = normalizeMarkdownForDisplay(message.text || "");
    const hasReasoning = Boolean(message.reasoning && String(message.reasoning).trim());
    const hasBlocks = this.visibleAssistantBlocks(message.blocks).length > 0;
    const fallbackText = hasReasoning || hasBlocks ? "(结构化输出已返回，可展开下方详情查看。)" : "";
    MarkdownRenderer.render(this.app, textForRender || fallbackText, body, "", this.plugin).then(() => {
      this.attachCodeCopyButtons(body);
    });

    if (message.role === "assistant" && hasReasoning) {
      const reasoningBody = this.ensureReasoningContainer(row, !textForRender);
      if (reasoningBody) {
        const reasoningText = normalizeMarkdownForDisplay(message.reasoning || "");
        MarkdownRenderer.render(this.app, reasoningText, reasoningBody, "", this.plugin).then(() => {
          this.attachCodeCopyButtons(reasoningBody);
        });
      }
    }
    if (message.role === "assistant") {
      this.renderAssistantBlocks(row, message);
      this.renderAssistantMeta(row, message);
      this.reorderAssistantMessageLayout(row);
    }

    if (message.role === "user") {
      this.renderUserActions(row, message);
    }
  }

  isAbortLikeError(message) {
    const text = String(message || "").toLowerCase();
    return /abort|aborted|cancelled|canceled|用户取消/.test(text);
  }

  async handleSend() {
    const input = this.elements.input;
    if (!input) return;
    const text = String(input.value || "").trim();
    if (!text) return;
    input.value = "";
    await this.sendPrompt(text);
  }

  async sendPrompt(userText, options = {}) {
    const requestOptions = options && typeof options === "object" ? options : {};
    const forceSessionId = typeof requestOptions.sessionId === "string" ? requestOptions.sessionId.trim() : "";
    const hideUserMessage = Boolean(requestOptions.hideUserMessage);

    const modelSlash = this.parseModelSlashCommand(userText);
    if (modelSlash) {
      await this.handleModelSlashCommand(userText, modelSlash);
      return;
    }

    const skillSelectorSlash = this.parseSkillSelectorSlashCommand(userText);
    if (skillSelectorSlash) {
      this.openSkillSelector();
      return;
    }

    const skillMatch = this.resolveSkillFromPrompt(userText);

    const st = this.plugin.sessionStore.state();
    let sessionId = forceSessionId || st.activeSessionId;
    if (forceSessionId && st.activeSessionId !== forceSessionId) {
      this.plugin.sessionStore.setActiveSession(forceSessionId);
      this.render();
    }

    if (!sessionId) {
      const session = await this.plugin.createSession("新会话");
      sessionId = session.id;
      this.plugin.sessionStore.setActiveSession(sessionId);
      this.render();
    }

    const userMessage = { id: uid("msg"), role: "user", text: userText, createdAt: Date.now() };
    const draftId = uid("msg");
    const draft = {
      id: draftId,
      role: "assistant",
      text: "",
      reasoning: "",
      meta: "",
      blocks: [],
      createdAt: Date.now(),
      pending: true,
      error: "",
    };
    if (!hideUserMessage) {
      this.plugin.sessionStore.appendMessage(sessionId, userMessage);
    }
    this.plugin.sessionStore.appendMessage(sessionId, draft);
    this.renderMessages();
    this.renderSidebar(this.root.querySelector(".oc-side"));

    this.currentAbort = new AbortController();
    this.setBusy(true);
    this.setRuntimeStatus("正在等待 OpenCode 响应…", "working");

    try {
      const prompt = this.plugin.skillService.buildInjectedPrompt(
        skillMatch.skill,
        this.plugin.settings.skillInjectMode,
        skillMatch.promptText || userText,
      );

      const response = await this.plugin.opencodeClient.sendMessage({
        sessionId,
        prompt,
        signal: this.currentAbort.signal,
        onToken: (partial) => {
          this.plugin.sessionStore.updateAssistantDraft(sessionId, draftId, partial);
          if (String(partial || "").trim()) {
            this.setRuntimeStatus("正在生成回复…", "working");
          }
          const messages = this.elements.messages;
          if (!messages) return;
          const target = this.findMessageRow(draftId);
          if (target) {
            const body = target.querySelector(".oc-message-content");
            if (body) body.textContent = partial;
          }
          messages.scrollTop = messages.scrollHeight;
        },
        onReasoning: (partialReasoning) => {
          this.plugin.sessionStore.updateAssistantDraft(sessionId, draftId, undefined, partialReasoning);
          if (String(partialReasoning || "").trim()) {
            this.setRuntimeStatus("模型思考中…", "working");
          }
          const messages = this.elements.messages;
          if (!messages) return;
          const target = this.findMessageRow(draftId);
          if (target) {
            const reasoningBody = this.ensureReasoningContainer(target, true);
            if (reasoningBody) reasoningBody.textContent = partialReasoning || "...";
          }
          messages.scrollTop = messages.scrollHeight;
        },
        onBlocks: (blocks) => {
          this.plugin.sessionStore.updateAssistantDraft(sessionId, draftId, undefined, undefined, undefined, blocks);
          const runtimeStatus = this.runtimeStatusFromBlocks(blocks);
          if (runtimeStatus && runtimeStatus.text) {
            this.setRuntimeStatus(runtimeStatus.text, runtimeStatus.tone);
          }
          const messages = this.elements.messages;
          if (!messages) return;
          const target = this.findMessageRow(draftId);
          if (target) {
            const currentDraft = this.plugin
              .sessionStore
              .getActiveMessages()
              .find((msg) => msg && msg.id === draftId);
            if (currentDraft) {
              this.renderAssistantBlocks(target, currentDraft);
              this.reorderAssistantMessageLayout(target);
            }
          }
          // Question tool arrives through streaming block updates; keep inline panel in sync in real time.
          this.renderInlineQuestionPanel(this.plugin.sessionStore.getActiveMessages());
          messages.scrollTop = messages.scrollHeight;
        },
        onPermissionRequest: async (permission) => {
          this.setRuntimeStatus("等待权限确认…", "info");
          const decision = await this.showPermissionRequestModal(permission || {});
          if (!decision) return "reject";
          if (decision === "always" || decision === "once" || decision === "reject") {
            return decision;
          }
          return "reject";
        },
        onQuestionRequest: (questionRequest) => {
          const request = this.upsertPendingQuestionRequest(questionRequest || {});
          if (!request) return;
          console.log("[opencode-assistant] question requested", {
            id: request.id,
            sessionId: request.sessionId,
            count: Array.isArray(request.questions) ? request.questions.length : 0,
          });
          this.setRuntimeStatus("请在下方问题面板中回答。", "info");
          this.renderInlineQuestionPanel(this.plugin.sessionStore.getActiveMessages());
        },
        onQuestionResolved: (info) => {
          const sessionIdFromEvent = String((info && info.sessionId) || "").trim();
          const requestIdFromEvent = String((info && info.requestId) || "").trim();
          if (requestIdFromEvent) {
            this.removePendingQuestionRequest(sessionIdFromEvent || sessionId, requestIdFromEvent);
          }
          this.renderInlineQuestionPanel(this.plugin.sessionStore.getActiveMessages());
        },
        onPromptAppend: (appendText) => {
          this.setRuntimeStatus("等待补充输入…", "info");
          if (this.hasVisibleQuestionToolCard()) {
            this.setRuntimeStatus("请在下方问题面板中回答并提交。", "info");
            return;
          }
          this.showPromptAppendModal(appendText);
        },
        onToast: (toast) => {
          this.handleToastEvent(toast || {});
        },
      });

      this.plugin.sessionStore.finalizeAssistantDraft(
        sessionId,
        draftId,
        {
          text: response.text || "",
          reasoning: response.reasoning || "",
          meta: response.meta || "",
          blocks: Array.isArray(response.blocks) ? response.blocks : [],
        },
        /error|failed|失败|status=\d{3}/i.test(String(response.meta || "")) ? String(response.meta || "") : "",
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isSilentAbort = this.silentAbortBudget > 0 && this.isAbortLikeError(msg);
      if (isSilentAbort) {
        this.silentAbortBudget = Math.max(0, Number(this.silentAbortBudget || 0) - 1);
        const existing = (this.plugin.sessionStore.state().messagesBySession[sessionId] || []).find((x) => x && x.id === draftId);
        this.plugin.sessionStore.finalizeAssistantDraft(
          sessionId,
          draftId,
          {
            text: existing && typeof existing.text === "string" ? existing.text : "",
            reasoning: existing && typeof existing.reasoning === "string" ? existing.reasoning : "",
            meta: existing && typeof existing.meta === "string" ? existing.meta : "",
            blocks: existing && Array.isArray(existing.blocks) ? existing.blocks : [],
          },
          "",
        );
        this.setRuntimeStatus("等待问题回答…", "info");
      } else {
        this.setRuntimeStatus(`请求失败：${msg}`, "error");
        this.plugin.sessionStore.finalizeAssistantDraft(sessionId, draftId, `请求失败: ${msg}`, msg);
        new Notice(msg);
      }
    } finally {
      this.currentAbort = null;
      this.setBusy(false);
      await this.plugin.persistState();
      this.renderMessages();
      this.renderSidebar(this.root.querySelector(".oc-side"));
    }
  }

  cancelSending() {
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
      this.setBusy(false);
      new Notice("已取消发送");
    }
  }

  setBusy(isBusy) {
    if (this.elements.sendBtn) this.elements.sendBtn.disabled = isBusy;
    if (this.elements.cancelBtn) this.elements.cancelBtn.disabled = !isBusy;
    if (this.elements.input) this.elements.input.disabled = isBusy;
    if (this.root) {
      this.root.toggleClass("is-busy", isBusy);
    }
    if (!isBusy) {
      this.setRuntimeStatus("", "info");
    }
  }

  setRuntimeStatus(text, tone = "info") {
    if (!this.elements.runtimeStatus) return;
    const statusEl = this.elements.runtimeStatus;
    statusEl.removeClass("is-hidden", "is-info", "is-working", "is-error");
    if (!String(text || "").trim()) {
      statusEl.setText("");
      statusEl.addClass("is-hidden");
      return;
    }
    statusEl.setText(String(text || "").trim());
    if (tone === "error") {
      statusEl.addClass("is-error");
    } else if (tone === "working") {
      statusEl.addClass("is-working");
    } else {
      statusEl.addClass("is-info");
    }
  }
}

class OpenCodeSettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "OpenCode Assistant 设置" });
    containerEl.createEl("p", {
      text: "常用情况下只需要确认鉴权方式和连接状态。其余高级项一般保持默认即可。",
    });

    new Setting(containerEl)
      .setName("OpenCode CLI 路径（可选）")
      .setDesc("通常留空。插件会自动探测；只有诊断提示“找不到 opencode”时再填写绝对路径。")
      .addText((text) => {
        text
          .setPlaceholder("/Users/xxx/.opencode/bin/opencode")
          .setValue(this.plugin.settings.cliPath)
          .onChange(async (v) => {
            this.plugin.settings.cliPath = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("鉴权方式")
      .setDesc("默认使用 OpenCode 本机登录状态。仅在你要改用自有 API Key 时切换为“自定义 API Key”。")
      .addDropdown((d) => {
        d.addOption("opencode-default", "默认（OpenCode 本机登录）")
          .addOption("custom-api-key", "自定义 API Key（高级）")
          .setValue(this.plugin.settings.authMode)
          .onChange(async (v) => {
            this.plugin.settings.authMode = v;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("技能注入方式")
      .setDesc("当你使用 /skill 指令时，插件如何把技能内容传给模型。")
      .addDropdown((d) => {
        d.addOption("summary", "摘要注入（推荐）")
          .addOption("full", "全文注入（更完整但更重）")
          .addOption("off", "关闭注入（只发送用户输入）")
          .setValue(this.plugin.settings.skillInjectMode)
          .onChange(async (v) => {
            this.plugin.settings.skillInjectMode = v;
            await this.plugin.saveSettings();
          });
      });

    if (this.plugin.settings.authMode === "custom-api-key") {
      new Setting(containerEl)
        .setName("Provider ID")
        .setDesc("例如 openai。需与 OpenCode 中 provider 标识一致。")
        .addText((text) => {
          text.setPlaceholder("openai");
          text.setValue(this.plugin.settings.customProviderId).onChange(async (v) => {
            this.plugin.settings.customProviderId = v.trim();
            await this.plugin.saveSettings();
          });
        });

      new Setting(containerEl)
        .setName("API Key")
        .setDesc("仅在本地保存，用于该 Vault 的插件请求。")
        .addText((text) => {
          text.inputEl.type = "password";
          text.setValue(this.plugin.settings.customApiKey).onChange(async (v) => {
            this.plugin.settings.customApiKey = v.trim();
            await this.plugin.saveSettings();
          });
        });

      new Setting(containerEl)
        .setName("Base URL（可选）")
        .setDesc("只有使用代理网关或自建兼容接口时才需要填写。")
        .addText((text) => {
          text.setPlaceholder("https://api.openai.com/v1");
          text.setValue(this.plugin.settings.customBaseUrl).onChange(async (v) => {
            this.plugin.settings.customBaseUrl = v.trim();
            await this.plugin.saveSettings();
          });
        });
    }

    containerEl.createEl("h3", { text: "高级设置" });

    new Setting(containerEl)
      .setName("内置 Skills 安装目录")
      .setDesc("默认 .opencode/skills。插件会自动安装内置 skills，并忽略目录中的非内置 skills。通常无需修改。")
      .addText((text) => {
        text.setValue(this.plugin.settings.skillsDir).onChange(async (v) => {
          this.plugin.settings.skillsDir = v.trim() || ".opencode/skills";
          await this.plugin.saveSettings();
          await this.plugin.reloadSkills();
        });
      });

    new Setting(containerEl)
      .setName("重新安装内置 Skills")
      .setDesc("手动覆盖安装一次内置 skills，用于修复技能缺失或文件损坏。")
      .addButton((b) => {
        b.setButtonText("立即重装").onClick(async () => {
          b.setDisabled(true);
          b.setButtonText("重装中...");
          try {
            const syncResult = await this.plugin.reloadSkills();
            if (syncResult && !syncResult.errors.length) {
              new Notice(`重装完成：${syncResult.synced}/${syncResult.total} 个技能，目录 ${syncResult.targetRoot}`);
            } else {
              const msg = syncResult && syncResult.errors.length
                ? syncResult.errors[0]
                : "未知错误";
              new Notice(`重装失败：${msg}`);
            }
          } catch (e) {
            new Notice(`重装失败: ${e instanceof Error ? e.message : String(e)}`);
          } finally {
            b.setDisabled(false);
            b.setButtonText("立即重装");
          }
        });
      });

    new Setting(containerEl)
      .setName("连接诊断")
      .setDesc("检测 OpenCode 可执行文件与连接状态。")
      .addButton((b) => {
        b.setButtonText("运行诊断").onClick(async () => {
          b.setDisabled(true);
          b.setButtonText("测试中...");
          try {
            const r = await this.plugin.diagnosticsService.run();
            if (r.connection.ok) new Notice(`连接正常 (${r.connection.mode})`);
            else new Notice(`连接失败: ${r.connection.error}`);
          } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e));
          } finally {
            b.setDisabled(false);
            b.setButtonText("运行诊断");
          }
        });
      });
  }
}

module.exports = class OpenCodeAssistantPlugin extends Plugin {
  async onload() {
    try {
      await this.loadPersistedData();

      this.sessionStore = new SessionStore(this);

      const vaultPath = this.getVaultPath();
      this.skillService = new SkillService(vaultPath, this.settings);
      this.opencodeClient = new OpenCodeClient({
        vaultPath,
        settings: this.settings,
        logger: (line) => this.log(line),
      });
      this.diagnosticsService = new DiagnosticsService(this);

      this.registerView(VIEW_TYPE, (leaf) => new OpenCodeAssistantView(leaf, this));

      this.addRibbonIcon("bot", "OpenCode 助手", () => this.activateView());

      this.addCommand({
        id: "open-opencode-assistant",
        name: "打开 OpenCode 助手",
        callback: () => this.activateView(),
      });

      this.addCommand({
        id: "opencode-send-selected-text",
        name: "发送选中文本到 OpenCode 助手",
        editorCallback: async (editor) => {
          const text = editor.getSelection().trim();
          if (!text) return new Notice("请先选择文本");

          await this.activateView();
          const view = this.getAssistantView();
          if (view) await view.sendPrompt(text);
        },
      });

      this.addCommand({
        id: "opencode-new-session",
        name: "OpenCode: 新建会话",
        callback: async () => {
          const session = await this.createSession("新会话");
          this.sessionStore.setActiveSession(session.id);
          await this.persistState();
          const view = this.getAssistantView();
          if (view) view.render();
        },
      });

      this.addSettingTab(new OpenCodeSettingsTab(this.app, this));
      await this.bootstrapData();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[opencode-assistant] load failed", e);
      new Notice(`OpenCode Assistant 加载失败: ${msg}`);
    }
  }

  async onunload() {
    if (this.opencodeClient) await this.opencodeClient.stop();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  log(line) {
    if (!this.settings || !this.settings.debugLogs) return;
    console.log("[opencode-assistant]", line);
  }

  getVaultPath() {
    const adapter = this.app.vault.adapter;
    const byMethod = adapter && typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "";
    const byField = adapter && adapter.basePath ? adapter.basePath : "";
    const resolved = byMethod || byField;
    if (!resolved) throw new Error("仅支持本地文件系统 Vault");
    return resolved;
  }

  getPluginRootDir() {
    const vaultPath = this.getVaultPath();
    const configDir = this.app && this.app.vault && this.app.vault.configDir
      ? String(this.app.vault.configDir)
      : ".obsidian";
    const id = this.manifest && this.manifest.id ? String(this.manifest.id) : "opencode-assistant";

    const candidates = [
      path.join(vaultPath, configDir, "plugins", id),
      this.manifest && this.manifest.dir ? String(this.manifest.dir) : "",
      __dirname,
      path.resolve(__dirname, ".."),
    ].filter(Boolean);

    for (const dir of candidates) {
      if (fs.existsSync(path.join(dir, "manifest.json"))) return dir;
    }
    return candidates[0] || __dirname;
  }

  getBundledSkillsRoot() {
    return path.join(this.getPluginRootDir(), "bundled-skills");
  }

  listBundledSkillIds(rootDir = this.getBundledSkillsRoot()) {
    if (!fs.existsSync(rootDir)) return [];

    return fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry && entry.isDirectory() && !String(entry.name || "").startsWith("."))
      .map((entry) => String(entry.name || "").trim())
      .filter(Boolean)
      .filter((id) => fs.existsSync(path.join(rootDir, id, "SKILL.md")))
      .sort((a, b) => a.localeCompare(b));
  }

  syncBundledSkills(vaultPath) {
    const bundledRoot = this.getBundledSkillsRoot();
    const bundledIds = this.listBundledSkillIds(bundledRoot);

    if (this.skillService) this.skillService.setAllowedSkillIds(bundledIds);
    if (!bundledIds.length) {
      return {
        synced: 0,
        total: 0,
        targetRoot: path.join(vaultPath, this.settings.skillsDir),
        bundledRoot,
        errors: [`未找到内置 skills 源目录或目录为空：${bundledRoot}`],
      };
    }

    const targetRoot = path.join(vaultPath, this.settings.skillsDir);
    fs.mkdirSync(targetRoot, { recursive: true });

    const errors = [];
    for (const skillId of bundledIds) {
      const srcDir = path.join(bundledRoot, skillId);
      const destDir = path.join(targetRoot, skillId);
      try {
        fs.rmSync(destDir, { recursive: true, force: true });
        copyDirectoryRecursive(srcDir, destDir);
      } catch (e) {
        errors.push(`${skillId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return {
      synced: bundledIds.length - errors.length,
      total: bundledIds.length,
      targetRoot,
      bundledRoot,
      errors,
    };
  }

  getAssistantView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (!leaves.length) return null;
    return leaves[0].view;
  }

  async activateView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length) {
      await this.app.workspace.revealLeaf(leaves[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  async loadPersistedData() {
    const raw = (await this.loadData()) || {};

    if (raw.settings || raw.runtimeState) {
      this.settings = normalizeSettings(raw.settings || {});
      this.runtimeState = migrateLegacyMessages(raw.runtimeState || { sessions: [], activeSessionId: "", messagesBySession: {} });
      return;
    }

    this.settings = normalizeSettings(raw);
    this.runtimeState = migrateLegacyMessages({ sessions: [], activeSessionId: "", messagesBySession: {} });
  }

  async saveSettings() {
    this.settings = normalizeSettings(this.settings);
    if (this.skillService) this.skillService.updateSettings(this.settings);
    if (this.opencodeClient) this.opencodeClient.updateSettings(this.settings);
    await this.persistState();
  }

  async persistState() {
    await this.saveData({ settings: this.settings, runtimeState: this.runtimeState });
  }

  async reloadSkills() {
    if (!this.skillService) return;
    const vaultPath = this.getVaultPath();
    const syncResult = this.syncBundledSkills(vaultPath);
    console.log(
      `[opencode-assistant] bundled skills reload: ${syncResult.synced || 0}/${syncResult.total || 0} ` +
      `source=${syncResult.bundledRoot || "unknown"} target=${syncResult.targetRoot || "unknown"}`,
    );
    if (syncResult.errors.length) this.log(`bundled skills sync: ${syncResult.errors.join("; ")}`);
    this.skillService.loadSkills();
    const view = this.getAssistantView();
    if (view) view.render();
    return syncResult;
  }

  async createSession(title) {
    const created = await this.opencodeClient.createSession(title || "");
    const session = {
      id: created.id,
      title: created.title || title || "新会话",
      updatedAt: Date.now(),
    };

    this.sessionStore.upsertSession(session);
    await this.persistState();
    return session;
  }

  async syncSessionsFromRemote() {
    try {
      const remote = await this.opencodeClient.listSessions();
      remote.forEach((s) => {
        this.sessionStore.upsertSession({
          id: s.id,
          title: s.title || "未命名会话",
          updatedAt: (s.time && s.time.updated) || Date.now(),
        });
      });

      const st = this.sessionStore.state();
      if (!st.activeSessionId && st.sessions.length) st.activeSessionId = st.sessions[0].id;
      await this.persistState();
    } catch {
      // ignore bootstrap sync failure
    }
  }

  async bootstrapData() {
    const vaultPath = this.getVaultPath();
    const syncResult = this.syncBundledSkills(vaultPath);
    if (!syncResult.errors.length) {
      console.log(
        `[opencode-assistant] bundled skills bootstrap: ${syncResult.synced || 0}/${syncResult.total || 0} ` +
        `source=${syncResult.bundledRoot || "unknown"} target=${syncResult.targetRoot || "unknown"}`,
      );
    }
    if (syncResult.errors.length) this.log(`bundled skills bootstrap sync: ${syncResult.errors.join("; ")}`);
    this.skillService.loadSkills();
    try {
      this.cachedModels = await this.opencodeClient.listModels();
    } catch {
      this.cachedModels = [];
    }
    await this.syncSessionsFromRemote();
  }
};
