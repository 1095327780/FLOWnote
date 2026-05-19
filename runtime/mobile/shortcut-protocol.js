const { Notice } = require("obsidian");
const { tFromContext } = require("../i18n-runtime");
const { isTruthyParam, readTextParam } = require("./shortcut-url-utils");

async function ensureAssistantRuntime(plugin) {
  if (!plugin) return false;
  if (!plugin.sessionStore || typeof plugin.activateView !== "function") {
    if (typeof plugin.ensureFacadeMethodsLoaded === "function") plugin.ensureFacadeMethodsLoaded();
    if (typeof plugin.loadPersistedData === "function") await plugin.loadPersistedData();
    if (typeof plugin.bootstrapMobileFullRuntime === "function") await plugin.bootstrapMobileFullRuntime();
  }
  return typeof plugin.activateView === "function";
}

async function openAssistant(plugin) {
  if (plugin && typeof plugin.activateMobileAssistantView === "function") {
    await plugin.activateMobileAssistantView();
    return;
  }
  if (await ensureAssistantRuntime(plugin)) await plugin.activateView();
}

async function openNewSession(plugin) {
  if (!(await ensureAssistantRuntime(plugin))) return;
  const session = typeof plugin.createSession === "function" ? await plugin.createSession("") : null;
  if (session && plugin.sessionStore && typeof plugin.sessionStore.setActiveSession === "function") {
    plugin.sessionStore.setActiveSession(session.id);
  }
  if (typeof plugin.persistState === "function") await plugin.persistState();
  await plugin.activateView();
  const view = typeof plugin.getAssistantView === "function" ? plugin.getAssistantView() : null;
  if (view && typeof view.render === "function") view.render();
}

async function openChat(plugin, params) {
  const text = readTextParam(params);
  await openAssistant(plugin);
  if (!text) return;
  const view = typeof plugin.getAssistantView === "function" ? plugin.getAssistantView() : null;
  if (view && typeof view.sendPrompt === "function") {
    await view.sendPrompt(text);
  }
}

function openCapture(plugin, params) {
  const text = readTextParam(params);
  const autoSubmit = isTruthyParam(params && params.submit);
  if (plugin && typeof plugin.openCaptureModal === "function") {
    plugin.openCaptureModal({ initialText: text, autoSubmit });
  }
}

function registerShortcutProtocolHandlers(plugin) {
  if (!plugin || typeof plugin.registerObsidianProtocolHandler !== "function") return false;
  if (plugin.__flownoteShortcutProtocolRegistered) return true;
  const t = (key, fallback, params = {}) => tFromContext(plugin, key, fallback, params);
  const safely = (fn) => async (params) => {
    try {
      await fn(params || {});
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      new Notice(t("notices.shortcutFailed", "快捷指令执行失败：{message}", { message }));
      if (typeof plugin.log === "function") plugin.log(`shortcut protocol failed: ${message}`);
    }
  };

  plugin.registerObsidianProtocolHandler("flownote-open", safely(() => openAssistant(plugin)));
  plugin.registerObsidianProtocolHandler("flownote-capture", safely((params) => openCapture(plugin, params)));
  plugin.registerObsidianProtocolHandler("flownote-chat", safely((params) => openChat(plugin, params)));
  plugin.registerObsidianProtocolHandler("flownote-new-session", safely(() => openNewSession(plugin)));
  plugin.__flownoteShortcutProtocolRegistered = true;
  return true;
}

module.exports = {
  registerShortcutProtocolHandlers,
  openCapture,
  openChat,
  openAssistant,
  openNewSession,
};
