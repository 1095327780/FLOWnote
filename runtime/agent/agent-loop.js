// Agent loop — the conductor.
//
// Takes a Provider, a tool registry, the conversation so far, and runs
// turn-by-turn until the model returns a stop_reason other than
// `tool_use`. Yields a single stream of events for the UI:
//
//   - { type: 'stream', event: <ProviderStreamEvent> }   passthrough
//   - { type: 'tool_progress', tool, message?, data? }   from tool execute()
//   - { type: 'tool_start',    tool, toolUseId, input } before execute
//   - { type: 'tool_finish',   tool, toolUseId, isError, content }
//   - { type: 'turn_complete', turnIndex, stopReason }
//   - { type: 'done',          turns }
//   - { type: 'error',         error }
//
// No Obsidian dependencies. Tests use a MockProvider that scripts a
// canned event stream and a ToolRegistry pre-populated with fakes.

const DEFAULT_MAX_TURNS = 20;
// 16384 fits comfortably within every supported provider's per-response
// output cap (DeepSeek V4: 384K, Claude: 64K, GLM/Kimi/MiniMax all 8K+),
// while being roomy enough for vault_write turns that have to emit the
// full new file content as tool input JSON.
const DEFAULT_MAX_TOKENS_PER_TURN = 16384;

/**
 * @param {Object} args
 * @param {import('../providers/provider').Provider} args.provider
 * @param {import('./tool-registry').ToolRegistry}    args.registry
 * @param {string | Array}                            [args.system]
 * @param {Array}                                     args.messages
 *   Anthropic-shape conversation so far. The loop does NOT append the
 *   caller's most recent user message — the caller is responsible for
 *   doing that. The loop only appends what the model produces and the
 *   tool results.
 * @param {number}                                    [args.maxTurns]
 * @param {number}                                    [args.maxTokensPerTurn]
 * @param {number}                                    [args.temperature]
 * @param {AbortSignal}                               [args.signal]
 * @param {Object}                                    [args.ctx]
 *   Threaded into every tool's validate / checkPermissions / execute.
 *   Carries things like `grants`, `app` reference, abort, etc.
 * @param {(ask: Object) => Promise<{behavior:'allow'|'deny', persist?:'once'|'session'}>} [args.onPermissionAsk]
 *   Called when a tool's checkPermissions returns 'ask'. Default denies.
 * @returns {AsyncGenerator<Object>}
 */
