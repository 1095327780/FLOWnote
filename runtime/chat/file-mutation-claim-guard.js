const FILE_MUTATION_TOOLS = /^(vault_write|vault_edit|vault_move|vault_property|vault_daily|vault_create_dir)$/;

function hasSuccessfulFileMutation(toolUses) {
  return Array.isArray(toolUses) && toolUses.some((t) =>
    FILE_MUTATION_TOOLS.test(String((t && t.name) || "")) && !(t && t.isError),
  );
}

function claimsCompletedFileMutation(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (/(?:无法|不能|未能|没有|尚未|失败|出错|需要你|请提供|can't|cannot|could not|failed|not able|need you to)/i.test(raw)) {
    return false;
  }

  const zhCompleted = /(?:已|已经|完成|搞定|处理好了|帮你)/;
  const zhMutation = /(?:重命名|改名|移动|迁移|归档|创建|新建|写入|保存|修改|更新|删除|改成|改为)/;
  const enCompletedMutation = /\b(?:renamed|moved|archived|created|wrote|written|saved|edited|updated|deleted)\b/i;
  const enDone = /\b(?:done|completed|finished)\b/i;
  const enMutation = /\b(?:rename|move|archive|create|write|save|edit|update|delete)\b/i;
  return (zhCompleted.test(raw) && zhMutation.test(raw)) ||
    enCompletedMutation.test(raw) ||
    (enDone.test(raw) && enMutation.test(raw));
}

function shouldBlockUnbackedFileMutationClaim({ text, toolUses } = {}) {
  return !!text && !hasSuccessfulFileMutation(toolUses) && claimsCompletedFileMutation(text);
}

function unbackedFileMutationWarning(locale) {
  return locale === "zh-CN"
    ? "⚠️ 我这轮没有成功调用任何文件变更工具，所以没有真的改动你的文件。\n\n" +
      "请重新发送请求，并尽量提供明确的库内相对路径；如果是重命名或移动，我会先调用 `vault_move`，成功后再回复结果。"
    : "I did not successfully call any file-changing tool in this turn, so no files were actually changed.\n\n" +
      "Please send the request again with clear vault-relative paths. For renames or moves, I will call `vault_move` first and only confirm after it succeeds.";
}

module.exports = {
  claimsCompletedFileMutation,
  hasSuccessfulFileMutation,
  shouldBlockUnbackedFileMutationClaim,
  unbackedFileMutationWarning,
};
