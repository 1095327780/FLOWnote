function createQuestionPermissionMethods(deps = {}) {
  const {
    parseSlashCommand,
  } = deps;

  class QuestionPermissionMethods {
  async replyPermission(options) {
    const response = String(options && options.response ? options.response : "").trim();
    if (!["once", "always", "reject"].includes(response)) return { ok: false };
    await this.request(
      "POST",
      `/session/${encodeURIComponent(options.sessionId)}/permissions/${encodeURIComponent(options.permissionId)}`,
      { response },
      { directory: this.vaultPath },
      options.signal,
    );
    return { ok: true };
  }

  async listQuestions(options = {}) {
    const res = await this.request(
      "GET",
      "/question",
      undefined,
      { directory: this.vaultPath },
      options && options.signal ? options.signal : undefined,
    );
    const payload = res && res.data ? res.data : res;
    return Array.isArray(payload) ? payload : [];
  }

  async replyQuestion(options) {
    const requestId = String(options && options.requestId ? options.requestId : "").trim();
    if (!requestId) return { ok: false };
    const answers = Array.isArray(options && options.answers ? options.answers : [])
      ? options.answers.map((row) => {
        if (!Array.isArray(row)) return [];
        return row
          .map((item) => String(item || "").trim())
          .filter(Boolean);
      })
      : [];

    await this.request(
      "POST",
      `/question/${encodeURIComponent(requestId)}/reply`,
      { answers },
      { directory: this.vaultPath },
      options && options.signal ? options.signal : undefined,
    );
    return { ok: true };
  }

  async setDefaultModel(options) {
    await this.ensureAuth();
    const modelID = String(options.model || "").trim();
    if (!modelID) return { ok: true, model: "" };

    try {
      await this.request(
        "PATCH",
        "/config",
        {
          model: modelID,
        },
        { directory: this.vaultPath },
        options.signal,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isConfigMissing = /config\.json/i.test(message) && /enoent|no such file|cannot find/i.test(message);
      if (!isConfigMissing) throw error;
      // Some environments (e.g. WSL + remapped drive) don't expose a writable config.json path.
      // Keep model switch effective via per-request model command and plugin-level persistence.
      this.log(`setDefaultModel fallback (config missing): ${message}`);
      return { ok: true, model: modelID, persisted: false };
    }

    return { ok: true, model: modelID };
  }

  async switchModel(options) {
    return this.setDefaultModel(options);
  }

  parseSlashCommand(prompt) {
    return parseSlashCommand(prompt);
  }

  }

  const methods = {};
  for (const key of Object.getOwnPropertyNames(QuestionPermissionMethods.prototype)) {
    if (key === "constructor") continue;
    methods[key] = QuestionPermissionMethods.prototype[key];
  }
  return methods;
}

module.exports = { createQuestionPermissionMethods };
