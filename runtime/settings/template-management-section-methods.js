// Settings tab section: template management. Lists every entry in
// bundled-skills/template-map.json with view / edit / reset controls.
// Bridges to runtime/settings/template-management.js (I/O) and
// modals.TemplateEditorModal (form).

const { Setting, Notice } = require("obsidian");
const { tFromContext } = require("../i18n-runtime");
const {
  listTemplates,
  readTemplate,
  saveTemplate,
  resetTemplate,
} = require("./template-management");
const { TemplateEditorModal } = require("../modals");

function tr(ctx, key, fallback, params = {}) {
  return tFromContext(ctx, key, fallback, params);
}

const TEMPLATE_DISPLAY_KEYS = {
  "daily-note": "settings.templates.labelDaily",
  "weekly-note": "settings.templates.labelWeekly",
  "monthly-note": "settings.templates.labelMonthly",
  "yearly-note": "settings.templates.labelYearly",
  "literature-note": "settings.templates.labelLiterature",
  "evergreen-note": "settings.templates.labelEvergreen",
  "project-note": "settings.templates.labelProject",
  "progress-note": "settings.templates.labelProgress",
  "home-note": "settings.templates.labelHome",
  "topic-note": "settings.templates.labelTopic",
  "domain-note": "settings.templates.labelDomain",
};

const TEMPLATE_DISPLAY_FALLBACKS = {
  "daily-note":     { "zh-CN": "每日笔记模板",     en: "Daily note",      ru: "Ежедневная заметка" },
  "weekly-note":    { "zh-CN": "周报模板",         en: "Weekly review",   ru: "Еженедельный обзор" },
  "monthly-note":   { "zh-CN": "月报模板",         en: "Monthly review",  ru: "Ежемесячный обзор" },
  "yearly-note":    { "zh-CN": "年报模板",         en: "Yearly review",   ru: "Годовой обзор" },
  "literature-note":{ "zh-CN": "文献笔记模板",     en: "Literature note", ru: "Литературная заметка" },
  "evergreen-note": { "zh-CN": "永久笔记模板",     en: "Evergreen note",  ru: "Evergreen заметка" },
  "project-note":   { "zh-CN": "项目模板",         en: "Project",         ru: "Проект" },
  "progress-note":  { "zh-CN": "进度模板",         en: "Progress",        ru: "Прогресс" },
  "home-note":      { "zh-CN": "HOME 模板",        en: "HOME",            ru: "HOME" },
  "topic-note":     { "zh-CN": "主题笔记模板",     en: "Topic note",      ru: "Тематическая заметка" },
  "domain-note":    { "zh-CN": "领域页模板",       en: "Domain page",     ru: "Страница области" },
};

function templateDisplayName(ctx, id, metaSource) {
  const key = TEMPLATE_DISPLAY_KEYS[id];
  const locale = typeof ctx.plugin.getEffectiveLocale === "function"
    ? ctx.plugin.getEffectiveLocale()
    : "zh-CN";
  const fallback = TEMPLATE_DISPLAY_FALLBACKS[id] || {};
  if (key) return tr(ctx, key, fallback[locale] || fallback.en || fallback["zh-CN"] || metaSource.replace(/\.md$/, ""));
  return metaSource.replace(/\.md$/, "");
}

