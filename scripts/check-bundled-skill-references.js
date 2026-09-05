#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const LOCALIZED_MARKDOWN_SUFFIX = /\.(?:zh-CN|en|ru)\.md$/;
const RESOURCE_DIRECTORY_NAMES = Object.freeze(["references", "assets", "scripts"]);

// These entries are local filesystem metadata/cache, not Skill resources. The
// release builder and this parity checker intentionally share this policy so a
// new references/assets/scripts file can never disappear silently. If another
// non-distributable entry is needed, add it here with a reason and a test.
const BUNDLED_SKILL_EMBED_EXCLUSIONS = Object.freeze({
  files: Object.freeze([".DS_Store"]),
  directories: Object.freeze(["__pycache__"]),
  suffixes: Object.freeze([".pyc"]),
});

function toPosixPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function shouldSkipBundledEntry(name, isDirectory) {
  const basename = String(name || "");
  if (!basename) return true;
  if (basename.startsWith(".")) return true;
  if (isDirectory && BUNDLED_SKILL_EMBED_EXCLUSIONS.directories.includes(basename)) return true;
  if (!isDirectory && BUNDLED_SKILL_EMBED_EXCLUSIONS.files.includes(basename)) return true;
  if (!isDirectory && BUNDLED_SKILL_EMBED_EXCLUSIONS.suffixes.some((suffix) => basename.endsWith(suffix))) return true;
  return false;
}

function isDirectory(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function collectBundledSkillFiles(rootDir, currentDir = rootDir, output = []) {
  if (!rootDir || !currentDir || !isDirectory(currentDir)) return output;
  const entries = fs.readdirSync(currentDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!entry || shouldSkipBundledEntry(entry.name, entry.isDirectory())) continue;
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      collectBundledSkillFiles(rootDir, entryPath, output);
      continue;
    }
    if (!entry.isFile()) continue;
    const relative = toPosixPath(path.relative(rootDir, entryPath));
    if (relative) output.push(relative);
  }
  return output;
}

function collectBundledSkillFileMap(rootDir) {
  const root = path.resolve(String(rootDir || ""));
  const files = new Map();
  for (const relativePath of collectBundledSkillFiles(root)) {
    files.set(relativePath, fs.readFileSync(path.join(root, ...relativePath.split("/"))));
  }
  return files;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value == null ? "" : value), "utf8");
}

function sha256(value) {
  return crypto.createHash("sha256").update(toBuffer(value)).digest("hex");
}

function mapEntries(value) {
  if (value instanceof Map) return [...value.entries()];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value);
}

function compareBundledSkillFileMaps(sourceFiles, embeddedFiles) {
  const sourceEntries = mapEntries(sourceFiles)
    .map(([key, value]) => [toPosixPath(key), value])
    .sort(([left], [right]) => left.localeCompare(right));
  const embeddedEntries = mapEntries(embeddedFiles)
    .map(([key, value]) => [toPosixPath(key), value])
    .sort(([left], [right]) => left.localeCompare(right));
  const sourceMap = new Map(sourceEntries);
  const embeddedMap = new Map(embeddedEntries);
  const expected = [...sourceMap.keys()].sort((left, right) => left.localeCompare(right));
  const actual = [...embeddedMap.keys()].sort((left, right) => left.localeCompare(right));
  const missing = expected.filter((key) => !embeddedMap.has(key));
  const extra = actual.filter((key) => !sourceMap.has(key));
  const mismatched = expected.filter((key) => (
    embeddedMap.has(key) && sha256(sourceMap.get(key)) !== sha256(embeddedMap.get(key))
  ));
  const invalidEmbeddedPaths = actual.filter((key) => !normalizeSafeRelativePath(key));
  return { expected, actual, missing, extra, mismatched, invalidEmbeddedPaths };
}

function formatParityProblems(result) {
  const lines = [];
  if (result.missing.length) lines.push(`missing: ${result.missing.join(", ")}`);
  if (result.extra.length) lines.push(`extra: ${result.extra.join(", ")}`);
  if (result.mismatched.length) lines.push(`changed: ${result.mismatched.join(", ")}`);
  if (result.invalidEmbeddedPaths.length) lines.push(`unsafe embedded paths: ${result.invalidEmbeddedPaths.join(", ")}`);
  return lines.join("\n");
}

function assertBundledSkillFileParity(sourceRoot, embeddedFiles) {
  const root = path.resolve(String(sourceRoot || ""));
  if (!isDirectory(root)) {
    throw new Error(`bundled skills root does not exist or is not a directory: ${root}`);
  }
  const result = compareBundledSkillFileMaps(collectBundledSkillFileMap(root), embeddedFiles);
  if (result.missing.length || result.extra.length || result.mismatched.length || result.invalidEmbeddedPaths.length) {
    throw new Error(`Bundled Skill embedded map is stale or incomplete:\n${formatParityProblems(result)}`);
  }
  return result;
}

