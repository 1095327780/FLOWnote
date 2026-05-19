const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

class FakeScrollEl {
  constructor({ scrollTop = 0, scrollLeft = 0, scrollHeight = 1000, clientHeight = 400, scrollWidth = 800, clientWidth = 300 } = {}) {
    this.scrollTop = scrollTop;
    this.scrollLeft = scrollLeft;
    this.scrollHeight = scrollHeight;
    this.clientHeight = clientHeight;
    this.scrollWidth = scrollWidth;
    this.clientWidth = clientWidth;
    this.listeners = new Map();
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  removeEventListener(type, handler) {
    if (this.listeners.get(type) === handler) this.listeners.delete(type);
  }

  dispatch(type) {
    const handler = this.listeners.get(type);
    if (typeof handler === "function") handler();
  }
}

function loadLayoutRendererWithMockObsidian() {
  const originalLoad = Module._load;
  const modulePath = require.resolve("../../runtime/view/layout-renderer");
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") {
      return {
        Notice: class {},
        setIcon() {},
        normalizePath(value) {
          return String(value || "");
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[modulePath];
  const { layoutRendererMethods } = require(modulePath);
  return {
    layoutRendererMethods,
    restore() {
      Module._load = originalLoad;
      delete require.cache[modulePath];
    },
  };
}

test("home scroll state should be saved from old container and restored after rerender", () => {
  const fixture = loadLayoutRendererWithMockObsidian();
  const originalRaf = global.requestAnimationFrame;
  const originalCancel = global.cancelAnimationFrame;
  try {
    global.requestAnimationFrame = (callback) => {
      callback();
      return 1;
    };
    global.cancelAnimationFrame = () => {};

    const view = {
      elements: {},
      homeScrollState: { top: 0, left: 0, statsLeft: 0 },
      pendingHomeScrollRaf: 0,
      ...fixture.layoutRendererMethods,
    };

    const oldHome = new FakeScrollEl({ scrollTop: 260, scrollLeft: 4 });
    const oldStats = new FakeScrollEl({ scrollLeft: 88 });
    view.bindHomeScrollTracking(oldHome, oldStats);
    oldHome.dispatch("scroll");
    oldStats.dispatch("scroll");

    assert.deepEqual(view.homeScrollState, { top: 260, left: 4, statsLeft: 88 });

    const newHome = new FakeScrollEl({ scrollTop: 0, scrollLeft: 0, scrollHeight: 1200, clientHeight: 500 });
    const newStats = new FakeScrollEl({ scrollLeft: 0, scrollWidth: 900, clientWidth: 300 });
    view.bindHomeScrollTracking(newHome, newStats);
    view.restoreHomeScrollPosition(newHome, newStats);

    assert.equal(newHome.scrollTop, 260);
    assert.equal(newHome.scrollLeft, 4);
    assert.equal(newStats.scrollLeft, 88);
  } finally {
    global.requestAnimationFrame = originalRaf;
    global.cancelAnimationFrame = originalCancel;
    fixture.restore();
  }
});
