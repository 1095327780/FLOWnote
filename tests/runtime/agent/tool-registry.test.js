const test = require("node:test");
const assert = require("node:assert/strict");

const {
  TOOL_DEFAULTS,
  buildTool,
  ToolRegistry,
} = require("../../../runtime/agent/tool-registry");

function minimalDef(over = {}) {
  return {
    name: "tool_a",
    description: "test tool a",
    inputSchema: { type: "object", properties: {} },
    async *execute(_input, _ctx) {
      yield { type: "result", content: "ok" };
    },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// buildTool() input validation
// ---------------------------------------------------------------------------

test("buildTool requires a def object", () => {
  assert.throws(() => buildTool(null), /def is required/);
  assert.throws(() => buildTool(undefined), /def is required/);
});

test("buildTool requires name (non-empty string)", () => {
  assert.throws(() => buildTool({ description: "d", inputSchema: {}, execute: () => {} }), /name is required/);
  assert.throws(() => buildTool({ name: "", description: "d", inputSchema: {}, execute: () => {} }), /name is required/);
});

test("buildTool requires description", () => {
  assert.throws(() => buildTool({ name: "x", inputSchema: {}, execute: () => {} }), /description is required/);
});

test("buildTool requires inputSchema (object)", () => {
  assert.throws(() => buildTool({ name: "x", description: "d", execute: () => {} }), /inputSchema is required/);
});

test("buildTool requires execute (function)", () => {
  assert.throws(() => buildTool({ name: "x", description: "d", inputSchema: {} }), /execute must be a function/);
  assert.throws(() => buildTool({ name: "x", description: "d", inputSchema: {}, execute: "no" }), /execute must be a function/);
});

// ---------------------------------------------------------------------------
// Defaults are fail-closed
// ---------------------------------------------------------------------------

test("TOOL_DEFAULTS treat unknown tools as side-effectful, not concurrency-safe, not read-only", () => {
  assert.equal(TOOL_DEFAULTS.isReadOnly(), false);
  assert.equal(TOOL_DEFAULTS.isDestructive(), false);
  assert.equal(TOOL_DEFAULTS.isConcurrencySafe(), false);
  assert.equal(TOOL_DEFAULTS.isEnabled(), true);
});

test("TOOL_DEFAULTS.checkPermissions allows by default (general system gates writes)", async () => {
  const r = await TOOL_DEFAULTS.checkPermissions();
  assert.equal(r.behavior, "allow");
});

test("buildTool inherits defaults when fields are omitted", () => {
  const t = buildTool(minimalDef());
  assert.equal(t.isReadOnly(), false);
  assert.equal(t.isDestructive(), false);
  assert.equal(t.isConcurrencySafe(), false);
  assert.equal(t.isEnabled(), true);
});

test("buildTool keeps overrides over defaults", () => {
  const t = buildTool(minimalDef({
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
  }));
  assert.equal(t.isReadOnly(), true);
  assert.equal(t.isConcurrencySafe(), true);
  assert.equal(t.isDestructive(), false);
});

// ---------------------------------------------------------------------------
// ToolRegistry behavior
// ---------------------------------------------------------------------------

test("registry register + get + size", () => {
  const r = new ToolRegistry();
  assert.equal(r.size(), 0);
  const tool = buildTool(minimalDef());
  r.register(tool);
  assert.equal(r.size(), 1);
  assert.equal(r.get("tool_a"), tool);
  assert.equal(r.get("nope"), undefined);
});

test("registry rejects duplicate names", () => {
  const r = new ToolRegistry();
  r.register(buildTool(minimalDef({ name: "dup" })));
  assert.throws(() => r.register(buildTool(minimalDef({ name: "dup" }))), /duplicate tool "dup"/);
});

test("registry registerAll registers many at once", () => {
  const r = new ToolRegistry();
  r.registerAll([
    buildTool(minimalDef({ name: "a" })),
    buildTool(minimalDef({ name: "b" })),
    buildTool(minimalDef({ name: "c" })),
  ]);
  assert.equal(r.size(), 3);
  assert.deepEqual(r.list().map((t) => t.name), ["a", "b", "c"]);
});

test("registry subset filters by allowed names", () => {
  const r = new ToolRegistry();
  r.registerAll([
    buildTool(minimalDef({ name: "a" })),
    buildTool(minimalDef({ name: "b" })),
    buildTool(minimalDef({ name: "c" })),
  ]);
  const sub = r.subset(["a", "c", "not-a-tool"]);
  assert.deepEqual(sub.map((t) => t.name), ["a", "c"]);
});

test("registry subset returns all tools when given non-array", () => {
  const r = new ToolRegistry();
  r.registerAll([
    buildTool(minimalDef({ name: "a" })),
    buildTool(minimalDef({ name: "b" })),
  ]);
  assert.equal(r.subset(undefined).length, 2);
  assert.equal(r.subset(null).length, 2);
});

// ---------------------------------------------------------------------------
// toApiSpecs() emits the Anthropic shape and only the public fields
// ---------------------------------------------------------------------------

test("toApiSpecs emits Anthropic tool-spec shape with no internal flags", () => {
  const r = new ToolRegistry();
  r.register(buildTool({
    name: "vault_read",
    description: "Read a vault note.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute() { yield { type: "result", content: "" }; },
  }));
  const specs = r.toApiSpecs();
  assert.equal(specs.length, 1);
  assert.deepEqual(Object.keys(specs[0]).sort(), ["description", "input_schema", "name"]);
  assert.equal(specs[0].name, "vault_read");
  assert.equal(specs[0].description, "Read a vault note.");
  assert.equal(specs[0].input_schema.properties.path.type, "string");
});

test("toApiSpecs honors a passed-in subset", () => {
  const r = new ToolRegistry();
  r.registerAll([
    buildTool(minimalDef({ name: "a" })),
    buildTool(minimalDef({ name: "b" })),
    buildTool(minimalDef({ name: "c" })),
  ]);
  const subset = r.subset(["b"]);
  const specs = r.toApiSpecs(subset);
  assert.equal(specs.length, 1);
  assert.equal(specs[0].name, "b");
});

test("registry.register rejects tool without name property", () => {
  const r = new ToolRegistry();
  assert.throws(() => r.register({}), /tool with name required/);
  assert.throws(() => r.register(null), /tool with name required/);
});
