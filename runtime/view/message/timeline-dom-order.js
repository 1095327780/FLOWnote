function nextActivitySlot(container, previousSlot) {
  let candidate = previousSlot ? previousSlot.nextElementSibling : container.firstElementChild;
  while (candidate) {
    if (candidate.classList && candidate.classList.contains("oc-part-slot")) return candidate;
    candidate = candidate.nextElementSibling;
  }
  return null;
}

function placeActivitySlot(container, slot, previousSlot) {
  const expected = nextActivitySlot(container, previousSlot);
  if (expected === slot) return false;
  container.insertBefore(slot, expected);
  return true;
}

module.exports = { placeActivitySlot };
