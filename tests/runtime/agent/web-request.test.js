const test = require("node:test");
const assert = require("node:assert/strict");

const { createWebRequestTool } = require("../../../runtime/agent/tools/web-request");

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

test("web_request sends POST JSON with substituted secret headers", async () => {
  const calls = [];
  const tool = createWebRequestTool({
    getSecrets: () => ({ WEREAD_API_KEY: "wrk-test-secret" }),
    requestUrl: async (request) => {
      calls.push(request);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({ ok: true }),
      };
    },
  });

  const result = await collect(tool.execute({
    url: "https://i.weread.qq.com/api/agent/gateway",
    method: "POST",
    headers: { Authorization: "Bearer $WEREAD_API_KEY" },
    json: { api_name: "/book/search", skill_version: "1.0.3" },
  }));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers.Authorization, "Bearer wrk-test-secret");
  assert.equal(calls[0].headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].body), {
    api_name: "/book/search",
    skill_version: "1.0.3",
  });
  assert.equal(result[result.length - 1].isError, false);
  assert.match(result[result.length - 1].content, /"ok":true/);
  assert.doesNotMatch(result[result.length - 1].content, /wrk-test-secret/);
});

test("web_request reports missing secret placeholders before sending", async () => {
  const previous = process.env.WEREAD_API_KEY;
  let called = false;
  try {
    process.env.WEREAD_API_KEY = "env-value-should-not-be-used";
    const tool = createWebRequestTool({
      getSecrets: () => ({}),
      requestUrl: async () => {
        called = true;
        return { status: 200, headers: {}, text: "ok" };
      },
    });

    const result = await collect(tool.execute({
      url: "https://i.weread.qq.com/api/agent/gateway",
      method: "POST",
      headers: { Authorization: "Bearer $WEREAD_API_KEY" },
      json: { api_name: "/book/search" },
    }));

    assert.equal(called, false);
    assert.equal(result[result.length - 1].isError, true);
    assert.match(result[result.length - 1].content, /missing secret WEREAD_API_KEY/);
  } finally {
    if (previous === undefined) delete process.env.WEREAD_API_KEY;
    else process.env.WEREAD_API_KEY = previous;
  }
});

test("web_request rejects private hosts and unsafe headers during validation", async () => {
  const tool = createWebRequestTool({
    requestUrl: async () => ({ status: 200, headers: {}, text: "ok" }),
  });

  assert.deepEqual(
    await tool.validate({ url: "http://127.0.0.1:8080/x" }),
    { ok: false, error: "Refusing to request private/internal host: 127.0.0.1" },
  );

  const cookie = await tool.validate({
    url: "https://example.com/api",
    headers: { Cookie: "sid=1" },
  });
  assert.equal(cookie.ok, false);
  assert.match(cookie.error, /not allowed/);
});

test("web_request validates method and body shape", async () => {
  const tool = createWebRequestTool({
    requestUrl: async () => ({ status: 200, headers: {}, text: "ok" }),
  });

  assert.equal((await tool.validate({ url: "https://example.com", method: "POST" })).ok, true);
  assert.equal((await tool.validate({ url: "https://example.com", method: "TRACE" })).ok, false);
  assert.equal((await tool.validate({ url: "https://example.com", json: { a: 1 } })).ok, false);
  assert.equal((await tool.validate({
    url: "https://example.com",
    method: "POST",
    json: { a: 1 },
    body: "x",
  })).ok, false);
});
