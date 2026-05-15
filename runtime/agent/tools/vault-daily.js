// vault_daily tool — read / append / create today's (or any date's) daily note.
//
// Mirrors what `obsidian daily:read` and `obsidian daily:append` do in the
// official CLI: respect the daily-notes plugin's folder + filename format
// + template, so the agent doesn't have to guess where today's note lives.
//
// Resolution order for daily-notes config:
//   1. app.internalPlugins.plugins['daily-notes'].instance.options
//   2. Defaults: folder="" (vault root), format="YYYY-MM-DD", template=""

const { buildTool } = require("../tool-registry");

const DESCRIPTION =
  "Work with the user's Obsidian daily note. Modes: " +
  "`read` (returns today's note contents — or the date you specify), " +
  "`append` (adds text to the end, creating the note if missing), " +
  "`create` (creates the note from the configured template; fails if it already exists). " +
  "Pass `date` (YYYY-MM-DD) to target a different day; defaults to today. " +
  "Uses the daily-notes plugin's folder + filename format if it's enabled, " +
  "otherwise falls back to YYYY-MM-DD.md at the vault root. " +
  "Prefer this over vault_read/vault_write when the user means \"today's note\".";

const VALID_MODES = ["read", "append", "create"];

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      enum: VALID_MODES,
      description: "`read` (default), `append`, or `create`.",
    },
    date: {
      type: "string",
      description: "Target date in YYYY-MM-DD. Omit for today.",
    },
    content: {
      type: "string",
      description: "Text to append (mode=append) or initial body (mode=create, overrides template).",
    },
  },
  required: [],
};

const ZH_WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

// Minimal moment-style date formatter. Handles `YYYY`, `YY`, `MM`, `M`,
// `DD`, `D`, `HH`, `mm`, `ss`, `ddd`, `dddd`, and `[literal]` escape.
// Sufficient for ~all real-world daily-note format strings in CN/EN.
function formatDate(d, fmt) {
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const tokens = {
    YYYY: () => String(d.getFullYear()),
    YY: () => pad(d.getFullYear() % 100),
    MM: () => pad(d.getMonth() + 1),
    M: () => String(d.getMonth() + 1),
    DD: () => pad(d.getDate()),
    D: () => String(d.getDate()),
    HH: () => pad(d.getHours()),
    mm: () => pad(d.getMinutes()),
    ss: () => pad(d.getSeconds()),
    dddd: () => `星期${ZH_WEEKDAY[d.getDay()]}`,
    ddd: () => ZH_WEEKDAY[d.getDay()],
  };
  let out = "";
  let i = 0;
  while (i < fmt.length) {
    if (fmt[i] === "[") {
      const end = fmt.indexOf("]", i + 1);
      if (end >= 0) {
        out += fmt.slice(i + 1, end);
        i = end + 1;
        continue;
      }
    }
    let matched = false;
    for (const tok of ["YYYY", "YY", "MM", "DD", "HH", "mm", "ss", "dddd", "ddd", "M", "D"]) {
      if (fmt.startsWith(tok, i)) {
        out += tokens[tok]();
        i += tok.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += fmt[i];
      i += 1;
    }
  }
  return out;
}

function parseISODate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return new Date(y, m - 1, d, 12, 0, 0); // noon to dodge DST edges
}

function readDailyNotesConfig(app) {
  const out = { folder: "", format: "YYYY-MM-DD", template: "", enabled: false };
  try {
    const dn =
      app &&
      app.internalPlugins &&
      app.internalPlugins.plugins &&
      app.internalPlugins.plugins["daily-notes"];
    if (!dn) return out;
    out.enabled = !!(dn.enabled || dn._loaded);
    const opts = (dn.instance && dn.instance.options) || {};
    if (typeof opts.folder === "string") out.folder = opts.folder.trim().replace(/\/+$/, "");
    if (typeof opts.format === "string" && opts.format.trim()) out.format = opts.format.trim();
    if (typeof opts.template === "string") out.template = opts.template.trim();
  } catch {
    // ignore — fall back to defaults
  }
  return out;
}

function buildDailyPath(folder, format, date) {
  const stem = formatDate(date, format);
  // The format may itself contain slashes (e.g. "YYYY/MM/DD"). Join folder
  // only if both are non-empty, and don't double up separators.
  let path;
  if (folder) {
    path = `${folder}/${stem}`;
  } else {
    path = stem;
  }
  if (!/\.md$/i.test(path)) path += ".md";
  return path.replace(/\/{2,}/g, "/");
}

