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

    if (raw.settings || raw.runtimeState) {
      this.settings = runtime.normalizeSettings(raw.settings || {});
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
      return;
    }

    this.settings = runtime.normalizeSettings(raw);
    this.runtimeState = runtime.migrateLegacyMessages({ sessions: [], activeSessionId: "", messagesBySession: {} });
    this.runtimeStateMigrationDirty = false;
    this.ensureRuntimeStateShape();
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
    await this.saveData({ settings: this.settings, runtimeState: this.runtimeState });
  },

  async reloadSkills() {
    if (!this.skillService) return;
    const vaultPath = this.getVaultPath();
    const syncResult = this.syncBundledSkills(vaultPath, { force: true });
    console.log(
      `[opencode-assistant] bundled skills reload: ${syncResult.synced || 0}/${syncResult.total || 0} ` +
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
    const session = {
      id: created.id,
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
      console.log(
        `[opencode-assistant] bundled skills bootstrap: ${syncResult.synced || 0}/${syncResult.total || 0} ` +
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
