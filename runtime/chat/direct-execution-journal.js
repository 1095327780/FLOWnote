const { ExecutionLedger, reduceExecutionEvents } = require("../agent/execution-ledger");
const { projectDurableExecutionFact, projectCheckpointRef } = require("../agent/durable-execution-projection");

function definedFields(value) {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
}

class DirectExecutionJournal {
  constructor({ runId, now, onSnapshot } = {}) {
    if (typeof runId !== "string" || !runId.trim()) {
      throw new Error("DirectExecutionJournal: runId is required");
    }
    this.runId = runId;
    this.ledger = new ExecutionLedger({ now });
    this.onSnapshot = typeof onSnapshot === "function" ? onSnapshot : null;
    this.started = false;
    this.contract = null;
    this.terminalDisposition = null;
  }

  get events() {
    return this.ledger.events;
  }

  get status() {
    if (!this.started) return "pending";
    return reduceExecutionEvents(this.events).runs[this.runId].status;
  }

  async append(fact, { persist = true } = {}) {
    const event = this.ledger.append({ ...definedFields(projectDurableExecutionFact(fact)), runId: this.runId });
    if (persist && this.onSnapshot) await this.onSnapshot(this.events);
    return event;
  }

  async start(contract, detail = {}) {
    if (this.started) return;
    await this.append(definedFields({
      type: "run_started",
      contract: contract || null,
      resumeFromRunId: detail && detail.resumeFromRunId,
    }));
    this.contract = contract || null;
    this.started = true;
  }

  async finishWorkflow(event) {
    if (this.terminalDisposition) return;
    const disposition = String(event && event.disposition || "");
    const detail = definedFields({
      disposition,
      declaration: event && event.declaration,
      verified: event && event.verified,
    });
    if (disposition === "completed") {
      if (!event || event.verified !== true) {
        await this.append({ type: "completion_rejected", final: true });
        await this.append({
          type: "run_failed",
          code: "workflow_completion_unverified",
          message: "Workflow completion was not verified.",
        });
        this.terminalDisposition = "failed";
        return;
      }
      await this.append({ type: "completion_accepted" });
      await this.append({ type: "run_completed", ...detail });
      this.terminalDisposition = disposition;
      return;
    }
    if (disposition === "blocked") {
      await this.append({ type: "run_blocked", ...detail });
      this.terminalDisposition = disposition;
      return;
    }
    if (disposition === "cancelled") {
      await this.append({ type: "cancel_requested", stage: "workflow_finish" });
      await this.append({ type: "run_cancelled", stage: "workflow_finish", ...detail });
      this.terminalDisposition = disposition;
      return;
    }
    await this.append({
      type: "run_failed",
      code: "workflow_disposition_missing",
      message: "Workflow ended without a valid disposition.",
    });
    this.terminalDisposition = "failed";
  }

  async consume(event) {
    if (!event || !this.started) return;
    if (event.type === "tool_start") {
      await this.append(definedFields({
        type: "tool_started",
        toolUseId: event.toolUseId,
        tool: event.tool,
        input: event.input,
        capabilities: event.capabilities,
      }));
      return;
    }
    if (event.type === "tool_progress") {
      // Progress prose/data is useful only to the live UI. It must never
      // become durable session state, even after the final snapshot.
      return;
    }
    if (event.type === "tool_finish") {
      await this.append(definedFields({
        type: "tool_finished",
        toolUseId: event.toolUseId,
        isError: event.isError === true,
        content: event.content,
        outcome: event.outcome,
      }));
      return;
    }
    if (event.type === "effect_receipt") {
      const receipt = event.receipt || {};
      await this.append({
        type: receipt.verified === true ? "effect_verified" : "effect_unverified",
        toolUseId: receipt.toolUseId,
        receipt,
      });
      return;
    }
    if (event.type === "completion_retry") {
      await this.append(definedFields({ type: "completion_rejected", attempt: event.attempt }));
      return;
    }
    if (event.type === "workflow_finish") {
      await this.finishWorkflow(event);
      return;
    }
    if (event.type === "done") {
      if (this.terminalDisposition) return;
      if (event.disposition || (this.contract && this.contract.mode === "workflow")) {
        await this.finishWorkflow(event);
        return;
      }
      await this.append({ type: "completion_accepted" });
      await this.append({ type: "run_completed" });
      this.terminalDisposition = "completed";
      return;
    }
    if (event.type === "cancelled") {
      if (this.terminalDisposition) return;
      await this.append(definedFields({ type: "cancel_requested", stage: event.stage }));
      await this.append(definedFields({ type: "run_cancelled", stage: event.stage }));
      this.terminalDisposition = "cancelled";
      return;
    }
    if (event.type === "suspended") {
      if (this.terminalDisposition) return;
      if (!projectCheckpointRef(event.checkpointRef)) {
        const error = new Error("A durable suspension requires a valid checkpoint reference.");
        error.code = "CONTINUATION_CHECKPOINT_REFERENCE_REQUIRED";
        throw error;
      }
      await this.append(definedFields({
        type: "run_suspended",
        reason: event.reason,
        stage: event.stage,
        turns: event.turns,
        checkpointRef: event.checkpointRef,
      }));
      this.terminalDisposition = "suspended";
      return;
    }
    if (event.type === "error") {
      const error = event.error || {};
      if (error.type === "completion_contract_failed") {
        await this.append({ type: "completion_rejected", final: true });
      }
      await this.append(definedFields({
        type: "run_failed",
        code: error.type,
        message: error.message,
      }));
    }
  }
}

module.exports = { DirectExecutionJournal };
