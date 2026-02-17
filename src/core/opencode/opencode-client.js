const { SdkTransport } = require("./transports/sdk-transport");
const { CompatTransport } = require("./transports/compat-transport");

class OpenCodeClient {
  constructor(options) {
    this.vaultPath = options.vaultPath;
    this.settings = options.settings;
    this.logger = options.logger;

    this.sdkTransport = new SdkTransport({
      vaultPath: this.vaultPath,
      settings: this.settings,
      logger: this.logger,
    });

    this.compatTransport = new CompatTransport({
      vaultPath: this.vaultPath,
      settings: this.settings,
      logger: this.logger,
    });

    this.lastMode = "sdk";
    this.lastError = "";
  }

  updateSettings(settings) {
    this.settings = settings;
    this.sdkTransport.updateSettings(settings);
    this.compatTransport.updateSettings(settings);
  }

  getPrimaryTransport() {
    return this.settings.transportMode === "compat" ? this.compatTransport : this.sdkTransport;
  }

  getFallbackTransport() {
    return this.settings.transportMode === "compat" ? null : this.compatTransport;
  }

  async withTransport(actionName, fn) {
    const primary = this.getPrimaryTransport();
    try {
      const out = await fn(primary);
      this.lastMode = this.settings.transportMode === "compat" ? "compat" : "sdk";
      this.lastError = "";
      return out;
    } catch (primaryError) {
      const fallback = this.getFallbackTransport();
      if (!fallback) {
        this.lastError = primaryError instanceof Error ? primaryError.message : String(primaryError);
        throw primaryError;
      }

      try {
        const out = await fn(fallback);
        this.lastMode = "compat";
        this.lastError = "";
        return out;
      } catch (fallbackError) {
        this.lastError = [
          `[${actionName}] SDK失败: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}`,
          `[${actionName}] Compat失败: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        ].join(" | ");
        throw fallbackError;
      }
    }
  }

  async testConnection() {
    return this.withTransport("testConnection", (transport) => transport.testConnection());
  }

  async listSessions() {
    return this.withTransport("listSessions", (transport) => transport.listSessions());
  }

  async createSession(title) {
    return this.withTransport("createSession", (transport) => transport.createSession(title));
  }

  async listModels() {
    return this.withTransport("listModels", (transport) => transport.listModels());
  }

  async sendMessage(options) {
    return this.withTransport("sendMessage", (transport) => transport.sendMessage(options));
  }

  async stop() {
    await this.sdkTransport.stop();
    await this.compatTransport.stop();
  }
}

module.exports = {
  OpenCodeClient,
};
