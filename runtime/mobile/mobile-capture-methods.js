const { Notice } = require("obsidian");
const { tFromContext } = require("../i18n-runtime");
const { setRuntimeLocale } = require("../runtime-locale-state");
const { normalizeMobileSettings } = require("./mobile-settings-utils");
const { CaptureModal } = require("./capture-modal");
const { MobileSettingsTab } = require("./mobile-settings-tab");
const FLOWNOTE_ICON_ID = "flownote-journal-glow";

// Read the embedded bundled-skills index — we use it as the last-ditch
// fallback when the vault-side scan finds nothing (e.g. a fresh install
// where the user hasn't synced any skill folders yet).
const embeddedBundledSkillsModule = (() => {
  try { return require("../generated/bundled-skills-embedded"); } catch { return {}; }
})();
const EMBEDDED_BUNDLED_SKILLS_FILES =
  embeddedBundledSkillsModule && embeddedBundledSkillsModule.EMBEDDED_BUNDLED_SKILLS_FILES
    ? embeddedBundledSkillsModule.EMBEDDED_BUNDLED_SKILLS_FILES
    : {};

/**
 * Parse the YAML-ish frontmatter of an embedded SKILL.md and return
 * {name, description}. Cheap — we only need name + description for the
 * slash-command listing.
 */
function parseEmbeddedSkillFrontmatter(rawText) {
  const raw = String(rawText || "");
  if (!raw.startsWith("---")) return { name: "", description: "" };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { name: "", description: "" };
  const fmText = raw.slice(3, end).replace(/^\r?\n/, "");
  const out = { name: "", description: "" };
  for (const line of fmText.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key === "name") out.name = value;
    else if (key === "description") out.description = value;
  }
  return out;
}

/**
 * Synchronous skill list from the embedded bundle. Used as the initial
 * `__flownoteMobileSkillList` value so `/` autocomplete works the
 * moment the chat view opens, before any vault.adapter scan returns.
 */
