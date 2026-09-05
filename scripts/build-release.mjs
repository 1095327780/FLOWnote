#!/usr/bin/env node
import { build } from "esbuild";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  assertBundledSkillReferences,
  collectBundledSkillFiles,
} = require("./check-bundled-skill-references.js");
const {
  splitSkillFrontmatter,
  parseFlowNoteCompletionMetadata,
} = require("../runtime/skill-frontmatter.js");

const ROOT = process.cwd();
const RELEASE_DIR = path.join(ROOT, "release");
const BUNDLED_SKILLS_DIR = path.join(ROOT, "bundled-skills");
const GENERATED_RUNTIME_DIR = path.join(ROOT, "runtime", "generated");
const EMBEDDED_BUNDLED_SKILLS_FILE = path.join(GENERATED_RUNTIME_DIR, "bundled-skills-embedded.js");
const YAML_BROWSER_ENTRY = path.join(
  path.dirname(require.resolve("yaml/package.json")),
  "browser",
  "index.js",
);

// Obsidian desktop exposes Node built-ins, while Obsidian mobile only exposes
// partial compatibility shims. Keep the overall bundle on the Node platform
// for desktop integrations, but force YAML onto its browser entry so the same
// Skill parser has identical semantics on both hosts.
const mobileSafeYamlPlugin = {
  name: "flownote-mobile-safe-yaml",
  setup(buildContext) {
    buildContext.onResolve({ filter: /^yaml$/ }, () => ({ path: YAML_BROWSER_ENTRY }));
  },
};

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

  const relativeFiles = collectBundledSkillFiles(BUNDLED_SKILLS_DIR);
  const fileMap = {};
  const documentMap = {};
  const hash = crypto.createHash("sha1");
  let totalBytes = 0;

  for (const relativePath of relativeFiles) {
    const absPath = path.join(BUNDLED_SKILLS_DIR, relativePath.split("/").join(path.sep));
    const content = await fs.readFile(absPath);
    const text = content.toString("utf8");
    fileMap[relativePath] = text;
    if (/\/(?:SKILL)(?:\.(?:zh-CN|en|ru))?\.md$/.test(`/${relativePath}`)) {
      const parsed = splitSkillFrontmatter(text);
      if (parsed.errorCode) {
        throw new Error(`invalid Skill frontmatter: ${relativePath} (${parsed.errorCode})`);
      }
      const completionPolicy = parseFlowNoteCompletionMetadata(parsed.frontmatter);
      if (completionPolicy.state === "invalid") {
        throw new Error(
          `invalid Skill completion metadata: ${relativePath} (${completionPolicy.errorCode})`,
        );
      }
      const slug = relativePath.split("/", 1)[0];
      if (String(parsed.frontmatter.name || "").trim() !== slug) {
        throw new Error(`Skill name must match its bundled directory: ${relativePath} (expected ${slug})`);
      }
      documentMap[relativePath] = {
        frontmatter: parsed.frontmatter,
        // Keep the body in the canonical raw file map and store only its
        // boundary, avoiding a second copy of every large Skill instruction.
        bodyOffset: text.length - parsed.body.length,
        completionPolicy,
      };
    }
    totalBytes += content.byteLength;
    hash.update(`${relativePath}\n`);
    hash.update(content);
  }

  const versionSeed = hash.digest("hex");
  const embeddedVersion = `${versionSeed}:${relativeFiles.length}`;
  const serializedMap = asciiEscape(JSON.stringify(fileMap));
  const serializedDocuments = asciiEscape(JSON.stringify(documentMap));

  const moduleSource = [
    "\"use strict\";",
    "",
    `const EMBEDDED_BUNDLED_SKILLS_VERSION = \"${embeddedVersion}\";`,
    `const EMBEDDED_BUNDLED_SKILLS_FILE_COUNT = ${relativeFiles.length};`,
    `const EMBEDDED_BUNDLED_SKILLS_FILES = Object.freeze(${serializedMap});`,
    `const EMBEDDED_BUNDLED_SKILL_DOCUMENTS = Object.freeze(${serializedDocuments});`,
    "",
    "module.exports = {",
    "  EMBEDDED_BUNDLED_SKILLS_VERSION,",
    "  EMBEDDED_BUNDLED_SKILLS_FILE_COUNT,",
    "  EMBEDDED_BUNDLED_SKILLS_FILES,",
    "  EMBEDDED_BUNDLED_SKILL_DOCUMENTS,",
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
  assertBundledSkillReferences(BUNDLED_SKILLS_DIR);
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
    plugins: [mobileSafeYamlPlugin],
    sourcemap: false,
    legalComments: "none",
    logLevel: "info",
    loader: {
      ".DS_Store": "empty",
    },
  });

  await copyAsset("manifest.json");
  await copyAsset("styles.css");

  await assertExists("main.js");
  await assertExists("manifest.json");
  await assertExists("styles.css");

  const bundledMain = await fs.readFile(path.join(RELEASE_DIR, "main.js"), "utf8");
  const hasUnbundledRequire = bundledMain.split("\n").some((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return false;
    return /require\((['"`])\.\/runtime\//.test(trimmed);
  });
  if (hasUnbundledRequire) {
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
