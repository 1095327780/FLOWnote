function addClass(element, className) {
  if (!element) return;
  if (typeof element.addClass === "function") {
    element.addClass(className);
    return;
  }
  if (element.classList && typeof element.classList.add === "function") {
    element.classList.add(className);
  }
}

/**
 * Opt a modal into FLOWnote's two-layer responsive contract.
 *
 * Obsidian owns the outer `.modal` element while each modal implementation
 * owns only `contentEl`. Sizing the content alone leaves the host shell free to
 * overflow on phones, so both layers are marked from one shared boundary.
 */
function applyResponsiveModalSurface(modal, contentEl) {
  addClass(contentEl, "oc-responsive-modal");
  const shellEl = (modal && modal.modalEl)
    || (contentEl && typeof contentEl.closest === "function" ? contentEl.closest(".modal") : null);
  addClass(shellEl, "oc-responsive-modal-shell");
  return { shellEl: shellEl || null, contentEl: contentEl || null };
}

module.exports = { applyResponsiveModalSurface };
