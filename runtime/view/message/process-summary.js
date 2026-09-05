const { domUtils } = require("./dom-utils");

function syncProcessSummary(view, container, presentation, messagePending) {
  const shouldShow = Boolean(presentation && presentation.hasProcess);
  const legacySummary = container.querySelector(".oc-process-summary");
  if (legacySummary && legacySummary.parentElement === container) legacySummary.remove();
  let summary = container.querySelector(".oc-process-disclosure");
  if (summary && summary.parentElement !== container) summary = null;
  if (!shouldShow) {
    if (summary) summary.remove();
    container.removeClass("has-process-summary", "is-process-collapsed", "is-process-running");
    delete container.dataset.processAutoSettled;
    delete container.dataset.processUserToggled;
    return;
  }

  if (!summary) {
    // Do not use a native <button> here. Obsidian themes and stale mobile
    // stylesheets may skin buttons as cards before plugin CSS is refreshed.
    // This disclosure keeps button semantics while remaining plain text even
    // if only the new JavaScript bundle has arrived on a device.
    summary = document.createElement("div");
    summary.className = "oc-process-disclosure";
    summary.setAttr("role", "button");
    summary.tabIndex = 0;
    const icon = summary.createSpan({ cls: "oc-process-summary-icon" });
    domUtils.safeSetIcon(icon, "chevron-right");
    summary.createSpan({ cls: "oc-process-summary-label" });
    summary.createSpan({ cls: "oc-process-summary-count" });
    const toggleProcess = () => {
      container.dataset.processUserToggled = "1";
      container.toggleClass("is-process-collapsed", !container.hasClass("is-process-collapsed"));
      summary.setAttr("aria-expanded", String(!container.hasClass("is-process-collapsed")));
    };
    summary.addEventListener("click", toggleProcess);
    summary.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleProcess();
    });
    container.prepend(summary);
  }

  const locale = view && view.plugin && typeof view.plugin.getEffectiveLocale === "function"
    ? view.plugin.getEffectiveLocale()
    : "en";
  const useZh = locale === "zh-CN";
  const label = messagePending
    ? (useZh ? "执行过程" : "Process")
    : (useZh ? "过程" : "Process");
  const toolCount = Math.max(0, Number(presentation.toolCount || 0));
  const count = toolCount > 0
    ? (useZh ? `${toolCount} 次工具` : `${toolCount} tool${toolCount === 1 ? "" : "s"}`)
    : "";
  const labelEl = summary.querySelector(".oc-process-summary-label");
  const countEl = summary.querySelector(".oc-process-summary-count");
  if (labelEl) labelEl.textContent = label;
  if (countEl) countEl.textContent = count;
  summary.setAttr("aria-label", [label, count].filter(Boolean).join(" · "));

  container.addClass("has-process-summary");
  container.toggleClass("is-process-running", Boolean(messagePending));
  if (messagePending) {
    if (container.dataset.processUserToggled !== "1") container.removeClass("is-process-collapsed");
    delete container.dataset.processAutoSettled;
  } else if (container.dataset.processAutoSettled !== "1") {
    const readerIsFollowing = typeof view.shouldAutoScrollMessages === "function"
      ? view.shouldAutoScrollMessages()
      : true;
    if (container.dataset.processUserToggled !== "1" && readerIsFollowing) {
      container.addClass("is-process-collapsed");
    }
    container.dataset.processAutoSettled = "1";
  }
  summary.setAttr("aria-expanded", String(!container.hasClass("is-process-collapsed")));
}

module.exports = { syncProcessSummary };
