// Volatile context belongs to the current user turn, after the reusable prefix.
function buildTurnTimeContext(label, locale = "en") {
  const time = String(label || "");
  return String(locale).startsWith("zh")
    ? `[FLOWNOTE_CURRENT_TIME] 当前本地日期和时间：${time}。本次请求中的今天、昨天、本周及新记录时间戳以此为准。`
    : `[FLOWNOTE_CURRENT_TIME] Current local date and time: ${time}. Resolve relative dates and new entry timestamps for this request using this value.`;
}
module.exports = { buildTurnTimeContext };
