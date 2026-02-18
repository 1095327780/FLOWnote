function normalizedRenderableText(text) {
  return String(text || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

function normalizeMarkdownSpacing(text) {
  const raw = String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+\n/g, "\n\n");
  if (!raw.trim()) return "";

  const segments = raw.split(/(```[\s\S]*?```)/g);
  const normalized = segments.map((segment) => {
    if (!segment) return "";
    if (segment.startsWith("```")) return segment;

    let out = segment;
    out = out.replace(/\n{3,}/g, "\n\n");
    out = out.replace(/\n{2,}(?=[ \t]*(?:[-*+]|\d+\.)\s)/g, "\n");
    out = out.replace(/(^|\n)([ \t]*(?:[-*+]|\d+\.)[^\n]*)\n{2,}(?=[ \t]*(?:[-*+]|\d+\.)\s)/g, "$1$2\n");
    out = out.replace(/\n{3,}/g, "\n\n");
    return out;
  });

  return normalized.join("").trim();
}

function normalizeMarkdownForDisplay(text) {
  return normalizeMarkdownSpacing(normalizedRenderableText(text));
}

module.exports = {
  normalizedRenderableText,
  normalizeMarkdownSpacing,
  normalizeMarkdownForDisplay,
};
