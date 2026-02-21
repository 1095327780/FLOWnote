const { scrollMethods } = require("./message/scroll-methods");
const { markdownMethods } = require("./message/markdown-methods");
const { blockUtilsMethods } = require("./message/block-utils");
const { blockRenderMethods } = require("./message/block-render-methods");
const { messageListMethods } = require("./message/message-list-methods");

const messageRendererMethods = {
  ...scrollMethods,
  ...messageListMethods,
  ...markdownMethods,
  ...blockUtilsMethods,
  ...blockRenderMethods,
};

module.exports = { messageRendererMethods };
