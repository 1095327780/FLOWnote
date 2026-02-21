#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function readJson(relativePath) {
  const filePath = path.join(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function main() {
  const pkg = readJson("package.json");
  const manifest = readJson("manifest.json");
  const mainCode = fs.readFileSync(path.join(process.cwd(), "main.js"), "utf8");

  const errors = [];
  if (String(pkg.version || "") !== String(manifest.version || "")) {
    errors.push(`package.json(${pkg.version}) 与 manifest.json(${manifest.version}) 版本不一致`);
  }

  if (/runtime main\.js v\d+\.\d+\.\d+ loaded/.test(mainCode)) {
    errors.push("main.js 仍存在硬编码版本日志");
  }

  if (!/this\.manifest\s*&&\s*this\.manifest\.version/.test(mainCode)) {
    errors.push("main.js 未使用 manifest 动态版本");
  }

  if (errors.length) {
    console.error("[verify-version-sync] 检查失败:");
    for (const item of errors) {
      console.error(`- ${item}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("[verify-version-sync] OK");
}

main();
