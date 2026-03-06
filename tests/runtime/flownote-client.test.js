const test = require("node:test");
const assert = require("node:assert/strict");

const { FLOWnoteClient } = require("../../runtime/flownote-client");

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

    async getSessionDiff(payload) {
      const sessionId = String(payload && payload.sessionId ? payload.sessionId : "");
      const messageId = String(payload && payload.messageId ? payload.messageId : "");
      this.calls.push(`getSessionDiff:${sessionId}:${messageId}`);
      if (options.failGetSessionDiff) throw new Error(`${label} diff failed`);
      return Array.isArray(options.sessionDiff) ? options.sessionDiff : [];
    }

    async stop() {
      this.stopCalled += 1;
    }
  }
  TransportMock.instances = instances;
  return TransportMock;
}

test("FLOWnoteClient should require injected SdkTransport", async () => {
  assert.throws(() => new FLOWnoteClient({ settings: {} }), /SdkTransport/);
});

test("FLOWnoteClient should use sdk path", async () => {
  const SdkTransport = createTransportClass("sdk");
  const client = new FLOWnoteClient({
    settings: {},
    SdkTransport,
  });

  const result = await client.testConnection();
  assert.equal(result.mode, "sdk");
  assert.equal(SdkTransport.instances[0].calls.length, 1);
  assert.equal(client.lastMode, "sdk");
});

test("FLOWnoteClient should fail fast when sdk path fails", async () => {
  const SdkTransport = createTransportClass("sdk", { failTestConnection: true });
  const client = new FLOWnoteClient({
    settings: {},
    SdkTransport,
  });

  await assert.rejects(async () => client.testConnection(), /sdk failed/);
  assert.equal(SdkTransport.instances[0].calls.length, 1);
});

test("FLOWnoteClient listSessionMessages should return transport result", async () => {
  const SdkTransport = createTransportClass("sdk", {
    sessionMessages: [{ id: "m1", info: { role: "assistant" }, parts: [] }],
  });
  const client = new FLOWnoteClient({
    settings: {},
    SdkTransport,
  });

  const list = await client.listSessionMessages({ sessionId: "s1" });
  assert.equal(Array.isArray(list), true);
  assert.equal(list.length, 1);
  assert.equal(SdkTransport.instances[0].calls[0], "listSessionMessages:s1");
});

test("FLOWnoteClient getSessionDiff should return transport result", async () => {
  const SdkTransport = createTransportClass("sdk", {
    sessionDiff: [{ file: "a.md", before: "", after: "x", additions: 1, deletions: 0 }],
  });
  const client = new FLOWnoteClient({
    settings: {},
    SdkTransport,
  });

  const list = await client.getSessionDiff({ sessionId: "s1", messageId: "m1" });
  assert.equal(Array.isArray(list), true);
  assert.equal(list.length, 1);
  assert.equal(SdkTransport.instances[0].calls[0], "getSessionDiff:s1:m1");
});
