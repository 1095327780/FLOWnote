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
    rt = (_zh, en, params = {}) => String(en || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, k) => {
      const v = params[k];
      return v === undefined || v === null ? "" : String(v);
    }),
  } = deps;

  class RequestSessionMethods {
  ensureSessionAliasMap() {
    if (!(this.sessionAliasMap instanceof Map)) {
      this.sessionAliasMap = new Map();
    }
    return this.sessionAliasMap;
  }

  resolveSessionAlias(sessionId) {
    const original = String(sessionId || "").trim();
    if (!original) return "";

    const map = this.ensureSessionAliasMap();
    const seen = new Set();
    let current = original;
    while (current && map.has(current) && !seen.has(current)) {
      seen.add(current);
      const next = String(map.get(current) || "").trim();
      if (!next) break;
      current = next;
    }
    return current || original;
  }

  rememberSessionAlias(fromSessionId, toSessionId, source = "") {
    const from = String(fromSessionId || "").trim();
    const toRaw = String(toSessionId || "").trim();
    if (!from || !toRaw || from === toRaw) return;
    const to = this.resolveSessionAlias(toRaw);
    if (!to || from === to) return;

    const map = this.ensureSessionAliasMap();
    const previous = String(map.get(from) || "").trim();
    if (previous === to) return;
    map.set(from, to);
    if (source) {
      this.log(`session alias set ${JSON.stringify({ from, to, source })}`);
    }
  }

  ensureSessionDirectoryHintMap() {
    if (!(this.sessionDirectoryHints instanceof Map)) {
      this.sessionDirectoryHints = new Map();
    }
    return this.sessionDirectoryHints;
  }

  rememberSessionDirectoryHint(sessionId, directory, source = "") {
    const sidRaw = String(sessionId || "").trim();
    const sid = this.resolveSessionAlias(sidRaw) || sidRaw;
    const rawDirectory = String(directory || "").trim();
    if (!sid || !rawDirectory) return;

    const normalized = String(this.normalizeDirectoryForService(rawDirectory) || rawDirectory).trim();
    if (!normalized) return;

    const map = this.ensureSessionDirectoryHintMap();
    const previous = String(map.get(sid) || "").trim();
    if (previous === normalized) return;

    map.set(sid, normalized);
    if (source) {
      this.log(`session directory hint set ${JSON.stringify({ sessionId: sid, directory: normalized, source })}`);
    }
  }

  getSessionScopedDirectory(sessionId) {
    const sidRaw = String(sessionId || "").trim();
    const sid = this.resolveSessionAlias(sidRaw) || sidRaw;
    if (!sid) return this.vaultPath;
    const map = this.ensureSessionDirectoryHintMap();
    const hinted = String(map.get(sid) || "").trim();
    return hinted || this.vaultPath;
  }

  buildSessionDirectoryQuery(sessionId, query = {}) {
    const next = query && typeof query === "object" ? { ...query } : {};
    const hasDirectory = Object.prototype.hasOwnProperty.call(next, "directory")
      && String(next.directory || "").trim().length > 0;
    if (!hasDirectory) {
      const scoped = this.getSessionScopedDirectory(sessionId);
      if (String(scoped || "").trim()) next.directory = scoped;
    }
    return next;
  }

  collectSessionDirectoryCandidates(sessionId, preferredDirectory = "") {
    const candidates = [];
    const seen = new Set();
    const push = (value) => {
      const raw = String(value || "").trim();
      if (!raw) return;
      if (seen.has(raw)) return;
      seen.add(raw);
      candidates.push(raw);
    };

    push(preferredDirectory);
    push(this.getSessionScopedDirectory(sessionId));
    push(this.vaultPath);
    if (this.launchContext && this.launchContext.mode === "wsl") {
      push(this.launchContext.directory);
      if (typeof this.getDefaultWslWorkspaceDir === "function") {
        push(this.getDefaultWslWorkspaceDir());
      }
      if (typeof this.resolveWslDirectory === "function") {
        push(this.resolveWslDirectory(this.vaultPath));
      }
      if (typeof this.buildWslDirectoryCandidates === "function") {
        const extras = this.buildWslDirectoryCandidates(this.vaultPath);
        for (const item of extras) push(item);
      }
    }
    return candidates;
  }

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
      throw new Error(rt(
        "FLOWnote 连接失败: {message}{hint}",
        "FLOWnote connection failed: {message}{hint}",
        { message, hint },
      ));
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
      throw new Error(rt(
        "FLOWnote 请求失败 ({status}): {detail}{hint}",
        "FLOWnote request failed ({status}): {detail}{hint}",
        { status: resp.status, detail, hint },
      ));
    }

    return parsed;
  }

  parseModel() {
    return parseModel(this.settings.defaultModel);
  }

  parseCommandModel() {
    return parseCommandModel(this.settings.defaultModel);
  }

  extractSessionId(candidate) {
    const payload = candidate && typeof candidate === "object" ? candidate : null;
    if (!payload) return "";

    const direct = String(payload.id || payload.sessionID || payload.sessionId || "").trim();
    if (direct) return direct;

    const nestedCandidates = [
      payload.session,
      payload.data,
      payload.result,
      payload.payload,
      payload.item,
    ];
    for (const nested of nestedCandidates) {
      if (!nested || typeof nested !== "object") continue;
      const nestedId = String(nested.id || nested.sessionID || nested.sessionId || "").trim();
      if (nestedId) return nestedId;
    }

    return "";
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
    const requestedSessionId = String(sessionId || "").trim();
    const targetSessionId = this.resolveSessionAlias(requestedSessionId) || requestedSessionId;
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
        `/session/${encodeURIComponent(targetSessionId)}/message`,
        undefined,
        query,
        signal,
      );
      return this.extractMessageList(listRes && listRes.data ? listRes.data : listRes);
    };

    const fetchListWithDirectoryFallback = async (baseQuery = {}) => {
      const primaryDirectory = String(
        Object.prototype.hasOwnProperty.call(baseQuery, "directory")
          ? baseQuery.directory
          : this.getSessionScopedDirectory(sessionId),
      ).trim();

      const fallbackEnabled = Boolean(
        options.allowDirectoryFallback !== false
        && this.launchContext
        && this.launchContext.mode === "wsl",
      );

      const candidates = fallbackEnabled
        ? this.collectSessionDirectoryCandidates(sessionId, primaryDirectory)
        : [primaryDirectory || this.vaultPath];

      let firstError = null;
      let firstList = null;
      let firstDirectory = "";

      for (let i = 0; i < candidates.length; i += 1) {
        const candidate = String(candidates[i] || "").trim();
        const query = { ...baseQuery, directory: candidate };
        try {
          const list = await fetchList(query);
          if (i === 0) {
            firstList = list;
            firstDirectory = candidate;
          }
          if (Array.isArray(list) && list.length > 0) {
            this.rememberSessionDirectoryHint(targetSessionId, candidate, i > 0 ? "message-list-fallback" : "message-list");
            if (i > 0) {
              this.log(`message list directory fallback hit ${JSON.stringify({
                sessionId: targetSessionId,
                directory: String(this.normalizeDirectoryForService(candidate) || candidate),
                size: list.length,
              })}`);
            }
            return { list, directory: candidate, source: i > 0 ? "fallback" : "primary" };
          }
        } catch (error) {
          if (!firstError) firstError = error;
        }
      }

      if (Array.isArray(firstList)) {
        return { list: firstList, directory: firstDirectory, source: "primary-empty" };
      }
      if (firstError) throw firstError;
      return { list: [], directory: primaryDirectory, source: "empty" };
    };

    const pickLatest = (messages) => {
      if (!shouldPickLatest) return null;
      return this.findLatestAssistantMessage(messages, startedAt);
    };

    if (state && state.useUnbounded) {
      const unboundedResult = await fetchListWithDirectoryFallback(this.buildSessionDirectoryQuery(sessionId));
      const unbounded = unboundedResult.list;
      return {
        list: unbounded,
        latest: pickLatest(unbounded),
        strategy: unboundedResult.source === "fallback" ? "unbounded-directory-fallback" : "unbounded",
      };
    }

    const limitedResult = await fetchListWithDirectoryFallback(this.buildSessionDirectoryQuery(sessionId, { limit }));
    const limited = limitedResult.list;
    const limitedLatest = pickLatest(limited);
    const needUnbounded =
      limited.length >= limit
      && (requireRecentTail || (startedAt > 0 && !limitedLatest));

    if (!needUnbounded) {
      return {
        list: limited,
        latest: limitedLatest,
        strategy: limitedResult.source === "fallback" ? "limited-directory-fallback" : "limited",
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

    const unboundedResult = await fetchListWithDirectoryFallback(this.buildSessionDirectoryQuery(sessionId));
    const unbounded = unboundedResult.list;
    const unboundedLatest = pickLatest(unbounded);
    const shouldPreferUnbounded = Boolean(
      unbounded.length > limited.length
      || (!limitedLatest && unboundedLatest),
    );

    if (state && shouldPreferUnbounded) {
      state.useUnbounded = true;
      this.log(`message list switched to unbounded fetch session=${targetSessionId} limited=${limited.length} full=${unbounded.length}`);
    }

    return shouldPreferUnbounded
      ? {
        list: unbounded,
        latest: unboundedLatest,
        strategy: unboundedResult.source === "fallback" ? "unbounded-directory-fallback" : "unbounded",
      }
      : {
        list: limited,
        latest: limitedLatest,
        strategy: limitedResult.source === "fallback" ? "limited-directory-fallback" : "limited",
      };
  }

  async getSessionStatus(sessionId, signal) {
    const requestedSessionId = String(sessionId || "").trim();
    const targetSessionId = this.resolveSessionAlias(requestedSessionId) || requestedSessionId;
    try {
      const res = await this.request(
        "GET",
        "/session/status",
        undefined,
        this.buildSessionDirectoryQuery(targetSessionId),
        signal,
      );
      const payload = res && res.data ? res.data : res;
      if (!payload || typeof payload !== "object") return null;

      if (Object.prototype.hasOwnProperty.call(payload, targetSessionId)) {
        const normalized = this.normalizeSessionStatus(payload[targetSessionId]);
        if (normalized) return normalized;
      }

      if (payload.sessions && typeof payload.sessions === "object"
        && Object.prototype.hasOwnProperty.call(payload.sessions, targetSessionId)) {
        const normalized = this.normalizeSessionStatus(payload.sessions[targetSessionId]);
        if (normalized) return normalized;
      }

      if (Array.isArray(payload)) {
        if (!payload.length) return { type: "idle" };
        const row = payload.find((item) => {
          if (!item || typeof item !== "object") return false;
          return item.id === targetSessionId || item.sessionID === targetSessionId || item.sessionId === targetSessionId;
        });
        const normalized = this.normalizeSessionStatus(row);
        if (normalized) return normalized;
      }

      if (payload.sessionID === targetSessionId || payload.sessionId === targetSessionId || payload.id === targetSessionId) {
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

  async testConnection() {
    await this.request("GET", "/path", undefined, { directory: this.vaultPath });
    return { ok: true, mode: "compat" };
  }

  async listSessions() {
    const res = await this.request("GET", "/session", undefined, { directory: this.vaultPath });
    const payload = res && res.data ? res.data : res || [];
    const sessions = Array.isArray(payload) ? payload : Array.isArray(payload.sessions) ? payload.sessions : [];
    for (const row of sessions) {
      if (!row || typeof row !== "object") continue;
      const sid = String(row.id || row.sessionID || row.sessionId || "").trim();
      const directory = String(row.directory || "").trim();
      if (!sid || !directory) continue;
      this.rememberSessionDirectoryHint(sid, directory, "list-sessions");
    }
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.sessions)) return payload.sessions;
    return [];
  }

  async listSessionMessages(options = {}) {
    const requestedSessionId = String(options.sessionId || "").trim();
    const sessionId = this.resolveSessionAlias(requestedSessionId) || requestedSessionId;
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
    const fallbackEnabled = Boolean(this.launchContext && this.launchContext.mode === "wsl");
    const candidates = fallbackEnabled
      ? this.collectSessionDirectoryCandidates("", this.vaultPath)
      : [String(this.vaultPath || "").trim()];

    let firstPayload = null;
    let firstError = null;

    for (let i = 0; i < candidates.length; i += 1) {
      const directory = String(candidates[i] || "").trim();
      if (!directory) continue;
      try {
        const res = await this.request(
          "POST",
          "/session",
          title ? { title } : {},
          { directory },
        );
        const payload = res && res.data ? res.data : res;
        if (firstPayload === null) firstPayload = payload;

        const sessionId = this.extractSessionId(payload);
        if (!sessionId) continue;

        const out = payload && typeof payload === "object" ? { ...payload } : { id: sessionId };
        if (!String(out.id || "").trim()) out.id = sessionId;
        this.rememberSessionDirectoryHint(
          sessionId,
          directory,
          i > 0 ? "create-session-fallback" : "create-session",
        );
        return out;
      } catch (error) {
        if (!firstError) firstError = error;
      }
    }

    if (firstPayload !== null) {
      const sessionId = this.extractSessionId(firstPayload);
      if (sessionId && firstPayload && typeof firstPayload === "object" && !String(firstPayload.id || "").trim()) {
        return { ...firstPayload, id: sessionId };
      }
      return firstPayload;
    }
    if (firstError) throw firstError;
    return {};
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
    if (!providerID) throw new Error(rt("providerID 不能为空", "providerID is required"));

    const method = Number(options.method);
    if (!Number.isFinite(method) || method < 0) throw new Error(rt("OAuth method 无效", "Invalid OAuth method"));

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
    if (!providerID) throw new Error(rt("providerID 不能为空", "providerID is required"));

    const method = Number(options.method);
    if (!Number.isFinite(method) || method < 0) throw new Error(rt("OAuth method 无效", "Invalid OAuth method"));

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
    if (!providerID) throw new Error(rt("providerID 不能为空", "providerID is required"));

    const key = String(options.key || "").trim();
    if (!key) throw new Error(rt("API Key 不能为空", "API Key is required"));

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
    if (!providerID) throw new Error(rt("providerID 不能为空", "providerID is required"));

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
