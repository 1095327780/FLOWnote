function createQuestionPermissionMethods(deps = {}) {
  const {
    parseSlashCommand,
  } = deps;

  class QuestionPermissionMethods {
  async replyPermission(options) {
    const sessionIdRaw = String(options && options.sessionId ? options.sessionId : "").trim();
    const sessionId = this.resolveSessionAlias(sessionIdRaw) || sessionIdRaw;
    const response = String(options && options.response ? options.response : "").trim();
    if (!sessionId || !["once", "always", "reject"].includes(response)) return { ok: false };
    await this.request(
      "POST",
      `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(options.permissionId)}`,
      { response },
      this.buildSessionDirectoryQuery(sessionId),
      options.signal,
    );
    return { ok: true };
  }

  async listQuestions(options = {}) {
    const requestOptions = options && typeof options === "object" ? options : { signal: options };
    const signal = requestOptions.signal;
    const sessionIdRaw = String(requestOptions.sessionId || "").trim();
    const sessionId = this.resolveSessionAlias(sessionIdRaw) || sessionIdRaw;
    const preferredDirectory = String(requestOptions.directory || this.getSessionScopedDirectory(sessionId)).trim();
    const fallbackEnabled = Boolean(
      requestOptions.allowDirectoryFallback !== false
      && this.launchContext
      && this.launchContext.mode === "wsl",
    );
    const candidates = fallbackEnabled
      ? this.collectSessionDirectoryCandidates(sessionId, preferredDirectory)
      : [preferredDirectory || this.vaultPath];

    let firstList = null;
    let firstError = null;
    for (let i = 0; i < candidates.length; i += 1) {
      const directory = String(candidates[i] || "").trim();
      try {
        const res = await this.request(
          "GET",
          "/question",
          undefined,
          { directory },
          signal,
        );
        const payload = res && res.data ? res.data : res;
        const list = Array.isArray(payload) ? payload : [];
        if (firstList === null) firstList = list;
        if (list.length) {
          if (sessionId) {
            this.rememberSessionDirectoryHint(sessionId, directory, i > 0 ? "question-list-fallback" : "question-list");
          }
          return list;
        }
      } catch (error) {
        if (!firstError) firstError = error;
      }
    }

    if (Array.isArray(firstList)) return firstList;
    if (firstError) throw firstError;
    return [];
  }

  async hasPendingQuestionsForSession(sessionId, options = {}) {
    const sidRaw = String(sessionId || "").trim();
    const sid = this.resolveSessionAlias(sidRaw) || sidRaw;
    if (!sid) return false;
    const requestOptions = (
      options
      && typeof options === "object"
      && (Object.prototype.hasOwnProperty.call(options, "signal") || Object.prototype.hasOwnProperty.call(options, "minIntervalMs"))
    )
      ? options
      : { signal: options };
    try {
      const listed = await this.listQuestions({ ...requestOptions, sessionId: sid });
      if (!Array.isArray(listed)) return false;
      return listed.some((item) => {
        if (!item || typeof item !== "object") return false;
        const reqSession = String(item.sessionID || item.sessionId || "").trim();
        if (!reqSession || reqSession !== sid) return false;
        const requestId = String(item.id || item.requestID || item.requestId || "").trim();
        return Boolean(requestId);
      });
    } catch (error) {
      this.log(`check pending question failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
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
      this.buildSessionDirectoryQuery(options && options.sessionId),
      options && options.signal ? options.signal : undefined,
    );
    return { ok: true };
  }

  async setDefaultModel(options) {
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
