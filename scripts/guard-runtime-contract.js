#!/usr/bin/env node
"use strict";

const fs = require("fs");

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`读取文件失败 ${filePath}: ${message}`);
  }
}

function main() {
  const problems = [];

  const bannedPaths = [
    "src",
    "tsconfig.json",
    "esbuild.config.mjs",
  ];

  bannedPaths.forEach((target) => {
    if (fs.existsSync(target)) {
      problems.push(`禁止重新引入 legacy/占位路径: ${target}`);
    }
  });

  const mainCode = readText("main.js");
  if (/requirePluginRuntimeModule|getPluginRootCandidatesForFacade|resolvePluginRootForFacade/.test(mainCode)) {
    problems.push("main.js 仍包含动态运行时探测逻辑");
  }

  const loaderCode = readText("runtime/plugin/module-loader-methods.js");
  if (/new Function\s*\(/.test(loaderCode)) {
    problems.push("module-loader 仍包含 new Function 动态执行");
  }
  if (/resolveRuntimeModulePath|getRuntimeModuleRoots|loadRuntimeModuleFile/.test(loaderCode)) {
    problems.push("module-loader 仍包含多路径动态解析逻辑");
  }

  const modelCatalogCode = readText("runtime/plugin/model-catalog-methods.js");
  if (/终端输出\.md/.test(modelCatalogCode)) {
    problems.push("模型缓存已回退到用户笔记文件（终端输出.md）");
  }

  if (problems.length) {
    console.error("[guard-runtime-contract] 检查失败:");
    problems.forEach((problem) => console.error(`- ${problem}`));
    process.exitCode = 1;
    return;
  }

  console.log("[guard-runtime-contract] OK");
}

main();
