function createRequestSessionMethods(deps = {}) {
  const {
    URL,
    nodeHttpRequestJson,
    parseModel,
    parseCommandModel,
    availableCommandSet,
    resolveCommandFromSet,
    findLatestAssistantMessage,
    looksLikeRetryableConnectionError,
  } = deps;

  class RequestSessionMethods {
  withWslRequestLock(task) {
    const run = typeof task === "function" ? task : async () => null;
    const chain = Promise.resolve(this.wslRequestChain)
      .catch(() => {})
      .then(() => run());
    this.wslRequestChain = chain.catch(() => {});
    return chain;
  }

  async request(method, endpoint, body, query = {}, signal, retryState = {}) {
    const state = {
      wslSqliteRetried: Boolean(retryState && retryState.wslSqliteRetried),
      wslQueued: Boolean(retryState && retryState.wslQueued),
      connectionRetried: Boolean(retryState && retryState.connectionRetried),
    };
    if (this.launchContext && this.launchContext.mode === "wsl" && !state.wslQueued) {
      return this.withWslRequestLock(() =>
        this.request(method, endpoint, body, query, signal, {
          ...state,
          wslQueued: true,
        }));
    }

    const baseUrl = await this.ensureStarted();
    const url = new URL(baseUrl + endpoint);

    for (const [k, v] of Object.entries(query || {})) {
      const value = k === "directory" ? this.normalizeDirectoryForService(v) : v;
      if (value !== undefined && value !== null && String(value).length > 0) {
        url.searchParams.set(k, String(value));
      }
    }
    let resp;
    try {
      resp = await nodeHttpRequestJson(
        url.toString(),
        method,
        body,
        this.settings.requestTimeoutMs,
        signal,
        { trace: (line) => this.log(line) },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!state.connectionRetried && looksLikeRetryableConnectionError(message)) {
        this.log(`request connection reset, restart service and retry once: ${message}`);
        this.cleanupProcessOnBootFailure();
        return this.request(method, endpoint, body, query, signal, {
          ...state,
          connectionRetried: true,
        });
      }
      const hint = `${this.buildWslDirectoryHint(message)}${this.buildWslSqliteHint(message)}`;
      throw new Error(`OpenCode 连接失败: ${message}${hint}`);
    }
    const text = resp.text;
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    if (resp.status < 200 || resp.status >= 300) {
      const detail = parsed ? JSON.stringify(parsed) : text;
      if (!state.wslSqliteRetried && this.isWslSqliteLockError(resp.status, detail) && this.useWslDataHomeFallback()) {
        this.cleanupProcessOnBootFailure();
        return this.request(method, endpoint, body, query, signal, {
          ...state,
          wslSqliteRetried: true,
        });
      }
      const hint = `${this.buildWslDirectoryHint(detail)}${this.buildWslSqliteHint(detail)}`;
      throw new Error(`OpenCode 请求失败 (${resp.status}): ${detail}${hint}`);
    }

    return parsed;
  }

  parseModel() {
    return parseModel(this.settings.defaultModel);
  }

  parseCommandModel() {
    return parseCommandModel(this.settings.defaultModel);
  }

  normalizeSessionStatus(candidate) {
    if (typeof candidate === "string") {
      const type = candidate.trim().toLowerCase();
      return type ? { type } : null;
    }
    if (!candidate || typeof candidate !== "object") return null;

    if (candidate.status && typeof candidate.status === "object" && candidate.status !== candidate) {
      const nested = this.normalizeSessionStatus(candidate.status);
      if (nested) return nested;
    }
    if (candidate.state && typeof candidate.state === "object" && candidate.state !== candidate) {
      const nested = this.normalizeSessionStatus(candidate.state);
      if (nested) return nested;
    }

    const next = { ...candidate };
    if (!next.type && typeof next.status === "string") next.type = next.status;
    if (!next.type && typeof next.state === "string") next.type = next.state;
    if (typeof next.type === "string") next.type = next.type.trim().toLowerCase();
    return next;
  }

  normalizeMessageEnvelope(envelope, depth = 0) {
    if (depth > 3) return null;
    const item = envelope && typeof envelope === "object" ? envelope : null;
    if (!item) return null;

    if (item.info && typeof item.info === "object") {
      return {
        info: item.info,
        parts: Array.isArray(item.parts) ? item.parts : [],
      };
    }

    if (item.message && typeof item.message === "object") {
      return this.normalizeMessageEnvelope(item.message, depth + 1);
    }

    if (item.payload && typeof item.payload === "object") {
      return this.normalizeMessageEnvelope(item.payload, depth + 1);
    }

    const looksLikeInfo = Boolean(
      item.id
      || item.role
      || item.sessionID
      || item.sessionId
      || item.parentID
      || item.modelID,
    );
    if (looksLikeInfo) {
      return {
        info: item,
        parts: Array.isArray(item.parts) ? item.parts : [],
      };
    }
    return null;
  }

  extractMessageList(payload) {
    if (Array.isArray(payload)) {
      return payload
        .map((item) => this.normalizeMessageEnvelope(item))
        .filter(Boolean);
    }
    if (!payload || typeof payload !== "object") return [];

    const arrayCandidates = [
      payload.messages,
      payload.items,
      payload.list,
      payload.results,
      payload.result,
      payload.data,
      payload.message,
    ];
    for (const candidate of arrayCandidates) {
      if (!Array.isArray(candidate)) continue;
      return candidate
        .map((item) => this.normalizeMessageEnvelope(item))
        .filter(Boolean);
    }

    const singleCandidates = [
      payload.message,
      payload.data,
      payload.item,
      payload.result,
      payload.payload,
      payload,
    ];
    for (const candidate of singleCandidates) {
      const normalized = this.normalizeMessageEnvelope(candidate);
      if (normalized) return [normalized];
    }
    return [];
  }

  createMessageListFetchState(options = {}) {
    const fallbackCooldownMs = Number(options.fallbackCooldownMs);
    return {
      useUnbounded: Boolean(options.useUnbounded),
      lastFallbackAt: 0,
      fallbackCooldownMs: Number.isFinite(fallbackCooldownMs) && fallbackCooldownMs >= 0
        ? fallbackCooldownMs
        : 1500,
    };
  }

  async fetchSessionMessages(sessionId, options = {}) {
    const signal = options.signal;
    const startedAt = Number(options.startedAt || 0);
    const requireRecentTail = Boolean(options.requireRecentTail);
    const state = options.state && typeof options.state === "object" ? options.state : null;
    const rawLimit = Number(options.limit || 50);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.max(1, Math.floor(rawLimit)) : 50;
    const shouldPickLatest = startedAt > 0 || requireRecentTail;

    const fetchList = async (query) => {
      const listRes = await this.request(
        "GET",
        `/session/${encodeURIComponent(sessionId)}/message`,
        undefined,
        query,
        signal,
      );
      return this.extractMessageList(listRes && listRes.data ? listRes.data : listRes);
    };

    const pickLatest = (messages) => {
      if (!shouldPickLatest) return null;
      return this.findLatestAssistantMessage(messages, startedAt);
    };

    if (state && state.useUnbounded) {
      const unbounded = await fetchList({ directory: this.vaultPath });
      return {
        list: unbounded,
        latest: pickLatest(unbounded),
        strategy: "unbounded",
      };
    }

    const limited = await fetchList({ directory: this.vaultPath, limit });
    const limitedLatest = pickLatest(limited);
    const needUnbounded =
      limited.length >= limit
      && (requireRecentTail || (startedAt > 0 && !limitedLatest));

    if (!needUnbounded) {
      return {
        list: limited,
        latest: limitedLatest,
        strategy: "limited",
      };
    }

    if (state && state.fallbackCooldownMs > 0 && state.lastFallbackAt > 0) {
      const sinceLastFallback = Date.now() - Number(state.lastFallbackAt || 0);
      if (sinceLastFallback < state.fallbackCooldownMs) {
        return {
          list: limited,
          latest: limitedLatest,
          strategy: "limited-cooldown",
        };
      }
    }

    if (state) state.lastFallbackAt = Date.now();

    const unbounded = await fetchList({ directory: this.vaultPath });
    const unboundedLatest = pickLatest(unbounded);
    const shouldPreferUnbounded = Boolean(
      unbounded.length > limited.length
      || (!limitedLatest && unboundedLatest),
    );

    if (state && shouldPreferUnbounded) {
      state.useUnbounded = true;
      this.log(`message list switched to unbounded fetch session=${sessionId} limited=${limited.length} full=${unbounded.length}`);
    }

    return shouldPreferUnbounded
      ? { list: unbounded, latest: unboundedLatest, strategy: "unbounded" }
      : { list: limited, latest: limitedLatest, strategy: "limited" };
  }

  async getSessionStatus(sessionId, signal) {
    try {
      const res = await this.request("GET", "/session/status", undefined, { directory: this.vaultPath }, signal);
      const payload = res && res.data ? res.data : res;
      if (!payload || typeof payload !== "object") return null;

      if (Object.prototype.hasOwnProperty.call(payload, sessionId)) {
        const normalized = this.normalizeSessionStatus(payload[sessionId]);
        if (normalized) return normalized;
      }

      if (payload.sessions && typeof payload.sessions === "object"
        && Object.prototype.hasOwnProperty.call(payload.sessions, sessionId)) {
        const normalized = this.normalizeSessionStatus(payload.sessions[sessionId]);
        if (normalized) return normalized;
      }

      if (Array.isArray(payload)) {
        if (!payload.length) return { type: "idle" };
        const row = payload.find((item) => {
          if (!item || typeof item !== "object") return false;
          return item.id === sessionId || item.sessionID === sessionId || item.sessionId === sessionId;
        });
        const normalized = this.normalizeSessionStatus(row);
        if (normalized) return normalized;
      }

      if (payload.sessionID === sessionId || payload.sessionId === sessionId || payload.id === sessionId) {
        const normalized = this.normalizeSessionStatus(payload);
        if (normalized) return normalized;
      }

      const normalized = this.normalizeSessionStatus(payload);
      if (normalized && (normalized.type || normalized.message || normalized.reason || normalized.error)) {
        return normalized;
      }

      const hasKnownRootShape = Boolean(
        Object.prototype.hasOwnProperty.call(payload, "type")
        || Object.prototype.hasOwnProperty.call(payload, "status")
        || Object.prototype.hasOwnProperty.call(payload, "state")
        || Object.prototype.hasOwnProperty.call(payload, "message")
        || Object.prototype.hasOwnProperty.call(payload, "error")
        || Object.prototype.hasOwnProperty.call(payload, "reason")
        || Object.prototype.hasOwnProperty.call(payload, "id")
        || Object.prototype.hasOwnProperty.call(payload, "sessionID")
        || Object.prototype.hasOwnProperty.call(payload, "sessionId"),
      );
      if (!hasKnownRootShape) {
        return { type: "idle" };
      }

      return null;
    } catch {
      return null;
    }
  }

  findLatestAssistantMessage(messages, startedAt) {
    return findLatestAssistantMessage(messages, startedAt);
  }

  async ensureAuth() {
    if (this.settings.authMode !== "custom-api-key") return;
    if (!this.settings.customApiKey.trim()) throw new Error("当前是自定义 API Key 模式，但 API Key 为空");

    const providerId = this.settings.customProviderId.trim();
    await this.setProviderApiKeyAuth({
      providerID: providerId,
      key: this.settings.customApiKey.trim(),
    });

    if (this.settings.customBaseUrl.trim()) {
      await this.request(
        "PATCH",
        "/config",
        {
          provider: {
            [providerId]: {
              options: {
                baseURL: this.settings.customBaseUrl.trim(),
              },
            },
          },
        },
        { directory: this.vaultPath },
      );
    }
  }

  async testConnection() {
    await this.request("GET", "/path", undefined, { directory: this.vaultPath });
    return { ok: true, mode: "compat" };
  }

  async listSessions() {
    const res = await this.request("GET", "/session", undefined, { directory: this.vaultPath });
    const payload = res && res.data ? res.data : res || [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.sessions)) return payload.sessions;
    return [];
  }

  async listSessionMessages(options = {}) {
    const sessionId = String(options.sessionId || "").trim();
    if (!sessionId) return [];

    const rawLimit = Number(options.limit || 200);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.max(1, Math.floor(rawLimit)) : 200;
    const fetched = await this.fetchSessionMessages(sessionId, {
      signal: options.signal,
      limit,
      requireRecentTail: true,
      state: this.createMessageListFetchState(),
    });
    return Array.isArray(fetched && fetched.list) ? fetched.list : [];
  }

  async createSession(title) {
    const res = await this.request("POST", "/session", title ? { title } : {}, { directory: this.vaultPath });
    return res && res.data ? res.data : res;
  }

  async listModels() {
    try {
      const res = await this.request("GET", "/config/providers", undefined, { directory: this.vaultPath });
      const payload = res && res.data ? res.data : res || [];
      const providers = Array.isArray(payload) ? payload : Array.isArray(payload.providers) ? payload.providers : [];
      const out = [];
      for (const p of providers) {
        const models = p.models || {};
        for (const key of Object.keys(models)) out.push(`${p.id}/${key}`);
      }
      return out.sort();
    } catch {
      return [];
    }
  }

  async listProviders() {
    const res = await this.request("GET", "/provider", undefined, { directory: this.vaultPath });
    const payload = res && res.data ? res.data : res || {};
    const all = Array.isArray(payload.all) ? payload.all : [];
    const connected = Array.isArray(payload.connected) ? payload.connected : [];
    const defaults = payload && typeof payload.default === "object" && payload.default ? payload.default : {};
    return {
      all,
      connected,
      default: defaults,
    };
  }

  async listProviderAuthMethods() {
    const res = await this.request("GET", "/provider/auth", undefined, { directory: this.vaultPath });
    const payload = res && res.data ? res.data : res || {};
    return payload && typeof payload === "object" ? payload : {};
  }

  async authorizeProviderOauth(options = {}) {
    const providerID = String(options.providerID || "").trim();
    if (!providerID) throw new Error("providerID 不能为空");

    const method = Number(options.method);
    if (!Number.isFinite(method) || method < 0) throw new Error("OAuth method 无效");

    const res = await this.request(
      "POST",
      `/provider/${encodeURIComponent(providerID)}/oauth/authorize`,
      { method: Number(method) },
      { directory: this.vaultPath },
      options.signal,
    );
    return res && res.data ? res.data : res;
  }

  async completeProviderOauth(options = {}) {
    const providerID = String(options.providerID || "").trim();
    if (!providerID) throw new Error("providerID 不能为空");

    const method = Number(options.method);
    if (!Number.isFinite(method) || method < 0) throw new Error("OAuth method 无效");

    const body = { method: Number(method) };
    const code = String(options.code || "").trim();
    if (code) body.code = code;

    const res = await this.request(
      "POST",
      `/provider/${encodeURIComponent(providerID)}/oauth/callback`,
      body,
      { directory: this.vaultPath },
      options.signal,
    );
    const payload = res && Object.prototype.hasOwnProperty.call(res, "data") ? res.data : res;
    return payload === undefined ? true : Boolean(payload);
  }

  async setProviderApiKeyAuth(options = {}) {
    const providerID = String(options.providerID || "").trim();
    if (!providerID) throw new Error("providerID 不能为空");

    const key = String(options.key || "").trim();
    if (!key) throw new Error("API Key 不能为空");

    await this.request(
      "PUT",
      `/auth/${encodeURIComponent(providerID)}`,
      { type: "api", key },
      undefined,
      options.signal,
    );
    return true;
  }

  async clearProviderAuth(options = {}) {
    const providerID = String(options.providerID || "").trim();
    if (!providerID) throw new Error("providerID 不能为空");

    await this.request(
      "DELETE",
      `/auth/${encodeURIComponent(providerID)}`,
      undefined,
      undefined,
      options.signal,
    );
    return true;
  }

  async listCommands() {
    const now = Date.now();
    if (now - this.commandCache.at < 30000 && this.commandCache.items.length) {
      return this.commandCache.items;
    }

    try {
      const res = await this.request("GET", "/command", undefined, { directory: this.vaultPath });
      const payload = res && res.data ? res.data : res || [];
      const items = Array.isArray(payload) ? payload : Array.isArray(payload.commands) ? payload.commands : [];
      this.commandCache = {
        at: now,
        items: Array.isArray(items) ? items : [],
      };
      return this.commandCache.items;
    } catch {
      return [];
    }
  }

  async resolveCommandForEndpoint(commandName) {
    const list = await this.listCommands();
    const names = availableCommandSet(list);
    return resolveCommandFromSet(commandName, names);
  }

  getFinalizeTimeoutConfig() {
    const configured = Math.max(15000, Number(this.settings.requestTimeoutMs) || 120000);
    const isWsl = this.launchContext && this.launchContext.mode === "wsl";
    const quietTimeoutMs = Math.min(configured, isWsl ? 90000 : 90000);
    const maxTotalMs = Math.min(
      Math.max(quietTimeoutMs * 2, 90000),
      isWsl ? 180000 : 180000,
    );
    return { quietTimeoutMs, maxTotalMs };
  }

  }

  const methods = {};
  for (const key of Object.getOwnPropertyNames(RequestSessionMethods.prototype)) {
    if (key === "constructor") continue;
    methods[key] = RequestSessionMethods.prototype[key];
  }
  return methods;
}

module.exports = { createRequestSessionMethods };
