const { ExecutableResolver } = require("../../core/diagnostics/executable-resolver");

class DiagnosticsService {
  constructor(plugin) {
    this.plugin = plugin;
    this.resolver = new ExecutableResolver();
    this.lastResult = null;
  }

  async run() {
    const settings = this.plugin.settings;
    const executable = await this.resolver.resolve(settings.cliPath);

    let connection = {
      ok: false,
      mode: settings.transportMode,
      error: "",
    };

    try {
      const result = await this.plugin.opencodeClient.testConnection();
      connection = {
        ok: true,
        mode: result.mode || settings.transportMode,
        error: "",
      };
    } catch (error) {
      connection = {
        ok: false,
        mode: settings.transportMode,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    this.lastResult = {
      at: Date.now(),
      executable,
      connection,
    };

    return this.lastResult;
  }

  getLastResult() {
    return this.lastResult;
  }
}

module.exports = {
  DiagnosticsService,
};
