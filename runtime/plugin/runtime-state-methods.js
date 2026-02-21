const runtimeStateMethods = {
  ensureRuntimeStateShape() {
    if (!this.runtimeState || typeof this.runtimeState !== "object") {
      this.runtimeState = {};
    }
    if (!Array.isArray(this.runtimeState.deletedSessionIds)) this.runtimeState.deletedSessionIds = [];
    this.runtimeState.lastLaunchProfile = this.normalizeLaunchProfile(this.runtimeState.lastLaunchProfile);
  },

  normalizeLaunchProfile(profile) {
    if (!profile || typeof profile !== "object") return null;
    const mode = String(profile.mode || "").trim().toLowerCase() === "wsl" ? "wsl" : "native";
    const command = String(profile.command || "").trim();
    const shell = Boolean(profile.shell);
    const distro = String(profile.distro || "").trim();
    const args = Array.isArray(profile.args)
      ? profile.args.map((item) => String(item || ""))
      : [];
    if (mode === "native" && !command) return null;
    return {
      mode,
      command,
      args,
      shell,
      distro,
      at: Number(profile.at || Date.now()),
    };
  },

  getPreferredLaunchProfile() {
    if (String(this.settings && this.settings.launchStrategy ? this.settings.launchStrategy : "auto") !== "auto") {
      return null;
    }
    this.ensureRuntimeStateShape();
    return this.normalizeLaunchProfile(this.runtimeState.lastLaunchProfile);
  },

  rememberLaunchProfile(profile) {
    const normalized = this.normalizeLaunchProfile(profile);
    if (!normalized) return;
    this.ensureRuntimeStateShape();

    const current = this.normalizeLaunchProfile(this.runtimeState.lastLaunchProfile);
    if (
      current &&
      current.mode === normalized.mode &&
      current.command === normalized.command &&
      JSON.stringify(current.args || []) === JSON.stringify(normalized.args || []) &&
      Boolean(current.shell) === Boolean(normalized.shell) &&
      current.distro === normalized.distro
    ) {
      return;
    }

    this.runtimeState.lastLaunchProfile = {
      ...normalized,
      at: Date.now(),
    };
    void this.persistState().catch((e) => {
      this.log(`persist launch profile failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  },

  async clearRememberedLaunchProfile() {
    this.ensureRuntimeStateShape();
    if (!this.runtimeState.lastLaunchProfile) return;
    this.runtimeState.lastLaunchProfile = null;
    await this.persistState();
  },
};

module.exports = { runtimeStateMethods };
