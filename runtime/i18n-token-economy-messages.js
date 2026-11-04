const LABELS = {
  "zh-CN": {
    "deepseekReasoningName": "DeepSeek 思考模式",
    "deepseekReasoningDesc": "日常适合捕获和编辑；深度适合复杂分析；关闭适合简单操作。思考也消耗输出 token。",
    "deepseekReasoningLow": "日常（低强度，推荐）",
    "deepseekReasoningHigh": "深度（高强度）",
    "deepseekReasoningDisabled": "关闭思考"
  },
  "en": {
    "deepseekReasoningName": "DeepSeek thinking mode",
    "deepseekReasoningDesc": "Use low for capture and edits, high for complex analysis, or disable for simple operations. Thinking uses output tokens.",
    "deepseekReasoningLow": "Everyday (low, recommended)",
    "deepseekReasoningHigh": "Deep (high)",
    "deepseekReasoningDisabled": "Thinking off"
  },
  "ru": {
    "deepseekReasoningName": "Режим рассуждения DeepSeek",
    "deepseekReasoningDesc": "Низкий уровень для заметок; высокий для сложного анализа; без рассуждений для простых действий. Рассуждения расходуют выходные токены.",
    "deepseekReasoningLow": "Повседневный (низкий)",
    "deepseekReasoningHigh": "Глубокий (высокий)",
    "deepseekReasoningDisabled": "Без рассуждений"
  }
};
function applyTokenEconomyMessages(messages) {
  for (const [locale, labels] of Object.entries(LABELS)) {
    if (messages[locale]?.settings?.agent) Object.assign(messages[locale].settings.agent, labels);
  }
}
module.exports = { applyTokenEconomyMessages };
