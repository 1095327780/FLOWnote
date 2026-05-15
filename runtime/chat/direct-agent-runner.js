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

/**
 * Convert the session store's plain {role,text} messages into the
 * Anthropic-shape conversation the agent loop expects.
 *
 * Drops the current draft (still pending) and the just-pushed user
 * message — the user message is passed back separately as the "current
 * turn input" so the loop can re-build the conversation cleanly.
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
function renderBlocks(state) {
  const blocks = [];
  if (state.text && state.text.length > 0) {
    blocks.push({ type: "stream-text", text: state.text });
  }
  for (const tu of state.toolUses) {
    blocks.push({
      type: "tool",
      tool: tu.name,
      status: tu.status,
      input: tu.input,
      output: tu.output,
      isError: tu.isError,
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
  // Add the current user turn at the end. The session store already
  // contains it (we just pushed it in mountPendingDraft), but we filter
  // for non-pending plus explicit text — relying on history alone is
  // safe.
  if (!history.length || history[history.length - 1].role !== "user") {
    history.push({ role: "user", content: [{ type: "text", text: String(userText || "") }] });
  }

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
    const decision = await handlers.onPermissionRequest({
      tool: req.tool,
      input: req.input,
      summary: req.summary,
    });
    if (decision === "always") return { behavior: "allow", persist: "session" };
    if (decision === "once")   return { behavior: "allow" };
    return { behavior: "deny" };
  }

  const loopImpl = runAgentLoopImpl || runAgentLoop;

  for await (const ev of loopImpl({
    provider,
    registry,
    messages: history,
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
          // Progress message currently displayed as part of output —
          // the chat view's tool card will render this as a status note.
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
        }
        pushBlocksUpdate();
        break;
      }
      case "turn_complete":
        // intentional no-op — we only finalize at 'done'
        break;
      case "done":
        // loop signaled completion; exit the for-await
        break;
      case "error": {
        const err = ev.error || {};
        const message = err.message || err.type || "Agent runtime error.";
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
  const finalBlocks = renderBlocks(state);
  const meta = composeMetaLine(provider, stopReason, state);
  return {
    messageId: `direct-${Date.now()}`,
    text: state.text,
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
