// Sidecars originate from the attachment composer, never from model/user prompt tags.
async function seedLinkedEvidence({ evidence, vault, cache, history } = {}) {
  const drifted = [];
  for (const item of Array.isArray(evidence) ? evidence : []) {
    if (!item || typeof item.path !== "string" || typeof item.content !== "string") continue;
    try {
      const file = vault && vault.getFileByPath(item.path);
      const current = file ? String(await vault.cachedRead(file)) : null;
      if (current === item.content) cache.recordRead(item.path, current, { visibleRanges: item.visibleRanges });
      else drifted.push(item.path);
    } catch (_error) { drifted.push(item.path); }
    if (drifted.includes(item.path) && item.promptBlock) {
      for (const message of history) {
        if (message.role !== "user") continue;
        for (const block of message.content || []) {
          if (block.type === "text") block.text = block.text.split(item.promptBlock).join(`[FLOWNOTE_ATTACHMENT_STALE path="${item.path}": call vault_read for fresh evidence.]`);
        }
      }
    }
  }
  if (drifted.length) history[history.length - 1].content.push({ type: "text", text:
    `[FLOWNOTE_ATTACHMENT_DRIFT] These attached files changed or became unreadable after attachment. Read fresh source before making any decision or edit: ${drifted.join(", ")}` });
  return drifted;
}

module.exports = { seedLinkedEvidence };
