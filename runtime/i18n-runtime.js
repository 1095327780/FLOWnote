function interpolateTemplate(template, params = {}) {
  return String(template || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return "";
    const value = params[name];
    return value === undefined || value === null ? "" : String(value);
  });
}

function resolvePluginFromContext(context) {
  if (!context || typeof context !== "object") return null;
  if (context.plugin && typeof context.plugin === "object") return context.plugin;
  if (typeof context.t === "function" || typeof context.getEffectiveLocale === "function") return context;
  return null;
}

function tFromContext(context, key, fallback, params = {}, options = {}) {
  const plugin = resolvePluginFromContext(context);
  if (plugin && typeof plugin.t === "function") {
    return plugin.t(key, params, { ...options, defaultValue: fallback });
  }
  return interpolateTemplate(fallback, params);
}

module.exports = {
  interpolateTemplate,
  resolvePluginFromContext,
  tFromContext,
};
