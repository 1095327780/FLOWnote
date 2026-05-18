function readDropdownValue(dropdown, fallback = "") {
  if (dropdown && dropdown.selectEl && dropdown.selectEl.value !== undefined) {
    return String(dropdown.selectEl.value || "");
  }
  if (dropdown && typeof dropdown.getValue === "function") {
    const value = dropdown.getValue();
    if (value !== undefined && value !== null) return String(value);
  }
  return String(fallback || "");
}

function readEventTargetValue(event) {
  const target = event && event.target ? event.target : null;
  if (target && target.value !== undefined && target.value !== null) {
    return String(target.value);
  }
  return "";
}

function bindDropdownChange(dropdown, handler) {
  if (!dropdown || typeof handler !== "function") return dropdown;
  const selectEl = dropdown.selectEl;
  if (selectEl && typeof selectEl.addEventListener === "function") {
    selectEl.addEventListener("change", (event) => {
      const value = readEventTargetValue(event) || readDropdownValue(dropdown, "");
      return handler(value, event);
    });
    return dropdown;
  }
  if (typeof dropdown.onChange === "function") {
    dropdown.onChange((value) => handler(readDropdownValue(dropdown, value), null));
  }
  return dropdown;
}

module.exports = {
  bindDropdownChange,
  readDropdownValue,
};
