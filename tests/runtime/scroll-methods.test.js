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
  assert.equal(typeof view.messagesIntentHandler, "function");

  view.messagesIntentHandler();
  scrollHandler();
  assert.equal(view.autoScrollEnabled, false);

  container.scrollTop = 701;
  scrollHandler();
  assert.equal(view.autoScrollEnabled, true);
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