function normalizeSafeRelativePath(value) {
  const normalized = toPosixPath(value).trim();
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return "";
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return "";
  return normalized;
}

function normalizeReferencePath(value) {
  let normalized = String(value || "").trim();
  normalized = normalized
    .replace(/^<|>$/g, "")
    .replace(/^['"]|['"]$/g, "")
    .replace(/^`|`$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  if (!normalized || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/")) return "";
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return "";
  return normalized;
}

function hasResourceDirectory(referencePath) {
  const segments = toPosixPath(referencePath).split("/");
  return RESOURCE_DIRECTORY_NAMES.some((directory) => segments.includes(directory));
}

function hasPathTraversal(value) {
  const normalized = toPosixPath(value);
  return normalized.split("/").includes("..") || /(^|\/)\.\.(?:\/|$)/.test(normalized);
}

function trimReferenceCandidate(value) {
  let candidate = String(value || "").trim();
  candidate = candidate.replace(/^<|>$/g, "").replace(/^['"]|['"]$/g, "").replace(/^`|`$/g, "");
  const delimiter = candidate.search(/[<>'"`]/);
  if (delimiter >= 0) candidate = candidate.slice(0, delimiter);
  // Markdown prose commonly places punctuation immediately after the path.
  candidate = candidate.replace(/[\]})>,.;:!?。；，、]+$/u, "");
  const extension = candidate.match(/\.(?:md|json|ya?ml|js|mjs|cjs|ts|py|sh|txt|csv|png|jpe?g|svg|webp)/i);
  if (extension && extension.index !== undefined) {
    candidate = candidate.slice(0, extension.index + extension[0].length);
  }
  return candidate;
}

function extractResourcePathCandidates(text) {
  const source = String(text || "");
  const candidates = [];
  const add = (value) => {
    const candidate = trimReferenceCandidate(value);
    if (!candidate || candidate.endsWith("/")) return;
    if (!hasResourceDirectory(candidate)) return;
    if (!candidates.includes(candidate)) candidates.push(candidate);
  };

  // YAML lists and ordinary prose are intentionally covered by the same
  // resource-prefix scan; this accepts references/assets/scripts paths even
  // when they are not wrapped in Markdown syntax.
  const prefix = /(?:\/?(?:\.opencode|\.flownote|\.agents)\/skills\/[A-Za-z0-9_-]+\/)?(?:[A-Za-z0-9_-]+\/)?(?:references|assets|scripts)\//g;
  for (const match of source.matchAll(prefix)) {
    const start = match.index || 0;
    const preceding = source.slice(Math.max(0, start - 120), start);
    if (/(?:\.\.\/|\.\.\\)[^\r\n`"'<>)]*$/.test(preceding)) continue;
    const tail = source.slice(start);
    const line = tail.split(/\r?\n/, 1)[0];
    add(line);
  }
  return candidates;
}

function resolveSkillReference(rawReference, skillSlug) {
  const raw = String(rawReference || "").trim().replace(/\\/g, "/");
  if (!raw) return { reference: "", reason: "must be a safe relative references/, assets/, or scripts/ path" };
  if (hasPathTraversal(raw)) {
    return { reference: raw, reason: "path traversal is not allowed in Skill resource references" };
  }

  let candidate = raw.replace(/^\.\//, "");
  const externalSkill = candidate.match(/^\/?(?:\.opencode|\.flownote|\.agents)\/skills\/([^/]+)\/(.+)$/);
  if (externalSkill) candidate = `${externalSkill[1]}/${externalSkill[2]}`;

  const localSkill = String(skillSlug || "").trim();
  if (RESOURCE_DIRECTORY_NAMES.some((directory) => candidate.startsWith(`${directory}/`))) {
    candidate = `${localSkill}/${candidate}`;
  }
  const normalized = normalizeReferencePath(candidate);
  if (!normalized || !normalized.includes("/")) {
    return { reference: raw, reason: "must be a safe relative references/, assets/, or scripts/ path" };
  }
  const segments = normalized.split("/");
  const resourceIndex = segments.findIndex((segment) => RESOURCE_DIRECTORY_NAMES.includes(segment));
  if (resourceIndex < 1 || resourceIndex >= segments.length - 1) {
    return { reference: raw, reason: "must resolve to a Skill references/, assets/, or scripts/ file" };
  }
  if (segments[0] !== localSkill && !externalSkill) {
    return { reference: raw, reason: "cross-Skill resource references must name a bundled Skill" };
  }
  return { reference: normalized, reason: "" };
}

function hasMaterializedResource(skillRoot, referencePath) {
  const direct = path.join(skillRoot, ...referencePath.split("/"));
  if (isFile(direct)) return true;
  if (!referencePath.endsWith(".md")) return false;
  const stem = direct.slice(0, -".md".length);
  return ["zh-CN", "en", "ru"].some((locale) => isFile(`${stem}.${locale}.md`));
}

function hasEmbeddedResource(embeddedFiles, referencePath) {
  const entries = embeddedFiles instanceof Map
    ? embeddedFiles
    : new Map(mapEntries(embeddedFiles).map(([key, value]) => [toPosixPath(key), value]));
  if (entries.has(referencePath)) return true;
  if (!referencePath.endsWith(".md")) return false;
  const stem = referencePath.slice(0, -".md".length);
  return ["zh-CN", "en", "ru"].some((locale) => entries.has(`${stem}.${locale}.md`));
}

function walkSkillDocuments(rootDir, currentDir = rootDir, output = []) {
  if (!rootDir || !currentDir || !isDirectory(currentDir)) return output;
  const entries = fs.readdirSync(currentDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!entry || shouldSkipBundledEntry(entry.name, entry.isDirectory())) continue;
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkSkillDocuments(rootDir, entryPath, output);
      continue;
    }
    if (entry.isFile() && /^SKILL(?:\.[^.]+)?\.md$/.test(entry.name)) output.push(entryPath);
  }
  return output;
}

function collectBundledSkillReferenceProblems(bundledRoot, options = {}) {
  const rootDir = path.resolve(String(bundledRoot || ""));
  if (!isDirectory(rootDir)) {
    return [{ skillFile: "", reference: "", reason: `bundled skills root does not exist or is not a directory: ${rootDir}` }];
  }
  const embeddedFiles = options && options.embeddedFiles;
  const useEmbeddedMap = embeddedFiles !== undefined;
  const problems = [];
  for (const skillFile of walkSkillDocuments(rootDir)) {
    const skillFileRelative = toPosixPath(path.relative(rootDir, skillFile));
    const skillSlug = skillFileRelative.split("/")[0];
    const text = fs.readFileSync(skillFile, "utf8");
    const seen = new Set();

    // Detect traversal even when a broad prefix scan would otherwise skip the
    // leading ../ segment and find only the nested references/ token.
    for (const match of text.matchAll(/(?:^|[\s"'(<`])((?:\.\.\/|\.\.\\)[^\r\n`"'<>)]*)/g)) {
      const raw = trimReferenceCandidate(match[1]);
      if (!hasResourceDirectory(raw)) continue;
      const key = `invalid:${raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      problems.push({ skillFile: skillFileRelative, reference: raw, reason: "path traversal is not allowed in Skill resource references" });
    }

    for (const rawReference of extractResourcePathCandidates(text)) {
      const resolved = resolveSkillReference(rawReference, skillSlug);
      const key = `${resolved.reference}:${resolved.reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!resolved.reference || resolved.reason) {
        problems.push({ skillFile: skillFileRelative, reference: rawReference, reason: resolved.reason || "must be a safe relative references/, assets/, or scripts/ path" });
        continue;
      }
      const exists = useEmbeddedMap
        ? hasEmbeddedResource(embeddedFiles, resolved.reference)
        : (() => {
          const segments = resolved.reference.split("/");
          const referencedSkillDir = path.join(rootDir, segments[0]);
          return hasMaterializedResource(referencedSkillDir, segments.slice(1).join("/"));
        })();
      if (!exists) {
        problems.push({
          skillFile: skillFileRelative,
          reference: rawReference,
          reason: useEmbeddedMap
            ? "does not exist in the embedded Skill map (including localized Markdown sidecars)"
            : "does not exist in this Skill package (including localized Markdown sidecars)",
        });
      } else if (LOCALIZED_MARKDOWN_SUFFIX.test(resolved.reference)) {
        problems.push({
          skillFile: skillFileRelative,
          reference: resolved.reference,
          reason: "must use its canonical .md path because localized sidecars are materialized then removed",
        });
      }
    }
  }
  return problems;
}

function assertBundledSkillReferences(bundledRoot, options = {}) {
  const problems = collectBundledSkillReferenceProblems(bundledRoot, options);
  if (!problems.length) return;
  const details = problems
    .map((problem) => `- ${problem.skillFile}: \`${problem.reference}\` ${problem.reason}`)
    .join("\n");
  throw new Error(`Bundled Skill resource references are incomplete:\n${details}`);
}

function main() {
  const bundledRoot = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(process.cwd(), "bundled-skills");
  assertBundledSkillReferences(bundledRoot);
  console.log(`[check-bundled-skill-references] OK root=${bundledRoot}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[check-bundled-skill-references] FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  BUNDLED_SKILL_EMBED_EXCLUSIONS,
  RESOURCE_DIRECTORY_NAMES,
  collectBundledSkillFiles,
  collectBundledSkillFileMap,
  compareBundledSkillFileMaps,
  assertBundledSkillFileParity,
  collectBundledSkillReferenceProblems,
  assertBundledSkillReferences,
  extractResourcePathCandidates,
  normalizeReferencePath,
  resolveSkillReference,
};
