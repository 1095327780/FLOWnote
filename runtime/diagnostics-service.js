class DiagnosticsService {
  constructor(plugin, ResolverCtor) {
    this.plugin = plugin;
    const Ctor = typeof ResolverCtor === "function" ? ResolverCtor : null;
    this.resolver = Ctor
      ? new Ctor()
      : {
        resolve: async () => ({
          ok: false,
          path: "",
          attempted: [],
          hint: "Resolver 未注入",
        }),
      };
    this.lastResult = null;
  }

  async run() {
    const executable = await this.resolver.resolve(this.plugin.settings.cliPath);

    let connection = { ok: false, mode: this.plugin.settings.transportMode, error: "" };
    try {
      const result = await this.plugin.opencodeClient.testConnection();
      connection = { ok: true, mode: result.mode || this.plugin.settings.transportMode, error: "" };
    } catch (e) {
      connection = { ok: false, mode: this.plugin.settings.transportMode, error: e instanceof Error ? e.message : String(e) };
    }

    this.lastResult = { at: Date.now(), executable, connection };
    return this.lastResult;
  }

  getLastResult() {
    return this.lastResult;
  }
}


module.exports = { DiagnosticsService };
