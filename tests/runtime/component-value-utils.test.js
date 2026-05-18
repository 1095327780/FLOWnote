const test = require("node:test");
const assert = require("node:assert/strict");

const {
  bindDropdownChange,
  readDropdownValue,
} = require("../../runtime/settings/component-value-utils");

test("readDropdownValue prefers selectEl.value over callback fallback", () => {
  const dropdown = {
    selectEl: { value: "zhipu-glm" },
  };

  assert.equal(readDropdownValue(dropdown, "deepseek"), "zhipu-glm");
});

test("readDropdownValue prefers selectEl.value over stale getValue", () => {
  const dropdown = {
    getValue: () => "deepseek",
    selectEl: { value: "zhipu-glm" },
  };

  assert.equal(readDropdownValue(dropdown, "deepseek"), "zhipu-glm");
});

test("readDropdownValue falls back to getValue when selectEl is unavailable", () => {
  const dropdown = { getValue: () => "qwen" };

  assert.equal(readDropdownValue(dropdown, "deepseek"), "qwen");
});

test("bindDropdownChange reads native change event target value", async () => {
  let listener = null;
  const dropdown = {
    selectEl: {
      value: "deepseek",
      addEventListener(type, handler) {
        if (type === "change") listener = handler;
      },
    },
    getValue: () => "deepseek",
  };
  let seen = "";
  bindDropdownChange(dropdown, async (value) => {
    seen = value;
  });

  await listener({ target: { value: "zhipu-glm" } });

  assert.equal(seen, "zhipu-glm");
});
