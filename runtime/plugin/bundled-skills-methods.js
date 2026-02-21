const fs = require("fs");
const path = require("path");

function createBundledSkillsMethods(options = {}) {
  const pluginDirname = String(options.pluginDirname || "");

  return {
    getPluginRootDir() {
      const vaultPath = this.getVaultPath();
      const configDir = this.app && this.app.vault && this.app.vault.configDir
        ? String(this.app.vault.configDir)
        : ".obsidian";
      const id = this.manifest && this.manifest.id ? String(this.manifest.id) : "opencode-assistant";

      const candidates = [
        path.join(vaultPath, configDir, "plugins", id),
        this.manifest && this.manifest.dir ? String(this.manifest.dir) : "",
        pluginDirname,
        pluginDirname ? path.resolve(pluginDirname, "..") : "",
      ].filter(Boolean);

      for (const dir of candidates) {
        if (fs.existsSync(path.join(dir, "manifest.json"))) return dir;
      }
      return candidates[0] || pluginDirname;
    },

    getBundledSkillsRoot() {
      return path.join(this.getPluginRootDir(), "bundled-skills");
    },

    getBundledSkillsStamp(skillIds = []) {
      const version = this.manifest && this.manifest.version ? String(this.manifest.version) : "0";
      const ids = [...new Set(
        (Array.isArray(skillIds) ? skillIds : [])
          .map((id) => String(id || "").trim())
          .filter(Boolean),
      )].sort((a, b) => a.localeCompare(b));
      return `${version}:${ids.join(",")}`;
    },

    hasSyncedBundledSkills(targetRoot, bundledIds) {
      if (!targetRoot || !fs.existsSync(targetRoot)) return false;
      return bundledIds.every((skillId) =>
        fs.existsSync(path.join(targetRoot, skillId, "SKILL.md")));
    },

    shouldSyncBundledSkills(targetRoot, bundledIds, stamp, force = false) {
      if (force) return true;
      const st = this.runtimeState && typeof this.runtimeState === "object" ? this.runtimeState : {};
      const previousStamp = String(st.bundledSkillsStamp || "");
      if (!previousStamp || previousStamp !== String(stamp || "")) return true;
      return !this.hasSyncedBundledSkills(targetRoot, bundledIds);
    },

    listBundledSkillIds(rootDir = this.getBundledSkillsRoot()) {
      if (!fs.existsSync(rootDir)) return [];

      return fs.readdirSync(rootDir, { withFileTypes: true })
        .filter((entry) => entry && entry.isDirectory() && !String(entry.name || "").startsWith("."))
        .map((entry) => String(entry.name || "").trim())
        .filter(Boolean)
        .filter((id) => fs.existsSync(path.join(rootDir, id, "SKILL.md")))
        .sort((a, b) => a.localeCompare(b));
    },

    syncBundledSkills(vaultPath, options = {}) {
      const runtime = this.ensureRuntimeModules();
      const force = Boolean(options && options.force);
      const bundledRoot = this.getBundledSkillsRoot();
      const bundledIds = this.listBundledSkillIds(bundledRoot);
      const stamp = this.getBundledSkillsStamp(bundledIds);

      if (this.skillService) this.skillService.setAllowedSkillIds(bundledIds);
      if (!bundledIds.length) {
        return {
          synced: 0,
          total: 0,
          targetRoot: path.join(vaultPath, this.settings.skillsDir),
          bundledRoot,
          stamp,
          skipped: false,
          stampUpdated: false,
          errors: [`未找到内置 skills 源目录或目录为空：${bundledRoot}`],
        };
      }

      const targetRoot = path.join(vaultPath, this.settings.skillsDir);
      fs.mkdirSync(targetRoot, { recursive: true });
      const shouldSync = this.shouldSyncBundledSkills(targetRoot, bundledIds, stamp, force);
      if (!shouldSync) {
        return {
          synced: 0,
          total: bundledIds.length,
          targetRoot,
          bundledRoot,
          stamp,
          skipped: true,
          stampUpdated: false,
          errors: [],
        };
      }

      const errors = [];
      for (const skillId of bundledIds) {
        const srcDir = path.join(bundledRoot, skillId);
        const destDir = path.join(targetRoot, skillId);
        try {
          fs.rmSync(destDir, { recursive: true, force: true });
          runtime.copyDirectoryRecursive(srcDir, destDir);
        } catch (e) {
          errors.push(`${skillId}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      const hasRuntimeState = this.runtimeState && typeof this.runtimeState === "object";
      let stampUpdated = false;
      if (!errors.length && hasRuntimeState) {
        this.runtimeState.bundledSkillsStamp = stamp;
        stampUpdated = true;
      }

      return {
        synced: bundledIds.length - errors.length,
        total: bundledIds.length,
        targetRoot,
        bundledRoot,
        stamp,
        skipped: false,
        stampUpdated,
        errors,
      };
    },
  };
}

module.exports = { createBundledSkillsMethods };
