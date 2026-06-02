const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  ExecutableResolver,
  resolveWindowsWrapperNodeScript,
  isLikelyNodeScriptFile,
  isNodeScriptPath,
  isWindowsCommandWrapperPath,
  isLikelyOpenCodeDesktopAppPath,
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

test("resolveWindowsWrapperNodeScript should parse npm wrapper target without extension", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-wrapper-"));
  const wrapperPath = path.join(tmpDir, "opencode.cmd");
  const scriptPath = path.join(tmpDir, "node_modules", "opencode-ai", "bin", "opencode");
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, "#!/usr/bin/env node\nconsole.log('ok');\n", "utf8");
  fs.writeFileSync(
    wrapperPath,
    [
      "@ECHO off",
      "IF EXIST \"%~dp0\\\\node.exe\" (",
      "  \"%~dp0\\\\node.exe\"  \"%~dp0\\\\node_modules\\\\opencode-ai\\\\bin\\\\opencode\" %*",
      ") ELSE (",
      "  node  \"%~dp0\\\\node_modules\\\\opencode-ai\\\\bin\\\\opencode\" %*",
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

test("ExecutableResolver should treat windows node shebang bins as node scripts", async () => {
  const platformDesc = Object.getOwnPropertyDescriptor(process, "platform");
  if (!platformDesc) return;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-bin-"));
  const scriptPath = path.join(tmpDir, "opencode");
  fs.writeFileSync(scriptPath, "#!/usr/bin/env node\nconsole.log('ok');\n", "utf8");

  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    assert.equal(isLikelyNodeScriptFile(scriptPath), true);

    const resolver = new ExecutableResolver();
    const resolved = await resolver.resolve(scriptPath, { onlyCliPath: true });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.kind, "node-script");
    assert.equal(resolved.path, scriptPath);
  } finally {
    Object.defineProperty(process, "platform", platformDesc);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ExecutableResolver should skip windows shell wrapper without executable extension", async () => {
  const platformDesc = Object.getOwnPropertyDescriptor(process, "platform");
  if (!platformDesc) return;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-sh-"));
  const scriptPath = path.join(tmpDir, "opencode");
  fs.writeFileSync(scriptPath, "#!/bin/sh\nexec node \"$0\" \"$@\"\n", "utf8");

  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    assert.equal(isLikelyNodeScriptFile(scriptPath), false);

    const resolver = new ExecutableResolver();
    const resolved = await resolver.resolve(scriptPath, { onlyCliPath: true });
    assert.equal(resolved.ok, false);
  } finally {
    Object.defineProperty(process, "platform", platformDesc);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("helper detectors should recognize script and wrapper paths", () => {
  assert.equal(isNodeScriptPath("C:\\\\a\\\\b\\\\cli.js"), true);
  assert.equal(isNodeScriptPath("C:\\\\a\\\\b\\\\opencode.exe"), false);
  assert.equal(isWindowsCommandWrapperPath("C:\\\\a\\\\b\\\\opencode.cmd"), true);
  assert.equal(isWindowsCommandWrapperPath("C:\\\\a\\\\b\\\\opencode.exe"), false);
});

test("ExecutableResolver should skip the Windows OpenCode Desktop app exe", async () => {
  const platformDesc = Object.getOwnPropertyDescriptor(process, "platform");
  if (!platformDesc) return;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-desktop-"));
  const desktopExe = path.join(tmpDir, "AppData", "Local", "Programs", "opencode", "opencode.exe");
  const npmExe = path.join(tmpDir, "AppData", "Roaming", "npm", "node_modules", "opencode-ai", "bin", "opencode.exe");
  fs.mkdirSync(path.dirname(desktopExe), { recursive: true });
  fs.mkdirSync(path.dirname(npmExe), { recursive: true });
  fs.writeFileSync(desktopExe, "desktop gui", "utf8");
  fs.writeFileSync(npmExe, "cli", "utf8");

  const prevAppData = process.env.APPDATA;
  const prevLocalAppData = process.env.LOCALAPPDATA;
  const prevUserProfile = process.env.USERPROFILE;
  const prevPath = process.env.PATH;

  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    process.env.APPDATA = path.join(tmpDir, "AppData", "Roaming");
    process.env.LOCALAPPDATA = path.join(tmpDir, "AppData", "Local");
    process.env.USERPROFILE = tmpDir;
    process.env.PATH = "";

    assert.equal(isLikelyOpenCodeDesktopAppPath(desktopExe), true);
    const resolver = new ExecutableResolver();
    const resolved = await resolver.resolve();

    assert.equal(resolved.ok, true);
    assert.equal(resolved.path, npmExe);
    assert.equal(resolved.attempted.includes(desktopExe), false);
  } finally {
    Object.defineProperty(process, "platform", platformDesc);
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
    if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = prevLocalAppData;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
