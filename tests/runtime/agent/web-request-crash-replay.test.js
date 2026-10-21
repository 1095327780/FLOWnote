const test = require("node:test");
const assert = require("node:assert/strict");

const { runDirectAgentTurn } = require("../../../runtime/chat/direct-agent-runner");
const { runAgentLoop } = require("../../../runtime/agent/agent-loop");
const { ToolRegistry } = require("../../../runtime/agent/tool-registry");
const { createWebRequestTool } = require("../../../runtime/agent/tools/web-request");
const { SessionStore } = require("../../../runtime/session-store");
const { DirectExecutionJournal } = require("../../../runtime/chat/direct-execution-journal");
const {
  ExecutionLedger,
  reduceExecutionEvents,
  collectUnresolvedEffectAttempts,
} = require("../../../runtime/agent/execution-ledger");
const { projectDurableExecutionFact } = require("../../../runtime/agent/durable-execution-projection");
const { resolvePermissionDecision, resolvePermissionRequestDecision } = require("../../../runtime/agent/permission-policy");
const { describePermissionAction } = require("../../../runtime/permission-action-description");
const { defaultAgentSettings, setApiKeyFor } = require("../../../runtime/agent/agent-settings");

const SESSION = "s1";
const URL_NOTES = "https://api.flownote.test/v1/notes";
const FP = `sha256:${"a".repeat(64)}`;
const KEY = `flownote-${"a".repeat(64)}`;

function provider(turns, seen = []) {
  let calls = 0;
  return {
    id: "mock",
    displayName: "Mock",
    spec: { id: "mock", displayName: "Mock", protocol: "anthropic-messages" },
    userConfig: { providerId: "mock", mode: "api", apiKey: "k", model: "mock-1" },
    async *createMessage(input) {
      seen.push(JSON.parse(JSON.stringify(input.messages)));
      const turn = turns[calls++];
      if (!turn) throw new Error("mock provider exhausted");
      for (const event of turn) yield event;
    },
  };
}

function toolTurn(id, input) {
  return [
    { type: "message_start", message: {} },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "web_request", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
    { type: "message_stop" },
  ];
}

function textTurn(text) {
  return [
    { type: "message_start", message: {} },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ];
}

// One plugin process. `disk` is the persisted data.json: only what was written
// by persistState survives a crash.
function createProcess(disk) {
  const plugin = {
    runtimeState: disk.json ? JSON.parse(disk.json) : null,
    settings: { agentProvider: { ...defaultAgentSettings(), enabled: true }, toolPermissionMode: "auto" },
  };
  setApiKeyFor(plugin.settings.agentProvider, "deepseek", "k");
  plugin.persistState = async () => { disk.json = JSON.stringify(plugin.runtimeState); };
  plugin.sessionStore = new SessionStore(plugin);
  return plugin;
}

async function runTurn(plugin, { draftId, userText, toolUseId, input, onSend, answer = "once", prompts = [], seen = [] }) {
  const store = plugin.sessionStore;
  store.appendMessage(SESSION, { id: `u-${draftId}`, role: "user", text: userText });
  store.appendMessage(SESSION, { id: draftId, role: "assistant", text: "", pending: true });
  await plugin.persistState();
  const registry = new ToolRegistry();
  registry.register(createWebRequestTool({
    requestUrl: async (request) => {
      await onSend(request);
      return { status: 201, headers: { "content-type": "application/json" }, text: "{\"id\":\"n\"}" };
    },
  }));
  const handlers = {
    // Mirrors chat-orchestrator: the permission mode may answer before a modal.
    onPermissionRequest: async (permission) => {
      const decision = resolvePermissionRequestDecision(plugin.settings.toolPermissionMode, permission);
      if (decision.behavior === "allow") return "always";
      prompts.push(permission);
      return answer;
    },
    onExecutionSnapshot: async (events) => {
      store.setAssistantExecution(SESSION, draftId, events);
      await plugin.persistState();
    },
  };
  const response = await runDirectAgentTurn({
    view: { app: { vault: { getFileByPath: () => null, cachedRead: async () => "" } }, plugin },
    sessionId: SESSION,
    draftId,
    userText,
    handlers,
    toolRegistryOverride: registry,
    checkpointStoreOverride: {
      store: async () => ({ version: 1, id: FP, path: `.flownote/continuations/${"a".repeat(64)}.json`, byteLength: 10 }),
    },
    runTurnAuditImpl: async () => ({ ok: false }),
    runAgentLoopImpl: (args) => runAgentLoop({
      ...args,
      provider: provider([toolTurn(toolUseId, input), textTurn("done")], seen),
    }),
  });
  store.finalizeAssistantDraft(SESSION, draftId, response);
  await plugin.persistState();
  return response;
}

