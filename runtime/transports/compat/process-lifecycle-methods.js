function createProcessLifecycleMethods(deps = {}) {
  const {
    fs,
    path,
    spawn,
    process,
    STARTUP_TIMEOUT_MS,
    WSL_STARTUP_TIMEOUT_MS,
    collectOutputTail,
    appendOutputHint,
  } = deps;

  class ProcessLifecycleMethods {
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
        finish(new Error(`无法启动 FLOWnote 服务 (${label}): ${e instanceof Error ? e.message : String(e)}`));
        return;
      }

      const inspectOutput = (source, chunk) => {
        collectOutputTail(outputTail, source, chunk);
        const text = String(chunk || "");
        const dataHomeMatch = text.match(/\[flownote\]\s+WSL XDG_DATA_HOME=([^\r\n]+)/);
        if (dataHomeMatch && dataHomeMatch[1]) {
          detectedWslDataHome = String(dataHomeMatch[1]).trim();
        }
        const homeMatch = text.match(/\[flownote\]\s+WSL HOME=([^\r\n]+)/);
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
        finish(new Error(appendOutputHint(`无法启动 FLOWnote 服务 (${label}): ${message}`, outputTail)));
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
          `FLOWnote 服务提前退出 (${label})，退出码: ${String(code)}${armHint}`,
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
            `等待 FLOWnote 服务启动超时 (${label}, ${startupTimeoutMs}ms)`,
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
      throw new Error(`无法启动 FLOWnote 服务: ${hint}`);
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
    throw new Error(`无法启动 FLOWnote 服务，已尝试 ${attempts.length} 种方式:\n${failed.join("\n")}${hint}`);
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

  async stop() {
    if (this.process) this.process.kill();
    this.clearProcessState();
  }
  }

  const methods = {};
  for (const key of Object.getOwnPropertyNames(ProcessLifecycleMethods.prototype)) {
    if (key === "constructor") continue;
    methods[key] = ProcessLifecycleMethods.prototype[key];
  }
  return methods;
}

module.exports = { createProcessLifecycleMethods };
