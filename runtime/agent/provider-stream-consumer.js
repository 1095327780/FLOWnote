// Provider-neutral stream protocol validation and accumulation.
//
// This module owns the boundary between raw provider events and the agent
// loop. It never executes tools or mutates conversation state.

async function* consumeStreamGenerator(stream, uiAdapter) {
  const slots = [];
  const toolUseBuffers = [];
  let stopReason = null;
  let fatalError = null;
  let sawMessageStart = false;
  let sawMessageStop = false;
  const openBlocks = new Set();
  const seenToolUseIds = new Set();

  const failProtocol = (type, message) => {
    if (!fatalError) fatalError = { type, message };
  };

  for await (const ev of stream) {
    if (uiAdapter) {
      for (const out of uiAdapter(ev)) yield { kind: "ui", event: out };
    }

    if (!ev || typeof ev !== "object") continue;

    if (ev.type === "error") {
      fatalError = ev.error || { type: "unknown_error" };
      continue;
    }

    if (ev.type === "message_start") {
      if (sawMessageStart) {
        failProtocol("invalid_provider_stream", "Provider emitted more than one message_start event.");
      }
      sawMessageStart = true;
      continue;
    }

    if (ev.type === "content_block_start") {
      if (!Number.isInteger(ev.index) || ev.index < 0) {
        failProtocol("invalid_provider_stream", `Provider emitted an invalid content block index: ${String(ev.index)}.`);
        continue;
      }
      if (slots[ev.index] || openBlocks.has(ev.index)) {
        failProtocol("invalid_provider_stream", `Provider reused content block index ${ev.index}.`);
        continue;
      }
      const block = { ...(ev.content_block || {}) };
      slots[ev.index] = block;
      openBlocks.add(ev.index);
      if (block.type === "tool_use") {
        if (typeof block.id !== "string" || !block.id.trim()) {
          failProtocol("invalid_tool_call", `Tool call at block ${ev.index} has no id.`);
        } else if (seenToolUseIds.has(block.id)) {
          failProtocol("invalid_tool_call", `Provider reused tool call id ${block.id}.`);
        } else {
          seenToolUseIds.add(block.id);
        }
        if (typeof block.name !== "string" || !block.name.trim()) {
          failProtocol("invalid_tool_call", `Tool call ${block.id || `at block ${ev.index}`} has no tool name.`);
        }
        toolUseBuffers[ev.index] = { partialJson: "" };
        if (block.input === undefined || block.input === null) block.input = {};
      }
      continue;
    }

    if (ev.type === "content_block_delta" && ev.delta) {
      const slot = slots[ev.index];
      if (!slot || !openBlocks.has(ev.index)) {
        failProtocol("invalid_provider_stream", `Provider emitted a delta for unopened content block ${String(ev.index)}.`);
        continue;
      }
      if (slot.type === "text" && ev.delta.type === "text_delta") {
        slot.text = (slot.text || "") + (ev.delta.text || "");
      } else if (slot.type === "tool_use" && ev.delta.type === "input_json_delta") {
        const buffer = toolUseBuffers[ev.index];
        if (buffer) buffer.partialJson += ev.delta.partial_json || "";
      } else if (slot.type === "tool_use" && ev.delta.type === "tool_metadata_delta") {
        if (ev.delta.extra_content !== undefined) slot.extra_content = ev.delta.extra_content;
      }
      continue;
    }

    if (ev.type === "content_block_stop") {
      const slot = slots[ev.index];
      if (!slot || !openBlocks.has(ev.index)) {
        failProtocol("invalid_provider_stream", `Provider stopped unopened content block ${String(ev.index)}.`);
        continue;
      }
      if (slot.type === "tool_use") {
        const buffer = toolUseBuffers[ev.index];
        if (buffer && buffer.partialJson) {
          try { slot.input = JSON.parse(buffer.partialJson); }
          catch {
            failProtocol(
              "invalid_tool_arguments",
              `Tool call ${slot.id || `at block ${ev.index}`} ended with malformed JSON arguments.`,
            );
            slot.invalid = true;
          }
        } else if (slot.input === undefined) {
          slot.input = {};
        }
      }
      openBlocks.delete(ev.index);
      continue;
    }

    if (ev.type === "message_delta" && ev.delta && typeof ev.delta.stop_reason === "string") {
      stopReason = ev.delta.stop_reason;
      continue;
    }

    if (ev.type === "message_stop") {
      sawMessageStop = true;
      if (openBlocks.size > 0) {
        failProtocol("incomplete_provider_stream", "Provider stopped the message before all content blocks were closed.");
      }
    }
  }

  if (!sawMessageStart) {
    failProtocol("incomplete_provider_stream", "Provider stream ended without message_start.");
  } else if (!sawMessageStop) {
    failProtocol("incomplete_provider_stream", "Provider stream ended without message_stop.");
  }

  const assistantContent = slots.filter(Boolean).map((block) => {
    if (block.type === "tool_use") {
      const { type, id, name, input } = block;
      const out = { type, id, name, input };
      if (block.extra_content !== undefined) out.extra_content = block.extra_content;
      return out;
    }
    return block;
  });
  const toolUses = fatalError
    ? []
    : assistantContent.filter((block) => block.type === "tool_use" && !block.invalid);

  if (!fatalError && stopReason === "tool_use" && toolUses.length === 0) {
    failProtocol("missing_tool_call", "Provider reported tool_use but emitted no complete tool call.");
  }
  if (!fatalError && stopReason === "max_tokens") {
    failProtocol("incomplete_model_output", "Model output reached the token limit and cannot be treated as complete.");
  }

  yield {
    kind: "final",
    state: { assistantContent, toolUses, stopReason, fatalError, uiEvents: [] },
  };
}

async function consumeStream(stream, uiAdapter) {
  const uiEvents = [];
  let state = null;
  for await (const item of consumeStreamGenerator(stream, uiAdapter)) {
    if (!item) continue;
    if (item.kind === "ui") uiEvents.push(item.event);
    else if (item.kind === "final") state = item.state;
  }
  if (!state) state = { assistantContent: [], toolUses: [], stopReason: null, fatalError: null };
  return { ...state, uiEvents };
}

module.exports = { consumeStream, consumeStreamGenerator };
