const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

test("layout renderer should preserve public method surface", () => {
  const originalLoad = Module._load;
  const modulePath = require.resolve("../../runtime/view/layout-renderer");
  try {
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === "obsidian") {
        return {
          Notice: class {},
          setIcon() {},
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    delete require.cache[modulePath];
    const { layoutRendererMethods } = require(modulePath);

    const expected = [
      "openSettings",
      "buildIconButton",
      "createSvgNode",
      "renderSidebarToggleIcon",
      "scrollMessagesTo",
      "toggleSidebarCollapsed",
      "normalizeSessionTitle",
      "isPlaceholderSessionTitle",
      "deriveSessionTitleFromPrompt",
      "sessionDisplayTitle",
      "activeSessionLabel",
      "formatSessionMetaTime",
      "closeHistoryMenu",
      "toggleHistoryMenu",
      "refreshHistoryMenu",
      "refreshCurrentSessionContext",
      "getLinkedContextFilePaths",
      "listLinkableVaultFiles",
      "refreshLinkedContextIndicators",
      "toggleLinkedContextFile",
      "removeLinkedContextFile",
      "clearLinkedContextFiles",
      "ensureLinkedContextPickerState",
      "ensureLinkedContextPickerDocumentBinding",
      "closeLinkedContextFilePicker",
      "detectLinkedContextMentionQuery",
      "syncLinkedContextPickerFromInputMention",
      "handleLinkedContextInputKeydown",
      "filterLinkedContextPickerEntries",
      "moveLinkedContextPickerSelection",
      "selectLinkedContextPickerEntry",
      "renderLinkedContextFilePickerList",
      "renderLinkedContextFilePicker",
      "openLinkedContextFilePicker",
      "buildLinkedContextPromptBlock",
      "composePromptWithLinkedFiles",
      "updateModelSelectOptions",
      "render",
      "renderHeader",
      "renderSidebar",
      "renderMain",
      "applyStatus",
    ].sort();

    const actual = Object.keys(layoutRendererMethods).sort();
    assert.deepEqual(actual, expected);
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
  }
});
