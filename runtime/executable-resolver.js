const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { rt } = (() => {
  try {
    return require("./runtime-locale-state");
  } catch (_e) {
    return {
      rt: (_zh, en, params = {}) => String(en || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, k) => {
        const value = params[k];
        return value === undefined || value === null ? "" : String(value);
      }),
    };
  }
})();

function expandHome(p) {
  if (!p) return p;
  let out = String(p || "").trim();
  if (!out) return out;

  if (out === "~") out = os.homedir();
  else if (out.startsWith("~/")) out = path.join(os.homedir(), out.slice(2));

  out = out.replace(/%([^%]+)%/g, (full, name) => {
    const key = String(name || "").trim();
    if (!key) return full;
    return Object.prototype.hasOwnProperty.call(process.env, key) ? String(process.env[key]) : full;
  });

  return out;
}

function isWindowsCommandWrapperPath(filePath) {
  return /\.(cmd|bat)$/i.test(String(filePath || "").trim());
}

function isNodeScriptPath(filePath) {
  return /\.(mjs|cjs|js)$/i.test(String(filePath || "").trim());
}

function isRegularFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isLikelyNodeScriptFile(filePath) {
  const target = String(filePath || "").trim();
  if (!target || !isRegularFile(target)) return false;
  if (isNodeScriptPath(target)) return true;
  if (isWindowsCommandWrapperPath(target)) return false;

  try {
    const fd = fs.openSync(target, "r");
    try {
      const chunk = Buffer.alloc(160);
      const size = fs.readSync(fd, chunk, 0, chunk.length, 0);
      if (size <= 0) return false;
      const head = chunk.toString("utf8", 0, size);
      return /^\s*#!.*\bnode(?:\.exe)?\b/i.test(head);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function resolvesToWindowsExecutableAlias(filePath) {
  try {
    const resolved = fs.realpathSync(filePath);
    const ext = path.extname(String(resolved || "")).toLowerCase();
    return [".exe", ".com", ".cmd", ".bat", ".ps1"].includes(ext);
  } catch {
    return false;
  }
}

function isExecutable(filePath) {
  if (process.platform === "win32") {
    if (!isRegularFile(filePath)) return false;
    const ext = path.extname(String(filePath || "")).toLowerCase();
    if (!ext) return isLikelyNodeScriptFile(filePath) || resolvesToWindowsExecutableAlias(filePath);
    if (isNodeScriptPath(filePath)) return true;
    return [".exe", ".cmd", ".bat", ".com", ".ps1"].includes(ext);
  }

  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizeWindowsWrapperScriptPath(rawScriptPath, wrapperPath) {
  const raw = String(rawScriptPath || "").trim().replace(/^["']+|["']+$/g, "");
  if (!raw) return "";
  const wrapperDir = path.dirname(String(wrapperPath || ""));
  if (!wrapperDir) return "";

  let candidate = raw.replace(/%~dp0/gi, `${wrapperDir}\\`);
  candidate = candidate.replace(/%dp0%/gi, `${wrapperDir}\\`);
  candidate = candidate.replace(/\\/g, path.sep).replace(/\//g, path.sep);
  if (!path.isAbsolute(candidate)) candidate = path.resolve(wrapperDir, candidate);
  return path.normalize(candidate);
}

function resolveWindowsWrapperNodeScript(wrapperPath) {
  const wrapper = String(wrapperPath || "").trim();
  if (!wrapper || !isWindowsCommandWrapperPath(wrapper)) return "";
  if (!fs.existsSync(wrapper)) return "";

  let content = "";
  try {
    content = String(fs.readFileSync(wrapper, "utf8") || "");
  } catch {
    return "";
  }
  if (!content) return "";

  const patterns = [
    /node(?:\.exe)?\s+"([^"\r\n]+?)"/gi,
    /"%~dp0\\node\.exe"\s+"([^"\r\n]+?)"/gi,
    /"%~dp0([^"\r\n]+?)"/gi,
    /%~dp0([^\s\r\n]+)/gi,
    /"([^"\r\n]*node_modules[^"\r\n]+?)"/gi,
  ];

  for (const pattern of patterns) {
    let match = null;
    while ((match = pattern.exec(content)) !== null) {
      const candidate = normalizeWindowsWrapperScriptPath(match[1], wrapper);
      if (candidate && isLikelyNodeScriptFile(candidate)) return candidate;
    }
  }

  return "";
}

