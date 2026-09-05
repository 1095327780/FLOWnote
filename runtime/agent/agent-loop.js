// Agent loop — the conductor.
//
// Takes a Provider, a tool registry, the conversation so far, and runs
// turn-by-turn until the task contract is satisfied and the model returns no
// tool_use blocks. Some providers
// misreport stop_reason even when a tool_use block was streamed, so the
// actual content blocks are the source of truth. Yields a single stream of
// events for the UI:
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

// Productive workflows are not bounded by an arbitrary number of model
// turns. Callers may still provide a positive maxTurns as an operational
// boundary; reaching it produces a resumable suspension checkpoint.
const DEFAULT_MAX_TURNS = null;
const DEFAULT_MAX_REPEATED_TURNS = 4;
const DEFAULT_MAX_COMPLETION_RETRIES = 1;
const { resolveToolCapabilities } = require("./tool-registry");
const {
  normalizeToolPermissionMode,
  resolvePermissionDecision,
} = require("./permission-policy");
const { createContinuationCheckpoint } = require("./continuation-checkpoint");
const { prepareContextWindow } = require("./context-budget-manager");
const { normalizeEffectAttempts } = require("./effect-attempt-ledger");
const { consumeStream, consumeStreamGenerator } = require("./provider-stream-consumer");
const {
  normalizeAllowedToolPolicy,
  applySkillAllowedTools,
  toolIsAllowed,
  visibleToolSpecs,
} = require("./skill-tool-policy");
// 16384 fits comfortably within every supported provider's per-response
// output cap (DeepSeek V4: 384K, Claude: 64K, GLM/Kimi/MiniMax all 8K+),
// while being roomy enough for vault_write turns that have to emit the
// full new file content as tool input JSON.
const DEFAULT_MAX_TOKENS_PER_TURN = 16384;
const RECOVERABLE_PROVIDER_STREAM_CODES = new Set([
  "PROVIDER_STREAM_IDLE_TIMEOUT",
  "PROVIDER_STREAM_READ_FAILED",
]);

function isRecoverableProviderStreamInterruption(error) {
  if (!error || typeof error !== "object") return false;
  if (error.recoverable === true && error.replaySafe !== true) return true;
  return RECOVERABLE_PROVIDER_STREAM_CODES.has(String(error.code || "").trim());
}

