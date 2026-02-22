#!/usr/bin/env node
import { execFileSync } from "child_process";
import fs from "fs/promises";
import path from "path";

const ROOT = process.cwd();
const RELEASE_DIR = path.join(ROOT, "release");

function runGit(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

async function readJson(relativePath) {
  const full = path.join(ROOT, relativePath);
  return JSON.parse(await fs.readFile(full, "utf8"));
}

async function exists(relativePath) {
  try {
    await fs.access(path.join(ROOT, relativePath));
    return true;
  } catch {
    return false;
  }
}

function assert(condition, message, errors) {
  if (!condition) errors.push(message);
}

async function main() {
  const errors = [];

  const requiredRootFiles = [
    "README.md",
    "LICENSE",
    "manifest.json",
    "versions.json",
    "main.js",
    "styles.css",
  ];
  for (const file of requiredRootFiles) {
    assert(await exists(file), `缺少必需文件: ${file}`, errors);
  }

  const requiredReleaseFiles = [
    "main.js",
    "manifest.json",
    "styles.css",
  ];
  for (const file of requiredReleaseFiles) {
    assert(await exists(path.join("release", file)), `缺少 release 资产: release/${file}`, errors);
  }

  let manifest = null;
  let pkg = null;
  let versions = null;
  let releaseManifest = null;

  try {
    manifest = await readJson("manifest.json");
    pkg = await readJson("package.json");
    versions = await readJson("versions.json");
    releaseManifest = await readJson(path.join("release", "manifest.json"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`JSON 解析失败: ${message}`);
  }

  if (manifest && pkg) {
    const manifestVersion = String(manifest.version || "");
    const pkgVersion = String(pkg.version || "");
    assert(manifestVersion === pkgVersion, `manifest.version(${manifestVersion}) 与 package.version(${pkgVersion}) 不一致`, errors);
  }

  if (manifest && versions) {
    const manifestVersion = String(manifest.version || "");
    const mapped = String((versions && versions[manifestVersion]) || "");
    assert(Boolean(mapped), `versions.json 缺少当前版本映射: ${manifestVersion}`, errors);
    assert(mapped === String(manifest.minAppVersion || ""), `versions.json 当前版本映射(${mapped}) 与 manifest.minAppVersion 不一致`, errors);
  }

  if (manifest && releaseManifest) {
    assert(
      String(releaseManifest.version || "") === String(manifest.version || ""),
      `release/manifest.json 版本(${releaseManifest.version}) 与 manifest.json(${manifest.version}) 不一致`,
      errors,
    );
  }

  try {
    const trackedDataJson = runGit(["ls-files", "--", "data.json"]);
    assert(!trackedDataJson, "data.json 不允许被纳入版本控制", errors);
  } catch (error) {
    errors.push(`无法检查 data.json 跟踪状态: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const releaseMain = await fs.readFile(path.join(RELEASE_DIR, "main.js"), "utf8");
    assert(
      !/require\((['"`])\.\/runtime\//.test(releaseMain),
      "release/main.js 仍包含 ./runtime/* 依赖",
      errors,
    );
  } catch (error) {
    errors.push(`无法读取 release/main.js: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (errors.length) {
    console.error("[check-submission] 检查失败:");
    for (const item of errors) {
      console.error(`- ${item}`);
    }
    process.exitCode = 1;
    return;
  }

  const version = manifest ? String(manifest.version || "") : "unknown";
  console.log(`[check-submission] OK version=${version}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[check-submission] FAILED: ${message}`);
  process.exitCode = 1;
});
