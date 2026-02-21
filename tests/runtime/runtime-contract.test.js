const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const { createModuleLoaderMethods } = require("../../runtime/plugin/module-loader-methods");

test("module loader should expose static bootstrap surface only", () => {
  const methods = createModuleLoaderMethods();
  assert.equal(typeof methods.getViewType, "function");
  assert.equal(typeof methods.ensureRuntimeModules, "function");
  assert.equal(Object.prototype.hasOwnProperty.call(methods, "resolveRuntimeModulePath"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(methods, "loadRuntimeModuleFile"), false);
});

test("runtime contracts should avoid dynamic execution and note-file model cache", () => {
  const loaderCode = fs.readFileSync("runtime/plugin/module-loader-methods.js", "utf8");
  const modelCatalogCode = fs.readFileSync("runtime/plugin/model-catalog-methods.js", "utf8");

  assert.equal(/new Function\s*\(/.test(loaderCode), false);
  assert.equal(/终端输出\.md/.test(modelCatalogCode), false);
});
