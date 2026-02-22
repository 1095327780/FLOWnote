const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execFileSync } = require("child_process");
const {
  ExecutableResolver,
  isNodeScriptPath,
  isWindowsCommandWrapperPath,
  resolveWindowsWrapperNodeScript,
  resolveNodeExecutablePath,
} = require("./executable-resolver");
const {
  nodeHttpRequestJson,
  nodeHttpRequestSse,
  createLinkedAbortController,
} = require("./http-utils");
const {
  parseModel,
  parseCommandModel,
  availableCommandSet,
  resolveCommandFromSet,
  parseSlashCommand,
  findLatestAssistantMessage,
} = require("./transports/shared/command-utils");
const { createTransportEventReducer } = require("./transports/shared/event-reducer");
const {
  pollAssistantPayload,
  ensureRenderablePayload,
} = require("./transports/shared/finalizer");
const {
  extractAssistantPayloadFromEnvelope,
  extractErrorText,
  normalizedRenderableText,
  hasRenderablePayload,
  formatSessionStatusText,
  isIntermediateToolCallPayload,
  payloadLooksInProgress,
  hasTerminalPayload,
  responseRichnessScore,
  chooseRicherResponse,
} = require("./assistant-payload-utils");
const {
  createPathWslMethods,
} = require("./transports/compat/path-wsl-utils");
const {
  createLaunchAttemptMethods,
} = require("./transports/compat/launch-attempt-methods");
const {
  createProcessLifecycleMethods,
} = require("./transports/compat/process-lifecycle-methods");
const {
  createRequestSessionMethods,
} = require("./transports/compat/request-session-methods");
const {
  createResponseRecoveryMethods,
} = require("./transports/compat/response-recovery-methods");
const {
  createSendMessageMethods,
} = require("./transports/compat/send-message-methods");
const {
  createQuestionPermissionMethods,
} = require("./transports/compat/question-permission-methods");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

const OPENCODE_SERVE_ARGS = [
  "serve",
  "--hostname",
  "127.0.0.1",
  "--port",
  "0",
  "--cors",
  "app://obsidian.md",
  "--print-logs",
];
const STARTUP_TIMEOUT_MS = 15000;
const WSL_STARTUP_TIMEOUT_MS = 30000;
const WSL_RUNTIME_WORKSPACE_DIR = ".flownote-workspace";
const WSL_XDG_DATA_DIR = ".flownote-data";
const WSL_XDG_CONFIG_DIR = ".config";
const WSL_XDG_STATE_DIR = ".local/state";
const WSL_XDG_CACHE_DIR = ".cache";
const SQLITE_LOCK_RE = /sqlite|database is locked|sql_busy|readonly database|disk i\/o|locking protocol/i;

function isWindowsPlatform() {
  return process.platform === "win32";
}

function isWindowsCommandWrapper(filePath) {
  return isWindowsCommandWrapperPath(filePath);
}

function quotePosixShellArg(value) {
  return `'${String(value || "").replace(/'/g, "'\\''")}'`;
}

function toWslPath(inputPath) {
  const raw = String(inputPath || "").trim();
  if (!raw) return "";
  if (raw.startsWith("/")) return raw;

  const normalized = raw.replace(/\\/g, "/");
  const driveMatch = normalized.match(/^([a-zA-Z]):\/(.*)$/);
  if (!driveMatch) return normalized;
  const drive = String(driveMatch[1] || "").toLowerCase();
  const tail = String(driveMatch[2] || "");
  return `/mnt/${drive}/${tail}`;
}

function parseWindowsDrivePath(inputPath) {
  const normalized = String(inputPath || "").trim().replace(/\\/g, "/");
  const match = normalized.match(/^([a-zA-Z]):\/(.*)$/);
  if (!match) return null;
  return {
    drive: String(match[1] || "").toLowerCase(),
    tail: String(match[2] || ""),
  };
}

function parseWslMountPath(inputPath) {
  const normalized = String(inputPath || "").trim().replace(/\\/g, "/");
  const match = normalized.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (!match) return null;
  return {
    drive: String(match[1] || "").toLowerCase(),
    tail: String(match[2] || ""),
  };
}

