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
const WSL_RUNTIME_WORKSPACE_DIR = ".opencode-assistant-workspace";
const WSL_XDG_DATA_DIR = ".opencode-assistant-data";
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

  normalizeDirectoryForService(directory) {
    const raw = String(directory || "").trim();
    if (!raw) return raw;
    if (this.launchContext && this.launchContext.mode === "wsl") {
      let resolved = this.resolveWslDirectory(raw);
      if (this.isWslMountPath(resolved)) {
        const mountAccessible = this.probeWslDirectory(resolved);
        if (!mountAccessible) {
          const fallback = this.getDefaultWslWorkspaceDir();
          this.log(`wsl mount directory inaccessible, fallback to workspace: ${resolved} -> ${fallback}`);
          this.ensureWslFallbackWorkspaceMirror(raw, fallback);
          resolved = fallback;
        }
      }
      const normalized = this.normalizeWslWorkspaceDirectory(resolved);
      if (normalized && normalized !== raw) {
        this.wslDirectoryCache.set(raw, normalized);
      }
      return normalized;
    }
    return raw;
  }

  getActiveWslDistro() {
    const fromLaunch = this.launchContext && this.launchContext.mode === "wsl"
      ? String(this.launchContext.distro || "").trim()
      : "";
    if (fromLaunch) return fromLaunch;
    const fromSettings = String(this.settings && this.settings.wslDistro ? this.settings.wslDistro : "").trim();
    return fromSettings || "Ubuntu";
  }

  toWindowsWslUncPath(wslPath, distro = "") {
    const target = String(wslPath || "").trim();
    if (!target.startsWith("/")) return "";
    const pickedDistro = String(distro || this.getActiveWslDistro() || "").trim();
    if (!pickedDistro) return "";
    const tail = target.replace(/^\/+/, "").replace(/\//g, "\\");
    return `\\\\wsl$\\${pickedDistro}\\${tail}`;
  }

  copyFileIfNeeded(srcFile, dstFile) {
    try {
      const srcStat = fs.statSync(srcFile);
      if (!srcStat.isFile()) return;
      let shouldCopy = true;
      try {
        const dstStat = fs.statSync(dstFile);
        if (
          dstStat.isFile()
          && Number(dstStat.size) === Number(srcStat.size)
          && Math.floor(Number(dstStat.mtimeMs || 0)) === Math.floor(Number(srcStat.mtimeMs || 0))
        ) {
          shouldCopy = false;
        }
      } catch {
      }
      if (!shouldCopy) return;
      fs.mkdirSync(path.dirname(dstFile), { recursive: true });
      fs.copyFileSync(srcFile, dstFile);
      try {
        fs.utimesSync(dstFile, srcStat.atime, srcStat.mtime);
      } catch {
      }
    } catch {
    }
  }

  copyTreeIfNeeded(srcPath, dstPath) {
    let stat;
    try {
      stat = fs.statSync(srcPath);
    } catch {
      return;
    }
    if (!stat) return;

    if (stat.isFile()) {
      this.copyFileIfNeeded(srcPath, dstPath);
      return;
    }
    if (!stat.isDirectory()) return;

    try {
      fs.mkdirSync(dstPath, { recursive: true });
    } catch {
      return;
    }

    let entries = [];
    try {
      entries = fs.readdirSync(srcPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry || !entry.name) continue;
      const name = String(entry.name || "");
      if (!name || name === ".DS_Store") continue;
      const childSrc = path.join(srcPath, name);
      const childDst = path.join(dstPath, name);
      if (entry.isDirectory()) {
        this.copyTreeIfNeeded(childSrc, childDst);
      } else if (entry.isFile()) {
        this.copyFileIfNeeded(childSrc, childDst);
      }
    }
  }

  ensureWslFallbackWorkspaceMirror(sourceVaultPath, fallbackWorkspacePath) {
    if (!isWindowsPlatform()) return;
    if (!this.launchContext || this.launchContext.mode !== "wsl") return;

    const sourceRoot = String(sourceVaultPath || "").trim();
    const fallback = String(fallbackWorkspacePath || "").trim();
    if (!sourceRoot || !fallback.startsWith("/")) return;
    if (!path.isAbsolute(sourceRoot)) return;
    if (!fs.existsSync(sourceRoot)) return;

    const now = Date.now();
    const mirrorKey = `${sourceRoot}=>${fallback}`;
    if (
      this.wslFallbackMirrorKey === mirrorKey
      && now - Number(this.wslFallbackMirrorAt || 0) < 5000
    ) {
      return;
    }

    const distro = this.getActiveWslDistro();
    const uncRoot = this.toWindowsWslUncPath(fallback, distro);
    if (!uncRoot) return;

    const mirrorItems = [
      "Meta/.ai-memory",
      "Meta/模板",
      "skills",
      "AGENTS.md",
      "README.md",
    ];

    let copiedAny = false;
    for (const rel of mirrorItems) {
      const src = path.join(sourceRoot, rel);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(uncRoot, rel);
      this.copyTreeIfNeeded(src, dst);
      copiedAny = true;
    }

    this.wslFallbackMirrorAt = now;
    this.wslFallbackMirrorKey = mirrorKey;
    if (copiedAny) {
      this.log(`wsl fallback workspace mirrored from vault: ${sourceRoot} -> ${fallback}`);
    }
  }

  isWslMountPath(value) {
    return /^\/mnt\/[a-zA-Z]\//.test(String(value || "").trim());
  }

  readWindowsDriveMap() {
    if (!isWindowsPlatform()) return new Map();
    const now = Date.now();
    if (this.windowsDriveMapCache && now - Number(this.windowsDriveMapCache.at || 0) <= 60_000) {
      return this.windowsDriveMapCache.map;
    }

    const map = new Map();
    try {
      const output = String(execFileSync("cmd.exe", ["/d", "/s", "/c", "subst"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 1500,
      }) || "");

      output.split(/\r?\n/).forEach((line) => {
        const match = String(line || "").match(/^\s*([a-zA-Z]):\\:\s*=>\s*(.+?)\s*$/);
        if (!match) return;
        const drive = String(match[1] || "").toLowerCase();
        const target = String(match[2] || "").trim().replace(/^\\\\\?\\/, "");
        if (!drive || !target) return;
        map.set(drive, target);
      });
    } catch {
    }

    this.windowsDriveMapCache = {
      at: now,
      map,
    };
    return map;
  }

  resolveWindowsAliasPath(windowsPath) {
    if (!isWindowsPlatform()) return "";
    const parsed = parseWindowsDrivePath(windowsPath);
    if (!parsed || parsed.drive === "c") return "";

    const driveMap = this.readWindowsDriveMap();
    const mappedRoot = String(driveMap.get(parsed.drive) || "").trim();
    if (!mappedRoot) return "";

    const tail = String(parsed.tail || "").replace(/\//g, path.sep);
    return tail ? path.join(mappedRoot, tail) : mappedRoot;
  }

  buildWslDirectoryCandidates(rawDirectory) {
    const raw = String(rawDirectory || "").trim();
    const candidates = [];
    const push = (value) => {
      const next = String(value || "").trim();
      if (!next || candidates.includes(next)) return;
      candidates.push(next);
    };

    if (!raw) return candidates;

    const parsedWindows = parseWindowsDrivePath(raw);
    const parsedMount = parseWslMountPath(raw);

    if (raw.startsWith("/")) push(raw);

    if (parsedWindows) {
      const tail = String(parsedWindows.tail || "").replace(/\//g, path.sep);
      const mappedAlias = this.resolveWindowsAliasPath(raw);
      if (mappedAlias) push(toWslPath(mappedAlias));
      push(toWslPathWithFallback(raw));
      push(toWslPath(raw));

      if (tail) {
        const mappedRoot = String(this.readWindowsDriveMap().get(parsedWindows.drive) || "").trim();
        if (mappedRoot) push(toWslPath(path.join(mappedRoot, tail)));

        const userProfile = process.env.USERPROFILE || os.homedir();
        if (userProfile) push(toWslPath(path.join(userProfile, tail)));
      }
      return candidates;
    }

    if (parsedMount) {
      const tail = String(parsedMount.tail || "").replace(/\//g, path.sep);
      if (tail) {
        const mappedRoot = String(this.readWindowsDriveMap().get(parsedMount.drive) || "").trim();
        if (mappedRoot) push(toWslPath(path.join(mappedRoot, tail)));

        const userProfile = process.env.USERPROFILE || os.homedir();
        if (userProfile) push(toWslPath(path.join(userProfile, tail)));
      }
      push(toWslPathWithFallback(raw));
      return candidates;
    }

    push(toWslPathWithFallback(raw));
    push(toWslPath(raw));
    return candidates;
  }

  probeWslDirectory(directory) {
    if (!isWindowsPlatform()) return true;
    const target = String(directory || "").trim();
    if (!target) return false;
    if (!target.startsWith("/")) return false;

    const args = [];
    const distro = this.launchContext && this.launchContext.mode === "wsl"
      ? String(this.launchContext.distro || "").trim()
      : "";
    if (distro) args.push("-d", distro);
    args.push("-e", "sh", "-lc", `[ -d ${quotePosixShellArg(target)} ] && printf __OK__`);

    try {
      const out = String(execFileSync("wsl.exe", args, {
        encoding: "utf8",
        windowsHide: true,
        timeout: 2000,
        cwd: process.env.USERPROFILE || os.homedir() || process.cwd(),
      }) || "");
      return out.includes("__OK__");
    } catch {
      return false;
    }
  }

  resolveWslDirectory(rawDirectory) {
    const raw = String(rawDirectory || "").trim();
    if (!raw) return raw;

    const cached = String(this.wslDirectoryCache.get(raw) || "").trim();
    if (cached) return cached;

    const candidates = this.buildWslDirectoryCandidates(raw);
    if (!candidates.length) return raw;

    let resolved = candidates[0];
    for (const candidate of candidates) {
      if (this.probeWslDirectory(candidate)) {
        resolved = candidate;
        break;
      }
    }

    this.wslDirectoryCache.set(raw, resolved);
    if (resolved !== candidates[0]) {
      this.log(`wsl directory mapped: ${candidates[0]} -> ${resolved}`);
    }
    return resolved;
  }

  getWslHomeDirectory() {
    if (this.wslUserHomeDir) return this.wslUserHomeDir;
    const fromUserHome = String(this.launchContext && this.launchContext.wslUserHome ? this.launchContext.wslUserHome : "").trim();
    if (fromUserHome.startsWith("/")) {
      this.wslUserHomeDir = fromUserHome;
      return this.wslUserHomeDir;
    }
    const fromLaunch = String(this.launchContext && this.launchContext.wslHome ? this.launchContext.wslHome : "").trim();
    if (fromLaunch.startsWith("/")) {
      const idx = fromLaunch.lastIndexOf("/");
      if (idx > 0) {
        this.wslUserHomeDir = fromLaunch.slice(0, idx);
        return this.wslUserHomeDir;
      }
    }
    const args = [];
    const distro = this.launchContext && this.launchContext.mode === "wsl"
      ? String(this.launchContext.distro || "").trim()
      : String(this.settings && this.settings.wslDistro ? this.settings.wslDistro : "").trim();
    if (distro) args.push("-d", distro);
    args.push("-e", "sh", "-lc", "printf '%s' \"$HOME\"");

    try {
      const out = String(execFileSync("wsl.exe", args, {
        encoding: "utf8",
        windowsHide: true,
        timeout: 2000,
        cwd: process.env.USERPROFILE || os.homedir() || process.cwd(),
      }) || "").trim();
      if (out.startsWith("/")) {
        this.wslUserHomeDir = out;
        return this.wslUserHomeDir;
      }
    } catch {
    }
    this.wslUserHomeDir = "/home";
    return this.wslUserHomeDir;
  }

  ensureWslDirectory(dirPath) {
    if (!isWindowsPlatform()) return;
    const target = String(dirPath || "").trim();
    if (!target.startsWith("/")) return;

    const args = [];
    const distro = this.launchContext && this.launchContext.mode === "wsl"
      ? String(this.launchContext.distro || "").trim()
      : String(this.settings && this.settings.wslDistro ? this.settings.wslDistro : "").trim();
    if (distro) args.push("-d", distro);
    args.push("-e", "sh", "-lc", `mkdir -p ${quotePosixShellArg(target)} >/dev/null 2>&1`);

    try {
      execFileSync("wsl.exe", args, {
        encoding: "utf8",
        windowsHide: true,
        timeout: 2500,
        cwd: process.env.USERPROFILE || os.homedir() || process.cwd(),
      });
    } catch {
    }
  }

  getDefaultWslWorkspaceDir() {
    if (this.wslWorkspaceDir) return this.wslWorkspaceDir;
    const homeDir = this.getWslHomeDirectory();
    const workspace = `${homeDir}/${WSL_RUNTIME_WORKSPACE_DIR}`;
    this.ensureWslDirectory(workspace);
    this.wslWorkspaceDir = workspace;
    this.log(`wsl mount directory detected, use local workspace: ${workspace}`);
    return workspace;
  }

  normalizeWslWorkspaceDirectory(inputDir) {
    const raw = String(inputDir || "").trim();
    if (!raw) return raw;

    const normalized = raw.replace(/\\/g, "/").replace(/\/+$/, "");
    const needsMigration = /\/\.opencode-runtime\/workspace$/i.test(normalized)
      || /\/\.opencode-workspace$/i.test(normalized);
    if (!needsMigration) return raw;

    const fallback = this.getDefaultWslWorkspaceDir();
    this.log(`wsl legacy workspace mapped: ${raw} -> ${fallback}`);
    return fallback;
  }

  buildWslDirectoryHint(detailText) {
    if (!this.launchContext || this.launchContext.mode !== "wsl") return "";
    const detail = String(detailText || "");
    if (!/enoent|no such file|cannot find/i.test(detail)) return "";
    if (!/config\.json|\/mnt\/[a-z]\//i.test(detail)) return "";
    return `\n提示: 当前 Vault 路径在 WSL 不可访问，插件会自动改用 WSL 本地工作目录。`;
  }

  buildWslSqliteHint(detailText) {
    if (!this.launchContext || this.launchContext.mode !== "wsl") return "";
    const detail = String(detailText || "");
    if (!SQLITE_LOCK_RE.test(detail)) return "";
    const dataHome = String(this.launchContext.wslHome || "").trim();
    const suffix = dataHome ? ` 当前 XDG_DATA_HOME=${dataHome}。` : "";
    return `\n提示: 检测到 SQLite/文件锁问题。OpenCode 官方将数据库存放在 XDG_DATA_HOME（默认 ~/.local/share/opencode）。插件已改为独立 XDG_DATA_HOME，以避免与其他 OpenCode 进程竞争同一个数据库。${suffix}`;
  }

  buildWslServeCommand(_runtimeHome) {
    const args = OPENCODE_SERVE_ARGS.map((arg) => quotePosixShellArg(arg)).join(" ");
    const overrideDataHome = String(this.wslDataHomeOverride || "").trim();
    const dataHomeExpr = overrideDataHome.startsWith("/")
      ? quotePosixShellArg(overrideDataHome)
      : `"${`$HOME/${WSL_XDG_DATA_DIR}`}"`;

    return [
      "cd \"$HOME\" >/dev/null 2>&1 || true;",
      "OPENCODE_BIN='';",
      "for c in \"$HOME/.opencode/bin/opencode\" /home/*/.opencode/bin/opencode /root/.opencode/bin/opencode \"$HOME/.local/bin/opencode\" \"/usr/local/bin/opencode\" \"/usr/bin/opencode\"; do",
      "  if [ -x \"$c\" ]; then OPENCODE_BIN=\"$c\"; break; fi;",
      "done;",
      "if [ -z \"$OPENCODE_BIN\" ] && command -v opencode >/dev/null 2>&1; then",
      "  CAND=\"$(command -v opencode 2>/dev/null)\";",
      "  case \"$CAND\" in",
      "    ''|*.exe|*:*|*\\\\*) ;;",
      "    *) OPENCODE_BIN=\"$CAND\" ;;",
      "  esac;",
      "fi;",
      "if [ -z \"$OPENCODE_BIN\" ]; then",
      "  echo \"opencode not found in WSL PATH or common install dirs\" 1>&2;",
      "  exit 127;",
      "fi;",
      "echo \"[opencode-assistant] WSL HOME=$HOME\" 1>&2;",
      `XDG_DATA_HOME_DIR=${dataHomeExpr};`,
      `XDG_CONFIG_HOME_DIR="$HOME/${WSL_XDG_CONFIG_DIR}";`,
      `XDG_STATE_HOME_DIR="$HOME/${WSL_XDG_STATE_DIR}";`,
      `XDG_CACHE_HOME_DIR="$HOME/${WSL_XDG_CACHE_DIR}";`,
      "SRC_DATA_DIR=\"$HOME/.local/share/opencode\";",
      "TARGET_DATA_DIR=\"$XDG_DATA_HOME_DIR/opencode\";",
      "mkdir -p \"$XDG_DATA_HOME_DIR\" \"$XDG_CONFIG_HOME_DIR\" \"$XDG_STATE_HOME_DIR\" \"$XDG_CACHE_HOME_DIR\" >/dev/null 2>&1 || true;",
      "mkdir -p \"$TARGET_DATA_DIR\" >/dev/null 2>&1 || true;",
      "if [ -d \"$SRC_DATA_DIR\" ] && [ \"$SRC_DATA_DIR\" != \"$TARGET_DATA_DIR\" ]; then",
      "  cp -R \"$SRC_DATA_DIR\"/. \"$TARGET_DATA_DIR\"/ >/dev/null 2>&1 || true;",
      "  find \"$TARGET_DATA_DIR\" -type f \\( -name \"*.lock\" -o -name \"*.wal\" -o -name \"*.shm\" \\) -delete >/dev/null 2>&1 || true;",
      "fi;",
      "echo \"[opencode-assistant] WSL XDG_DATA_HOME=$XDG_DATA_HOME_DIR\" 1>&2;",
      "echo \"[opencode-assistant] WSL XDG_CONFIG_HOME=$XDG_CONFIG_HOME_DIR\" 1>&2;",
      `exec env XDG_DATA_HOME="$XDG_DATA_HOME_DIR" XDG_CONFIG_HOME="$XDG_CONFIG_HOME_DIR" XDG_STATE_HOME="$XDG_STATE_HOME_DIR" XDG_CACHE_HOME="$XDG_CACHE_HOME_DIR" "$OPENCODE_BIN" ${args}`,
    ].join(" ");
  }

  useWslDataHomeFallback() {
    if (!this.launchContext || this.launchContext.mode !== "wsl") return false;
    const homeDir = String(this.getWslHomeDirectory() || "").trim();
    if (!homeDir.startsWith("/")) return false;
    const stamp = Date.now().toString(36);
    const vaultTag = shortStableHash(this.vaultPath || "vault").slice(0, 8);
    const next = `${homeDir}/${WSL_XDG_DATA_DIR}-${vaultTag}-${stamp}`;
    if (!next || next === this.wslDataHomeOverride) return false;
    this.wslDataHomeOverride = next;
    this.log(`wsl sqlite fallback XDG_DATA_HOME=${next}`);
    return true;
  }

  parseWslCliPath(cliPath) {
    const raw = String(cliPath || "").trim();
    if (!raw) return { useWsl: false, distro: "" };

    const lower = raw.toLowerCase();
    if (lower.startsWith("wsl://")) {
      return { useWsl: true, distro: raw.slice("wsl://".length).trim() };
    }
    if (lower.startsWith("wsl:")) {
      return { useWsl: true, distro: raw.slice("wsl:".length).trim() };
    }

    const normalized = raw.replace(/\\/g, "/");
    const base = normalized.split("/").filter(Boolean).pop() || "";
    if (base.toLowerCase() === "wsl" || base.toLowerCase() === "wsl.exe") {
      return { useWsl: true, distro: "" };
    }

    return { useWsl: false, distro: "" };
  }

  createWslAttempt(runtimeHome, distro = "", shellName = "sh") {
    const pickedDistro = String(distro || "").trim();
    const pickedShell = String(shellName || "sh").trim() || "sh";
    const args = [];
    if (pickedDistro) args.push("-d", pickedDistro);
    args.push("-e", pickedShell, "-lc", this.buildWslServeCommand(runtimeHome));
    const wslLaunchCwd = process.env.USERPROFILE || os.homedir() || process.cwd();
    return {
      label: pickedDistro ? `wsl(${pickedDistro}, ${pickedShell})` : `wsl(${pickedShell})`,
      command: "wsl.exe",
      args,
      options: {
        cwd: wslLaunchCwd,
        env: { ...process.env },
        shell: false,
      },
      mode: "wsl",
      directory: toWslPath(this.vaultPath) || this.vaultPath,
      distro: pickedDistro,
    };
  }

  pushWslAttempts(list, seen, runtimeHome, distro = "") {
    this.pushLaunchAttempt(list, seen, this.createWslAttempt(runtimeHome, distro, "bash"));
    this.pushLaunchAttempt(list, seen, this.createWslAttempt(runtimeHome, distro, "sh"));
  }

  pushLaunchAttempt(list, seen, attempt) {
    const item = attempt && typeof attempt === "object" ? attempt : null;
    if (!item) return;
    const command = String(item.command || "").trim();
    if (!command) return;
    const args = Array.isArray(item.args) ? item.args.map((v) => String(v || "")) : [];
    const shellFlag = item.options && item.options.shell ? "1" : "0";
    const key = `${command}|${shellFlag}|${args.join("\u0001")}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({
      label: String(item.label || command),
      command,
      args,
      options: item.options && typeof item.options === "object" ? item.options : {},
      mode: item.mode === "wsl" ? "wsl" : "native",
      directory: String(item.directory || this.vaultPath),
      distro: String(item.distro || "").trim(),
      remember: item.remember !== false,
    });
  }

  normalizeLaunchStrategy(value) {
    const mode = String(value || "").trim().toLowerCase();
    const compact = mode.replace(/[\s_-]+/g, "");
    if (
      mode === "native"
      || compact === "windowsnative"
      || compact === "macnative"
      || compact === "local"
    ) {
      if (isWindowsPlatform() && String(process.arch || "").toLowerCase() === "arm64") {
        const cliPath = String(this.settings && this.settings.cliPath ? this.settings.cliPath : "").trim().toLowerCase();
        const wslDistro = String(this.settings && this.settings.wslDistro ? this.settings.wslDistro : "").trim();
        const hasWslHint = Boolean(wslDistro) || /^wsl(?::|:\/\/|$|\.exe$)/.test(cliPath);
        if (hasWslHint) return "wsl";
        if (!cliPath) return "auto";
      }
      return "native";
    }
    if (
      mode === "wsl"
      || compact === "windowswsl"
      || compact === "wslinstall"
      || compact === "onlywsl"
    ) return "wsl";
    return "auto";
  }

  normalizeLaunchProfile(profile) {
    if (!profile || typeof profile !== "object") return null;
    const mode = String(profile.mode || "").trim().toLowerCase() === "wsl" ? "wsl" : "native";
    const command = String(profile.command || "").trim();
    const args = Array.isArray(profile.args)
      ? profile.args.map((item) => String(item || ""))
      : [];
    const shell = Boolean(profile.shell);
    const distro = String(profile.distro || "").trim();
    if (mode === "native" && !command) return null;
    return { mode, command, args, shell, distro };
  }

  resolvePreferredLaunchProfile() {
    if (typeof this.getPreferredLaunch !== "function") return null;
    try {
      return this.normalizeLaunchProfile(this.getPreferredLaunch());
    } catch {
      return null;
    }
  }

  buildLaunchProfileFromAttempt(attempt) {
    const item = attempt && typeof attempt === "object" ? attempt : null;
    if (!item) return null;
    if (item.remember === false) return null;
    if (item.mode === "wsl") {
      return { mode: "wsl", command: "wsl.exe", shell: false, distro: String(item.distro || "").trim() };
    }
    const command = String(item.command || "").trim();
    if (!command) return null;
    return {
      mode: "native",
      command,
      args: Array.isArray(item.args) ? item.args.map((value) => String(value || "")) : [],
      shell: Boolean(item.options && item.options.shell),
      distro: "",
    };
  }

  notifyLaunchSuccess(attempt) {
    const profile = this.buildLaunchProfileFromAttempt(attempt);
    if (!profile || typeof this.onLaunchSuccess !== "function") return;
    try {
      Promise.resolve(this.onLaunchSuccess(profile)).catch(() => {
      });
    } catch {
    }
  }

  pushPreferredLaunchAttempt(list, seen, preferred, runtimeHome) {
    const profile = this.normalizeLaunchProfile(preferred);
    if (!profile) return;
    if (profile.mode === "wsl") {
      this.pushWslAttempts(list, seen, runtimeHome, profile.distro);
      return;
    }

    this.pushLaunchAttempt(list, seen, {
      label: `${profile.command} (remembered)`,
      command: profile.command,
      args: Array.isArray(profile.args) && profile.args.length ? profile.args : OPENCODE_SERVE_ARGS,
      options: {
        cwd: this.vaultPath,
        env: { ...process.env, OPENCODE_HOME: runtimeHome },
        shell: Boolean(profile.shell),
      },
      mode: "native",
      directory: this.vaultPath,
    });
  }

  isNodeScriptLaunchPath(resolvedPath, resolvedKind = "") {
    if (String(resolvedKind || "").trim().toLowerCase() === "node-script") return true;
    return isNodeScriptPath(resolvedPath);
  }

  pushNodeScriptAttempts(list, seen, scriptPath, baseOptions, preferredNode = "", sourcePath = "") {
    const script = String(scriptPath || "").trim();
    if (!script) return;

    const nodeCandidates = [
      String(preferredNode || "").trim(),
      String(resolveNodeExecutablePath(script) || "").trim(),
      isWindowsPlatform() ? "node.exe" : "node",
      "node",
    ];
    const dedupedNodes = [...new Set(nodeCandidates.filter(Boolean))];
    const baseName = path.basename(script);
    const sourceLabel = String(sourcePath || "").trim();

    dedupedNodes.forEach((nodeCommand, index) => {
      this.pushLaunchAttempt(list, seen, {
        label: sourceLabel && index === 0
          ? `${baseName} via ${nodeCommand} (${path.basename(sourceLabel)})`
          : `${baseName} via ${nodeCommand}`,
        command: nodeCommand,
        args: [script, ...OPENCODE_SERVE_ARGS],
        options: { ...baseOptions, shell: false },
        mode: "native",
        directory: this.vaultPath,
      });
    });
  }

  buildLaunchAttempts(resolved, runtimeHome) {
    const attempts = [];
    const seen = new Set();
    const strategy = this.normalizeLaunchStrategy(this.settings && this.settings.launchStrategy);
    const isWindowsArm64 = isWindowsPlatform() && String(process.arch || "").toLowerCase() === "arm64";
    const preferred = strategy === "auto" ? this.resolvePreferredLaunchProfile() : null;
    const baseEnv = { ...process.env, OPENCODE_HOME: runtimeHome };
    const baseOptions = {
      cwd: this.vaultPath,
      env: baseEnv,
    };
    const resolvedPath = String(resolved && resolved.path ? resolved.path : "").trim();
    const resolvedKind = String(resolved && resolved.kind ? resolved.kind : "").trim();
    const resolvedNodePath = String(resolved && resolved.nodePath ? resolved.nodePath : "").trim();
    const resolvedSourcePath = String(resolved && resolved.sourcePath ? resolved.sourcePath : "").trim();
    const forcedWsl = this.parseWslCliPath(resolvedPath);
    const configuredWslDistro = String(this.settings && this.settings.wslDistro ? this.settings.wslDistro : "").trim();
    const preferWslFirst = isWindowsPlatform()
      && strategy !== "native"
      && (Boolean(configuredWslDistro) || forcedWsl.useWsl || isWindowsArm64);
    const deferPreferredNative = Boolean(
      preferWslFirst
      && preferred
      && preferred.mode === "native",
    );

    if (preferred && !deferPreferredNative) {
      this.pushPreferredLaunchAttempt(attempts, seen, preferred, runtimeHome);
    }

    if (preferWslFirst) {
      this.pushWslAttempts(attempts, seen, runtimeHome, forcedWsl.distro || configuredWslDistro);
    }

    if (forcedWsl.useWsl) {
      if (strategy !== "native") {
        this.pushWslAttempts(attempts, seen, runtimeHome, forcedWsl.distro || configuredWslDistro);
      }
    } else if (resolvedPath) {
      if (strategy !== "wsl") {
        const wrapperScript = isWindowsPlatform() && isWindowsCommandWrapper(resolvedPath)
          ? resolveWindowsWrapperNodeScript(resolvedPath)
          : "";
        const nodeScriptPath = this.isNodeScriptLaunchPath(resolvedPath, resolvedKind)
          ? resolvedPath
          : wrapperScript;

        if (nodeScriptPath) {
          this.pushNodeScriptAttempts(
            attempts,
            seen,
            nodeScriptPath,
            baseOptions,
            resolvedNodePath,
            resolvedSourcePath || (wrapperScript ? resolvedPath : ""),
          );
        } else if (!(isWindowsPlatform() && isWindowsCommandWrapper(resolvedPath))) {
          this.pushLaunchAttempt(attempts, seen, {
            label: resolvedPath,
            command: resolvedPath,
            args: OPENCODE_SERVE_ARGS,
            options: { ...baseOptions, shell: false },
            mode: "native",
            directory: this.vaultPath,
          });
        }
      }
    }

    const allowAutoFallback = strategy !== "wsl"
      && Boolean(this.settings.autoDetectCli || !String(this.settings.cliPath || "").trim());
    if (allowAutoFallback) {
      if (isWindowsPlatform()) {
        this.pushLaunchAttempt(attempts, seen, {
          label: "opencode.exe (PATH)",
          command: "opencode.exe",
          args: OPENCODE_SERVE_ARGS,
          options: { ...baseOptions, shell: false },
          mode: "native",
          directory: this.vaultPath,
        });
        this.pushLaunchAttempt(attempts, seen, {
          label: "opencode (PATH)",
          command: "opencode",
          args: OPENCODE_SERVE_ARGS,
          options: { ...baseOptions, shell: false },
          mode: "native",
          directory: this.vaultPath,
        });
      } else {
        this.pushLaunchAttempt(attempts, seen, {
          label: "opencode (PATH)",
          command: "opencode",
          args: OPENCODE_SERVE_ARGS,
          options: { ...baseOptions, shell: false },
          mode: "native",
          directory: this.vaultPath,
        });
      }
    }

    if (deferPreferredNative && preferred) {
      this.pushPreferredLaunchAttempt(attempts, seen, preferred, runtimeHome);
    }

    if (isWindowsPlatform() && (strategy !== "native" || isWindowsArm64) && !preferWslFirst) {
      this.pushWslAttempts(attempts, seen, runtimeHome, configuredWslDistro);
    }

    return attempts;
  }

  async startProcessWithAttempt(attempt) {
    const launch = attempt && typeof attempt === "object" ? attempt : {};
    const label = String(launch.label || launch.command || "unknown");

    return new Promise((resolve, reject) => {
      let settled = false;
      let startupTimeout = null;
      const startupTimeoutMs = launch.mode === "wsl" ? WSL_STARTUP_TIMEOUT_MS : STARTUP_TIMEOUT_MS;
      let onOutput = null;
      let onStderr = null;
      let onError = null;
      let onExit = null;
      const outputTail = [];
      let detectedWslDataHome = "";
      let detectedWslUserHome = "";

      const finish = (error, url) => {
        if (settled) return;
        settled = true;
        if (startupTimeout) {
          clearTimeout(startupTimeout);
          startupTimeout = null;
        }

        if (this.process) {
          if (onOutput) {
            try {
              this.process.stdout.removeListener("data", onOutput);
            } catch {
            }
            try {
              this.process.stderr.removeListener("data", onStderr || onOutput);
            } catch {
            }
          }
          if (onError) {
            try {
              this.process.removeListener("error", onError);
            } catch {
            }
          }
          if (onExit) {
            try {
              this.process.removeListener("exit", onExit);
            } catch {
            }
          }
        }

        if (error) {
          this.cleanupProcessOnBootFailure();
          reject(error);
          return;
        }

        this.launchContext = {
          mode: launch.mode === "wsl" ? "wsl" : "native",
          directory: String(launch.directory || this.vaultPath),
          label,
          distro: String(launch.distro || "").trim(),
          wslHome: detectedWslDataHome,
          wslUserHome: detectedWslUserHome,
        };
        this.attachProcessExitMonitor();
        resolve(url);
      };

      try {
        this.process = spawn(launch.command, Array.isArray(launch.args) ? launch.args : [], launch.options || {});
      } catch (e) {
        finish(new Error(`无法启动 OpenCode 服务 (${label}): ${e instanceof Error ? e.message : String(e)}`));
        return;
      }

      const inspectOutput = (source, chunk) => {
        collectOutputTail(outputTail, source, chunk);
        const text = String(chunk || "");
        const dataHomeMatch = text.match(/\[opencode-assistant\]\s+WSL XDG_DATA_HOME=([^\r\n]+)/);
        if (dataHomeMatch && dataHomeMatch[1]) {
          detectedWslDataHome = String(dataHomeMatch[1]).trim();
        }
        const homeMatch = text.match(/\[opencode-assistant\]\s+WSL HOME=([^\r\n]+)/);
        if (homeMatch && homeMatch[1]) {
          detectedWslUserHome = String(homeMatch[1]).trim();
        }
        const match = text.match(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/i);
        if (match) {
          this.baseUrl = match[0];
          finish(null, this.baseUrl);
        }
      };
      onOutput = (chunk) => inspectOutput("stdout", chunk);
      onStderr = (chunk) => inspectOutput("stderr", chunk);

      onError = (err) => {
        const message = err instanceof Error ? err.message : String(err);
        finish(new Error(appendOutputHint(`无法启动 OpenCode 服务 (${label}): ${message}`, outputTail)));
      };

      onExit = (code) => {
        if (this.baseUrl) {
          this.clearProcessState();
          return;
        }
        const exitCode = Number(code);
        const armHint = exitCode === 3221225477
          ? "（Windows 0xC0000005：进程崩溃，常见于架构不匹配或运行时异常）"
          : "";
        finish(new Error(appendOutputHint(
          `OpenCode 服务提前退出 (${label})，退出码: ${String(code)}${armHint}`,
          outputTail,
        )));
      };

      this.process.stdout.on("data", onOutput);
      this.process.stderr.on("data", onStderr);
      this.process.on("error", onError);
      this.process.on("exit", onExit);

      startupTimeout = setTimeout(() => {
        if (!this.baseUrl) {
          finish(new Error(appendOutputHint(
            `等待 OpenCode 服务启动超时 (${label}, ${startupTimeoutMs}ms)`,
            outputTail,
          )));
        }
      }, startupTimeoutMs);
    });
  }

  async startWithFallbacks() {
    const runtimeHome = path.join(this.vaultPath, this.settings.opencodeHomeDir || ".opencode-runtime");
    fs.mkdirSync(runtimeHome, { recursive: true });

    const resolved = await this.resolveExecutable();
    const attempts = this.buildLaunchAttempts(resolved, runtimeHome);

    if (!attempts.length) {
      const hint = resolved && resolved.hint ? resolved.hint : "opencode 未找到";
      throw new Error(`无法启动 OpenCode 服务: ${hint}`);
    }

    const failed = [];
    for (const attempt of attempts) {
      try {
        const url = await this.startProcessWithAttempt(attempt);
        this.log(`opencode launch ok: ${attempt.label} -> ${url}`);
        this.notifyLaunchSuccess(attempt);
        return url;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        failed.push(`${attempt.label}: ${message}`);
        this.log(`opencode launch failed: ${attempt.label}: ${message}`);
      }
    }

    const hint = resolved && resolved.hint ? `\n提示: ${resolved.hint}` : "";
    throw new Error(`无法启动 OpenCode 服务，已尝试 ${attempts.length} 种方式:\n${failed.join("\n")}${hint}`);
  }

  clearProcessState() {
    this.process = null;
    this.baseUrl = "";
    this.bootPromise = null;
    this.processExitListener = null;
    this.wslDirectoryCache.clear();
    this.wslWorkspaceDir = "";
    this.wslUserHomeDir = "";
    this.wslRequestChain = Promise.resolve();
    this.launchContext = {
      mode: "native",
      directory: this.vaultPath,
      label: "",
      distro: "",
      wslHome: "",
      wslUserHome: "",
    };
  }

  cleanupProcessOnBootFailure() {
    if (this.processExitListener && this.process) {
      try {
        this.process.removeListener("exit", this.processExitListener);
      } catch {
      }
      this.processExitListener = null;
    }
    if (this.process) {
      try {
        this.process.kill();
      } catch {
      }
    }
    this.clearProcessState();
  }

  attachProcessExitMonitor() {
    if (!this.process) return;
    if (this.processExitListener) {
      try {
        this.process.removeListener("exit", this.processExitListener);
      } catch {
      }
    }
    this.processExitListener = () => {
      this.clearProcessState();
    };
    this.process.once("exit", this.processExitListener);
  }

  async ensureStarted() {
    if (this.baseUrl) return this.baseUrl;
    if (this.bootPromise) return this.bootPromise;

    this.bootPromise = this.startWithFallbacks().catch((e) => {
      this.bootPromise = null;
      throw e;
    });

    return this.bootPromise;
  }

  isWslSqliteLockError(status, detailText) {
    if (!this.launchContext || this.launchContext.mode !== "wsl") return false;
    if (!(Number(status) >= 500)) return false;
    const detail = String(detailText || "");
    return SQLITE_LOCK_RE.test(detail);
  }

  withWslRequestLock(task) {
    const run = typeof task === "function" ? task : async () => null;
    const chain = Promise.resolve(this.wslRequestChain)
      .catch(() => {})
      .then(() => run());
    this.wslRequestChain = chain.catch(() => {});
    return chain;
  }

  async request(method, endpoint, body, query = {}, signal, retryState = {}) {
    const state = {
      wslSqliteRetried: Boolean(retryState && retryState.wslSqliteRetried),
      wslQueued: Boolean(retryState && retryState.wslQueued),
      connectionRetried: Boolean(retryState && retryState.connectionRetried),
    };
    if (this.launchContext && this.launchContext.mode === "wsl" && !state.wslQueued) {
      return this.withWslRequestLock(() =>
        this.request(method, endpoint, body, query, signal, {
          ...state,
          wslQueued: true,
        }));
    }

    const baseUrl = await this.ensureStarted();
    const url = new URL(baseUrl + endpoint);

    for (const [k, v] of Object.entries(query || {})) {
      const value = k === "directory" ? this.normalizeDirectoryForService(v) : v;
      if (value !== undefined && value !== null && String(value).length > 0) {
        url.searchParams.set(k, String(value));
      }
    }
    let resp;
    try {
      resp = await nodeHttpRequestJson(
        url.toString(),
        method,
        body,
        this.settings.requestTimeoutMs,
        signal,
        { trace: (line) => this.log(line) },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!state.connectionRetried && looksLikeRetryableConnectionError(message)) {
        this.log(`request connection reset, restart service and retry once: ${message}`);
        this.cleanupProcessOnBootFailure();
        return this.request(method, endpoint, body, query, signal, {
          ...state,
          connectionRetried: true,
        });
      }
      const hint = `${this.buildWslDirectoryHint(message)}${this.buildWslSqliteHint(message)}`;
      throw new Error(`OpenCode 连接失败: ${message}${hint}`);
    }
    const text = resp.text;
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    if (resp.status < 200 || resp.status >= 300) {
      const detail = parsed ? JSON.stringify(parsed) : text;
      if (!state.wslSqliteRetried && this.isWslSqliteLockError(resp.status, detail) && this.useWslDataHomeFallback()) {
        this.cleanupProcessOnBootFailure();
        return this.request(method, endpoint, body, query, signal, {
          ...state,
          wslSqliteRetried: true,
        });
      }
      const hint = `${this.buildWslDirectoryHint(detail)}${this.buildWslSqliteHint(detail)}`;
      throw new Error(`OpenCode 请求失败 (${resp.status}): ${detail}${hint}`);
    }

    return parsed;
  }

  parseModel() {
    return parseModel(this.settings.defaultModel);
  }

  parseCommandModel() {
    return parseCommandModel(this.settings.defaultModel);
  }

  normalizeSessionStatus(candidate) {
    if (typeof candidate === "string") {
      const type = candidate.trim().toLowerCase();
      return type ? { type } : null;
    }
    if (!candidate || typeof candidate !== "object") return null;

    if (candidate.status && typeof candidate.status === "object" && candidate.status !== candidate) {
      const nested = this.normalizeSessionStatus(candidate.status);
      if (nested) return nested;
    }
    if (candidate.state && typeof candidate.state === "object" && candidate.state !== candidate) {
      const nested = this.normalizeSessionStatus(candidate.state);
      if (nested) return nested;
    }

    const next = { ...candidate };
    if (!next.type && typeof next.status === "string") next.type = next.status;
    if (!next.type && typeof next.state === "string") next.type = next.state;
    if (typeof next.type === "string") next.type = next.type.trim().toLowerCase();
    return next;
  }

  normalizeMessageEnvelope(envelope, depth = 0) {
    if (depth > 3) return null;
    const item = envelope && typeof envelope === "object" ? envelope : null;
    if (!item) return null;

    if (item.info && typeof item.info === "object") {
      return {
        info: item.info,
        parts: Array.isArray(item.parts) ? item.parts : [],
      };
    }

    if (item.message && typeof item.message === "object") {
      return this.normalizeMessageEnvelope(item.message, depth + 1);
    }

    if (item.payload && typeof item.payload === "object") {
      return this.normalizeMessageEnvelope(item.payload, depth + 1);
    }

    const looksLikeInfo = Boolean(
      item.id
      || item.role
      || item.sessionID
      || item.sessionId
      || item.parentID
      || item.modelID,
    );
    if (looksLikeInfo) {
      return {
        info: item,
        parts: Array.isArray(item.parts) ? item.parts : [],
      };
    }
    return null;
  }

  extractMessageList(payload) {
    if (Array.isArray(payload)) {
      return payload
        .map((item) => this.normalizeMessageEnvelope(item))
        .filter(Boolean);
    }
    if (!payload || typeof payload !== "object") return [];

    const arrayCandidates = [
      payload.messages,
      payload.items,
      payload.list,
      payload.results,
      payload.result,
      payload.data,
      payload.message,
    ];
    for (const candidate of arrayCandidates) {
      if (!Array.isArray(candidate)) continue;
      return candidate
        .map((item) => this.normalizeMessageEnvelope(item))
        .filter(Boolean);
    }

    const singleCandidates = [
      payload.message,
      payload.data,
      payload.item,
      payload.result,
      payload.payload,
      payload,
    ];
    for (const candidate of singleCandidates) {
      const normalized = this.normalizeMessageEnvelope(candidate);
      if (normalized) return [normalized];
    }
    return [];
  }

  createMessageListFetchState(options = {}) {
    const fallbackCooldownMs = Number(options.fallbackCooldownMs);
    return {
      useUnbounded: Boolean(options.useUnbounded),
      lastFallbackAt: 0,
      fallbackCooldownMs: Number.isFinite(fallbackCooldownMs) && fallbackCooldownMs >= 0
        ? fallbackCooldownMs
        : 1500,
    };
  }

  async fetchSessionMessages(sessionId, options = {}) {
    const signal = options.signal;
    const startedAt = Number(options.startedAt || 0);
    const requireRecentTail = Boolean(options.requireRecentTail);
    const state = options.state && typeof options.state === "object" ? options.state : null;
    const rawLimit = Number(options.limit || 50);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.max(1, Math.floor(rawLimit)) : 50;
    const shouldPickLatest = startedAt > 0 || requireRecentTail;

    const fetchList = async (query) => {
      const listRes = await this.request(
        "GET",
        `/session/${encodeURIComponent(sessionId)}/message`,
        undefined,
        query,
        signal,
      );
      return this.extractMessageList(listRes && listRes.data ? listRes.data : listRes);
    };

    const pickLatest = (messages) => {
      if (!shouldPickLatest) return null;
      return this.findLatestAssistantMessage(messages, startedAt);
    };

    if (state && state.useUnbounded) {
      const unbounded = await fetchList({ directory: this.vaultPath });
      return {
        list: unbounded,
        latest: pickLatest(unbounded),
        strategy: "unbounded",
      };
    }

    const limited = await fetchList({ directory: this.vaultPath, limit });
    const limitedLatest = pickLatest(limited);
    const needUnbounded =
      limited.length >= limit
      && (requireRecentTail || (startedAt > 0 && !limitedLatest));

    if (!needUnbounded) {
      return {
        list: limited,
        latest: limitedLatest,
        strategy: "limited",
      };
    }

    if (state && state.fallbackCooldownMs > 0 && state.lastFallbackAt > 0) {
      const sinceLastFallback = Date.now() - Number(state.lastFallbackAt || 0);
      if (sinceLastFallback < state.fallbackCooldownMs) {
        return {
          list: limited,
          latest: limitedLatest,
          strategy: "limited-cooldown",
        };
      }
    }

    if (state) state.lastFallbackAt = Date.now();

    const unbounded = await fetchList({ directory: this.vaultPath });
    const unboundedLatest = pickLatest(unbounded);
    const shouldPreferUnbounded = Boolean(
      unbounded.length > limited.length
      || (!limitedLatest && unboundedLatest),
    );

    if (state && shouldPreferUnbounded) {
      state.useUnbounded = true;
      this.log(`message list switched to unbounded fetch session=${sessionId} limited=${limited.length} full=${unbounded.length}`);
    }

    return shouldPreferUnbounded
      ? { list: unbounded, latest: unboundedLatest, strategy: "unbounded" }
      : { list: limited, latest: limitedLatest, strategy: "limited" };
  }

  async getSessionStatus(sessionId, signal) {
    try {
      const res = await this.request("GET", "/session/status", undefined, { directory: this.vaultPath }, signal);
      const payload = res && res.data ? res.data : res;
      if (!payload || typeof payload !== "object") return null;

      if (Object.prototype.hasOwnProperty.call(payload, sessionId)) {
        const normalized = this.normalizeSessionStatus(payload[sessionId]);
        if (normalized) return normalized;
      }

      if (payload.sessions && typeof payload.sessions === "object"
        && Object.prototype.hasOwnProperty.call(payload.sessions, sessionId)) {
        const normalized = this.normalizeSessionStatus(payload.sessions[sessionId]);
        if (normalized) return normalized;
      }

      if (Array.isArray(payload)) {
        if (!payload.length) return { type: "idle" };
        const row = payload.find((item) => {
          if (!item || typeof item !== "object") return false;
          return item.id === sessionId || item.sessionID === sessionId || item.sessionId === sessionId;
        });
        const normalized = this.normalizeSessionStatus(row);
        if (normalized) return normalized;
      }

      if (payload.sessionID === sessionId || payload.sessionId === sessionId || payload.id === sessionId) {
        const normalized = this.normalizeSessionStatus(payload);
        if (normalized) return normalized;
      }

      const normalized = this.normalizeSessionStatus(payload);
      if (normalized && (normalized.type || normalized.message || normalized.reason || normalized.error)) {
        return normalized;
      }

      const hasKnownRootShape = Boolean(
        Object.prototype.hasOwnProperty.call(payload, "type")
        || Object.prototype.hasOwnProperty.call(payload, "status")
        || Object.prototype.hasOwnProperty.call(payload, "state")
        || Object.prototype.hasOwnProperty.call(payload, "message")
        || Object.prototype.hasOwnProperty.call(payload, "error")
        || Object.prototype.hasOwnProperty.call(payload, "reason")
        || Object.prototype.hasOwnProperty.call(payload, "id")
        || Object.prototype.hasOwnProperty.call(payload, "sessionID")
        || Object.prototype.hasOwnProperty.call(payload, "sessionId"),
      );
      if (!hasKnownRootShape) {
        return { type: "idle" };
      }

      return null;
    } catch {
      return null;
    }
  }

  findLatestAssistantMessage(messages, startedAt) {
    return findLatestAssistantMessage(messages, startedAt);
  }

  async ensureAuth() {
    if (this.settings.authMode !== "custom-api-key") return;
    if (!this.settings.customApiKey.trim()) throw new Error("当前是自定义 API Key 模式，但 API Key 为空");

    const providerId = this.settings.customProviderId.trim();
    await this.setProviderApiKeyAuth({
      providerID: providerId,
      key: this.settings.customApiKey.trim(),
    });

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

  async listProviders() {
    const res = await this.request("GET", "/provider", undefined, { directory: this.vaultPath });
    const payload = res && res.data ? res.data : res || {};
    const all = Array.isArray(payload.all) ? payload.all : [];
    const connected = Array.isArray(payload.connected) ? payload.connected : [];
    const defaults = payload && typeof payload.default === "object" && payload.default ? payload.default : {};
    return {
      all,
      connected,
      default: defaults,
    };
  }

  async listProviderAuthMethods() {
    const res = await this.request("GET", "/provider/auth", undefined, { directory: this.vaultPath });
    const payload = res && res.data ? res.data : res || {};
    return payload && typeof payload === "object" ? payload : {};
  }

  async authorizeProviderOauth(options = {}) {
    const providerID = String(options.providerID || "").trim();
    if (!providerID) throw new Error("providerID 不能为空");

    const method = Number(options.method);
    if (!Number.isFinite(method) || method < 0) throw new Error("OAuth method 无效");

    const res = await this.request(
      "POST",
      `/provider/${encodeURIComponent(providerID)}/oauth/authorize`,
      { method: Number(method) },
      { directory: this.vaultPath },
      options.signal,
    );
    return res && res.data ? res.data : res;
  }

  async completeProviderOauth(options = {}) {
    const providerID = String(options.providerID || "").trim();
    if (!providerID) throw new Error("providerID 不能为空");

    const method = Number(options.method);
    if (!Number.isFinite(method) || method < 0) throw new Error("OAuth method 无效");

    const body = { method: Number(method) };
    const code = String(options.code || "").trim();
    if (code) body.code = code;

    const res = await this.request(
      "POST",
      `/provider/${encodeURIComponent(providerID)}/oauth/callback`,
      body,
      { directory: this.vaultPath },
      options.signal,
    );
    const payload = res && Object.prototype.hasOwnProperty.call(res, "data") ? res.data : res;
    return payload === undefined ? true : Boolean(payload);
  }

  async setProviderApiKeyAuth(options = {}) {
    const providerID = String(options.providerID || "").trim();
    if (!providerID) throw new Error("providerID 不能为空");

    const key = String(options.key || "").trim();
    if (!key) throw new Error("API Key 不能为空");

    await this.request(
      "PUT",
      `/auth/${encodeURIComponent(providerID)}`,
      { type: "api", key },
      undefined,
      options.signal,
    );
    return true;
  }

  async clearProviderAuth(options = {}) {
    const providerID = String(options.providerID || "").trim();
    if (!providerID) throw new Error("providerID 不能为空");

    await this.request(
      "DELETE",
      `/auth/${encodeURIComponent(providerID)}`,
      undefined,
      undefined,
      options.signal,
    );
    return true;
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

  async resolveCommandForEndpoint(commandName) {
    const list = await this.listCommands();
    const names = availableCommandSet(list);
    return resolveCommandFromSet(commandName, names);
  }

  getFinalizeTimeoutConfig() {
    const configured = Math.max(15000, Number(this.settings.requestTimeoutMs) || 120000);
    const isWsl = this.launchContext && this.launchContext.mode === "wsl";
    const quietTimeoutMs = Math.min(configured, isWsl ? 90000 : 90000);
    const maxTotalMs = Math.min(
      Math.max(quietTimeoutMs * 2, 90000),
      isWsl ? 180000 : 180000,
    );
    return { quietTimeoutMs, maxTotalMs };
  }

  async finalizeAssistantResponse(sessionId, responsePayload, startedAt, signal, preferredMessageId = "") {
    const data = responsePayload && responsePayload.data ? responsePayload.data : responsePayload;
    const initialMessageId = preferredMessageId || (data && data.info ? data.info.id : "");
    const initialPayload = extractAssistantPayloadFromEnvelope(data);
    const timeoutCfg = this.getFinalizeTimeoutConfig();
    const quietTimeoutMs = timeoutCfg.quietTimeoutMs;
    const messageListFetchState = this.createMessageListFetchState();

    const polled = await pollAssistantPayload({
      initialMessageId,
      initialPayload,
      signal,
      quietTimeoutMs,
      maxTotalMs: timeoutCfg.maxTotalMs,
      sleep,
      getByMessageId: async (messageId, requestSignal) => {
        const msgRes = await this.request(
          "GET",
          `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`,
          undefined,
          { directory: this.vaultPath },
          requestSignal,
        );
        const messagePayload = this.normalizeMessageEnvelope(msgRes && msgRes.data ? msgRes.data : msgRes);
        const role =
          messagePayload && messagePayload.info && typeof messagePayload.info.role === "string"
            ? messagePayload.info.role
            : "";
        if (role && role !== "assistant") {
          return { payload: null, completed: false, messageId: "" };
        }
        const completedAt =
          messagePayload && messagePayload.info && messagePayload.info.time
            ? Number(messagePayload.info.time.completed || 0)
            : 0;
        return {
          payload: messagePayload ? extractAssistantPayloadFromEnvelope(messagePayload) : null,
          completed: completedAt > 0,
          messageId,
        };
      },
      getLatest: async (requestSignal) => {
        const fetched = await this.fetchSessionMessages(sessionId, {
          signal: requestSignal,
          limit: 50,
          startedAt,
          state: messageListFetchState,
        });
        const latest = fetched.latest || this.findLatestAssistantMessage(fetched.list, startedAt);
        if (!latest) return null;
        const completedAt =
          latest && latest.info && latest.info.time
            ? Number(latest.info.time.completed || 0)
            : 0;
        const createdAt =
          latest && latest.info && latest.info.time
            ? Number(latest.info.time.created || 0)
            : 0;
        return {
          payload: extractAssistantPayloadFromEnvelope(latest),
          completed: completedAt > 0,
          messageId: latest && latest.info ? latest.info.id : "",
          createdAt,
        };
      },
      getSessionStatus: (requestSignal) => this.getSessionStatus(sessionId, requestSignal),
    });

    const hadRenderablePayload = hasRenderablePayload(polled.payload);
    if (polled.timedOut && !hadRenderablePayload) {
      const statusText = formatSessionStatusText(polled.lastStatus);
      const activeModel = String(this.settings && this.settings.defaultModel ? this.settings.defaultModel : "").trim();
      const modelText = activeModel ? `模型 ${activeModel}` : "当前模型";
      throw new Error(`${modelText} 长时间无响应，可能不受当前账号/API Key 支持（session.status=${statusText}）。请切换模型或检查登录配置。`);
    }

    let payload = await ensureRenderablePayload({
      payload: polled.payload,
      lastStatus: polled.lastStatus,
      getSessionStatus: (requestSignal) => this.getSessionStatus(sessionId, requestSignal),
      signal,
    });

    if (polled.timedOut) {
      this.log(`finalize timeout ${JSON.stringify({
        sessionId,
        messageId: polled.messageId,
        idleMs: Date.now() - Number(polled.lastProgressAt || polled.startedAt || Date.now()),
        quietTimeoutMs: polled.quietTimeoutMs,
        maxTotalMs: polled.maxTotalMs,
        textLen: String(payload.text || "").length,
        reasoningLen: String(payload.reasoning || "").length,
        blockCount: Array.isArray(payload.blocks) ? payload.blocks.length : 0,
        terminal: hasTerminalPayload(payload),
        inProgress: payloadLooksInProgress(payload),
      })}`);
    }

    if (isIntermediateToolCallPayload(payload) && normalizedRenderableText(payload.text || "").length <= 1) {
      payload = { ...payload, text: "" };
    }

    return {
      messageId: polled.messageId || "",
      text: payload.text || "",
      reasoning: payload.reasoning || "",
      meta: payload.meta || "",
      blocks: payload.blocks || [],
      completed: Boolean(polled.completed) || (hasTerminalPayload(payload) && !payloadLooksInProgress(payload)),
    };
  }

  async streamAssistantFromPolling(sessionId, startedAt, signal, handlers) {
    const timeoutCfg = this.getFinalizeTimeoutConfig();
    const quietTimeoutMs = timeoutCfg.quietTimeoutMs;
    const messageListFetchState = this.createMessageListFetchState();
    const polled = await pollAssistantPayload({
      signal,
      quietTimeoutMs,
      maxTotalMs: timeoutCfg.maxTotalMs,
      sleep,
      requireTerminal: false,
      onToken: handlers && handlers.onToken,
      onReasoning: handlers && handlers.onReasoning,
      onBlocks: handlers && handlers.onBlocks,
      getLatest: async (requestSignal) => {
        const fetched = await this.fetchSessionMessages(sessionId, {
          signal: requestSignal,
          limit: 50,
          startedAt,
          state: messageListFetchState,
        });
        const latest = fetched.latest || this.findLatestAssistantMessage(fetched.list, startedAt);
        if (!latest) return null;
        const completedAt = latest && latest.info && latest.info.time ? Number(latest.info.time.completed || 0) : 0;
        const createdAt = latest && latest.info && latest.info.time ? Number(latest.info.time.created || 0) : 0;
        return {
          payload: extractAssistantPayloadFromEnvelope(latest),
          completed: completedAt > 0,
          messageId: latest && latest.info ? latest.info.id : "",
          createdAt,
        };
      },
      getSessionStatus: (requestSignal) => this.getSessionStatus(sessionId, requestSignal),
    });

    return {
      messageId: polled.messageId || "",
      text: polled.payload && polled.payload.text ? polled.payload.text : "",
      reasoning: polled.payload && polled.payload.reasoning ? polled.payload.reasoning : "",
      meta: polled.payload && polled.payload.meta ? polled.payload.meta : "",
      blocks: polled.payload && Array.isArray(polled.payload.blocks) ? polled.payload.blocks : [],
      completed: Boolean(polled.completed),
    };
  }

  async streamAssistantFromEvents(sessionId, startedAt, signal, handlers) {
    const baseUrl = await this.ensureStarted();
    const eventUrl = new URL(baseUrl + "/event");
    const expectedDirectory = this.normalizeDirectoryForService(this.vaultPath) || this.vaultPath;
    eventUrl.searchParams.set("directory", expectedDirectory);
    const reducer = createTransportEventReducer({
      sessionId,
      startedAt,
      onToken: handlers && handlers.onToken,
      onReasoning: handlers && handlers.onReasoning,
      onBlocks: handlers && handlers.onBlocks,
      onPermissionRequest: (permission, permissionId) => {
        if (!handlers || typeof handlers.onPermissionRequest !== "function") return;
        Promise.resolve(handlers.onPermissionRequest(permission || {}))
          .then((response) => {
            if (!response || !["once", "always", "reject"].includes(response)) return;
            return this.replyPermission({
              sessionId,
              permissionId,
              response,
              signal,
            });
          })
          .catch((e) => {
            this.log(`permission handler failed: ${e instanceof Error ? e.message : String(e)}`);
          });
      },
      onQuestionRequest: handlers && handlers.onQuestionRequest,
      onQuestionResolved: handlers && handlers.onQuestionResolved,
      onPromptAppend: handlers && handlers.onPromptAppend,
      onToast: handlers && handlers.onToast,
      permissionEventTypes: ["permission.updated", "permission.asked"],
    });

    await nodeHttpRequestSse(
      eventUrl.toString(),
      Math.max(3000, Number(this.settings.requestTimeoutMs) || 120000),
      signal,
      {
        onEvent: (raw) => {
          const root = raw && typeof raw === "object" ? raw : null;
          if (root && typeof root.directory === "string" && root.directory) {
            const eventDir = String(root.directory || "").trim();
            const originDir = String(this.vaultPath || "").trim();
            if (eventDir !== expectedDirectory && eventDir !== originDir) return;
          }

          const event = root && root.payload && typeof root.payload === "object" ? root.payload : root;
          if (!event || typeof event !== "object") return;
          reducer.consume(event);
        },
        shouldStop: () => reducer.isDone(),
      },
      { trace: (line) => this.log(line) },
    );

    return reducer.snapshot();
  }

  isUnknownStatusFallbackText(text) {
    const value = String(text || "").trim();
    if (!value) return false;
    return /^\(无文本返回：session\.status=/i.test(value);
  }

  async trySyncMessageRecovery(sessionId, messageBody, signal, streamedMessageId = "") {
    const body = messageBody && typeof messageBody === "object" ? { ...messageBody } : null;
    if (!body || !Array.isArray(body.parts) || !body.parts.length) return null;
    const messageListFetchState = this.createMessageListFetchState();

    const placeholderId = String(streamedMessageId || "").trim();
    let parentMessageId = "";

    if (placeholderId) {
      try {
        const placeholderRes = await this.request(
          "GET",
          `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(placeholderId)}`,
          undefined,
          { directory: this.vaultPath },
          signal,
        );
        const placeholder = this.normalizeMessageEnvelope(
          placeholderRes && placeholderRes.data ? placeholderRes.data : placeholderRes,
        );
        const info = placeholder && placeholder.info && typeof placeholder.info === "object" ? placeholder.info : null;
        if (info && info.role === "assistant" && typeof info.parentID === "string" && info.parentID.trim()) {
          parentMessageId = info.parentID.trim();
        }
      } catch (error) {
        this.log(`sync recovery inspect failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (parentMessageId && !body.messageID) {
      body.messageID = parentMessageId;
    }

    if (!body.messageID) {
      try {
        const fetched = await this.fetchSessionMessages(sessionId, {
          signal,
          limit: 50,
          requireRecentTail: true,
          state: messageListFetchState,
        });
        const listPayload = Array.isArray(fetched.list) ? fetched.list : [];
        let latestUser = null;
        let latestUserCreated = 0;
        for (const item of listPayload) {
          if (!item || typeof item !== "object") continue;
          const info = item.info && typeof item.info === "object" ? item.info : null;
          if (!info || info.role !== "user" || typeof info.id !== "string" || !info.id.trim()) continue;
          const time = info.time && typeof info.time === "object" ? info.time : {};
          const created = Number(time.created || info.created || info.updated || 0);
          if (created >= latestUserCreated) {
            latestUserCreated = created;
            latestUser = info.id.trim();
          }
        }
        if (latestUser) {
          body.messageID = latestUser;
        }
      } catch (error) {
        this.log(`sync recovery user-anchor failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const pickAssistantEnvelope = (items, anchorMessageId = "") => {
      const list = Array.isArray(items) ? items : [];
      if (!list.length) return null;
      const anchor = String(anchorMessageId || "").trim();
      if (anchor) {
        const anchored = list
          .filter((row) => {
            const info = row && row.info && typeof row.info === "object" ? row.info : null;
            return Boolean(
              info
              && typeof info.parentID === "string"
              && info.parentID.trim()
              && info.parentID.trim() === anchor,
            );
          })
          .sort((a, b) => {
            const ai = a && a.info && typeof a.info === "object" ? a.info : {};
            const bi = b && b.info && typeof b.info === "object" ? b.info : {};
            const at = Number((ai.time && ai.time.created) || ai.created || 0);
            const bt = Number((bi.time && bi.time.created) || bi.created || 0);
            return bt - at;
          });
        if (anchored.length) return anchored[0];
      }
      return this.findLatestAssistantMessage(list, 0);
    };

    try {
      const syncRes = await this.request(
        "POST",
        `/session/${encodeURIComponent(sessionId)}/message`,
        body,
        { directory: this.vaultPath },
        signal,
      );
      const raw = syncRes && syncRes.data ? syncRes.data : syncRes;

      const direct = this.normalizeMessageEnvelope(raw);
      if (
        direct
        && direct.info
        && typeof direct.info === "object"
        && (direct.info.role === "assistant" || direct.info.type === "assistant" || direct.info.error)
      ) {
        const payload = extractAssistantPayloadFromEnvelope(direct);
        return {
          messageId: direct.info && direct.info.id ? String(direct.info.id) : placeholderId,
          text: String(payload.text || ""),
          reasoning: String(payload.reasoning || ""),
          meta: String(payload.meta || ""),
          blocks: Array.isArray(payload.blocks) ? payload.blocks : [],
          completed: true,
        };
      }

      const fromResponseList = pickAssistantEnvelope(this.extractMessageList(raw), body.messageID);
      if (fromResponseList) {
        const payload = extractAssistantPayloadFromEnvelope(fromResponseList);
        return {
          messageId: fromResponseList.info && fromResponseList.info.id
            ? String(fromResponseList.info.id)
            : placeholderId,
          text: String(payload.text || ""),
          reasoning: String(payload.reasoning || ""),
          meta: String(payload.meta || ""),
          blocks: Array.isArray(payload.blocks) ? payload.blocks : [],
          completed: true,
        };
      }

      for (let i = 0; i < 6; i += 1) {
        if (signal && signal.aborted) break;
        await sleep(220);
        const fetched = await this.fetchSessionMessages(sessionId, {
          signal,
          limit: 50,
          requireRecentTail: true,
          state: messageListFetchState,
        });
        const listPayload = Array.isArray(fetched.list) ? fetched.list : [];
        const envelope = pickAssistantEnvelope(listPayload, body.messageID);
        if (!envelope) continue;
        const payload = extractAssistantPayloadFromEnvelope(envelope);
        return {
          messageId: envelope.info && envelope.info.id ? String(envelope.info.id) : placeholderId,
          text: String(payload.text || ""),
          reasoning: String(payload.reasoning || ""),
          meta: String(payload.meta || ""),
          blocks: Array.isArray(payload.blocks) ? payload.blocks : [],
          completed: true,
        };
      }
      return null;
    } catch (error) {
      this.log(`sync recovery failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async reconcileAssistantResponseQuick(sessionId, currentPayload, startedAt, signal, preferredMessageId = "") {
    let merged = currentPayload && typeof currentPayload === "object"
      ? { ...currentPayload }
      : { messageId: "", text: "", reasoning: "", meta: "", blocks: [], completed: false };
    const messageIdHint = String(
      preferredMessageId
      || (merged && typeof merged.messageId === "string" ? merged.messageId : ""),
    ).trim();

    if (messageIdHint) {
      try {
        const msgRes = await this.request(
          "GET",
          `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageIdHint)}`,
          undefined,
          { directory: this.vaultPath },
          signal,
        );
        const messagePayload = this.normalizeMessageEnvelope(msgRes && msgRes.data ? msgRes.data : msgRes);
        const role =
          messagePayload && messagePayload.info && typeof messagePayload.info.role === "string"
            ? messagePayload.info.role
            : "";
        if (!role || role === "assistant") {
          const payload = messagePayload ? extractAssistantPayloadFromEnvelope(messagePayload) : null;
          if (payload) {
            const completedAt =
              messagePayload && messagePayload.info && messagePayload.info.time
                ? Number(messagePayload.info.time.completed || 0)
                : 0;
            merged = chooseRicherResponse(merged, {
              messageId: messageIdHint,
              text: String(payload.text || ""),
              reasoning: String(payload.reasoning || ""),
              meta: String(payload.meta || ""),
              blocks: Array.isArray(payload.blocks) ? payload.blocks : [],
              completed: completedAt > 0,
            });
          }
        }
      } catch (error) {
        this.log(`quick reconcile by-id failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      const fetched = await this.fetchSessionMessages(sessionId, {
        signal,
        limit: 20,
        startedAt,
        requireRecentTail: true,
        state: this.createMessageListFetchState(),
      });
      const latest = fetched.latest || this.findLatestAssistantMessage(fetched.list, startedAt);
      if (latest) {
        const payload = extractAssistantPayloadFromEnvelope(latest);
        const completedAt =
          latest && latest.info && latest.info.time
            ? Number(latest.info.time.completed || 0)
            : 0;
        merged = chooseRicherResponse(merged, {
          messageId: latest && latest.info && latest.info.id ? String(latest.info.id) : messageIdHint,
          text: String(payload.text || ""),
          reasoning: String(payload.reasoning || ""),
          meta: String(payload.meta || ""),
          blocks: Array.isArray(payload.blocks) ? payload.blocks : [],
          completed: completedAt > 0,
        });
      }
    } catch (error) {
      this.log(`quick reconcile latest failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return merged;
  }

  async sendMessage(options) {
    this.log(`sendMessage start ${JSON.stringify({
      sessionId: options.sessionId,
      transport: "compat",
      streaming: Boolean(this.settings.enableStreaming),
    })}`);
    await this.ensureAuth();
    const startedAt = Date.now();

    const model = this.parseModel();
    const commandModel = this.parseCommandModel();
    const parsedCommand = this.parseSlashCommand(options.prompt);
    const resolvedCommand = parsedCommand ? await this.resolveCommandForEndpoint(parsedCommand.command) : { use: false, command: "" };
    const isCommandRequest = Boolean(parsedCommand && resolvedCommand.use);
    if (isCommandRequest) {
      this.log(`compat command route ${JSON.stringify({
        sessionId: options.sessionId,
        command: resolvedCommand.command,
      })}`);
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
      const streamWaitMs = Math.max(
        20000,
        Math.min(60000, Math.floor((Number(this.settings.requestTimeoutMs) || 120000) / 2)),
      );
      let streamTimeoutHandle = null;
      const streamTimeoutPromise = new Promise((resolve) => {
        streamTimeoutHandle = setTimeout(() => {
          this.log(`event stream soft-timeout (${streamWaitMs}ms), fallback to polling`);
          linked.controller.abort();
          resolve(null);
        }, streamWaitMs);
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
        streamed = await Promise.race([eventStreamPromise, streamTimeoutPromise]);
        if (streamTimeoutHandle) clearTimeout(streamTimeoutHandle);
      } finally {
        if (streamTimeoutHandle) clearTimeout(streamTimeoutHandle);
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
      finalized = streamed || {
        messageId: "", text: "", reasoning: "", meta: "", blocks: [], completed: false,
      };
      const streamedMessageId = String(finalized && finalized.messageId ? finalized.messageId : "").trim();
      const streamedHasRenderable = hasRenderablePayload(finalized);
      if (!streamedMessageId && !streamedHasRenderable) {
        const status = await this.getSessionStatus(options.sessionId, options.signal);
        const statusText = formatSessionStatusText(status);
        const activeModel = String(this.settings && this.settings.defaultModel ? this.settings.defaultModel : "").trim();
        const modelText = activeModel ? `模型 ${activeModel}` : "当前模型";
        if (sessionStatusLooksAuthFailure(status)) {
          throw new Error(`${modelText} 鉴权失败（session.status=${statusText}）。请检查 Provider 登录或 API Key。`);
        }
        if (!isCommandRequest) {
          const recovered = await this.trySyncMessageRecovery(
            options.sessionId,
            messageBody,
            options.signal,
            streamedMessageId,
          );
          if (recovered && hasRenderablePayload(recovered)) {
            finalized = chooseRicherResponse(finalized, recovered);
          }
        }
        if (!hasRenderablePayload(finalized)) {
          try {
            const fetched = await this.fetchSessionMessages(options.sessionId, {
              signal: options.signal,
              limit: 20,
              requireRecentTail: true,
            });
            const listPayload = Array.isArray(fetched.list) ? fetched.list : [];
            const latestErrorEnvelope = [...listPayload]
              .reverse()
              .find((item) => {
                const info = item && item.info && typeof item.info === "object" ? item.info : null;
                return Boolean(info && info.error);
              }) || null;
            if (latestErrorEnvelope) {
              const info = latestErrorEnvelope.info && typeof latestErrorEnvelope.info === "object"
                ? latestErrorEnvelope.info
                : {};
              const err = extractErrorText(info.error);
              if (err) {
                finalized = chooseRicherResponse(finalized, {
                  messageId: info && info.id ? String(info.id) : streamedMessageId,
                  text: `模型返回错误：${err}`,
                  reasoning: "",
                  meta: err,
                  blocks: [],
                  completed: true,
                });
              }
            }
            const tail = listPayload
              .slice(-5)
              .map((item) => {
                const info = item && item.info && typeof item.info === "object" ? item.info : {};
                const role = String(info.role || info.type || "unknown");
                const id = String(info.id || "");
                const t = info.time && typeof info.time === "object" ? info.time : {};
                const created = Number(t.created || info.created || 0);
                const hasError = info && info.error ? ":error" : "";
                return `${role}:${id || "-"}:${created || 0}${hasError}`;
              })
              .join(", ");
            this.log(`no-renderable-after-async session=${options.sessionId} status=${statusText} messageCount=${listPayload.length} tail=[${tail}]`);
          } catch (error) {
            this.log(`no-renderable-after-async inspect failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (!hasRenderablePayload(finalized) && status && status.type === "idle") {
          throw new Error(`${modelText} 未返回可用消息（session.status=${statusText}）。请切换模型或检查登录配置。`);
        }
      }
      finalized = await this.reconcileAssistantResponseQuick(
        options.sessionId,
        finalized,
        startedAt,
        options.signal,
        streamedMessageId,
      );

      const strictFinalizeRequired = !hasTerminalPayload(finalized)
        || payloadLooksInProgress(finalized)
        || !Boolean(finalized && finalized.completed);
      if (strictFinalizeRequired) {
        try {
          const fetchedFinal = await this.finalizeAssistantResponse(
            options.sessionId,
            null,
            startedAt,
            options.signal,
            streamedMessageId,
          );
          const currentText = finalized && typeof finalized === "object" ? String(finalized.text || "") : "";
          const nextText = fetchedFinal && typeof fetchedFinal === "object" ? String(fetchedFinal.text || "") : "";
          const shouldKeepCurrent =
            hasRenderablePayload(finalized)
            && !this.isUnknownStatusFallbackText(currentText)
            && this.isUnknownStatusFallbackText(nextText);
          if (!shouldKeepCurrent) {
            finalized = chooseRicherResponse(finalized, fetchedFinal);
          }
        } catch (error) {
          if (!isCommandRequest) {
            const recovered = await this.trySyncMessageRecovery(
              options.sessionId,
              messageBody,
              options.signal,
              streamedMessageId,
            );
            if (recovered && hasRenderablePayload(recovered) && !payloadLooksInProgress(recovered)) {
              finalized = chooseRicherResponse(finalized, recovered);
            } else {
              throw error;
            }
          } else {
            throw error;
          }
        }
      }

      if (!isCommandRequest && this.isUnknownStatusFallbackText(finalized && finalized.text)) {
        const recovered = await this.trySyncMessageRecovery(
          options.sessionId,
          messageBody,
          options.signal,
          streamedMessageId,
        );
        if (recovered && hasRenderablePayload(recovered)) {
          finalized = chooseRicherResponse(finalized, recovered);
        }
      }
    } else {
      finalized = await this.finalizeAssistantResponse(options.sessionId, res, startedAt, options.signal);
    }

    if (payloadLooksInProgress(finalized)) {
      throw new Error("模型响应未完成且已超时，请切换模型或检查该 Provider 鉴权。");
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

    this.log(`sendMessage done ${JSON.stringify({
      sessionId: options.sessionId,
      hasText: Boolean(normalizedRenderableText(text)),
      textLen: text ? text.length : 0,
      normalizedTextLen: normalizedRenderableText(text).length,
      reasoningLen: reasoning ? reasoning.length : 0,
      blockCount: blocks.length,
      messageId,
    })}`);
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

    try {
      await this.request(
        "PATCH",
        "/config",
        {
          model: modelID,
        },
        { directory: this.vaultPath },
        options.signal,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isConfigMissing = /config\.json/i.test(message) && /enoent|no such file|cannot find/i.test(message);
      if (!isConfigMissing) throw error;
      // Some environments (e.g. WSL + remapped drive) don't expose a writable config.json path.
      // Keep model switch effective via per-request model command and plugin-level persistence.
      this.log(`setDefaultModel fallback (config missing): ${message}`);
      return { ok: true, model: modelID, persisted: false };
    }

    return { ok: true, model: modelID };
  }

  async switchModel(options) {
    return this.setDefaultModel(options);
  }

  parseSlashCommand(prompt) {
    return parseSlashCommand(prompt);
  }

  async stop() {
    if (this.process) this.process.kill();
    this.clearProcessState();
  }
}


module.exports = { CompatTransport };
