const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("selectable collection navigation supports arrows, Home, and End without wrapping", () => {
  const {
    nextSelectableCollectionIndex,
    applyRovingSelection,
  } = require("../../runtime/ui/selectable-collection");

  assert.equal(nextSelectableCollectionIndex({ key: "ArrowDown", index: 0, length: 3 }), 1);
  assert.equal(nextSelectableCollectionIndex({ key: "ArrowUp", index: 0, length: 3 }), 0);
  assert.equal(nextSelectableCollectionIndex({ key: "Home", index: 2, length: 3 }), 0);
  assert.equal(nextSelectableCollectionIndex({ key: "End", index: 0, length: 3 }), 2);
  assert.equal(nextSelectableCollectionIndex({ key: "Enter", index: 0, length: 3 }), null);

  const makeItem = () => ({
    attrs: {},
    classList: {
      values: new Set(),
      toggle(name, active) {
        if (active) this.values.add(name);
        else this.values.delete(name);
      },
    },
    setAttribute(name, value) { this.attrs[name] = value; },
  });
  const items = [makeItem(), makeItem(), makeItem()];
  applyRovingSelection(items, 1);
  assert.deepEqual(items.map((item) => item.attrs["aria-current"]), ["false", "true", "false"]);
  assert.deepEqual(items.map((item) => item.attrs.tabindex), ["-1", "0", "-1"]);
  assert.equal(items[1].classList.values.has("is-selected"), true);
});

test("model picker is a native roving-button collection with a named search field", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../runtime/modals.js"), "utf8");

  assert.match(source, /require\("\.\/ui\/selectable-collection"\)/);
  assert.match(source, /cls:\s*"oc-model-search"[\s\S]{0,280}aria-label/);
  assert.match(source, /createEl\("button",\s*\{[\s\S]{0,180}cls:\s*"oc-model-item"/);
  assert.match(source, /type:\s*"button"/);
  assert.match(source, /aria-pressed/);
  assert.match(source, /handleSelectableCollectionNavigation\(event/);
});

test("slash and linked-file pickers use native buttons and expose their selected result", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../runtime/view/layout/linked-context-methods.js"), "utf8");

  assert.match(source, /require\("\.\.\/\.\.\/ui\/selectable-collection"\)/);
  assert.match(source, /createEl\("button",\s*\{[\s\S]{0,180}oc-slash-command-item/);
  assert.match(source, /createEl\("button",\s*\{[\s\S]{0,180}oc-context-file-picker-item/);
  assert.match(source, /aria-pressed/);
  assert.match(source, /"aria-label":\s*tr\(this, "view\.context\.picker\.search"/);
  assert.match(source, /moveSlashCommandPickerSelectionForKey/);
  assert.match(source, /moveLinkedContextPickerSelectionForKey/);
  assert.equal(
    (source.match(/applyRovingSelection\(/g) || []).length,
    2,
    "pointer selection must update class, aria-current, and tabindex through the shared controller",
  );
});

test("skill editor labels are programmatically associated with every input", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../runtime/modals.js"), "utf8");

  assert.match(source, /createEl\("label",\s*\{[\s\S]{0,220}for:/);
  assert.match(source, /oc-skill-editor-body[\s\S]{0,240}id:/);
  assert.match(source, /oc-skill-editor-field-label[\s\S]{0,240}attr:\s*\{\s*for:/);
});
