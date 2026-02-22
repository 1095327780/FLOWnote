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
  const versions = readJson("versions.json");

  const errors = [];
  if (String(pkg.version || "") !== String(manifest.version || "")) {
    errors.push(`package.json(${pkg.version}) 与 manifest.json(${manifest.version}) 版本不一致`);
  }

  if (!versions || typeof versions !== "object" || Array.isArray(versions)) {
    errors.push("versions.json 必须是 JSON 对象");
  } else {
    const manifestVersion = String(manifest.version || "");
    const mappedMinApp = String(versions[manifestVersion] || "");
    const manifestMinApp = String(manifest.minAppVersion || "");
    if (!mappedMinApp) {
      errors.push(`versions.json 缺少当前版本映射: ${manifestVersion}`);
    } else if (mappedMinApp !== manifestMinApp) {
      errors.push(
        `versions.json(${manifestVersion} => ${mappedMinApp}) 与 manifest.minAppVersion(${manifestMinApp}) 不一致`,
      );
    }
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
