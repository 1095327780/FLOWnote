#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");

function readTracked(pathspec) {
  try {
    const out = execFileSync("git", ["ls-files", "--", pathspec], { encoding: "utf8" });
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取 git 索引: ${message}`);
  }
}

function isIgnored(pathspec) {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", pathspec], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const blocked = [
    "data.json",
  ];
  const requiredTracked = [
    "data.example.json",
  ];
  const problems = [];

  for (const pathspec of blocked) {
    const tracked = readTracked(pathspec);
    if (tracked.length) {
      const existing = tracked.filter((file) => fs.existsSync(file));
      problems.push(...existing.map((file) => `禁止提交运行态文件: ${file}`));
    }
  }

  if (!isIgnored("data.json")) {
    problems.push("data.json 必须在 .gitignore 中被忽略");
  }

  for (const pathspec of requiredTracked) {
    const tracked = readTracked(pathspec);
    if (!tracked.length) {
      problems.push(`必须保留示例文件并纳入版本控制: ${pathspec}`);
      continue;
    }
    if (!fs.existsSync(pathspec)) {
      problems.push(`示例文件缺失: ${pathspec}`);
    }
  }

  if (fs.existsSync("data.example.json")) {
    try {
      JSON.parse(fs.readFileSync("data.example.json", "utf8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(`data.example.json 不是合法 JSON: ${message}`);
    }
  }

  if (problems.length) {
    console.error("[guard-repo-hygiene] 检查失败:");
    for (const item of problems) {
      console.error(`- ${item}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("[guard-repo-hygiene] OK");
}

main();
