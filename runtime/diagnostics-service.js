const { rt } = (() => {
  try {
    return require("./runtime-locale-state");
  } catch (_e) {
    return {
      rt: (_zh, en, params = {}) => String(en || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, k) => {
        const value = params[k];
        return value === undefined || value === null ? "" : String(value);
      }),
    };
  }
})();

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
          hint: rt("Resolver 未注入", "Resolver is not initialized"),
        }),
      };
    this.lastResult = null;
    this.inflight = null;
  }

  async runFresh() {
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

  async runCached(ttlMs = 10000, force = false) {
    const ttl = Math.max(0, Number(ttlMs) || 0);
    const now = Date.now();
    if (!force && this.lastResult && now - Number(this.lastResult.at || 0) <= ttl) {
      return this.lastResult;
    }

    if (this.inflight) return this.inflight;

    this.inflight = this.runFresh()
      .finally(() => {
        this.inflight = null;
      });

    return this.inflight;
  }

  async run() {
    return this.runCached(0, true);
  }

  getLastResult() {
    return this.lastResult;
  }
}


module.exports = { DiagnosticsService };
