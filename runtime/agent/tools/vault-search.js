// vault_search: complete lexical content search with bounded, resumable output.
// Each invocation reads the current vault; no retained index can go stale after edits.

const { buildTool } = require("../tool-registry");
const { globToRegExp } = require("./vault-list");
const { estimateTextTokens } = require("./read-output-budget");
const { throwIfToolAborted } = require("../vault-effect-verifiers");

const DEFAULT_MAX_MATCHES = 100;
const MAX_PAGE_MATCHES = 100;
const FAILURE_SAMPLE_SIZE = 8;

const DESCRIPTION =
  "Search note contents inside the user's Obsidian vault. `query` is a plain " +
  "substring unless `regex: true`. The default search checks every file in " +
  "the requested scope, including note bodies; this is lexical search, not " +
  "semantic recall. Results are bounded pages of `path:line: text`. Use " +
  "`next_cursor` with the same query and filters to continue. `max_files` " +
  "optionally limits files read per call, with a cursor for remaining files. " +
  "Pages read the live vault; restart the search if files change between pages. " +
  "Use `path`, `pattern`, or `extensions` to scope the search, and vault_read " +
  "to inspect a matching note.";

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Plain substring unless `regex: true`.",
    },
    regex: {
      type: "boolean",
      description: "Treat `query` as a JavaScript regular expression. Default false.",
    },
    case_sensitive: {
      type: "boolean",
      description: "Default false (case-insensitive).",
    },
    path: {
      type: "string",
      description: "Scope to a subtree of the vault.",
    },
    pattern: {
      type: "string",
      description: "Optional glob against the path tail (e.g. daily/*.md).",
    },
    extensions: {
      type: "array",
      items: { type: "string" },
      description: "Extensions to search. Defaults to [\"md\"].",
    },
    max_files: {
      type: "integer",
      description: "Optional files to read on this page. Omit to scan the entire scope.",
      minimum: 1,
    },
    max_matches: {
      type: "integer",
      description: "Matching lines to return on this page. Default and maximum 100.",
      minimum: 1,
      maximum: MAX_PAGE_MATCHES,
    },
    cursor: {
      type: "string",
      description: "next_cursor from the prior page; keep the query and filters unchanged.",
    },
  },
  required: ["query"],
};

