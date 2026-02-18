class OpenCodeClient {
  constructor(options) {
    if (!options || typeof options.SdkTransport !== "function" || typeof options.CompatTransport !== "function") {
      throw new Error("OpenCodeClient 需要注入 SdkTransport 和 CompatTransport 构造器");
    }
    this.SdkTransport = options.SdkTransport;
    this.CompatTransport = options.CompatTransport;
    this.settings = options.settings;
    this.logger = options.logger || (() => {});
    this.sdk = new this.SdkTransport(options);
    this.compat = new this.CompatTransport(options);
    this.lastMode = "compat";
    this.lastError = "";
  }

  updateSettings(settings) {
    this.settings = settings;
    this.sdk.updateSettings(settings);
    this.compat.updateSettings(settings);
  }

  primary() {
    // In Obsidian renderer runtime, SDK path can hit file:// import restrictions.
    // Force compat transport for reliability.
    return this.compat;
  }

  fallback() {
    return null;
  }

  async withTransport(actionName, fn) {
    const primary = this.primary();
    try {
      const out = await fn(primary);
      this.logger(`action=${actionName} mode=compat ok`);
      this.lastMode = "compat";
      this.lastError = "";
      return out;
    } catch (e1) {
      const fb = this.fallback();
      if (!fb) {
        this.logger(`action=${actionName} mode=compat err=${e1 instanceof Error ? e1.message : String(e1)}`);
        this.lastError = e1 instanceof Error ? e1.message : String(e1);
        throw e1;
      }

      try {
        const out = await fn(fb);
        this.lastMode = "compat";
        this.lastError = "";
        return out;
      } catch (e2) {
        this.lastError = `[${actionName}] SDK失败: ${e1 instanceof Error ? e1.message : String(e1)} | Compat失败: ${e2 instanceof Error ? e2.message : String(e2)}`;
        throw e2;
      }
    }
  }

  testConnection() {
    return this.withTransport("testConnection", (t) => t.testConnection());
  }
  listSessions() {
    return this.withTransport("listSessions", (t) => t.listSessions());
  }
  createSession(title) {
    return this.withTransport("createSession", (t) => t.createSession(title));
  }
  listModels() {
    return this.withTransport("listModels", (t) => t.listModels());
  }
  setDefaultModel(options) {
    return this.withTransport("setDefaultModel", (t) => {
      if (typeof t.setDefaultModel === "function") return t.setDefaultModel(options);
      if (typeof t.switchModel === "function") return t.switchModel(options);
      return { ok: true, model: String(options && options.model ? options.model : "") };
    });
  }
  switchModel(options) {
    return this.setDefaultModel(options);
  }
  sendMessage(options) {
    return this.withTransport("sendMessage", (t) => t.sendMessage(options));
  }
  listQuestions(options = {}) {
    return this.withTransport("listQuestions", (t) => {
      if (typeof t.listQuestions === "function") return t.listQuestions(options);
      return [];
    });
  }
  replyQuestion(options) {
    return this.withTransport("replyQuestion", (t) => {
      if (typeof t.replyQuestion === "function") return t.replyQuestion(options);
      return { ok: false };
    });
  }
  replyPermission(options) {
    return this.withTransport("replyPermission", (t) => {
      if (typeof t.replyPermission === "function") return t.replyPermission(options);
      return { ok: false };
    });
  }
  async stop() {
    await this.sdk.stop();
    await this.compat.stop();
  }
}


module.exports = { OpenCodeClient };