function embeddedSkillListSync() {
  const seen = new Set();
  const out = [];
  for (const filePath of Object.keys(EMBEDDED_BUNDLED_SKILLS_FILES)) {
    if (!filePath.endsWith("/SKILL.md")) continue;
    const slug = filePath.split("/")[0];
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const { name, description } = parseEmbeddedSkillFrontmatter(
      EMBEDDED_BUNDLED_SKILLS_FILES[filePath],
    );
    out.push({ slug, name: name || slug, description: description || "" });
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

/**
 * Build the slash-command skill list for mobile. Walks the configured
 * skillsDir plus common FLOWnote/OpenCode/Claude skill roots AND
 * always merges the embedded bundle on top — vault wins when both
 * have a slug, embedded fills gaps.
 *
 * Why merge instead of "vault if any, else embedded": iOS Obsidian
 * Sync occasionally drops individual files inside a synced dotfolder
 * (notably the 2-char `ah/` directory). The vault scan returns 20
 * skills but is missing `ah`; a plain "fallback-only-if-empty" model
 * never injects it. Merging means the user sees every skill in the
 * popup AND the agent can `skill_invoke` any of them.
 */
async function loadMobileSkillList(plugin) {
  const tried = [];
  const bySlug = new Map();
  const addEntry = (entry) => {
    if (!entry) return;
    const slug = String(entry.slug || "").trim();
    if (!slug || bySlug.has(slug)) return;
    bySlug.set(slug, {
      slug,
      name: String(entry.name || slug),
      description: String(entry.description || ""),
    });
  };

  const { listSkills } = require("../settings/skill-management");

  const originalDir = plugin.settings && plugin.settings.skillsDir;
  const roots = dedupeSkillRoots([
    originalDir,
    ".flownote/skills",
    ".opencode/skills",
    ".claude/skills",
    "skills",
  ]);
  for (const root of roots) {
    try {
      if (plugin.settings) plugin.settings.skillsDir = root;
      const list = await listSkills(plugin);
      for (const item of list || []) addEntry(item);
      tried.push(`${root || "skillsDir"} → ${list ? list.length : 0}`);
    } catch (e) {
      tried.push(`${root || "skillsDir"} error: ${e && e.message ? e.message : e}`);
    } finally {
      if (plugin.settings) plugin.settings.skillsDir = originalDir;
    }
  }

  // Embedded bundle backfill — guarantees `/` autocomplete works
  //    on first launch AND patches over iOS Sync-dropped folders.
  let embeddedAdded = 0;
  for (const filePath of Object.keys(EMBEDDED_BUNDLED_SKILLS_FILES)) {
    if (!filePath.endsWith("/SKILL.md")) continue;
    const slug = filePath.split("/")[0];
    if (!slug || bySlug.has(slug)) continue;
    const { name, description } = parseEmbeddedSkillFrontmatter(
      EMBEDDED_BUNDLED_SKILLS_FILES[filePath],
    );
    addEntry({ slug, name: name || slug, description: description || "" });
    embeddedAdded += 1;
  }
  tried.push(`embedded backfill → +${embeddedAdded}`);

  const result = Array.from(bySlug.values()).sort((a, b) => a.slug.localeCompare(b.slug));
  if (typeof plugin.log === "function") {
    plugin.log(`[mobile] slash-command skill list loaded: ${result.length} (${tried.join("; ")})`);
  }
  return result;
}

function dedupeSkillRoots(roots) {
  const seen = new Set();
  return (roots || [])
    .map((root) => String(root || "").replace(/\\/g, "/").replace(/\/+$/, "").trim())
    .filter((root) => {
      if (!root || seen.has(root)) return false;
      seen.add(root);
      return true;
    });
}

// Mobile parity (2026-05-15+): direct-mode agent provider works on mobile
// because every tool we ship goes through vault.adapter rather than Node
// fs. We keep quick-capture as the lightweight entrypoint but also expose
// the full assistant view + commands + settings tab. The Node-only
// services (OpenCode CLI bridge, executable resolver / diagnostics, the
// fs-backed legacy SkillService) stay desktop-only; on mobile users get
// the direct-mode agent path.

const mobileCaptureMethodsMixin = {
  /**
   * Mobile onload — registers quick-capture AND the full assistant view
   * + commands + settings tab. Node-only services are skipped; the
   * direct-mode agent provider handles everything the UI exposes.
   */
  async onloadMobile() {
    const t = (key, fallback, params = {}) => tFromContext(this, key, fallback, params);

    // Stage 1: capture-only essentials + assistant entry. Register both
    // user-facing entrypoints FIRST so they're guaranteed to appear in
    // the mobile "more options" panel even if Stage 2 (full runtime
    // bootstrap) fails. Each callback lazy-checks whether the heavier
    // surface is ready and falls back gracefully.
    try {
      // Entry 1: quick capture into today's daily note.
      this.addRibbonIcon(
        FLOWNOTE_ICON_ID,
        t("commands.mobileQuickCapture", "快速捕获想法"),
        () => { this.openCaptureModal(); },
      );
      this.addCommand({
        id: "mobile-quick-capture",
        name: t("commands.mobileQuickCapture", "快速捕获想法"),
        callback: () => { this.openCaptureModal(); },
      });

      // Entry 2: full FLOWnote assistant (chat view). Distinct icon +
      // label so users see two clearly separate options in the more menu.
      this.addRibbonIcon(
        "messages-square",
        t("commands.openMobileAssistant", "FLOWnote 助手"),
        () => { void this.activateMobileAssistantView(); },
      );
      this.addCommand({
        id: "flownote-open-assistant",
        name: t("commands.openMobileAssistant", "FLOWnote 助手"),
        callback: () => { void this.activateMobileAssistantView(); },
      });
    } catch (e) {
      // If even ribbon/command registration throws, surface it once.
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[FLOWnote] mobile capture registration failed", e);
      new Notice(t("notices.mobileLoadFailed", "FLOWnote 移动端加载失败: {message}", { message: msg }));
      return;
    }

    // Stage 2: full assistant. Best-effort — if the full runtime can't
    // load on this device (older Obsidian build missing an export, etc),
    // fall back to the legacy mobile settings tab so the user still has
    // somewhere to configure quick-capture.
    let fullRuntimeOk = false;
    try {
      this.ensureFacadeMethodsLoaded();
      await this.loadPersistedData();
      await this.bootstrapMobileFullRuntime();
      fullRuntimeOk = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[FLOWnote] mobile full-runtime bootstrap failed", e);
      if (typeof this.log === "function") {
        this.log(`mobile full-runtime bootstrap failed: ${msg}`);
      }
    }

    if (!fullRuntimeOk) {
      // Recover: hydrate settings via the mobile-only shim (bypasses
      // ensureRuntimeModules, which is what just blew up) and register
      // the legacy MobileSettingsTab so quick-capture stays configurable.
      try {
        const raw = (await this.loadData()) || {};
        this.settings = normalizeMobileSettings(raw.settings || raw || {});
        setRuntimeLocale(typeof this.getEffectiveLocale === "function"
          ? this.getEffectiveLocale() : "en");
        this.addSettingTab(new MobileSettingsTab(this.app, this));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[FLOWnote] mobile fallback settings tab failed", e);
        if (typeof this.log === "function") {
          this.log(`mobile fallback settings tab failed: ${msg}`);
        }
      }
    }
  },

  /**
   * Initialize the cross-platform pieces of the assistant on mobile:
   *  - skill-dir migration (vault.adapter, portable)
   *  - SessionStore (vault.adapter, portable)
   *  - Assistant view registration
   *  - Open/new-session/send-selected-text commands
   *  - Full settings tab (FLOWnoteSettingsTab; mobile-only fields still
   *    render because they live in basicSettingsSection)
   *
   * Skipped because they need Node:
   *  - SkillService (legacy fs scanner — agent-side SkillRegistry covers it)
   *  - FLOWnoteClient (OpenCode CLI bridge — direct mode bypasses)
   *  - DiagnosticsService (executable resolver via child_process)
   *  - bundled-skills sync (fs-based; templates are still readable from
   *    the embedded bundle on mobile)
   */
  async bootstrapMobileFullRuntime() {
    const runtime = this.ensureRuntimeModules();
    setRuntimeLocale(this.getEffectiveLocale());

    if (typeof runtime.migrateSkillDir === "function") {
      try { await runtime.migrateSkillDir(this); } catch { /* non-fatal */ }
    }

    this.sessionStore = new runtime.SessionStore(this);

    // Pre-warm the slash-command skill list. Two-phase: a SYNCHRONOUS
    // first pass from the embedded bundle (guarantees `/` autocomplete
    // works the moment the chat view opens, even before the async vault
    // scan finishes) and an ASYNC refresh that picks up the user's real
    // skill folders. The refresh result wins when it's non-empty.
    this.__flownoteMobileSkillList = embeddedSkillListSync();
    void loadMobileSkillList(this).then((real) => {
      if (Array.isArray(real) && real.length) {
        this.__flownoteMobileSkillList = real;
      }
    }).catch(() => { /* keep embedded fallback */ });

    this.registerView(this.getViewType(), (leaf) => new runtime.FLOWnoteAssistantView(leaf, this));

    this.addCommand({
      id: "flownote-send-selected-text",
      name: this.t("commands.sendSelectedText"),
      editorCallback: async (editor) => {
        const text = editor.getSelection().trim();
        if (!text) { new Notice(this.t("notices.pickTextFirst")); return; }
        await this.activateView();
        const view = this.getAssistantView();
        if (view) await view.sendPrompt(text);
      },
    });

    this.addCommand({
      id: "flownote-new-session",
      name: this.t("commands.newSession"),
      callback: async () => {
        const session = await this.createSession("");
        this.sessionStore.setActiveSession(session.id);
        await this.persistState();
        const view = this.getAssistantView();
        if (view) view.render();
      },
    });

    this.addSettingTab(new runtime.FLOWnoteSettingsTab(this.app, this));
    if (typeof this.showAgentModeNoticeIfNeeded === "function") {
      this.showAgentModeNoticeIfNeeded();
    }
  },

  /**
   * Mobile entrypoint: open the chat / assistant view. Stage 1 may have
   * registered this ribbon before Stage 2 finished — if the runtime
   * isn't ready yet, do a one-shot lazy bootstrap, then activate.
   */
  async activateMobileAssistantView() {
    const t = (key, fallback, params = {}) => tFromContext(this, key, fallback, params);
    try {
      if (!this.sessionStore || typeof this.activateView !== "function") {
        // Stage 2 hasn't finished (or failed earlier). Try once more.
        if (typeof this.ensureFacadeMethodsLoaded === "function") {
          this.ensureFacadeMethodsLoaded();
        }
        if (typeof this.loadPersistedData === "function") {
          await this.loadPersistedData();
        }
        if (typeof this.bootstrapMobileFullRuntime === "function") {
          await this.bootstrapMobileFullRuntime();
        }
      }
      if (typeof this.activateView === "function") {
        await this.activateView();
        return;
      }
      new Notice(t(
        "notices.mobileAssistantUnavailable",
        "FLOWnote 助手在此设备上暂不可用。请检查日志后重试。",
      ));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[FLOWnote] mobile activateMobileAssistantView failed", e);
      new Notice(t(
        "notices.mobileAssistantOpenFailed",
        "无法打开 FLOWnote 助手：{message}",
        { message: msg },
      ));
    }
  },

  /**
   * Open the capture modal.
   */
  openCaptureModal() {
    new CaptureModal(this.app, this).open();
  },

  /**
   * Back-compat shim — older code paths still call this. Delegates to
   * the shared loadPersistedData / saveSettings now that mobile shares
   * the desktop settings schema.
   */
  async loadMobilePersistedData() {
    if (typeof this.loadPersistedData === "function") {
      return this.loadPersistedData();
    }
    const raw = await this.loadData();
    const data = raw && typeof raw === "object" ? raw : {};
    this.settings = normalizeMobileSettings(data.settings || {});
    setRuntimeLocale(typeof this.getEffectiveLocale === "function" ? this.getEffectiveLocale() : "en");
  },

  async saveMobileSettings() {
    if (typeof this.persistState === "function") {
      await this.persistState();
      setRuntimeLocale(this.getEffectiveLocale());
      return;
    }
    const raw = (await this.loadData()) || {};
    raw.settings = this.settings;
    await this.saveData(raw);
    setRuntimeLocale(typeof this.getEffectiveLocale === "function" ? this.getEffectiveLocale() : "en");
  },
};

module.exports = { mobileCaptureMethodsMixin };
