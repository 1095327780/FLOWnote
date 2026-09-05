const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("responsive modal helper marks both the Obsidian shell and its content surface", () => {
  const { applyResponsiveModalSurface } = require("../../runtime/ui/responsive-modal");
  const shellClasses = [];
  const contentClasses = [];
  const modalEl = { addClass: (name) => shellClasses.push(name) };
  const contentEl = { addClass: (name) => contentClasses.push(name) };

  const result = applyResponsiveModalSurface({ modalEl }, contentEl);

  assert.deepEqual(shellClasses, ["oc-responsive-modal-shell"]);
  assert.deepEqual(contentClasses, ["oc-responsive-modal"]);
  assert.equal(result.shellEl, modalEl);
  assert.equal(result.contentEl, contentEl);
});

test("responsive modal helper falls back to the nearest host shell and remains safe without one", () => {
  const { applyResponsiveModalSurface } = require("../../runtime/ui/responsive-modal");
  const closestShell = { classList: { added: [], add(name) { this.added.push(name); } } };
  const contentEl = {
    classList: { added: [], add(name) { this.added.push(name); } },
    closest: (selector) => selector === ".modal" ? closestShell : null,
  };

  assert.equal(applyResponsiveModalSurface({}, contentEl).shellEl, closestShell);
  assert.deepEqual(closestShell.classList.added, ["oc-responsive-modal-shell"]);
  assert.deepEqual(contentEl.classList.added, ["oc-responsive-modal"]);
  assert.doesNotThrow(() => applyResponsiveModalSurface({}, null));
});

