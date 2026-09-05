function clampSelectableCollectionIndex(index, length) {
  const count = Math.max(0, Number(length) || 0);
  if (!count) return 0;
  return Math.max(0, Math.min(count - 1, Number(index) || 0));
}

function nextSelectableCollectionIndex({ key, index, length }) {
  const count = Math.max(0, Number(length) || 0);
  if (!count) return null;
  const current = clampSelectableCollectionIndex(index, count);
  switch (key) {
    case "ArrowDown":
      return Math.min(count - 1, current + 1);
    case "ArrowUp":
      return Math.max(0, current - 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

function handleSelectableCollectionNavigation(event, options = {}) {
  const nextIndex = nextSelectableCollectionIndex({
    key: event && event.key,
    index: options.index,
    length: options.length,
  });
  if (nextIndex === null) return false;
  if (event && typeof event.preventDefault === "function") event.preventDefault();
  if (typeof options.onMove === "function") options.onMove(nextIndex);
  return true;
}

function applyRovingSelection(elements, selectedIndex, selectedClass = "is-selected") {
  const items = Array.from(elements || []);
  const activeIndex = clampSelectableCollectionIndex(selectedIndex, items.length);
  items.forEach((item, index) => {
    if (!item) return;
    const isSelected = index === activeIndex;
    if (item.classList && typeof item.classList.toggle === "function") {
      item.classList.toggle(selectedClass, isSelected);
    }
    const setAttribute = typeof item.setAttr === "function"
      ? item.setAttr.bind(item)
      : typeof item.setAttribute === "function"
        ? item.setAttribute.bind(item)
        : null;
    if (setAttribute) {
      setAttribute("aria-current", isSelected ? "true" : "false");
      setAttribute("tabindex", isSelected ? "0" : "-1");
    }
  });
  return activeIndex;
}

module.exports = {
  applyRovingSelection,
  clampSelectableCollectionIndex,
  nextSelectableCollectionIndex,
  handleSelectableCollectionNavigation,
};
