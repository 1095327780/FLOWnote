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
const { resolveAgentProvider } = require("../agent/agent-provider-resolver");
const { getActiveApiKey } = require("../agent/agent-settings");
const { getProviderSpec } = require("../providers/registry");

const DEFAULT_SYSTEM_PROMPT = [
  "You are FLOWnote, an AI assistant running inside Obsidian. The user's notes live in an Obsidian vault.",
  "",
  "You have these tools available:",
  "  • vault_read  — read a markdown note. Pass the vault-relative path (e.g. \"daily/2026-05-15.md\").",
  "                  Supports optional offset/limit to slice long files.",
  "  • vault_write — create / overwrite / append text in the vault. Pass `path`, `content`, and `mode`:",
  "                    mode=\"create\"    → fails if the file already exists",
  "                    mode=\"overwrite\" → replace existing content (use this to edit a file)",
  "                    mode=\"append\"   → add to the end",
  "",
  "Core rules:",
  "  1. ALWAYS call the tools to do file operations. Do NOT just describe what you would write — actually call vault_write.",
  "  2. When the user attaches files, they appear in the conversation wrapped like this:",
  "       <<<FLOWNOTE_FILE path=\"some/path.md\">>>",
  "       ...file contents...",
  "       <<<END_FLOWNOTE_FILE>>>",
  "     The `path` attribute is the REAL vault path. Use it directly when calling vault_read or vault_write.",
  "  3. To edit a file: call vault_read first if you don't already have the latest content; then call vault_write with mode=\"overwrite\" passing the FULL new content (no partial edits in this version).",
  "  4. Reply in the same language the user used. Be concise.",
  "  5. If you finish without needing tools, respond naturally with text only.",
].join("\n");

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
 * Build the tool registry the agent loop runs with. v0.5.0 ships
 * vault_read + vault_write; the rest land in M2.
 *
 * @param {Object} app  Obsidian App
 * @param {Function} [normalizePath]
 * @returns {ToolRegistry}
 */
function buildDefaultToolRegistry(app, normalizePath) {
  const registry = new ToolRegistry();
  if (app && app.vault) {
    registry.register(createVaultReadTool({ vault: app.vault, normalizePath }));
    registry.register(createVaultWriteTool({ vault: app.vault, normalizePath }));
  }
  return registry;
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
  if (toolName === "vault_read" || toolName === "vault_write") {
    const path = typeof input.path === "string" ? input.path : "";
    if (!path) return "";
    if (toolName === "vault_write") {
      const mode = typeof input.mode === "string" ? input.mode : "create";
      return `${mode} → ${path}`;
    }
    if (typeof input.offset === "number" || typeof input.limit === "number") {
      return `${path} (lines ${input.offset || 1}-${input.limit ? (input.offset || 1) + input.limit - 1 : "end"})`;
    }
    return path;
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
}) {
  const plugin = view.plugin;
  const settings = plugin.settings.agentProvider || {};

  // ---------------------------------------------------------------------
  // 1. Resolve Provider (will throw on missing key etc. — let it propagate)
  // ---------------------------------------------------------------------
  const provider = resolveAgentProvider(settings, { requestImpl });

  // ---------------------------------------------------------------------
  // 2. Build the tool registry against the live vault
  // ---------------------------------------------------------------------
  let normalizePath;
  try {
    // eslint-disable-next-line global-require
    normalizePath = require("obsidian").normalizePath;
  } catch (_e) {
    normalizePath = undefined;
  }
  const registry = toolRegistryOverride || buildDefaultToolRegistry(view.app, normalizePath);

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

  for await (const ev of loopImpl({
    provider,
    registry,
    system: DEFAULT_SYSTEM_PROMPT,
    messages: history,
    maxTokensPerTurn,
    signal,
    ctx: { app: view.app, grants: {} },
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
};
