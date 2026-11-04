// Bridge: agent loop + Obsidian Vault → existing chat view handlers.
// UI updates flow through chat-orchestrator callbacks; this file does not touch the DOM.
const { runAgentLoop } = require("../agent/agent-loop");
const { DirectExecutionJournal } = require("./direct-execution-journal");
const { collectUnresolvedEffectAttempts } = require("../agent/execution-ledger");
const { projectCheckpointRef } = require("../agent/durable-execution-projection");
const { buildAnthropicHistory } = require("./history-builder");
const { prepareContinuationContext, buildSuspensionCopy } = require("./direct-continuation-context");
const {
  createContinuationCheckpointStore,
  continuationStoreUnavailableError,
} = require("./direct-checkpoint-lifecycle");
const { createDirectActivityTimeline } = require("./direct-activity-timeline");
const { createDirectUsageAccumulator } = require("./direct-response-stats");
const { meterProvider } = require("./metered-provider");
const { resolveWorkflowUsageId, workflowUsageSummary } = require("./workflow-usage");
const { seedLinkedEvidence } = require("./linked-evidence");
const { buildTurnTimeContext } = require("./direct-turn-context");
const { buildTurnChangeBlock } = require("./turn-change-block");
const { EXECUTION_FALLBACK_COPY, createExplicitSkillWorkflowContract } = require("../agent/execution-contract");
const { createVaultChangeRecorder, describeChanges } = require("../agent/vault-change-recorder");
const { runTurnAudit, evaluateTurnReport, buildHostCheckMessage } = require("../agent/turn-audit");
const { ToolRegistry } = require("../agent/tool-registry");
const { createVaultReadTool } = require("../agent/tools/vault-read");
const { createVaultWriteTool } = require("../agent/tools/vault-write");
const { createVaultEditTool } = require("../agent/tools/vault-edit");
const { createVaultListTool } = require("../agent/tools/vault-list");
const { createVaultSearchTool } = require("../agent/tools/vault-search");
const { createCardPrepareTool } = require("../agent/tools/card-prepare");
const { createCardCommitTool } = require("../agent/tools/card-commit");
const { createCardExpandToolsTool } = require("../agent/card-tool-surface");
const { createVaultDailyTool } = require("../agent/tools/vault-daily");
const { createVaultPropertyTool } = require("../agent/tools/vault-property");
const { createVaultBacklinksTool } = require("../agent/tools/vault-backlinks");
const { createVaultTasksTool } = require("../agent/tools/vault-tasks");
const { createVaultTagsTool } = require("../agent/tools/vault-tags");
const { createVaultMoveTool } = require("../agent/tools/vault-move");
const { createVaultCreateDirTool } = require("../agent/tools/vault-create-dir");
const { createVaultGetActiveFileTool } = require("../agent/tools/vault-get-active-file");
const { createWebFetchTool } = require("../agent/tools/web-fetch");
const { createWebRequestTool } = require("../agent/tools/web-request");
const { createAskUserTool } = require("../agent/tools/ask-user");
const { createSkillInvokeTool } = require("../agent/tools/skill-invoke");
const { createSkillResourceReadTool } = require("../agent/tools/skill-resource-read");
const {
  loadSkills, formatSkillListing, SkillRegistry, parseFrontmatter,
  buildSkillManifest, normalizeResourcePaths, substituteArguments, renderSkillTemplateVariables,
} = require("../agent/skill-registry");
const { skillIdentityKeys } = require("../skill-catalog");
const { getSkillDocLocale } = require("../localized-defaults");
const { formatNotePathOverrides } = require("./note-path-context");

// Embedded fallback for devices where synced dotfolders are absent.
const {
  EMBEDDED_BUNDLED_SKILLS_FILES,
  getEmbeddedSkillDocument,
} = require("../embedded-skill-documents");
const { resolveAgentProvider } = require("../agent/agent-provider-resolver");
const { getActiveApiKey } = require("../agent/agent-settings");
const { getEffectiveAgentMode } = require("../agent/agent-mode");
const { getProviderSpec } = require("../providers/registry");
const { getIntlLocale, normalizeSupportedLocale, materializeLocalizedMarkdownFiles } = require("../i18n-locale-utils");
const {
  DEFAULT_NOTE_PATHS_ZH, DEFAULT_NOTE_PATHS_EN, DEFAULT_NOTE_PATHS_RU,
  DEFAULT_META_PATHS_ZH, DEFAULT_META_PATHS_EN, DEFAULT_META_PATHS_RU,
  getDefaultNotePathsByLocale, getDefaultMetaPathsByLocale, normalizeNotePaths, normalizeMetaPaths,
} = require("../settings-utils");
const { BASE_SYSTEM_PROMPT } = require("./direct-agent-system-prompt");
const { addEmbeddedTemplateAliases, addEmbeddedTemplateVaultOverrides } = require("./embedded-skill-templates");
const DEFAULT_SKILL_ROOT = ".opencode/skills";
const SUPPLEMENTAL_SKILL_ROOTS = [
  ".flownote/skills",
  ".opencode/skills",
  ".claude/skills",
  "skills",
];
const pad2 = (value) => String(value).padStart(2, "0");

const { resolveMainTurnTokenBudget } = require("./direct-request-budget");

