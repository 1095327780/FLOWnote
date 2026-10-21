// Bundle deterministic preparation; semantic source/relationship decisions stay with the model.
const { buildTool } = require("../tool-registry");
const { contentFingerprint } = require("../file-state-cache");
const { defaultNormalizePath } = require("./vault-read");
const { resolveReadablePath, toCanonicalMemoryPath } = require("./vault-path-aliases");
const { pageReadOutput, estimateTextTokens } = require("./read-output-budget");
const { throwIfToolAborted } = require("../vault-effect-verifiers");

function safeNotePath(value, normalize) {
  const raw = String(value || "");
  if (!raw || /^(?:[\\/]|[a-z]:)/i.test(raw) || raw.split(/[\\/]/).some(p => p === ".." || p.startsWith("."))) {
    throw new Error("Use a vault-relative Markdown note path, without hidden folders or traversal.");
  }
  const path = normalize(raw);
  if (!path.toLowerCase().endsWith(".md")) throw new Error("A Markdown note path is required.");
  return path;
}

function createCardPrepareTool({ vault, normalizePath, paths } = {}) {
  const normalize = typeof normalizePath === "function" ? normalizePath : defaultNormalizePath;
  const configured = paths || {};
  return buildTool({
    name: "card_prepare",
    description: "Prepare an ah-card workflow locally: return configured folders, STATUS, an explicitly supplied source, and a paged topic/domain title catalog. Does not classify the source, choose relations, or claim semantic completeness. Read full source/related notes with vault_read and expand search with vault_search before confirming a draft. Omit sourcePath when the user already provided its text; use catalogOffset for further titles, not to cap related notes.",
    inputSchema: { type: "object", properties: {
      sourcePath: { type: "string", description: "Exact source note path supplied by the user; do not guess." },
      catalogOffset: { type: "integer", minimum: 0 },
    } },
    capabilities: input => ({ effect: "observation", risk: "low", concurrency: "parallel", presentation: "read",
      targets: [configured.statusPath, input && input.sourcePath].filter(Boolean) }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async validate(input) {
      try {
        if (input && input.sourcePath !== undefined) safeNotePath(input.sourcePath, normalize);
        if (input && input.catalogOffset !== undefined && (!Number.isInteger(input.catalogOffset) || input.catalogOffset < 0)) {
          throw new Error("catalogOffset must be a non-negative integer.");
        }
        return { ok: true };
      } catch (error) { return { ok: false, error: error.message }; }
    },
    async *execute(input = {}, ctx) {
      const result = { paths: configured, evidence: [], catalog: null,
        nextSteps: "Candidates are not verified relationships. Read enough original evidence, expand terms/synonyms and search scope as needed, and confirm title/content/relations with the user before card_commit. A catalog page is not a coverage or semantic recall guarantee." };
      const pendingReads = [];
      const readPaths = [...new Set([configured.statusPath, input.sourcePath].filter(Boolean))];
      // Leave half of the host allowance for JSON envelopes, catalogs, and recovery notices.
      const readCtx = ctx && Number.isInteger(ctx.toolResultBudgetTokens)
        ? { ...ctx, toolResultBudgetTokens: Math.floor(ctx.toolResultBudgetTokens / (2 * Math.max(1, readPaths.length))) }
        : ctx;
      for (const requested of readPaths) {
        throwIfToolAborted(ctx, "card_prepare");
        safeNotePath(toCanonicalMemoryPath(requested), normalize);
        const path = resolveReadablePath(vault, normalize(requested));
        const file = vault.getFileByPath(path);
        if (!file) { result.evidence.push({ path, missing: true }); continue; }
        try {
          const text = String(await vault.cachedRead(file));
          const page = pageReadOutput(text, { ctx: readCtx });
          result.evidence.push({ path, version: contentFingerprint(text), ...page,
            ...(page.truncated ? { continueWith: { tool: "vault_read", path, byteOffset: page.nextOffset } } : {}) });
          // An excerpt is never represented as a full model read.
          if (!page.truncated) pendingReads.push({ path, text });
        } catch (error) { result.evidence.push({ path, error: error.message, retryWith: "vault_read" }); }
      }
      const folders = [configured.topicNotes, configured.domainPages].filter(Boolean).map(p => normalize(p).replace(/\/+$/, ""));
      const files = typeof vault.getMarkdownFiles === "function" ? vault.getMarkdownFiles() : null;
      if (files) {
        const entries = files.filter(file => folders.some(folder => file.path.startsWith(`${folder}/`)))
          .map(file => ({ path: file.path, title: file.basename || file.path.split("/").pop().replace(/\.md$/i, "") }))
          .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        const offset = input.catalogOffset || 0;
        const page = entries.slice(offset, offset + 50);
        result.catalog = { entries: page, total: entries.length, offset,
          nextOffset: offset + page.length < entries.length ? offset + page.length : null,
          scope: folders, snapshot: false, note: "Live title catalog only; repeat from offset 0 if files change. No semantic filtering has been performed." };
      } else result.catalog = { unavailable: true, retryWith: "vault_list" };
      const budget = ctx && ctx.toolResultBudgetTokens;
      if (Number.isInteger(budget)) {
        // Fit the complete JSON envelope, never silently cut a source or its truncation notice.
        while (result.catalog && result.catalog.entries && result.catalog.entries.length
          && estimateTextTokens(JSON.stringify(result)) > budget) {
          result.catalog.entries.pop();
          result.catalog.nextOffset = result.catalog.offset + result.catalog.entries.length;
        }
        if (estimateTextTokens(JSON.stringify(result)) > budget
          || (result.catalog && result.catalog.total > (input.catalogOffset || 0) && !result.catalog.entries.length)) {
          yield { type: "result", isError: true, content: "card_prepare: remaining context is too small for the evidence bundle. Use vault_read and vault_list separately; no preparation evidence was marked as read." };
          return;
        }
      }
      for (const { path, text } of pendingReads) {
        if (ctx && ctx.fileStateCache) ctx.fileStateCache.recordRead(path, text, { visibleRanges: [[0, text.length]] });
      }
      yield { type: "result", content: JSON.stringify(result), data: result };
    },
  });
}

module.exports = { createCardPrepareTool, safeNotePath };
