function createLaunchAttemptMethods(deps = {}) {
  const {
    os,
    path,
    process,
    OPENCODE_SERVE_ARGS,
    isWindowsPlatform,
    isWindowsCommandWrapper,
    isNodeScriptPath,
    resolveWindowsWrapperNodeScript,
    resolveNodeExecutablePath,
    toWslPath,
  } = deps;

  const CHILD_ENV_KEYS = [
    "PATH",
    "PATHEXT",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ];
  const CHILD_ENV_PREFIXES = [
    "OPENCODE_",
    "OPENAI_",
    "ANTHROPIC_",
    "DEEPSEEK_",
    "DASHSCOPE_",
    "MOONSHOT_",
    "ZHIPU_",
    "SILICONFLOW_",
    "GEMINI_",
    "GOOGLE_",
    "OPENROUTER_",
    "AZURE_OPENAI_",
  ];

  function readEnvValue(name) {
    try {
      if (!process || !process.env) return "";
      const value = process.env[name];
      return typeof value === "string" && value ? value : "";
    } catch {
      return "";
    }
  }

  function shouldForwardEnvKey(name) {
    const key = String(name || "");
    if (!key) return false;
    const upper = key.toUpperCase();
    if (CHILD_ENV_KEYS.some((item) => item.toUpperCase() === upper)) return true;
    if (CHILD_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true;
    return /_(API_KEY|ACCESS_TOKEN|BASE_URL|ENDPOINT)$/i.test(key);
  }

  function buildChildEnv(extra = {}) {
    const env = {};
    try {
      for (const key of Object.keys((process && process.env) || {})) {
        if (!shouldForwardEnvKey(key)) continue;
        const value = readEnvValue(key);
        if (value) env[key] = value;
      }
    } catch {
      for (const key of CHILD_ENV_KEYS) {
        const value = readEnvValue(key);
        if (value) env[key] = value;
      }
    }
    return { ...env, ...extra };
  }

  function defaultLaunchCwd() {
    return readEnvValue("USERPROFILE") || os.homedir() || process.cwd();
  }

  class LaunchAttemptMethods {
  createWslAttempt(runtimeHome, distro = "", shellName = "sh") {
    const pickedDistro = String(distro || "").trim();
    const pickedShell = String(shellName || "sh").trim() || "sh";
    const args = [];
    if (pickedDistro) args.push("-d", pickedDistro);
    args.push("-e", pickedShell, "-lc", this.buildWslServeCommand(runtimeHome));
    const wslLaunchCwd = defaultLaunchCwd();
    return {
      label: pickedDistro ? `wsl(${pickedDistro}, ${pickedShell})` : `wsl(${pickedShell})`,
      command: "wsl.exe",
      args,
      options: {
        cwd: wslLaunchCwd,
        env: buildChildEnv(),
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
    ) return "native";
    return "auto";
  }

  normalizeLaunchProfile(profile) {
    if (!profile || typeof profile !== "object") return null;
    const mode = String(profile.mode || "").trim().toLowerCase() === "native" ? "native" : "";
    const command = String(profile.command || "").trim();
    const args = Array.isArray(profile.args)
      ? profile.args.map((item) => String(item || ""))
      : [];
    const shell = Boolean(profile.shell);
    const distro = String(profile.distro || "").trim();
    if (mode !== "native" || !command) return null;
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
    if (item.mode !== "native") return null;
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
    this.pushLaunchAttempt(list, seen, {
      label: `${profile.command} (remembered)`,
      command: profile.command,
      args: Array.isArray(profile.args) && profile.args.length ? profile.args : OPENCODE_SERVE_ARGS,
      options: {
        cwd: this.vaultPath,
        env: buildChildEnv({ OPENCODE_HOME: runtimeHome }),
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
    const preferred = strategy === "auto" ? this.resolvePreferredLaunchProfile() : null;
    const baseEnv = buildChildEnv({ OPENCODE_HOME: runtimeHome });
    const baseOptions = {
      cwd: this.vaultPath,
      env: baseEnv,
    };
    const resolvedPath = String(resolved && resolved.path ? resolved.path : "").trim();
    const resolvedKind = String(resolved && resolved.kind ? resolved.kind : "").trim();
    const resolvedNodePath = String(resolved && resolved.nodePath ? resolved.nodePath : "").trim();
    const resolvedSourcePath = String(resolved && resolved.sourcePath ? resolved.sourcePath : "").trim();

    if (preferred) {
      this.pushPreferredLaunchAttempt(attempts, seen, preferred, runtimeHome);
    }

    if (resolvedPath) {
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

    const allowAutoFallback = Boolean(this.settings.autoDetectCli || !String(this.settings.cliPath || "").trim());
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

    return attempts;
  }

  }

  const methods = {};
  for (const key of Object.getOwnPropertyNames(LaunchAttemptMethods.prototype)) {
    if (key === "constructor") continue;
    methods[key] = LaunchAttemptMethods.prototype[key];
  }
  return methods;
}

module.exports = { createLaunchAttemptMethods };
