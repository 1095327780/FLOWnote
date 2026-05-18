// Settings tab section: skill management. Lists every skill folder in
// `settings.skillsDir`, with edit/delete/new-skill controls. Bridges to
// runtime/settings/skill-management.js (which does the I/O) and to
// modals.SkillEditorModal (which shows the form).

const { Setting, Notice } = require("obsidian");
const { tFromContext } = require("../i18n-runtime");
const {
  listSkillManagementEntries,
  saveSkill,
  deleteSkill,
  importSkillsFromFileList,
  listSkillSecretRefs,
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

  // "新建技能" button + skill list, both inside a host div so we can
  // re-render after CRUD without rebuilding the rest of the settings tab.
  const host = containerEl.createDiv({ cls: "oc-skill-mgmt-host" });
  const renderListLocal = async () => {
    host.empty();
    host.createDiv({
      cls: "oc-skill-mgmt-intro",
      text: tr(
        this,
        "settings.skills.intro",
        "编辑器只修改技能根目录里的 SKILL.md；如果技能带 references、assets、scripts 等资源，请用「导入文件夹」保留完整目录。",
      ),
    });
    const headerRow = host.createDiv({ cls: "oc-skill-mgmt-header" });
    const importInput = headerRow.createEl("input", {
      cls: "oc-skill-mgmt-import-input",
      attr: { type: "file" },
    });
    importInput.multiple = true;
    importInput.setAttribute("webkitdirectory", "");
    importInput.setAttribute("directory", "");
    const importBtn = headerRow.createEl("button", {
      text: tr(this, "settings.skills.importFolder", "导入文件夹"),
    });
    const addBtn = headerRow.createEl("button", {
      cls: "mod-cta",
      text: tr(this, "settings.skills.add", "+ 新建技能"),
    });

    importBtn.addEventListener("click", () => {
      if (!("webkitdirectory" in importInput) && !("directory" in importInput)) {
        new Notice(tr(
          this,
          "settings.skills.importUnsupported",
          "当前平台不支持直接选择文件夹。请在桌面端 Obsidian 使用「导入文件夹」，或手动复制到 Skills 安装目录。",
        ));
        return;
      }
      importInput.value = "";
      importInput.click();
    });

    importInput.addEventListener("change", async () => {
      const files = Array.from(importInput.files || []);
      importInput.value = "";
      if (files.length === 0) return;
      importBtn.disabled = true;
      importBtn.setText(tr(this, "settings.skills.importing", "导入中..."));
      try {
        const result = await importSkillsFromFileList(plugin, files);
        const firstError = result.errors && result.errors.length > 0 ? result.errors[0] : "";
        if (result.imported === 0 && result.skipped === 0 && firstError) {
          new Notice(tr(this, "settings.skills.importFailed", "导入失败：{msg}", { msg: firstError }));
        } else {
          new Notice(tr(
            this,
            "settings.skills.importDone",
            "已导入 {imported} 个技能（{files} 个文件），跳过 {skipped} 个。{errors}",
            {
              imported: result.imported,
              files: result.files,
              skipped: result.skipped,
              errors: firstError ? `提示：${firstError}` : "",
            },
          ));
        }
        await renderListLocal();
      } catch (e) {
        new Notice(tr(this, "settings.skills.importFailed", "导入失败：{msg}", {
          msg: e instanceof Error ? e.message : String(e),
        }));
      } finally {
        importBtn.disabled = false;
        importBtn.setText(tr(this, "settings.skills.importFolder", "导入文件夹"));
      }
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

    let secretRefs = [];
    try {
      secretRefs = await listSkillSecretRefs(plugin);
    } catch (_e) {
      secretRefs = [];
    }
    if (secretRefs.length > 0) {
      renderSkillSecretSettings(this, host, secretRefs);
    }

    let skills;
    try {
      skills = await listSkillManagementEntries(plugin);
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
      const source = main.createDiv({ cls: "oc-skill-mgmt-source" });
      if (skill.embedded) {
        source.setText(tr(this, "settings.skills.sourceEmbedded", "来源：内置回退（只读）"));
      } else if (skill.readOnly) {
        source.setText(tr(this, "settings.skills.sourceReadonly", "来源：{dir}（只读）", { dir: skill.dirPath }));
      } else {
        source.setText(tr(this, "settings.skills.sourceInstalled", "来源：{dir}", { dir: skill.dirPath }));
      }
      const desc = main.createDiv({ cls: "oc-skill-mgmt-desc" });
      desc.setText(truncate(skill.description, PREVIEW_DESC_LEN));

      const actions = row.createDiv({ cls: "oc-skill-mgmt-actions" });
      const editBtn = actions.createEl("button", { text: tr(this, "settings.skills.edit", "编辑 SKILL.md") });
      const delBtn = actions.createEl("button", {
        cls: "mod-warning",
        text: tr(this, "settings.skills.delete", "删除"),
      });
      if (skill.readOnly) {
        editBtn.disabled = true;
        delBtn.disabled = true;
        editBtn.setText(tr(this, "settings.skills.readonly", "只读"));
      }

      editBtn.addEventListener("click", async () => {
        if (skill.readOnly) return;
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
        if (skill.readOnly) return;
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

function renderSkillSecretSettings(ctx, host, secretRefs) {
  const plugin = ctx.plugin;
  const box = host.createDiv({ cls: "oc-skill-secret-host" });
  box.createDiv({
    cls: "oc-skill-secret-intro",
    text: tr(
      ctx,
      "settings.skills.secretsIntro",
      "已安装的技能需要以下密钥。模型只会使用 $KEY 占位符，真实密钥会在工具执行时由插件替换。",
    ),
  });
  for (const name of secretRefs) {
    const desc = name === "WEREAD_API_KEY"
      ? tr(ctx, "settings.skills.secretWereadDesc", "微信读书官方 Skill 调用 API 时使用；建议填入 wrk- 开头的官方密钥。")
      : tr(ctx, "settings.skills.secretGenericDesc", "第三方 Skill 调用 API 时使用。");
    new Setting(box)
      .setName(name)
      .setDesc(desc)
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder(name === "WEREAD_API_KEY" ? "wrk-..." : "");
        text.setValue((plugin.settings.skillSecrets && plugin.settings.skillSecrets[name]) || "");
        text.onChange(async (value) => {
          if (!plugin.settings.skillSecrets || typeof plugin.settings.skillSecrets !== "object") {
            plugin.settings.skillSecrets = {};
          }
          const next = String(value || "").trim();
          if (next) plugin.settings.skillSecrets[name] = next;
          else delete plugin.settings.skillSecrets[name];
          await plugin.saveSettings();
        });
      });
  }
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
