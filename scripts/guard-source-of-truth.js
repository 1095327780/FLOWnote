#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");

function hasRef(ref) {
  if (!ref) return false;
  try {
    execFileSync("git", ["rev-parse", "--verify", ref], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function resolveDiffRange() {
  if (!process.env.CI && !process.env.GITHUB_ACTIONS) {
    return "";
  }

  const baseRef = String(process.env.GITHUB_BASE_REF || "").trim();
  const baseRemoteRef = baseRef ? `origin/${baseRef}` : "";
  if (baseRemoteRef && hasRef(baseRemoteRef)) {
    return `${baseRemoteRef}...HEAD`;
  }
  if (hasRef("HEAD~1")) {
    return "HEAD~1...HEAD";
  }
  return "";
}

function readDiffByArgs(args) {
  try {
    const out = execFileSync("git", args, { encoding: "utf8" });
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`读取 src 变更失败: ${message}`);
  }
}

function readChangedSrcFiles(range) {
  if (range) {
    return readDiffByArgs(["diff", "--name-only", "--diff-filter=ACMR", range, "--", "src/"]);
  }

  const unstaged = readDiffByArgs(["diff", "--name-only", "--diff-filter=ACMR", "--", "src/"]);
  const staged = readDiffByArgs(["diff", "--name-only", "--diff-filter=ACMR", "--cached", "--", "src/"]);
  const untracked = readDiffByArgs(["ls-files", "--others", "--exclude-standard", "--", "src/"]);
  return [...new Set([...unstaged, ...staged, ...untracked])];
}

function main() {
  const range = resolveDiffRange();
  const files = readChangedSrcFiles(range);
  const allowList = new Set([
    "src/LEGACY.md",
  ]);

  const blocked = files.filter((file) => !allowList.has(file));
  if (blocked.length) {
    console.error("[guard-source-of-truth] 检查失败: src/ 为 legacy 只读目录。");
    console.error(`比较范围: ${range || "工作区"}`);
    for (const file of blocked) {
      console.error(`- 禁止修改: ${file}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("[guard-source-of-truth] OK");
}

main();
