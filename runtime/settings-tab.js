const {
  PluginSettingTab,
} = require("obsidian");
const {
  basicSettingsSectionMethods,
} = require("./settings/basic-settings-section-methods");
const {
  providerAuthUtilsMethods,
} = require("./settings/provider-auth-utils");
const {
  providerAuthSectionMethods,
} = require("./settings/provider-auth-section-methods");
const {
  providerAuthActionsMethods,
} = require("./settings/provider-auth-actions");

class FLOWnoteSettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.providerSearchQuery = "";
    this.providerAuthSnapshot = null;
  }
}

Object.assign(
  FLOWnoteSettingsTab.prototype,
  basicSettingsSectionMethods,
  providerAuthUtilsMethods,
  providerAuthSectionMethods,
  providerAuthActionsMethods,
);

module.exports = { FLOWnoteSettingsTab };
