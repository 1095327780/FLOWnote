const test = require("node:test");
const assert = require("node:assert/strict");

const { SdkTransport } = require("../../runtime/sdk-transport");

function createTransport() {
  return new SdkTransport({
    vaultPath: "/vault",
    settings: {
      requestTimeoutMs: 120000,
      enableStreaming: true,
      defaultModel: "",
      experimentalSdkEnabled: true,
      transportMode: "sdk",
    },
    logger: () => {},
  });
}

test("sdk sendMessage should emit polling updates when event stream fallback is needed", async () => {
  const transport = createTransport();
  const tokenUpdates = [];
  let pollingHandlerPassed = false;

  transport.ensureClient = async () => ({
    session: {
      promptAsync: async () => ({ data: {} }),
    },
  });
  transport.streamAssistantFromEvents = async () => {
    throw new Error("sse unavailable");
  };
  transport.pollAssistantResult = async (_client, _sessionId, _startedAt, _signal, _preferredMessageId, handlers) => {
    pollingHandlerPassed = Boolean(handlers && typeof handlers.onToken === "function");
    if (handlers && typeof handlers.onToken === "function") handlers.onToken("polling-stream");
    return {
      messageId: "msg_poll",
      text: "polling-stream",
      reasoning: "",
      meta: "",
      blocks: [],
      completed: true,
    };
  };

  const result = await transport.sendMessage({
    sessionId: "ses_1",
    prompt: "hello",
    onToken: (text) => tokenUpdates.push(String(text || "")),
  });

  assert.equal(pollingHandlerPassed, true);
  assert.equal(result.text, "polling-stream");
  assert.equal(result.messageId, "msg_poll");
  assert.equal(tokenUpdates.includes("polling-stream"), true);
});
