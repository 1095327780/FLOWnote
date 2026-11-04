// Bound read results by the host's remaining per-tool context allowance.
// Without a host budget (standalone tools and tests), retain a generous
// safety page rather than returning an unbounded response.
const { utf8Page } = require("./utf8-page");

const FALLBACK_MAX_BYTES = 128 * 1024;

function estimateTextTokens(value) {
  let cjk = 0;
  let other = 0;
  let astral = 0;
  // JSON escaping is part of the provider message. Count the serialized
  // representation so quotes, backslashes, and control characters cost space.
  for (const character of JSON.stringify(String(value == null ? "" : value))) {
    if (/[\u2e80-\u9fff\uf900-\ufaff]/u.test(character)) cjk += 1;
    else if (character.codePointAt(0) > 0xffff) astral += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 1.5 + other / 3.5 + astral * 2);
}

function pageReadOutput(value, { ctx, byteOffset = 0, maxBytes } = {}) {
  const source = String(value == null ? "" : value);
  const allocatedTokens = ctx && Number.isInteger(ctx.toolResultBudgetTokens)
    && ctx.toolResultBudgetTokens >= 0 ? ctx.toolResultBudgetTokens : null;
  if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes < 1)) {
    throw new RangeError("maxBytes must be a positive integer");
  }
  const sourceBytes = new TextEncoder().encode(source).length;
  const byteCap = Math.min(maxBytes === undefined ? Infinity : maxBytes,
    allocatedTokens === null ? FALLBACK_MAX_BYTES : Infinity,
    Math.max(1, sourceBytes));
  const candidate = utf8Page(source, byteOffset, byteCap);
  if (!candidate.truncated && candidate.text === "") return candidate;
  if (candidate.nextOffset === candidate.offset) {
    throw new RangeError("Read output limit is too small for one UTF-8 character; use a larger limit or a narrower range.");
  }
  if (allocatedTokens === null || estimateTextTokens(candidate.text) <= allocatedTokens) return candidate;

  const boundaries = [0];
  let index = 0;
  for (const character of candidate.text) {
    index += character.length;
    boundaries.push(index);
  }
  let low = 0;
  let high = boundaries.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTextTokens(candidate.text.slice(0, boundaries[mid])) <= allocatedTokens) low = mid;
    else high = mid - 1;
  }
  if (low === 0) {
    throw new RangeError("Read output budget is too small for one UTF-8 character; narrow the requested range.");
  }
  const text = candidate.text.slice(0, boundaries[low]);
  const nextOffset = candidate.offset + new TextEncoder().encode(text).length;
  return { text, offset: candidate.offset, nextOffset, totalBytes: candidate.totalBytes, truncated: nextOffset < candidate.totalBytes };
}

module.exports = { pageReadOutput, estimateTextTokens, FALLBACK_MAX_BYTES };
