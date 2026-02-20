const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  resolveWindowsWrapperNodeScript,
  isNodeScriptPath,
  isWindowsCommandWrapperPath,
} = require("../../runtime/executable-resolver");

test("resolveWindowsWrapperNodeScript should parse npm cmd wrapper target", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-wrapper-"));
  const wrapperPath = path.join(tmpDir, "opencode.cmd");
  const scriptPath = path.join(tmpDir, "node_modules", "@opencode-ai", "opencode", "dist", "cli.js");
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, "console.log('ok');\n", "utf8");
  fs.writeFileSync(
    wrapperPath,
    [
      "@ECHO off",
      "IF EXIST \"%~dp0\\\\node.exe\" (",
      "  \"%~dp0\\\\node.exe\"  \"%~dp0\\\\node_modules\\\\@opencode-ai\\\\opencode\\\\dist\\\\cli.js\" %*",
      ") ELSE (",
      "  node  \"%~dp0\\\\node_modules\\\\@opencode-ai\\\\opencode\\\\dist\\\\cli.js\" %*",
      ")",
      "",
    ].join("\r\n"),
    "utf8",
  );

  try {
    const resolved = resolveWindowsWrapperNodeScript(wrapperPath);
    assert.equal(resolved, path.normalize(scriptPath));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolveWindowsWrapperNodeScript should return empty when target script is missing", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-wrapper-"));
  const wrapperPath = path.join(tmpDir, "opencode.cmd");
  fs.writeFileSync(
    wrapperPath,
    "node \"%~dp0\\\\node_modules\\\\@opencode-ai\\\\opencode\\\\dist\\\\cli.js\" %*\r\n",
    "utf8",
  );

  try {
    const resolved = resolveWindowsWrapperNodeScript(wrapperPath);
    assert.equal(resolved, "");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("helper detectors should recognize script and wrapper paths", () => {
  assert.equal(isNodeScriptPath("C:\\\\a\\\\b\\\\cli.js"), true);
  assert.equal(isNodeScriptPath("C:\\\\a\\\\b\\\\opencode.exe"), false);
  assert.equal(isWindowsCommandWrapperPath("C:\\\\a\\\\b\\\\opencode.cmd"), true);
  assert.equal(isWindowsCommandWrapperPath("C:\\\\a\\\\b\\\\opencode.exe"), false);
});
