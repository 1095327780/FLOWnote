# Contributing to FLOWnote

Thanks for your interest in improving FLOWnote.

## Reporting issues

- Check [existing issues](https://github.com/1095327780/FLOWnote/issues) before opening a new one.
- For bugs, include: OS, Obsidian version, FLOWnote version, OpenCode version, reproduction steps, and any relevant log output (Settings → FLOWnote → enable Debug logs).
- For feature requests, describe the workflow you want to support and why current capabilities are not enough.

## Development

1. Fork and clone the repo.
2. Use the Node version pinned in `.nvmrc` (Node 20). `nvm use` will pick it up.
3. Install dependencies with `npm ci`.
4. Useful scripts:
   - `npm run ci` — guard checks, syntax checks, tests.
   - `npm run build:release` — produce `release/main.js`, `release/manifest.json`, `release/styles.css`.
   - `npm run release:check` — full CI + build + submission readiness audit.
5. For UI changes, test in a real Obsidian vault: drop the built `release/` output into `<Vault>/.obsidian/plugins/flownote/`, reload plugins, and verify the affected views.

## Pull requests

- Keep PRs focused. Mention the user-facing impact in the description.
- Update `manifest.json`, `versions.json`, and `package.json` versions together when bumping; `npm run verify:version-sync` will catch drift.
- Do not edit `release/main.js` by hand — CI rebuilds from source.
- Add or update tests under `tests/runtime/` when changing runtime behavior.

## License

By contributing, you agree your contributions are licensed under the MIT License (see `LICENSE`).
