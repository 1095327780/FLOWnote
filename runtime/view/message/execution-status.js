function isZhContext(viewCtx) {
  if (viewCtx && viewCtx.plugin && typeof viewCtx.plugin.getEffectiveLocale === "function") {
    return viewCtx.plugin.getEffectiveLocale() === "zh-CN";
  }
  return false;
}

function executionStatusLabel(viewCtx, status) {
  const value = String(status || "").trim().toLowerCase();
  const zh = isZhContext(viewCtx);
  if (value === "cancelled") return zh ? "已取消" : "Cancelled";
  if (value === "suspended") return zh ? "已暂停，可继续" : "Paused — ready to continue";
  if (value === "blocked") return zh ? "未完成，请检查失败项" : "Not completed — check failed steps";
  if (value === "interrupted") return zh ? "运行中断，请检查更改" : "Interrupted — check changes";
  if (value === "failed") return zh ? "未完成" : "Not completed";
  return "";
}

module.exports = {
  executionStatusLabel,
};
