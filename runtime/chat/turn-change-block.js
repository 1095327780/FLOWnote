// Host-authored "files changed" block for one assistant response.
//
// The block is built only from vault changes the host measured during the
// turn. It is stored apart from the model's prose, so later turns never see
// host-written completion text as something the model said.

const ACTION_BY_OP = Object.freeze({
  created: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
});

function buildTurnChangeBlock({ runId, changes } = {}) {
  const list = Array.isArray(changes) ? changes.filter((change) => change && change.path) : [];
  if (!list.length) return null;
  const files = list.map((change) => {
    const entry = { action: ACTION_BY_OP[change.op] || "modified", path: change.path };
    if (change.op === "renamed") {
      entry.from = change.from;
      entry.to = change.path;
    }
    if (change.kind === "folder") entry.kind = "folder";
    return entry;
  });
  const diffs = list
    .filter((change) => change.diff && typeof change.diff.after === "string")
    .map((change) => ({
      file: change.path,
      before: String(change.diff.before || ""),
      after: String(change.diff.after || ""),
      startLine: Number.isSafeInteger(change.diff.startLine) ? change.diff.startLine : 1,
      additions: Number.isSafeInteger(change.diff.added) ? change.diff.added : undefined,
      deletions: Number.isSafeInteger(change.diff.removed) ? change.diff.removed : undefined,
    }));
  return {
    id: `direct:${String(runId || "run")}:changes`,
    type: "patch",
    phase: "final",
    status: "completed",
    source: "host_measured",
    raw: { files, diffs },
  };
}

module.exports = { buildTurnChangeBlock };
