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
  recordRead(path, content) {
    if (!path || typeof content !== "string") return;
    this._map.set(path, {
      content,
      readAt: Date.now(),
      writtenInTurn: false,
    });
  }

  /**
   * Record that the agent has written this file with the given content.
   * Crucially, this satisfies read-before-edit too — after writing a
   * file the agent has, by definition, seen its latest contents.
   * @param {string} path
   * @param {string} content
   */
  recordWrite(path, content) {
    if (!path || typeof content !== "string") return;
    this._map.set(path, {
      content,
      readAt: Date.now(),
      writtenInTurn: true,
    });
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

  size() {
    return this._map.size;
  }
}

module.exports = { FileStateCache };
