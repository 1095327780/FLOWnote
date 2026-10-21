// FileStateCache — session-scoped record of files the agent has read
// or written this conversation.
//
// Two motivations:
//
// 1. Read-before-edit gate: `vault_edit` refuses to operate on a file
//    that hasn't been read this session, mirroring the reference
//    project's FileStateCache approach. Reason: the model can only
//    propose accurate string replacements if it has seen the current
//    content. Without this gate we rely on the tool's "old_string not
//    found" error to catch hallucinations — which works but is noisy.
//
// 2. Backlinks-lag bypass: Obsidian's metadataCache reindexes
//    asynchronously, so a wikilink written ~1s ago may not show up in
//    `app.metadataCache.resolvedLinks` yet. We cache the WRITTEN
//    content of every modified file this turn so vault_backlinks can
//    scan that content directly and merge results, eliminating the
//    "I just wrote the link but you say it doesn't exist" loop.
//
// One instance per agent-loop ctx. Lives only in memory. Not persisted.

/**
 * @typedef {Object} FileStateEntry
 * @property {string} content     full file content at the time we last touched it
 * @property {number} readAt      timestamp of the read/write that produced this entry (ms)
 * @property {boolean} writtenInTurn  true if the most recent update was a write (not a read)
 * @property {Array<[number, number]>} visibleRanges UTF-16 ranges actually shown to the model
 */

class FileStateCache {
  constructor() {
    /** @type {Map<string, FileStateEntry>} */
    this._map = new Map();
  }

  /**
   * Record that the agent has read this file with the given content.
   * @param {string} path
   * @param {string} content
   */
  recordRead(path, content, { visibleRanges = [[0, content && content.length]] } = {}) {
    if (!path || typeof content !== "string") return;
    const previous = this._map.get(path);
    const ranges = normalizeVisibleRanges(visibleRanges, content.length);
    this._map.set(path, {
      content,
      readAt: Date.now(),
      writtenInTurn: false,
      visibleRanges: previous && previous.content === content
        ? normalizeVisibleRanges([...(previous.visibleRanges || []), ...ranges], content.length)
        : ranges,
    });
  }

  /**
   * Record that the agent has written this file with the given content.
   * With no visibility override, the model supplied the whole new content
   * (vault_write create/overwrite). Host-derived edits must supply ranges.
   * @param {string} path
   * @param {string} content
   */
  recordWrite(path, content, { visibleRanges = [[0, content && content.length]] } = {}) {
    if (!path || typeof content !== "string") return;
    this._map.set(path, {
      content,
      readAt: Date.now(),
      writtenInTurn: true,
      visibleRanges: normalizeVisibleRanges(visibleRanges, content.length),
    });
  }

  recordHostWrite(path, content) {
    this.recordWrite(path, content, { visibleRanges: [] });
  }

  /**
   * @param {string} path
   * @returns {FileStateEntry | undefined}
   */
  get(path) {
    return this._map.get(String(path || ""));
  }

  /**
   * Whether the agent has touched (read or written) this file in this
   * session.
   * @param {string} path
   * @returns {boolean}
   */
  has(path) {
    return this._map.has(String(path || ""));
  }

  matchesContent(path, content) {
    const entry = this.get(path);
    return !!entry && typeof content === "string" && entry.content === content;
  }

  isTextVisible(path, oldString, { allOccurrences = false } = {}) {
    const entry = this.get(path);
    if (!entry || typeof oldString !== "string" || !oldString) return false;
    let found = false;
    let index = 0;
    while ((index = entry.content.indexOf(oldString, index)) !== -1) {
      const visible = (entry.visibleRanges || []).some(([start, end]) => (
        start <= index && index + oldString.length <= end
      ));
      if (allOccurrences && !visible) return false;
      if (visible) found = true;
      index += oldString.length;
    }
    return found;
  }

  /**
   * All entries that were WRITTEN (not just read) in this session.
   * Used by vault_backlinks to scan for the target path in files whose
   * Obsidian-side metadataCache may not have indexed yet.
   * @returns {Array<{ path: string, content: string }>}
   */
  recentWrites() {
    /** @type {Array<{ path: string, content: string }>} */
    const out = [];
    for (const [path, entry] of this._map.entries()) {
      if (entry.writtenInTurn) out.push({ path, content: entry.content });
    }
    return out;
  }

  /**
   * Compact durable state for a continuation checkpoint. Full contents are
   * deliberately excluded: resume re-reads the live vault and hydrates only
   * entries whose fingerprint still matches, preventing stale edits.
   */
  snapshot() {
    return {
      version: 2,
      entries: Array.from(this._map.entries()).map(([path, entry]) => ({
        path,
        fingerprint: contentFingerprint(entry.content),
        writtenInTurn: entry.writtenInTurn === true,
        visibleRanges: entry.visibleRanges || [],
      })),
    };
  }

  /**
   * Rebuild read-before-edit state from live file contents. Drifted, deleted,
   * or unreadable files remain absent so the model must read them again.
   * @param {Object} snapshot
   * @param {(path:string) => Promise<string>} readCurrent
   */
  async restoreSnapshot(snapshot, readCurrent) {
    const restoredPaths = [];
    const driftedPaths = [];
    const entries = snapshot && [1, 2].includes(snapshot.version) && Array.isArray(snapshot.entries)
      ? snapshot.entries
      : [];
    if (typeof readCurrent !== "function") return { restoredPaths, driftedPaths };
    for (const entry of entries) {
      const path = String((entry && entry.path) || "").trim();
      if (!path || typeof entry.fingerprint !== "string") continue;
      try {
        const content = await readCurrent(path);
        if (typeof content !== "string" || contentFingerprint(content) !== entry.fingerprint) {
          driftedPaths.push(path);
          continue;
        }
        if (entry.writtenInTurn === true) this.recordWrite(path, content, {
          visibleRanges: snapshot.version === 2 && Array.isArray(entry.visibleRanges) ? entry.visibleRanges : [],
        });
        else this.recordRead(path, content, {
          visibleRanges: snapshot.version === 2 && Array.isArray(entry.visibleRanges) ? entry.visibleRanges : [],
        });
        restoredPaths.push(path);
      } catch (_error) {
        driftedPaths.push(path);
      }
    }
    return { restoredPaths, driftedPaths };
  }

  size() {
    return this._map.size;
  }
}

function normalizeVisibleRanges(ranges, length) {
  if (!Array.isArray(ranges)) return [];
  const sorted = ranges.filter((range) => Array.isArray(range) && range.length === 2
    && Number.isInteger(range[0]) && Number.isInteger(range[1])
    && range[0] >= 0 && range[1] <= length && range[0] < range[1])
    .map((range) => [range[0], range[1]])
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

function contentFingerprint(content) {
  const value = String(content || "");
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${value.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

module.exports = { FileStateCache, contentFingerprint };
