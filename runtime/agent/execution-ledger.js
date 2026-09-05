// Durable, provider-neutral facts for one agent execution.  This module does
// not execute tools or render UI: consumers derive their own projections from
// the validated append-only log.

const EVENT_TYPES = new Set([
  "run_started",
  "tool_started",
  "tool_progress",
  "tool_finished",
  "effect_verified",
  "effect_unverified",
  "completion_rejected",
  "completion_accepted",
  "cancel_requested",
  "run_cancelled",
  "run_suspended",
  "run_blocked",
  "run_failed",
  "run_completed",
  "run_interrupted",
]);

const TERMINAL_TYPES = new Set([
  "run_cancelled",
  "run_suspended",
  "run_blocked",
  "run_failed",
  "run_completed",
  "run_interrupted",
]);

const TERMINAL_DISPOSITIONS = Object.freeze({
  run_completed: "completed",
  run_blocked: "blocked",
  run_cancelled: "cancelled",
  run_suspended: "suspended",
});

function isJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Object.keys(value).every((key) => Object.prototype.propertyIsEnumerable.call(value, key)
    && value[key] !== undefined && isJsonValue(value[key], seen));
  seen.delete(value);
  return valid;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function ledgerError(message) {
  return new Error(`ExecutionLedger: ${message}`);
}

function requireString(value, subject) {
  if (typeof value !== "string" || !value.trim()) throw ledgerError(`${subject} must be a non-empty string`);
  return value;
}

function createRun(runId) {
  return {
    id: runId,
    status: "running",
    disposition: null,
    contract: null,
    completion: null,
    completionDecisions: [],
    cancelRequested: false,
    tools: {},
    terminal: null,
  };
}

function assertEventEnvelope(event, expectedSeq, previousTime) {
  if (!isJsonValue(event)) throw ledgerError("event must be JSON-serializable");
  if (!event || typeof event !== "object" || Array.isArray(event)) throw ledgerError("event must be an object");
  if (!EVENT_TYPES.has(event.type)) throw ledgerError(`unknown event type ${String(event.type)}`);
  requireString(event.runId, "runId");
  if (!Number.isSafeInteger(event.seq) || event.seq !== expectedSeq) {
    throw ledgerError(`expected seq ${expectedSeq}, received ${String(event.seq)}`);
  }
  if (!Number.isSafeInteger(event.time) || event.time < 0 || event.time < previousTime) {
    throw ledgerError("time must be a non-decreasing non-negative safe integer");
  }
}

function requireTool(run, event) {
  const toolUseId = requireString(event.toolUseId, "toolUseId");
  const tool = run.tools[toolUseId];
  if (!tool) throw ledgerError(`unknown tool ${toolUseId} in run ${run.id}`);
  return tool;
}

function requireOpenRun(runs, event) {
  const run = runs[event.runId];
  if (!run) throw ledgerError(`event ${event.type} references unknown run ${event.runId}`);
  if (run.terminal) {
    if (TERMINAL_TYPES.has(event.type)) throw ledgerError(`multiple terminal outcomes for run ${event.runId}`);
    throw ledgerError(`event ${event.type} after terminal state for run ${event.runId}`);
  }
  return run;
}

function hasRunningTools(run) {
  return Object.values(run.tools).some((tool) => tool.status === "running");
}

/**
 * Strictly project execution facts into the recoverable run/tool state.
 * @param {Array<Object>} events
 * @returns {{runs: Record<string, Object>, lastSeq: number, lastTime: number}}
 */
