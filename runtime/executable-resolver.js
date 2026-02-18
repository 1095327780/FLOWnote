const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

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

module.exports = { ExecutableResolver };
