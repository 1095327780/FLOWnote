// Custom Obsidian icons used by FLOWnote.
//
// Obsidian expects `addIcon(iconId, svgContent)` where svgContent is the
// inner markup of a 100x100 viewBox SVG. The plugin currently references
// "flownote-journal-glow" in 3 places (chat view, header, mobile capture
// ribbon) but never registered any SVG — so the ribbon entries showed
// without a leading icon. Registering once at plugin onload fixes all
// call sites.

const FLOWNOTE_ICON_ID = "flownote-journal-glow";

// Open book + glowing bulb: this is FLOWnote's original product mark.
// Stroke-only so it inherits the current theme color (Obsidian renders
// custom icons with `color: currentColor`).
const FLOWNOTE_ICON_SVG = `
<g fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
  <path d="M16 79V34c11-7 23-7 34 0v45c-11-7-23-7-34 0z" />
  <path d="M84 79V34c-11-7-23-7-34 0v45c11-7 23-7 34 0z" />
  <path d="M50 34v45" />
  <path d="M40 20c0-5.5 4.5-10 10-10s10 4.5 10 10c0 5-2.6 8-5.4 10.9-1.5 1.5-2.6 3-2.6 5.1h-4c0-2.1-1.1-3.6-2.6-5.1C42.6 28 40 25 40 20z" />
  <path d="M46 40h8" />
  <path d="M47 46h6" />
  <path d="M50 4v4" />
  <path d="M36 8l2.8 2.8" />
  <path d="M64 8l-2.8 2.8" />
  <path d="M30 16h4" />
  <path d="M66 16h4" />
</g>
`.trim();

let _registered = false;

function registerFLOWnoteIcons(addIcon) {
  if (_registered) return;
  if (typeof addIcon !== "function") return;
  try {
    addIcon(FLOWNOTE_ICON_ID, FLOWNOTE_ICON_SVG);
    _registered = true;
  } catch (_e) {
    // Non-fatal: ribbon entries will fall back to the label-only render.
  }
}

module.exports = {
  FLOWNOTE_ICON_ID,
  FLOWNOTE_ICON_SVG,
  registerFLOWnoteIcons,
};
