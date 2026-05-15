// Bridge: agent loop + Obsidian Vault → existing chat view handlers.
//
// runDirectAgentTurn is the direct-mode counterpart to
// opencodeClient.sendMessage. It returns the same response shape
// ({ messageId, text, reasoning, meta, blocks }) so the orchestrator's
// finalizeAssistantDraft works unchanged.
//
// All UI updates flow through the handler callbacks (onToken / onBlocks
// / onPermissionRequest) that chat-orchestrator passes in. This file
// does not touch the DOM directly.

const { runAgentLoop } = require("../agent/agent-loop");
const { ToolRegistry } = require("../agent/tool-registry");
const { createVaultReadTool } = require("../agent/tools/vault-read");
const { createVaultWriteTool } = require("../agent/tools/vault-write");
const { createVaultEditTool } = require("../agent/tools/vault-edit");
const { createVaultListTool } = require("../agent/tools/vault-list");
const { createVaultSearchTool } = require("../agent/tools/vault-search");
const { createVaultDailyTool } = require("../agent/tools/vault-daily");
const { createVaultPropertyTool } = require("../agent/tools/vault-property");
const { createVaultBacklinksTool } = require("../agent/tools/vault-backlinks");
const { createVaultTasksTool } = require("../agent/tools/vault-tasks");
const { createVaultTagsTool } = require("../agent/tools/vault-tags");
const { createVaultMoveTool } = require("../agent/tools/vault-move");
const { createVaultCreateDirTool } = require("../agent/tools/vault-create-dir");
const { createVaultGetActiveFileTool } = require("../agent/tools/vault-get-active-file");
const { createAskUserTool } = require("../agent/tools/ask-user");
const { createSkillInvokeTool } = require("../agent/tools/skill-invoke");
const { loadSkills, formatSkillListing, SkillRegistry } = require("../agent/skill-registry");
const { FileStateCache } = require("../agent/file-state-cache");
const { resolveAgentProvider } = require("../agent/agent-provider-resolver");
const { getActiveApiKey } = require("../agent/agent-settings");
const { getProviderSpec } = require("../providers/registry");

const DEFAULT_SKILL_ROOT = ".opencode/skills";

