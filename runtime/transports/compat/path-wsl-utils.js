function createPathWslMethods(deps = {}) {
  const {
    fs,
    path,
    os,
    execFileSync,
    OPENCODE_SERVE_ARGS,
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
    toWslPathWithFallback,
    parseWindowsDrivePath,
    parseWslMountPath,
    shortStableHash,
  } = deps;

  class PathWslMethods {
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
    return `\n提示: 检测到 SQLite/文件锁问题。FLOWnote 官方将数据库存放在 XDG_DATA_HOME（默认 ~/.local/share/opencode）。插件已改为独立 XDG_DATA_HOME，以避免与其他 FLOWnote 进程竞争同一个数据库。${suffix}`;
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
      "echo \"[FLOWnote] WSL HOME=$HOME\" 1>&2;",
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
      "echo \"[FLOWnote] WSL XDG_DATA_HOME=$XDG_DATA_HOME_DIR\" 1>&2;",
      "echo \"[FLOWnote] WSL XDG_CONFIG_HOME=$XDG_CONFIG_HOME_DIR\" 1>&2;",
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

  }

  const methods = {};
  for (const key of Object.getOwnPropertyNames(PathWslMethods.prototype)) {
    if (key === "constructor") continue;
    methods[key] = PathWslMethods.prototype[key];
  }
  return methods;
}

module.exports = { createPathWslMethods };
