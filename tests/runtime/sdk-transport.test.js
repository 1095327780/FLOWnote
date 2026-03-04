const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { SdkTransport } = require("../../runtime/sdk-transport");

function createTransport() {
  return new SdkTransport({
    vaultPath: "/vault",
    settings: {
      requestTimeoutMs: 120000,
      enableStreaming: true,
      defaultModel: "",
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

test("sdk listSessionMessages should call official session.messages endpoint", async () => {
  const transport = createTransport();
  let captured = null;

  transport.ensureClient = async () => ({
    session: {
      messages: async (params, options) => {
        captured = {
          params,
          hasSignal: Boolean(options && Object.prototype.hasOwnProperty.call(options, "signal")),
        };
        return {
          data: [
            { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
          ],
        };
      },
    },
  });

  const list = await transport.listSessionMessages({
    sessionId: "ses_1",
    limit: 50,
    signal: undefined,
  });

  assert.equal(Array.isArray(list), true);
  assert.equal(list.length, 1);
  assert.ok(captured && captured.params);
  assert.equal(captured.params.sessionID, "ses_1");
  assert.equal(captured.params.directory, "/vault");
  assert.equal(captured.params.limit, 50);
  assert.equal(captured.hasSignal, true);
});

test("sdk listModels should parse official config.providers payload with providers array", async () => {
  const transport = createTransport();

  transport.ensureClient = async () => ({
    config: {
      providers: async () => ({
        data: {
          providers: [
            {
              id: "openai",
              models: {
                "gpt-5": { id: "gpt-5" },
                "gpt-5-codex": { id: "gpt-5-codex" },
              },
            },
            {
              id: "google",
              models: {
                "gemini-2.5-pro": { id: "gemini-2.5-pro" },
              },
            },
          ],
        },
      }),
    },
  });

  const models = await transport.listModels();
  assert.deepEqual(models, [
    "google/gemini-2.5-pro",
    "openai/gpt-5",
    "openai/gpt-5-codex",
  ]);
});

test("sdk ensureClient should pass normalized fetch(url, init) bridge to sdk client", async () => {
  const transport = createTransport();
  const vendorPath = path.resolve(__dirname, "../../runtime/vendor/opencode-sdk-v2-client.cjs");
  const originalVendorCache = require.cache[vendorPath];
  const originalFetch = globalThis.fetch;

  let capturedConfig = null;
  let fetchCall = null;
  try {
    require.cache[vendorPath] = {
      id: vendorPath,
      filename: vendorPath,
      loaded: true,
      exports: {
        createOpencodeClient: (config) => {
          capturedConfig = config;
          return {
            path: {
              get: async () => ({ ok: true }),
            },
          };
        },
      },
    };

    globalThis.fetch = async (url, init) => {
      fetchCall = { url, init };
      return { ok: true };
    };

    await transport.ensureClient();
    assert.ok(capturedConfig && typeof capturedConfig.fetch === "function");

    await capturedConfig.fetch({
      url: "http://127.0.0.1:4096/provider?directory=%2Fvault",
      method: "POST",
      headers: { "x-test": "1" },
      body: "payload",
      duplex: "half",
      signal: null,
      redirect: "follow",
      cache: "default",
      credentials: "same-origin",
      integrity: "",
      keepalive: false,
      mode: "cors",
      referrer: "about:client",
      referrerPolicy: "strict-origin-when-cross-origin",
    });

    assert.ok(fetchCall);
    assert.equal(fetchCall.url, "http://127.0.0.1:4096/provider?directory=%2Fvault");
    assert.equal(fetchCall.init.method, "POST");
    assert.equal(fetchCall.init.body, "payload");
    assert.equal(fetchCall.init.duplex, "half");
  } finally {
    if (originalVendorCache) require.cache[vendorPath] = originalVendorCache;
    else delete require.cache[vendorPath];
    globalThis.fetch = originalFetch;
  }
});

test("sdk ensureClient fetch bridge should add duplex=half for streaming body without explicit duplex", async () => {
  const transport = createTransport();
  const vendorPath = path.resolve(__dirname, "../../runtime/vendor/opencode-sdk-v2-client.cjs");
  const originalVendorCache = require.cache[vendorPath];
  const originalFetch = globalThis.fetch;

  let capturedConfig = null;
  let fetchCall = null;
  try {
    require.cache[vendorPath] = {
      id: vendorPath,
      filename: vendorPath,
      loaded: true,
      exports: {
        createOpencodeClient: (config) => {
          capturedConfig = config;
          return {
            path: {
              get: async () => ({ ok: true }),
            },
          };
        },
      },
    };

    globalThis.fetch = async (url, init) => {
      fetchCall = { url, init };
      return { ok: true };
    };

    await transport.ensureClient();
    assert.ok(capturedConfig && typeof capturedConfig.fetch === "function");

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([123]));
        controller.close();
      },
    });

    await capturedConfig.fetch({
      url: "http://127.0.0.1:4096/config?directory=%2Fvault",
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: stream,
      signal: null,
    });

    assert.ok(fetchCall);
    assert.equal(fetchCall.init.method, "PATCH");
    assert.equal(fetchCall.init.duplex, "half");
  } finally {
    if (originalVendorCache) require.cache[vendorPath] = originalVendorCache;
    else delete require.cache[vendorPath];
    globalThis.fetch = originalFetch;
  }
});

test("sdk ensureClient should use launched local server url when default probe fails", async () => {
  const transport = createTransport();
  const vendorPath = path.resolve(__dirname, "../../runtime/vendor/opencode-sdk-v2-client.cjs");
  const originalVendorCache = require.cache[vendorPath];

  let capturedConfig = null;
  try {
    require.cache[vendorPath] = {
      id: vendorPath,
      filename: vendorPath,
      loaded: true,
      exports: {
        createOpencodeClient: (config) => {
          capturedConfig = config;
          return {
            path: {
              get: async () => ({ ok: true }),
            },
          };
        },
      },
    };

    transport.probeBaseUrl = async () => false;
    transport.getBootstrapTransport = () => ({
      ensureStarted: async () => "http://127.0.0.1:5099",
      stop: async () => {},
      updateSettings: () => {},
    });

    await transport.ensureClient();
    assert.ok(capturedConfig);
    assert.equal(capturedConfig.baseUrl, "http://127.0.0.1:5099");
  } finally {
    if (originalVendorCache) require.cache[vendorPath] = originalVendorCache;
    else delete require.cache[vendorPath];
  }
});

test("sdk listProviders should recover and retry once on network fetch failure", async () => {
  const transport = createTransport();
  let ensureCount = 0;
  let recovered = false;

  const firstClient = {
    provider: {
      list: async () => {
        throw new Error("Failed to fetch");
      },
    },
  };
  const secondClient = {
    provider: {
      list: async () => ({
        data: {
          all: [{ id: "openai", name: "OpenAI" }],
          connected: ["openai"],
          default: { chat: "openai/gpt-4.1" },
        },
      }),
    },
  };

  transport.ensureClient = async () => {
    ensureCount += 1;
    return ensureCount === 1 ? firstClient : secondClient;
  };
  transport.recoverFromNetworkFailure = async () => {
    recovered = true;
  };

  const out = await transport.listProviders();
  assert.equal(recovered, true);
  assert.equal(ensureCount, 2);
  assert.equal(Array.isArray(out.all), true);
  assert.equal(out.connected.includes("openai"), true);
});