async function* runAgentLoop(args) {
  const {
    provider,
    registry,
    system,
    messages,
    maxTurns = DEFAULT_MAX_TURNS,
    maxTokensPerTurn = DEFAULT_MAX_TOKENS_PER_TURN,
    temperature,
    signal,
    ctx = {},
    onPermissionAsk,
  } = args;

  if (!provider || typeof provider.createMessage !== "function") {
    throw new Error("runAgentLoop: provider with createMessage required");
  }
  if (!registry || typeof registry.list !== "function") {
    throw new Error("runAgentLoop: registry required");
  }
  if (!Array.isArray(messages)) {
    throw new Error("runAgentLoop: messages array required");
  }

  const conversation = messages.slice();
  const model = (provider.userConfig && provider.userConfig.model) || (provider.spec && provider.spec.defaultModel);
  const toolSpecs = registry.toApiSpecs();
  const askFn = typeof onPermissionAsk === "function" ? onPermissionAsk : null;

  for (let turn = 0; turn < maxTurns; turn++) {
    const input = {
      model,
      // Snapshot the conversation so providers / tests see the
      // immutable state of this turn even if the loop keeps appending.
      messages: conversation.slice(),
      maxTokens: maxTokensPerTurn,
    };
    if (system !== undefined) input.system = system;
    if (toolSpecs.length > 0) input.tools = toolSpecs;
    if (typeof temperature === "number") input.temperature = temperature;
    if (signal) input.signal = signal;

    const streamResult = await consumeStream(provider.createMessage(input), function* (ev) {
      yield { type: "stream", event: ev };
    });
    // Forward all events that consumeStream emitted while it ran.
    for (const ev of streamResult.uiEvents) yield ev;

    if (streamResult.fatalError) {
      yield { type: "error", error: streamResult.fatalError };
      return;
    }

    conversation.push({ role: "assistant", content: streamResult.assistantContent });

    if (streamResult.toolUses.length === 0 || streamResult.stopReason !== "tool_use") {
      yield { type: "turn_complete", turnIndex: turn, stopReason: streamResult.stopReason };
      yield { type: "done", turns: turn + 1 };
      return;
    }

    // Split tool_uses by concurrency: read-only/concurrency-safe → parallel.
    const parallel = [];
    const serial = [];
    for (const tu of streamResult.toolUses) {
      const tool = registry.get(tu.name);
      const isSafe = tool && (
        (typeof tool.isConcurrencySafe === "function" && tool.isConcurrencySafe(tu.input)) ||
        (typeof tool.isReadOnly === "function" && tool.isReadOnly(tu.input))
      );
      (isSafe ? parallel : serial).push(tu);
    }

    /** @type {Array<{id:string,content:string,isError:boolean,progress:Array<Object>}>} */
    const allResults = [];

    if (parallel.length > 0) {
      const settled = await Promise.all(parallel.map((tu) => runToolUse(tu, registry, ctx, askFn)));
      for (const r of settled) allResults.push(r);
    }
    for (const tu of serial) {
      const r = await runToolUse(tu, registry, ctx, askFn);
      allResults.push(r);
    }

    // Stream tool_start / progress / tool_finish events in tool_use order.
    for (const tu of streamResult.toolUses) {
      const r = allResults.find((x) => x.id === tu.id);
      yield { type: "tool_start", tool: tu.name, toolUseId: tu.id, input: tu.input };
      for (const p of r.progress) {
        yield { type: "tool_progress", tool: tu.name, message: p.message, data: p.data };
      }
      yield { type: "tool_finish", tool: tu.name, toolUseId: tu.id, isError: r.isError, content: r.content };
    }

    const toolResultBlocks = streamResult.toolUses.map((tu) => {
      const r = allResults.find((x) => x.id === tu.id);
      return {
        type: "tool_result",
        tool_use_id: tu.id,
        content: r.content,
        is_error: r.isError,
      };
    });
    conversation.push({ role: "user", content: toolResultBlocks });

    yield { type: "turn_complete", turnIndex: turn, stopReason: streamResult.stopReason };
  }

  yield {
    type: "error",
    error: { type: "max_turns_exceeded", message: `Hit ${maxTurns} turn budget; pausing.` },
  };
}

/**
 * Drive a provider stream to completion, accumulating the assistant
 * message content and any tool_use blocks.
 *
 * @param {AsyncIterable<Object>} stream
 * @param {(ev: Object) => Iterable<Object>} uiAdapter
 * @returns {Promise<{ assistantContent: Array, toolUses: Array, stopReason: string | null, fatalError: Object | null, uiEvents: Array }>}
 */
async function consumeStream(stream, uiAdapter) {
  /** @type {Array<any>} */
  const slots = [];
  /** @type {Array<{ partialJson: string }>} */
  const toolUseBuffers = [];
  /** @type {string | null} */
  let stopReason = null;
  /** @type {Object | null} */
  let fatalError = null;
  /** @type {Array<Object>} */
  const uiEvents = [];

  for await (const ev of stream) {
    if (uiAdapter) {
      for (const out of uiAdapter(ev)) uiEvents.push(out);
    }

    if (!ev || typeof ev !== "object") continue;

    if (ev.type === "error") {
      fatalError = ev.error || { type: "unknown_error" };
      continue;
    }

    if (ev.type === "content_block_start") {
      const block = { ...(ev.content_block || {}) };
      slots[ev.index] = block;
      if (block.type === "tool_use") {
        toolUseBuffers[ev.index] = { partialJson: "" };
        if (block.input === undefined || block.input === null) block.input = {};
      }
      continue;
    }

    if (ev.type === "content_block_delta" && ev.delta) {
      const slot = slots[ev.index];
      if (!slot) continue;
      if (slot.type === "text" && ev.delta.type === "text_delta") {
        slot.text = (slot.text || "") + (ev.delta.text || "");
      } else if (slot.type === "tool_use" && ev.delta.type === "input_json_delta") {
        const buf = toolUseBuffers[ev.index];
        if (buf) buf.partialJson += ev.delta.partial_json || "";
      }
      continue;
    }

    if (ev.type === "content_block_stop") {
      const slot = slots[ev.index];
      if (!slot) continue;
      if (slot.type === "tool_use") {
        const buf = toolUseBuffers[ev.index];
        if (buf && buf.partialJson) {
          try {
            slot.input = JSON.parse(buf.partialJson);
          } catch {
            slot.input = {};
          }
        } else if (slot.input === undefined) {
          slot.input = {};
        }
      }
      continue;
    }

    if (ev.type === "message_delta" && ev.delta && typeof ev.delta.stop_reason === "string") {
      stopReason = ev.delta.stop_reason;
      continue;
    }
  }

  const assistantContent = slots.filter(Boolean).map((b) => {
    if (b.type === "tool_use") {
      // Anthropic shape doesn't include partialJson — drop any helpers we added.
      const { type, id, name, input } = b;
      return { type, id, name, input };
    }
    return b;
  });
  const toolUses = assistantContent.filter((b) => b.type === "tool_use");

  return { assistantContent, toolUses, stopReason, fatalError, uiEvents };
}