// User-local calendar date for daily and weekly note workflows.
function getLocalISODate(now) {
  const d = now instanceof Date ? now : new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function getLocalHHmm(now) {
  const d = now instanceof Date ? now : new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
const ZH_WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

function describeToday(now, locale = "zh-CN") {
  const d = now instanceof Date ? now : new Date();
  const normalizedLocale = normalizeSupportedLocale(locale, "en");
  const weekday = normalizedLocale === "zh-CN"
    ? `星期${ZH_WEEKDAY[d.getDay()]}`
    : d.toLocaleDateString(getIntlLocale(normalizedLocale), { weekday: "long" });
  return `${getLocalISODate(d)} (${weekday})`;
}

function describeCurrentDateTime(now, locale = "zh-CN") {
  const d = now instanceof Date ? now : new Date();
  return `${describeToday(d, locale)} ${getLocalHHmm(d)}`;
}

function runnerText(locale, zh, en, ru) {
  const normalizedLocale = normalizeSupportedLocale(locale, "en");
  if (normalizedLocale === "zh-CN") return zh;
  if (normalizedLocale === "ru") return ru || en;
  return en;
}

function assistantTextFromContent(content) {
  return (Array.isArray(content) ? content : [])
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
}

function getRunnerLocale(owner) {
  const plugin = owner && owner.plugin ? owner.plugin : owner;
  if (plugin && typeof plugin.getEffectiveLocale === "function") {
    return normalizeSupportedLocale(plugin.getEffectiveLocale(), "en");
  }
  const settings = plugin && plugin.settings ? plugin.settings : {};
  return normalizeSupportedLocale(settings.uiLanguage, "en");
}

function describeOutputLanguage(locale) {
  const normalizedLocale = normalizeSupportedLocale(locale, "en");
  if (normalizedLocale === "zh-CN") return { label: "Simplified Chinese", instruction: "用简体中文输出。" };
  if (normalizedLocale === "ru") {
    return {
      label: "Russian",
      instruction: [
        "Reply and write user-facing note content in Russian unless the user explicitly asks for another language.",
        "Bundled skill instructions may be written in Chinese or English; follow their workflow, but translate user-facing output.",
        "Do not translate file paths, tool names, code, frontmatter keys, or quoted source text unless the user asks.",
      ].join(" "),
    };
  }
  return { label: "English", instruction: "Reply and write user-facing note content in English unless the user explicitly asks for another language." };
}

function buildSystemPrompt(skillManifests, opts) {
  const parts = [BASE_SYSTEM_PROMPT];
  const ctxLines = [];
  const locale = normalizeSupportedLocale(opts && opts.locale, "en");
  if (opts && opts.outputLocale) {
    const outputLanguage = describeOutputLanguage(opts.outputLocale);
    ctxLines.push(`# outputLanguage\nUI language: ${outputLanguage.label}. ${outputLanguage.instruction}`);
  }
  if (opts && typeof opts.vaultName === "string" && opts.vaultName) {
    ctxLines.push(runnerText(
      locale,
      `# vault\n当前 Obsidian 库名：${opts.vaultName}`,
      `# vault\nCurrent Obsidian vault: ${opts.vaultName}`,
    ));
  }
  if (ctxLines.length > 0) {
    parts.push(`Context:\n${ctxLines.join("\n\n")}`);
  }
  // Note path overrides — the user has configured which folders each
  // note kind lives in. The bundled SKILL.md files reference defaults
  // like `01-捕获层/每日笔记/` inline; this block tells the model to
  // treat those as DEFAULTS and prefer the user's configured paths.
  const notePathBlock = formatNotePathOverrides(opts && opts.notePaths, opts && opts.outputLocale);
  if (notePathBlock) parts.push(notePathBlock);

  const listing = formatSkillListing(skillManifests);
  if (listing) {
    parts.push(`Available skills (call via skill_invoke):\n${listing}`);
  }
  return parts.join("\n\n");
}

/** Build the direct agent's Obsidian, web, user-input, and Skill tools. */
function buildDefaultToolRegistry(app, normalizePath, skillRegistry, plugin, now = new Date(), { includeCardTools = false } = {}) {
  const registry = new ToolRegistry();
  if (app && app.vault) {
    registry.register(createVaultReadTool({ vault: app.vault, normalizePath }));
    registry.register(createVaultListTool({ vault: app.vault, normalizePath }));
    registry.register(createVaultSearchTool({ vault: app.vault, normalizePath }));
    registry.register(createVaultEditTool({ vault: app.vault, normalizePath }));
    registry.register(createVaultWriteTool({ vault: app.vault, normalizePath }));
    if (includeCardTools) {
      const variables = buildSkillTemplateVariables(plugin, now);
      registry.register(createCardPrepareTool({ vault: app.vault, normalizePath, paths: {
        ...variables.notePaths, statusPath: `${variables.metaPaths.memory}/STATUS.md`,
      } }));
      if (typeof app.vault.process === "function") registry.register(createCardCommitTool({ vault: app.vault }));
      registry.register(createCardExpandToolsTool());
    }
    // Obsidian-native tools — replace the operations the old skills used
    // to delegate to `obsidian-cli`. Each one is gated on the relevant
    // app sub-API existing, so we degrade gracefully on minimal vault
    // mocks (tests) or older Obsidian versions.
    registry.register(createVaultDailyTool({ app, normalizePath }));
    if (app.fileManager && typeof app.fileManager.processFrontMatter === "function") {
      registry.register(createVaultPropertyTool({ app, normalizePath }));
    }
    if (app.metadataCache) {
      registry.register(createVaultBacklinksTool({ app, normalizePath }));
      if (typeof app.metadataCache.getFileCache === "function") {
        registry.register(createVaultTasksTool({ app, normalizePath }));
      }
      registry.register(createVaultTagsTool({ app }));
    }
    if (
      typeof app.vault.getAbstractFileByPath === "function" &&
      app.fileManager &&
      typeof app.fileManager.renameFile === "function"
    ) {
      registry.register(createVaultMoveTool({ app, normalizePath }));
    }
    if (typeof app.vault.createFolder === "function" && typeof app.vault.getAbstractFileByPath === "function") {
      registry.register(createVaultCreateDirTool({ app, normalizePath }));
    }
    if (app.workspace && typeof app.workspace.getActiveFile === "function") {
      registry.register(createVaultGetActiveFileTool({ app }));
    }
  }
  // web_fetch — Obsidian's requestUrl bypasses CORS on desktop and uses
  // the platform HTTP client on mobile. No third-party API key required.
  try {
    const obsidian = require("obsidian");
    if (obsidian && typeof obsidian.requestUrl === "function") {
      registry.register(createWebFetchTool({ requestUrl: obsidian.requestUrl }));
      registry.register(createWebRequestTool({
        requestUrl: obsidian.requestUrl,
        getSecrets: () => (plugin && plugin.settings && plugin.settings.skillSecrets) || {},
      }));
    }
  } catch (_e) {
    // obsidian module unavailable (test harness etc) — skip silently.
  }
  registry.register(createAskUserTool());
  if (skillRegistry && typeof skillRegistry.list === "function") {
    const skillTemplateVariables = buildSkillTemplateVariables(plugin, now);
    registry.register(createSkillInvokeTool({ skillRegistry, skillTemplateVariables }));
    if (app && app.vault) {
      registry.register(createSkillResourceReadTool({ skillRegistry, vault: app.vault, skillTemplateVariables }));
    }
  }
  return registry;
}

/**
 * Resolve where SKILL.md files live. The configured path stays first so a
 * user override wins, then we supplement with common Claude/OpenCode/FLOWnote
 * locations. This is intentionally vault-relative so it works on mobile.
 *
 * @param {Object} plugin
 * @returns {string}
 */
function resolveSkillRoot(plugin) {
  if (plugin && plugin.settings && typeof plugin.settings.skillsDir === "string") {
    const trimmed = plugin.settings.skillsDir.trim();
    if (trimmed) return trimmed;
  }
  return DEFAULT_SKILL_ROOT;
}

function resolveSkillRoots(plugin) {
  const roots = [];
  const primary = resolveSkillRoot(plugin);
  if (primary) roots.push(primary);
  roots.push(...SUPPLEMENTAL_SKILL_ROOTS);
  const seen = new Set();
  return roots
    .map((root) => String(root || "").replace(/\\/g, "/").replace(/\/+$/, "").trim())
    .filter((root) => {
      if (!root || seen.has(root)) return false;
      seen.add(root);
      return true;
    });
}

function buildSkillTemplateVariables(plugin, now = new Date()) {
  const settings = plugin && plugin.settings && typeof plugin.settings === "object"
    ? plugin.settings
    : {};
  const locale = getRunnerLocale(plugin);
  const localeDefaults = getDefaultNotePathsByLocale(locale);
  const metaLocaleDefaults = getDefaultMetaPathsByLocale(locale);
  const notePaths = normalizeNotePaths(settings.notePaths, localeDefaults);
  const metaPaths = normalizeMetaPaths(settings.metaPaths, metaLocaleDefaults);
  const skillsDir = String(settings.skillsDir || DEFAULT_SKILL_ROOT).replace(/\\/g, "/").replace(/\/+$/, "").trim() || DEFAULT_SKILL_ROOT;
  const defaultPathReplacements = [];
  for (const defaults of [DEFAULT_NOTE_PATHS_ZH, DEFAULT_NOTE_PATHS_EN, DEFAULT_NOTE_PATHS_RU]) {
    for (const key of Object.keys(defaults || {})) {
      defaultPathReplacements.push({ from: defaults[key], to: notePaths[key] });
    }
  }
  for (const defaults of [DEFAULT_META_PATHS_ZH, DEFAULT_META_PATHS_EN, DEFAULT_META_PATHS_RU]) {
    for (const key of Object.keys(defaults || {})) {
      defaultPathReplacements.push({ from: defaults[key], to: metaPaths[key] });
    }
  }
  const currentDate = getLocalISODate(now);
  const currentTime = getLocalHHmm(now);
  return { notePaths, metaPaths, skillsDir, defaultPathReplacements, now, currentDate, currentTime, currentDateTime: `${currentDate} ${currentTime}` };
}

function resolveExplicitSkillInvocation(skillRegistry, preloadedSkillCommand) {
  const requested = preloadedSkillCommand && typeof preloadedSkillCommand === "object"
    ? preloadedSkillCommand
    : null;
  if (!requested) return null;
  const requestedName = String(requested.skill || requested.command || "").replace(/^\/+/, "").trim();
  const errorWithCode = (message, code) => {
    const error = new Error(message);
    error.code = code;
    return error;
  };
  if (!requestedName) {
    throw errorWithCode("This skill command is invalid.", "SKILL_COMMAND_INVALID");
  }
  const skill = skillRegistry && typeof skillRegistry.get === "function"
    ? skillRegistry.get(requestedName)
    : null;
  if (!skill) {
    throw errorWithCode(`Skill /${requestedName} is unavailable.`, "SKILL_NOT_FOUND");
  }
  if (skill.userInvocable === false) {
    throw errorWithCode(`Skill /${requestedName} cannot be started from chat.`, "SKILL_NOT_USER_INVOCABLE");
  }
  const canonicalName = String(skill.slug || skill.name || requestedName).replace(/^\/+/, "").trim() || requestedName;
  const registryPolicy = skill.completionPolicy;
  const requestedPolicy = requested.completionPolicy && typeof requested.completionPolicy === "object"
    ? requested.completionPolicy
    : null;
  const registryPolicyState = String((registryPolicy && registryPolicy.state) || "legacy_unclassified");
  const completionPolicy = registryPolicyState === "legacy_unclassified" && requestedPolicy
    ? requestedPolicy
    : registryPolicy;
  return {
    skill: completionPolicy === registryPolicy ? skill : { ...skill, completionPolicy },
    skillName: String(skill.name || requestedName),
    command: `/${canonicalName}`,
    args: requested.args === undefined || requested.args === null
      ? ""
      : String(requested.args),
  };
}

function buildPreloadedSkillTurnText({
  explicitSkillInvocation,
  plugin,
  userText,
  locale,
  now,
}) {
  if (!explicitSkillInvocation) return String(userText || "");
  const { skill, args, command } = explicitSkillInvocation;
  const skillTemplateVariables = buildSkillTemplateVariables(plugin, now);
  let body = renderSkillTemplateVariables(skill.body, skillTemplateVariables);
  body = substituteArguments(body, args, skill.argumentNames || []);

  const resources = Array.isArray(skill.resourcePaths) ? skill.resourcePaths : [];
  const resourceHint = resources.length
    ? [
        "Skill resources available via skill_resource_read:",
        ...resources.slice(0, 40).map((path) => `  - ${path}`),
        resources.length > 40 ? `  ... ${resources.length - 40} more` : "",
      ].filter(Boolean).join("\n")
    : "";
  const preface = runnerText(
    locale,
    [
      "FLOWnote 已按用户显式输入的 slash 命令预加载技能。",
      `Original command: ${command}`,
      args ? `Arguments: ${args}` : "",
      "请把 Arguments 当作该技能的输入，按下面的技能说明执行，不要把它当作普通聊天请求。",
    ].filter(Boolean).join("\n"),
    [
      "FLOWnote preloaded this skill because the user explicitly typed a slash command.",
      `Original command: ${command}`,
      args ? `Arguments: ${args}` : "",
      "Treat Arguments as the skill input and follow the loaded skill instructions below. Do not answer it as ordinary chat.",
    ].filter(Boolean).join("\n"),
  );

  return [
    preface,
    "",
    `--- preloaded skill: ${skill.name} ---`,
    `Source: ${skill.dirPath || skill.filePath || ""}`,
    resourceHint,
    "",
    "--- skill body ---",
    body,
    "",
    "--- user request ---",
    String(userText || ""),
  ].filter((part) => part !== "").join("\n");
}

/**
 * Load skills from the vault. Cached on the plugin object so we don't
 * re-scan disk on every turn. Cache invalidates when the configured
 * skill root path changes.
 *
 * @param {Object} plugin   Obsidian plugin instance
 * @returns {Promise<SkillRegistry>}
 */
async function ensureSkillRegistry(plugin) {
  if (!plugin || !plugin.app || !plugin.app.vault) {
    return new SkillRegistry([]);
  }
  const skillRoots = resolveSkillRoots(plugin);
  const locale = normalizeSupportedLocale(
    typeof plugin.getEffectiveLocale === "function" ? plugin.getEffectiveLocale() : plugin.settings && plugin.settings.uiLanguage,
    "en",
  );
  const templateRoot = normalizeMetaPaths(
    plugin.settings && plugin.settings.metaPaths,
    getDefaultMetaPathsByLocale(locale),
  ).templates;
  const cacheKey = `${locale}\n${templateRoot}\n${skillRoots.join("\n")}`;

  // Cache key: ordered skill roots. Re-load if the user points elsewhere.
  if (plugin.__flownoteSkillCache && plugin.__flownoteSkillCache.root === cacheKey) {
    return plugin.__flownoteSkillCache.registry;
  }

  let manifests = [];
  const seenSkillKeys = new Set();
  const embeddedManifests = buildEmbeddedSkillManifests(locale);
  addEmbeddedTemplateVaultOverrides(embeddedManifests, plugin, locale, EMBEDDED_BUNDLED_SKILLS_FILES);
  const bundledSkillKeys = new Set();
  let skippedVaultBundled = 0;

  // Bundled skills are product-owned and immutable from the user's point
  // of view. Prefer the embedded copy so stale or manually edited vault
  // copies cannot change built-in behavior. User-added skills still load
  // normally as long as they don't collide with a bundled identity.
  for (const embedded of embeddedManifests) {
    if (!embedded || !embedded.name) continue;
    const keys = skillIdentityKeys(embedded);
    manifests.push(embedded);
    for (const key of keys) {
      seenSkillKeys.add(key);
      bundledSkillKeys.add(key);
    }
  }

  for (const skillRoot of skillRoots) {
    let loaded = [];
    try {
      loaded = await loadSkills({ rootPath: skillRoot, vault: plugin.app.vault });
    } catch (e) {
      loaded = [];
      if (typeof plugin.traceDiagnostic === "function") {
        void plugin.traceDiagnostic("agent.skill_load_failed", { errorType: "skill_load_failed" });
      }
    }
    for (const manifest of loaded) {
      const keys = skillIdentityKeys(manifest);
      if (keys.some((key) => bundledSkillKeys.has(key))) {
        skippedVaultBundled += 1;
        continue;
      }
      if (keys.some((key) => seenSkillKeys.has(key))) continue;
      manifests.push(manifest);
      for (const key of keys) seenSkillKeys.add(key);
    }
  }
  if (skippedVaultBundled > 0 && typeof plugin.log === "function") {
    plugin.log(`[direct-agent] ignored ${skippedVaultBundled} vault copy/copies of bundled skill(s); using embedded bundle`);
  }
  if (skippedVaultBundled > 0 && typeof plugin.traceDiagnostic === "function") {
    void plugin.traceDiagnostic("agent.bundled_skill_copies_ignored", { skippedVaultBundledCount: skippedVaultBundled });
  }
  const registry = new SkillRegistry(manifests);
  plugin.__flownoteSkillCache = { root: cacheKey, registry };
  return registry;
}

/**
 * Build skill manifests from the embedded bundled-skills index. Same
 * shape that `loadSkills` returns, so SkillRegistry / skill_invoke can
 * consume either without caring where the body came from.
 */
function localizedEmbeddedSkillDocPath(slug, locale = "zh-CN") {
  const skillLocale = getSkillDocLocale(locale);
  const candidates = skillLocale === "zh-CN"
    ? [`${slug}/SKILL.zh-CN.md`, `${slug}/SKILL.md`, `${slug}/SKILL.en.md`]
    : [`${slug}/SKILL.en.md`, `${slug}/SKILL.md`, `${slug}/SKILL.zh-CN.md`];
  return candidates.find((candidate) => Object.prototype.hasOwnProperty.call(EMBEDDED_BUNDLED_SKILLS_FILES, candidate)) || "";
}

function buildEmbeddedSkillManifests(locale = "zh-CN") {
  const resourcesBySlug = {};
  for (const filePath of Object.keys(EMBEDDED_BUNDLED_SKILLS_FILES)) {
    const slash = filePath.indexOf("/");
    if (slash === -1) continue;
    const slug = filePath.slice(0, slash);
    const rel = filePath.slice(slash + 1);
    if (!slug || !rel || /^SKILL(\.(zh-CN|en|ru))?\.md$/.test(rel)) continue;
    if (!resourcesBySlug[slug]) resourcesBySlug[slug] = {};
    resourcesBySlug[slug][rel] = String(EMBEDDED_BUNDLED_SKILLS_FILES[filePath] || "");
  }
  for (const slug of Object.keys(resourcesBySlug)) {
    resourcesBySlug[slug] = materializeLocalizedMarkdownFiles(resourcesBySlug[slug], locale, "en");
  }
  addEmbeddedTemplateAliases(resourcesBySlug, locale, EMBEDDED_BUNDLED_SKILLS_FILES);
  const out = [];
  const slugs = [...new Set(Object.keys(EMBEDDED_BUNDLED_SKILLS_FILES)
    .map((filePath) => String(filePath || "").split("/")[0])
    .filter(Boolean))].sort((a, b) => a.localeCompare(b));
  for (const slug of slugs) {
    if (!slug) continue;
    const filePath = localizedEmbeddedSkillDocPath(slug, locale);
    if (!filePath) continue;
    const document = getEmbeddedSkillDocument(filePath);
    if (!document) continue;
    const embeddedResourceFiles = resourcesBySlug[slug] || {};
    out.push(buildSkillManifest({
      frontmatter: document.frontmatter,
      body: document.body,
      frontmatterError: document.errorCode,
      // dirPath is informational only; embedded skills don't live in the
      // vault. We use a sentinel prefix so vault_read / vault_edit don't
      // accidentally try to treat it as a real path.
      dirPath: `<embedded>/${slug}`,
      filePath: `<embedded>/${slug}/SKILL.md`,
      resourcePaths: normalizeResourcePaths(Object.keys(embeddedResourceFiles)),
      embeddedResourceFiles,
    }));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Discard the cached SkillRegistry so the next turn reloads from disk. */
function invalidateSkillCache(plugin) {
  if (plugin) plugin.__flownoteSkillCache = null;
}

// Direct-mode entrypoint. Test-only overrides are accepted at provider, loop,
// registry, contract, and Skill boundaries; continuation IDs select one exact checkpoint.
async function runDirectAgentTurn({
  view,
  sessionId,
  draftId,
  userText,
  intentText,
  handlers,
  signal,
  requestImpl,
  toolRegistryOverride,
  runAgentLoopImpl,
  runTurnAuditImpl,
  skillRegistryOverride,
  preloadedSkillCommand,
  continuationMessageId,
  continuationRunId,
  checkpointStoreOverride,
  linkedContextEvidence,
}) {
  const plugin = view.plugin;
  let settings = plugin.settings.agentProvider || {};
  let isMobileRuntime = false;
  try {
    const { Platform = {} } = require("obsidian");
    isMobileRuntime = Boolean(Platform.isMobile);
  } catch (_e) {
    // Keep desktop/direct behavior if Obsidian Platform is unavailable in tests.
  }
  if (
    isMobileRuntime
    && settings
    && settings.direct
    && String(settings.direct.providerId || "").trim() === "ollama"
  ) {
    // Lazy-load mobile-only helpers so Node tests that do not mock Obsidian
    // can still import the direct runner.
    const { buildMobileAgentSettingsOverride } = require("../mobile/mobile-ai-service");
    const mobileOverride = buildMobileAgentSettingsOverride(plugin.settings);
    if (!mobileOverride) {
      const locale = getRunnerLocale(view);
      throw new Error(runnerText(
        locale,
        "移动端无法直接使用电脑端 Ollama。请在 FLOWnote 设置中为移动端单独配置可访问的云端 AI 模型。",
        "Mobile cannot directly use the desktop Ollama service. Configure a cloud AI model for mobile in FLOWnote settings.",
      ));
    }
    settings = mobileOverride;
  }

  // Resolve Provider (missing configuration is surfaced to the caller).
  const usageAccumulator = createDirectUsageAccumulator();
  let workflowId = `${sessionId}:${draftId}`;
  let workflowStoredMessages = [];
  function usageSnapshot() {
    const workflow = workflowUsageSummary({ storedMessages: workflowStoredMessages, workflowId, runId: draftId,
      requests: usageAccumulator.requests() });
    return { runId: draftId, workflowId, requestCount: usageAccumulator.requestCount(), usage: usageAccumulator.snapshot(), usageReported: usageAccumulator.snapshotReported(),
      requestUsage: workflow.requests.filter(request => request.runId === draftId), workflowUsage: workflow.totals,
      accounting: workflow.accounting };
  }
  let usagePhase = "main";
  const provider = meterProvider(
    resolveAgentProvider({ ...settings, mode: getEffectiveAgentMode(settings) }, { requestImpl }),
    usageAccumulator,
    {
      getPhase: () => usagePhase,
      onComplete: async (record) => {
        if (typeof plugin.traceDiagnostic === "function") void plugin.traceDiagnostic("agent.request_usage", record);
        if (handlers && typeof handlers.onUsageSnapshot === "function") await handlers.onUsageSnapshot(usageSnapshot());
      },
    },
  );

  // Load skills and build the tool registry against the live vault.
  let normalizePath;
  try {
    // eslint-disable-next-line global-require
    normalizePath = require("obsidian").normalizePath;
  } catch (_e) {
    normalizePath = undefined;
  }
  const skillRegistry = skillRegistryOverride || (await ensureSkillRegistry(plugin));
  const explicitSkillInvocation = resolveExplicitSkillInvocation(skillRegistry, preloadedSkillCommand);
  const locale = getRunnerLocale(view);
  const turnNow = new Date();
  const vaultName = view.app && view.app.vault && typeof view.app.vault.getName === "function"
    ? String(view.app.vault.getName() || "")
    : "";
  const notePaths = (plugin.settings && plugin.settings.notePaths) || null;
  const systemPrompt = buildSystemPrompt(
    skillRegistry.list ? skillRegistry.list() : [],
    {
      outputLocale: locale,
      vaultName,
      notePaths,
    },
  );

  // The orchestrator binds a request to sessionId before any asynchronous
  // setup begins.  Never re-resolve history through the currently active chat:
  // the user may switch sessions while skills/providers are still loading.
  const sessionStore = plugin.sessionStore;
  const stored = (sessionStore && typeof sessionStore.getSessionMessages === "function")
    ? sessionStore.getSessionMessages(sessionId)
    : ((sessionStore && typeof sessionStore.getActiveMessages === "function")
      ? sessionStore.getActiveMessages()
      : []);
  const checkpointStore = createContinuationCheckpointStore(
    plugin,
    view.app && view.app.vault,
    checkpointStoreOverride,
  );
  const continuationContext = await prepareContinuationContext({
    storedMessages: stored,
    draftId,
    userText,
    continuationMessageId,
    continuationRunId,
    sessionId,
    sessionStore: plugin.sessionStore,
    persistState: typeof plugin.persistState === "function" ? () => plugin.persistState() : null,
    vault: view.app && view.app.vault,
    checkpointStore,
  });
  const continuation = continuationContext.continuation;
  workflowStoredMessages = stored;
  workflowId = resolveWorkflowUsageId({ storedMessages: stored, sessionId, runId: draftId,
    resumeFromRunId: continuationContext.resumeFromRunId });
  const cardWorkflow = String((explicitSkillInvocation && explicitSkillInvocation.skillName)
    || (continuationContext.executionContract && continuationContext.executionContract.skillName) || "") === "ah-card";
  // Every vault write API handed to tools is measured. The recorder, not
  // tool text or model prose, decides which files this turn changed.
  const changeRecorder = view.app && view.app.vault
    ? createVaultChangeRecorder({ vault: view.app.vault })
    : null;
  const toolApp = changeRecorder ? changeRecorder.instrumentApp(view.app) : view.app;
  const registry = toolRegistryOverride || buildDefaultToolRegistry(toolApp, normalizePath, skillRegistry, plugin, turnNow, { includeCardTools: true });
  let history;
  if (continuation) {
    history = continuationContext.history;
  } else {
    history = buildAnthropicHistory(stored, draftId);
    // buildAnthropicHistory drops the most recent user message because
    // that's the raw version from the session store. Append the composed
    // userText (which the orchestrator built via composePromptWithLinkedFiles
    // and skill injection) as the actual current turn.
    const turnText = buildPreloadedSkillTurnText({
      explicitSkillInvocation,
      plugin,
      userText,
      locale,
      now: turnNow,
    });
    history.push({ role: "user", content: [{ type: "text", text: turnText }, { type: "text", text: buildTurnTimeContext(describeCurrentDateTime(turnNow, locale), locale) }] });
  }

  // Natural-language turns carry no predicted task contract: the model works
  // with its tools and the host reconciles its final message with measured
  // vault changes when it stops. An explicit Skill records its declared
  // completion policy, which the end-of-turn check enforces.
  const executionContract = continuation
    ? continuationContext.executionContract
    : explicitSkillInvocation
    ? createExplicitSkillWorkflowContract({
        skillName: explicitSkillInvocation.skillName,
        command: explicitSkillInvocation.command,
        args: explicitSkillInvocation.args,
        completionPolicy: explicitSkillInvocation.skill.completionPolicy,
      })
    : null;

  const state = {
    text: "",
    toolUses: [],
    effectReceipts: continuation && Array.isArray(continuationContext.effectReceipts)
      ? continuationContext.effectReceipts.slice()
      : [],
    suspension: null,
    retryPending: false,
    cancelled: false,
  };
  const activityTimeline = createDirectActivityTimeline(draftId);
  const contextRequests = [];
  const journal = new DirectExecutionJournal({
    runId: draftId,
    onSnapshot: handlers && handlers.onExecutionSnapshot,
  });
  await journal.start(executionContract, {
    resumeFromRunId: continuationContext.resumeFromRunId,
  });
  let stopReason = null;

  function findToolUse(toolUseId) {
    return state.toolUses.find((t) => t.id === toolUseId);
  }

  function pushBlocksUpdate() {
    if (handlers && typeof handlers.onBlocks === "function") {
      handlers.onBlocks(activityTimeline.blocks());
    }
  }

  async function onPermissionAsk(req) {
    if (!handlers || typeof handlers.onPermissionRequest !== "function") {
      return { behavior: "deny" };
    }
    // Map our internal "ask" request to the OpenCode-style permission
    // object the existing PermissionRequestModal renders.
    const permObj = {
      type: req.tool || "tool",
      title: `${req.tool || "tool"}: ${req.summary || ""}`.trim(),
      pattern: req.summary || "",
      metadata: req.input || {},
      requiresExplicitConfirmation: req.requiresExplicitConfirmation === true || undefined,
      unresolvedEffect: req.unresolvedEffect,
    };
    try {
      const decision = await handlers.onPermissionRequest(permObj);
      if (decision === "always") return { behavior: "allow", persist: "session" };
      if (decision === "once")   return { behavior: "allow" };
      return { behavior: "deny" };
    } catch (e) {
      trace("agent.permission_ask_failed", { errorType: "permission_ask_failed" });
      return { behavior: "deny" };
    }
  }

  // Bridge ask_user through the chat view.
  async function askUserFn(payload) {
    if (!handlers || typeof handlers.onAskUser !== "function") {
      throw new Error("no onAskUser handler installed");
    }
    return await handlers.onAskUser(payload);
  }

  const loopImpl = runAgentLoopImpl || runAgentLoop;
  const trace = (event, metadata) => {
    if (plugin && typeof plugin.traceDiagnostic === "function") {
      void plugin.traceDiagnostic(event, metadata);
    }
  };

  // Reserve a bounded default output budget; explicit overrides still respect model limits.
  const activeModelInfo = (provider.spec.models || []).find((m) => m && m.id === provider.userConfig.model);
  const maxTokensPerTurn = resolveMainTurnTokenBudget(settings, provider);

  trace("agent.turn_started", {
    provider: provider.id,
    model: provider.userConfig.model,
    historyLength: history.length,
    maxOutputTokens: maxTokensPerTurn,
    contractMode: String((executionContract && executionContract.mode) || ""),
    completionPolicyState: String((executionContract && executionContract.completionPolicyState) || ""),
    requiredInteractionCount: Array.isArray(executionContract && executionContract.requiredInteractions)
      ? executionContract.requiredInteractions.length
      : 0,
  });
  // Record only observable prompt shape. Prompt text and linked-file paths
  // are intentionally excluded from the vault-persisted diagnostic trace.
  try {
    const lastUserMsg = history[history.length - 1];
    if (lastUserMsg && lastUserMsg.role === "user" && Array.isArray(lastUserMsg.content)) {
      const textJoined = lastUserMsg.content
        .filter((b) => b && b.type === "text")
        .map((b) => String(b.text || ""))
        .join("\n");
      const hasFileTag = /<<<FLOWNOTE_FILE\s+path="/.test(textJoined);
      trace("agent.outgoing_user_shape", {
        promptLength: textJoined.length,
        hasFlowNoteFileTag: hasFileTag,
      });
    }
  } catch (_e) {
    trace("agent.outgoing_user_shape_failed", { errorType: "outgoing_user_shape_failed" });
  }

  // Per-turn FileStateCache — tracks every file the agent reads or
  // writes during this conversation turn. Used by vault_edit to enforce
  // read-before-edit, and by vault_backlinks to sidestep metadataCache
  // reindex lag. Fresh instance each turn so stale state can't leak.
  const fileStateCache = continuationContext.fileStateCache;
  if (!continuation) await seedLinkedEvidence({ evidence: linkedContextEvidence,
    vault: view.app && view.app.vault, cache: fileStateCache, history });

  const skillCompletion = describeSkillCompletion(executionContract);
  const previousAssistantText = lastAssistantText(stored, draftId);
  const auditImpl = runTurnAuditImpl || runTurnAudit;
  // End-of-turn reconciliation. The host compares what the final message
  // claims with what it measured; a mismatch goes back to the model as an
  // internal note so it performs the change or says plainly it did not.
  async function stopCheck({ finalContent, interactionReceipts, provider: loopProvider }) {
    const finalText = assistantTextFromContent(finalContent);
    if (!finalText) return { allow: true };
    const { changes } = changeRecorder ? await changeRecorder.snapshot() : { changes: [] };
    const previousPhase = usagePhase;
    usagePhase = "audit";
    let audit;
    try {
      audit = await auditImpl({
        provider: loopProvider || provider,
        signal,
        userRequest: intentText === undefined ? userText : intentText,
        previousAssistantText,
        finalText,
        changes: describeChanges(changes),
      });
    } finally {
      usagePhase = previousPhase;
    }
    if (!audit || !audit.ok) {
      trace("agent.turn_audit_unavailable", { errorType: String((audit && audit.error) || "audit_failed") });
      return { allow: true };
    }
    const decision = evaluateTurnReport({
      report: audit.report,
      changes,
      requiresChange: skillCompletion.requiresChange,
      requiredInteractions: skillCompletion.requiredInteractions,
      interactionReceipts,
    });
    trace("agent.turn_audit", {
      allow: decision.allow,
      claimCount: audit.report.claims.length,
      changeCount: changes.length,
      issueCount: decision.issues.length,
    });
    if (decision.allow) return { allow: true };
    return {
      allow: false,
      issues: decision.issues,
      feedback: buildHostCheckMessage({
        changes: describeChanges(changes),
        issues: decision.issues,
        skillCommand: skillCompletion.command,
      }),
    };
  }

  if (changeRecorder) changeRecorder.start();
  try {
    for await (const ev of loopImpl({
      provider,
      registry,
      system: systemPrompt,
      messages: history,
      maxTokensPerTurn,
      executionContract,
      resumeState: continuationContext.resumeState,
      allowedToolPolicy: explicitSkillInvocation && explicitSkillInvocation.skill.allowedTools,
      stopCheck,
      signal,
      ctx: {
        app: toolApp,
        signal,
        grants: {},
        askUserFn,
        fileStateCache,
        cardWorkflow,
        changeRecorder,
        // External sends are journaled (and persisted) before they leave.
        onEffectAttempt: (record) => journal.recordEffectAttempt(record),
        unresolvedEffectAttempts: collectUnresolvedEffectAttempts(stored, { excludeMessageId: draftId }),
        toolPermissionMode: plugin.settings && plugin.settings.toolPermissionMode,
      },
      onPermissionAsk,
    })) {
      if (!ev) continue;
      let durableEvent = ev;
      if (ev.type === "suspended") {
        try {
          if (!checkpointStore || typeof checkpointStore.store !== "function") {
            throw continuationStoreUnavailableError();
          }
          const storedRef = projectCheckpointRef(await checkpointStore.store(ev.checkpoint));
          if (!storedRef) {
            const error = new Error("Continuation checkpoint storage returned an invalid reference.");
            error.code = "CONTINUATION_CHECKPOINT_REFERENCE_INVALID";
            throw error;
          }
          durableEvent = { ...ev, checkpointRef: storedRef };
          delete durableEvent.checkpoint;
        } catch (error) {
          const code = String((error && error.code) || "CONTINUATION_CHECKPOINT_STORE_FAILED");
          await journal.consume({ type: "error", error: { type: code } });
          throw error;
        }
      }
      await journal.consume(durableEvent);
      switch (durableEvent.type) {
        case "context_usage": {
          const { type, ...metrics } = ev;
          contextRequests.push(metrics);
          trace("agent.context_usage", metrics);
          break;
        }
        case "stream": {
          const inner = ev.event;
          if (!inner) break;
          // Injected loops may synthesize stream events without calling the
          // provider. Production usage is captured at the provider boundary.
          if (runAgentLoopImpl) usageAccumulator.observe(inner);
          const deltaText = inner.type === "content_block_delta" && inner.delta && inner.delta.type === "text_delta"
            ? inner.delta.text || ""
            : inner.type === "content_block_start" && inner.content_block && inner.content_block.type === "text"
              ? inner.content_block.text || "" : "";
          if (deltaText) {
            state.text += deltaText;
            activityTimeline.appendText(deltaText);
            if (handlers && typeof handlers.onToken === "function") handlers.onToken(state.text);
            pushBlocksUpdate();
          }
          if (inner.type === "message_delta" && inner.delta && typeof inner.delta.stop_reason === "string") {
            stopReason = inner.delta.stop_reason;
          }
          break;
        }
        case "tool_start": {
          trace("agent.tool_started", { tool: ev.tool });
          state.toolUses.push({
            id: ev.toolUseId,
            name: ev.tool,
            input: ev.input,
            capabilities: ev.capabilities,
            status: "running",
            output: "",
            isError: false,
            startedAt: Date.now(),
            durationMs: 0,
          });
          activityTimeline.startTool(state.toolUses[state.toolUses.length - 1]);
          pushBlocksUpdate();
          break;
        }
        case "effect_receipt": {
          if (ev.receipt) state.effectReceipts.push(ev.receipt);
          if (ev.receipt && ev.receipt.toolUseId) {
            const receiptTool = findToolUse(ev.receipt.toolUseId);
            if (receiptTool) activityTimeline.syncTool(receiptTool, ev.receipt);
          }
          pushBlocksUpdate();
          trace("agent.effect_receipt", {
            tool: ev.receipt && ev.receipt.tool,
            verified: !!(ev.receipt && ev.receipt.verified),
          });
          break;
        }
        case "completion_retry": {
          // The host check returned the turn to the model. Whatever it said
          // in that turn becomes process narration; the answer is what it
          // says after acting on the feedback.
          state.retryPending = true;
          state.text = "";
          if (handlers && typeof handlers.onToken === "function") handlers.onToken("");
          trace("agent.completion_retry", { attempt: ev.attempt, issues: ev.issues || [] });
          break;
        }
        case "tool_progress": {
          const t = findToolUse(ev.toolUseId);
          if (t) {
            if (ev.message) t.output = ev.message;
            pushBlocksUpdate();
          }
          break;
        }
        case "tool_finish": {
          const t = findToolUse(ev.toolUseId);
          if (t) {
            t.status = ev.isError ? "error" : "done";
            t.output = ev.content;
            t.isError = !!ev.isError;
            t.outcome = ev.outcome;
            if (ev.capabilities) t.capabilities = ev.capabilities;
            t.durationMs = Date.now() - t.startedAt;
            const receipt = state.effectReceipts.find((item) => item && item.toolUseId === t.id);
            activityTimeline.syncTool(t, receipt);
            trace("agent.tool_finished", { tool: ev.tool, status: t.status, durationMs: t.durationMs, isError: !!ev.isError });
          }
          pushBlocksUpdate();
          break;
        }
        case "turn_complete": {
          activityTimeline.completeTurn({ forceProcess: state.retryPending });
          state.retryPending = false;
          const requestUsage = usageAccumulator.completeTurn();
          if (requestUsage) trace("agent.request_usage", requestUsage);
          trace("agent.turn_completed", {
            turnIndex: ev.turnIndex,
            stopReason: ev.stopReason,
            textLength: state.text.length,
            toolCount: state.toolUses.length,
          });
          break;
        }
        case "cancelled":
          state.cancelled = true;
          break;
        case "suspended":
          state.suspension = {
            reason: durableEvent.reason || "workflow_suspended",
            stage: durableEvent.stage || "between_turns",
            turns: durableEvent.turns,
            checkpointRef: durableEvent.checkpointRef,
          };
          trace("agent.workflow_suspended", { reason: state.suspension.reason, stage: state.suspension.stage, turns: durableEvent.turns });
          break;
        case "error": {
          const err = ev.error || {};
          const message = err.message || err.type || "Agent runtime error.";
          trace("agent.error", { errorType: err.type || "agent_error" });
          const wrapped = new Error(message);
          if (err.type) wrapped.code = err.type;
          throw wrapped;
        }
        default:
          break;
      }
    }
  } catch (error) {
    // A failed or cancelled run may already have changed files. Attach the
    // measured list so the stored message still shows what really changed.
    if (changeRecorder && error && typeof error === "object") {
      try {
        const partial = await changeRecorder.finalize();
        const block = buildTurnChangeBlock({ runId: draftId, changes: partial.changes });
        if (block) error.flownoteChangeBlock = block;
      } catch (_measureError) {
        // Measurement is best effort on the failure path.
      }
    }
    throw error;
  } finally {
    if (changeRecorder) changeRecorder.stop();
  }

  // Do not delete a consumed checkpoint here. The caller has not yet durably
  // committed the final assistant message, so a crash at this point must leave
  // the previous recovery point intact. Once final state is persisted, the
  // existing mark-and-sweep lifecycle removes the now-unreferenced blob.

  const measured = changeRecorder ? await changeRecorder.finalize() : { changes: [], external: [] };
  trace("agent.turn_finished", {
    stopReason,
    textLength: state.text.length,
    toolCount: state.toolUses.length,
    changeCount: measured.changes.length,
  });
  let finalText = activityTimeline.finalText() || state.text;
  if (state.suspension) {
    finalText = buildSuspensionCopy(locale, state, runnerText);
  } else if (!finalText && measured.changes.length > 0) {
    finalText = runnerText(locale, EXECUTION_FALLBACK_COPY.verified.zh, EXECUTION_FALLBACK_COPY.verified.en);
  }
  // If the model ran out of output budget before producing anything
  // useful, surface a clear message instead of a silent empty bubble.
  if (!finalText && stopReason === "max_tokens") {
    const modelLabel = activeModelInfo ? activeModelInfo.label : provider.userConfig.model;
    finalText = runnerText(
      locale,
      "⚠️ 模型在还没产生输出之前就用尽了本轮的输出额度。\n\n" +
        "已经按当前模型（" + modelLabel +
        "）设置本轮输出上限为 " + maxTokensPerTurn + " tokens。\n\n" +
        "建议：\n" +
        "• 在设置中提高单次输出 token 上限，或降低思考强度\n" +
        "• 拆分任务：先让模型只输出 [总结部分]，再单独写回文件",
      "The model used up this turn's output budget before producing content.\n\n" +
        "The configured output limit for " + modelLabel +
        " is " + maxTokensPerTurn + " tokens.\n\n" +
        "Suggestions:\n" +
        "• Increase the output token limit in settings, or lower the thinking effort.\n" +
        "• Split the task into smaller steps, then write each part back separately.",
    );
  }
  const finalBlocks = activityTimeline.settle(finalText);
  const changeBlock = buildTurnChangeBlock({ runId: draftId, changes: measured.changes });
  if (changeBlock) finalBlocks.push(changeBlock);
  const meta = composeMetaLine(provider, stopReason, state, measured.changes);
  const usage = usageAccumulator.snapshot();
  return {
    messageId: `direct-${Date.now()}`,
    text: finalText,
    reasoning: "",
    meta,
    changes: describeChanges(measured.changes),
    stats: {
      ...usageSnapshot(),
      providerLabel: String((provider.spec && provider.spec.displayName) || provider.id || ""),
      modelId: String(provider.userConfig && provider.userConfig.model || ""),
      modelLabel: String((activeModelInfo && activeModelInfo.label) || (provider.userConfig && provider.userConfig.model) || ""),
      toolCount: state.toolUses.length,
      requestCount: usageAccumulator.requestCount(),
      contextRequests,
      usage,
    },
    blocks: finalBlocks,
    status: journal.status,
    execution: { version: 1, events: journal.events },
  };
}

// Completion requirements an explicit Skill declares in its metadata. Ordinary
// chat turns declare none: there the check only rejects unbacked claims.
function describeSkillCompletion(contract) {
  if (!contract || contract.source !== "explicit_skill") {
    return { requiresChange: false, requiredInteractions: [], command: "" };
  }
  const requiredEffects = (Array.isArray(contract.requiredEffects) ? contract.requiredEffects : [])
    .map((effect) => String((effect && effect.kind) || effect || ""));
  const requiresChange = contract.completionMode === "effect"
    && (requiredEffects.length === 0 || requiredEffects.includes("vault_mutation"));
  return {
    requiresChange,
    requiredInteractions: Array.isArray(contract.requiredInteractions) ? contract.requiredInteractions.slice() : [],
    command: String(contract.command || ""),
  };
}

function lastAssistantText(storedMessages, draftId) {
  const list = Array.isArray(storedMessages) ? storedMessages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (!message || message.id === draftId || message.role !== "assistant" || message.pending) continue;
    return String(message.text || "");
  }
  return "";
}

function composeMetaLine(provider, stopReason, state, changes) {
  const parts = [];
  const spec = provider && provider.spec;
  const model = provider && provider.userConfig && provider.userConfig.model;
  if (spec && spec.displayName) parts.push(spec.displayName);
  if (model) parts.push(model);
  if (state.toolUses.length > 0) parts.push(`tools=${state.toolUses.length}`);
  if (state.suspension) parts.push("execution=suspended");
  if (Array.isArray(changes) && changes.length > 0) parts.push(`changes=${changes.length}`);
  if (stopReason && stopReason !== "end_turn") parts.push(`stop=${stopReason}`);
  return parts.join(" · ");
}

module.exports = {
  runDirectAgentTurn, buildAnthropicHistory, buildDefaultToolRegistry, buildSystemPrompt,
  ensureSkillRegistry, invalidateSkillCache, getLocalISODate, getLocalHHmm,
  describeToday, describeCurrentDateTime, DEFAULT_SKILL_ROOT, SUPPLEMENTAL_SKILL_ROOTS,
  resolveSkillRoots, resolveMainTurnTokenBudget,
};
