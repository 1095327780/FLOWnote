const { reduceExecutionEvents } = require("../agent/execution-ledger");

function durableToolStatus(tool) {
  const status = String(tool && tool.status || "").trim();
  if (status === "running") return "running";
  if (status === "succeeded") return "completed";
  if (status === "failed" || status === "unknown_after_reload") return "error";
  return "pending";
}

function durableToolSummary(tool, existing) {
  const prior = String(existing && existing.summary || "").trim();
  if (prior) return prior.slice(0, 240);
  const targets = tool && tool.capabilities && Array.isArray(tool.capabilities.targets)
    ? tool.capabilities.targets.map((target) => String(target || "").trim()).filter(Boolean)
    : [];
  return targets.slice(0, 2).join(" · ").slice(0, 240);
}

function latestRun(events) {
  const state = reduceExecutionEvents(events);
  const runs = Object.values(state.runs);
  return runs.length ? runs[runs.length - 1] : null;
}

/**
 * Reconcile the visible tool list from the durable execution ledger.
 *
 * Live blocks may carry a richer, safe summary while the app is foregrounded.
 * The ledger remains authoritative for membership and status so a suspended
 * mobile animation frame cannot leave later tools missing from SessionStore.
 */
function mergeDurableToolBlocks(existingBlocks, events) {
  const blocks = Array.isArray(existingBlocks) ? existingBlocks : [];
  const existingTools = new Map(blocks
    .filter((block) => String(block && block.type || "") === "tool")
    .map((block) => [String(block.id || ""), block]));
  const run = latestRun(events);
  if (!run) return blocks.slice();

  const durableTools = Object.values(run.tools || {}).map((tool) => {
    const prior = existingTools.get(String(tool.id || "")) || {};
    const status = durableToolStatus(tool);
    const receiptStatus = tool && tool.effect && String(tool.effect.status || "");
    const verified = receiptStatus === "verified"
      ? true
      : receiptStatus === "unverified"
        ? false
        : prior.verified;
    const outcome = tool && tool.outcome ? tool.outcome : prior.outcome || null;
    return {
      ...prior,
      id: String(tool.id || ""),
      type: "tool",
      tool: String(tool.tool || prior.tool || ""),
      status,
      summary: durableToolSummary(tool, prior),
      detail: status === "error" && outcome && outcome.code ? String(outcome.code) : "",
      capabilities: tool.capabilities || prior.capabilities || null,
      outcome,
      isError: status === "error",
      ...(verified === undefined ? {} : { verified }),
    };
  });
  const durableById = new Map(durableTools.map((block) => [String(block.id || ""), block]));
  const emitted = new Set();
  const merged = blocks.map((block) => {
    if (String(block && block.type || "") !== "tool") return block;
    const id = String(block && block.id || "");
    const durable = durableById.get(id);
    if (!durable) return block;
    emitted.add(id);
    return durable;
  });
  for (const block of durableTools) {
    const id = String(block.id || "");
    if (!id || emitted.has(id)) continue;
    merged.push(block);
  }
  return merged;
}

module.exports = {
  mergeDurableToolBlocks,
  durableToolStatus,
};