/**
 * Validate, permission-gate, and execute one tool_use. Always resolves
 * (never throws) — tool errors become is_error: true tool results so
 * the model can react.
 *
 * @param {{ id: string, name: string, input: any }} tu
 * @param {import('./tool-registry').ToolRegistry} registry
 * @param {Object} ctx
 * @param {Function | null} askFn
 * @returns {Promise<{ id: string, content: string, isError: boolean, progress: Array<{message: string, data: any}> }>}
 */
async function runToolUse(tu, registry, ctx, askFn) {
  const result = { id: tu.id, content: "", isError: false, progress: [] };
  const tool = registry.get(tu.name);
  if (!tool) {
    result.isError = true;
    result.content = `Unknown tool: ${tu.name}`;
    return result;
  }

  // 1. validate
  try {
    const v = await tool.validate(tu.input, ctx);
    if (v && v.ok === false) {
      result.isError = true;
      result.content = `Invalid input for ${tu.name}: ${v.error || "validation failed"}`;
      return result;
    }
  } catch (e) {
    result.isError = true;
    result.content = `Validation crashed for ${tu.name}: ${errMsg(e)}`;
    return result;
  }

  // 2. permission gate
  try {
    const p = await tool.checkPermissions(tu.input, ctx);
    if (p && p.behavior === "deny") {
      result.isError = true;
      result.content = `Permission denied for ${tu.name}${p.reason ? `: ${p.reason}` : ""}.`;
      return result;
    }
    if (p && p.behavior === "ask") {
      if (!askFn) {
        result.isError = true;
        result.content = `Permission required for ${tu.name}, but no askFn configured.`;
        return result;
      }
      const decision = await askFn({ tool: tu.name, input: tu.input, ...p });
      if (!decision || decision.behavior !== "allow") {
        result.isError = true;
        result.content = `User denied ${tu.name}.`;
        return result;
      }
      if (decision.persist === "session") {
        if (!ctx.grants) ctx.grants = {};
        ctx.grants[`${tu.name}:*`] = "session";
      }
    }
  } catch (e) {
    result.isError = true;
    result.content = `Permission check crashed for ${tu.name}: ${errMsg(e)}`;
    return result;
  }

  // 3. execute
  try {
    let last = null;
    for await (const out of tool.execute(tu.input, ctx)) {
      if (!out || typeof out !== "object") continue;
      if (out.type === "progress") {
        result.progress.push({ message: out.message || "", data: out.data });
      } else if (out.type === "result") {
        last = out;
      }
    }
    if (last) {
      result.content = stringifyContent(last.content);
      result.isError = !!last.isError;
    } else {
      result.content = `${tu.name} returned no result.`;
      result.isError = true;
    }
  } catch (e) {
    result.isError = true;
    result.content = `${tu.name} crashed: ${errMsg(e)}`;
  }
  return result;
}

function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

function stringifyContent(c) {
  if (typeof c === "string") return c;
  if (c === null || c === undefined) return "";
  try { return JSON.stringify(c); } catch { return String(c); }
}

module.exports = {
  runAgentLoop,
  consumeStream,
  runToolUse,
  DEFAULT_MAX_TURNS,
  DEFAULT_MAX_TOKENS_PER_TURN,
};
