#!/usr/bin/env node
// One-shot rewrite to clear Obsidian scorecard CSS warnings:
//  - drop all `!important`
//  - replace `all: unset` with explicit reset block
//  - swap `:has(.oc-capture-modal)` for `.oc-modal-capture` class
//  - collapse `0 0 8px 0` → `0 0 8px`
//  - merge duplicate `.oc-code-copy-btn` block
// Run once. Result is checked in; this script is kept for traceability.

import fs from "fs";
import path from "path";

const FILE = path.resolve("styles.css");
let src = fs.readFileSync(FILE, "utf8");

const original = src;

// --- 1) `:has(.oc-capture-modal)` → `.oc-modal-capture` ---------------------
// We add `oc-modal-capture` to the modalEl in JS (capture-modal.js), so the
// selectors below resolve without :has().
src = src.replace(/\.modal:has\(\.oc-capture-modal\)/g, ".modal.oc-modal-capture");
src = src.replace(/\.is-mobile \.modal:has\(\.oc-capture-modal\)/g, ".is-mobile .modal.oc-modal-capture");

// --- 2) `0 0 8px 0` shorthand → `0 0 8px` -----------------------------------
src = src.replace(/margin: 0 0 8px 0;/g, "margin: 0 0 8px;");

// --- 3) `all: unset` replacement --------------------------------------------
// `all: unset` resets every property including box-model and ARIA-affecting
// ones. We only care about button-like reset, so use a focused block.
const allUnsetReplacement = [
  "appearance: none;",
  "  background: none;",
  "  border: 0;",
  "  color: inherit;",
  "  font: inherit;",
  "  margin: 0;",
  "  padding: 0;",
].join("\n  ");
src = src.replace(/\ball: unset;/g, allUnsetReplacement);

// --- 4) Bump specificity via doubled-class trick to retire `!important` -----
// Selectors we know need to win over Obsidian core / 3rd-party themes.
const doubleClassMap = [
  // SVG sizes in header icon buttons
  [
    ".oc-header-btn.oc-icon-btn svg,\n.oc-header-btn.oc-icon-btn .svg-icon",
    ".oc-header-btn.oc-icon-btn.oc-icon-btn svg,\n.oc-header-btn.oc-icon-btn.oc-icon-btn .svg-icon",
  ],
  // Code wrapper copy-button override
  [
    ".oc-code-wrapper .copy-code-button",
    ".oc-code-wrapper.oc-code-wrapper .copy-code-button",
  ],
  // Input textarea reset
  [".oc-input {", ".oc-input.oc-input {"],
  [".oc-input:hover,\n.oc-input:focus", ".oc-input.oc-input:hover,\n.oc-input.oc-input:focus"],
  // Round context link button
  [".oc-context-link-btn {", ".oc-context-link-btn.oc-context-link-btn {"],
  // SVGs inside the context link button
  [
    ".oc-context-link-btn svg,\n.oc-context-link-btn .svg-icon",
    ".oc-context-link-btn.oc-context-link-btn svg,\n.oc-context-link-btn.oc-context-link-btn .svg-icon",
  ],
  // Model select overlay
  [".oc-model-select-inline {", ".oc-model-select-inline.oc-model-select-inline {"],
  [
    ".oc-model-select-inline:hover,\n.oc-model-select-inline:focus",
    ".oc-model-select-inline.oc-model-select-inline:hover,\n.oc-model-select-inline.oc-model-select-inline:focus",
  ],
  // Capture modal — top-mode override for iOS
  [
    ".is-mobile .modal.oc-capture-top-mode {",
    ".is-mobile .modal.oc-capture-top-mode.oc-capture-top-mode {",
  ],
];
for (const [needle, repl] of doubleClassMap) {
  if (!src.includes(needle)) {
    console.error(`[fix-scorecard-css] WARN: did not find selector to bump: ${JSON.stringify(needle)}`);
    continue;
  }
  src = src.replace(needle, repl);
}

// Special case: the mobile-capture modal selector also needs specificity
// bumped (line ~3136 region). After step 1, `.is-mobile .modal.oc-modal-capture`
// exists; double it.
src = src.replace(
  ".is-mobile .modal.oc-modal-capture {",
  ".is-mobile .modal.oc-modal-capture.oc-modal-capture {",
);

// --- 5) Strip remaining `!important` ----------------------------------------
src = src.replace(/\s*!important\b/g, "");

// --- 6) Deduplicate `.oc-code-copy-btn` -------------------------------------
// Two adjacent blocks define the same selector; the second only adds
// padding/opacity/flex-layout. Merge into one.
src = src.replace(
  /\.oc-code-copy-btn \{\n([\s\S]*?)\}\n\n\.oc-code-copy-btn \{\n([\s\S]*?)\}/,
  (_full, first, second) => `.oc-code-copy-btn {\n${first.trimEnd()}\n${second.trimStart()}}`,
);

if (src === original) {
  console.error("[fix-scorecard-css] No changes made — bailing.");
  process.exit(1);
}

fs.writeFileSync(FILE, src);
console.log("[fix-scorecard-css] OK");
