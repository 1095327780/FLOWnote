const test = require("node:test");
const assert = require("node:assert/strict");

const {
  migrateLegacyTemplaterConfig,
} = require("../../runtime/templater-config-migration");

const TEMPLATER_DATA_PATH = ".obsidian/plugins/templater-obsidian/data.json";

function makeAdapter(initial = {}) {
  const files = new Map(Object.entries(initial));
  const folders = new Set();
  const writes = [];

  for (const path of files.keys()) {
    const parts = path.split("/");
    parts.pop();
    while (parts.length > 0) {
      folders.add(parts.join("/"));
      parts.pop();
    }
  }

  return {
    _files: files,
    _writes: writes,
    async exists(path) {
      return files.has(path) || folders.has(path);
    },
    async list(path) {
      const prefix = `${String(path).replace(/\/+$/, "")}/`;
      const directFiles = [];
      const directFolders = new Set();
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        if (!rest.includes("/")) {
          directFiles.push(file);
        } else {
          directFolders.add(`${prefix}${rest.split("/")[0]}`);
        }
      }
      for (const folder of folders) {
        if (!folder.startsWith(prefix)) continue;
        const rest = folder.slice(prefix.length);
        if (rest && !rest.includes("/")) directFolders.add(folder);
      }
      return {
        files: directFiles.sort(),
        folders: Array.from(directFolders).sort(),
      };
    },
    async read(path) {
      if (!files.has(path)) throw new Error(`no such file: ${path}`);
      return files.get(path);
    },
    async write(path, data) {
      files.set(path, data);
      writes.push({ path, data });
    },
  };
}

function makePlugin(adapter) {
  return {
    app: {
      vault: {
        adapter,
        configDir: ".obsidian",
      },
      plugins: {},
    },
  };
}

function attachLoadedTemplater(plugin, userScriptsFolder) {
  let saves = 0;
  const templater = {
    settings: {
      user_scripts_folder: userScriptsFolder,
    },
    async save_settings() {
      saves += 1;
    },
  };
  plugin.app.plugins.getPlugin = (id) => (
    id === "templater-obsidian" ? templater : null
  );
  return {
    templater,
    get saves() {
      return saves;
    },
  };
}

test("clears the obsolete Meta/Scripts setting when the folder is missing", async () => {
  const adapter = makeAdapter({
    [TEMPLATER_DATA_PATH]: JSON.stringify({
      user_scripts_folder: "Meta/Scripts",
      trigger_on_file_creation: true,
    }),
  });

  const result = await migrateLegacyTemplaterConfig(makePlugin(adapter));

  assert.deepEqual(result, {
    migrated: true,
    source: "data-file",
  });
  const saved = JSON.parse(adapter._files.get(TEMPLATER_DATA_PATH));
  assert.equal(saved.user_scripts_folder, "");
  assert.equal(saved.trigger_on_file_creation, true);
  assert.equal(adapter._writes.length, 1);
});

test("clears the obsolete setting when Meta/Scripts contains only placeholder files", async () => {
  const adapter = makeAdapter({
    [TEMPLATER_DATA_PATH]: JSON.stringify({
      user_scripts_folder: "Meta/Scripts/",
    }),
    "Meta/Scripts/.gitkeep": "",
    "Meta/Scripts/nested/.DS_Store": "",
  });

  const result = await migrateLegacyTemplaterConfig(makePlugin(adapter));

  assert.equal(result.migrated, true);
  const saved = JSON.parse(adapter._files.get(TEMPLATER_DATA_PATH));
  assert.equal(saved.user_scripts_folder, "");
});

test("preserves Meta/Scripts when it contains a real user script", async () => {
  const original = JSON.stringify({
    user_scripts_folder: "Meta/Scripts",
  });
  const adapter = makeAdapter({
    [TEMPLATER_DATA_PATH]: original,
    "Meta/Scripts/helpers/format-title.js": "module.exports = () => 'title';",
  });

  const result = await migrateLegacyTemplaterConfig(makePlugin(adapter));

  assert.deepEqual(result, {
    migrated: false,
    reason: "user files present",
  });
  assert.equal(adapter._files.get(TEMPLATER_DATA_PATH), original);
  assert.equal(adapter._writes.length, 0);
});

test("repairs the loaded Templater instance so it stops using the stale setting immediately", async () => {
  const adapter = makeAdapter({
    [TEMPLATER_DATA_PATH]: JSON.stringify({
      user_scripts_folder: "Meta/Scripts",
    }),
  });
  const plugin = makePlugin(adapter);
  const loaded = attachLoadedTemplater(plugin, "Meta/Scripts");

  const result = await migrateLegacyTemplaterConfig(plugin);

  assert.deepEqual(result, {
    migrated: true,
    source: "loaded-plugin",
  });
  assert.equal(loaded.templater.settings.user_scripts_folder, "");
  assert.equal(loaded.saves, 1);
  assert.equal(adapter._writes.length, 0);
});

