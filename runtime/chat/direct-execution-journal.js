const { ExecutionLedger, reduceExecutionEvents } = require("../agent/execution-ledger");
const { projectDurableExecutionFact, projectCheckpointRef } = require("../agent/durable-execution-projection");
const { buildToolInputPreview, buildToolResultPreview } = require("../agent/tool-history-preview");

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

  /**
   * Durably record that an external mutation is about to be sent. Resolves
   * only after the snapshot is persisted; the caller must not send otherwise.
   */
  async recordEffectAttempt({ toolUseId, attempt } = {}) {
    if (!this.started || this.terminalDisposition) throw new Error("Execution journal is not open.");
    if (!this.onSnapshot) throw new Error("Execution journal persistence is unavailable.");
    await this.append({ type: "effect_attempt_sending", toolUseId, attempt });
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

  async consume(event) {
    if (!event || !this.started) return;
    if (event.type === "tool_start") {
      await this.append(definedFields({
        type: "tool_started",
        toolUseId: event.toolUseId,
        tool: event.tool,
        input: event.input,
        inputPreview: buildToolInputPreview(event.input),
        capabilities: event.capabilities,
      }));
      this.toolEffects = this.toolEffects || new Map();
      this.toolEffects.set(event.toolUseId, event.capabilities && event.capabilities.effect);
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
        resultPreview: buildToolResultPreview(event.content, {
          isError: event.isError === true,
          effect: (event.capabilities && event.capabilities.effect)
            || (this.toolEffects && this.toolEffects.get(event.toolUseId)),
        }),
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
    if (event.type === "done") {
      if (this.terminalDisposition) return;
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
      await this.append(definedFields({
        type: "run_failed",
        code: error.type,
        message: error.message,
      }));
    }
  }
}

module.exports = { DirectExecutionJournal };
