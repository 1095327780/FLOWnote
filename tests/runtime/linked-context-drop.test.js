const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadLinkedContextMethodsWithMockObsidian() {
  const originalLoad = Module._load;
  class NoticeMock {
    static messages = [];

    constructor(message) {
      NoticeMock.messages.push(String(message || ""));
    }

    static reset() {
      NoticeMock.messages = [];
    }
  }

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") {
      return {
        Notice: NoticeMock,
        setIcon() {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const modulePath = require.resolve("../../runtime/view/layout/linked-context-methods");
  const dropModulePath = require.resolve("../../runtime/view/layout/linked-context-drop-methods");
  delete require.cache[modulePath];
  delete require.cache[dropModulePath];
  const { linkedContextMethods } = require(modulePath);

  return {
    linkedContextMethods,
    NoticeMock,
    restore() {
      Module._load = originalLoad;
      delete require.cache[modulePath];
      delete require.cache[dropModulePath];
    },
  };
}

function createDropEvent(payload = {}) {
  const dataByType = {
    "text/plain": String(payload.textPlain || ""),
    "text/uri-list": String(payload.uriList || ""),
    "text/html": String(payload.html || ""),
    "application/x-obsidian-link": String(payload.obsidian || ""),
  };
  const types = [...new Set([
    ...Object.entries(dataByType)
      .filter(([, value]) => value)
      .map(([type]) => type),
    ...((Array.isArray(payload.extraTypes) ? payload.extraTypes : []).map((type) => String(type || "").trim()).filter(Boolean)),
  ])];
  let prevented = 0;
  let stopped = 0;
  const event = {
    currentTarget: payload.currentTarget || null,
    relatedTarget: payload.relatedTarget || null,
    dataTransfer: {
      files: Array.isArray(payload.files) ? payload.files : [],
      items: Array.isArray(payload.items) ? payload.items : [],
      types,
      dropEffect: "none",
      getData(type) {
        return dataByType[type] || "";
      },
    },
    preventDefault() {
      prevented += 1;
    },
    stopPropagation() {
      stopped += 1;
    },
  };
  Object.defineProperty(event, "prevented", {
    get() {
      return prevented;
    },
  });
  Object.defineProperty(event, "stopped", {
    get() {
      return stopped;
    },
  });
  return event;
}

function createMockView(linkedContextMethods, options = {}) {
  const filesByPath = new Map(Object.entries(options.filesByPath || {}).map(([path, descriptor]) => {
    if (descriptor && typeof descriptor === "object" && !Array.isArray(descriptor)) {
      return [path, { path, ...descriptor }];
    }
    return [path, { path, extension: descriptor }];
  }));
  const linkResolver = options.linkResolver || (() => null);
  const fileContentsByPath = options.fileContentsByPath && typeof options.fileContentsByPath === "object"
    ? options.fileContentsByPath
    : {};
  let focused = 0;
  let dropTargetActive = false;
  let indicatorRefreshCount = 0;

  const view = {
    ...linkedContextMethods,
    app: {
      vault: {
        getAbstractFileByPath(path) {
          return filesByPath.get(String(path || "")) || null;
        },
        getFiles() {
          return Array.from(filesByPath.values()).filter((entry) => {
            const ext = String(entry && entry.extension ? entry.extension : "").trim().toLowerCase();
            return Boolean(ext);
          });
        },
        async read(file) {
          const pathValue = String(file && file.path ? file.path : "");
          return String(fileContentsByPath[pathValue] || "");
        },
        async cachedRead(file) {
          const pathValue = String(file && file.path ? file.path : "");
          return String(fileContentsByPath[pathValue] || "");
        },
        adapter: {
          getBasePath() {
            return "/Users/shanghao/vault";
          },
        },
      },
      metadataCache: {
        getFirstLinkpathDest(linkpath, sourcePath) {
          return linkResolver(String(linkpath || ""), String(sourcePath || ""));
        },
        fileToLinktext(file, sourcePath, omitMdExtension) {
          const filePath = String(file && file.path ? file.path : "");
          if (!filePath) return "";
          const base = filePath.replace(/\.md$/i, "");
          const raw = omitMdExtension ? base : filePath;
          return options.fileToLinktext
            ? String(options.fileToLinktext(file, sourcePath, omitMdExtension) || raw)
            : raw;
        },
      },
      workspace: {
        getActiveFile() {
          return { path: "Inbox/today.md" };
        },
      },
    },
    elements: {
      inputWrapper: {
        toggleClass(name, enabled) {
          if (name === "is-drop-target") dropTargetActive = Boolean(enabled);
        },
      },
      input: {
        focus() {
          focused += 1;
        },
      },
    },
    linkedContextFiles: Array.isArray(options.initialLinked) ? options.initialLinked.slice() : [],
    refreshLinkedContextIndicators() {
      indicatorRefreshCount += 1;
    },
  };

  return {
    view,
    getFocusedCount() {
      return focused;
    },
    isDropTargetActive() {
      return dropTargetActive;
    },
    getIndicatorRefreshCount() {
      return indicatorRefreshCount;
    },
  };
}

test("extractLinkedContextPathsFromDropEvent should resolve dropped files from explorer-like payload", () => {
  const fixture = loadLinkedContextMethodsWithMockObsidian();
  try {
    const { linkedContextMethods } = fixture;
    const { view } = createMockView(linkedContextMethods, {
      filesByPath: {
        "Projects/Alpha.md": "md",
        "Projects/Board.canvas": "canvas",
      },
      linkResolver(linkpath) {
        if (linkpath === "Alpha") return { path: "Projects/Alpha.md", extension: "md" };
        return null;
      },
    });

    const event = createDropEvent({
      files: [{ path: "/Users/shanghao/vault/Projects/Board.canvas", name: "Board.canvas" }],
      textPlain: "[[Alpha]]\nUnrelated plain text",
      uriList: "obsidian://open?vault=FLOWnote4&file=Projects%2FAlpha.md",
    });

    const out = linkedContextMethods.extractLinkedContextPathsFromDropEvent.call(view, event);
    assert.deepEqual(out.sort(), ["Projects/Alpha.md", "Projects/Board.canvas"].sort());
  } finally {
    fixture.restore();
  }
});

test("handleLinkedContextInputDrop should append new linked files and keep existing ones", () => {
  const fixture = loadLinkedContextMethodsWithMockObsidian();
  try {
    const { linkedContextMethods, NoticeMock } = fixture;
    NoticeMock.reset();

    const state = createMockView(linkedContextMethods, {
      filesByPath: {
        "Projects/Alpha.md": "md",
        "Projects/Beta.md": "md",
      },
      initialLinked: ["Projects/Alpha.md"],
      linkResolver(linkpath) {
        if (linkpath === "Beta") return { path: "Projects/Beta.md", extension: "md" };
        return null;
      },
    });
    const { view } = state;

    view.setLinkedContextDropActive(true);
    const event = createDropEvent({
      textPlain: "[[Alpha]] [[Beta]]",
    });

    const handled = linkedContextMethods.handleLinkedContextInputDrop.call(view, event);
    assert.equal(handled, true);
    assert.equal(event.prevented, 1);
    assert.equal(event.stopped, 1);
    assert.deepEqual(view.linkedContextFiles, ["Projects/Alpha.md", "Projects/Beta.md"]);
    assert.equal(state.getIndicatorRefreshCount(), 1);
    assert.equal(state.getFocusedCount(), 1);
    assert.equal(state.isDropTargetActive(), false);
    assert.equal(NoticeMock.messages.length, 0);
  } finally {
    fixture.restore();
  }
});

test("handleLinkedContextInputDrop should resolve obsidian uri without extension to linked file chip", () => {
  const fixture = loadLinkedContextMethodsWithMockObsidian();
  try {
    const { linkedContextMethods, NoticeMock } = fixture;
    NoticeMock.reset();

    const { view, getFocusedCount, getIndicatorRefreshCount } = createMockView(linkedContextMethods, {
      filesByPath: {
        "Projects/Beta.md": "md",
      },
    });

    const event = createDropEvent({
      uriList: "obsidian://open?vault=FLOWnote4&file=Projects%2FBeta",
      textPlain: "obsidian://open?vault=FLOWnote4&file=Projects%2FBeta",
    });

    const handled = linkedContextMethods.handleLinkedContextInputDrop.call(view, event);
    assert.equal(handled, true);
    assert.equal(event.prevented, 1);
    assert.equal(event.stopped, 1);
    assert.deepEqual(view.linkedContextFiles, ["Projects/Beta.md"]);
    assert.equal(getIndicatorRefreshCount(), 1);
    assert.equal(getFocusedCount(), 1);
    assert.equal(NoticeMock.messages.length, 0);
  } finally {
    fixture.restore();
  }
});

test("handleLinkedContextInputDrop should resolve obsidian uri with path query", () => {
  const fixture = loadLinkedContextMethodsWithMockObsidian();
  try {
    const { linkedContextMethods } = fixture;

    const { view } = createMockView(linkedContextMethods, {
      filesByPath: {
        "Project/alpha.md": "md",
      },
    });

    const event = createDropEvent({
      textPlain: "obsidian://advanced-uri?vault=FLOWnote4&path=Project%2Falpha",
    });

    const handled = linkedContextMethods.handleLinkedContextInputDrop.call(view, event);
    assert.equal(handled, true);
    assert.equal(event.prevented, 1);
    assert.equal(event.stopped, 1);
    assert.deepEqual(view.linkedContextFiles, ["Project/alpha.md"]);
  } finally {
    fixture.restore();
  }
});

test("handleLinkedContextInputDrop should resolve file linkpath by vault scan fallback", () => {
  const fixture = loadLinkedContextMethodsWithMockObsidian();
  try {
    const { linkedContextMethods } = fixture;

    const { view } = createMockView(linkedContextMethods, {
      filesByPath: {
        "03-进阶/🌱 个人成长.md": "md",
      },
      linkResolver() {
        return null;
      },
      fileToLinktext(file, _sourcePath, omitMdExtension) {
        const pathValue = String(file && file.path ? file.path : "");
        const noExt = pathValue.replace(/\.md$/i, "");
        return omitMdExtension ? noExt : pathValue;
      },
    });

    const event = createDropEvent({
      textPlain: "obsidian://open?vault=FLOWnote4&file=03-%E8%BF%9B%E9%98%B6%2F%F0%9F%8C%B1%20%E4%B8%AA%E4%BA%BA%E6%88%90%E9%95%BF",
    });

    const handled = linkedContextMethods.handleLinkedContextInputDrop.call(view, event);
    assert.equal(handled, true);
    assert.equal(event.prevented, 1);
    assert.equal(event.stopped, 1);
    assert.deepEqual(view.linkedContextFiles, ["03-进阶/🌱 个人成长.md"]);
  } finally {
    fixture.restore();
  }
});

test("extractLinkedContextPathsFromDropEvent should resolve dropped folders from explorer-like payload", () => {
  const fixture = loadLinkedContextMethodsWithMockObsidian();
  try {
    const { linkedContextMethods } = fixture;
    const { view } = createMockView(linkedContextMethods, {
      filesByPath: {
        Projects: { children: [] },
      },
    });

    const event = createDropEvent({
      files: [{ path: "/Users/shanghao/vault/Projects", name: "Projects" }],
      textPlain: "Projects",
    });

    const out = linkedContextMethods.extractLinkedContextPathsFromDropEvent.call(view, event);
    assert.deepEqual(out, ["Projects"]);
  } finally {
    fixture.restore();
  }
});

test("handleLinkedContextInputDrop should append dropped folder path into linked context", () => {
  const fixture = loadLinkedContextMethodsWithMockObsidian();
  try {
    const { linkedContextMethods, NoticeMock } = fixture;
    NoticeMock.reset();

    const { view, getFocusedCount, getIndicatorRefreshCount } = createMockView(linkedContextMethods, {
      filesByPath: {
        Projects: { children: [] },
      },
    });

    const event = createDropEvent({
      files: [{ path: "/Users/shanghao/vault/Projects", name: "Projects" }],
      textPlain: "Projects",
    });

    const handled = linkedContextMethods.handleLinkedContextInputDrop.call(view, event);
    assert.equal(handled, true);
    assert.equal(event.prevented, 1);
    assert.equal(event.stopped, 1);
    assert.deepEqual(view.linkedContextFiles, ["Projects"]);
    assert.equal(getIndicatorRefreshCount(), 1);
    assert.equal(getFocusedCount(), 1);
    assert.equal(NoticeMock.messages.length, 0);
  } finally {
    fixture.restore();
  }
});

test("extractLinkedContextPathsFromDropEvent should resolve dropped folders from item entry payload", () => {
  const fixture = loadLinkedContextMethodsWithMockObsidian();
  try {
    const { linkedContextMethods } = fixture;
    const { view } = createMockView(linkedContextMethods, {
      filesByPath: {
        "Areas/Projects": { children: [] },
      },
    });

    const event = createDropEvent({
      items: [{
        kind: "file",
        getAsFile() {
          return {
            path: "/Users/shanghao/vault/Areas/Projects",
            name: "Projects",
          };
        },
        webkitGetAsEntry() {
          return {
            isDirectory: true,
            isFile: false,
            fullPath: "/Areas/Projects",
            name: "Projects",
          };
        },
      }],
      extraTypes: ["Files"],
      textPlain: "Projects",
    });

    const out = linkedContextMethods.extractLinkedContextPathsFromDropEvent.call(view, event);
    assert.deepEqual(out, ["Areas/Projects"]);
  } finally {
    fixture.restore();
  }
});

test("handleLinkedContextInputDrop should intercept unsupported file-like item payload", () => {
  const fixture = loadLinkedContextMethodsWithMockObsidian();
  try {
    const { linkedContextMethods, NoticeMock } = fixture;
    NoticeMock.reset();

    const { view, getFocusedCount, getIndicatorRefreshCount } = createMockView(linkedContextMethods, {
      filesByPath: {
        "Projects/Alpha.md": "md",
      },
    });

    const event = createDropEvent({
      items: [{
        kind: "file",
        getAsFile() {
          return null;
        },
        webkitGetAsEntry() {
          return {
            isDirectory: true,
            isFile: false,
            fullPath: "/ExternalFolder",
            name: "ExternalFolder",
          };
        },
      }],
      extraTypes: ["Files"],
      textPlain: "ExternalFolder",
    });

    const handled = linkedContextMethods.handleLinkedContextInputDrop.call(view, event);
    assert.equal(handled, true);
    assert.equal(event.prevented, 1);
    assert.equal(event.stopped, 1);
    assert.deepEqual(view.linkedContextFiles, []);
    assert.equal(getIndicatorRefreshCount(), 0);
    assert.equal(getFocusedCount(), 1);
    assert.equal(NoticeMock.messages.length, 1);
  } finally {
    fixture.restore();
  }
});

test("buildLinkedContextPromptBlock should include folder path without attaching file content", async () => {
  const fixture = loadLinkedContextMethodsWithMockObsidian();
  try {
    const { linkedContextMethods } = fixture;
    const { view } = createMockView(linkedContextMethods, {
      filesByPath: {
        Projects: { children: [] },
        "Projects/Alpha.md": { extension: "md" },
      },
      fileContentsByPath: {
        "Projects/Alpha.md": "# Alpha\nbody\n",
      },
      initialLinked: ["Projects", "Projects/Alpha.md"],
    });

    const block = await linkedContextMethods.buildLinkedContextPromptBlock.call(view);
    assert.match(block, /<<<FLOWNOTE_FOLDER path="Projects">>>/);
    assert.match(block, /\[Folder path only; file contents are not attached\.\]/);
    assert.match(block, /<<<FLOWNOTE_FILE path="Projects\/Alpha\.md">>>/);
  } finally {
    fixture.restore();
  }
});

test("handleLinkedContextInputDrop should ignore non-file payloads", () => {
  const fixture = loadLinkedContextMethodsWithMockObsidian();
  try {
    const { linkedContextMethods, NoticeMock } = fixture;
    NoticeMock.reset();

    const { view, getFocusedCount, getIndicatorRefreshCount } = createMockView(linkedContextMethods, {
      filesByPath: {
        "Projects/Alpha.md": "md",
      },
      initialLinked: ["Projects/Alpha.md"],
    });

    const event = createDropEvent({
      textPlain: "just text",
    });

    const handled = linkedContextMethods.handleLinkedContextInputDrop.call(view, event);
    assert.equal(handled, false);
    assert.equal(event.prevented, 0);
    assert.equal(event.stopped, 0);
    assert.deepEqual(view.linkedContextFiles, ["Projects/Alpha.md"]);
    assert.equal(getIndicatorRefreshCount(), 0);
    assert.equal(getFocusedCount(), 0);
    assert.equal(NoticeMock.messages.length, 0);
  } finally {
    fixture.restore();
  }
});