test("every FLOWnote modal opts into the shared responsive shell and content surface", () => {
  const runtimeModals = read("runtime/modals.js");
  const settingsModals = read("runtime/settings/modals.js");

  const runtimeOpens = (runtimeModals.match(/onOpen\(\)\s*\{/g) || []).length;
  const runtimeResponsive = (runtimeModals.match(/applyResponsiveModalSurface\(this, contentEl\)/g) || []).length;
  const settingsOpens = (settingsModals.match(/onOpen\(\)\s*\{/g) || []).length;
  const settingsResponsive = (settingsModals.match(/applyResponsiveModalSurface\(this, contentEl\)/g) || []).length;

  assert.equal(runtimeResponsive, runtimeOpens, "each runtime modal must opt into the shared responsive contract");
  assert.equal(settingsResponsive, settingsOpens, "each settings modal must opt into the shared responsive contract");
  assert.match(settingsModals, /createDiv\(\{\s*cls:\s*"oc-responsive-modal-actions"/);
});

test("mobile settings and modal CSS define one safe, scrollable form contract", () => {
  const mobileSettings = read("runtime/mobile/mobile-settings-tab.js");
  const css = read("styles.css");

  assert.match(mobileSettings, /containerEl\.addClass\("oc-settings-root"\)/);
  assert.match(css, /--oc-mobile-touch-target:\s*44px/);
  assert.match(css, /\.is-mobile \.oc-responsive-modal-shell[\s\S]{0,900}100dvh/);
  assert.match(css, /\.is-mobile \.oc-responsive-modal-shell[\s\S]{0,900}safe-area-inset-left/);
  assert.match(css, /\.is-mobile \.oc-responsive-modal-shell[\s\S]{0,900}safe-area-inset-right/);
  assert.match(css, /\.is-mobile \.oc-responsive-modal-shell[\s\S]{0,900}overflow:\s*hidden/);
  assert.match(css, /\.is-mobile \.oc-responsive-modal[\s\S]{0,900}min-width:\s*0/);
  assert.match(css, /\.is-mobile \.oc-responsive-modal[\s\S]{0,900}min-height:\s*0/);
  assert.match(css, /\.is-mobile \.oc-responsive-modal[\s\S]{0,900}overflow-y:\s*auto/);
  assert.match(css, /env\(safe-area-inset-bottom/);
  assert.match(css, /\.is-mobile \.oc-responsive-modal-actions[\s\S]{0,350}flex-wrap:\s*wrap/);
  assert.match(css, /\.is-mobile \.oc-settings-root[\s\S]{0,900}font-size:\s*16px/);
  assert.match(css, /\.is-mobile \.oc-settings-root[\s\S]{0,900}min-height:\s*var\(--oc-mobile-touch-target\)/);
});

test("small mobile controls join the touch target contract without enlarging toggles", () => {
  const css = read("styles.css");

  for (const selector of [
    ".is-mobile .oc-capture-btn",
    ".is-mobile .oc-home-task-row",
    ".is-mobile .oc-message-context-chip",
    ".is-mobile .oc-responsive-modal summary",
    ".is-mobile .oc-responsive-modal button",
  ]) {
    assert.match(css, new RegExp(`${selector.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}[\\s\\S]{0,500}min-height:\\s*var\\(--oc-mobile-touch-target\\)`));
  }
  assert.doesNotMatch(css, /\.is-mobile \.oc-settings-root input\[type="(?:checkbox|radio)"\][\s\S]{0,300}min-height/);
});

test("shared chat layout responds to the Obsidian pane container, not only the window viewport", () => {
  const css = read("styles.css");

  assert.match(css, /\.oc-root\s*\{[\s\S]{0,240}container-type:\s*inline-size/);
  assert.match(css, /\.oc-root\s*\{[\s\S]{0,240}container-name:\s*flownote/);
  assert.match(css, /@container\s+flownote\s*\(max-width:\s*860px\)[\s\S]{0,500}\.oc-suggest-grid/);
  assert.match(css, /@container\s+flownote\s*\(max-width:\s*700px\)[\s\S]{0,1600}\.oc-toolbar/);
  assert.match(css, /@container\s+flownote\s*\(max-width:\s*560px\)[\s\S]{0,500}\.oc-suggest-grid/);
});

test("short mobile landscape keeps the composer compact without shrinking touch targets", () => {
  const css = read("styles.css");

  assert.match(css, /@media\s*\(orientation:\s*landscape\)\s*and\s*\(max-height:\s*520px\)[\s\S]{0,1800}\.is-mobile \.oc-input-wrapper\s*\{[\s\S]{0,500}display:\s*grid/);
  assert.match(css, /grid-template-areas:\s*[\s\S]{0,100}"context context"[\s\S]{0,100}"input toolbar"/);
  assert.match(css, /@media\s*\(orientation:\s*landscape\)\s*and\s*\(max-height:\s*520px\)[\s\S]{0,2200}\.is-mobile \.oc-input-toolbar\s*\{[\s\S]{0,180}grid-area:\s*toolbar/);
  assert.match(css, /\.is-mobile \.oc-composer textarea,[\s\S]{0,800}grid-area:\s*input;[\s\S]{0,300}min-height:\s*44px/);
});

test("an open mobile keyboard leaves composer placement to the Obsidian host", () => {
  const css = read("styles.css");

  assert.match(
    css,
    /\.is-mobile \.oc-root\.oc-surface\.is-kb-open\s*\{\s*padding-bottom:\s*0;\s*\}/,
  );
  assert.match(
    css,
    /\.is-mobile \.oc-root\.oc-surface\.is-kb-open\s*\{[\s\S]{0,280}transition:\s*none/,
  );
  assert.doesNotMatch(css, /\.is-mobile \.oc-root\.is-kb-open \.oc-composer/);
  assert.doesNotMatch(css, /--oc-kb-offset/);
  assert.doesNotMatch(css, /translateY\(calc\(-1 \* var\(--oc-kb-offset/);
});

test("assistant timeline and message utilities stay touchable without becoming cards on mobile", () => {
  const css = read("styles.css");

  assert.match(
    css,
    /:is\(body\.is-mobile, body \.is-mobile\) \.oc-tool-header,[\s\S]{0,240}\.oc-process-disclosure,[\s\S]{0,120}button\.oc-process-summary\s*\{\s*min-height:\s*44px/,
  );
  assert.match(
    css,
    /:is\(body\.is-mobile, body \.is-mobile\) \.oc-message-meta:where\(\*\)\s*\{[\s\S]{0,220}border:\s*0;[\s\S]{0,140}background:\s*transparent;[\s\S]{0,140}box-shadow:\s*none/,
  );
  assert.match(css, /\.oc-messages\s*\{[\s\S]{0,260}overflow-x:\s*hidden;[\s\S]{0,180}overflow-anchor:\s*none/);
  assert.match(css, /\.oc-message\s*\{[\s\S]{0,260}max-width:\s*100%/);
  assert.match(css, /\.oc-user-msg-actions,[\s\S]{0,120}\.oc-assistant-msg-actions[\s\S]{0,300}position:\s*static/);
  assert.doesNotMatch(css, /\.oc-text-copy-btn\s*\{[\s\S]{0,220}position:\s*absolute/);
  assert.match(css, /\.is-mobile \.oc-message-user\s*\{[\s\S]{0,280}padding:\s*0;[\s\S]{0,180}background:\s*transparent;[\s\S]{0,120}box-shadow:\s*none/);
  assert.match(css, /body\.theme-light \.is-mobile \.oc-message-user\s*>\s*\.oc-message-content\s*\{/);
  assert.doesNotMatch(css, /body\.theme-light \.is-mobile \.oc-message-user\s*\{[\s\S]{0,240}background:\s*linear-gradient/);
  assert.match(css, /\.oc-root \.oc-process-disclosure,[\s\S]{0,100}\.oc-root button\.oc-process-summary\s*\{[\s\S]{0,320}border:\s*0;[\s\S]{0,180}background:\s*transparent;[\s\S]{0,120}box-shadow:\s*none/);
  const processSummary = read("runtime/view/message/process-summary.js");
  assert.match(processSummary, /document\.createElement\("div"\)/);
  assert.match(processSummary, /setAttr\("role", "button"\)/);
  assert.doesNotMatch(processSummary, /document\.createElement\("button"\)/);
  assert.match(processSummary, /querySelector\("\.oc-process-summary"\)[\s\S]{0,120}legacySummary\.remove\(\)/);
  const finalStatsAuthority = css.slice(css.lastIndexOf("Mobile light-theme rules above style"));
  assert.match(finalStatsAuthority, /body\.theme-light\.is-mobile[\s\S]{0,260}\.oc-message-meta:where\(\*\)\s*\{[\s\S]{0,180}background:\s*transparent/);
});

test("mobile running feedback uses an independent animated turn status instead of a cursor", () => {
  const css = read("styles.css");

  assert.match(css, /@keyframes oc-runtime-dots\s*\{[\s\S]{0,260}0%, 100%[\s\S]{0,180}50%/);
  assert.match(css, /\.oc-runtime-status\.is-working::before\s*\{\s*animation:\s*oc-runtime-dots/);
  assert.match(css, /\.is-mobile \.oc-runtime-status\s*\{[\s\S]{0,180}font-size:\s*13px/);
  assert.match(css, /\.is-mobile \.oc-message\.is-pending \.oc-message-content:empty::after\s*\{\s*content:\s*none/);
  assert.doesNotMatch(css, /@keyframes oc-pulse-m/);
});