// Local-timezone YYYY-MM-DD. Local — not UTC — because the user's "today"
// is whatever calendar date their wall clock shows. Used to anchor the
// model when it writes daily notes, weekly reviews, etc.
function getLocalISODate(now) {
  const d = now instanceof Date ? now : new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const ZH_WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

function describeToday(now) {
  const d = now instanceof Date ? now : new Date();
  return `${getLocalISODate(d)} (星期${ZH_WEEKDAY[d.getDay()]})`;
}

const BASE_SYSTEM_PROMPT = [
  "You are FLOWnote, an AI assistant running inside Obsidian. The user's notes live in an Obsidian vault.",
  "",
  "You have these tools available:",
  "  • vault_read      — read a markdown note. Pass `path` (vault-relative, forward slashes).",
  "                      Optional `offset` + `limit` to slice long files.",
  "  • vault_list      — enumerate notes/folders. Optional `path`, `pattern` (glob), `extensions`,",
  "                      `recursive`, `include_folders`, `limit`.",
  "  • vault_search    — search note contents. Required `query` (substring; set `regex: true` for regex).",
  "                      Optional `path`, `pattern`, `case_sensitive`, `extensions`, `max_files`, `max_matches`.",
  "  • vault_edit      — precise string replacement in a single note. Pass `path`, `old_string`,",
  "                      `new_string`, optional `replace_all`. The match must be unique unless replace_all.",
  "                      Prefer this over vault_write for surgical edits (faster, safer).",
  "  • vault_write     — create / overwrite / append text. Pass `path`, `content`, `mode`:",
  "                        mode=\"create\"    → fails if the file already exists",
  "                        mode=\"overwrite\" → replace existing content (full rewrite only)",
  "                        mode=\"append\"   → add to the end",
  "  • vault_daily     — read / append / create the user's daily note. Pass `mode` (read|append|create),",
  "                      optional `date` (YYYY-MM-DD, defaults to today), optional `content`.",
  "                      Uses the daily-notes plugin's folder + format + template automatically.",
  "                      Prefer this whenever the user means \"today's note\" / \"昨日日记\" / \"周记\".",
  "  • vault_property  — read/set/delete a YAML frontmatter property. Pass `path`, `name`, `op`",
  "                      (get|set|delete), `value` (for set). Use for status / tags / source /",
  "                      due-date / any frontmatter field.",
  "  • vault_backlinks — list notes that link TO a given note. Pass `path`. Useful for finding",
  "                      related notes (ah-card flow) without reading every file.",
  "  • vault_tasks     — list checkbox tasks across the vault. Optional `path` scope, `status`",
  "                      (open|done|all). Use for daily/weekly task review.",
  "  • vault_tags      — `mode: list` returns top tags + counts; `mode: files` returns notes that",
  "                      carry a given `tag` (with or without leading #).",
  "  • vault_move      — rename or move a note OR folder. Pass `from` and `to` (both vault-relative).",
  "                      Obsidian rewrites wikilinks pointing at the moved file(s) automatically —",
  "                      ALWAYS prefer this over vault_write to a new path + delete.",
  "  • vault_create_dir — `mkdir -p` for a vault folder. Pass `path`. Use BEFORE vault_write when",
  "                      laying out a new directory structure (e.g. a fresh project folder).",
  "  • vault_get_active_file — return the note currently open in the editor (path + basename +",
  "                      parent folder). Use when the user says \"this note\" / \"add to here\".",
  "  • ask_user        — ask the user a multiple-choice question when truly ambiguous. Don't",
  "                      abuse this — most ambiguity can be resolved with vault_list / vault_search.",
  "  • skill_invoke    — load a vault skill's instructions so you can follow them. See \"Available",
  "                      skills\" below. Pass `skill` (name) and optional `args` (string).",
  "",
  "Core rules:",
  "  1. ALWAYS call the tools to do file operations. Don't describe what you would write — actually call the tool.",
  "  2. Promise = tool call. If your reply claims a note/card was created/edited/saved/moved, the matching",
  "     vault_* tool call MUST already be in this turn. Call the tools first, then summarize.",
  "  3. Prefer vault_edit for small in-place changes; reserve vault_write/overwrite for wholesale rewrites.",
  "     vault_edit requires the file to have been read this session (vault_read or a prior vault_write satisfies it).",
  "  4. When the user attaches files, they appear in the conversation wrapped like this:",
  "       <<<FLOWNOTE_FILE path=\"some/path.md\">>>",
  "       ...file contents...",
  "       <<<END_FLOWNOTE_FILE>>>",
  "     The `path` attribute is the REAL vault path. Use it directly with vault_read/vault_write/vault_edit.",
  "  5. Reply in the same language the user used. Be concise.",
  "  6. If you finish without needing tools, respond naturally with text only.",
  "",
  "obsidian-cli compatibility map:",
  "  Some skills reference `obsidian-cli` (Obsidian's official CLI tool) for vault operations. " +
  "The CLI itself is desktop-only and not available in this runtime, but the same operations " +
  "are exposed as native tools here. Translate as follows:",
  "    obsidian read              → vault_read",
  "    obsidian create            → vault_write mode=\"create\"",
  "    obsidian append            → vault_write mode=\"append\"",
  "    obsidian search            → vault_search",
  "    obsidian daily:read        → vault_daily mode=\"read\"",
  "    obsidian daily:append      → vault_daily mode=\"append\"",
  "    obsidian property:set      → vault_property op=\"set\"",
  "    obsidian backlinks         → vault_backlinks",
  "    obsidian tasks             → vault_tasks",
  "    obsidian tags              → vault_tags",
  "  Same idea for any reference to Bash / Read / Write tools — they don't exist here; use the vault_* tools above.",
  "",
  "Vault navigation (read this BEFORE searching):",
  "",
  "  The user's vault uses a PARA + Zettelkasten hybrid:",
  "    01-捕获层/  daily notes, inbox, reading clippings (capture stage)",
  "    02-培养层/  permanent notes, literature notes, topic pages (📍 prefix)",
  "    03-连接层/  domain pages (🌱 prefix) — top-level knowledge hubs",
  "    04-创造层/  active projects, archives",
  "",
  "  When the user asks about a topic, asks \"what do I know about X\", asks to extract notes,",
  "  asks to summarize their thinking, or otherwise needs you to RETRIEVE knowledge from the vault:",
  "",
  "    STEP 1 — Read the authoritative index FIRST: `Meta/索引/kb-manifest.md`. This file is",
  "             maintained by the user's /ah-index skill and lists every domain page, topic",
  "             page, and permanent-note grouping. It is the FAST PATH — do not search before",
  "             you have read it.",
  "",
  "    STEP 2 — If kb-manifest.md exists AND was updated recently, follow the link hierarchy",
  "             it describes: domain page (🌱) → topic page (📍) → permanent note. Use",
  "             vault_read on the specific page the user cares about, then vault_read again on",
  "             the permanent notes it links to.",
  "",
  "    STEP 3 — If kb-manifest.md is MISSING, EMPTY, or its `更新时间` / `version` frontmatter",
  "             field shows it's older than ~30 days, tell the user (in their language):",
  "               \"你的知识库索引看起来过期/不存在，建议运行 /ah-index 重建一下，AI 才能高效",
  "                  地通过领域页 → 主题页 → 永久笔记的层级帮你找东西。\"",
  "             Then proceed to STEP 4.",
  "",
  "    STEP 4 — Fallback (no usable index): vault_list to enumerate 02-培养层/永久笔记 and",
  "             03-连接层, vault_search to find by content. Tell the user EXPLICITLY that you're",
  "             doing a manual scan because the index is unavailable.",
  "",
  "  Naming conventions (use to identify file type WITHOUT reading content):",
  "    🌱 *.md    → domain page (knowledge hub)",
  "    📍 *.md    → topic page (groups permanent notes)",
  "    《...》*.md → literature note (book/article)",
  "    YYYY-MM-DD.md → daily note",
  "    no prefix → permanent note (atomic assertion)",
].join("\n");

function buildSystemPrompt(skillManifests, opts) {
  const parts = [BASE_SYSTEM_PROMPT];
  const ctxLines = [];
  if (opts && opts.todayLabel) {
    ctxLines.push(`# currentDate\n今天是 ${opts.todayLabel}。涉及"今天 / 昨天 / 本周"等相对时间时，以这个日期为准。`);
  }
  if (opts && typeof opts.vaultName === "string" && opts.vaultName) {
    ctxLines.push(`# vault\n当前 Obsidian 库名：${opts.vaultName}`);
  }
  if (ctxLines.length > 0) {
    parts.push(`Context:\n${ctxLines.join("\n\n")}`);
  }
  const listing = formatSkillListing(skillManifests);
  if (listing) {
    parts.push(`Available skills (call via skill_invoke):\n${listing}`);
  }
  return parts.join("\n\n");
}

/**
 * Convert the session store's plain {role,text} messages into the
 * Anthropic-shape conversation the agent loop expects.
 *
 * Skips:
 *   - the in-flight assistant draft (no content yet)
 *   - any pending assistant messages
 *   - empty-text messages
 *   - the LAST user message (it's the one that was just pushed by
 *     mountPendingDraft, and it contains the raw user input WITHOUT
 *     the composePromptWithLinkedFiles wrapper — the runner will append
 *     the properly composed userText as the actual current turn)
 *
 * @param {Array<Object>} storedMessages
 * @param {string}        draftId           the in-flight assistant draft to skip
 * @returns {Array<{role: 'user'|'assistant', content: Array}>}
 */
function buildAnthropicHistory(storedMessages, draftId) {
  const out = [];
  for (const msg of storedMessages || []) {
    if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;
    if (msg.id === draftId) continue;
    if (msg.role === "assistant" && msg.pending) continue;
    const text = String(msg.text || "");
    if (!text) continue;
    out.push({
      role: msg.role,
      content: [{ type: "text", text }],
    });
  }
  // Drop the most recent user message: it's the just-pushed raw-input
  // version. The caller will append the composed userText (which carries
  // any linked-context file blocks) as the actual current turn.
  if (out.length > 0 && out[out.length - 1].role === "user") {
    out.pop();
  }
  return out;
}

/**
 * Build the tool registry the agent loop runs with. M2 ships the full
 * tool surface: vault_read, vault_list, vault_search, vault_edit,
 * vault_write, ask_user, skill_invoke.
 *
 * @param {Object} app  Obsidian App
 * @param {Function} [normalizePath]
 * @param {SkillRegistry} [skillRegistry]   omit to skip skill_invoke registration
 * @returns {ToolRegistry}
 */
function buildDefaultToolRegistry(app, normalizePath, skillRegistry) {
  const registry = new ToolRegistry();
  if (app && app.vault) {
    registry.register(createVaultReadTool({ vault: app.vault, normalizePath }));
    registry.register(createVaultListTool({ vault: app.vault, normalizePath }));
    registry.register(createVaultSearchTool({ vault: app.vault, normalizePath }));
    registry.register(createVaultEditTool({ vault: app.vault, normalizePath }));
    registry.register(createVaultWriteTool({ vault: app.vault, normalizePath }));
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
  registry.register(createAskUserTool());
  if (skillRegistry && typeof skillRegistry.list === "function") {
    registry.register(createSkillInvokeTool({ skillRegistry }));
  }
  return registry;
}

/**
 * Resolve where SKILL.md files live. We share the path with the legacy
 * SkillService (slash-command path) so the user never has to configure
 * the directory twice. Order:
 *   1. plugin.settings.skillsDir      (legacy + slash-command source of truth)
 *   2. DEFAULT_SKILL_ROOT             (.opencode/skills — back-compat default)
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
  const skillRoot = resolveSkillRoot(plugin);

  // Cache key: skill root string. Re-load if the user points elsewhere.
  if (plugin.__flownoteSkillCache && plugin.__flownoteSkillCache.root === skillRoot) {
    return plugin.__flownoteSkillCache.registry;
  }

  let manifests = [];
  try {
    manifests = await loadSkills({ rootPath: skillRoot, vault: plugin.app.vault });
  } catch (e) {
    manifests = [];
    if (typeof plugin.log === "function") {
      plugin.log(`[direct-agent] skill load failed for ${skillRoot}: ${e && e.message ? e.message : e}`);
    }
  }
  const registry = new SkillRegistry(manifests);
  plugin.__flownoteSkillCache = { root: skillRoot, registry };
  return registry;
}

/** Discard the cached SkillRegistry so the next turn reloads from disk. */
function invalidateSkillCache(plugin) {
  if (plugin) plugin.__flownoteSkillCache = null;
}

/**
 * Render the working set of assistant content blocks (text + tool calls)
 * as the "blocks" array the chat view already knows how to draw.
 *
 * View block shapes (matched to existing renderer):
 *   { type: 'stream-text', text }
 *   { type: 'tool', tool: <name>, status: 'running'|'done'|'error',
 *     input, output, durationMs }
 */
// Map our internal tool-use status to the chat view's renderer status.
// Renderer expects one of: 'pending' | 'running' | 'completed' | 'error'.
function toRendererStatus(status, isError) {
  if (isError) return "error";
  if (status === "running") return "running";
  if (status === "done") return "completed";
  if (status === "pending") return "pending";
  return "pending";
}

function summarizeToolInput(toolName, input) {
  if (!input || typeof input !== "object") return "";
  if (toolName === "vault_read") {
    const path = typeof input.path === "string" ? input.path : "";
    if (!path) return "";
    if (typeof input.offset === "number" || typeof input.limit === "number") {
      return `${path} (lines ${input.offset || 1}-${input.limit ? (input.offset || 1) + input.limit - 1 : "end"})`;
    }
    return path;
  }
  if (toolName === "vault_write") {
    const path = typeof input.path === "string" ? input.path : "";
    const mode = typeof input.mode === "string" ? input.mode : "create";
    return path ? `${mode} → ${path}` : mode;
  }
  if (toolName === "vault_edit") {
    return typeof input.path === "string" ? input.path : "";
  }
  if (toolName === "vault_list") {
    const path = typeof input.path === "string" && input.path ? input.path : "/";
    return input.pattern ? `${path} (${input.pattern})` : path;
  }
  if (toolName === "vault_search") {
    const q = typeof input.query === "string" ? input.query : "";
    return input.path ? `"${q}" in ${input.path}` : `"${q}"`;
  }
  if (toolName === "vault_daily") {
    const mode = typeof input.mode === "string" ? input.mode : "read";
    const date = typeof input.date === "string" ? input.date : "today";
    return `${mode} ${date}`;
  }
  if (toolName === "vault_property") {
    const op = typeof input.op === "string" ? input.op : "get";
    return `${op} ${input.name || "?"} → ${input.path || "?"}`;
  }
  if (toolName === "vault_backlinks") {
    return typeof input.path === "string" ? input.path : "";
  }
  if (toolName === "vault_tasks") {
    const status = typeof input.status === "string" ? input.status : "open";
    const path = typeof input.path === "string" && input.path ? input.path : "/";
    return `${status} in ${path}`;
  }
  if (toolName === "vault_tags") {
    const mode = typeof input.mode === "string" ? input.mode : "list";
    if (mode === "files") return `files ${input.tag || ""}`;
    return "list";
  }
  if (toolName === "vault_move") {
    const from = typeof input.from === "string" ? input.from : "?";
    const to = typeof input.to === "string" ? input.to : "?";
    return `${from} → ${to}`;
  }
  if (toolName === "vault_create_dir") {
    return typeof input.path === "string" ? input.path : "";
  }
  if (toolName === "vault_get_active_file") {
    return "";
  }
  if (toolName === "skill_invoke") {
    const skill = typeof input.skill === "string" ? input.skill : "";
    return input.args ? `${skill} ${input.args}` : skill;
  }
  if (toolName === "ask_user") {
    const qs = Array.isArray(input.questions) ? input.questions : [];
    return qs.length ? `${qs.length} question(s): ${qs[0].header || qs[0].question || ""}` : "";
  }
  try { return JSON.stringify(input).slice(0, 120); } catch { return ""; }
}

function renderBlocks(state) {
  const blocks = [];
  if (state.text && state.text.length > 0) {
    blocks.push({ type: "stream-text", text: state.text });
  }
  for (const tu of state.toolUses) {
    const status = toRendererStatus(tu.status, tu.isError);
    const summary = summarizeToolInput(tu.name, tu.input);
    const outputText = typeof tu.output === "string" ? tu.output : "";
    blocks.push({
      type: "tool",
      tool: tu.name,
      status,
      summary,
      detail: outputText,
      input: tu.input,
      output: outputText,
      isError: !!tu.isError,
      durationMs: tu.durationMs,
    });
  }
  return blocks;
}

/**
 * @param {Object} args
 * @param {Object} args.view                     chat view
 * @param {string} args.sessionId
 * @param {string} args.draftId
 * @param {string} args.userText                 the user's just-submitted text
 * @param {Object} args.handlers                 from createTransportHandlers
 * @param {AbortSignal} [args.signal]
 * @param {Function}    [args.requestImpl]       injection for tests
 * @param {ToolRegistry} [args.toolRegistryOverride] injection for tests
 * @param {Function}    [args.runAgentLoopImpl]  injection for tests
 * @returns {Promise<{messageId: string, text: string, reasoning: string, meta: string, blocks: Array}>}
 */
async function runDirectAgentTurn({
  view,
  sessionId,
  draftId,
  userText,
  handlers,
  signal,
  requestImpl,
  toolRegistryOverride,
  runAgentLoopImpl,
  skillRegistryOverride,
}) {
  const plugin = view.plugin;
  const settings = plugin.settings.agentProvider || {};

  // ---------------------------------------------------------------------
  // 1. Resolve Provider (will throw on missing key etc. — let it propagate)
  // ---------------------------------------------------------------------
  const provider = resolveAgentProvider(settings, { requestImpl });

  // ---------------------------------------------------------------------
  // 2. Load skills + build the tool registry against the live vault
  // ---------------------------------------------------------------------
  let normalizePath;
  try {
    // eslint-disable-next-line global-require
    normalizePath = require("obsidian").normalizePath;
  } catch (_e) {
    normalizePath = undefined;
  }
  const skillRegistry = skillRegistryOverride || (await ensureSkillRegistry(plugin));
  const registry = toolRegistryOverride || buildDefaultToolRegistry(view.app, normalizePath, skillRegistry);
  const vaultName = view.app && view.app.vault && typeof view.app.vault.getName === "function"
    ? String(view.app.vault.getName() || "")
    : "";
  const systemPrompt = buildSystemPrompt(
    skillRegistry.list ? skillRegistry.list() : [],
    { todayLabel: describeToday(), vaultName },
  );

  // ---------------------------------------------------------------------
  // 3. Build the conversation
  // ---------------------------------------------------------------------
  const stored = (plugin.sessionStore && typeof plugin.sessionStore.getActiveMessages === "function")
    ? plugin.sessionStore.getActiveMessages()
    : [];
  const history = buildAnthropicHistory(stored, draftId);
  // buildAnthropicHistory drops the most recent user message because
  // that's the raw version from the session store. Append the composed
  // userText (which the orchestrator built via composePromptWithLinkedFiles
  // and skill injection) as the actual current turn.
  history.push({ role: "user", content: [{ type: "text", text: String(userText || "") }] });

  // ---------------------------------------------------------------------
  // 4. Translate agent-loop events → chat handler calls
  // ---------------------------------------------------------------------
  /** @type {{text: string, toolUses: Array<{id:string,name:string,input:any,status:string,output:any,isError:boolean,startedAt:number,durationMs:number}>}} */
  const state = { text: "", toolUses: [] };
  let stopReason = null;

  function findToolUse(toolUseId) {
    return state.toolUses.find((t) => t.id === toolUseId);
  }

  function pushBlocksUpdate() {
    if (handlers && typeof handlers.onBlocks === "function") {
      handlers.onBlocks(renderBlocks(state));
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
    };
    try {
      const decision = await handlers.onPermissionRequest(permObj);
      if (decision === "always") return { behavior: "allow", persist: "session" };
      if (decision === "once")   return { behavior: "allow" };
      return { behavior: "deny" };
    } catch (e) {
      log(`permission ask failed: ${e instanceof Error ? e.message : String(e)}`);
      return { behavior: "deny" };
    }
  }

  // ask_user bridge: the tool yields a question payload; we surface it
  // through the handlers.onAskUser callback the chat view installs. If
  // that callback is missing, the tool itself returns an error result —
  // the model handles graceful fallback.
  async function askUserFn(payload) {
    if (!handlers || typeof handlers.onAskUser !== "function") {
      throw new Error("no onAskUser handler installed");
    }
    return await handlers.onAskUser(payload);
  }

  const loopImpl = runAgentLoopImpl || runAgentLoop;
  const log = (msg) => {
    if (plugin && typeof plugin.log === "function") plugin.log(`[direct-agent] ${msg}`);
  };

  // Use the active model's maxOutput as the per-turn output cap. This
  // is a ceiling, not a target — the model only generates what it
  // generates. Setting it to the model's hard limit gives the longest
  // possible response when the user actually needs it.
  //
  // Resolution order:
  //   1. settings.direct.maxOutputTokens (user override; if non-positive
  //      it's treated as "use model default")
  //   2. provider.spec.models[].maxOutput for the active model
  //   3. fallback constant (16K — safe across all providers)
  const activeModelInfo = (provider.spec.models || []).find((m) => m && m.id === provider.userConfig.model);
  const userMaxOutput = settings && settings.direct && Number(settings.direct.maxOutputTokens);
  const maxTokensPerTurn = (Number.isFinite(userMaxOutput) && userMaxOutput > 0)
    ? userMaxOutput
    : ((activeModelInfo && activeModelInfo.maxOutput) || 16_384);

  log(`turn start provider=${provider.id} model=${provider.userConfig.model} historyLen=${history.length} maxOutput=${maxTokensPerTurn}`);
  // Diagnostic: dump the actual user-turn text being sent to the model.
  // First 600 chars are enough to spot whether <<<FLOWNOTE_FILE>>> tags
  // landed in there.
  try {
    const lastUserMsg = history[history.length - 1];
    if (lastUserMsg && lastUserMsg.role === "user" && Array.isArray(lastUserMsg.content)) {
      const textJoined = lastUserMsg.content
        .filter((b) => b && b.type === "text")
        .map((b) => String(b.text || ""))
        .join("\n");
      const head = textJoined.slice(0, 600).replace(/\n/g, " ⏎ ");
      log(`outgoing user text len=${textJoined.length} head="${head}"`);
      const hasFileTag = /<<<FLOWNOTE_FILE\s+path="/.test(textJoined);
      log(`outgoing user text has FLOWNOTE_FILE tag=${hasFileTag}`);
    }
  } catch (e) {
    log(`diagnostic log failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Per-turn FileStateCache — tracks every file the agent reads or
  // writes during this conversation turn. Used by vault_edit to enforce
  // read-before-edit, and by vault_backlinks to sidestep metadataCache
  // reindex lag. Fresh instance each turn so stale state can't leak.
  const fileStateCache = new FileStateCache();

  for await (const ev of loopImpl({
    provider,
    registry,
    system: systemPrompt,
    messages: history,
    maxTokensPerTurn,
    signal,
    ctx: { app: view.app, grants: {}, askUserFn, fileStateCache },
    onPermissionAsk,
  })) {
    if (!ev) continue;
    switch (ev.type) {
      case "stream": {
        const inner = ev.event;
        if (!inner) break;
        if (inner.type === "content_block_delta" && inner.delta && inner.delta.type === "text_delta") {
          state.text += inner.delta.text || "";
          if (handlers && typeof handlers.onToken === "function") {
            handlers.onToken(state.text);
          }
        }
        if (inner.type === "message_delta" && inner.delta && typeof inner.delta.stop_reason === "string") {
          stopReason = inner.delta.stop_reason;
        }
        break;
      }
      case "tool_start": {
        log(`tool_start ${ev.tool} input=${summarizeToolInput(ev.tool, ev.input)}`);
        state.toolUses.push({
          id: ev.toolUseId,
          name: ev.tool,
          input: ev.input,
          status: "running",
          output: "",
          isError: false,
          startedAt: Date.now(),
          durationMs: 0,
        });
        pushBlocksUpdate();
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
          t.durationMs = Date.now() - t.startedAt;
          log(`tool_finish ${ev.tool} status=${t.status} ms=${t.durationMs}`);
        }
        pushBlocksUpdate();
        break;
      }
      case "turn_complete": {
        log(`turn ${ev.turnIndex} complete stop=${ev.stopReason || "?"} textLen=${state.text.length} toolsSoFar=${state.toolUses.length}`);
        break;
      }
      case "done":
        // loop signaled completion; exit the for-await
        break;
      case "error": {
        const err = ev.error || {};
        const message = err.message || err.type || "Agent runtime error.";
        log(`error ${err.type || ""} ${message}`);
        const wrapped = new Error(message);
        if (err.type) wrapped.code = err.type;
        throw wrapped;
      }
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------
  // 5. Compose final response in the shape sendMessage returns
  // ---------------------------------------------------------------------
  log(`turn end stop=${stopReason || "?"} textLen=${state.text.length} tools=${state.toolUses.length}`);
  // Per-tool summary so reading the trace file later tells you exactly
  // what fired this turn. Format: name(status,Nbytes) — easy to scan
  // for "the model claimed 3 files but only 1 tool ran".
  if (state.toolUses.length > 0) {
    const summary = state.toolUses.map((t) => {
      const sz = typeof t.output === "string" ? t.output.length : 0;
      const status = t.isError ? "ERR" : (t.status || "?");
      return `${t.name}(${status},${sz}b)`;
    }).join(" ");
    log(`turn tool summary: ${summary}`);
  } else {
    log("turn tool summary: <no tool calls this turn>");
  }
  // Diagnostic only: flag turns where the assistant produced text but
  // no destructive tool call fired. Keeps the file trace useful for
  // post-mortem without forcing the model to read regex rules. Behavior
  // is unchanged either way — this is logged, not enforced.
  const hadDestructiveCall = state.toolUses.some((t) =>
    /^(vault_write|vault_edit|vault_move|vault_property|vault_daily|vault_create_dir)$/.test(t.name) && !t.isError,
  );
  if (state.text.length > 200 && !hadDestructiveCall && state.toolUses.length === 0) {
    log(`turn note: long text response with no tool calls (textLen=${state.text.length}). Verify if model claimed actions.`);
  }

  // If the model ran out of output budget before producing anything
  // useful, surface a clear message instead of a silent empty bubble.
  let finalText = state.text;
  if (!finalText && stopReason === "max_tokens") {
    finalText = (
      "⚠️ 模型在还没产生输出之前就用尽了本轮的输出额度。\n\n" +
      "已经按当前模型（" + (activeModelInfo ? activeModelInfo.label : provider.userConfig.model) +
      "）的硬上限 " + maxTokensPerTurn + " tokens 请求，超过这个就是该模型的固有限制。\n\n" +
      "建议：\n" +
      "• 换支持更大输出的模型（如 DeepSeek V4 Flash/Pro 支持 384K 输出）\n" +
      "• 拆分任务：先让模型只输出 [总结部分]，再单独写回文件"
    );
  }

  const finalBlocks = renderBlocks(state);
  // Replace the streaming text block (if any) with the final text so the
  // UI shows the friendly max_tokens warning when appropriate.
  if (finalText !== state.text) {
    const idx = finalBlocks.findIndex((b) => b.type === "stream-text");
    if (idx >= 0) finalBlocks[idx] = { type: "stream-text", text: finalText };
    else finalBlocks.unshift({ type: "stream-text", text: finalText });
  }
  const meta = composeMetaLine(provider, stopReason, state);
  return {
    messageId: `direct-${Date.now()}`,
    text: finalText,
    reasoning: "",
    meta,
    blocks: finalBlocks,
  };
}

function composeMetaLine(provider, stopReason, state) {
  const parts = [];
  const spec = provider && provider.spec;
  const model = provider && provider.userConfig && provider.userConfig.model;
  if (spec && spec.displayName) parts.push(spec.displayName);
  if (model) parts.push(model);
  if (state.toolUses.length > 0) parts.push(`tools=${state.toolUses.length}`);
  if (stopReason && stopReason !== "end_turn") parts.push(`stop=${stopReason}`);
  return parts.join(" · ");
}

module.exports = {
  runDirectAgentTurn,
  buildAnthropicHistory,
  buildDefaultToolRegistry,
  buildSystemPrompt,
  ensureSkillRegistry,
  invalidateSkillCache,
  getLocalISODate,
  describeToday,
  DEFAULT_SKILL_ROOT,
};