// Phase 1: the request is sent; the process dies right after requestUrl
// returns, so data.json is exactly what was persisted at send time.
async function crashAfterSend() {
  const live = { json: "" };
  const plugin = createProcess(live);
  plugin.sessionStore.upsertSession({ id: SESSION, title: "t", updatedAt: 1 });
  const sent = [];
  let diskAtSend = "";
  await runTurn(plugin, {
    draftId: "d1",
    userText: "publish this card",
    toolUseId: "tu-1",
    input: { url: URL_NOTES, method: "POST", json: { title: "Card", body: "PRIVATE_BODY" } },
    onSend: async (request) => { sent.push(request); diskAtSend = live.json; },
  });
  return { sent, disk: { json: diskAtSend } };
}

function restart(disk) {
  const plugin = createProcess(disk);
  assert.equal(plugin.sessionStore.recoverInterruptedExecutions(Date.now()), 1);
  return plugin;
}

test("crash replay: the sending attempt is persisted before the request leaves", async () => {
  const { sent, disk } = await crashAfterSend();
  assert.equal(sent.length, 1);
  const message = JSON.parse(disk.json).messagesBySession[SESSION].find((item) => item.id === "d1");
  const types = message.execution.events.map((event) => event.type);
  assert.deepEqual(types, ["run_started", "tool_started", "effect_attempt_sending"]);
  const attempt = message.execution.events[2].attempt;
  assert.equal(attempt.endpoint, URL_NOTES);
  assert.equal(attempt.scope, "https://api.flownote.test");
  assert.equal(sent[0].headers["Idempotency-Key"], attempt.idempotencyKey);
  assert.equal(disk.json.includes("PRIVATE_BODY"), false);

  const plugin = restart(disk);
  const recovered = plugin.sessionStore.getSessionMessages(SESSION).find((item) => item.id === "d1");
  assert.equal(recovered.status, "interrupted");
  const tool = Object.values(reduceExecutionEvents(recovered.execution.events).runs)[0].tools["tu-1"];
  assert.equal(tool.status, "unknown_after_reload");
  assert.equal(tool.effectAttempt.state, "unknown_after_send");
  assert.deepEqual(collectUnresolvedEffectAttempts(plugin.sessionStore.getSessionMessages(SESSION))
    .map((item) => [item.method, item.endpoint]), [["POST", URL_NOTES]]);
});

test("crash replay: a new turn cannot resend to the same service without explicit confirmation, even in auto mode", async () => {
  const { sent, disk } = await crashAfterSend();
  const plugin = restart(disk);
  const prompts = [];
  const seen = [];
  const response = await runTurn(plugin, {
    draftId: "d2",
    userText: "it did not seem to work, publish the card again",
    toolUseId: "tu-2",
    // Any byte change gives a new fingerprint and Idempotency-Key.
    input: { url: URL_NOTES, method: "POST", json: { title: "Card ", body: "PRIVATE_BODY" } },
    onSend: async (request) => { sent.push(request); },
    answer: "reject",
    prompts,
    seen,
  });

  assert.equal(sent.length, 1, "the uncertain change must not be sent again");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].requiresExplicitConfirmation, true);
  assert.equal(prompts[0].unresolvedEffect.endpoint, URL_NOTES);
  assert.match(describePermissionAction(prompts[0]), /可能已经生效/);
  assert.equal(response.status, "suspended");
  // The model is told the earlier send has an unknown outcome.
  const replayed = seen[0].flatMap((message) => message.content)
    .find((block) => block.type === "tool_result" && /was sent, but its result was never recorded/.test(block.content));
  assert.ok(replayed);
  assert.equal(replayed.is_error, true);
  assert.equal(collectUnresolvedEffectAttempts(plugin.sessionStore.getSessionMessages(SESSION)).length, 1);
});

