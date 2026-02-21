const { parseMethods } = require("./question/parse-methods");
const { requestStateMethods } = require("./question/request-state-methods");
const { submissionMethods } = require("./question/submission-methods");
const { inlinePanelMethods } = require("./question/inline-panel-methods");

const questionFlowMethods = {
  ...parseMethods,
  ...requestStateMethods,
  ...submissionMethods,
  ...inlinePanelMethods,
};

module.exports = { questionFlowMethods };
