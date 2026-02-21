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

function main() {
  const blocked = [
    "data.json",
  ];
  const problems = [];

  for (const pathspec of blocked) {
    const tracked = readTracked(pathspec);
    if (tracked.length) {
      const existing = tracked.filter((file) => fs.existsSync(file));
      problems.push(...existing.map((file) => `禁止提交运行态文件: ${file}`));
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
