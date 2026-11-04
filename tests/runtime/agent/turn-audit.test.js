const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AUDIT_TOOL_NAME,
  runTurnAudit,
  evaluateTurnReport,
  buildHostCheckMessage,
  normalizeAuditReport,
} = require("../../../runtime/agent/turn-audit");

function scriptedProvider(responses) {
  const seen = [];
  let calls = 0;
  return {
    seen,
    spec: { models: [{ id: "m", maxOutput: 100_000 }] },
    userConfig: { model: "m" },
    async *createMessage(input) {
      seen.push(input);
      const response = responses[calls++];
      if (response instanceof Error) throw response;
      yield { type: "message_start", message: {} };
      if (response && response.tool) {
        yield { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "r", name: response.tool, input: {} } };
        yield { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(response.input) } };
        yield { type: "content_block_stop", index: 0 };
        yield { type: "message_delta", delta: { stop_reason: "tool_use" } };
      } else {
        yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I think it is fine." } };
        yield { type: "content_block_stop", index: 0 };
        yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
      }
      yield { type: "message_stop" };
    },
  };
}

test("the audit sends the final message with host-measured changes and parses a typed report", async () => {
  const provider = scriptedProvider([{ tool: AUDIT_TOOL_NAME, input: {
    claims: [{ text: "已更新今天的日记", backed_by: 0 }, { text: "已创建周记", backed_by: -1 }],
    message_kind: "reports_done",
  } }]);
  const result = await runTurnAudit({
    provider,
    userRequest: "把这条加到今天日记，并建好周记",
    finalText: "已更新今天的日记，并已创建周记。",
    changes: [{ path: "Daily/2026-10-20.md", op: "modified" }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.report, {
    claims: [{ text: "已更新今天的日记", backedBy: 0 }, { text: "已创建周记", backedBy: -1 }],
    messageKind: "reports_done",
  });
  const prompt = provider.seen[0].messages[0].content[0].text;
  assert.match(prompt, /<assistant_final_message>\n已更新今天的日记/);
  assert.match(prompt, /\[0\] modified Daily\/2026-10-20\.md/);
  assert.deepEqual(provider.seen[0].tools.map((tool) => tool.name), [AUDIT_TOOL_NAME]);
  assert.equal(provider.seen[0].temperature, 0);
});

test("the audit retries a missing report once and then reports unavailability instead of throwing", async () => {
  const recovered = await runTurnAudit({
    provider: scriptedProvider([{}, { tool: AUDIT_TOOL_NAME, input: { claims: [], message_kind: "answer_only" } }]),
    userRequest: "hi", finalText: "hello", changes: [],
  });
  assert.equal(recovered.ok, true);
  const unavailable = await runTurnAudit({
    provider: scriptedProvider([new Error("network down"), {}]),
    userRequest: "hi", finalText: "hello", changes: [],
  });
  assert.deepEqual(unavailable, { ok: false, error: "missing_report" });
});

test("malformed reports are rejected", () => {
  assert.equal(normalizeAuditReport({ claims: "x", message_kind: "answer_only" }), null);
  assert.equal(normalizeAuditReport({ claims: [], message_kind: "unknown" }), null);
  assert.deepEqual(normalizeAuditReport({ claims: [{ text: "a", backed_by: "nope" }], message_kind: "reports_done" }).claims, [
    { text: "a", backedBy: -1 },
  ]);
});

test("every claim must be backed by a measured change index", () => {
  const changes = [{ path: "A.md", op: "modified" }];
  const backed = evaluateTurnReport({ report: { claims: [{ text: "改了 A", backedBy: 0 }], messageKind: "reports_done" }, changes });
  assert.deepEqual(backed, { allow: true, issues: [] });
  const unbacked = evaluateTurnReport({
    report: { claims: [{ text: "改了 A", backedBy: 0 }, { text: "建了 B", backedBy: 3 }], messageKind: "reports_done" },
    changes,
  });
  assert.equal(unbacked.allow, false);
  assert.deepEqual(unbacked.issues, [{ type: "unbacked_claims", claims: [{ text: "建了 B", backedBy: 3 }] }]);
  const nothingChanged = evaluateTurnReport({ report: { claims: [{ text: "已保存", backedBy: 0 }], messageKind: "reports_done" }, changes: [] });
  assert.equal(nothingChanged.allow, false);
});

test("ordinary chat never requires a change; an effect skill does unless it asks the user or reports a blocker", () => {
  const report = (messageKind) => ({ claims: [], messageKind });
  assert.equal(evaluateTurnReport({ report: report("answer_only"), changes: [] }).allow, true);
  assert.deepEqual(evaluateTurnReport({ report: report("reports_done"), changes: [], requiresChange: true }).issues, [
    { type: "required_change_missing" },
  ]);
  assert.equal(evaluateTurnReport({ report: report("asks_user"), changes: [], requiresChange: true }).allow, true);
  assert.equal(evaluateTurnReport({ report: report("reports_blocker"), changes: [], requiresChange: true }).allow, true);
  assert.equal(evaluateTurnReport({ report: report("reports_done"), changes: [{ path: "A.md", op: "created" }], requiresChange: true }).allow, true);
});

test("a skill that must ask the user cannot report completion without a recorded question", () => {
  const args = { report: { claims: [], messageKind: "reports_done" }, changes: [{ path: "N.md", op: "created" }], requiredInteractions: ["ask_user"] };
  assert.deepEqual(evaluateTurnReport(args).issues, [{ type: "required_interaction_missing" }]);
  assert.equal(evaluateTurnReport({ ...args, interactionReceipts: [{ verified: true }] }).allow, true);
});

test("host feedback lists measured changes and the exact unbacked claims", () => {
  const message = buildHostCheckMessage({
    changes: [],
    issues: [{ type: "unbacked_claims", claims: [{ text: "已写入 x.md", backedBy: -1 }] }],
  });
  assert.match(message, /^\[FLOWNOTE_HOST_CHECK\]/);
  assert.match(message, /\(none — no file or folder was created/);
  assert.match(message, /- "已写入 x\.md"/);
  assert.match(message, /Do not mention this check/);
  assert.match(buildHostCheckMessage({ changes: [], issues: [{ type: "required_change_missing" }], skillCommand: "/ah-capture" }), /\/ah-capture must change the vault/);
});