function defaultNormalizePath(p) {
  return String(p || "")
    .replace(/\\+/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/**
 * @param {Object} deps
 * @param {Object} deps.app                 Obsidian App (vault + internalPlugins)
 * @param {Function} [deps.normalizePath]
 * @param {() => Date} [deps.now]           injected clock for tests
 * @returns {import('../tool-registry').ToolDef}
 */
function createVaultDailyTool({ app, normalizePath, now } = {}) {
  if (!app || !app.vault) throw new Error("createVaultDailyTool: app.vault required");
  const vault = app.vault;
  if (typeof vault.getFileByPath !== "function") {
    throw new Error("createVaultDailyTool: vault.getFileByPath required");
  }
  if (typeof vault.cachedRead !== "function" || typeof vault.create !== "function" || typeof vault.modify !== "function") {
    throw new Error("createVaultDailyTool: vault must expose cachedRead + create + modify");
  }
  const normalize = typeof normalizePath === "function" ? normalizePath : defaultNormalizePath;
  const nowFn = typeof now === "function" ? now : () => new Date();

  return buildTool({
    name: "vault_daily",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    isReadOnly: (input) => !input || input.mode === undefined || input.mode === "read",
    isDestructive: () => false,
    isConcurrencySafe: (input) => !input || input.mode === undefined || input.mode === "read",

    async validate(input) {
      if (input && input.mode !== undefined && !VALID_MODES.includes(input.mode)) {
        return { ok: false, error: `mode must be one of ${VALID_MODES.join(", ")}` };
      }
      if (input && input.date !== undefined) {
        if (parseISODate(input.date) === null) {
          return { ok: false, error: "date must be YYYY-MM-DD." };
        }
      }
      if (input && input.content !== undefined && typeof input.content !== "string") {
        return { ok: false, error: "content must be a string." };
      }
      return { ok: true };
    },

    async checkPermissions(input, ctx) {
      const mode = (input && input.mode) || "read";
      if (mode === "read") return { behavior: "allow" };
      const grants = ctx && ctx.grants ? ctx.grants : null;
      if (grants && grants["vault_daily:*"]) return { behavior: "allow" };
      const cfg = readDailyNotesConfig(app);
      const d = input && input.date ? parseISODate(input.date) : nowFn();
      const path = normalize(buildDailyPath(cfg.folder, cfg.format, d));
      return {
        behavior: "ask",
        summary: `${mode} → ${path}`,
        choices: ["allow once", "allow for this conversation", "deny"],
      };
    },

    userFacingName(input) {
      const mode = (input && input.mode) || "read";
      const date = (input && input.date) || "today";
      return `${mode} ${date}`;
    },

    async *execute(input, _ctx) {
      const mode = (input && input.mode) || "read";
      const d = input && input.date ? parseISODate(input.date) : nowFn();
      const cfg = readDailyNotesConfig(app);
      const path = normalize(buildDailyPath(cfg.folder, cfg.format, d));
      const existing = vault.getFileByPath(path);

      if (mode === "read") {
        if (!existing) {
          yield {
            type: "result",
            content: `vault_daily: daily note for ${formatDate(d, "YYYY-MM-DD")} does not exist yet at "${path}". Use mode=create to make it.`,
            isError: true,
          };
          return;
        }
        const raw = await vault.cachedRead(existing);
        yield { type: "result", content: typeof raw === "string" ? raw : String(raw || "") };
        return;
      }

      if (mode === "append") {
        const content = typeof input.content === "string" ? input.content : "";
        if (!content) {
          yield {
            type: "result",
            content: "vault_daily: append requires non-empty `content`.",
            isError: true,
          };
          return;
        }
        yield { type: "progress", message: `append → ${path}` };
        if (existing) {
          const current = await vault.cachedRead(existing);
          const joined = `${current || ""}${current && !String(current).endsWith("\n") ? "\n" : ""}${content}`;
          await vault.modify(existing, joined);
          yield {
            type: "result",
            content: `Appended ${Buffer.byteLength(content, "utf8")} bytes to "${path}".`,
          };
          return;
        }
        // Auto-create with append semantics — same behavior as the CLI.
        const tplBody = cfg.template ? await readTemplate(vault, cfg.template) : "";
        const seed = tplBody ? `${tplBody}${tplBody.endsWith("\n") ? "" : "\n"}${content}` : content;
        await vault.create(path, seed);
        yield {
          type: "result",
          content: `Created "${path}" via append (${Buffer.byteLength(seed, "utf8")} bytes).`,
        };
        return;
      }

      // mode === "create"
      if (existing) {
        yield {
          type: "result",
          content: `vault_daily: "${path}" already exists. Use mode=append to add to it, or vault_write with mode=overwrite to replace.`,
          isError: true,
        };
        return;
      }
      yield { type: "progress", message: `create → ${path}` };
      const userBody = typeof input.content === "string" ? input.content : "";
      const tplBody = cfg.template && !userBody ? await readTemplate(vault, cfg.template) : "";
      const seed = userBody || tplBody;
      await vault.create(path, seed);
      yield {
        type: "result",
        content:
          `Created "${path}" (${Buffer.byteLength(seed, "utf8")} bytes` +
          `${tplBody && !userBody ? `; seeded from template "${cfg.template}"` : ""}).`,
      };
    },
  });
}

async function readTemplate(vault, templatePath) {
  if (!templatePath) return "";
  const path = /\.md$/i.test(templatePath) ? templatePath : `${templatePath}.md`;
  const file = vault.getFileByPath(path);
  if (!file) return "";
  try {
    const raw = await vault.cachedRead(file);
    return typeof raw === "string" ? raw : String(raw || "");
  } catch {
    return "";
  }
}

module.exports = {
  createVaultDailyTool,
  formatDate,
  parseISODate,
  buildDailyPath,
  readDailyNotesConfig,
  VALID_MODES,
};
