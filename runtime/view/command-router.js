const { Notice } = require("obsidian");

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function getSkillPrimaryDescription(skill) {
  if (!skill) return "选择技能后会显示主要功能说明。";

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

  return lines[0] || "暂无技能说明";
}

function getSkillBriefDescription(skill) {
  const primary = String(this.getSkillPrimaryDescription(skill) || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!primary || primary === "暂无技能说明") return "";

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
  const promptText = rest || `请按技能 ${skill.name || skill.id} 处理当前任务。`;
  return { skill, promptText };
}

function openSkillSelector() {
  const skills = this.plugin.skillService.getSkills();
  if (!skills.length) {
    new Notice("当前未发现可用技能，请先检查 Skills 目录设置。");
    return;
  }
  const select = this.elements.skillSelect;
  if (!select || select.disabled) {
    new Notice("技能下拉尚未初始化，请稍后再试。");
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
  this.setRuntimeStatus("请从技能下拉列表中选择技能。", "info");
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
    throw new Error(`模型不可用或当前账号未授权：${normalized}`);
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
      if (!options.silentNotice) new Notice(`已切换模型：${normalized}`);
      return `已切换模型：${normalized}`;
    }

    if (!options.silentNotice) new Notice("已恢复默认模型（由 FLOWnote 自动选择）");
    return "已恢复默认模型（由 FLOWnote 自动选择）";
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
    new Notice("模型下拉尚未初始化，请稍后再试。");
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
  this.setRuntimeStatus("请从模型下拉列表中选择模型。", "info");
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
    this.appendAssistantMessage(sessionId, "请从模型下拉列表中选择模型。", "");
    await this.plugin.persistState();
    this.renderMessages();
    this.renderSidebar(this.root.querySelector(".oc-side"));
    await this.openModelSelector(sessionId);
    return;
  }

  try {
    const text = await this.applyModelSelection(parsed.args, { silentNotice: true });
    this.appendAssistantMessage(sessionId, text, "");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    this.appendAssistantMessage(sessionId, `模型切换失败: ${msg}`, msg);
    new Notice(`模型切换失败: ${msg}`);
  }

  await this.plugin.persistState();
  this.renderMessages();
  this.renderSidebar(this.root.querySelector(".oc-side"));
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
