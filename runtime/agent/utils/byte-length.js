// Cross-platform UTF-8 byte length helper.
//
// Several vault_* tools display "wrote N bytes" status by calling
// `Buffer.byteLength(str, "utf8")`. Buffer is a Node global; Obsidian
// Mobile runs in a webview where Buffer is undefined, so any tool that
// hits this path throws "Can't find variable: Buffer" mid-execution.
//
// TextEncoder is universally available (Node ≥11, every modern browser
// runtime including the iOS/Android Obsidian webviews), so we prefer
// it. Buffer remains the fast path when present.

let encoder = null;
function ensureEncoder() {
  if (encoder) return encoder;
  if (typeof TextEncoder === "function") {
    encoder = new TextEncoder();
  }
  return encoder;
}

function byteLengthUtf8(value) {
  const s = String(value == null ? "" : value);
  if (typeof Buffer !== "undefined" && Buffer && typeof Buffer.byteLength === "function") {
    return Buffer.byteLength(s, "utf8");
  }
  const enc = ensureEncoder();
  if (enc) return enc.encode(s).length;
  // Last-ditch fallback. Not perfectly accurate for surrogate pairs but
  // good enough for byte-cap heuristics where missing Buffer + missing
  // TextEncoder would only happen in exotic environments.
  let bytes = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { bytes += 4; i += 1; }
    else bytes += 3;
  }
  return bytes;
}

module.exports = { byteLengthUtf8 };