function splitPathEntries(envPath) {
  const sep = process.platform === "win32" ? ";" : ":";
  return String(envPath || "").split(sep).filter(Boolean);
}

function findInPath(binaryName) {
  const out = [];
  const name = String(binaryName || "").trim();
  if (!name) return out;

  const windowsExts = process.platform === "win32"
    ? String(process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
      .split(";")
      .map((ext) => ext.trim().toLowerCase())
      .filter(Boolean)
    : [];
  const hasKnownWinExt = process.platform === "win32" && windowsExts.some((ext) => name.toLowerCase().endsWith(ext));

  for (const p of splitPathEntries(process.env.PATH)) {
    const base = path.join(p, name);
    out.push(base);
    if (process.platform === "win32") {
      if (!hasKnownWinExt) {
        windowsExts.forEach((ext) => out.push(`${base}${ext.toLowerCase()}`));
      }
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

function resolveNodeExecutablePath(scriptPath = "") {
  const candidates = [];
  if (process.platform === "win32") {
    const scriptDir = path.dirname(String(scriptPath || ""));
    if (scriptDir) candidates.push(path.join(scriptDir, "node.exe"));

    const home = os.homedir();
    const userProfile = process.env.USERPROFILE || home;
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

    candidates.push(
      path.join(userProfile, "scoop", "apps", "nodejs-lts", "current", "node.exe"),
      path.join(userProfile, "scoop", "apps", "nodejs", "current", "node.exe"),
      path.join(programFiles, "nodejs", "node.exe"),
      path.join(programFilesX86, "nodejs", "node.exe"),
      path.join(localAppData, "Programs", "nodejs", "node.exe"),
      ...findInPath("node.exe"),
      ...findInPath("node"),
    );
  } else {
    candidates.push(...findInPath("node"));
  }

  const normalized = [...new Set(candidates.map((item) => String(item || "").trim()).filter(Boolean))];
  const existing = normalized.find((candidate) => {
    if (!fs.existsSync(candidate)) return false;
    if (process.platform === "win32" && isWindowsCommandWrapperPath(candidate)) return false;
    return true;
  });
  if (existing) return existing;
  return process.platform === "win32" ? "node.exe" : "node";
}

function isWindowsWslPath(filePath) {
  const target = String(filePath || "").trim();
  if (!target) return false;
  const base = path.basename(target).toLowerCase();
  return base === "wsl" || base === "wsl.exe";
}

function windowsCandidatePriority(candidate) {
  const normalized = String(candidate || "").trim();
  const ext = path.extname(normalized).toLowerCase();
  if (isWindowsCommandWrapperPath(normalized)) return 50;
  if (ext === ".exe" || ext === ".com") return 0;
  if (isNodeScriptPath(normalized)) return 10;
  if (!ext) return 20;
  return 30;
}

class ExecutableResolver {
  buildPlatformCandidates() {
    if (process.platform !== "win32") {
      return [expandHome("~/.opencode/bin/opencode")];
    }

    const home = os.homedir();
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const userProfile = process.env.USERPROFILE || home;
    const npmNodeModules = path.join(appData, "npm", "node_modules");

    return [
      path.join(home, ".opencode", "bin", "opencode.exe"),
      path.join(userProfile, ".opencode", "bin", "opencode.exe"),
      path.join(localAppData, "Programs", "opencode", "opencode.exe"),
      path.join(localAppData, "Microsoft", "WinGet", "Links", "opencode.exe"),
      path.join(localAppData, "Microsoft", "WinGet", "Links", "opencode"),
      path.join(npmNodeModules, "@opencode-ai", "opencode", "dist", "cli.js"),
      path.join(npmNodeModules, "@opencode-ai", "opencode", "cli.js"),
      path.join(npmNodeModules, "@opencode-ai", "opencode", "bin", "opencode.js"),
      path.join(npmNodeModules, "opencode-ai", "bin", "opencode"),
      path.join(npmNodeModules, "opencode", "dist", "cli.js"),
      path.join(npmNodeModules, "opencode", "cli.js"),
      path.join(npmNodeModules, "opencode", "bin", "opencode.js"),
      path.join(home, ".opencode", "bin", "opencode.cmd"),
      path.join(userProfile, ".opencode", "bin", "opencode.cmd"),
      path.join(appData, "npm", "opencode.cmd"),
      path.join(appData, "npm", "opencode"),
    ];
  }

  buildMissingHint() {
    if (process.platform === "win32") {
      const home = os.homedir();
      return [
        rt("未找到可执行文件。", "Executable not found."),
        rt(
          "请先在 Windows 本机安装 Node.js，然后执行 npm install -g opencode-ai。必要时可在设置里填写 FLOWnote CLI 的绝对路径（优先 .exe，其次 cli.js 或 bin/opencode），例如：",
          "Install Node.js on native Windows first, then run npm install -g opencode-ai. If needed, set the absolute FLOWnote CLI path in settings (prefer .exe, then cli.js or bin/opencode), for example:",
        ),
        `${path.join(home, ".opencode", "bin", "opencode.exe")}`,
        `${path.join(home, "AppData", "Roaming", "npm", "node_modules", "opencode-ai", "bin", "opencode")}`,
        rt(
          "Windows 下请避免填写 opencode.cmd 包装脚本。",
          "On Windows, avoid using the opencode.cmd wrapper script.",
        ),
        rt(
          "不要使用 WSL 安装 OpenCode；请改为在 Windows 本机用 Node.js 安装。",
          "Do not install OpenCode via WSL; install it on native Windows with Node.js instead.",
        ),
      ].join(" ");
    }
    return rt(
      "未找到可执行文件。请在设置里填写绝对路径，例如 {example}",
      "Executable not found. Set the absolute path in settings, e.g. {example}",
      { example: expandHome("~/.opencode/bin/opencode") },
    );
  }

  async resolve(cliPath, options = {}) {
    const attempted = [];
    const candidates = [];
    const onlyCliPath = Boolean(options && options.onlyCliPath);
    const explicitCliPath = String(cliPath || "").trim();

    if (explicitCliPath) candidates.push(expandHome(explicitCliPath));
    if (!onlyCliPath) {
      candidates.push(...findInPath("opencode"));
      candidates.push(...this.buildPlatformCandidates());
      candidates.push(...(await which("opencode")));
    }

    const unique = [...new Set(candidates.map((c) => String(c || "").trim()).filter(Boolean))];
    const ordered = process.platform === "win32"
      ? unique
        .map((item, index) => ({ item, index }))
        .sort((a, b) => {
          const aExplicit = explicitCliPath && a.index === 0 ? -100 : 0;
          const bExplicit = explicitCliPath && b.index === 0 ? -100 : 0;
          const delta = (windowsCandidatePriority(a.item) + aExplicit) - (windowsCandidatePriority(b.item) + bExplicit);
          if (delta !== 0) return delta;
          return a.index - b.index;
        })
        .map((item) => item.item)
      : unique;

    for (const c of ordered) {
      attempted.push(c);
      if (process.platform === "win32" && isWindowsWslPath(c)) continue;
      if (!fs.existsSync(c)) continue;
      if (!isExecutable(c)) continue;

      if (process.platform === "win32" && isWindowsCommandWrapperPath(c)) {
        const scriptPath = resolveWindowsWrapperNodeScript(c);
        if (!scriptPath) continue;
        return {
          ok: true,
          path: scriptPath,
          attempted,
          kind: "node-script",
          sourcePath: c,
          nodePath: resolveNodeExecutablePath(scriptPath),
        };
      }

      if (process.platform === "win32" && isNodeScriptPath(c)) {
        return {
          ok: true,
          path: c,
          attempted,
          kind: "node-script",
          nodePath: resolveNodeExecutablePath(c),
        };
      }

      if (process.platform === "win32" && isLikelyNodeScriptFile(c)) {
        return {
          ok: true,
          path: c,
          attempted,
          kind: "node-script",
          nodePath: resolveNodeExecutablePath(c),
        };
      }

      return { ok: true, path: c, attempted, kind: "native" };
    }

    return {
      ok: false,
      path: "",
      attempted,
      hint: this.buildMissingHint(),
    };
  }
}

module.exports = {
  ExecutableResolver,
  isNodeScriptPath,
  isLikelyNodeScriptFile,
  isWindowsCommandWrapperPath,
  resolveWindowsWrapperNodeScript,
  resolveNodeExecutablePath,
};
