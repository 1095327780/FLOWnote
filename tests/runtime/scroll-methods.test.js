const test = require("node:test");
const assert = require("node:assert/strict");

const { scrollMethods } = require("../../runtime/view/message/scroll-methods");

function createViewContext(overrides = {}) {
  const view = {
    elements: {
      messages: null,
    },
    autoScrollEnabled: true,
    pendingScrollRaf: 0,
    ignoreMessageScrollEventsUntil: 0,
    forceBottomUntil: 0,
    lastManualScrollIntentAt: 0,
    messagesIntentHandler: null,
    messagesKeyDownHandler: null,
    ...overrides,
  };
  Object.assign(view, scrollMethods);
  return view;
}

test("scheduleScrollMessagesToBottom should scroll to bottom when auto follow is enabled", () => {
  const originalRaf = global.requestAnimationFrame;
  const originalCancel = global.cancelAnimationFrame;
  global.requestAnimationFrame = (cb) => {
    cb();
    return 1;
  };
  global.cancelAnimationFrame = () => {};

  try {
    const container = {
      scrollTop: 10,
      scrollHeight: 1000,
      clientHeight: 300,
    };
    const view = createViewContext({
      elements: { messages: container },
      autoScrollEnabled: true,
    });

    view.scheduleScrollMessagesToBottom();
    assert.equal(container.scrollTop, 1000);
  } finally {
    global.requestAnimationFrame = originalRaf;
    global.cancelAnimationFrame = originalCancel;
  }
});

test("scheduleScrollMessagesToBottom should not scroll when auto follow is disabled", () => {
  const originalRaf = global.requestAnimationFrame;
  const originalCancel = global.cancelAnimationFrame;
  let rafCalled = false;
  global.requestAnimationFrame = () => {
    rafCalled = true;
    return 1;
  };
  global.cancelAnimationFrame = () => {};

  try {
    const container = {
      scrollTop: 10,
      scrollHeight: 1000,
      clientHeight: 300,
    };
    const view = createViewContext({
      elements: { messages: container },
      autoScrollEnabled: false,
    });

    view.scheduleScrollMessagesToBottom();
    assert.equal(rafCalled, false);
    assert.equal(container.scrollTop, 10);
  } finally {
    global.requestAnimationFrame = originalRaf;
    global.cancelAnimationFrame = originalCancel;
  }
});

test("scheduleScrollMessagesToBottom should force while force-bottom window is active", () => {
  const originalRaf = global.requestAnimationFrame;
  const originalCancel = global.cancelAnimationFrame;
  global.requestAnimationFrame = (cb) => {
    cb();
    return 1;
  };
  global.cancelAnimationFrame = () => {};

  try {
    const container = {
      scrollTop: 10,
      scrollHeight: 1000,
      clientHeight: 300,
    };
    const view = createViewContext({
      elements: { messages: container },
      autoScrollEnabled: false,
    });
    view.setForceBottomWindow(5000);

    view.scheduleScrollMessagesToBottom();
    assert.equal(container.scrollTop, 1000);
    assert.equal(view.autoScrollEnabled, true);
  } finally {
    global.requestAnimationFrame = originalRaf;
    global.cancelAnimationFrame = originalCancel;
  }
});

test("scheduleScrollMessagesToBottom should force scroll when requested", () => {
  const originalRaf = global.requestAnimationFrame;
  const originalCancel = global.cancelAnimationFrame;
  global.requestAnimationFrame = (cb) => {
    cb();
    return 1;
  };
  global.cancelAnimationFrame = () => {};

  try {
    const container = {
      scrollTop: 10,
      scrollHeight: 1000,
      clientHeight: 300,
    };
    const view = createViewContext({
      elements: { messages: container },
      autoScrollEnabled: false,
    });

    view.scheduleScrollMessagesToBottom(true);
    assert.equal(container.scrollTop, 1000);
    assert.equal(view.autoScrollEnabled, true);
  } finally {
    global.requestAnimationFrame = originalRaf;
    global.cancelAnimationFrame = originalCancel;
  }
});

test("bindMessagesScrollTracking should switch to manual mode when user scrolls away from bottom", () => {
  let scrollHandler = null;
  const container = {
    scrollTop: 200,
    scrollHeight: 1000,
    clientHeight: 300,
    addEventListener(event, handler) {
      if (event === "scroll") scrollHandler = handler;
    },
    removeEventListener() {},
  };

  const view = createViewContext({
    elements: { messages: container },
    autoScrollEnabled: true,
  });
  view.bindMessagesScrollTracking();
  assert.equal(typeof scrollHandler, "function");
  assert.equal(typeof view.messagesWheelIntentHandler, "function");

  view.messagesWheelIntentHandler();
  scrollHandler();
  assert.equal(view.autoScrollEnabled, false);

  container.scrollTop = 701;
  scrollHandler();
  assert.equal(view.autoScrollEnabled, true);
});