function toWslPathWithFallback(inputPath) {
  const raw = String(inputPath || "").trim();
  if (!raw || !isWindowsPlatform()) return toWslPath(raw);

  const parsed = parseWindowsDrivePath(raw);
  if (!parsed) return toWslPath(raw);
  if (parsed.drive === "c") return toWslPath(raw);

  const direct = toWslPath(raw);
  const normalizedTail = parsed.tail.replace(/\//g, path.sep);

  const candidates = [];
  if (normalizedTail) {
    candidates.push(path.join(`${String("C").toUpperCase()}:\\`, normalizedTail));
    const userProfile = process.env.USERPROFILE || os.homedir();
    if (userProfile) candidates.push(path.join(userProfile, normalizedTail));
  }

  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  return existing ? toWslPath(existing) : direct;
}

function shortStableHash(input) {
  const text = String(input || "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function collectOutputTail(tail, source, chunk) {
  const text = String(chunk || "");
  if (!text) return;
  text
    .split(/\r?\n/)
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .forEach((line) => {
      tail.push(`${source}: ${line}`);
      if (tail.length > 20) tail.shift();
    });
}

function appendOutputHint(message, tail) {
  if (!Array.isArray(tail) || !tail.length) return message;
  return `${message}\n最近输出:\n${tail.join("\n")}`;
}

function looksLikeRetryableConnectionError(message) {
  const text = String(message || "");
  if (!text) return false;
  return /(ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|connection reset|network socket disconnected|read ECONNRESET|write EPIPE|broken pipe)/i.test(text);
}

function extractSessionStatusHint(status) {
  if (!status || typeof status !== "object") return "";
  const text = [
    typeof status.type === "string" ? status.type : "",
    typeof status.message === "string" ? status.message : "",
    typeof status.error === "string" ? status.error : "",
    typeof status.reason === "string" ? status.reason : "",
  ]
    .filter(Boolean)
    .join(" ");
  return String(text || "").trim();
}

function sessionStatusLooksAuthFailure(status) {
  const hint = extractSessionStatusHint(status);
  if (!hint) return false;
  return /401|unauthorized|user not found|forbidden|invalid api key|authentication/i.test(hint);
}

class CompatTransport {
  constructor(options) {
    this.vaultPath = options.vaultPath;
    this.settings = options.settings;
    this.logger = typeof options.logger === "function" ? options.logger : () => {};
    this.process = null;
    this.baseUrl = "";
    this.bootPromise = null;
    this.resolver = new ExecutableResolver();
    this.commandCache = {
      at: 0,
      items: [],
    };
    this.processExitListener = null;
    this.launchContext = {
      mode: "native",
      directory: this.vaultPath,
      label: "",
      distro: "",
      wslHome: "",
      wslUserHome: "",
    };
    this.windowsDriveMapCache = {
      at: 0,
      map: new Map(),
    };
    this.wslDirectoryCache = new Map();
    this.wslWorkspaceDir = "";
    this.wslUserHomeDir = "";
    this.wslDataHomeOverride = "";
    this.wslRequestChain = Promise.resolve();
    this.wslFallbackMirrorAt = 0;
    this.wslFallbackMirrorKey = "";
    this.getPreferredLaunch = typeof options.getPreferredLaunch === "function"
      ? options.getPreferredLaunch
      : null;
    this.onLaunchSuccess = typeof options.onLaunchSuccess === "function"
      ? options.onLaunchSuccess
      : null;
  }

  log(line) {
    this.logger(line);
  }

  updateSettings(settings) {
    this.settings = settings;
    this.wslDirectoryCache.clear();
    this.wslWorkspaceDir = "";
    this.wslUserHomeDir = "";
    this.wslFallbackMirrorAt = 0;
    this.wslFallbackMirrorKey = "";
  }

  async resolveExecutable() {
    if (!this.settings.autoDetectCli && this.settings.cliPath) {
      return this.resolver.resolve(this.settings.cliPath, { onlyCliPath: true });
    }
    return this.resolver.resolve(this.settings.cliPath);
  }
}

const compatDeps = {
  fs,
  path,
  os,
  spawn,
  execFileSync,
  URL,
  process,
  ExecutableResolver,
  isNodeScriptPath,
  resolveWindowsWrapperNodeScript,
  resolveNodeExecutablePath,
  nodeHttpRequestJson,
  nodeHttpRequestSse,
  createLinkedAbortController,
  parseModel,
  parseCommandModel,
  availableCommandSet,
  resolveCommandFromSet,
  parseSlashCommand,
  findLatestAssistantMessage,
  createTransportEventReducer,
  pollAssistantPayload,
  ensureRenderablePayload,
  extractAssistantPayloadFromEnvelope,
  extractErrorText,
  normalizedRenderableText,
  hasRenderablePayload,
  formatSessionStatusText,
  isIntermediateToolCallPayload,
  payloadLooksInProgress,
  hasTerminalPayload,
  responseRichnessScore,
  chooseRicherResponse,
  sleep,
  streamPseudo,
  OPENCODE_SERVE_ARGS,
  STARTUP_TIMEOUT_MS,
  WSL_STARTUP_TIMEOUT_MS,
  WSL_RUNTIME_WORKSPACE_DIR,
  WSL_XDG_DATA_DIR,
  WSL_XDG_CONFIG_DIR,
  WSL_XDG_STATE_DIR,
  WSL_XDG_CACHE_DIR,
  SQLITE_LOCK_RE,
  isWindowsPlatform,
  isWindowsCommandWrapper,
  quotePosixShellArg,
  toWslPath,
  parseWindowsDrivePath,
  parseWslMountPath,
  toWslPathWithFallback,
  shortStableHash,
  collectOutputTail,
  appendOutputHint,
  looksLikeRetryableConnectionError,
  sessionStatusLooksAuthFailure,
};

const pathWslMethods = createPathWslMethods(compatDeps);
const launchAttemptMethods = createLaunchAttemptMethods(compatDeps);
const processLifecycleMethods = createProcessLifecycleMethods(compatDeps);
const requestSessionMethods = createRequestSessionMethods(compatDeps);
const responseRecoveryMethods = createResponseRecoveryMethods(compatDeps);
const sendMessageMethods = createSendMessageMethods(compatDeps);
const questionPermissionMethods = createQuestionPermissionMethods(compatDeps);

Object.assign(
  CompatTransport.prototype,
  pathWslMethods,
  launchAttemptMethods,
  processLifecycleMethods,
  requestSessionMethods,
  responseRecoveryMethods,
  sendMessageMethods,
  questionPermissionMethods,
);

module.exports = { CompatTransport };
