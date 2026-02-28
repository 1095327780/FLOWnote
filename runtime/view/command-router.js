const { Notice } = require("obsidian");
const { tFromContext } = require("../i18n-runtime");

function tr(view, key, fallback, params = {}) {
  return tFromContext(view, key, fallback, params);
}

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function getSkillPrimaryDescription(skill) {
  if (!skill) return tr(this, "view.skill.primaryFallback", "Select a skill to see its primary description.");

  const cleanInline = (line) => String(line || "")
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^>\s+/, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();

  const directRaw = String(skill.description || "").trim();
  const isBlockMarker = /^([>|][+-]?)$/.test(directRaw);
  if (!isBlockMarker && directRaw) {
    const directLines = directRaw
      .split(/\r?\n/)
      .map((line) => cleanInline(line))
      .filter((line) => line && !/^[-:| ]+$/.test(line));
    if (directLines.length) return directLines[0];
  }

  const lines = String(skill.summary || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (!line.startsWith("|")) return line.replace(/^[-*]\s+/, "");
      const cells = line
        .split("|")
        .map((cell) => cell.trim().replace(/^[-*]\s+/, ""))
        .filter(Boolean);
      const picked = cells.find((cell) => (
        !/^[-:]+$/.test(cell) &&
        !/^(name|名称|命令|command|技能|skill|功能|作用|描述|description)$/i.test(cell) &&
        !cell.startsWith("/")
      ));
      return picked || "";
    })
    .map((line) => cleanInline(line))
    .filter((line) => (
      line &&
      !/^#{1,6}\s/.test(line) &&
      !/^```/.test(line) &&
      !/^[-:| ]+$/.test(line)
    ));

  return lines[0] || tr(this, "view.skill.noDescription", "No skill description");
}

function getSkillBriefDescription(skill) {
  const primary = String(this.getSkillPrimaryDescription(skill) || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!primary || primary === tr(this, "view.skill.noDescription", "No skill description")) return "";

  let brief = primary;
  const namePrefix = String(skill && skill.name ? skill.name : "").trim();
  if (namePrefix && brief.toLowerCase().startsWith(namePrefix.toLowerCase())) {
    brief = brief.slice(namePrefix.length).trim();
    brief = brief.replace(/^[(（][^)）]+[)）]\s*[-—:：]?\s*/, "");
    brief = brief.replace(/^[-—:：\s]+/, "");
  }

  if (!brief) brief = primary;
  const delimiters = ["：", ":", "。", "；", ";", "，", ",", "（", "("];
  let cutIndex = brief.length;
  delimiters.forEach((delimiter) => {
    const index = brief.indexOf(delimiter);
    if (index > 0 && index < cutIndex) cutIndex = index;
  });
  brief = brief.slice(0, cutIndex).trim();
  if (brief.length > 24) brief = `${brief.slice(0, 24)}…`;
  return brief;
}

function parseModelSlashCommand(text) {
  const input = String(text || "").trim();
  if (!input.startsWith("/")) return null;

  const raw = input.slice(1).trim();
  if (!raw) return null;

  const firstSpace = raw.indexOf(" ");
  const cmd = (firstSpace >= 0 ? raw.slice(0, firstSpace) : raw).trim().toLowerCase();
  const args = (firstSpace >= 0 ? raw.slice(firstSpace + 1) : "").trim();

  if (!["models", "model", "modle"].includes(cmd)) return null;
  return { command: "models", args };
}

function parseSkillSelectorSlashCommand(text) {
  const input = String(text || "").trim();
  if (!input.startsWith("/")) return null;

  const raw = input.slice(1).trim();
  if (!raw) return null;

  const firstSpace = raw.indexOf(" ");
  const cmd = (firstSpace >= 0 ? raw.slice(0, firstSpace) : raw).trim().toLowerCase();
  if (!["skills", "skill"].includes(cmd)) return null;
  return { command: "skills" };
}

function resolveSkillFromPrompt(userText) {
  const input = String(userText || "").trim();
  if (!input.startsWith("/")) return { skill: null, promptText: input };

  const raw = input.slice(1).trim();
  if (!raw) return { skill: null, promptText: input };

  const firstSpace = raw.indexOf(" ");
  const cmd = (firstSpace >= 0 ? raw.slice(0, firstSpace) : raw).trim();
  const cmdLower = cmd.toLowerCase();
  if (!cmdLower) return { skill: null, promptText: input };
  if (["models", "model", "modle", "skills", "skill"].includes(cmdLower)) {
    return { skill: null, promptText: input };
  }

  const skills = this.plugin.skillService.getSkills();
  const skill = skills.find((item) => {
    const id = String(item.id || "").toLowerCase();
    const name = String(item.name || "").toLowerCase();
    return id === cmdLower || name === cmdLower;
  });

  if (!skill) return { skill: null, promptText: input };

  const rest = (firstSpace >= 0 ? raw.slice(firstSpace + 1) : "").trim();
  const promptText = rest || tr(
    this,
    "view.skill.defaultPrompt",
    "Please handle this task with skill {name}.",
    { name: skill.name || skill.id },
  );
  return { skill, promptText };
}

function openSkillSelector() {
  const skills = this.plugin.skillService.getSkills();
  if (!skills.length) {
    new Notice(tr(this, "view.skill.noneFound", "No available skills found. Check Skills directory settings."));
    return;
  }
  const select = this.elements.skillSelect;
  if (!select || select.disabled) {
    new Notice(tr(this, "view.skill.notReady", "Skill dropdown is not ready yet. Try again shortly."));
    return;
  }
  select.focus();
  if (typeof select.showPicker === "function") {
    try {
      select.showPicker();
      return;
    } catch {
    }
  }
  this.setRuntimeStatus(tr(this, "view.skill.selectHint", "Please choose a skill from the dropdown."), "info");
}

async function refreshModelList() {
  if (this.plugin && typeof this.plugin.loadModelCatalogFromTerminalOutput === "function") {
    const cachedModels = this.plugin.loadModelCatalogFromTerminalOutput();
    if (Array.isArray(cachedModels) && cachedModels.length && typeof this.updateModelSelectOptions === "function") {
      this.updateModelSelectOptions();
    }
  }

  if (this.plugin && typeof this.plugin.refreshModelCatalog === "function") {
    return this.plugin.refreshModelCatalog();
  }
  const models = await this.plugin.opencodeClient.listModels();
  this.plugin.cachedModels = Array.isArray(models) ? models : [];
  if (typeof this.updateModelSelectOptions === "function") this.updateModelSelectOptions();
  return this.plugin.cachedModels;
}

async function ensureActiveSession() {
  const st = this.plugin.sessionStore.state();
  if (st.activeSessionId) return st.activeSessionId;
  const session = await this.plugin.createSession("");
  this.plugin.sessionStore.setActiveSession(session.id);
  await this.plugin.persistState();
  return session.id;
}

async function applyModelSelection(modelID, options = {}) {
  const normalized = String(modelID || "").trim();
  const previous = String(this.selectedModel || "");
  const previousSetting = String(this.plugin.settings.defaultModel || "");
  const availableModels = Array.isArray(this.plugin.cachedModels) ? this.plugin.cachedModels : [];

  if (normalized && availableModels.length && !availableModels.includes(normalized)) {
    throw new Error(tr(this, "view.model.unavailable", "Model unavailable or not authorized: {model}", { model: normalized }));
  }

  this.selectedModel = normalized;
  this.plugin.settings.defaultModel = normalized;
  await this.plugin.saveSettings();

  if (this.elements.modelSelect) {
    this.elements.modelSelect.value = normalized;
  }

  try {
    if (normalized) {
      await this.plugin.opencodeClient.setDefaultModel({ model: normalized });
      if (!options.silentNotice) new Notice(tr(this, "view.model.switched", "Switched model: {model}", { model: normalized }));
      return tr(this, "view.model.switched", "Switched model: {model}", { model: normalized });
    }

    if (!options.silentNotice) new Notice(tr(this, "view.model.resetAuto", "Reset to automatic model selection by FLOWnote."));
    return tr(this, "view.model.resetAuto", "Reset to automatic model selection by FLOWnote.");
  } catch (e) {
    this.selectedModel = previous;
    this.plugin.settings.defaultModel = previousSetting;
    await this.plugin.saveSettings();
    if (this.elements.modelSelect) this.elements.modelSelect.value = previous;
    throw e;
  }
}

async function openModelSelector(sessionId) {
  let select = this.elements.modelSelect;
  if (!select) {
    this.render();
    select = this.elements.modelSelect;
  }
  if (typeof this.updateModelSelectOptions === "function") this.updateModelSelectOptions();

  if (!select || select.disabled) {
    new Notice(tr(this, "view.model.notReady", "Model dropdown is not ready yet. Try again shortly."));
    return;
  }

  void this.refreshModelList().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (typeof this.plugin.log === "function") this.plugin.log(`refresh model list failed: ${message}`);
  });

  select.focus();
  if (typeof select.showPicker === "function") {
    try {
      select.showPicker();
      return;
    } catch {
    }
  }
  this.setRuntimeStatus(tr(this, "view.model.selectHint", "Please choose a model from the dropdown."), "info");
}

async function handleModelSlashCommand(userText, parsed) {
  const sessionId = await this.ensureActiveSession();
  this.plugin.sessionStore.appendMessage(sessionId, {
    id: uid("msg"),
    role: "user",
    text: userText,
    createdAt: Date.now(),
  });

  if (!parsed.args) {
    this.appendAssistantMessage(sessionId, tr(this, "view.model.selectHint", "Please choose a model from the dropdown."), "");
    await this.plugin.persistState();
    this.renderMessages();
    this.refreshHistoryMenu();
    await this.openModelSelector(sessionId);
    return;
  }

  try {
    const text = await this.applyModelSelection(parsed.args, { silentNotice: true });
    this.appendAssistantMessage(sessionId, text, "");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    this.appendAssistantMessage(
      sessionId,
      tr(this, "view.model.switchFailed", "Model switch failed: {message}", { message: msg }),
      msg,
    );
    new Notice(tr(this, "view.model.switchFailed", "Model switch failed: {message}", { message: msg }));
  }

  await this.plugin.persistState();
  this.renderMessages();
  this.refreshHistoryMenu();
}

module.exports = { commandRouterMethods: {
  getSkillPrimaryDescription,
  getSkillBriefDescription,
  parseModelSlashCommand,
  parseSkillSelectorSlashCommand,
  resolveSkillFromPrompt,
  openSkillSelector,
  refreshModelList,
  ensureActiveSession,
  applyModelSelection,
  openModelSelector,
  handleModelSlashCommand,
} };
