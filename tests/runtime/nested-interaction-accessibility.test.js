const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(file) {
  return fs.readFileSync(path.join(__dirname, "../../runtime", file), "utf8");
}

test("tool and patch summaries render file paths as non-interactive text", () => {
  const blocks = source("view/message/block-render-methods.js");
  assert.match(blocks, /function renderPatchPath\(container, text, pathInfo, view, options = \{\}\)/);
  assert.match(blocks, /if \(options\.interactive === false \|\| !info\.isLinkable\)/);
  assert.match(blocks, /renderPatchPath\(pathWrap, linkedPathInfo\.displayPath, linkedPathInfo, this, \{ interactive: false \}\)/);
  assert.match(blocks, /renderPatchPath\(summaryPathWrap, primaryPath\.label, primaryPath\.pathInfo, this, \{ interactive: false \}\)/);
  assert.match(blocks, /renderPatchPath\(item, pathInfo\.displayPath \|\| displayPath, pathInfo, view\)/);
});

test("session rename input has an accessible localized label and mobile keyboard hint", () => {
  const sidebar = source("view/layout/sidebar-methods.js");
  assert.match(sidebar, /input\.setAttribute\("aria-label", tr\(this, "view\.session\.rename", "Rename session"\)\)/);
  assert.match(sidebar, /input\.setAttribute\("enterkeyhint", "done"\)/);
});