test("crash replay: an explicit confirmation sends once, and durably resolves the unknown attempt", async () => {
  const { sent, disk } = await crashAfterSend();
  const plugin = restart(disk);
  const prompts = [];
  await runTurn(plugin, {
    draftId: "d2",
    userText: "I checked the service; send it again",
    toolUseId: "tu-2",
    input: { url: URL_NOTES, method: "POST", json: { title: "Card", body: "PRIVATE_BODY" } },
    onSend: async (request) => { sent.push(request); },
    answer: "always",
    prompts,
  });
  assert.equal(sent.length, 2);
  assert.equal(prompts.length, 1);
  const messages = plugin.sessionStore.getSessionMessages(SESSION);
  const d2 = messages.find((item) => item.id === "d2");
  const sending = d2.execution.events.find((event) => event.type === "effect_attempt_sending");
  const first = messages.find((item) => item.id === "d1").execution.events
    .find((event) => event.type === "effect_attempt_sending");
  assert.deepEqual(sending.attempt.resolves, [first.attempt.fingerprint]);
  assert.deepEqual(collectUnresolvedEffectAttempts(messages), []);

  // Later sends to that service follow the normal permission mode again.
  const later = [];
  await runTurn(plugin, {
    draftId: "d3",
    userText: "publish another card",
    toolUseId: "tu-3",
    input: { url: URL_NOTES, method: "POST", json: { title: "Other" } },
    onSend: async (request) => { later.push(request); },
    answer: "reject",
    prompts,
  });
  assert.equal(later.length, 1);
  assert.equal(prompts.length, 1);
});

test("web_request does not send when the attempt cannot be recorded first", async () => {
  let calls = 0;
  const tool = createWebRequestTool({ requestUrl: async () => { calls += 1; return { status: 200, text: "" }; } });
  const effectAttempts = [];
  const ctx = {
    effectAttempts,
    unresolvedEffectAttempts: [],
    recordEffectAttempt: async () => { throw new Error("disk full"); },
  };
  const input = { url: URL_NOTES, method: "POST", json: { a: 1 } };
  const results = [];
  for await (const event of tool.execute(input, ctx)) results.push(event);
  assert.equal(calls, 0);
  assert.equal(results.at(-1).code, "effect_attempt_not_recorded");
  assert.equal(effectAttempts.length, 0, "an unsent attempt must not suppress a later retry");

  // A journal that cannot persist refuses to record.
  const journal = new DirectExecutionJournal({ runId: "r1" });
  await journal.start(null);
  await assert.rejects(journal.recordEffectAttempt({ toolUseId: "t1", attempt: {} }), /persistence is unavailable/);
});

test("web_request gate: unknown outcomes block only the same service and survive a same-run timeout", async () => {
  const sends = [];
  let fail = true;
  const tool = createWebRequestTool({
    timeoutMs: 5,
    requestUrl: async (request) => {
      sends.push(request);
      if (fail) return new Promise(() => {});
      return { status: 201, headers: {}, text: "ok" };
    },
  });
  const ctx = { effectAttempts: [], unresolvedEffectAttempts: [], recordEffectAttempt: async () => {} };
  const run = async (input, extra = {}) => {
    const events = [];
    for await (const event of tool.execute(input, { ...ctx, ...extra })) events.push(event);
    return events.at(-1);
  };
  const input = { url: URL_NOTES, method: "POST", json: { a: 1 } };
  assert.equal((await run(input)).code, "unknown_after_send");
  assert.equal(ctx.unresolvedEffectAttempts.length, 1);

  // A modified body to the same service is held back without confirmation.
  const modified = { ...input, json: { a: 2 } };
  assert.equal((await run(modified)).code, "unresolved_effect_confirmation_required");
  const permission = await tool.checkPermissions(modified, ctx);
  assert.equal(permission.requiresExplicitConfirmation, true);
  // Another service, and plain reads, are unaffected.
  assert.equal((await tool.checkPermissions({ url: "https://other.test/x", method: "POST" }, ctx)).requiresExplicitConfirmation, undefined);
  assert.equal((await tool.checkPermissions({ url: URL_NOTES }, ctx)).requiresExplicitConfirmation, undefined);
  assert.equal(sends.length, 1);

  // With explicit confirmation the identical request is retried with the same key.
  fail = false;
  const retried = await run(input, { explicitEffectConfirmation: true });
  assert.equal(retried.code, "accepted_unverified");
  assert.equal(sends.length, 2);
  assert.equal(sends[1].headers["Idempotency-Key"], sends[0].headers["Idempotency-Key"]);
  assert.equal(ctx.unresolvedEffectAttempts.length, 0);
});