function assistantContentHasText(content) {
  const blocks = Array.isArray(content) ? content : [];
  return blocks.some((block) => (
    block
    && block.type === "text"
    && typeof block.text === "string"
    && block.text.trim().length > 0
  ));
}

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
 * @param {number|null}                               [args.maxTurns]
 * @param {number}                                    [args.maxTokensPerTurn]
 * @param {number}                                    [args.temperature]
 * @param {{id?:string,mode:'answer'|'inspect'|'effect',requiredEffects?:Array}} [args.executionContract]
 * @param {number}                                    [args.maxCompletionRetries]
 * @param {number|null}                               [args.maxRepeatedTurns]
 * @param {{effectReceipts?:Array,interactionReceipts?:Array,completionRetries?:number,turns?:number}} [args.resumeState]
 * @param {string[]|{allowedTools:string[]}} [args.allowedToolPolicy]
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
    executionContract,
    maxCompletionRetries = DEFAULT_MAX_COMPLETION_RETRIES,
    maxRepeatedTurns = DEFAULT_MAX_REPEATED_TURNS,
    resumeState,
    allowedToolPolicy,
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
  if (
    executionContract
    && executionContract.mode === "workflow"
    && executionContract.completionPolicyState === "invalid"
  ) {
    yield {
      type: "error",
      error: {
        type: "SKILL_COMPLETION_METADATA_INVALID",
        code: "SKILL_COMPLETION_METADATA_INVALID",
        message: "The skill completion contract is invalid.",
        contractId: executionContract.id,
      },
    };
    return;
  }

  const conversation = cloneJson(messages);
  const model = (provider.userConfig && provider.userConfig.model) || (provider.spec && provider.spec.defaultModel);
  const workflowMode = !!(executionContract && executionContract.mode === "workflow");
  const workflowProtocol = workflowMode ? require("./execution-contract") : null;
  const askFn = typeof onPermissionAsk === "function" ? onPermissionAsk : null;
  const resumed = resumeState && typeof resumeState === "object" ? resumeState : {};
  // A continuation is an exact saved execution state. Its policy always wins
  // over a new caller's default so resuming cannot regain capabilities.
  const policyInput = resumed.allowedToolPolicy || allowedToolPolicy;
  const initialPolicy = normalizeAllowedToolPolicy(policyInput, registry);
  if (!initialPolicy.ok) {
    yield { type: "error", error: {
      type: "SKILL_ALLOWED_TOOL_INVALID",
      code: "SKILL_ALLOWED_TOOL_INVALID",
      message: initialPolicy.error,
    } };
    return;
  }
  let activeToolPolicy = initialPolicy.policy;
  const effectReceipts = Array.isArray(resumed.effectReceipts)
    ? cloneJson(resumed.effectReceipts)
    : [];
  const interactionReceipts = Array.isArray(resumed.interactionReceipts)
    ? cloneJson(resumed.interactionReceipts)
    : [];
  const effectAttempts = normalizeEffectAttempts(resumed.effectAttempts);
  if (!effectAttempts) { yield { type: "error", error: { type: "EFFECT_ATTEMPT_STATE_INVALID", code: "EFFECT_ATTEMPT_STATE_INVALID" } }; return; }
  let completionRetries = Number.isSafeInteger(resumed.completionRetries)
    ? Math.max(0, resumed.completionRetries)
    : 0;
  const priorTurns = Number.isSafeInteger(resumed.turns) ? Math.max(0, resumed.turns) : 0;
  const turnBoundary = normalizeTurnBoundary(maxTurns);
  const repeatedTurnBoundary = normalizeTurnBoundary(maxRepeatedTurns);
  let previousTurnSignature = "";
  let repeatedTurnCount = 0;
  const toolCtx = {
    ...ctx,
    effectAttempts,
    signal: signal || (ctx && ctx.signal),
    toolPermissionMode: ctx && ctx.toolPermissionMode
      ? normalizeToolPermissionMode(ctx.toolPermissionMode)
      : null,
  };

  let turn = 0;
  while (turnBoundary === null || turn < turnBoundary) {
    const turnIndex = priorTurns + turn;
    if (toolCtx.signal && toolCtx.signal.aborted) {
      yield { type: "cancelled", stage: "before_model", turns: turnIndex };
      return;
    }
    const toolSpecs = registry.toApiSpecs(visibleToolSpecs(registry, activeToolPolicy));
    if (workflowMode) toolSpecs.push(workflowProtocol.WORKFLOW_FINISH_TOOL_SPEC);
    const budget = await prepareContextWindow({ provider, model, system, tools: toolSpecs, conversation, requestedMaxTokens: maxTokensPerTurn });
    if (!budget.ok) { yield { type: "error", error: budget.error }; return; }
    if (budget.compacted) conversation.splice(0, conversation.length, ...budget.messages);
    const input = { model, messages: conversation.slice(), maxTokens: budget.maxTokens };
    if (system !== undefined) input.system = system;
    if (toolSpecs.length > 0) input.tools = toolSpecs;
    if (typeof temperature === "number") input.temperature = temperature;
    if (signal) input.signal = signal;

    // CRITICAL: live-stream events through the generator instead of
    // awaiting consumeStream's full completion. Previously this awaited
    // the whole turn and then `yield`'d every UI event in one burst,
    // which collapsed any provider-side streaming into "show all text
    // after the model finishes". We now interleave: each provider chunk
    // yields its UI event immediately, while consumeStreamGenerator
    // accumulates state in the background. The final state comes back
    // through a sentinel `{ kind: "final", state }` event.
    let streamResult = null;
    try {
      for await (const item of consumeStreamGenerator(provider.createMessage(input), function* (ev) {
        yield { type: "stream", event: ev };
      })) {
        if (!item) continue;
        if (item.kind === "ui") {
          yield item.event;
        } else if (item.kind === "final") {
          streamResult = item.state;
        }
      }
    } catch (error) {
      if (isAbortError(error) || (toolCtx.signal && toolCtx.signal.aborted)) {
        yield { type: "cancelled", stage: "model_stream", turns: turnIndex };
      } else if (isRecoverableProviderStreamInterruption(error)) {
        // The current assistant turn never reached message_stop and has not
        // been appended to `conversation`. Checkpoint the last complete turn
        // boundary so continuing asks the model for the next step without
        // replaying any already executed tool (especially mutations).
        yield {
          type: "suspended",
          reason: "provider_stream_interrupted",
          stage: "model_stream",
          turns: turnIndex,
          checkpoint: createContinuationCheckpoint({
            conversation,
            effectReceipts,
            interactionReceipts,
            executionContract,
            completionRetries,
            turns: turnIndex,
            fileState: snapshotFileState(toolCtx.fileStateCache),
            allowedToolPolicy: activeToolPolicy,
            effectAttempts,
          }),
        };
      } else {
        yield { type: "error", error: { type: "provider_stream_error", message: errMsg(error) } };
      }
      return;
    }
    if (!streamResult) streamResult = { assistantContent: [], toolUses: [], stopReason: null, fatalError: null, uiEvents: [] };

    if (streamResult.fatalError && streamResult.fatalError.type === "incomplete_provider_stream") {
      // Some browser networking stacks report a clean iterator end when the
      // underlying connection was actually lost. Absence of message_stop is
      // therefore the protocol-level equivalent of a read interruption: keep
      // only the last complete conversation boundary and make it resumable.
      yield {
        type: "suspended",
        reason: "provider_stream_interrupted",
        stage: "model_stream",
        turns: turnIndex,
        checkpoint: createContinuationCheckpoint({
          conversation,
          effectReceipts,
          interactionReceipts,
          executionContract,
          completionRetries,
          turns: turnIndex,
          fileState: snapshotFileState(toolCtx.fileStateCache),
          allowedToolPolicy: activeToolPolicy,
          effectAttempts,
        }),
      };
      return;
    }
    if (streamResult.fatalError) {
      yield { type: "error", error: streamResult.fatalError };
      return;
    }

    conversation.push({ role: "assistant", content: streamResult.assistantContent });

    if (streamResult.toolUses.length === 0) {
      if (workflowMode) {
        if (completionRetries < maxCompletionRetries) {
          completionRetries += 1;
          conversation.push({
            role: "user",
            content: [{
              type: "text",
              text:
                `[FLOWNOTE_RUNTIME_CONTRACT] The explicit skill workflow has not finished. Call ` +
                `${workflowProtocol.WORKFLOW_FINISH_TOOL_NAME} exactly once with status completed or cancelled. ` +
                "If the workflow needs user input, call ask_user instead of ending the workflow. If status is " +
                "completed, declare mode answer, inspect, or effect; inspect/effect must be backed by verified " +
                "tool receipts.",
            }],
          });
          yield {
            type: "completion_retry",
            contractId: executionContract && executionContract.id,
            attempt: completionRetries,
            provisionalContent: streamResult.assistantContent,
          };
          yield { type: "turn_complete", turnIndex, stopReason: streamResult.stopReason };
          turn += 1;
          continue;
        }
        yield {
          type: "error",
          error: {
            type: "completion_contract_failed",
            message: `The skill workflow ended without a valid ${workflowProtocol.WORKFLOW_FINISH_TOOL_NAME} declaration.`,
            contractId: executionContract && executionContract.id,
            receipts: effectReceipts.slice(),
          },
        };
        return;
      }
      if (requiresVerifiedEffects(executionContract) && !contractIsSatisfied(executionContract, effectReceipts)) {
        if (completionRetries < maxCompletionRetries) {
          completionRetries += 1;
          conversation.push({
            role: "user",
            content: [{
              type: "text",
              text:
                "[FLOWNOTE_RUNTIME_CONTRACT] This task requires a verified external action, but no matching " +
                "execution receipt exists. Do not claim completion. Issue the required tool call now; if it cannot " +
                "be performed, explain the blocker without saying it was completed.",
            }],
          });
          yield {
            type: "completion_retry",
            contractId: executionContract && executionContract.id,
            attempt: completionRetries,
            provisionalContent: streamResult.assistantContent,
          };
          yield { type: "turn_complete", turnIndex, stopReason: streamResult.stopReason };
          turn += 1;
          continue;
        }
        yield {
          type: "error",
          error: {
            type: "completion_contract_failed",
            message: "The model ended without producing the verified action required by this task.",
            contractId: executionContract && executionContract.id,
            receipts: effectReceipts.slice(),
          },
        };
        return;
      }
      if (!assistantContentHasText(streamResult.assistantContent)) {
        // A structurally complete but empty assistant message is not a user
        // answer. Remove that empty turn and preserve the prior safe boundary
        // so the user can continue without re-running completed tools.
        conversation.pop();
        yield { type: "turn_complete", turnIndex, stopReason: streamResult.stopReason };
        yield {
          type: "suspended",
          reason: "empty_final_response",
          stage: "after_model",
          turns: turnIndex,
          checkpoint: createContinuationCheckpoint({
            conversation,
            effectReceipts,
            interactionReceipts,
            executionContract,
            completionRetries,
            turns: turnIndex,
            fileState: snapshotFileState(toolCtx.fileStateCache),
            allowedToolPolicy: activeToolPolicy,
            effectAttempts,
          }),
        };
        return;
      }
      yield { type: "turn_complete", turnIndex, stopReason: streamResult.stopReason };
      yield { type: "done", turns: turnIndex + 1, contract: executionContract || null, receipts: effectReceipts.slice() };
      return;
    }

    const workflowFinishUses = workflowMode
      ? streamResult.toolUses.filter((toolUse) => toolUse.name === workflowProtocol.WORKFLOW_FINISH_TOOL_NAME)
      : [];
    const executableToolUses = workflowMode
      ? streamResult.toolUses.filter((toolUse) => toolUse.name !== workflowProtocol.WORKFLOW_FINISH_TOOL_NAME)
      : streamResult.toolUses;

    // Interactive tools are a host-level turn barrier. A model may emit
    // `vault_write` and `ask_user` in the same assistant message; executing
    // siblings according to model order would allow a write before the user
    // has answered. Execute only the question calls in this turn and return
    // typed deferred results for every sibling so the model may re-issue them
    // after the answer.
    const interactionToolUses = executableToolUses.filter((toolUse) => isInteractionToolUse(toolUse, registry));
    const hasInteractionBarrier = interactionToolUses.length > 0;
    const dispatchedToolUses = hasInteractionBarrier ? interactionToolUses : executableToolUses;

    /** @type {Array<{id:string,content:string,isError:boolean,progress:Array<Object>}>} */
    const allResults = hasInteractionBarrier
      ? executableToolUses
          .filter((toolUse) => !interactionToolUses.some((interaction) => interaction.id === toolUse.id))
          .map((toolUse) => deferredToolResult(toolUse, "interaction_barrier"))
      : [];
    let suspensionRequest = null;

    for (const batch of partitionToolUses(dispatchedToolUses, registry)) {
      for (const tu of batch.items) {
        const tool = registry.get(tu.name);
        let capabilities = null;
        try { capabilities = tool ? resolveToolCapabilities(tool, tu.input) : null; } catch (_error) {}
        yield { type: "tool_start", tool: tu.name, toolUseId: tu.id, input: tu.input, capabilities };
      }
      if (batch.isConcurrencySafe) {
        const settled = await Promise.all(batch.items.map((tu) => runToolUse(
          tu, registry, toolCtx, askFn, activeToolPolicy,
        )));
        for (const r of settled) allResults.push(r);
      } else {
        for (const tu of batch.items) {
          const r = await runToolUse(tu, registry, toolCtx, askFn, activeToolPolicy);
          allResults.push(r);
        }
      }
      for (const tu of batch.items) {
        const r = allResults.find((x) => x.id === tu.id);
        for (const p of r.progress) {
          yield { type: "tool_progress", tool: tu.name, toolUseId: tu.id, message: p.message, data: p.data };
        }
        yield {
          type: "tool_finish",
          tool: tu.name,
          toolUseId: tu.id,
          isError: r.isError,
          content: r.content,
          outcome: r.outcome,
          capabilities: r.capabilities,
        };
        const receipt = await createEffectReceipt(tu, r, toolCtx);
        if (receipt) {
          effectReceipts.push(receipt);
          yield { type: "effect_receipt", receipt };
        }
        const interactionReceipt = createInteractionReceipt(tu, r);
        if (interactionReceipt) {
          interactionReceipts.push(interactionReceipt);
          yield { type: "interaction_receipt", receipt: interactionReceipt };
        }
      }
      const requested = batch.items
        .map((toolUse) => allResults.find((result) => result.id === toolUse.id))
        .find((result) => result && result.outcome && result.outcome.control
          && result.outcome.control.type === "suspend");
      if (requested) {
        suspensionRequest = requested.outcome.control;
        break;
      }
      if (toolCtx.signal && toolCtx.signal.aborted) {
        yield {
          type: "cancelled",
          stage: "tool_execution",
          turns: turnIndex + 1,
          outcomes: allResults.map((result) => result.outcome).filter(Boolean),
        };
        return;
      }
    }

    if (suspensionRequest) {
      for (const toolUse of executableToolUses) {
        if (!allResults.some((result) => result.id === toolUse.id)) {
          allResults.push(deferredToolResult(toolUse, "workflow_suspended"));
        }
      }
      const resultBlocks = streamResult.toolUses.map((toolUse) => {
        const result = allResults.find((candidate) => candidate.id === toolUse.id);
        if (result) {
          return {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result.content,
            is_error: result.isError,
          };
        }
        return {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: "Not executed because the workflow was suspended before this tool call.",
          is_error: true,
        };
      });
      conversation.push({ role: "user", content: resultBlocks });
      yield { type: "turn_complete", turnIndex, stopReason: streamResult.stopReason };
      const turns = turnIndex + 1;
      yield {
        type: "suspended",
        reason: suspensionRequest.reason || "tool_requested_suspension",
        stage: "tool_control",
        turns,
        checkpoint: createContinuationCheckpoint({
          conversation,
          effectReceipts,
          interactionReceipts,
          executionContract,
          completionRetries,
          turns,
          fileState: snapshotFileState(toolCtx.fileStateCache),
          allowedToolPolicy: activeToolPolicy,
          effectAttempts,
        }),
      };
      return;
    }

    const finishToolResultBlocks = [];
    let acceptedFinish = null;
    if (hasInteractionBarrier && workflowFinishUses.length > 0) {
      for (const finishUse of workflowFinishUses) {
        finishToolResultBlocks.push({
          type: "tool_result",
          tool_use_id: finishUse.id,
          content: `Not executed because ${workflowProtocol.WORKFLOW_FINISH_TOOL_NAME} cannot finish in the same turn as a user question.`,
          is_error: true,
        });
      }
    } else if (workflowFinishUses.length === 1) {
      const finishUse = workflowFinishUses[0];
      const declaration = workflowProtocol.normalizeWorkflowFinishDeclaration(finishUse.input);
      const validation = workflowProtocol.validateWorkflowFinish(
        declaration,
        effectReceipts,
        executionContract,
        interactionReceipts,
      );
      if (validation.ok) {
        acceptedFinish = { declaration, validation };
      } else {
        finishToolResultBlocks.push({
          type: "tool_result",
          tool_use_id: finishUse.id,
          content: validation.error,
          is_error: true,
        });
      }
    } else if (workflowFinishUses.length > 1) {
      for (const finishUse of workflowFinishUses) {
        finishToolResultBlocks.push({
          type: "tool_result",
          tool_use_id: finishUse.id,
          content: `Call ${workflowProtocol.WORKFLOW_FINISH_TOOL_NAME} exactly once.`,
          is_error: true,
        });
      }
    }

    if (acceptedFinish) {
      const { declaration, validation } = acceptedFinish;
      const disposition = declaration.status;
      const verified = validation.verified !== false;
      const finishEvent = {
        type: "workflow_finish",
        disposition,
        declaration,
        verified,
      };
      if (validation.verification) finishEvent.verification = validation.verification;
      yield finishEvent;
      yield { type: "turn_complete", turnIndex, stopReason: streamResult.stopReason };
      const doneEvent = {
        type: "done",
        turns: turnIndex + 1,
        contract: executionContract,
        receipts: effectReceipts.slice(),
        interactions: interactionReceipts.slice(),
        disposition,
        verified,
      };
      if (validation.verification) doneEvent.verification = validation.verification;
      yield doneEvent;
      return;
    }

    const policyUpdate = resolveSkillInvocationPolicy(
      dispatchedToolUses,
      allResults,
      activeToolPolicy,
      registry,
    );
    if (!policyUpdate.ok) {
      for (const toolUse of dispatchedToolUses.filter((item) => item.name === "skill_invoke")) {
        const result = allResults.find((item) => item.id === toolUse.id);
        if (!result || result.isError) continue;
        result.isError = true;
        result.content = `Skill tool policy rejected: ${policyUpdate.error}`;
        result.outcome = {
          state: "failed", code: "skill_allowed_tool_invalid", message: result.content,
          data: null, effects: [], control: null,
        };
      }
    } else if (policyUpdate.policy) {
      activeToolPolicy = policyUpdate.policy;
    }

    const toolResultBlocks = executableToolUses.map((tu) => {
      const r = allResults.find((x) => x.id === tu.id);
      return {
        type: "tool_result",
        tool_use_id: tu.id,
        content: r.content,
        is_error: r.isError,
      };
    });
    toolResultBlocks.push(...finishToolResultBlocks);
    conversation.push({ role: "user", content: toolResultBlocks });

    const progressSignature = createTurnProgressSignature(executableToolUses, allResults);
    if (progressSignature && progressSignature === previousTurnSignature) repeatedTurnCount += 1;
    else {
      previousTurnSignature = progressSignature;
      repeatedTurnCount = progressSignature ? 1 : 0;
    }
    yield { type: "turn_complete", turnIndex, stopReason: streamResult.stopReason };
    turn += 1;
    if (repeatedTurnBoundary !== null && repeatedTurnCount >= repeatedTurnBoundary) {
      const turns = priorTurns + turn;
      yield {
        type: "suspended",
        reason: "no_progress",
        stage: "between_turns",
        turns,
        checkpoint: createContinuationCheckpoint({
          conversation,
          effectReceipts,
          interactionReceipts,
          executionContract,
          completionRetries,
          turns,
          fileState: snapshotFileState(toolCtx.fileStateCache),
          allowedToolPolicy: activeToolPolicy,
          effectAttempts,
        }),
      };
      return;
    }
  }

  yield {
    type: "suspended",
    reason: "turn_boundary",
    stage: "between_turns",
    turns: priorTurns + turn,
    checkpoint: createContinuationCheckpoint({
      conversation,
      effectReceipts,
      interactionReceipts,
      executionContract,
      completionRetries,
      turns: priorTurns + turn,
      fileState: snapshotFileState(toolCtx.fileStateCache),
      allowedToolPolicy: activeToolPolicy,
      effectAttempts,
    }),
  };
}

