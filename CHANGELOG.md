# Changelog

## 0.4.4 — 2026-10-13

Initial public source release of the existing locally validated plugin.

- Native toolbar button to open/hide the speed panel; automatic remount on toolbar replacement.
- Retained first-flow and speed snapshots; read-only last-completed model/effort/mode card.
- First-turn chat identification and host/chat/turn isolation.
- Optional pinned native observation for tool arguments and compaction without model forwarding.
- Native per-turn average includes completed calls and request waiting; renderer-only mode uses observed text streams.
- Local token totals and API-equivalent estimated cost; public pricing refresh.
- Linux user-level persistent launcher; guarded custom client override and original-client fallback.
- Public repository documentation, MIT/Apache/dependency notices, package checks, source/runtime ZIPs and CI.

Live development validation captured a completed compaction with a 1.273 s first flow, 5,737 output tokens over 188.359 s, and 30.46 tok/s full-duration throughput. These numeric results are illustrative validation evidence, not a performance guarantee. The public demo uses synthetic data only.