test("explicit confirmation overrides every permission mode", () => {
  const permission = { behavior: "ask", requiresExplicitConfirmation: true };
  for (const mode of ["auto", "ask-dangerous", "ask"]) {
    assert.equal(resolvePermissionDecision({ mode, toolName: "web_request", input: { method: "POST" }, permission }).behavior, "ask");
  }
  assert.equal(resolvePermissionRequestDecision("auto", { type: "web_request", requiresExplicitConfirmation: true }).behavior, "ask");
});

test("ledger: effect attempts are validated, projected without payloads, and ordered", () => {
  const attempt = {
    version: 1, fingerprint: FP, idempotencyKey: KEY, tool: "web_request",
    scope: "https://api.flownote.test", method: "POST", endpoint: URL_NOTES, resolves: [],
  };
  const projected = projectDurableExecutionFact({ type: "effect_attempt_sending", toolUseId: "t1", attempt: { ...attempt, body: "SECRET" } });
  assert.equal(JSON.stringify(projected).includes("SECRET"), false);

  const ledger = new ExecutionLedger({ now: () => 1 });
  ledger.append({ type: "run_started", runId: "r1", contract: null });
  ledger.append({ type: "tool_started", runId: "r1", toolUseId: "t1", tool: "web_request" });
  assert.throws(() => ledger.append({ type: "effect_attempt_sending", runId: "r1", toolUseId: "t1", attempt: { ...attempt, idempotencyKey: "x" } }), /invalid effect attempt/);
  ledger.append({ type: "effect_attempt_sending", runId: "r1", toolUseId: "t1", attempt });
  assert.throws(() => ledger.append({ type: "effect_attempt_sending", runId: "r1", toolUseId: "t1", attempt }), /duplicate effect attempt/);
  ledger.append({ type: "tool_finished", runId: "r1", toolUseId: "t1", isError: false, outcome: { state: "completed", code: "accepted_unverified", effects: [] } });
  assert.throws(() => ledger.append({ type: "effect_attempt_sending", runId: "r1", toolUseId: "t1", attempt }), /after tool finished/);
  assert.equal(reduceExecutionEvents(ledger.events).runs.r1.tools.t1.effectAttempt.state, "response_received");

  // A confirmed retry with the same fingerprint resolves only earlier attempts.
  const message = (id, resolves, code) => {
    const events = new ExecutionLedger({ now: () => 1 });
    events.append({ type: "run_started", runId: id, contract: null });
    events.append({ type: "tool_started", runId: id, toolUseId: "t", tool: "web_request" });
    events.append({ type: "effect_attempt_sending", runId: id, toolUseId: "t", attempt: { ...attempt, resolves } });
    events.append({ type: "tool_finished", runId: id, toolUseId: "t", isError: true, outcome: { state: "failed", code, effects: [] } });
    events.append({ type: "run_completed", runId: id });
    return { id, role: "assistant", execution: { version: 1, events: events.events } };
  };
  const unresolved = collectUnresolvedEffectAttempts([
    message("a1", [], "unknown_after_send"),
    message("a2", [FP], "unknown_after_send"),
  ]);
  assert.deepEqual(unresolved.map((item) => item.messageId), ["a2"]);
  assert.deepEqual(collectUnresolvedEffectAttempts([message("a1", [], "request_rejected")]), []);
});