test("falls back to the data file when a loaded Templater cannot save its settings", async () => {
  const adapter = makeAdapter({
    [TEMPLATER_DATA_PATH]: JSON.stringify({
      user_scripts_folder: "Meta/Scripts",
    }),
  });
  const plugin = makePlugin(adapter);
  const loaded = attachLoadedTemplater(plugin, "Meta/Scripts");
  loaded.templater.save_settings = async () => {
    throw new Error("save failed");
  };

  const result = await migrateLegacyTemplaterConfig(plugin);

  assert.deepEqual(result, {
    migrated: true,
    source: "data-file",
  });
  assert.equal(loaded.templater.settings.user_scripts_folder, "");
  const saved = JSON.parse(adapter._files.get(TEMPLATER_DATA_PATH));
  assert.equal(saved.user_scripts_folder, "");
  assert.equal(adapter._writes.length, 1);
});

test("repairs stale disk data when the loaded Templater setting is already blank", async () => {
  const adapter = makeAdapter({
    [TEMPLATER_DATA_PATH]: JSON.stringify({
      user_scripts_folder: "Meta/Scripts",
    }),
  });
  const plugin = makePlugin(adapter);
  const loaded = attachLoadedTemplater(plugin, "");

  const result = await migrateLegacyTemplaterConfig(plugin);

  assert.deepEqual(result, {
    migrated: true,
    source: "data-file",
  });
  assert.equal(loaded.templater.settings.user_scripts_folder, "");
  assert.equal(loaded.saves, 0);
  const saved = JSON.parse(adapter._files.get(TEMPLATER_DATA_PATH));
  assert.equal(saved.user_scripts_folder, "");
});

test("persists a loaded custom scripts folder instead of clearing it", async () => {
  const adapter = makeAdapter({
    [TEMPLATER_DATA_PATH]: JSON.stringify({
      user_scripts_folder: "Meta/Scripts",
    }),
  });
  const plugin = makePlugin(adapter);
  attachLoadedTemplater(plugin, "Automation/Templater");

  const result = await migrateLegacyTemplaterConfig(plugin);

  assert.equal(result.migrated, true);
  const saved = JSON.parse(adapter._files.get(TEMPLATER_DATA_PATH));
  assert.equal(saved.user_scripts_folder, "Automation/Templater");
});

test("leaves an independently configured Templater scripts folder untouched", async () => {
  const original = JSON.stringify({
    user_scripts_folder: "Automation/Templater",
  });
  const adapter = makeAdapter({
    [TEMPLATER_DATA_PATH]: original,
  });

  const result = await migrateLegacyTemplaterConfig(makePlugin(adapter));

  assert.deepEqual(result, {
    migrated: false,
    reason: "setting not legacy",
  });
  assert.equal(adapter._files.get(TEMPLATER_DATA_PATH), original);
  assert.equal(adapter._writes.length, 0);
});

test("does not overwrite malformed Templater configuration", async () => {
  const adapter = makeAdapter({
    [TEMPLATER_DATA_PATH]: "{not json",
  });

  const result = await migrateLegacyTemplaterConfig(makePlugin(adapter));

  assert.deepEqual(result, {
    migrated: false,
    reason: "invalid config",
  });
  assert.equal(adapter._files.get(TEMPLATER_DATA_PATH), "{not json");
  assert.equal(adapter._writes.length, 0);
});

test("uses the vault's custom config directory", async () => {
  const customDataPath = "Config/plugins/templater-obsidian/data.json";
  const adapter = makeAdapter({
    [customDataPath]: JSON.stringify({
      user_scripts_folder: "Meta\\Scripts\\",
    }),
  });
  const plugin = makePlugin(adapter);
  plugin.app.vault.configDir = "Config";

  const result = await migrateLegacyTemplaterConfig(plugin);

  assert.equal(result.migrated, true);
  const saved = JSON.parse(adapter._files.get(customDataPath));
  assert.equal(saved.user_scripts_folder, "");
});

test("is idempotent after the legacy setting has been cleared", async () => {
  const adapter = makeAdapter({
    [TEMPLATER_DATA_PATH]: JSON.stringify({
      user_scripts_folder: "Meta/Scripts",
    }),
  });
  const plugin = makePlugin(adapter);

  const first = await migrateLegacyTemplaterConfig(plugin);
  const second = await migrateLegacyTemplaterConfig(plugin);

  assert.equal(first.migrated, true);
  assert.deepEqual(second, {
    migrated: false,
    reason: "setting not legacy",
  });
  assert.equal(adapter._writes.length, 1);
});

test("adapter failures never block plugin startup", async () => {
  const adapter = {
    async exists() {
      throw new Error("vault unavailable");
    },
    async read() {
      throw new Error("vault unavailable");
    },
    async write() {
      throw new Error("vault unavailable");
    },
  };

  const result = await migrateLegacyTemplaterConfig(makePlugin(adapter));

  assert.deepEqual(result, {
    migrated: false,
    reason: "migration failed",
  });
});
