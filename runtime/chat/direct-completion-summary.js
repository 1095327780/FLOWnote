function localeFamily(locale) {
  const value = String(locale || "").trim().toLowerCase();
  if (value.startsWith("zh")) return "zh";
  if (value.startsWith("ru")) return "ru";
  return "en";
}

function copyFor(locale) {
  const family = localeFamily(locale);
  if (family === "zh") {
    return {
      mutationHeading: "**已完成并核验**",
      observationHeading: "**已完成检查**",
      write: "写入",
      create: "创建",
      append: "追加到",
      edit: "更新",
      property: "更新属性",
      directory: "确保文件夹存在",
      move: "移动",
      inspect: "读取",
      verifiedChanges: (count) => `已核验 ${count} 项更改。`,
      verifiedSources: (count) => `已核验 ${count} 项来源。`,
      more: (count) => `另有 ${count} 项，可在“过程”中查看`,
    };
  }
  if (family === "ru") {
    return {
      mutationHeading: "**Выполнено и проверено**",
      observationHeading: "**Проверка завершена**",
      write: "Записан файл",
      create: "Создан файл",
      append: "Добавлено в",
      edit: "Обновлен файл",
      property: "Обновлены свойства",
      directory: "Папка существует",
      move: "Перемещено",
      inspect: "Прочитан файл",
      verifiedChanges: (count) => `Проверено изменений: ${count}.`,
      verifiedSources: (count) => `Проверено источников: ${count}.`,
      more: (count) => `Еще ${count} — в разделе процесса`,
    };
  }
  return {
    mutationHeading: "**Completed and verified**",
    observationHeading: "**Inspection complete**",
    write: "Wrote",
    create: "Created",
    append: "Appended to",
    edit: "Updated",
    property: "Updated properties in",
    directory: "Ensured folder exists",
    move: "Moved",
    inspect: "Read",
    verifiedChanges: (count) => `Verified ${count} change${count === 1 ? "" : "s"}.`,
    verifiedSources: (count) => `Verified ${count} source${count === 1 ? "" : "s"}.`,
    more: (count) => `${count} more in Process`,
  };
}

function safeInlineCode(value) {
  const normalized = String(value || "").trim().replace(/`/g, "'");
  return normalized ? `\`${normalized}\`` : "";
}

function verifiedReceipts(effectReceipts) {
  return (Array.isArray(effectReceipts) ? effectReceipts : [])
    .filter((receipt) => receipt && receipt.verified === true);
}

function toolForReceipt(receipt, toolUses) {
  const declared = String(receipt && receipt.tool || "").trim();
  const toolUseId = String(receipt && receipt.toolUseId || "").trim();
  const match = (Array.isArray(toolUses) ? toolUses : [])
    .find((toolUse) => toolUse && String(toolUse.id || "") === toolUseId);
  return {
    name: String(match && match.name || declared || "").trim(),
    input: match && match.input && typeof match.input === "object" ? match.input : null,
  };
}

function receiptPaths(receipt) {
  const values = Array.isArray(receipt && receipt.paths) ? receipt.paths : [];
  return [...new Set(values.map((path) => String(path || "").trim()).filter(Boolean))];
}

function actionLabel(copy, tool, pathIndex = 0) {
  const name = String(tool && tool.name || "").trim();
  const mode = String(tool && tool.input && tool.input.mode || "").trim().toLowerCase();
  if (name === "vault_move") return copy.move;
  if (name === "vault_create_dir") return copy.directory;
  if (name === "vault_property") return copy.property;
  if (name === "vault_edit") return copy.edit;
  if (name === "vault_write") {
    if (mode === "create") return copy.create;
    if (mode === "append") return copy.append;
    return copy.write;
  }
  if (name === "vault_read" || name === "vault_list" || name === "vault_search") return copy.inspect;
  return pathIndex >= 0 ? copy.edit : "";
}

function mutationLines(receipts, toolUses, copy) {
  const lines = [];
  for (const receipt of receipts) {
    const tool = toolForReceipt(receipt, toolUses);
    const paths = receiptPaths(receipt);
    if (tool.name === "vault_move" && paths.length >= 2) {
      lines.push(`- ${copy.move} ${safeInlineCode(paths[0])} → ${safeInlineCode(paths[1])}`);
      continue;
    }
    for (let index = 0; index < paths.length; index += 1) {
      lines.push(`- ${actionLabel(copy, tool, index)} ${safeInlineCode(paths[index])}`);
    }
  }
  return [...new Set(lines)];
}

function observationLines(receipts, copy) {
  const paths = [...new Set(receipts.flatMap((receipt) => receiptPaths(receipt)))];
  return paths.map((path) => `- ${copy.inspect} ${safeInlineCode(path)}`);
}

function buildVerifiedCompletionSummary({
  locale,
  effectReceipts,
  toolUses,
  maxItems = 5,
  includeObservations = false,
} = {}) {
  const copy = copyFor(locale);
  const receipts = verifiedReceipts(effectReceipts);
  if (!receipts.length) return "";

  const mutations = receipts.filter((receipt) => String(receipt.kind || "").trim() !== "observation");
  if (!mutations.length && !includeObservations) return "";
  const selected = mutations.length ? mutations : receipts;
  const rawLines = mutations.length
    ? mutationLines(selected, toolUses, copy)
    : observationLines(selected, copy);
  const limit = Math.max(1, Math.floor(Number(maxItems) || 5));
  const visibleLines = rawLines.slice(0, limit);
  if (rawLines.length > visibleLines.length) {
    visibleLines.push(`- ${copy.more(rawLines.length - visibleLines.length)}`);
  }

  const heading = mutations.length ? copy.mutationHeading : copy.observationHeading;
  if (visibleLines.length) return `${heading}\n${visibleLines.join("\n")}`;
  const fallback = mutations.length
    ? copy.verifiedChanges(selected.length)
    : copy.verifiedSources(selected.length);
  return `${heading}\n${fallback}`;
}

function mergeVerifiedCompletionSummary(modelText, summary, genericFallback = "") {
  const text = String(modelText || "").trim();
  const verifiedSummary = String(summary || "").trim();
  if (!verifiedSummary) return text;
  if (!text || (genericFallback && text === String(genericFallback).trim())) return verifiedSummary;
  return `${text}\n\n${verifiedSummary}`;
}

module.exports = {
  buildVerifiedCompletionSummary,
  mergeVerifiedCompletionSummary,
};
