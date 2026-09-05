const { FileStateCache } = require("../agent/file-state-cache");
const { appendResumeInstruction, validateContinuationCheckpoint } = require("../agent/continuation-checkpoint");
const { findResumableContinuation } = require("./history-builder");

async function readVaultFile(vault, path) {
  if (!vault) throw new Error("Vault is unavailable while restoring a continuation checkpoint.");
  const normalized = String(path || "").replace(/^\/+/, "");
  const file = typeof vault.getFileByPath === "function"
    ? vault.getFileByPath(normalized)
    : typeof vault.getAbstractFileByPath === "function"
      ? vault.getAbstractFileByPath(normalized)
      : null;
  if (!file || Array.isArray(file.children)) throw new Error(`Checkpoint file is unavailable: ${normalized}`);
  if (typeof vault.cachedRead === "function") return vault.cachedRead(file);
  if (typeof vault.read === "function") return vault.read(file);
  throw new Error("Vault cannot read files while restoring a continuation checkpoint.");
}

function appendDriftNotice(history, driftedPaths) {
  if (!Array.isArray(driftedPaths) || driftedPaths.length === 0) return;
  const notice = {
    type: "text",
    text:
      "[FLOWNOTE_RESUME_DRIFT] These files changed after the checkpoint and must be read again before " +
      `any edit: ${driftedPaths.join(", ")}`,
  };
  const tail = history[history.length - 1];
  if (tail && tail.role === "user" && Array.isArray(tail.content)) tail.content.push(notice);
  else history.push({ role: "user", content: [notice] });
}

async function prepareContinuationContext({
  storedMessages,
  draftId,
  userText,
  continuationMessageId,
  continuationRunId,
  sessionId,
  sessionStore,
  persistState,
  vault,
  checkpointStore,
} = {}) {
  const fileStateCache = new FileStateCache();
  const lookup = findResumableContinuation(storedMessages, {
    draftId,
    userText,
    continuationMessageId,
    continuationRunId,
  });
  if (lookup.status === "not_found" && lookup.reason === "not_resume_request") {
    return {
      continuation: null,
      continuationLookup: lookup,
      history: null,
      executionContract: null,
      effectReceipts: [],
      resumeFromRunId: null,
      resumeState: null,
      fileStateCache,
    };
  }
  if (!["resumable", "claimed"].includes(lookup.status)) {
    throw continuationLookupError(lookup);
  }

  let claimAcquired = false;
  if (sessionStore && typeof sessionStore.claimContinuation === "function") {
    const claim = sessionStore.claimContinuation(sessionId, lookup.messageId, draftId, lookup.runId);
    const claimStatus = claim === true ? "claimed" : claim && claim.status;
    if (claimStatus !== "claimed") throw continuationClaimError(claim);
    claimAcquired = true;
  } else if (lookup.status === "claimed") {
    throw continuationLookupError(lookup);
  }

  try {
    if (claimAcquired && typeof persistState === "function") await persistState();
    const checkpoint = lookup.checkpointRef
      ? await loadCheckpointRef(checkpointStore, lookup.checkpointRef)
      : lookup.checkpoint;
    const history = appendResumeInstruction(checkpoint.messages, userText);
    if (checkpoint.fileState) {
      const restored = await fileStateCache.restoreSnapshot(
        checkpoint.fileState,
        async (path) => readVaultFile(vault, path),
      );
      appendDriftNotice(history, restored.driftedPaths);
    }

    return {
      continuation: lookup,
      continuationLookup: lookup,
      history,
      executionContract: checkpoint.contract,
      effectReceipts: Array.isArray(checkpoint.effectReceipts)
        ? JSON.parse(JSON.stringify(checkpoint.effectReceipts))
        : [],
      resumeFromRunId: lookup.runId,
      resumeState: {
        effectReceipts: checkpoint.effectReceipts,
        ...(Array.isArray(checkpoint.interactionReceipts)
          ? { interactionReceipts: checkpoint.interactionReceipts }
          : {}),
        completionRetries: checkpoint.completionRetries,
        turns: checkpoint.turns,
        allowedToolPolicy: checkpoint.allowedToolPolicy || null,
        effectAttempts: Array.isArray(checkpoint.effectAttempts) ? checkpoint.effectAttempts : [],
      },
      fileStateCache,
    };
  } catch (error) {
    if (claimAcquired && sessionStore && typeof sessionStore.releaseContinuation === "function") {
      sessionStore.releaseContinuation(sessionId, lookup.messageId, draftId);
      if (typeof persistState === "function") {
        try { await persistState(); } catch (_releaseError) {}
      }
    }
    throw error;
  }
}

