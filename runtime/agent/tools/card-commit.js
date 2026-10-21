// Host-owned commit of a confirmed card draft and its precise link updates.
// No semantic relationship is inferred here. Every existing note must have
// been read, and all targets are preflighted before the first mutation.

const { buildTool } = require("../tool-registry");
const { contentFingerprint } = require("../file-state-cache");
const { throwIfToolAborted } = require("../vault-effect-verifiers");

const ROLE_ORDER = Object.freeze({ topic: 0, source: 1, backlink: 2 });
const SCHEMA = {
  type: "object",
  properties: {
    card: {
      type: "object",
      properties: {
        path: { type: "string", description: "New card path relative to the vault root, ending .md." },
        content: { type: "string", description: "Exact user-confirmed card text." },
      },
      required: ["path", "content"],
    },
    sync: {
      type: "array",
      description: "Confirmed precise updates, ordered topic, source, then backlink. Repeat a path for multiple edits in the same note. Each old_string must have been visible in vault_read output.",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          role: { type: "string", enum: ["topic", "source", "backlink"] },
          old_string: { type: "string" },
          new_string: { type: "string" },
          expected_fingerprint: { type: "string", description: "Optional full-note fingerprint from the read evidence. All edits to one path use the same preimage fingerprint." },
          after_fingerprint: { type: "string", description: "Optional full-note fingerprint after all edits to this path; permits a guarded retry after a restart." },
        },
        required: ["path", "role", "old_string", "new_string"],
      },
    },
  },
  required: ["card", "sync"],
};

function safeNotePath(value) {
  if (typeof value !== "string" || value !== value.trim() || !value || value.includes("\\") || value.startsWith("/")) return null;
  if (/[\u0000-\u001f\u007f?#|]/u.test(value) || !value.endsWith(".md")) return null;
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) return null;
  if (/^[A-Za-z]:/u.test(value)) return null;
  return value;
}

function cardLinkIn(text, cardPath) {
  const target = cardPath.slice(0, -3);
  const pattern = /\[\[([^\]]+)\]\]/gu;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const destination = match[1].split("|")[0].split("#")[0].trim().replace(/\.md$/iu, "");
    if (destination === target) return true;
  }
  return false;
}

function countOccurrences(text, needle) {
  let count = 0;
  let at = 0;
  while ((at = text.indexOf(needle, at)) !== -1) {
    count += 1;
    at += needle.length;
  }
  return count;
}

function exactDesiredSnippetPresent(text, edit) {
  return countOccurrences(text, edit.new_string) === 1
    && countOccurrences(text, edit.old_string) === countOccurrences(edit.new_string, edit.old_string);
}

function groupSync(sync) {
  const groups = [];
  const seen = new Map();
  for (const item of sync) {
    let group = seen.get(item.path);
    if (!group) {
      group = { path: item.path, role: item.role, edits: [], beforeFingerprint: item.expected_fingerprint || null, afterFingerprint: item.after_fingerprint || null };
      seen.set(item.path, group);
      groups.push(group);
    } else if (group.role !== item.role
      || group.beforeFingerprint !== (item.expected_fingerprint || null)
      || group.afterFingerprint !== (item.after_fingerprint || null)) {
      throw new Error(`Conflicting role or fingerprint for ${item.path}.`);
    }
    group.edits.push(item);
  }
  return groups;
}

function applyEditsWithVisibility(original, edits, path, visibleRanges) {
  let text = original;
  let ranges = Array.isArray(visibleRanges) ? visibleRanges.map(([start, end]) => [start, end]) : [];
  for (const edit of edits) {
    // An exact desired snippet is a confirmed duplicate. A link elsewhere in
    // the note is not enough to suppress a required source-field update.
    if ((edit.new_string.startsWith(edit.old_string) || edit.new_string.endsWith(edit.old_string))
      && exactDesiredSnippetPresent(text, edit)) continue;
    const count = countOccurrences(text, edit.old_string);
    if (count !== 1) throw new Error(`${path}: old_string has ${count} matches; expected exactly one.`);
    const at = text.indexOf(edit.old_string);
    const oldEnd = at + edit.old_string.length;
    const newEnd = at + edit.new_string.length;
    const delta = edit.new_string.length - edit.old_string.length;
    const nextRanges = [[at, newEnd]]; // New text was supplied in the confirmed plan.
    for (const [start, end] of ranges) {
      if (end <= at) nextRanges.push([start, end]);
      else if (start >= oldEnd) nextRanges.push([start + delta, end + delta]);
      else {
        if (start < at) nextRanges.push([start, at]);
        if (end > oldEnd) nextRanges.push([newEnd, end + delta]);
      }
    }
    ranges = nextRanges;
    text = text.slice(0, at) + edit.new_string + text.slice(oldEnd);
  }
  return { text, visibleRanges: ranges };
}

