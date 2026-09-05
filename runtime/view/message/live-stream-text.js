function liveStreamText(block) {
  if (!block || typeof block !== "object") return "";
  const value = typeof block.detail === "string" && block.detail
    ? block.detail
    : (typeof block.text === "string" ? block.text : "");
  return String(value || "").replace(/\r\n?/g, "\n");
}

function isLiveStreamTextBlock(block, messagePending) {
  if (!messagePending || !block || typeof block !== "object") return false;
  if (String(block.type || "").trim().toLowerCase() !== "stream-text") return false;
  const phase = String(block.phase || "").trim().toLowerCase();
  const status = String(block.status || "pending").trim().toLowerCase();
  return phase !== "process"
    && phase !== "final"
    && status !== "completed"
    && status !== "error";
}

function syncLiveStreamTextSlot(slot, block, status = "running") {
  if (!slot || typeof slot.querySelector !== "function") return false;
  const card = slot.querySelector(".oc-stream-text-part");
  const body = slot.querySelector(".oc-stream-text-content");
  if (!card || !body) return false;

  const normalizedStatus = String(status || "running").trim().toLowerCase() || "running";
  if (card.classList) {
    ["running", "pending", "completed", "error", "unknown"].forEach((value) => {
      card.classList.remove(`is-${value}`);
    });
    card.classList.remove("is-process", "is-final");
    card.classList.add("is-streaming", `is-${normalizedStatus}`);
  }

  const text = liveStreamText(block);
  const visibleText = text || "…";
  if (body.textContent !== visibleText) body.textContent = visibleText;
  return true;
}

module.exports = {
  liveStreamText,
  isLiveStreamTextBlock,
  syncLiveStreamTextSlot,
};