test("touch scrolling keeps manual ownership through a long press and inertial tail", () => {
  const originalNow = Date.now;
  const originalRaf = global.requestAnimationFrame;
  const originalCancel = global.cancelAnimationFrame;
  let now = 1000;
  Date.now = () => now;
  global.requestAnimationFrame = (callback) => { callback(); return 1; };
  global.cancelAnimationFrame = () => {};
  const handlers = new Map();
  const container = {
    scrollTop: 1500,
    scrollHeight: 2000,
    clientHeight: 500,
    addEventListener(event, handler) { handlers.set(event, handler); },
    removeEventListener(event, handler) {
      if (handlers.get(event) === handler) handlers.delete(event);
    },
  };

  try {
    const view = createViewContext({ elements: { messages: container } });
    view.bindMessagesScrollTracking();

    handlers.get("touchstart")();
    now += 1201;
    handlers.get("touchmove")();
    container.scrollTop = 250;
    handlers.get("scroll")();
    assert.equal(view.autoScrollEnabled, false, "a slow touch drag must opt out of follow");

    handlers.get("touchend")();
    now += 600;
    container.scrollTop = 180;
    handlers.get("scroll")();
    view.scheduleScrollMessagesToBottom();
    assert.equal(container.scrollTop, 180, "inertial scrolling must not be pulled to the latest token");

    container.scrollTop = 1500;
    handlers.get("scroll")();
    assert.equal(view.autoScrollEnabled, true, "returning to the bottom re-enables follow");
  } finally {
    Date.now = originalNow;
    global.requestAnimationFrame = originalRaf;
    global.cancelAnimationFrame = originalCancel;
  }
});

test("touch cancellation and scroll teardown clear touch ownership and listeners", () => {
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  const handlers = new Map();
  const container = {
    scrollTop: 1500,
    scrollHeight: 2000,
    clientHeight: 500,
    addEventListener(event, handler) { handlers.set(event, handler); },
    removeEventListener(event, handler) {
      if (handlers.get(event) === handler) handlers.delete(event);
    },
  };

  try {
    const view = createViewContext({ elements: { messages: container } });
    view.bindMessagesScrollTracking();
    handlers.get("touchstart")();
    now += 1201;
    handlers.get("touchmove")();
    container.scrollTop = 250;
    handlers.get("scroll")();
    assert.equal(view.autoScrollEnabled, false);

    handlers.get("touchcancel")();
    now += 600;
    handlers.get("scroll")();
    assert.equal(view.autoScrollEnabled, false, "cancelled gestures keep their inertial tail");

    view.unbindMessagesScrollTracking();
    assert.equal(view.touchScrollInProgress, false);
    assert.equal(view.touchScrollInertiaUntil, 0);
    assert.equal(handlers.has("touchstart"), false);
    assert.equal(handlers.has("touchmove"), false);
    assert.equal(handlers.has("touchend"), false);
    assert.equal(handlers.has("touchcancel"), false);
  } finally {
    Date.now = originalNow;
  }
});

test("manual touch movement and wheel override a continuously refreshed programmatic scroll window", () => {
  const originalNow = Date.now;
  const originalRaf = global.requestAnimationFrame;
  const originalCancel = global.cancelAnimationFrame;
  let now = 1000;
  Date.now = () => now;
  global.requestAnimationFrame = (callback) => { callback(); return 1; };
  global.cancelAnimationFrame = () => {};
  const handlers = new Map();
  const container = {
    scrollTop: 1500,
    scrollHeight: 2000,
    clientHeight: 500,
    addEventListener(event, handler) { handlers.set(event, handler); },
    removeEventListener(event, handler) {
      if (handlers.get(event) === handler) handlers.delete(event);
    },
  };

  try {
    const view = createViewContext({ elements: { messages: container } });
    view.bindMessagesScrollTracking();
    for (let tick = 0; tick < 3; tick += 1) {
      view.withProgrammaticScroll(container, () => { container.scrollTop = 1500; });
      now += 50;
    }
    assert.ok(view.ignoreMessageScrollEventsUntil > now, "the stream keeps refreshing the suppression window");

    handlers.get("touchstart")();
    container.scrollTop = 250;
    handlers.get("scroll")();
    assert.equal(view.autoScrollEnabled, true, "a tap alone must not opt out of follow");

    handlers.get("touchmove")();
    handlers.get("scroll")();
    assert.equal(view.autoScrollEnabled, false, "a real touch move must win over stream suppression");
    view.mutateMessagesPreservingViewport(() => { container.scrollHeight = 2050; });
    assert.equal(container.scrollTop, 250, "the next stream update preserves the reader position");

    view.autoScrollEnabled = true;
    view.withProgrammaticScroll(container, () => { container.scrollTop = 1500; });
    now += 50;
    container.scrollTop = 200;
    handlers.get("wheel")();
    handlers.get("scroll")();
    assert.equal(view.autoScrollEnabled, false, "wheel input must also win over stream suppression");
  } finally {
    Date.now = originalNow;
    global.requestAnimationFrame = originalRaf;
    global.cancelAnimationFrame = originalCancel;
  }
});

