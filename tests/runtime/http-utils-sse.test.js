const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { nodeHttpRequestSse } = require("../../runtime/http-utils");

function serveChunks(chunks, delayMs = 15) {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let index = 0;
      const next = () => {
        if (index >= chunks.length) {
          res.end();
          return;
        }
        res.write(chunks[index]);
        index += 1;
        setTimeout(next, delayMs);
      };
      next();
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function collectEvents(chunks) {
  const server = await serveChunks(chunks);
  try {
    const events = [];
    await nodeHttpRequestSse(`http://127.0.0.1:${server.address().port}/event`, 3000, null, {
      onEvent: (payload) => events.push(payload),
    });
    return events;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("compat SSE keeps Chinese and emoji intact when bytes split across network chunks", async () => {
  const bytes = Buffer.from('data: {"text":"中文路径😀正文"}\n\n', "utf8");
  // Split inside a CJK character, then inside the 4-byte emoji.
  const firstCjk = bytes.indexOf(Buffer.from("中", "utf8"));
  const emoji = bytes.indexOf(Buffer.from("😀", "utf8"));
  const chunks = [
    bytes.subarray(0, firstCjk + 1),
    bytes.subarray(firstCjk + 1, emoji + 2),
    bytes.subarray(emoji + 2),
  ];

  assert.deepEqual(await collectEvents(chunks), [{ text: "中文路径😀正文" }]);
});

test("compat SSE decodes one-byte chunks and CRLF framing across events", async () => {
  const bytes = Buffer.from('data: {"n":1,"t":"甲"}\r\n\r\ndata: {"n":2,"t":"乙🙂"}\r\n\r\n', "utf8");
  const chunks = Array.from(bytes, (byte) => Buffer.from([byte]));

  assert.deepEqual(await collectEvents(chunks), [{ n: 1, t: "甲" }, { n: 2, t: "乙🙂" }]);
});