function normalizeTurnBoundary(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.max(1, Math.floor(numeric));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function resolveSkillInvocationPolicy(toolUses, results, activePolicy, registry) {
  const invoked = (Array.isArray(toolUses) ? toolUses : [])
    .filter((toolUse) => toolUse && toolUse.name === "skill_invoke")
    .map((toolUse) => ({
      toolUse,
      result: (Array.isArray(results) ? results : []).find((result) => result && result.id === toolUse.id),
    }))
    .filter(({ result }) => result && !result.isError);
  if (invoked.length === 0) return { ok: true, policy: null };
  // One tool surface per next turn. Multiple successful loading calls cannot
  // safely decide which Skill's authority applies, so keep the prior policy.
  if (invoked.length > 1) return { ok: false, error: "Only one skill_invoke may establish a tool policy per turn." };
  const { toolUse } = invoked[0];
  const tool = registry.get("skill_invoke");
  const allowed = tool && typeof tool.resolveSkillAllowedTools === "function"
    ? tool.resolveSkillAllowedTools(toolUse.input)
    : null;
  if (allowed === null) return { ok: false, error: "The invoked skill could not provide a valid allowed-tools policy." };
  return applySkillAllowedTools(activePolicy, allowed, registry);
}

function snapshotFileState(cache) {
  if (!cache || typeof cache.snapshot !== "function") return null;
  try { return cache.snapshot(); } catch (_error) { return null; }
}

function deferredToolResult(toolUse, reason) {
  return {
    id: toolUse.id,
    content: `Not executed because ${reason === "interaction_barrier"
      ? "this turn is waiting for user input"
      : "the workflow was suspended"}. Re-issue the tool call after the workflow continues.`,
    isError: true,
    progress: [],
    capabilities: null,
    verification: null,
    outcome: {
      state: "deferred",
      code: reason,
      message: "Tool call deferred at a safe workflow boundary.",
      data: null,
      effects: [],
      control: null,
    },
  };
}

function isInteractionToolUse(toolUse, registry) {
  const tool = registry.get(toolUse.name);
  if (!tool) return false;
  try {
    return resolveToolCapabilities(tool, toolUse.input).presentation === "question";
  } catch (_error) {
    return false;
  }
}

function createInteractionReceipt(toolUse, result) {
  const isQuestion = result && result.capabilities
    && result.capabilities.presentation === "question";
  const completed = result && !result.isError && result.outcome
    && result.outcome.state === "completed";
  if (!isQuestion || !completed) return null;
  return {
    toolUseId: String((toolUse && toolUse.id) || ""),
    tool: String((toolUse && toolUse.name) || ""),
    verified: true,
    outcome: "answered",
  };
}

function createTurnProgressSignature(toolUses, results) {
  if (!Array.isArray(toolUses) || toolUses.length === 0) return "";
  return JSON.stringify(toolUses.map((toolUse) => {
    const result = Array.isArray(results) ? results.find((item) => item.id === toolUse.id) : null;
    return {
      tool: toolUse.name,
      input: toolUse.input,
      state: result && result.outcome ? result.outcome.state : "missing",
      code: result && result.outcome ? result.outcome.code : "missing",
      content: result ? result.content : "",
    };
  }));
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
async function runToolUse(tu, registry, ctx, askFn, activeToolPolicy) {
  const result = {
    id: tu.id,
    content: "",
    isError: false,
    progress: [],
    capabilities: null,
    outcome: null,
    verification: null,
  };
  const tool = registry.get(tu.name);
  if (!tool) {
    return failToolResult(result, "failed", "unknown_tool", `Unknown tool: ${tu.name}`);
  }
  if (!toolIsAllowed(activeToolPolicy, tu.name)) {
    return failToolResult(
      result,
      "denied",
      "skill_tool_not_allowed",
      `Tool ${tu.name} is not allowed by the active Skill allowed-tools policy.`,
    );
  }
  if (tu.name === "skill_invoke" && typeof tool.resolveSkillAllowedTools === "function") {
    const declaredAllowedTools = tool.resolveSkillAllowedTools(tu.input);
    if (declaredAllowedTools === null) {
      return failToolResult(result, "failed", "skill_allowed_tool_invalid", "The invoked skill is unavailable.");
    }
    const declaredPolicy = normalizeAllowedToolPolicy(declaredAllowedTools, registry);
    if (!declaredPolicy.ok) {
      return failToolResult(result, "failed", "skill_allowed_tool_invalid", `Skill tool policy rejected: ${declaredPolicy.error}`);
    }
  }

  try {
    result.capabilities = resolveToolCapabilities(tool, tu.input);
  } catch (error) {
    return failToolResult(result, "failed", "invalid_capabilities", errMsg(error));
  }

  if (isExecutionAborted(ctx)) {
    return failToolResult(result, "aborted", "cancelled_before_validation", `${tu.name} was cancelled before validation.`);
  }

  // 1. validate
  try {
    const v = await tool.validate(tu.input, ctx);
    if (v && v.ok === false) {
      return failToolResult(
        result,
        "failed",
        "invalid_input",
        `Invalid input for ${tu.name}: ${v.error || "validation failed"}`,
      );
    }
  } catch (e) {
    return failToolResult(result, "failed", "validation_error", `Validation crashed for ${tu.name}: ${errMsg(e)}`);
  }
  if (isExecutionAborted(ctx)) {
    return failToolResult(result, "aborted", "cancelled_after_validation", `${tu.name} was cancelled after validation.`);
  }

  // 2. permission gate
  try {
    let p = await tool.checkPermissions(tu.input, ctx);
    if (p && p.behavior === "deny") {
      return failToolResult(
        result,
        "denied",
        "permission_denied",
        `Permission denied for ${tu.name}${p.reason ? `: ${p.reason}` : ""}.`,
      );
    }
    if (isExecutionAborted(ctx)) {
      return failToolResult(result, "aborted", "cancelled_after_permission", `${tu.name} was cancelled after permission check.`);
    }
    const isSideEffect = !["none", "observation"].includes(result.capabilities.effect);
    if (isSideEffect && ctx && ctx.toolPermissionMode && (!p || p.behavior === "allow")) {
      p = {
        behavior: "ask",
        risk: result.capabilities.risk === "high" ? "dangerous" : "safe",
        summary: typeof tool.userFacingName === "function" ? tool.userFacingName(tu.input) : tu.name,
      };
    }
    if (p && p.behavior === "ask") {
      const policyDecision = resolvePermissionDecision({
        mode: ctx && ctx.toolPermissionMode,
        tool,
        input: tu.input,
        permission: p,
        capabilities: result.capabilities,
      });
      if (policyDecision && policyDecision.behavior === "allow") {
        if (ctx && ctx.grants) ctx.grants[`${tu.name}:*`] = "session";
      } else {
        if (!askFn) {
          return failToolResult(
            result,
            "denied",
            "permission_required",
            `Permission required for ${tu.name}, but no askFn configured.`,
          );
        }
        const decision = await askFn({ tool: tu.name, input: tu.input, ...p });
        if (isExecutionAborted(ctx)) {
          return failToolResult(result, "aborted", "cancelled_after_permission", `${tu.name} was cancelled after permission prompt.`);
        }
        if (!decision || decision.behavior !== "allow") {
          return failToolResult(
            result,
            "denied",
            "user_denied",
            `User denied ${tu.name}.`,
            { type: "suspend", reason: "permission_denied" },
          );
        }
        if (decision.persist === "session") {
          if (!ctx.grants) ctx.grants = {};
          ctx.grants[`${tu.name}:*`] = "session";
        }
      }
    }
  } catch (e) {
    return failToolResult(result, "failed", "permission_error", `Permission check crashed for ${tu.name}: ${errMsg(e)}`);
  }
  if (isExecutionAborted(ctx)) {
    return failToolResult(result, "aborted", "cancelled_before_execution", `${tu.name} was cancelled before execution.`);
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
      const control = normalizeToolControl(last.control);
      const state = control && control.type === "suspend"
        ? "suspended"
        : result.isError
          ? "failed"
          : isExecutionAborted(ctx)
            ? "completed_after_cancel"
            : "completed";
      result.outcome = {
        state,
        code: String(last.code || (result.isError ? "tool_error" : "ok")),
        message: result.content,
        data: last.data === undefined ? null : last.data,
        effects: normalizeOutcomeEffects(last.effects, result.capabilities),
        control,
      };
    } else {
      return failToolResult(result, "failed", "missing_result", `${tu.name} returned no result.`);
    }
  } catch (e) {
    if (isAbortError(e) || isExecutionAborted(ctx)) {
      return failToolResult(result, "aborted", "cancelled_during_execution", `${tu.name} was cancelled during execution.`);
    }
    return failToolResult(result, "failed", "execution_error", `${tu.name} crashed: ${errMsg(e)}`);
  }

  if (!result.isError && typeof tool.verifyEffect === "function" && result.outcome.effects.length > 0) {
    try {
      const verification = await tool.verifyEffect(tu.input, result.outcome, ctx);
      if (verification && typeof verification === "object") result.verification = verification;
    } catch (error) {
      result.verification = { verified: false, outcome: "verification_error", detail: errMsg(error) };
    }
  }
  return result;
}

function isExecutionAborted(ctx) {
  return !!(ctx && ctx.signal && ctx.signal.aborted);
}

function isAbortError(error) {
  return !!(
    error
    && (
      error.name === "AbortError"
      || error.code === "ABORT_ERR"
      || error.code === "ERR_CANCELED"
    )
  );
}

function failToolResult(result, state, code, message, control = null) {
  result.content = message;
  result.isError = true;
  result.outcome = {
    state,
    code,
    message,
    data: null,
    effects: normalizeOutcomeEffects(null, result.capabilities),
    control: normalizeToolControl(control),
  };
  return result;
}

function normalizeToolControl(value) {
  if (!value || typeof value !== "object" || value.type !== "suspend") return null;
  const reason = String(value.reason || "tool_requested_suspension").trim();
  return { type: "suspend", reason: reason || "tool_requested_suspension" };
}

function normalizeOutcomeEffects(effects, capabilities) {
  const declared = capabilities && capabilities.effect !== "none"
    ? [{ kind: capabilities.effect, targets: capabilities.targets || [] }]
    : [];
  if (!Array.isArray(effects)) return declared;
  return effects
    .filter((effect) => effect && typeof effect === "object" && typeof effect.kind === "string")
    .map((effect) => ({
      kind: effect.kind,
      targets: Array.isArray(effect.targets)
        ? [...new Set(effect.targets.map(normalizeEffectPath).filter(Boolean))]
        : [],
      data: effect.data === undefined ? undefined : effect.data,
    }));
}

function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

function stringifyContent(c) {
  if (typeof c === "string") return c;
  if (c === null || c === undefined) return "";
  try { return JSON.stringify(c); } catch { return String(c); }
}

function requiresVerifiedEffects(contract) {
  return !!(contract && (contract.mode === "effect" || contract.mode === "inspect"));
}

function normalizeEffectPath(value) {
  return String(value || "")
    .replace(/\\+/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .trim();
}

function contractIsSatisfied(contract, receipts) {
  if (!requiresVerifiedEffects(contract)) return true;
  const requirements = Array.isArray(contract.requiredEffects) && contract.requiredEffects.length > 0
    ? contract.requiredEffects
    : [{ kind: contract.mode === "inspect" ? "observation" : "vault_mutation", targetPaths: [] }];
  const verified = (Array.isArray(receipts) ? receipts : []).filter((receipt) => receipt && receipt.verified);
  return requirements.every((requirement) => {
    const kind = String((requirement && requirement.kind) || "vault_mutation");
    const matching = verified.filter((receipt) => receipt.kind === kind);
    if (matching.length === 0) return false;
    const targets = (Array.isArray(requirement && requirement.targetPaths) ? requirement.targetPaths : [])
      .map(normalizeEffectPath)
      .filter(Boolean);
    if (targets.length === 0) return true;
    const actualPaths = new Set(matching.flatMap((receipt) => (
      Array.isArray(receipt.paths) ? receipt.paths.map(normalizeEffectPath).filter(Boolean) : []
    )));
    return targets.every((path) => actualPaths.has(path));
  });
}

async function createEffectReceipt(toolUse, result, ctx) {
  const effects = result && result.outcome && Array.isArray(result.outcome.effects)
    ? result.outcome.effects
    : [];
  const effect = effects[0];
  if (!effect) return null;
  const paths = Array.isArray(effect.targets)
    ? [...new Set(effect.targets.map(normalizeEffectPath).filter(Boolean))]
    : [];
  const base = {
    kind: effect.kind,
    toolUseId: toolUse.id,
    tool: toolUse.name,
    paths,
    verified: false,
    outcome: result && result.outcome ? result.outcome.state : "outcome_unknown",
  };
  if (ctx && typeof ctx.verifyToolEffect === "function") {
    try {
      const receipt = await ctx.verifyToolEffect({ toolUse, result, effect });
      if (receipt && typeof receipt === "object") return receipt;
    } catch (error) {
      return { ...base, outcome: "verification_error", detail: errMsg(error) };
    }
  }
  if (result && result.verification && typeof result.verification === "object") {
    return {
      ...base,
      ...result.verification,
      verified: result.verification.verified === true,
    };
  }
  if (effect.kind === "observation") {
    const verified = !!result && !result.isError && result.outcome && result.outcome.state === "completed";
    return { ...base, verified, outcome: verified ? "verified" : base.outcome };
  }
  return base;
}

function partitionToolUses(toolUses, registry) {
  const batches = [];
  for (const tu of toolUses) {
    const isConcurrencySafe = isConcurrencySafeToolUse(tu, registry);
    const last = batches[batches.length - 1];
    if (isConcurrencySafe && last && last.isConcurrencySafe) {
      last.items.push(tu);
    } else {
      batches.push({ isConcurrencySafe, items: [tu] });
    }
  }
  return batches;
}

function isConcurrencySafeToolUse(tu, registry) {
  const tool = registry.get(tu.name);
  if (!tool) return false;
  try {
    return resolveToolCapabilities(tool, tu.input).concurrency === "parallel";
  } catch (_e) {
    return false;
  }
}

module.exports = {
  runAgentLoop,
  consumeStream,
  runToolUse,
  DEFAULT_MAX_TURNS,
  DEFAULT_MAX_REPEATED_TURNS,
  DEFAULT_MAX_TOKENS_PER_TURN,
  DEFAULT_MAX_COMPLETION_RETRIES,
  contractIsSatisfied,
  createEffectReceipt,
};