function applyEdits(original, edits, path) {
  return applyEditsWithVisibility(original, edits, path, []).text;
}

function cacheHasExactContent(cache, path, content) {
  if (!cache || typeof cache.get !== "function") return false;
  if (typeof cache.matchesContent === "function") return cache.matchesContent(path, content);
  const entry = cache.get(path);
  return !!entry && entry.content === content;
}

function editWasVisible(cache, path, oldString) {
  if (!cache || typeof cache.get !== "function") return false;
  if (typeof cache.isTextVisible === "function") return cache.isTextVisible(path, oldString);
  // Older cache versions have no model-visible range evidence. Fail closed.
  return false;
}

async function readCurrent(vault, file) {
  const value = typeof vault.read === "function"
    ? await vault.read(file)
    : await vault.cachedRead(file);
  return typeof value === "string" ? value : String(value || "");
}

function parentFolderExists(vault, path) {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return true;
  const parent = path.slice(0, slash);
  if (typeof vault.getFolderByPath === "function") return !!vault.getFolderByPath(parent);
  if (typeof vault.getAbstractFileByPath === "function") {
    const folder = vault.getAbstractFileByPath(parent);
    return !!folder && Array.isArray(folder.children);
  }
  return false;
}

function receipt(content, isError, code, data, targets) {
  return {
    type: "result", content, isError, code, data,
    effects: [{ kind: "vault_mutation", targets }],
  };
}

