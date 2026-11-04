// Return a UTF-8 bounded page without splitting a Unicode code point.
// Offsets count bytes in the source text, and nextOffset can be passed back
// to reconstruct the original text exactly.
function utf8Page(value, offset = 0, limit = 16 * 1024) {
  const source = String(value == null ? "" : value);
  const totalBytes = new TextEncoder().encode(source).length;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1) {
    throw new RangeError("offset and limit must be non-negative byte offset and positive byte limit");
  }
  let bytePos = 0;
  let startIndex = source.length;
  let endIndex = source.length;
  let started = false;
  for (let i = 0; i < source.length;) {
    const cp = source.codePointAt(i);
    const chars = cp > 0xffff ? 2 : 1;
    // TextEncoder replaces unpaired surrogates with U+FFFD.
    const bytes = cp >= 0xd800 && cp <= 0xdfff ? 3
      : cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (!started && bytePos === offset) {
      startIndex = i;
      endIndex = i;
      started = true;
    }
    if (!started && bytePos < offset && bytePos + bytes > offset) {
      throw new RangeError("byte offset must be on a UTF-8 character boundary");
    }
    if (started && bytePos + bytes > offset + limit) break;
    bytePos += bytes;
    i += chars;
    if (started) endIndex = i;
  }
  if (!started && offset < totalBytes) throw new RangeError("byte offset must be on a UTF-8 character boundary");
  const text = source.slice(startIndex, endIndex);
  const actualOffset = Math.min(offset, totalBytes);
  const nextOffset = actualOffset + new TextEncoder().encode(text).length;
  return { text, offset: actualOffset, nextOffset, totalBytes, truncated: nextOffset < totalBytes };
}

function pageNotice(toolName, page, args = "") {
  return page.truncated
    ? `\n\n[${toolName}: content truncated; next byte offset ${page.nextOffset} of ${page.totalBytes}. ` +
      `Call ${toolName} again with ${args}byteOffset=${page.nextOffset}.]`
    : "";
}

module.exports = { utf8Page, pageNotice };
