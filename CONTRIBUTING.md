# Contributing

Use Node 22.15+ and Python 3.12+ for packaging/native tooling. Start with:

```bash
npm ci --no-audit --no-fund
npm test
npm run build
npm run check:release
npm run package
```

Use `node scripts/preview.mjs` for synthetic UI work. Test first-turn chat detection, host/turn isolation, snapshot retention and toolbar remounting when changing the adapter. Do not upload real App screenshots/logs with private data; demonstrate changes with synthetic data.

Native changes must preserve all upstream connection/authentication/encoding/retry/protocol paths. Keep the official revision and source hash pinned, bounded nonblocking observation, privacy whitelist, and SSE/WS comparison tests. Never silently support an unvalidated native client version. Use the upstream build's licenses when distributing derived code.

Commit original source, tests, documentation and lockfiles. Do not commit runtime caches, native binaries/build trees, `node_modules`, real sample captures or credentials. Release bundles are generated from an explicit file allowlist. See `scripts/check_release.py` for public-package checks.

Version updates must keep `package.json`, `package-lock.json`, `plugin.json`, `.codex-plugin/plugin.json` and the overlay's version constant aligned. After a tagged release the workflow builds artifacts; the optional native binary is not released.
