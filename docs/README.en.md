# Codex Speed HUD

A local speedometer for Codex desktop: first-stream latency, token rate, per-turn average, cumulative tokens, and estimated API-equivalent cost.

[中文说明](README.zh-CN.md) · [Architecture and metric details](architecture.md) · [Native observer](native-observer.md) · [Privacy](../PRIVACY.md)

This is an independent community project. The desktop UI adapter uses local Electron DevTools; it is not an official OpenAI toolbar extension.

## Features

- A read-only model card showing the last completed output's model, reasoning effort, and Fast/standard mode.
- A token speedometer with retained snapshots; a button inside the top-right toolbar toggles the panel.
- Measurements isolated by host, chat, and user turn, including the first turn of a new chat.
- Per-turn averages reset on the next user message, keeping earlier Fast-mode turns out of the result.
- Cumulative input + output usage without double-counting cached input or reasoning.
- An optional same-version native observer for model-generated tool arguments and context compaction.

## Requirements and support

The automatic application-menu setup is tested on Linux with the ChatGPT/Codex desktop distribution using `/usr/share/applications/chatgpt.desktop`. Other desktop paths may require adapter changes. macOS and Windows have not been validated and do not have persistent menu setup.

- Node.js **22.15+** and a Codex CLI with `plugin marketplace` / `plugin add` support.
- A desktop build supporting a loopback Electron DevTools endpoint.
- The optional native patch supports **only `codex-cli 0.162.0-alpha.17.2`**. It is not automatically built or enabled by HUD installation.

## Install

For a release ZIP, extract it and run from its `codex-speed-hud/` directory:

```bash
node scripts/install.mjs
```

Release ZIPs bundle the runtime dependencies. A source checkout needs a build first:

```bash
npm ci --no-audit --no-fund
npm run build
node scripts/install.mjs
```

The installer registers the local plugin, sets up a **user-level** desktop launcher, and starts the HUD. If the running App has no debugging endpoint, normally quit and reopen it once through the configured application icon. The installer does not terminate the App or interrupt a conversation. Subsequent normal launches enable the local endpoint automatically.

Use the purple speedometer button beside the new-tab button to open/hide the panel; hidden panels keep collecting. Drag the panel by its header; the toolbar button stays in the toolbar. `−` collapses the content, and `×` hides the panel.

```bash
node scripts/control.mjs status
node scripts/control.mjs stop
node scripts/control.mjs start
```

## Metrics

| Field | HUD only | With native observer |
| --- | --- | --- |
| 首流 / first flow | Turn start to the first observed model stream notification; previous native timing is a fallback | Native request start to the first decoded response event, including `response.created` |
| 速率 / rate | Estimated visible-text token growth over about two seconds | Also estimates streamed tool arguments; opaque compaction uses completed output tokens / full request duration |
| 本次平均 / turn average | Observed visible tokens / observed text streaming time | Sum of completed output tokens / sum of native request durations for the same user turn, including waiting, reasoning, tool arguments, and compaction |
| 累计 / cumulative | Historical input + output, plus estimated cost | Same accounting, with native usage records |

Tool execution stdout is not model-generated tool arguments. Compaction throughput is a completed-call average, **not an instantaneous decoder rate**. Manual compaction has its own turn; it does not enter the next user message's average. Local token estimates may differ from server tokenization.

Cost is **API-equivalent estimation, not the subscription bill**. The default GPT-6.1 Sol long-context threshold is a **500,000-input-token maintainer override** inherited from this project's requirements. It is not an assertion about the official billing threshold. Set `CODEX_SPEED_HUD_SOL_CONTEXT_THRESHOLD` to the threshold appropriate to your current price card. Public pricing refreshes daily; unknown model prices remain unknown.

## Privacy and transport

There is no model forwarding proxy. The HUD does not rewrite backend URLs, authentication, request headers/body, TLS, connection pools, retries, or HTTP/WebSocket selection. The optional observer runs inside a same-version custom native client after response decoding and asynchronously writes numeric/identifier snapshots. It never enables hidden `runtime_metrics` or adds `x-responsesapi-include-timing-metrics`.

Loopback DevTools grants local inspection/control access to the App: keep it bound to **127.0.0.1** and do not forward the port. Captured text/tool arguments exist briefly in local memory; published state contains identifiers, numeric metrics, and enums. See [../PRIVACY.md](../PRIVACY.md) for files and network requests.

App upgrades can invalidate DOM adapters or the native patch. The native launcher verifies both original and patched binary hashes and falls back to the original client if they change. Rebuilding the client preserves audited transport source logic, but is not a claim of byte-identical binaries, connection timing, or guaranteed account outcomes.

## Development and release

```bash
npm ci --no-audit --no-fund
npm test
npm run build
npm run check:release
npm run package
node scripts/preview.mjs
```

Open `http://127.0.0.1:4198/` for a **synthetic** demo; it contains no real chat data or model connection. Release artifacts appear under `release/` and include source/runtime ZIPs and SHA-256 checksums. GitHub Actions runs build/tests on Node 22.15 and 24; version tags build release assets. Native builds are opt-in, expensive, and not part of routine JS CI.

See [../CONTRIBUTING.md](../CONTRIBUTING.md) and [../CHANGELOG.md](../CHANGELOG.md).

## Uninstall

```bash
node scripts/control.mjs stop
node scripts/desktop.mjs remove
codex plugin remove codex-speed-hud@agent-cost-monitor-local
```

If the native observer was enabled, set its `native-client/enabled.json` `enabled` field to false before the next normal App launch. Preserve any local files you need before removing the plugin's runtime directory. No system App files are modified.

## License

Original HUD/observer code: [MIT](../LICENSE). Modified snippets from the official Codex source retain [Apache-2.0](../licenses/codex-LICENSE) and its [NOTICE](../licenses/codex-NOTICE). Bundled tokenizer dependencies retain their own notices: [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
