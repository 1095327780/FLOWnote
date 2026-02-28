const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");

test("guard-file-size should pass for current source tree", () => {
  const output = execFileSync("node", ["scripts/guard-file-size.js"], {
    encoding: "utf8",
  });
  assert.match(output, /\[guard-file-size\] OK/);
});
