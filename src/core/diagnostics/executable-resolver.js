const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
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
  const candidates = [];
  for (const entry of splitPathEntries(process.env.PATH)) {
    const resolved = path.join(entry, binaryName);
    candidates.push(resolved);
    if (process.platform === "win32") {
      candidates.push(`${resolved}.exe`);
      candidates.push(`${resolved}.cmd`);
    }
  }
  return candidates;
}

function which(binaryName) {
  const cmd = process.platform === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    execFile(cmd, [binaryName], { timeout: 2000 }, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      const lines = String(stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      resolve(lines);
    });
  });
}

class ExecutableResolver {
  async resolve(cliPath) {
    const attempted = [];
    const binary = process.platform === "win32" ? "opencode.exe" : "opencode";

    const candidates = [];
    if (cliPath) {
      candidates.push(expandHome(cliPath));
    }

    candidates.push(...findInPath("opencode"));
    candidates.push(expandHome("~/.opencode/bin/opencode"));

    const wh = await which("opencode");
    candidates.push(...wh);

    const unique = [...new Set(candidates.filter(Boolean))];

    for (const candidate of unique) {
      attempted.push(candidate);

      if (!fs.existsSync(candidate)) continue;
      if (!isExecutable(candidate)) continue;

      return {
        ok: true,
        path: candidate,
        attempted,
      };
    }

    return {
      ok: false,
      path: "",
      attempted,
      hint: `未找到可执行文件。请在设置里填写绝对路径，例如 ${expandHome("~/.opencode/bin/opencode")}`,
      binary,
    };
  }
}

module.exports = {
  ExecutableResolver,
};