async function loadCheckpointRef(checkpointStore, ref) {
  if (!checkpointStore || typeof checkpointStore.load !== "function") {
    const error = new Error("Continuation checkpoint storage is unavailable.");
    error.code = "CONTINUATION_CHECKPOINT_UNAVAILABLE";
    throw error;
  }
  const checkpoint = await checkpointStore.load(ref);
  const validation = validateContinuationCheckpoint(checkpoint);
  if (!validation.ok) {
    const error = new Error(`Continuation checkpoint is invalid: ${validation.error}`);
    error.code = "CONTINUATION_CHECKPOINT_INVALID";
    throw error;
  }
  return checkpoint;
}

function continuationLookupError(lookup) {
  const status = String((lookup && lookup.status) || "not_found");
  const codes = {
    not_found: "CONTINUATION_NOT_FOUND",
    claimed: "CONTINUATION_ALREADY_CLAIMED",
    corrupt: "CONTINUATION_CORRUPT",
    stale: "CONTINUATION_STALE",
  };
  const error = new Error(
    status === "claimed"
      ? "This suspended workflow is already being continued by another request."
      : `The requested continuation is ${status.replace(/_/g, " ")}.`,
  );
  error.code = codes[status] || "CONTINUATION_NOT_FOUND";
  error.continuation = lookup || null;
  return error;
}

function continuationClaimError(claim) {
  const status = String((claim && claim.status) || "active");
  if (status === "consumed") {
    const error = new Error("This checkpoint was already consumed by a completed continuation.");
    error.code = "CONTINUATION_ALREADY_CONSUMED";
    error.continuation = claim || null;
    return error;
  }
  if (status === "stale") return continuationLookupError({ ...(claim || {}), status: "stale" });
  return continuationLookupError({ ...(claim || {}), status: "claimed" });
}

function buildSuspensionCopy(locale, state, translate) {
  const reason = String(state && state.suspension && state.suspension.reason || "").trim();
  const connectionInterrupted = reason === "provider_stream_interrupted";
  const missingFinalAnswer = reason === "empty_final_response";
  const receipts = Array.isArray(state && state.effectReceipts) ? state.effectReceipts : [];
  const verifiedEffects = receipts.filter((receipt) => (
    receipt
    && receipt.verified === true
    && receipt.kind !== "observation"
  ));
  const paths = Array.from(new Set(verifiedEffects.flatMap((receipt) => (
    Array.isArray(receipt.paths) ? receipt.paths.map((path) => String(path || "").trim()).filter(Boolean) : []
  ))));
  const safePaths = paths.map((path) => path.replace(/`/g, ""));
  if (safePaths.length > 0) {
    const list = safePaths.map((path) => `- \`${path}\``).join("\n");
    if (connectionInterrupted) {
      return translate(
        locale,
        `连接中断，当前进度已保留。已验证完成 ${safePaths.length} 项文件更改：\n\n${list}\n\n点击“继续”即可恢复，已完成的更改不会重复执行。`,
        `The connection was interrupted, but progress was preserved. ${safePaths.length} verified file change(s) are complete:\n\n${list}\n\nSelect Continue to resume without repeating completed changes.`,
      );
    }
    return translate(
      locale,
      `已暂停，可继续。已验证完成 ${safePaths.length} 项文件更改：\n\n${list}\n\n发送“继续”将从当前进度恢复，不会重做这些更改。`,
      `Paused and ready to continue. ${safePaths.length} verified file change(s) are already complete:\n\n${list}\n\nSend “continue” to resume from this checkpoint without repeating them.`,
    );
  }
  if (verifiedEffects.length > 0) {
    if (connectionInterrupted) {
      return translate(
        locale,
        `连接中断，当前进度已保留。已有 ${verifiedEffects.length} 项操作得到验证；点击“继续”即可恢复。`,
        `The connection was interrupted, but progress was preserved. ${verifiedEffects.length} verified action(s) are complete; select Continue to resume.`,
      );
    }
    return translate(
      locale,
      `已暂停，可继续。已有 ${verifiedEffects.length} 项操作得到验证；发送“继续”将从当前进度恢复。`,
      `Paused and ready to continue. ${verifiedEffects.length} verified action(s) are preserved; send “continue” to resume.`,
    );
  }
  if (connectionInterrupted) {
    return translate(
      locale,
      "连接中断，当前进度已保留。点击“继续”即可恢复。",
      "The connection was interrupted, but progress was preserved. Select Continue to resume.",
    );
  }
  if (missingFinalAnswer) {
    return translate(
      locale,
      "当前进度已保留，但没有收到最终答复。点击“继续”即可恢复。",
      "Progress was preserved, but no final answer was received. Select Continue to resume.",
    );
  }
  return translate(
    locale,
    "已暂停，可继续。本次暂停前没有产生已验证的更改；发送“继续”将从当前进度恢复。",
    "Paused and ready to continue. No verified changes were made before the pause; send “continue” to resume.",
  );
}

module.exports = {
  prepareContinuationContext,
  buildSuspensionCopy,
};
