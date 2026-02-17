// Runtime service contracts (documented for maintainability).

// IOpenCodeClient
// - updateSettings(settings)
// - testConnection()
// - listSessions()
// - createSession(title)
// - listModels()
// - sendMessage({ sessionId, prompt, onToken, signal })
// - stop()

// ISessionService: currently implemented via OpenCodeClient + SessionStore in plugin layer.
// IAuthService: currently implemented inside each transport's ensureAuth().
// ISkillService: implemented by SkillService.
// IDiagnosticsService: implemented by DiagnosticsService.

module.exports = {};
