const DEFAULT_KEYBOARD_THRESHOLD_PX = 24;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function positiveDifference(baseline, current) {
  return Math.max(0, finiteNumber(baseline) - finiteNumber(current));
}

/**
 * Resolve keyboard visibility without taking ownership of composer geometry.
 * Obsidian Mobile may resize only its leaf while leaving visualViewport
 * unchanged, so either host shrink or viewport occlusion can confirm that the
 * software keyboard is present. Focus alone is deliberately insufficient: a
 * hardware keyboard must keep the closed-keyboard navbar reservation.
 */
function resolveMobileKeyboardState(input = {}) {
  const viewportOcclusion = positiveDifference(
    input.viewportBaselineBottom,
    input.viewportBottom,
  );
  const hostShrink = positiveDifference(
    input.hostBaselineHeight,
    input.hostHeight,
  );

  if (!input.editableFocused) {
    return {
      open: false,
      reason: "unfocused",
      viewportOcclusion,
      hostShrink,
    };
  }

  const threshold = Math.max(1, finiteNumber(input.thresholdPx) || DEFAULT_KEYBOARD_THRESHOLD_PX);
  if (hostShrink >= threshold) {
    return { open: true, reason: "host", viewportOcclusion, hostShrink };
  }
  if (viewportOcclusion >= threshold) {
    return { open: true, reason: "viewport", viewportOcclusion, hostShrink };
  }
  return { open: false, reason: "none", viewportOcclusion, hostShrink };
}

module.exports = {
  DEFAULT_KEYBOARD_THRESHOLD_PX,
  resolveMobileKeyboardState,
};