function createCardCommitTool({ vault } = {}) {
  if (!vault || typeof vault.getFileByPath !== "function" || typeof vault.create !== "function"
    || typeof vault.process !== "function" || (typeof vault.read !== "function" && typeof vault.cachedRead !== "function")) {
    throw new Error("createCardCommitTool: vault with getFileByPath, create, process, and read/cachedRead required");
  }
  // The map only helps same-session retries. Cross-session retries require
  // supplied after_fingerprint guards, compared against the live vault.
  const completedPlans = new Map();

  return buildTool({
    name: "card_commit",
    description: "Save a user-confirmed new card and its already-confirmed topic/source/backlink link plan. Requires exact read evidence for every existing target. Preflights the whole plan, then writes in order and verifies every file. Stops with a partial receipt on failure; reusing the same plan safely resumes verified steps. Does not decide relationships or replace existing cards.",
    inputSchema: SCHEMA,
    capabilities: (input) => ({
      effect: "vault_mutation", risk: "medium", concurrency: "serial", presentation: "edit",
      targets: [input && input.card && input.card.path, ...((input && Array.isArray(input.sync)) ? input.sync.map((item) => item && item.path) : [])]
        .filter((path) => typeof path === "string"),
    }),
    isReadOnly: () => false,
    isDestructive: () => false,
    isConcurrencySafe: () => false,
    userFacingName: (input) => `commit card ${input && input.card ? input.card.path : "?"}`,
    async validate(input) {
      if (!input || !input.card || !safeNotePath(input.card.path) || typeof input.card.content !== "string") {
        return { ok: false, error: "card requires a safe vault-relative .md path and string content." };
      }
      if (!Array.isArray(input.sync)) {
        return { ok: false, error: "sync must be an array of confirmed topic/source/backlink updates; it may be empty when no link was confirmed." };
      }
      let lastRole = -1;
      const pathRoles = new Map();
      for (const item of input.sync) {
        if (!item || !safeNotePath(item.path) || item.path === input.card.path || !Object.hasOwn(ROLE_ORDER, item.role)) {
          return { ok: false, error: "Each sync item needs a safe, distinct .md path and topic/source/backlink role." };
        }
        if (ROLE_ORDER[item.role] < lastRole) return { ok: false, error: "sync order must be topic, source, backlink." };
        lastRole = ROLE_ORDER[item.role];
        if (pathRoles.has(item.path) && pathRoles.get(item.path) !== item.role) {
          return { ok: false, error: `A path cannot have two roles: ${item.path}.` };
        }
        pathRoles.set(item.path, item.role);
        if (typeof item.old_string !== "string" || !item.old_string || typeof item.new_string !== "string"
          || item.old_string === item.new_string || !cardLinkIn(item.new_string, input.card.path)) {
          return { ok: false, error: `${item.path}: require distinct exact old/new strings and a full-path wikilink to the new card in new_string.` };
        }
        for (const field of ["expected_fingerprint", "after_fingerprint"]) {
          if (item[field] !== undefined && (typeof item[field] !== "string" || !/^\d+:[0-9a-f]{8}$/u.test(item[field]))) {
            return { ok: false, error: `${item.path}: ${field} must be a content fingerprint.` };
          }
        }
      }
      try { groupSync(input.sync); } catch (error) { return { ok: false, error: error.message }; }
      return { ok: true };
    },
    async checkPermissions(input, ctx) {
      if (ctx && ctx.grants && ctx.grants["card_commit:*"]) return { behavior: "allow" };
      return {
        behavior: "ask",
        summary: `create ${input.card.path}; update ${new Set(input.sync.map((item) => item.path)).size} linked notes`,
        choices: ["allow once", "allow for this conversation", "deny"],
      };
    },
    async verifyEffect(input, outcome, ctx) {
      const planState = completedPlans.get(JSON.stringify(input));
      if (!planState || !outcome || !outcome.data) {
        return { verified: false, outcome: "postcondition_failed", detail: "missing_expected_states" };
      }
      const targets = [input.card.path, ...new Set(input.sync.map((item) => item.path))];
      for (const path of targets) {
        const file = vault.getFileByPath(path);
        if (!file) return { verified: false, outcome: "postcondition_failed", detail: `missing:${path}` };
        const live = await readCurrent(vault, file);
        const expected = path === input.card.path ? input.card.content : planState.get(path);
        if (typeof expected !== "string" || live !== expected) {
          return { verified: false, outcome: "postcondition_failed", detail: `drifted:${path}` };
        }
        if (path === input.card.path && ctx && ctx.fileStateCache && typeof ctx.fileStateCache.recordWrite === "function") {
          ctx.fileStateCache.recordWrite(path, live);
        }
      }
      return { verified: true, outcome: "verified" };
    },
    async *execute(input, ctx) {
      const paths = [input.card.path, ...new Set(input.sync.map((item) => item.path))];
      const verified = [];
      const recovery = [];
      let attempted = null;
      let attemptedBefore = null;
      let attemptedAfter = null;
      let failedAt = "preflight";
      const fail = (code, detail, observation) => receipt(
        `card_commit stopped at ${failedAt}: ${detail}. Verified: ${verified.length ? verified.join(", ") : "none"}. ${attempted ? `Attempted: ${attempted} (${observation}). ` : ""}Pending: ${paths.filter((path) => !verified.includes(path)).join(", ")}.`,
        true, code,
        { verified: verified.slice(), pending: paths.filter((path) => !verified.includes(path)), failedAt, detail, recovery: recovery.slice(), attempted, observation },
        verified.slice(),
      );
      try {
        throwIfToolAborted(ctx, "card_commit_preflight");
        if (!parentFolderExists(vault, input.card.path)) throw new Error(`Card parent folder is missing: ${input.card.path}`);
        const planKey = JSON.stringify(input);
        const previous = completedPlans.get(planKey) || new Map();
        const cardFile = vault.getFileByPath(input.card.path);
        if (cardFile) {
          const current = await readCurrent(vault, cardFile);
          if (current !== input.card.content) throw new Error(`Card path already exists with different content: ${input.card.path}`);
        }
        const groups = groupSync(input.sync);
        const prepared = [];
        const cache = ctx && ctx.fileStateCache;
        for (const group of groups) {
          const file = vault.getFileByPath(group.path);
          if (!file) throw new Error(`Sync target missing: ${group.path}`);
          const current = await readCurrent(vault, file);
          if (!cacheHasExactContent(cache, group.path, current)) {
            throw new Error(`${group.path}: read evidence is missing or stale; call vault_read again.`);
          }
          const currentFingerprint = contentFingerprint(current);
          const knownAfter = previous.get(group.path);
          const guardedAfter = group.afterFingerprint === currentFingerprint
            && group.afterFingerprint !== group.beforeFingerprint
            && !!group.beforeFingerprint
            && group.edits.every((edit) => exactDesiredSnippetPresent(current, edit));
          if ((knownAfter && current === knownAfter) || guardedAfter) {
            // A completed target must match the exact desired state, not merely
            // contain a link somewhere. If in-memory text exists, compare it.
            if (knownAfter && current !== knownAfter) throw new Error(`${group.path}: after-state drifted.`);
            prepared.push({ ...group, file, current, desired: current, alreadyApplied: true });
            continue;
          }
          if (group.beforeFingerprint && group.beforeFingerprint !== currentFingerprint) {
            throw new Error(`${group.path}: fingerprint changed since the confirmed plan.`);
          }
          for (const edit of group.edits) {
            if (!editWasVisible(cache, group.path, edit.old_string)) {
              throw new Error(`${group.path}: old_string was not visible in the read evidence; read the relevant span.`);
            }
          }
          const planned = applyEditsWithVisibility(current, group.edits, group.path, cache.get(group.path).visibleRanges);
          const desired = planned.text;
          if (group.afterFingerprint && contentFingerprint(desired) !== group.afterFingerprint) {
            throw new Error(`${group.path}: after_fingerprint does not match the planned edits.`);
          }
          prepared.push({ ...group, file, current, desired, visibleRanges: planned.visibleRanges, alreadyApplied: false });
        }
        for (const group of prepared) {
          recovery.push({
            path: group.path,
            expected_fingerprint: group.beforeFingerprint || contentFingerprint(group.current),
            after_fingerprint: contentFingerprint(group.desired),
          });
        }

        // No write begins until all targets and exact before/after states pass.
        failedAt = input.card.path;
        if (cardFile) {
          verified.push(input.card.path);
        } else {
          throwIfToolAborted(ctx, "card_commit_create");
          attempted = input.card.path;
          attemptedBefore = null;
          attemptedAfter = input.card.content;
          await vault.create(input.card.path, input.card.content);
          const created = vault.getFileByPath(input.card.path);
          if (!created || await readCurrent(vault, created) !== input.card.content) {
            throw new Error("new card did not match confirmed content after create");
          }
          verified.push(input.card.path);
          attempted = null;
          if (cache && typeof cache.recordWrite === "function") cache.recordWrite(input.card.path, input.card.content);
        }
        completedPlans.set(planKey, previous);
        if (completedPlans.size > 32) completedPlans.delete(completedPlans.keys().next().value);
        for (const group of prepared) {
          failedAt = group.path;
          throwIfToolAborted(ctx, "card_commit_sync");
          if (!group.alreadyApplied && group.desired !== group.current) {
            // Obsidian Vault.process supplies the live text inside its edit
            // lock, closing the read/modify race left by modify().
            attempted = group.path;
            attemptedBefore = group.current;
            attemptedAfter = group.desired;
            await vault.process(group.file, (live) => {
              if (live !== group.current) throw new Error(`${group.path}: changed after preflight`);
              return group.desired;
            });
          }
          const file = vault.getFileByPath(group.path);
          if (!file || await readCurrent(vault, file) !== group.desired) {
            throw new Error(`${group.path}: postcondition failed`);
          }
          verified.push(group.path);
          attempted = null;
          previous.set(group.path, group.desired);
          completedPlans.set(planKey, previous);
          if (completedPlans.size > 32) completedPlans.delete(completedPlans.keys().next().value);
          if (cache && typeof cache.recordWrite === "function" && !group.alreadyApplied) {
            cache.recordWrite(group.path, group.desired, { visibleRanges: group.visibleRanges });
          }
        }
        yield receipt(
          `Committed ${input.card.path}; verified ${verified.length} note${verified.length === 1 ? "" : "s"}: ${verified.join(", ")}.`,
          false, "ok", { verified: verified.slice(), recovery }, paths,
        );
      } catch (error) {
        let observation = null;
        if (attempted) {
          try {
            const file = vault.getFileByPath(attempted);
            const live = file ? await readCurrent(vault, file) : null;
            observation = live === attemptedAfter ? "desired_state_observed_unverified"
              : live === attemptedBefore ? "preimage_observed"
                : live === null ? "missing" : "diverged";
          } catch (_readError) {
            observation = "unreadable";
          }
        }
        yield fail("partial_commit", error && error.message ? error.message : String(error), observation);
      }
    },
  });
}

module.exports = { createCardCommitTool, safeNotePath, cardLinkIn, applyEdits };