function reduceExecutionEvents(events) {
  if (!Array.isArray(events)) throw ledgerError("events must be an array");
  const runs = {};
  let previousTime = 0;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    assertEventEnvelope(event, index, previousTime);
    previousTime = event.time;

    if (event.type === "run_started") {
      if (runs[event.runId]) throw ledgerError(`duplicate run_started for run ${event.runId}`);
      runs[event.runId] = createRun(event.runId);
      runs[event.runId].contract = event.contract === undefined ? null : cloneJson(event.contract);
      continue;
    }

    const run = requireOpenRun(runs, event);
    if (event.type === "tool_started") {
      const toolUseId = requireString(event.toolUseId, "toolUseId");
      requireString(event.tool, "tool");
      if (run.tools[toolUseId]) throw ledgerError(`duplicate tool_started for tool ${toolUseId}`);
      run.tools[toolUseId] = {
        id: toolUseId,
        tool: event.tool,
        status: "running",
        capabilities: event.capabilities === undefined ? null : cloneJson(event.capabilities),
        progress: [],
        result: null,
        effect: { status: "not_applicable", receipt: null },
      };
      continue;
    }
    if (event.type === "tool_progress") {
      const tool = requireTool(run, event);
      if (tool.status !== "running") throw ledgerError(`tool_progress after tool finished for tool ${tool.id}`);
      const progress = {};
      if (event.message !== undefined) progress.message = String(event.message);
      if (event.data !== undefined) progress.data = cloneJson(event.data);
      tool.progress.push(progress);
      continue;
    }
    if (event.type === "tool_finished") {
      const tool = requireTool(run, event);
      if (tool.status !== "running") throw ledgerError(`duplicate tool_finished for tool ${tool.id}`);
      tool.status = event.isError === true ? "failed" : "succeeded";
      tool.result = event.content === undefined ? null : cloneJson(event.content);
      tool.outcome = event.outcome === undefined ? null : cloneJson(event.outcome);
      continue;
    }
    if (event.type === "effect_verified" || event.type === "effect_unverified") {
      const tool = requireTool(run, event);
      if (tool.status === "running") throw ledgerError(`effect receipt before tool_finished for tool ${tool.id}`);
      if (tool.effect.status !== "not_applicable") throw ledgerError(`duplicate effect receipt for tool ${tool.id}`);
      tool.effect = {
        status: event.type === "effect_verified" ? "verified" : "unverified",
        receipt: event.receipt === undefined ? null : cloneJson(event.receipt),
      };
      continue;
    }
    if (event.type === "completion_accepted" || event.type === "completion_rejected") {
      const decision = event.type === "completion_accepted" ? "accepted" : "rejected";
      if (run.completion === "accepted") throw ledgerError(`completion decision after acceptance for run ${run.id}`);
      if (decision === "accepted" && run.completionDecisions.includes("accepted")) {
        throw ledgerError(`duplicate completion acceptance for run ${run.id}`);
      }
      run.completion = decision;
      run.completionDecisions.push(decision);
      continue;
    }
    if (event.type === "cancel_requested") {
      if (run.cancelRequested) throw ledgerError(`duplicate cancel_requested for run ${run.id}`);
      run.cancelRequested = true;
      continue;
    }
    if (TERMINAL_TYPES.has(event.type)) {
      if (hasRunningTools(run) && event.type !== "run_interrupted") {
        throw ledgerError(`terminal ${event.type} with unfinished tools for run ${run.id}`);
      }
      if (event.type === "run_interrupted") {
        for (const tool of Object.values(run.tools)) {
          if (tool.status === "running") tool.status = "unknown_after_reload";
        }
      }
      run.status = event.type.slice("run_".length);
      run.disposition = TERMINAL_DISPOSITIONS[event.type] || null;
      run.terminal = event.type;
      run.terminalDetail = cloneJson(event);
      continue;
    }
    throw ledgerError(`unsupported event type ${event.type}`);
  }
  return { runs, lastSeq: events.length - 1, lastTime: events.length ? previousTime : 0 };
}

/**
 * Compact machine record for later turns. It deliberately excludes tool prose
 * and raw write payloads; only validated lifecycle, capabilities, targets and
 * effect receipts cross the turn boundary.
 */
function buildExecutionRecap(events) {
  const state = reduceExecutionEvents(events);
  const runs = Object.values(state.runs);
  if (runs.length !== 1 || !runs[0].terminal) return null;
  const run = runs[0];
  return {
    version: 1,
    runId: run.id,
    status: run.status,
    disposition: run.disposition,
    completion: run.completion,
    contract: run.contract,
    tools: Object.values(run.tools).map((tool) => ({
      toolUseId: tool.id,
      tool: tool.tool,
      status: tool.status,
      capabilities: tool.capabilities,
      outcome: tool.outcome
        ? { state: tool.outcome.state, code: tool.outcome.code, effects: tool.outcome.effects || [] }
        : null,
      effect: tool.effect,
    })),
  };
}

class ExecutionLedger {
  constructor({ now = () => Date.now(), events = [] } = {}) {
    if (typeof now !== "function") throw ledgerError("now must be a function");
    this.now = now;
    this._events = cloneJson(events);
    reduceExecutionEvents(this._events);
  }

  get events() {
    return cloneJson(this._events);
  }

  append(fact) {
    if (!isJsonValue(fact)) throw ledgerError("event must be JSON-serializable");
    const state = reduceExecutionEvents(this._events);
    const time = Math.max(state.lastTime, Math.floor(Number(this.now())) || 0);
    const event = { ...cloneJson(fact), seq: this._events.length, time };
    reduceExecutionEvents([...this._events, event]);
    this._events.push(event);
    return cloneJson(event);
  }
}

/**
 * Pure crash-recovery helper. It never mutates the supplied facts; it appends a
 * synthetic terminal event only when exactly one run is still open.
 */
function recoverInterruptedRun(events, { time } = {}) {
  const copied = cloneJson(events);
  const state = reduceExecutionEvents(copied);
  const openRuns = Object.values(state.runs).filter((run) => !run.terminal);
  if (!openRuns.length) return { events: copied, state, recovered: false };
  if (openRuns.length > 1) throw ledgerError("cannot recover multiple open runs");
  if (!Number.isSafeInteger(time) || time < state.lastTime) {
    throw ledgerError("recovery time must be a non-decreasing non-negative safe integer");
  }
  const run = openRuns[0];
  const unresolvedToolUseIds = Object.values(run.tools)
    .filter((tool) => tool.status === "running")
    .map((tool) => tool.id);
  const recoveredEvent = {
    seq: copied.length,
    time,
    type: "run_interrupted",
    runId: run.id,
    reason: "unknown_after_reload",
    unresolvedToolUseIds,
  };
  const recoveredEvents = [...copied, recoveredEvent];
  return { events: recoveredEvents, state: reduceExecutionEvents(recoveredEvents), recovered: true };
}

module.exports = {
  ExecutionLedger,
  reduceExecutionEvents,
  recoverInterruptedRun,
  buildExecutionRecap,
  EVENT_TYPES,
};
