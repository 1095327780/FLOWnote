const { sharedLayoutMethods } = require("./layout/shared-utils");
const { headerMethods } = require("./layout/header-methods");
const { sidebarMethods } = require("./layout/sidebar-methods");
const { linkedContextMethods } = require("./layout/linked-context-methods");
const { mainComposerMethods } = require("./layout/main-composer-methods");

const layoutRendererMethods = {
  ...sharedLayoutMethods,
  ...sidebarMethods,
  ...linkedContextMethods,
  ...headerMethods,
  ...mainComposerMethods,
};

module.exports = { layoutRendererMethods };
