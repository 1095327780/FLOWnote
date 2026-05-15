// Settings tab section: skill management. Lists every skill folder in
// `settings.skillsDir`, with edit/delete/new-skill controls. Bridges to
// runtime/settings/skill-management.js (which does the I/O) and to
// modals.SkillEditorModal (which shows the form).

const { Setting, Notice } = require("obsidian");
const { tFromContext } = require("../i18n-runtime");
const {
  listSkills,
  saveSkill,
  deleteSkill,
} = require("./skill-management");
const { SkillEditorModal } = require("../modals");

function tr(ctx, key, fallback, params = {}) {
  return tFromContext(ctx, key, fallback, params);
}

const PREVIEW_DESC_LEN = 80;

function truncate(s, n) {
  const str = String(s || "");
  if (str.length <= n) return str;
  return `${str.slice(0, n - 1)}…`;
}

async function renderSkillManagementSection(containerEl) {
  const plugin = this.plugin;
  if (!plugin) return;

  // Section heading + intro.
  new Setting(containerEl)
    .setName(tr(this, "settings.skills.heading", "技能管理"))
    .setHeading();

  containerEl.createDiv({
    cls: "oc-skill-mgmt-intro",
    text: tr(
      this,
      "settings.skills.intro",
      "管理 .flownote/skills 下的技能文件。编辑会直接写入对应 SKILL.md。改动会即时反映到 AI 的可调用技能列表。",
    ),
  });

  // "新建技能" button + skill list, both inside a host div so we can
  // re-render after CRUD without rebuilding the rest of the settings tab.
  const host = containerEl.createDiv({ cls: "oc-skill-mgmt-host" });
  const renderListLocal = async () => {
    host.empty();
    const headerRow = host.createDiv({ cls: "oc-skill-mgmt-header" });
    const addBtn = headerRow.createEl("button", {
      cls: "mod-cta",
      text: tr(this, "settings.skills.add", "+ 新建技能"),
    });
    addBtn.addEventListener("click", async () => {
      const draft = await openSkillEditor(this, null);
      if (!draft) return;
      try {
        await saveSkill(plugin, draft);
        new Notice(tr(this, "settings.skills.created", "已创建技能 \"{name}\"", { name: draft.name }));
        await renderListLocal();
      } catch (e) {
        new Notice(tr(this, "settings.skills.saveFailed", "保存失败：{msg}", {
          msg: e instanceof Error ? e.message : String(e),
        }));
      }
    });

    let skills;
    try {
      skills = await listSkills(plugin);
    } catch (e) {
      host.createDiv({
        cls: "oc-skill-mgmt-error",
        text: tr(this, "settings.skills.listFailed", "无法读取技能列表：{msg}", {
          msg: e instanceof Error ? e.message : String(e),
        }),
      });
      return;
    }

    if (!skills || skills.length === 0) {
      host.createDiv({
        cls: "oc-skill-mgmt-empty",
        text: tr(this, "settings.skills.empty", "还没有技能。点上面的「新建技能」开始。"),
      });
      return;
    }

    const list = host.createDiv({ cls: "oc-skill-mgmt-list" });
    for (const skill of skills) {
      const row = list.createDiv({ cls: "oc-skill-mgmt-row" });
      const main = row.createDiv({ cls: "oc-skill-mgmt-row-main" });
      const name = main.createDiv({ cls: "oc-skill-mgmt-name" });
      name.setText(skill.name);
      const slug = main.createDiv({ cls: "oc-skill-mgmt-slug" });
      slug.setText(`/${skill.slug}`);
      const desc = main.createDiv({ cls: "oc-skill-mgmt-desc" });
      desc.setText(truncate(skill.description, PREVIEW_DESC_LEN));

      const actions = row.createDiv({ cls: "oc-skill-mgmt-actions" });
      const editBtn = actions.createEl("button", { text: tr(this, "settings.skills.edit", "编辑") });
      const delBtn = actions.createEl("button", {
        cls: "mod-warning",
        text: tr(this, "settings.skills.delete", "删除"),
      });

      editBtn.addEventListener("click", async () => {
        const draft = await openSkillEditor(this, skill);
        if (!draft) return;
        try {
          await saveSkill(plugin, draft, skill.slug);
          new Notice(tr(this, "settings.skills.saved", "已保存技能 \"{name}\"", { name: draft.name }));
          await renderListLocal();
        } catch (e) {
          new Notice(tr(this, "settings.skills.saveFailed", "保存失败：{msg}", {
            msg: e instanceof Error ? e.message : String(e),
          }));
        }
      });

      delBtn.addEventListener("click", async () => {
        const ok = window.confirm(tr(this,
          "settings.skills.deleteConfirm",
          "确认删除技能 \"{name}\" 吗？这会删除整个 {dir} 文件夹（包含技能正文、references 等），无法撤销。",
          { name: skill.name, dir: skill.dirPath },
        ));
        if (!ok) return;
        try {
          await deleteSkill(plugin, skill.slug);
          new Notice(tr(this, "settings.skills.deleted", "已删除技能 \"{name}\"", { name: skill.name }));
          await renderListLocal();
        } catch (e) {
          new Notice(tr(this, "settings.skills.deleteFailed", "删除失败：{msg}", {
            msg: e instanceof Error ? e.message : String(e),
          }));
        }
      });
    }
  };

  await renderListLocal();
}

function openSkillEditor(ctx, skill) {
  return new Promise((resolve) => {
    const t = typeof ctx.plugin.t === "function" ? ctx.plugin.t.bind(ctx.plugin) : null;
    const modal = new SkillEditorModal(
      ctx.plugin.app,
      { skill },
      (result) => resolve(result || null),
      t,
    );
    modal.open();
  });
}

const skillManagementSectionMethods = {
  renderSkillManagementSection,
};

module.exports = {
  renderSkillManagementSection,
  skillManagementSectionMethods,
};
