const test = require("node:test");
const assert = require("node:assert/strict");

const { DiagnosticsService } = require("../../runtime/diagnostics-service");

class ResolverMock {
  constructor() {
    this.calls = 0;
  }

  async resolve() {
    this.calls += 1;
    return {
      ok: true,
      path: "/tmp/opencode",
      attempted: ["/tmp/opencode"],
    };
  }
}

test("runCached should reuse cached result within ttl", async () => {
  let connectionCalls = 0;
  const plugin = {
    settings: { cliPath: "", transportMode: "compat" },
    opencodeClient: {
      async testConnection() {
        connectionCalls += 1;
        return { mode: "compat" };
      },
    },
  };

  const service = new DiagnosticsService(plugin, ResolverMock);
  const first = await service.runCached(10_000, false);
  const second = await service.runCached(10_000, false);

  assert.equal(connectionCalls, 1);
  assert.equal(service.resolver.calls, 1);
  assert.deepEqual(first, second);
});

test("runCached should bypass cache when force=true", async () => {
  let connectionCalls = 0;
  const plugin = {
    settings: { cliPath: "", transportMode: "compat" },
    opencodeClient: {
      async testConnection() {
        connectionCalls += 1;
        return { mode: "compat" };
      },
    },
  };

  const service = new DiagnosticsService(plugin, ResolverMock);
  await service.runCached(10_000, false);
  await service.runCached(10_000, true);

  assert.equal(connectionCalls, 2);
  assert.equal(service.resolver.calls, 2);
});

test("runCached should singleflight concurrent requests", async () => {
  let connectionCalls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const plugin = {
    settings: { cliPath: "", transportMode: "compat" },
    opencodeClient: {
      async testConnection() {
        connectionCalls += 1;
        await gate;
        return { mode: "compat" };
      },
    },
  };

  const service = new DiagnosticsService(plugin, ResolverMock);
  const p1 = service.runCached(10_000, false);
  const p2 = service.runCached(10_000, false);
  release();
  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(connectionCalls, 1);
  assert.equal(service.resolver.calls, 1);
  assert.deepEqual(r1, r2);
});

