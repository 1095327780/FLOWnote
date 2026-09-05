#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { resolveAgentProvider } = require("../runtime/agent/agent-provider-resolver");
const { runAgentLoop } = require("../runtime/agent/agent-loop");
const { buildTool, ToolRegistry } = require("../runtime/agent/tool-registry");
const { createVaultWriteTool } = require("../runtime/agent/tools/vault-write");
const { createExplicitSkillWorkflowContract } = require("../runtime/agent/execution-contract");
const { getEmbeddedSkillCatalog } = require("../runtime/skill-catalog");

const EXPECTED_PROVIDER = "deepseek";
const EXPECTED_MODEL = "deepseek-v4-flash";
const SMOKE_PATH = "FLOWnote Smoke/Card.md";
const INTERACTIVE_SMOKE_PATH = "FLOWnote Smoke/Daily.md";
const SMOKE_MARKER = "FLOWNOTE_REAL_PROVIDER_SMOKE";

function fail(message) {
  const error = new Error(message);
  error.code = "REAL_PROVIDER_SMOKE_FAILED";
  throw error;
}

function loadProviderSettings(dataPath) {
  const raw = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  const candidate = raw && raw.settings && raw.settings.agentProvider;
  if (!candidate || typeof candidate !== "object") fail("FLOWnote agent provider settings were not found.");
  const settings = JSON.parse(JSON.stringify(candidate));
  settings.direct = settings.direct && typeof settings.direct === "object" ? settings.direct : {};
  if (settings.direct.providerId !== EXPECTED_PROVIDER) {
    fail(`Expected active provider ${EXPECTED_PROVIDER}.`);
  }
  if (settings.direct.model !== EXPECTED_MODEL) {
    fail(`Expected active model ${EXPECTED_MODEL}.`);
  }
  const key = settings.direct.apiKeys && settings.direct.apiKeys[EXPECTED_PROVIDER];
  if (typeof key !== "string" || key.length < 8) fail("DeepSeek API key is not configured.");
  settings.direct.stream = false;
  return settings;
}

async function requestWithFetch(args) {
  return fetch(args.url, {
    method: args.method,
    headers: args.headers,
    body: args.body,
    signal: AbortSignal.timeout(90_000),
  });
}

class MemoryVault {
  constructor() {
    this.files = new Map();
  }

  getFileByPath(filePath) {
    return this.files.has(filePath) ? { path: filePath } : null;
  }

  async create(filePath, content) {
    if (this.files.has(filePath)) throw new Error(`File already exists: ${filePath}`);
    this.files.set(filePath, String(content));
    return { path: filePath };
  }

  async modify(file, content) {
    if (!file || !this.files.has(file.path)) throw new Error("File does not exist.");
    this.files.set(file.path, String(content));
  }

  async cachedRead(file) {
    return this.files.get(file.path);
  }
}

function makeResourceReadTool() {
  return buildTool({
    name: "skill_resource_read",
    description: "Read one resource belonging to the active standard Skill.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    capabilities: (input) => ({
      effect: "observation",
      risk: "low",
      concurrency: "parallel",
      presentation: "skill",
      targets: input && input.path ? [String(input.path)] : [],
    }),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(input) {
      if (input.path !== "references/card-guide.md") {
        yield { type: "result", isError: true, content: "Unknown Skill resource." };
        return;
      }
      yield {
        type: "result",
        content: "Create exactly one concise Markdown card containing the required smoke marker.",
      };
    },
  });
}

function makeDismissedAskTool() {
  return buildTool({
    name: "ask_user",
    description: "Ask the user a blocking question and wait. For this smoke test the panel is dismissed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { question: { type: "string" } },
      required: ["question"],
    },
    capabilities: {
      effect: "none",
      risk: "low",
      concurrency: "serial",
      presentation: "question",
      targets: [],
    },
    isReadOnly: () => true,
    async *execute() {
      yield {
        type: "result",
        code: "user_input_dismissed",
        content: "The user dismissed the question without answering.",
        control: { type: "suspend", reason: "user_input_dismissed" },
      };
    },
  });
}

