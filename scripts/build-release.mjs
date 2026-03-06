#!/usr/bin/env node
import { build } from "esbuild";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

const ROOT = process.cwd();
const RELEASE_DIR = path.join(ROOT, "release");
const BUNDLED_SKILLS_DIR = path.join(ROOT, "bundled-skills");
const GENERATED_RUNTIME_DIR = path.join(ROOT, "runtime", "generated");
const EMBEDDED_BUNDLED_SKILLS_FILE = path.join(GENERATED_RUNTIME_DIR, "bundled-skills-embedded.js");

const SKIP_FILE_BASENAMES = new Set([
  ".DS_Store",
]);
const SKIP_DIR_BASENAMES = new Set([
  "__pycache__",
]);
const SKIP_FILE_SUFFIXES = [
  ".pyc",
];

async function ensureDirClean(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

async function copyAsset(filename) {
  await fs.copyFile(path.join(ROOT, filename), path.join(RELEASE_DIR, filename));
}

async function assertExists(filename) {
  const full = path.join(RELEASE_DIR, filename);
  await fs.access(full);
}

function toPosixPath(value) {
  return String(value || "").split(path.sep).join("/");
}

function shouldSkipBundledEntry(name, isDirectory) {
  const basename = String(name || "");
  if (!basename) return true;
  if (basename.startsWith(".")) return true;
  if (isDirectory && SKIP_DIR_BASENAMES.has(basename)) return true;
  if (!isDirectory && SKIP_FILE_BASENAMES.has(basename)) return true;
  if (!isDirectory && SKIP_FILE_SUFFIXES.some((suffix) => basename.endsWith(suffix))) return true;
  return false;
}

async function collectBundledSkillFiles(rootDir, currentDir = rootDir, output = []) {
  let entries = [];
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return output;
  }

  entries.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  for (const entry of entries) {
    if (!entry) continue;
    if (shouldSkipBundledEntry(entry.name, entry.isDirectory())) continue;
    const absPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await collectBundledSkillFiles(rootDir, absPath, output);
      continue;
    }
    if (!entry.isFile()) continue;
    const relative = toPosixPath(path.relative(rootDir, absPath));
    if (!relative) continue;
    output.push(relative);
  }
  return output;
}

function asciiEscape(value) {
  return String(value || "").replace(/[^\x20-\x7E]/g, (char) => {
    const code = char.codePointAt(0);
    if (!Number.isInteger(code)) return "";
    if (code <= 0xffff) return `\\u${code.toString(16).padStart(4, "0")}`;
    const normalized = code - 0x10000;
    const high = 0xd800 + ((normalized >> 10) & 0x3ff);
    const low = 0xdc00 + (normalized & 0x3ff);
    return `\\u${high.toString(16).padStart(4, "0")}\\u${low.toString(16).padStart(4, "0")}`;
  });
}

async function buildEmbeddedBundledSkillsModule() {
  await fs.mkdir(GENERATED_RUNTIME_DIR, { recursive: true });

  const relativeFiles = await collectBundledSkillFiles(BUNDLED_SKILLS_DIR);
  const fileMap = {};
  const hash = crypto.createHash("sha1");
  let totalBytes = 0;

  for (const relativePath of relativeFiles) {
    const absPath = path.join(BUNDLED_SKILLS_DIR, relativePath.split("/").join(path.sep));
    const content = await fs.readFile(absPath);
    fileMap[relativePath] = content.toString("base64");
    totalBytes += content.byteLength;
    hash.update(`${relativePath}\n`);
    hash.update(content);
  }

  const versionSeed = hash.digest("hex");
  const embeddedVersion = `${versionSeed}:${relativeFiles.length}`;
  const serializedMap = asciiEscape(JSON.stringify(fileMap));

  const moduleSource = [
    "\"use strict\";",
    "",
    `const EMBEDDED_BUNDLED_SKILLS_VERSION = \"${embeddedVersion}\";`,
    `const EMBEDDED_BUNDLED_SKILLS_FILE_COUNT = ${relativeFiles.length};`,
    `const EMBEDDED_BUNDLED_SKILLS_FILES = Object.freeze(${serializedMap});`,
    "",
    "module.exports = {",
    "  EMBEDDED_BUNDLED_SKILLS_VERSION,",
    "  EMBEDDED_BUNDLED_SKILLS_FILE_COUNT,",
    "  EMBEDDED_BUNDLED_SKILLS_FILES,",
    "};",
    "",
  ].join("\n");

  await fs.writeFile(EMBEDDED_BUNDLED_SKILLS_FILE, moduleSource, "utf8");
  return {
    fileCount: relativeFiles.length,
    totalBytes,
    embeddedVersion,
    outputPath: EMBEDDED_BUNDLED_SKILLS_FILE,
  };
}

async function main() {
  const embedResult = await buildEmbeddedBundledSkillsModule();
  console.log(
    `[build-release] embedded bundled-skills files=${embedResult.fileCount} bytes=${embedResult.totalBytes} version=${embedResult.embeddedVersion}`,
  );
  await ensureDirClean(RELEASE_DIR);

  await build({
    entryPoints: [path.join(ROOT, "main.js")],
    outfile: path.join(RELEASE_DIR, "main.js"),
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "es2020",
    external: ["obsidian"],
    sourcemap: false,
    legalComments: "none",
    logLevel: "info",
  });

  await copyAsset("manifest.json");
  await copyAsset("styles.css");

  await assertExists("main.js");
  await assertExists("manifest.json");
  await assertExists("styles.css");

  const bundledMain = await fs.readFile(path.join(RELEASE_DIR, "main.js"), "utf8");
  if (/require\((['"`])\.\/runtime\//.test(bundledMain)) {
    throw new Error("release/main.js 仍依赖 ./runtime/*，请检查 bundling");
  }

  const manifest = JSON.parse(await fs.readFile(path.join(RELEASE_DIR, "manifest.json"), "utf8"));
  const version = String(manifest.version || "").trim();
  if (!version) throw new Error("release/manifest.json 缺少 version");

  console.log(`[build-release] OK version=${version} dir=${RELEASE_DIR}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[build-release] FAILED: ${message}`);
  process.exitCode = 1;
});