function defaultNormalizePath(path) {
  return String(path || "")
    .replace(/\\+/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function extOf(path) {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot <= slash ? "" : path.slice(dot + 1).toLowerCase();
}

function listFiles(vault) {
  if (typeof vault.getAllLoadedFiles === "function") {
    return (vault.getAllLoadedFiles() || []).filter(
      (f) => f && typeof f.path === "string" && !Array.isArray(f.children),
    );
  }
  if (typeof vault.getMarkdownFiles === "function") {
    return (vault.getMarkdownFiles() || []).filter((f) => f && typeof f.path === "string");
  }
  if (typeof vault.listFilesForSearch === "function") {
    return vault.listFilesForSearch() || [];
  }
  throw new Error("vault_search: vault has no file enumeration API");
}

function snippetForLine(line, hitIndex) {
  if (line.length <= 200) return line.replace(/^\s+/, "");
  const start = Math.max(0, hitIndex - 80);
  const end = Math.min(line.length, start + 200);
  return `${start ? "…" : ""}${line.slice(start, end).replace(/^\s+/, "")}${end < line.length ? "…" : ""}`;
}

function searchSpec(input, normalize) {
  return {
    query: input.query,
    regex: !!input.regex,
    case_sensitive: !!input.case_sensitive,
    path: normalize(input.path || ""),
    pattern: input.pattern || "",
    extensions: Array.isArray(input.extensions) && input.extensions.length
      ? [...new Set(input.extensions.map((e) => String(e).toLowerCase().replace(/^\./, "")))].sort()
      : ["md"],
  };
}

function decodeCursor(value) {
  try {
    const parsed = JSON.parse(decodeURIComponent(value));
    if (parsed && parsed.v === 1 && typeof parsed.spec === "string" &&
        typeof parsed.path === "string" &&
        Number.isSafeInteger(parsed.failures) && parsed.failures >= 0 &&
        (parsed.line === null || Number.isSafeInteger(parsed.line) && parsed.line >= 1)) {
      return parsed;
    }
  } catch (_) {
    // A malformed cursor is an input error, not an empty search.
  }
  return null;
}

function makeCursor(spec, path, line, failures) {
  return encodeURIComponent(JSON.stringify({ v: 1, spec, path, line, failures }));
}

function matcherFor(spec) {
  if (spec.regex) {
    const re = new RegExp(spec.query, spec.case_sensitive ? "" : "i");
    return (line) => {
      const match = re.exec(line);
      return match ? match.index : -1;
    };
  }
  if (spec.case_sensitive) return (line) => line.indexOf(spec.query);
  const needle = spec.query.toLowerCase();
  return (line) => line.toLowerCase().indexOf(needle);
}

function candidateFiles(vault, spec) {
  const prefix = spec.path ? `${spec.path}/` : "";
  const extensions = new Set(spec.extensions);
  const pattern = spec.pattern ? globToRegExp(spec.pattern) : null;
  const candidates = [];
  for (const file of listFiles(vault)) {
    if (spec.path && file.path !== spec.path && !file.path.startsWith(prefix)) continue;
    if (!extensions.has(extOf(file.path))) continue;
    if (pattern) {
      const tail = spec.path ? file.path.slice(prefix.length) : file.path;
      if (!pattern.test(tail)) continue;
    }
    candidates.push(file);
  }
  candidates.sort((a, b) => a.path.localeCompare(b.path));
  return candidates;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** @returns {import('../tool-registry').ToolDef} */
function createVaultSearchTool({ vault, normalizePath } = {}) {
  if (!vault) throw new Error("createVaultSearchTool: vault required");
  if (typeof vault.cachedRead !== "function") {
    throw new Error("createVaultSearchTool: vault.cachedRead required");
  }
  const normalize = typeof normalizePath === "function" ? normalizePath : defaultNormalizePath;

  return buildTool({
    name: "vault_search",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    capabilities: (input) => ({
      effect: "observation",
      risk: "low",
      concurrency: "parallel",
      presentation: "search",
      targets: [normalize((input && input.path) || "") || "/"],
    }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,

    async validate(input) {
      if (!input || typeof input.query !== "string" || input.query.length === 0) {
        return { ok: false, error: "query must be a non-empty string." };
      }
      if (input.regex) {
        try {
          // eslint-disable-next-line no-new
          new RegExp(input.query);
        } catch (error) {
          return { ok: false, error: `Invalid regex: ${error.message || error}` };
        }
      }
      if (input.max_matches !== undefined && (!Number.isInteger(input.max_matches) ||
          input.max_matches < 1 || input.max_matches > MAX_PAGE_MATCHES)) {
        return { ok: false, error: `max_matches must be an integer from 1 to ${MAX_PAGE_MATCHES}.` };
      }
      if (input.max_files !== undefined && (!Number.isInteger(input.max_files) || input.max_files < 1)) {
        return { ok: false, error: "max_files must be a positive integer." };
      }
      if (input.cursor !== undefined) {
        const decoded = typeof input.cursor === "string" ? decodeCursor(input.cursor) : null;
        if (!decoded || decoded.spec !== JSON.stringify(searchSpec(input, normalize))) {
          return { ok: false, error: "cursor is invalid or does not match the query and filters." };
        }
      }
      return { ok: true };
    },

    userFacingName(input) {
      return input && typeof input.query === "string" ? input.query : "";
    },

    async *execute(input, ctx) {
      const resultBudget = ctx && Number.isInteger(ctx.toolResultBudgetTokens)
        && ctx.toolResultBudgetTokens >= 0 ? ctx.toolResultBudgetTokens : Infinity;
      if (resultBudget === 0) {
        yield { type: "result", isError: true,
          content: "vault_search: no result context remains. Narrow the query or scope and retry; no search coverage was claimed." };
        return;
      }
      throwIfToolAborted(ctx, "vault_search_start");
      const spec = searchSpec(input, normalize);
      const specKey = JSON.stringify(spec);
      const cursor = input.cursor ? decodeCursor(input.cursor) : null;
      if (input.cursor && (!cursor || cursor.spec !== specKey)) {
        throw new Error("vault_search: cursor is invalid or does not match the query and filters");
      }
      const maxMatches = input.max_matches === undefined ? DEFAULT_MAX_MATCHES : input.max_matches;
      const maxFiles = input.max_files === undefined ? Infinity : input.max_files;
      if (!Number.isInteger(maxMatches) || maxMatches < 1 || maxMatches > MAX_PAGE_MATCHES ||
          maxFiles !== Infinity && (!Number.isInteger(maxFiles) || maxFiles < 1)) {
        throw new RangeError("vault_search: invalid max_matches or max_files");
      }
      const matches = matcherFor(spec);
      const candidates = candidateFiles(vault, spec);
      throwIfToolAborted(ctx, "vault_search_enumeration");
      const after = cursor ? cursor.path : null;
      const pending = after === null ? candidates : candidates.filter((f) => {
        const order = f.path.localeCompare(after);
        return order > 0 || order === 0 && cursor.line !== null;
      });
      const filesBeforeCursor = candidates.length - pending.length;

      const hits = [];
      const failures = [];
      let failedCount = 0;
      let scanned = 0;
      let found = 0;
      let filesWithMatches = 0;
      let lastScanned = null;

      for (const file of pending) {
        throwIfToolAborted(ctx, "vault_search_file");
        if (scanned >= maxFiles) break;
        scanned += 1;
        lastScanned = file.path;
        let raw;
        try {
          raw = typeof file.read === "function" ? await file.read() : await vault.cachedRead(file);
          throwIfToolAborted(ctx, "vault_search_read");
        } catch (error) {
          if (error && (error.name === "AbortError" || error.code === "ABORT_ERR")) throw error;
          failedCount += 1;
          if (failures.length < FAILURE_SAMPLE_SIZE) {
            const detail = String(error && error.message ? error.message : error).replace(/[\r\n]+/g, " ").slice(0, 160);
            failures.push(`${file.path}: ${detail}`);
          }
          continue;
        }
        // Search the whole note. Only returned snippets are capped; body hits beyond
        // the old 512 KiB read cap must remain discoverable.
        const fileLines = String(raw == null ? "" : raw).split(/\r?\n/);
        const start = cursor && file.path === cursor.path ? cursor.line : 0;
        let hitInFile = false;
        for (let i = start; i < fileLines.length; i += 1) {
          if ((i & 255) === 0) throwIfToolAborted(ctx, "vault_search_lines");
          const line = fileLines[i];
          const hitIndex = matches(line);
          if (hitIndex < 0) continue;
          found += 1;
          hitInFile = true;
          if (hits.length < maxMatches) {
            hits.push({ path: file.path, line: i + 1,
              text: `${file.path}:${i + 1}: ${snippetForLine(line, hitIndex)}` });
          }
        }
        if (hitInFile) filesWithMatches += 1;
      }

      const remainingFiles = pending.length - scanned;
      const totalFailures = (cursor ? cursor.failures : 0) + failedCount;
      const coverage = `Coverage: ${plural(candidates.length, "eligible file")}; ` +
        `${plural(filesBeforeCursor, "file")} before cursor; ` +
        `${plural(scanned, "file read")} attempted on this page; ` +
        `${plural(scanned - failedCount, "file")} read successfully; ` +
        `${plural(remainingFiles, "unread candidate")}; ` +
        `${plural(failedCount, "read failure")} on this page` +
        (cursor ? ` (${totalFailures} across pages).` : ".");
      const formatPage = (count, failureSampleCount) => {
        const remainingMatches = found - count;
        const hasMore = remainingMatches > 0 || remainingFiles > 0;
        const lastReturned = count ? hits[count - 1] : null;
        const resumeAtHit = remainingMatches > 0;
        const nextCursor = hasMore && (lastReturned || lastScanned)
          ? makeCursor(specKey, resumeAtHit ? lastReturned.path : lastScanned,
            resumeAtHit ? lastReturned.line : null, totalFailures)
          : null;
        const summary = count
          ? `Returned ${plural(count, "match")}; scanned portion has ` +
            `${plural(found, "matching line")} in ${plural(filesWithMatches, "file")}.`
          : "vault_search: no matches in successfully read files on this page.";
        const details = [];
        if (remainingMatches > 0) {
          const reason = count < hits.length ? "tool result budget" : `max_matches=${maxMatches}`;
          details.push(`[vault_search: truncated at ${reason}; ${plural(remainingMatches, "matching line")} remains in scanned files.]`);
        }
        if (nextCursor) details.push(`next_cursor: ${nextCursor}`);
        else if (totalFailures) details.push("No remaining candidates; coverage is incomplete due to read failures. Retry the search after resolving them.");
        else details.push("Search page complete; no remaining matches or candidates.");
        if (failedCount) {
          details.push(failureSampleCount
            ? `Read failures (first ${failureSampleCount} of ${failedCount}):\n${failures.slice(0, failureSampleCount).join("\n")}`
            : `${plural(failedCount, "read failure")}; narrow the scope to inspect failed paths.`);
        }
        if (count) details.push(hits.slice(0, count).map(hit => hit.text).join("\n"));
        return { type: "result", content: [summary, coverage, ...details].join("\n"), data: {
          eligible_files: candidates.length,
          files_before_cursor: filesBeforeCursor,
          files_scanned: scanned,
          files_read_successfully: scanned - failedCount,
          unread_candidates: remainingFiles,
          read_failures: failedCount,
          read_failures_across_pages: totalFailures,
          matching_lines_in_scanned_portion: found,
          matches_returned: count,
          remaining_matches_in_scanned_files: remainingMatches,
          next_cursor: nextCursor,
          budget_limited: count < hits.length,
          complete: !hasMore && totalFailures === 0,
        } };
      };
      // The full scan happens once. Shrink only the at-most-100 returned hits
      // and bounded failure sample until the entire model-visible result fits.
      let count = hits.length;
      let failureSampleCount = failures.length;
      let page = formatPage(count, failureSampleCount);
      while (estimateTextTokens(page.content) > resultBudget) {
        if (count > 1) count -= 1;
        else if (failureSampleCount > 0) failureSampleCount -= 1;
        else break;
        page = formatPage(count, failureSampleCount);
      }
      if (estimateTextTokens(page.content) > resultBudget || (found > 0 && count === 0)) {
        yield { type: "result", isError: true,
          content: "vault_search: result budget cannot hold one match with coverage and cursor. Narrow the query or scope and retry; no search coverage was claimed." };
        return;
      }
      yield page;
    },
  });
}

module.exports = { createVaultSearchTool };
