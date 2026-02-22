const { Notice } = require("obsidian");
const { normalizeSettings } = require("../settings-utils");
const { CaptureModal } = require("./capture-modal");
const { MobileSettingsTab } = require("./mobile-settings-tab");

const mobileCaptureMethodsMixin = {
  /**
   * Mobile-only onload — called instead of desktop onload on mobile platforms.
   */
  async onloadMobile() {
    try {
      const manifestVersion =
        this.manifest && this.manifest.version ? String(this.manifest.version) : "dev";
      console.log(`[FLOWnote] mobile runtime v${manifestVersion} loaded`);

      await this.loadMobilePersistedData();

      // Ribbon icon
      this.addRibbonIcon("lightbulb", "快速捕获想法", () => {
        this.openCaptureModal();
      });

      // Command
      this.addCommand({
        id: "mobile-quick-capture",
        name: "快速捕获想法",
        callback: () => {
          this.openCaptureModal();
        },
      });

      // Settings tab
      this.addSettingTab(new MobileSettingsTab(this.app, this));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[FLOWnote] mobile load failed", e);
      new Notice(`FLOWnote 移动端加载失败: ${msg}`);
    }
  },

  /**
   * Open the capture modal.
   */
  openCaptureModal() {
    new CaptureModal(this.app, this).open();
  },

  /**
   * Simplified data loading for mobile — no Node.js dependencies.
   */
  async loadMobilePersistedData() {
    const raw = await this.loadData();
    const data = raw && typeof raw === "object" ? raw : {};
    this.settings = normalizeSettings(data.settings || {});
  },

  /**
   * Save settings (shares data.json format with desktop).
   */
  async saveMobileSettings() {
    const raw = (await this.loadData()) || {};
    raw.settings = this.settings;
    await this.saveData(raw);
  },

  /**
   * Alias for save — used by settings tab.
   */
  async saveSettings() {
    await this.saveMobileSettings();
  },
};

module.exports = { mobileCaptureMethodsMixin };
