#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const LIMIT = 1200;

const TARGETS = [
  "main.js",
  "runtime",
];

function toPosix(value) {
  return String(value || "").split(path.sep).join("/");
}

function shouldSkip(relativePath) {
  const p = toPosix(relativePath);
  if (!p) return true;
  if (p.startsWith("node_modules/")) return true;
  if (p.startsWith("release/")) return true;
  if (p.startsWith("tests/")) return true;
  if (p === "styles.css") return true;
  return false;
}

function walkJsFiles(absPath, relPath = "") {
  if (!fs.existsSync(absPath)) return [];
  const stat = fs.statSync(absPath);
  if (stat.isFile()) {
    if (!absPath.endsWith(".js")) return [];
    const relative = relPath || path.basename(absPath);
    return shouldSkip(relative) ? [] : [relative];
  }
  if (!stat.isDirectory()) return [];

  const output = [];
  const entries = fs.readdirSync(absPath, { withFileTypes: true });
  for (const entry of entries) {
    const childAbs = path.join(absPath, entry.name);
    const childRel = relPath ? path.join(relPath, entry.name) : entry.name;
    const childPosix = toPosix(childRel);
    if (shouldSkip(childPosix)) continue;
    if (entry.isDirectory()) {
      output.push(...walkJsFiles(childAbs, childRel));
      continue;
    }
    if (entry.isFile() && childAbs.endsWith(".js")) {
      output.push(childRel);
    }
  }
  return output;
}

function countLines(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  if (!text.length) return 0;
  return text.split(/\r?\n/).length;
}

function main() {
  const candidates = [];
  for (const target of TARGETS) {
    const abs = path.join(ROOT, target);
    candidates.push(...walkJsFiles(abs, target));
  }

  const unique = [...new Set(candidates.map((item) => toPosix(item)))].sort();
  const violations = [];

  for (const relative of unique) {
    const abs = path.join(ROOT, relative);
    const lines = countLines(abs);
    if (lines > LIMIT) {
      violations.push({ path: relative, lines });
    }
  }

  if (violations.length) {
    console.error(`[guard-file-size] FAILED: found ${violations.length} file(s) over ${LIMIT} lines`);
    for (const item of violations) {
      console.error(`- ${item.path}: ${item.lines}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`[guard-file-size] OK (${unique.length} files checked, limit=${LIMIT})`);
}

main();
