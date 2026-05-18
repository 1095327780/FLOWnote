const {
  extractAssistantPayloadFromEnvelope,
} = require("../assistant-payload-utils");
const {
  getAgentModeNotice,
  hasPersistedPluginData,
  markAgentModeNoticeSeen,
} = require("../release-notice");

const RUNTIME_SCHEMA_VERSION = 1;

/**
 * Returns true iff `leaf` lives inside Obsidian's main editor area
 * (workspace.rootSplit) rather than a left/right sidebar.
 *
 * Walks up the leaf's parent chain until we hit one of the workspace
 * roots; matching `rootSplit` means main area. This is the official
 * way to distinguish "tab area" leaves from sidebar leaves (see
 * Obsidian's "Tabs and Splits" docs).
 */
function isLeafInMainArea(workspace, leaf) {
  if (!leaf || !workspace) return false;
  let cursor = leaf;
  // `leaf.getRoot?.()` is the most direct shortcut; fall back to a
  // parent walk for older Obsidian versions that don't expose it.
  if (typeof leaf.getRoot === "function") {
    const root = leaf.getRoot();
    return root === workspace.rootSplit;
  }
  while (cursor && cursor.parent) {
    cursor = cursor.parent;
    if (cursor === workspace.rootSplit) return true;
    if (cursor === workspace.leftSplit || cursor === workspace.rightSplit) return false;
  }
  return false;
}

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
    let isMobile = false;
    try { isMobile = require("obsidian").Platform && require("obsidian").Platform.isMobile; } catch { /* desktop */ }
    const viewType = this.getViewType();
    const workspace = this.app.workspace;

    if (isMobile) {
      // Mobile full-screen pattern (per Obsidian docs: leaves opened in
      // the main "rootSplit" area get the same tab chrome as notes; the
      // left/right sidebar leaves render as slide-in drawers and are NOT
      // full-screen). Strategy:
      //   1. Detach any saved leaves that landed in the sidebar from a
      //      previous desktop layout — otherwise revealLeaf below will
      //      re-pin to that sidebar slot.
      //   2. Reuse a main-area leaf if one exists; otherwise create a
      //      fresh tab via workspace.getLeaf("tab"). This is the exact
      //      pattern Obsidian's docs recommend for "open a custom view
      //      like a note tab" (Tasks Calendar, Thino, etc.).
      const existing = workspace.getLeavesOfType(viewType);
      let mainLeaf = null;
      for (const leaf of existing) {
        const inMainArea = isLeafInMainArea(workspace, leaf);
        if (inMainArea && !mainLeaf) {
          mainLeaf = leaf;
        } else {
          // Sidebar (or stale) leaf — detach so it doesn't compete.
          try { leaf.detach(); } catch { /* ignore */ }
        }
      }
      if (!mainLeaf) {
        mainLeaf = workspace.getLeaf("tab");
        await mainLeaf.setViewState({ type: viewType, active: true });
      }
      await workspace.revealLeaf(mainLeaf);
    } else {
      // Desktop: right sidebar (so the chat sits alongside the note).
      const leaves = workspace.getLeavesOfType(viewType);
      if (leaves.length) {
        await workspace.revealLeaf(leaves[0]);
      } else {
        const leaf = workspace.getRightLeaf(false);
        await leaf.setViewState({ type: viewType, active: true });
        await workspace.revealLeaf(leaf);
      }
    }

    void this.bootstrapData({ waitRemote: false, startRemote: true }).catch((e) => {
      this.log(`activate view bootstrap failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    void this.refreshDiagnosticsStatus({ ttlMs: 10_000, force: false, applyView: true });
  },

  async refreshDiagnosticsStatus(options = {}) {
    const service = this.diagnosticsService;
    if (!service || typeof service.runCached !== "function") return null;

    const ttlMs = Math.max(0, Number(options.ttlMs || 10_000));
    const force = Boolean(options.force);
    let result = null;
    try {
      result = await service.runCached(ttlMs, force);
    } catch (e) {
      this.log(`refresh diagnostics failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }

    const applyView = options.applyView !== false;
    if (applyView) {
      const view = this.getAssistantView();
      if (view && typeof view.applyStatus === "function") {
        view.applyStatus(result);
      }
    }
    return result;
  },

  async loadPersistedData() {
    const runtime = this.ensureRuntimeModules();
    const raw = (await this.loadData()) || {};
    const existingInstall = hasPersistedPluginData(raw);
    const rawSchemaVersion = Number(raw && raw.schemaVersion ? raw.schemaVersion : 0);
    this.schemaVersion = Number.isFinite(rawSchemaVersion) && rawSchemaVersion > 0
      ? Math.floor(rawSchemaVersion)
      : RUNTIME_SCHEMA_VERSION;

    if (raw.settings || raw.runtimeState) {
      const rawSettings = raw.settings || {};
      this.settings = runtime.normalizeSettings(rawSettings, { existingInstall });
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
      this.ensureModelCatalogState();
      this.agentModeNotice = getAgentModeNotice(this.runtimeState, {
        existingInstall,
        version: this.manifest && this.manifest.version,
      });
      return;
    }

    this.settings = runtime.normalizeSettings(raw, { existingInstall });
    this.runtimeState = runtime.migrateLegacyMessages({ sessions: [], activeSessionId: "", messagesBySession: {} });
    this.runtimeStateMigrationDirty = false;
    this.ensureRuntimeStateShape();
    this.ensureModelCatalogState();
    this.agentModeNotice = getAgentModeNotice(this.runtimeState, {
      existingInstall,
      version: this.manifest && this.manifest.version,
    });
  },

  async saveSettings() {
    const runtime = this.ensureRuntimeModules();
    this.settings = typeof runtime.normalizeSettingsInPlace === "function"
      ? runtime.normalizeSettingsInPlace(this.settings)
      : runtime.normalizeSettings(this.settings);
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

  showAgentModeNoticeIfNeeded() {
    const notice = this.agentModeNotice;
    if (!notice || !notice.version) return;
    if (typeof window === "undefined" || typeof window.setTimeout !== "function") return;

    this.agentModeNotice = null;
    window.setTimeout(() => {
      try {
        const { AgentModeNoticeModal } = require("../modals");
        const modal = new AgentModeNoticeModal(
          this.app,
          {
            ...notice,
            currentMode: this.settings && this.settings.agentProvider
              ? this.settings.agentProvider.mode
              : "",
          },
          (choice) => {
            markAgentModeNoticeSeen(this.runtimeState, notice.version);
            void this.persistState().catch((e) => {
              this.log(`persist agent mode notice failed: ${e instanceof Error ? e.message : String(e)}`);
            });
            if (choice === "settings") {
              try {
                if (this.app && this.app.setting && typeof this.app.setting.open === "function") {
                  this.app.setting.open();
                  if (typeof this.app.setting.openTabById === "function") {
                    this.app.setting.openTabById(this.manifest.id);
                  }
                }
              } catch (e) {
                this.log(`open settings from notice failed: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
          },
          this.t.bind(this),
        );
        modal.open();
      } catch (e) {
        this.log(`show agent mode notice failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }, 500);
  },

  async reloadSkills(options = {}) {
    if (!this.skillService) return null;
    const vaultPath = this.getVaultPath();
    const locale = String(
      options && options.locale
        ? options.locale
        : (typeof this.getEffectiveLocale === "function" ? this.getEffectiveLocale() : "en"),
    ).trim() || "en";
    const syncResult = await this.syncBundledContent(vaultPath, {
      force: Object.prototype.hasOwnProperty.call(options, "force") ? Boolean(options.force) : true,
      syncTemplates: Object.prototype.hasOwnProperty.call(options, "syncTemplates")
        ? Boolean(options.syncTemplates)
        : true,
      locale,
      resolveConflict: typeof options.resolveConflict === "function" ? options.resolveConflict : null,
      defaultConflictAction: String(options.defaultConflictAction || "replace"),
      backupDir: options.backupDir,
    });

    this.log(
      `bundled content reload: skills=${syncResult.synced || 0}/${syncResult.total || 0}, ` +
      `templates=${syncResult.syncedTemplates || 0}/${syncResult.totalTemplates || 0}, ` +
      `source=${syncResult.bundledRoot || "unknown"} target=${syncResult.targetRoot || "unknown"}`,
    );
    if (syncResult.errors.length) this.log(`bundled content sync: ${syncResult.errors.join("; ")}`);
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

  async resetTemplateBaseline(options = {}) {
    const vaultPath = this.getVaultPath();
    const locale = String(
      options && options.locale
        ? options.locale
        : (typeof this.getEffectiveLocale === "function" ? this.getEffectiveLocale() : "en"),
    ).trim() || "en";
    return this.resetMetaTemplateBaseline(vaultPath, {
      locale,
      resolveConflict: typeof options.resolveConflict === "function" ? options.resolveConflict : null,
      defaultConflictAction: String(options.defaultConflictAction || "skip"),
      backupDir: options.backupDir,
    });
  },

  async createSession(title) {
    // Direct mode (and mobile, which always uses direct) doesn't have a
    // remote session backend — generate a local ID.
    const mode = this.settings
      && this.settings.agentProvider
      && this.settings.agentProvider.mode;
    const useDirect = mode === "direct" || !this.opencodeClient;
    let sessionId = "";
    let createdTitle = "";
    if (useDirect) {
      sessionId = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    } else {
      const created = await this.opencodeClient.createSession(title || "");
      sessionId = String(
        (created && (created.id || created.sessionID || created.sessionId))
        || (created && created.session && (created.session.id || created.session.sessionID || created.session.sessionId))
        || "",
      ).trim();
      createdTitle = String((created && created.title) || "").trim();
    }
    if (!sessionId) {
      throw new Error("FLOWnote 创建会话失败：返回数据缺少会话 ID");
    }
    const session = {
      id: sessionId,
      title: createdTitle || title || "新会话",
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

    // Mobile (or any environment without fs-backed services): skip the
    // bundled-skills sync + legacy SkillService load. Templates are
    // still served from the embedded bundle via template-management.js,
    // and skills are discovered by the agent-side SkillRegistry (vault
    // adapter) on demand.
    let vaultPath = "";
    try { vaultPath = this.getVaultPath(); } catch { vaultPath = ""; }
    if (!vaultPath || !this.skillService) {
      this.bootstrapLocalDone = true;
      return;
    }
    const locale = String(
      options && options.locale
        ? options.locale
        : (typeof this.getEffectiveLocale === "function" ? this.getEffectiveLocale() : "en"),
    ).trim() || "en";
    const syncResult = await this.syncBundledContent(vaultPath, {
      force: Boolean(options.force),
      syncTemplates: true,
      locale,
      defaultConflictAction: "replace",
    });
    if (!syncResult.errors.length && !syncResult.skipped) {
      this.log(
        `bundled content bootstrap: skills=${syncResult.synced || 0}/${syncResult.total || 0}, ` +
        `templates=${syncResult.syncedTemplates || 0}/${syncResult.totalTemplates || 0}, ` +
        `source=${syncResult.bundledRoot || "unknown"} target=${syncResult.targetRoot || "unknown"}`,
      );
    }
    if (syncResult.errors.length) this.log(`bundled content bootstrap sync: ${syncResult.errors.join("; ")}`);
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
    // No OpenCode bridge (mobile, or desktop running in direct mode
    // before any OpenCode-only init): the remote model catalog + remote
    // session sync don't apply. Refresh the model catalog via the
    // direct-mode provider so the model picker still has something
    // to show, but skip the remote session pull.
    if (!this.opencodeClient) {
      if (typeof this.refreshModelCatalog === "function") {
        try { await this.refreshModelCatalog(); } catch { /* non-fatal */ }
      }
      this.bootstrapRemoteDone = true;
      this.bootstrapRemoteAt = Date.now();
      return;
    }
    await this.refreshModelCatalog();
    await this.syncSessionsFromRemote();
    this.bootstrapRemoteDone = true;
    this.bootstrapRemoteAt = Date.now();
  },

  async bootstrapData(options = {}) {
    const force = Boolean(options && options.force);
    const waitRemote = Boolean(options && options.waitRemote);
    const startRemote = Object.prototype.hasOwnProperty.call(options || {}, "startRemote")
      ? Boolean(options.startRemote)
      : true;

    if (force) {
      this.bootstrapLocalDone = false;
      this.bootstrapRemoteDone = false;
    }

    await this.bootstrapLocalData({ force });

    const shouldStartRemote = startRemote && (force || !this.bootstrapRemoteDone);
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
      remoteSkipped: !startRemote,
    };
  },
};

module.exports = { sessionBootstrapMethods };
