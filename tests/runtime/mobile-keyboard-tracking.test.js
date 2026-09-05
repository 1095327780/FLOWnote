const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("mobile keyboard tracking does not replace its desktop baseline with a keyboard-shrunken resize", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../runtime/flownote-view.js"), "utf8");
  assert.match(
    source,
    /bind\(window, "resize", \(\) => \{\s*baselineBottom = Math\.max\(baselineBottom, getViewportBottom\(\)\);/,
  );
});

test("mobile keyboard tracking observes Obsidian host resizing as a first-class signal", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../runtime/flownote-view.js"), "utf8");
  assert.match(source, /resolveMobileKeyboardState/);
  assert.match(source, /new ResizeObserver/);
  assert.match(source, /hostBaselineHeight/);
  assert.match(source, /hostHeight/);
  assert.match(source, /const \{ open \} = resolveMobileKeyboardState/);
});

test("mobile keyboard tracking only reacts to editable controls inside this FLOWnote view", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../runtime/flownote-view.js"), "utf8");
  assert.match(source, /if \(!root\.contains\(el\)\) return false/);
  assert.match(source, /composer\.contains\(el\)/);
  assert.match(source, /inlineQuestionHost\.contains\(el\)/);
});

test("mobile keyboard tracking never becomes a second composer layout authority", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../runtime/flownote-view.js"), "utf8");
  const methodStart = source.indexOf("_setupMobileKeyboardTracking() {");
  const methodEnd = source.indexOf("\n  appendAssistantMessage(", methodStart);
  const method = source.slice(methodStart, methodEnd);
  assert.match(method, /root\.toggleClass\("is-kb-open", open\)/);
  assert.doesNotMatch(method, /getBoundingClientRect/);
  assert.doesNotMatch(method, /--oc-kb-offset/);
  assert.doesNotMatch(method, /resolveMobileKeyboardLayout/);
  assert.doesNotMatch(method, /transform/);
});

test("mobile keyboard listeners, timers, and orientation state all have teardown paths", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../runtime/flownote-view.js"), "utf8");
  assert.match(source, /bind\(window, "orientationchange"/);
  assert.match(source, /resizeObserver\.disconnect\(\)/);
  assert.match(source, /for \(const timerId of timerIds\) window\.clearTimeout\(timerId\)/);
  assert.match(source, /for \(const dispose of disposers\) dispose\(\)/);
  assert.doesNotMatch(source, /root\.style\.removeProperty\("--oc-kb-offset"\)/);
});
