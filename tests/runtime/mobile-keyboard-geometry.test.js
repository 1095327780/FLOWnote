const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveMobileKeyboardState } = require("../../runtime/mobile/keyboard-state");

test("mobile keyboard opens when the Obsidian host shrinks even if visualViewport does not", () => {
  const state = resolveMobileKeyboardState({
    editableFocused: true,
    viewportBaselineBottom: 874,
    viewportBottom: 874,
    hostBaselineHeight: 780,
    hostHeight: 690,
  });

  assert.equal(state.open, true);
  assert.equal(state.hostShrink, 90);
  assert.equal(state.viewportOcclusion, 0);
  assert.equal(state.reason, "host");
});

test("mobile keyboard opens from visual viewport occlusion when the host does not resize", () => {
  const state = resolveMobileKeyboardState({
    editableFocused: true,
    viewportBaselineBottom: 874,
    viewportBottom: 540,
    hostBaselineHeight: 780,
    hostHeight: 780,
  });

  assert.equal(state.open, true);
  assert.equal(state.viewportOcclusion, 334);
  assert.equal(state.hostShrink, 0);
  assert.equal(state.reason, "viewport");
});

test("hardware keyboard focus does not remove the mobile navbar reservation", () => {
  const state = resolveMobileKeyboardState({
    editableFocused: true,
    viewportBaselineBottom: 874,
    viewportBottom: 874,
    hostBaselineHeight: 780,
    hostHeight: 780,
  });

  assert.deepEqual(state, {
    open: false,
    reason: "none",
    viewportOcclusion: 0,
    hostShrink: 0,
  });
});

test("blur closes keyboard state even while viewport restoration is still animating", () => {
  const state = resolveMobileKeyboardState({
    editableFocused: false,
    viewportBaselineBottom: 874,
    viewportBottom: 620,
    hostBaselineHeight: 780,
    hostHeight: 700,
  });

  assert.equal(state.open, false);
  assert.equal(state.reason, "unfocused");
});

test("small browser chrome changes stay below the keyboard threshold", () => {
  const state = resolveMobileKeyboardState({
    editableFocused: true,
    viewportBaselineBottom: 874,
    viewportBottom: 862,
    hostBaselineHeight: 780,
    hostHeight: 770,
    thresholdPx: 24,
  });

  assert.equal(state.open, false);
});
