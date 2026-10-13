# Local data and privacy

Codex Speed HUD is a local desktop adapter. It does not provide a hosted telemetry service, forward model traffic, inspect authentication files, or add timing headers.

## Data read

- Existing renderer notifications, including visible output, lifecycle metadata and usage.
- Existing local session logs and the native SQLite log database in read-only mode, to extract usage and selected numeric metadata. Logs can contain private text even when the resulting state is numeric.
- With the optional native patch: already-decoded selected response fields, including transient tool argument text, inside the custom client. These are processed after the original network receive path; encrypted compaction content is not tokenized.

Visible text and tool arguments are briefly held in bounded local memory for estimates. Do not interpret numeric output files as proof that the process never encounters content.

## Data written

The runtime directory defaults to `$XDG_CACHE_HOME/codex-speed-hud` or `~/.cache/codex-speed-hud`; `CODEX_SPEED_HUD_DATA` overrides it. Files include connection status, chat/turn/response identifiers, numeric samples, captured model/service-mode metadata, and a public pricing cache. Native sample files are private (0600, directory 0700). Identifiers are still local metadata and should not be included in public bug reports.

The panel position is kept in the App's localStorage. User-level desktop launch files and optional native build/binary/hash manifests are stored locally. The repository/release package excludes all runtime files, real conversation records, account files, and native build caches.

## Network and local inspection

Normal model traffic follows the selected client's original transport code. The HUD separately fetches only the public OpenAI pricing document and does not send chat contents to it. Optional native builds download official public source/dependencies. Installation uses the Codex CLI's local plugin flow.

Electron DevTools runs on **127.0.0.1**, normally port 9222. A process able to reach that port can inspect/control the App. Do not expose or tunnel it. Restoring the desktop launcher and normally reopening the App without debugging flags closes the endpoint.

## Reporting problems

Use synthetic reproductions. Redact chat identifiers, prompts, tool arguments, responses, credentials, private filesystem paths and diagnostic logs before sharing. Never upload your `auth.json` or the plugin runtime directory.
