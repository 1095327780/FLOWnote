const TEMPLATER_PLUGIN_ID = "templater-obsidian";
const LEGACY_USER_SCRIPTS_FOLDER = "Meta/Scripts";
const PLACEHOLDER_FILE_NAMES = new Set([".gitkeep", ".keep", ".DS_Store"]);

function normalizeVaultPath(path) {
  return String(path || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
}

function baseName(path) {
  const normalized = normalizeVaultPath(path);
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? normalized : normalized.slice(separator + 1);
}

async function containsRealUserFiles(adapter, folder) {
  if (!await adapter.exists(folder)) return false;
  if (typeof adapter.list !== "function") return true;

  const pending = [folder];
  while (pending.length > 0) {
    const current = pending.pop();
    let listing;
    try {
      listing = await adapter.list(current);
    } catch {
      return true;
    }
    const files = listing && Array.isArray(listing.files) ? listing.files : [];
    if (files.some((path) => !PLACEHOLDER_FILE_NAMES.has(baseName(path)))) {
      return true;
    }
    const folders = listing && Array.isArray(listing.folders) ? listing.folders : [];
    pending.push(...folders);
  }
  return false;
}

function getLoadedTemplater(app) {
  const plugins = app && app.plugins;
  if (!plugins) return null;
  if (typeof plugins.getPlugin === "function") {
    const loaded = plugins.getPlugin(TEMPLATER_PLUGIN_ID);
    if (loaded) return loaded;
  }
  return plugins.plugins && plugins.plugins[TEMPLATER_PLUGIN_ID]
    ? plugins.plugins[TEMPLATER_PLUGIN_ID]
    : null;
}

async function migrateLegacyTemplaterConfig(plugin) {
  try {
    return await migrateLegacyTemplaterConfigUnsafe(plugin);
  } catch {
    return { migrated: false, reason: "migration failed" };
  }
}

async function migrateLegacyTemplaterConfigUnsafe(plugin) {
  const vault = plugin && plugin.app && plugin.app.vault;
  const adapter = vault && vault.adapter;
  if (
    !adapter
    || typeof adapter.exists !== "function"
    || typeof adapter.read !== "function"
    || typeof adapter.write !== "function"
  ) {
    return { migrated: false, reason: "no vault adapter" };
  }

  const configDir = String(vault.configDir || ".obsidian").replace(/\/+$/, "");
  const dataPath = `${configDir}/plugins/${TEMPLATER_PLUGIN_ID}/data.json`;

  const loadedTemplater = getLoadedTemplater(plugin.app);
  const loadedHasSetting = Boolean(
    loadedTemplater
    && loadedTemplater.settings
    && Object.prototype.hasOwnProperty.call(
      loadedTemplater.settings,
      "user_scripts_folder",
    ),
  );
  let loadedFolder = "";
  let loadedFolderIsLegacy = false;
  if (loadedHasSetting) {
    loadedFolder = loadedTemplater.settings.user_scripts_folder;
    loadedFolderIsLegacy = normalizeVaultPath(loadedFolder) === LEGACY_USER_SCRIPTS_FOLDER;
  }

  if (loadedFolderIsLegacy) {
    if (await containsRealUserFiles(adapter, LEGACY_USER_SCRIPTS_FOLDER)) {
      return { migrated: false, reason: "user files present" };
    }
    loadedTemplater.settings.user_scripts_folder = "";
    if (typeof loadedTemplater.save_settings === "function") {
      try {
        await loadedTemplater.save_settings();
        return { migrated: true, source: "loaded-plugin" };
      } catch {
        // The in-memory value is already safe. Fall through and persist the
        // same repair directly so the next Obsidian launch remains fixed.
      }
    }
  }

  if (!await adapter.exists(dataPath)) {
    return { migrated: false, reason: "config missing" };
  }

  let settings;
  try {
    settings = JSON.parse(await adapter.read(dataPath));
  } catch {
    return { migrated: false, reason: "invalid config" };
  }

  if (normalizeVaultPath(settings.user_scripts_folder) !== LEGACY_USER_SCRIPTS_FOLDER) {
    return { migrated: false, reason: "setting not legacy" };
  }

  if (loadedHasSetting && !loadedFolderIsLegacy) {
    settings.user_scripts_folder = loadedFolder;
    await adapter.write(dataPath, `${JSON.stringify(settings, null, 2)}\n`);
    return { migrated: true, source: "data-file" };
  }

  if (await containsRealUserFiles(adapter, LEGACY_USER_SCRIPTS_FOLDER)) {
    return { migrated: false, reason: "user files present" };
  }

  settings.user_scripts_folder = "";
  await adapter.write(dataPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { migrated: true, source: "data-file" };
}

module.exports = {
  migrateLegacyTemplaterConfig,
  TEMPLATER_PLUGIN_ID,
  LEGACY_USER_SCRIPTS_FOLDER,
};
