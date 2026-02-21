const test = require("node:test");
const assert = require("node:assert/strict");

const { OpenCodeClient } = require("../../runtime/open-code-client");

function createTransportClass(label, options = {}) {
  const instances = [];
  class TransportMock {
    constructor() {
      this.label = label;
      this.calls = [];
      this.settings = null;
      this.stopCalled = 0;
      instances.push(this);
    }

    updateSettings(settings) {
      this.settings = settings;
    }

    async testConnection() {
      this.calls.push("testConnection");
      if (options.failTestConnection) throw new Error(`${label} failed`);
      return { ok: true, mode: label };
    }

    async listSessionMessages(payload) {
      this.calls.push(`listSessionMessages:${String(payload && payload.sessionId ? payload.sessionId : "")}`);
      if (options.failListSessionMessages) throw new Error(`${label} list failed`);
      return Array.isArray(options.sessionMessages) ? options.sessionMessages : [];
    }

    async stop() {
      this.stopCalled += 1;
    }
  }
  TransportMock.instances = instances;
  return TransportMock;
}

test("OpenCodeClient should use compat path when experimental sdk is disabled", async () => {
  const SdkTransport = createTransportClass("sdk");
  const CompatTransport = createTransportClass("compat");
  const client = new OpenCodeClient({
    settings: { transportMode: "sdk", experimentalSdkEnabled: false },
    SdkTransport,
    CompatTransport,
  });

  const result = await client.testConnection();
  assert.equal(result.mode, "compat");
  assert.equal(CompatTransport.instances[0].calls.length, 1);
  assert.equal(SdkTransport.instances[0].calls.length, 0);
  assert.equal(client.lastMode, "compat");
});

test("OpenCodeClient should use sdk path only when experimental sdk is enabled", async () => {
  const SdkTransport = createTransportClass("sdk");
  const CompatTransport = createTransportClass("compat");
  const client = new OpenCodeClient({
    settings: { transportMode: "sdk", experimentalSdkEnabled: true },
    SdkTransport,
    CompatTransport,
  });

  const result = await client.testConnection();
  assert.equal(result.mode, "sdk");
  assert.equal(SdkTransport.instances[0].calls.length, 1);
  assert.equal(CompatTransport.instances[0].calls.length, 0);
  assert.equal(client.lastMode, "sdk");
});

test("OpenCodeClient should fallback to compat when sdk experimental path fails", async () => {
  const SdkTransport = createTransportClass("sdk", { failTestConnection: true });
  const CompatTransport = createTransportClass("compat");
  const client = new OpenCodeClient({
    settings: { transportMode: "sdk", experimentalSdkEnabled: true },
    SdkTransport,
    CompatTransport,
  });

  const result = await client.testConnection();
  assert.equal(result.mode, "compat");
  assert.equal(SdkTransport.instances[0].calls.length, 1);
  assert.equal(CompatTransport.instances[0].calls.length, 1);
  assert.equal(client.lastMode, "compat");
});

test("OpenCodeClient listSessionMessages should return transport result", async () => {
  const SdkTransport = createTransportClass("sdk", {
    sessionMessages: [{ id: "m1", info: { role: "assistant" }, parts: [] }],
  });
  const CompatTransport = createTransportClass("compat", {
    sessionMessages: [{ id: "m2", info: { role: "assistant" }, parts: [] }],
  });
  const client = new OpenCodeClient({
    settings: { transportMode: "compat", experimentalSdkEnabled: false },
    SdkTransport,
    CompatTransport,
  });

  const list = await client.listSessionMessages({ sessionId: "s1" });
  assert.equal(Array.isArray(list), true);
  assert.equal(list.length, 1);
  assert.equal(CompatTransport.instances[0].calls[0], "listSessionMessages:s1");
});
