const test = require("node:test");
const assert = require("node:assert/strict");

const {
  splitEventBlocks,
  parseEventBlock,
  parseSseStream,
} = require("../../../runtime/providers/sse-parser");

async function* fromArray(arr) {
  for (const x of arr) yield x;
}

async function collect(asyncIterable) {
  const out = [];
  for await (const x of asyncIterable) out.push(x);
  return out;
}

test("splitEventBlocks separates complete blocks from a trailing partial tail", () => {
  const input = "event: a\ndata: {}\n\nevent: b\ndata: {\"x\":1}\n\nevent: c\ndata:";
  const { blocks, tail } = splitEventBlocks(input);
  assert.deepEqual(blocks, ["event: a\ndata: {}", "event: b\ndata: {\"x\":1}"]);
  assert.equal(tail, "event: c\ndata:");
});

test("splitEventBlocks handles CRLF line endings", () => {
  const input = "event: a\r\ndata: 1\r\n\r\nevent: b\r\ndata: 2\r\n\r\n";
  const { blocks, tail } = splitEventBlocks(input);
  assert.deepEqual(blocks, ["event: a\ndata: 1", "event: b\ndata: 2"]);
  assert.equal(tail, "");
});

test("parseEventBlock parses event/data fields and joins multi-line data", () => {
  const ev = parseEventBlock("event: foo\ndata: line1\ndata: line2");
  assert.deepEqual(ev, { event: "foo", data: "line1\nline2" });
});

test("parseEventBlock defaults event to 'message' when no event: line is present", () => {
  const ev = parseEventBlock("data: {\"hello\":1}");
  assert.deepEqual(ev, { event: "message", data: "{\"hello\":1}" });
});

test("parseEventBlock skips comments and ignores id/retry fields", () => {
  const ev = parseEventBlock(": this is a comment\nid: 17\nretry: 1500\nevent: x\ndata: hi");
  assert.deepEqual(ev, { event: "x", data: "hi" });
});

test("parseEventBlock returns null when the block has no data", () => {
  assert.equal(parseEventBlock("event: x"), null);
  assert.equal(parseEventBlock(""), null);
});

test("parseSseStream emits parsed events in order for a complete single-chunk input", async () => {
  const stream = fromArray([
    "event: message_start\ndata: {\"type\":\"message_start\"}\n\n" +
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n" +
    "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
  ]);
  const got = await collect(parseSseStream(stream));
  assert.equal(got.length, 3);
  assert.equal(got[0].event, "message_start");
  assert.equal(got[0].parsedData.type, "message_start");
  assert.equal(got[1].parsedData.delta.text, "hi");
  assert.equal(got[2].event, "message_stop");
});

test("parseSseStream stitches events split across chunk boundaries", async () => {
  // Same payload as above, but split mid-event and mid-line.
  const chunks = [
    "event: message_start\nda",
    "ta: {\"type\":\"message_start\"}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_de",
    "lta\",\"text\":\"hi\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
  ];
  const got = await collect(parseSseStream(fromArray(chunks)));
  assert.equal(got.length, 3);
  assert.equal(got[0].parsedData.type, "message_start");
  assert.equal(got[1].parsedData.delta.text, "hi");
  assert.equal(got[2].event, "message_stop");
});

test("parseSseStream parses [DONE] sentinel without throwing (parsedData is null)", async () => {
  const got = await collect(parseSseStream(fromArray(["data: [DONE]\n\n"])));
  assert.equal(got.length, 1);
  assert.equal(got[0].data, "[DONE]");
  assert.equal(got[0].parsedData, null);
});

test("parseSseStream throws on malformed JSON when not in tolerant mode", async () => {
  await assert.rejects(
    () => collect(parseSseStream(fromArray(["data: {not json\n\n"]))),
    /SSE parse error/,
  );
});

test("parseSseStream tolerant mode swallows malformed JSON and yields raw data", async () => {
  const got = await collect(parseSseStream(fromArray(["data: {not json\n\n"]), { tolerant: true }));
  assert.equal(got.length, 1);
  assert.equal(got[0].data, "{not json");
  assert.equal(got[0].parsedData, null);
});

test("parseSseStream flushes a trailing block that lacks a closing blank line", async () => {
  // Some servers drop the final \n\n on close.
  const got = await collect(parseSseStream(fromArray([
    "event: message_stop\ndata: {\"type\":\"message_stop\"}",
  ])));
  assert.equal(got.length, 1);
  assert.equal(got[0].event, "message_stop");
});

test("parseSseStream ignores empty chunks gracefully", async () => {
  const got = await collect(parseSseStream(fromArray([
    "",
    "event: x\ndata: {\"a\":1}\n\n",
    "",
  ])));
  assert.equal(got.length, 1);
  assert.equal(got[0].parsedData.a, 1);
});
