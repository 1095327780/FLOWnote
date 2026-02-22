#!/usr/bin/env node
import { build } from "esbuild";
import fs from "fs/promises";
import path from "path";

const ROOT = process.cwd();
const RELEASE_DIR = path.join(ROOT, "release");

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

async function main() {
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