function makeAnsweredAskTool() {
  return buildTool({
    name: "ask_user",
    description: "Ask the user a blocking question and wait for an explicit answer.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { question: { type: "string" } },
      required: ["question"],
    },
    capabilities: {
      effect: "none",
      risk: "low",
      concurrency: "serial",
      presentation: "question",
      targets: [],
    },
    isReadOnly: () => true,
    async *execute(input) {
      yield {
        type: "result",
        content: `User confirmed: ${String(input && input.question || "Proceed?")}`,
      };
    },
  });
}

async function drainLoop(args) {
  const events = [];
  for await (const event of runAgentLoop(args)) events.push(event);
  const terminal = [...events].reverse().find((event) => (
    event && ["done", "suspended", "blocked", "cancelled", "error"].includes(event.type)
  ));
  return { events, terminal };
}

function checkpointToolNames(checkpoint) {
  const messages = checkpoint && Array.isArray(checkpoint.messages) ? checkpoint.messages : [];
  return messages.flatMap((message) => (
    Array.isArray(message && message.content)
      ? message.content.filter((block) => block && block.type === "tool_use").map((block) => block.name)
      : []
  ));
}

async function runInteractionBarrier(provider) {
  const vault = new MemoryVault();
  const registry = new ToolRegistry();
  registry.registerAll([
    createVaultWriteTool({ vault }),
    makeDismissedAskTool(),
  ]);
  const result = await drainLoop({
    provider,
    registry,
    system:
      "This is a tool-protocol conformance test. In the next assistant message emit exactly two tool calls, " +
      `first vault_write with path '${SMOKE_PATH}', mode 'create', and content '${SMOKE_MARKER}', then ` +
      "ask_user with question 'Proceed?'. Emit both calls in the same message and no prose.",
    messages: [{
      role: "user",
      content: [{ type: "text", text: "Run the two-call conformance test now." }],
    }],
    maxTurns: 4,
    maxTokensPerTurn: 8_192,
    ctx: { grants: {} },
  });
  const calledTools = checkpointToolNames(result.terminal && result.terminal.checkpoint);
  if (!result.terminal || result.terminal.type !== "suspended") {
    const detail = result.terminal && result.terminal.type === "error"
      ? `error:${String(result.terminal.error && result.terminal.error.type || "unknown")}`
      : String(result.terminal && result.terminal.type || "missing");
    fail(`Interaction barrier did not produce a suspended checkpoint (${detail}).`);
  }
  if (!calledTools.includes("vault_write") || !calledTools.includes("ask_user")) {
    fail("DeepSeek did not emit both requested same-turn tool calls.");
  }
  if (vault.files.size !== 0) fail("Interaction barrier allowed a deferred Vault write to execute.");
  return {
    terminal: result.terminal.type,
    reason: result.terminal.reason,
    calledTools,
    verifiedMutations: vault.files.size,
  };
}

async function runStandardSkillWorkflow(provider) {
  const vault = new MemoryVault();
  const registry = new ToolRegistry();
  registry.registerAll([
    makeResourceReadTool(),
    createVaultWriteTool({ vault }),
  ]);
  const ahCard = getEmbeddedSkillCatalog().find((skill) => skill.id === "ah-card");
  if (!ahCard || !ahCard.completionPolicy || ahCard.completionPolicy.state !== "declared") {
    fail("The embedded ah-card Skill is missing its canonical completion contract.");
  }
  const contract = createExplicitSkillWorkflowContract({
    skillName: "ah-card",
    command: "/ah-card",
    args: "real provider smoke",
    completionPolicy: ahCard.completionPolicy,
  });
  const result = await drainLoop({
    provider,
    registry,
    executionContract: contract,
    system:
      "You are executing a standard FLOWnote Skill. First call skill_resource_read for " +
      "references/card-guide.md. Then create exactly one note with vault_write using path " +
      `'${SMOKE_PATH}', mode 'create', and content containing '${SMOKE_MARKER}'. Finally call ` +
      "flownote_finish_skill with status 'completed', mode 'effect', and target_paths containing the same path. " +
      "Do not claim completion in prose before the verified tool effect.",
    messages: [{
      role: "user",
      content: [{ type: "text", text: "/ah-card real provider smoke" }],
    }],
    maxTurns: 12,
    maxTokensPerTurn: 16_384,
    ctx: { grants: {} },
  });
  if (!result.terminal || result.terminal.type !== "done") {
    fail(`Standard Skill workflow did not complete (${result.terminal && result.terminal.type}).`);
  }
  const content = vault.files.get(SMOKE_PATH);
  if (vault.files.size !== 1 || typeof content !== "string" || !content.includes(SMOKE_MARKER)) {
    fail("Standard Skill workflow did not produce exactly one verified in-memory note.");
  }
  return {
    terminal: result.terminal.type,
    turns: result.terminal.turns,
    verifiedMutations: vault.files.size,
  };
}