test("bindMessagesScrollTracking should ignore programmatic scroll event window", () => {
  let scrollHandler = null;
  const container = {
    scrollTop: 701,
    scrollHeight: 1000,
    clientHeight: 300,
    addEventListener(event, handler) {
      if (event === "scroll") scrollHandler = handler;
    },
    removeEventListener() {},
  };

  const view = createViewContext({
    elements: { messages: container },
    autoScrollEnabled: true,
    ignoreMessageScrollEventsUntil: Date.now() + 1000,
  });
  view.bindMessagesScrollTracking();
  assert.equal(typeof scrollHandler, "function");
  assert.equal(view.autoScrollEnabled, true);

  container.scrollTop = 0;
  scrollHandler();
  assert.equal(view.autoScrollEnabled, true);
});

test("non-manual scroll should not disable auto follow", () => {
  let scrollHandler = null;
  const container = {
    scrollTop: 701,
    scrollHeight: 1000,
    clientHeight: 300,
    addEventListener(event, handler) {
      if (event === "scroll") scrollHandler = handler;
    },
    removeEventListener() {},
  };

  const view = createViewContext({
    elements: { messages: container },
    autoScrollEnabled: true,
  });
  view.bindMessagesScrollTracking();
  assert.equal(typeof scrollHandler, "function");

  container.scrollTop = 0;
  scrollHandler();
  assert.equal(view.autoScrollEnabled, true);
});

test("content shrink near the bottom does not steal follow ownership after the reader opted out", () => {
  let scrollHandler = null;
  const container = {
    scrollTop: 200,
    scrollHeight: 500,
    clientHeight: 300,
    addEventListener(event, handler) {
      if (event === "scroll") scrollHandler = handler;
    },
    removeEventListener() {},
  };
  const view = createViewContext({
    elements: { messages: container },
    autoScrollEnabled: false,
  });
  view.bindMessagesScrollTracking();
  view.autoScrollEnabled = false;

  scrollHandler();

  assert.equal(view.isMessagesNearBottom(), true);
  assert.equal(view.autoScrollEnabled, false);
});

test("message mutations synchronously pin a following reader and clear horizontal drift", () => {
  const originalRaf = global.requestAnimationFrame;
  global.requestAnimationFrame = (callback) => { callback(); return 1; };
  try {
    const container = {
      scrollTop: 650,
      scrollLeft: 37,
      scrollHeight: 1000,
      clientHeight: 300,
    };
    const view = createViewContext({ elements: { messages: container }, autoScrollEnabled: true });

    view.mutateMessagesPreservingViewport(() => {
      container.scrollHeight = 1280;
    });

    assert.equal(container.scrollTop, 1280);
    assert.equal(container.scrollLeft, 0);
    assert.equal(view.autoScrollEnabled, true);
  } finally {
    global.requestAnimationFrame = originalRaf;
  }
});

test("message mutations preserve a reader's manual vertical position while clearing horizontal drift", () => {
  const originalRaf = global.requestAnimationFrame;
  global.requestAnimationFrame = (callback) => { callback(); return 1; };
  try {
    const container = {
      scrollTop: 180,
      scrollLeft: 24,
      scrollHeight: 1000,
      clientHeight: 300,
    };
    const view = createViewContext({ elements: { messages: container }, autoScrollEnabled: false });

    view.mutateMessagesPreservingViewport(() => {
      container.scrollHeight = 1200;
    });

    assert.equal(container.scrollTop, 180);
    assert.equal(container.scrollLeft, 0);
    assert.equal(view.autoScrollEnabled, false);
  } finally {
    global.requestAnimationFrame = originalRaf;
  }
});
