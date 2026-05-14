// Server-Sent Events parser tailored for LLM streaming endpoints.
// Tolerant of:
//   - Missing `event:` lines (defaults to "message" per SSE spec)
//   - Mixed CRLF / LF
//   - Partial chunks that split across reads (mid-line, mid-event)
//   - Unknown event types (passed through; tolerant mode silently
//     ignores malformed `data:` payloads)
//
// The parser is shape-agnostic — it does not know about Anthropic vs
// OpenAI event semantics. It emits raw { event, data } records; the
// adapter on top decides what to do with each.

/**
 * Split a buffer into complete event blocks (terminated by a blank line)
 * and a tail of unfinished content. Handles CRLF and LF line endings.
 *
 * @param {string} buf
 * @returns {{ blocks: string[], tail: string }}
 */
function splitEventBlocks(buf) {
  // Normalize CRLF → LF to make the splitter trivial.
  const norm = buf.replace(/\r\n/g, "\n");
  const parts = norm.split("\n\n");
  // The last segment is the not-yet-terminated tail.
  const tail = parts.pop();
  return { blocks: parts, tail };
}

/**
 * Parse a single event block (one or more lines, no blank lines inside)
 * into a structured event. Returns null if the block has no data.
 *
 * Per the SSE spec:
 *   - Lines starting with ":" are comments — skip.
 *   - Lines of the form "field:value" set a field. Whitespace after the
 *     first colon is stripped.
 *   - Multiple `data:` lines concatenate with "\n" between values.
 *   - When the block ends, dispatch as event { event, data } where
 *     event defaults to "message".
 *
 * @param {string} block
 * @returns {{ event: string, data: string } | null}
 */
function parseEventBlock(block) {
  if (!block) return null;
  let eventType = "";
  const dataLines = [];
  for (const rawLine of block.split("\n")) {
    if (!rawLine) continue;
    if (rawLine.startsWith(":")) continue; // comment
    const colon = rawLine.indexOf(":");
    let field;
    let value;
    if (colon === -1) {
      field = rawLine;
      value = "";
    } else {
      field = rawLine.slice(0, colon);
      value = rawLine.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }
    if (field === "event") {
      eventType = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
    // Ignore "id" and "retry" fields — not used by LLM endpoints.
  }
  if (dataLines.length === 0) return null;
  return {
    event: eventType || "message",
    data: dataLines.join("\n"),
  };
}

/**
 * Wrap an iterable of incoming string chunks into an async iterable of
 * parsed { event, data, parsedData } events.
 *
 * @param {AsyncIterable<string> | Iterable<string>} chunks
 * @param {Object} [options]
 * @param {boolean} [options.tolerant] if true, malformed JSON in `data` is
 *   not thrown — instead the raw string is kept and `parsedData` is null.
 * @returns {AsyncGenerator<{ event: string, data: string, parsedData: any | null }>}
 */
async function* parseSseStream(chunks, options = {}) {
  const tolerant = !!options.tolerant;
  let buf = "";

  for await (const chunk of chunks) {
    if (!chunk) continue;
    buf += String(chunk);
    const { blocks, tail } = splitEventBlocks(buf);
    buf = tail;
    for (const block of blocks) {
      const ev = parseEventBlock(block);
      if (!ev) continue;
      let parsedData = null;
      try {
        parsedData = ev.data === "[DONE]" ? null : JSON.parse(ev.data);
      } catch (e) {
        if (!tolerant) {
          throw new Error(`SSE parse error: ${e.message} (data=${truncate(ev.data, 200)})`);
        }
        // Tolerant: keep raw, parsedData stays null.
      }
      yield { event: ev.event, data: ev.data, parsedData };
    }
  }

  // Flush any trailing block that wasn't terminated by a blank line.
  // Many servers do this on close; treat it as a final event if it has
  // any data.
  if (buf.trim().length > 0) {
    const ev = parseEventBlock(buf);
    if (ev) {
      let parsedData = null;
      try {
        parsedData = ev.data === "[DONE]" ? null : JSON.parse(ev.data);
      } catch (e) {
        if (!tolerant) {
          throw new Error(`SSE parse error: ${e.message} (data=${truncate(ev.data, 200)})`);
        }
      }
      yield { event: ev.event, data: ev.data, parsedData };
    }
  }
}

function truncate(s, n) {
  if (typeof s !== "string") return String(s);
  return s.length <= n ? s : `${s.slice(0, n)}…(${s.length - n} more)`;
}

module.exports = {
  splitEventBlocks,
  parseEventBlock,
  parseSseStream,
};