async function runInteractionRequiredSkillWorkflow(provider) {
  const vault = new MemoryVault();
  const registry = new ToolRegistry();
  registry.registerAll([
    createVaultWriteTool({ vault }),
    makeAnsweredAskTool(),
  ]);
  const ahNote = getEmbeddedSkillCatalog().find((skill) => skill.id === "ah-note");
  if (
    !ahNote
    || !ahNote.completionPolicy
    || ahNote.completionPolicy.state !== "declared"
    || !ahNote.completionPolicy.requiredInteractions.includes("ask_user")
  ) {
    fail("The canonical ah-note Skill lost its required ask_user interaction contract.");
  }
  const contract = createExplicitSkillWorkflowContract({
    skillName: "ah-note",
    command: "/ah-note",
    args: "real interaction smoke",
    completionPolicy: ahNote.completionPolicy,
  });
  const result = await drainLoop({
    provider,
    registry,
    executionContract: contract,
    system:
      "You are executing an interaction-required FLOWnote Skill. First create a daily-note scaffold with " +
      `vault_write using path '${INTERACTIVE_SMOKE_PATH}', mode 'create', and content '${SMOKE_MARKER}'. ` +
      "Then call ask_user with a concise confirmation question and wait for its answer. Only after the answer, " +
      "call flownote_finish_skill with status 'completed', mode 'effect', and target_paths containing the same path. " +
      "A prose claim or blocked finish without ask_user is invalid.",
    messages: [{
      role: "user",
      content: [{ type: "text", text: "/ah-note real interaction smoke" }],
    }],
    maxTurns: 12,
    maxTokensPerTurn: 16_384,
    ctx: { grants: {} },
  });
  if (!result.terminal || result.terminal.type !== "done") {
    fail(`Interaction-required Skill workflow did not complete (${result.terminal && result.terminal.type}).`);
  }
  const content = vault.files.get(INTERACTIVE_SMOKE_PATH);
  const interactionReceipts = result.events
    .filter((event) => event && event.type === "interaction_receipt")
    .map((event) => event.receipt)
    .filter((receipt) => receipt && receipt.tool === "ask_user" && receipt.verified === true);
  if (vault.files.size !== 1 || typeof content !== "string" || !content.includes(SMOKE_MARKER)) {
    fail("Interaction-required Skill workflow did not produce exactly one verified in-memory note.");
  }
  if (interactionReceipts.length !== 1) {
    fail("Interaction-required Skill workflow completed without exactly one verified ask_user receipt.");
  }
  return {
    terminal: result.terminal.type,
    turns: result.terminal.turns,
    verifiedMutations: vault.files.size,
    verifiedInteractions: interactionReceipts.length,
  };
}

async function main() {
  const dataPath = process.argv[2] ? path.resolve(process.argv[2]) : "";
  if (!dataPath) fail("Usage: node scripts/real-deepseek-isolated-smoke.js /path/to/flownote/data.json");
  const settings = loadProviderSettings(dataPath);
  const provider = resolveAgentProvider(settings, { requestImpl: requestWithFetch });
  const barrier = await runInteractionBarrier(provider);
  const workflow = await runStandardSkillWorkflow(provider);
  const interactiveWorkflow = await runInteractionRequiredSkillWorkflow(provider);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    provider: provider.id,
    model: provider.userConfig.model,
    isolatedVault: true,
    barrier,
    workflow,
    interactiveWorkflow,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`[real-deepseek-isolated-smoke] ${error && error.message ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
