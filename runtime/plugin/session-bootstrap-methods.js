const {
  extractAssistantPayloadFromEnvelope,
} = require("../assistant-payload-utils");

const RUNTIME_SCHEMA_VERSION = 1;

function normalizeTimestampMs(value) {
  const raw = Number(value || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  if (raw >= 1e14) return Math.floor(raw / 1000);
  if (raw >= 1e12) return Math.floor(raw);
  if (raw >= 1e9) return Math.floor(raw * 1000);
  return Math.floor(raw);
}

function mergeSnapshotText(existingText, incomingText) {
  const existing = String(existingText || "");
  const incoming = String(incomingText || "");
  if (!incoming.trim()) return existing;
  if (!existing.trim()) return incoming;
  if (existing === incoming) return existing;
  if (incoming.includes(existing)) return incoming;
  if (existing.includes(incoming)) return existing;
  return incoming.length >= existing.length ? incoming : existing;
}

function extractMergedPartText(parts, targetType = "text") {
  const list = Array.isArray(parts) ? parts : [];
  const byPart = new Map();
  list.forEach((part, index) => {
    const item = part && typeof part === "object" ? part : null;
    if (!item || String(item.type || "").trim().toLowerCase() !== String(targetType || "").toLowerCase()) return;
    const key = String(item.id || `${targetType}:${index}`);
    const current = String(byPart.get(key) || "");
    let next = current;
    if (typeof item.delta === "string") next = mergeSnapshotText(next, item.delta);
    if (typeof item.text === "string") next = mergeSnapshotText(next, item.text);
    byPart.set(key, next);
  });
  return Array.from(byPart.values())
    .map((text) => String(text || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

function toLocalSessionMessage(envelope, index, extractAssistantPayload) {
  const row = envelope && typeof envelope === "object" ? envelope : null;
  if (!row) return null;
  const info = row.info && typeof row.info === "object" ? row.info : {};
  const parts = Array.isArray(row.parts) ? row.parts : [];
  const roleRaw = String(info.role || info.type || "").trim().toLowerCase();
  const role = roleRaw === "assistant" ? "assistant" : roleRaw === "user" ? "user" : "";
  if (!role) return null;

  const id = String(info.id || `${role}-${index}`);
  const createdAt = normalizeTimestampMs(
    (info.time && info.time.created) || info.created || info.updated || 0,
  );

  if (role === "assistant") {
    const payload = typeof extractAssistantPayload === "function"
      ? extractAssistantPayload({ info, parts }) || { text: "", reasoning: "", meta: "", blocks: [] }
      : {
        text: extractMergedPartText(parts, "text"),
        reasoning: extractMergedPartText(parts, "reasoning"),
        meta: "",
        blocks: [],
      };
    const hasVisiblePayload = Boolean(
      String(payload.text || "").trim()
      || String(payload.reasoning || "").trim()
      || String(payload.meta || "").trim()
      || (Array.isArray(payload.blocks) && payload.blocks.length),
    );
    if (!hasVisiblePayload) return null;
    return {
      id,
      role,
      text: String(payload.text || ""),
      reasoning: String(payload.reasoning || ""),
      meta: String(payload.meta || ""),
      blocks: Array.isArray(payload.blocks) ? payload.blocks : [],
      createdAt,
      pending: false,
      error: "",
      __sortIndex: index,
    };
  }

  const text = extractMergedPartText(parts, "text");
  if (!text.trim()) return null;
  return {
    id,
    role,
    text,
    reasoning: "",
    meta: "",
    blocks: [],
    createdAt,
    pending: false,
    error: "",
    __sortIndex: index,
  };
}

const sessionBootstrapMethods = {
  getAssistantView() {
    const leaves = this.app.workspace.getLeavesOfType(this.getViewType());
    if (!leaves.length) return null;
    return leaves[0].view;
  },

  async activateView() {
    const leaves = this.app.workspace.getLeavesOfType(this.getViewType());
    if (leaves.length) {
      await this.app.workspace.revealLeaf(leaves[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: this.getViewType(), active: true });
    await this.app.workspace.revealLeaf(leaf);
  },

  async loadPersistedData() {
    const runtime = this.ensureRuntimeModules();
    const raw = (await this.loadData()) || {};
    const rawSchemaVersion = Number(raw && raw.schemaVersion ? raw.schemaVersion : 0);
    this.schemaVersion = Number.isFinite(rawSchemaVersion) && rawSchemaVersion > 0
      ? Math.floor(rawSchemaVersion)
      : RUNTIME_SCHEMA_VERSION;
    const extractRawTransportMode = (value) => String(value || "").trim().toLowerCase();
    const markTransportModeMigrationIfNeeded = (rawMode) => {
      const normalized = extractRawTransportMode(this.settings && this.settings.transportMode);
      if (!rawMode || rawMode === normalized) return;
      if (typeof this.markTransportModeCompatNormalization !== "function") return;
      if (this.markTransportModeCompatNormalization(rawMode)) {
        this.transportModeMigrationDirty = true;
      }
    };

    if (raw.settings || raw.runtimeState) {
      const rawSettings = raw.settings || {};
      const rawTransportMode = extractRawTransportMode(rawSettings.transportMode);
      this.settings = runtime.normalizeSettings(rawSettings);
      const runtimeStateRaw = raw.runtimeState || { sessions: [], activeSessionId: "", messagesBySession: {} };
      let beforeSnapshot = "";
      try {
        beforeSnapshot = JSON.stringify(runtimeStateRaw);
      } catch {
        beforeSnapshot = "";
      }
      this.runtimeState = runtime.migrateLegacyMessages(runtimeStateRaw);
      let afterSnapshot = "";
      try {
        afterSnapshot = JSON.stringify(this.runtimeState);
      } catch {
        afterSnapshot = "";
      }
      this.runtimeStateMigrationDirty = Boolean(beforeSnapshot && afterSnapshot && beforeSnapshot !== afterSnapshot);
      this.ensureRuntimeStateShape();
      markTransportModeMigrationIfNeeded(rawTransportMode);
      this.ensureModelCatalogState();
      return;
    }

    const rawTransportMode = extractRawTransportMode(raw.transportMode);
    this.settings = runtime.normalizeSettings(raw);
    this.runtimeState = runtime.migrateLegacyMessages({ sessions: [], activeSessionId: "", messagesBySession: {} });
    this.runtimeStateMigrationDirty = false;
    this.ensureRuntimeStateShape();
    markTransportModeMigrationIfNeeded(rawTransportMode);
    this.ensureModelCatalogState();
  },

  async saveSettings() {
    const runtime = this.ensureRuntimeModules();
    this.settings = runtime.normalizeSettings(this.settings);
    if (this.skillService) this.skillService.updateSettings(this.settings);
    if (this.opencodeClient) this.opencodeClient.updateSettings(this.settings);
    await this.persistState();
  },

  async persistState() {
    this.schemaVersion = RUNTIME_SCHEMA_VERSION;
    await this.saveData({
      schemaVersion: this.schemaVersion,
      settings: this.settings,
      runtimeState: this.runtimeState,
    });
  },

  async reloadSkills() {
    if (!this.skillService) return;
    const vaultPath = this.getVaultPath();
    const syncResult = this.syncBundledSkills(vaultPath, { force: true });
    this.log(
      `bundled skills reload: ${syncResult.synced || 0}/${syncResult.total || 0} ` +
      `source=${syncResult.bundledRoot || "unknown"} target=${syncResult.targetRoot || "unknown"}`,
    );
    if (syncResult.errors.length) this.log(`bundled skills sync: ${syncResult.errors.join("; ")}`);
    this.skillService.loadSkills();
    if (syncResult.stampUpdated) {
      try {
        await this.persistState();
      } catch (e) {
        this.log(`persist bundled skills stamp failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const view = this.getAssistantView();
    if (view) view.render();
    return syncResult;
  },

  async createSession(title) {
    const created = await this.opencodeClient.createSession(title || "");
    const sessionId = String(
      (created && (created.id || created.sessionID || created.sessionId))
      || (created && created.session && (created.session.id || created.session.sessionID || created.session.sessionId))
      || "",
    ).trim();
    if (!sessionId) {
      throw new Error("FLOWnote 创建会话失败：返回数据缺少会话 ID");
    }
    const session = {
      id: sessionId,
      title: created.title || title || "新会话",
      updatedAt: Date.now(),
    };

    if (this.runtimeState && Array.isArray(this.runtimeState.deletedSessionIds)) {
      this.runtimeState.deletedSessionIds = this.runtimeState.deletedSessionIds.filter((id) => id !== session.id);
    }

    this.sessionStore.upsertSession(session);
    await this.persistState();
    return session;
  },

  async deleteSession(sessionId) {
    if (!this.sessionStore || typeof this.sessionStore.removeSession !== "function") return false;
    const removed = this.sessionStore.removeSession(sessionId);
    if (!removed) return false;
    await this.persistState();
    return true;
  },

  normalizeRemoteSessionMessages(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const extractAssistantPayload = extractAssistantPayloadFromEnvelope;

    return list
      .map((item, index) => toLocalSessionMessage(item, index, extractAssistantPayload))
      .filter(Boolean)
      .sort((a, b) => {
        const at = Number(a.createdAt || 0);
        const bt = Number(b.createdAt || 0);
        if (at !== bt) return at - bt;
        return Number(a.__sortIndex || 0) - Number(b.__sortIndex || 0);
      })
      .map((item) => ({
        id: item.id,
        role: item.role,
        text: item.text,
        reasoning: item.reasoning,
        meta: item.meta,
        blocks: item.blocks,
        pending: false,
        error: item.error,
        createdAt: Number(item.createdAt || 0),
      }));
  },

  async ensureSessionMessagesLoaded(sessionId, options = {}) {
    const sid = String(sessionId || "").trim();
    if (!sid || !this.sessionStore || !this.opencodeClient) return false;

    const force = Boolean(options.force);
    const st = this.sessionStore.state();
    const currentMessages = Array.isArray(st.messagesBySession && st.messagesBySession[sid])
      ? st.messagesBySession[sid]
      : [];
    if (!force && currentMessages.length) return false;

    let remoteMessages = [];
    try {
      remoteMessages = await this.opencodeClient.listSessionMessages({
        sessionId: sid,
        limit: Number(options.limit || 200),
        signal: options.signal,
      });
    } catch (error) {
      this.log(`load session messages failed (${sid}): ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }

    const normalizedMessages = this.normalizeRemoteSessionMessages(remoteMessages);
    if (!normalizedMessages.length && !force) return false;
    return this.sessionStore.setSessionMessages(sid, normalizedMessages);
  },

  async syncSessionsFromRemote() {
    try {
      const st = this.sessionStore.state();
      const remote = await this.opencodeClient.listSessions();
      const deletedSet = new Set(
        Array.isArray(this.runtimeState && this.runtimeState.deletedSessionIds)
          ? this.runtimeState.deletedSessionIds
          : [],
      );
      let changed = false;
      remote.forEach((s) => {
        if (!s || deletedSet.has(s.id)) return;
        const nextSession = {
          id: s.id,
          title: s.title || "未命名会话",
          updatedAt: (s.time && s.time.updated) || Date.now(),
        };
        const existing = st.sessions.find((row) => row.id === nextSession.id);
        if (!existing) {
          changed = true;
        } else if (
          String(existing.title || "") !== String(nextSession.title || "")
          || Number(existing.updatedAt || 0) !== Number(nextSession.updatedAt || 0)
        ) {
          changed = true;
        }
        this.sessionStore.upsertSession({
          id: nextSession.id,
          title: nextSession.title,
          updatedAt: nextSession.updatedAt,
        });
      });

      if (!st.activeSessionId && st.sessions.length) {
        st.activeSessionId = st.sessions[0].id;
        changed = true;
      }
      if (changed) await this.persistState();
    } catch {
      // ignore bootstrap sync failure
    }
  },

  async bootstrapLocalData(options = {}) {
    if (this.bootstrapLocalDone && !options.force) return;

    try {
      this.loadModelCatalogFromTerminalOutput();
    } catch (e) {
      this.log(`load model cache failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const vaultPath = this.getVaultPath();
    const syncResult = this.syncBundledSkills(vaultPath, { force: Boolean(options.force) });
    if (!syncResult.errors.length && !syncResult.skipped) {
      this.log(
        `bundled skills bootstrap: ${syncResult.synced || 0}/${syncResult.total || 0} ` +
        `source=${syncResult.bundledRoot || "unknown"} target=${syncResult.targetRoot || "unknown"}`,
      );
    }
    if (syncResult.errors.length) this.log(`bundled skills bootstrap sync: ${syncResult.errors.join("; ")}`);
    this.skillService.loadSkills();
    this.bootstrapLocalDone = true;

    if (syncResult.stampUpdated) {
      try {
        await this.persistState();
      } catch (e) {
        this.log(`persist bundled skills stamp failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  },

  async runBootstrapRemote() {
    await this.refreshModelCatalog();
    await this.syncSessionsFromRemote();
    this.bootstrapRemoteDone = true;
    this.bootstrapRemoteAt = Date.now();
  },

  async bootstrapData(options = {}) {
    const force = Boolean(options && options.force);
    const waitRemote = Boolean(options && options.waitRemote);

    if (force) {
      this.bootstrapLocalDone = false;
      this.bootstrapRemoteDone = false;
    }

    await this.bootstrapLocalData({ force });

    const shouldStartRemote = force || !this.bootstrapRemoteDone;
    if (shouldStartRemote && !this.bootstrapInflight) {
      this.bootstrapInflight = (async () => {
        try {
          await this.runBootstrapRemote();
        } catch (e) {
          this.bootstrapRemoteDone = false;
          throw e;
        } finally {
          this.bootstrapInflight = null;
        }
      })().catch((e) => {
        this.log(`bootstrap remote failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });
    }

    if (waitRemote && this.bootstrapInflight) {
      await this.bootstrapInflight;
    }

    return {
      localDone: Boolean(this.bootstrapLocalDone),
      remoteDone: Boolean(this.bootstrapRemoteDone),
      remoteAt: Number(this.bootstrapRemoteAt || 0),
      remoteInflight: Boolean(this.bootstrapInflight),
    };
  },
};

module.exports = { sessionBootstrapMethods };