async function renderTemplateManagementSection(containerEl) {
  const plugin = this.plugin;
  if (!plugin) return;

  const host = containerEl.createDiv({ cls: "oc-template-mgmt-host" });
  const renderListLocal = async () => {
    host.empty();

    let items;
    try {
      items = await listTemplates(plugin);
    } catch (e) {
      host.createDiv({
        cls: "oc-template-mgmt-error",
        text: tr(this, "settings.templates.listFailed", "无法读取模板列表：{msg}", {
          msg: e instanceof Error ? e.message : String(e),
        }),
      });
      return;
    }

    if (!items || items.length === 0) {
      host.createDiv({
        cls: "oc-template-mgmt-empty",
        text: tr(this, "settings.templates.empty", "未找到模板。请确认插件包是否完整。"),
      });
      return;
    }

    const list = host.createDiv({ cls: "oc-template-mgmt-list" });
    for (const item of items) {
      const row = list.createDiv({ cls: "oc-template-mgmt-row" });
      const main = row.createDiv({ cls: "oc-template-mgmt-row-main" });

      const name = main.createDiv({ cls: "oc-template-mgmt-name" });
      name.setText(templateDisplayName(this, item.id, item.metaSource));

      const path = main.createDiv({ cls: "oc-template-mgmt-path" });
      path.setText(item.userPath);

      const status = main.createDiv({ cls: "oc-template-mgmt-status" });
      if (!item.hasUserCopy) {
        status.setText(tr(this, "settings.templates.statusDefault", "默认（未自定义）"));
        status.addClass("is-default");
      } else if (item.isCustomized) {
        status.setText(tr(this, "settings.templates.statusCustom", "已自定义"));
        status.addClass("is-custom");
      } else {
        status.setText(tr(this, "settings.templates.statusSynced", "已同步默认"));
      }

      const actions = row.createDiv({ cls: "oc-template-mgmt-actions" });
      const editBtn = actions.createEl("button", {
        text: tr(this, "settings.templates.edit", "编辑"),
      });
      const resetBtn = actions.createEl("button", {
        cls: "mod-warning",
        text: tr(this, "settings.templates.reset", "重置为默认"),
      });
      if (!item.hasUserCopy) resetBtn.disabled = true;

      editBtn.addEventListener("click", async () => {
        let current;
        try {
          current = await readTemplate(plugin, item.id);
        } catch (e) {
          new Notice(tr(this, "settings.templates.readFailed", "读取失败：{msg}", {
            msg: e instanceof Error ? e.message : String(e),
          }));
          return;
        }
        if (!current) {
          new Notice(tr(this, "settings.templates.readNone", "找不到模板内容"));
          return;
        }
        const draft = await openTemplateEditor(this, {
          id: item.id,
          name: templateDisplayName(this, item.id, item.metaSource),
          userPath: item.userPath,
          content: current.content,
          source: current.source,
        });
        if (draft == null) return;
        try {
          await saveTemplate(plugin, item.id, draft);
          new Notice(tr(this, "settings.templates.saved", "已保存模板"));
          await renderListLocal();
        } catch (e) {
          new Notice(tr(this, "settings.templates.saveFailed", "保存失败：{msg}", {
            msg: e instanceof Error ? e.message : String(e),
          }));
        }
      });

      resetBtn.addEventListener("click", async () => {
        const ok = window.confirm(tr(this,
          "settings.templates.resetConfirm",
          "确认把 \"{name}\" 重置为插件默认吗？你之前的修改会被覆盖。",
          { name: templateDisplayName(this, item.id, item.metaSource) },
        ));
        if (!ok) return;
        try {
          const r = await resetTemplate(plugin, item.id);
          if (!r.restored) {
            new Notice(tr(this, "settings.templates.resetNoDefault", "未找到默认内容，无法重置"));
            return;
          }
          new Notice(tr(this, "settings.templates.resetDone", "已重置为默认"));
          await renderListLocal();
        } catch (e) {
          new Notice(tr(this, "settings.templates.resetFailed", "重置失败：{msg}", {
            msg: e instanceof Error ? e.message : String(e),
          }));
        }
      });
    }
  };

  await renderListLocal();
}

function openTemplateEditor(ctx, payload) {
  return new Promise((resolve) => {
    const t = typeof ctx.plugin.t === "function" ? ctx.plugin.t.bind(ctx.plugin) : null;
    const modal = new TemplateEditorModal(
      ctx.plugin.app,
      payload,
      (result) => resolve(result == null ? null : result),
      t,
    );
    modal.open();
  });
}

const templateManagementSectionMethods = {
  renderTemplateManagementSection,
};

module.exports = {
  renderTemplateManagementSection,
  templateManagementSectionMethods,
};
