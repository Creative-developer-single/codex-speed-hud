# Changelog

## 0.4.5 — 2026-10-13

- 修复 Dot / durable 聊天的桌面 `local:` ID 前缀解析，保留真实主机身份。
- 接入已收到的云端原始响应完成通知，只保留模型事件类别，不保存工具参数或加密内容。
- 支持正文增量测速及带明确同消息服务端起止时间的完成消息平均吞吐；批量送达和历史消息不伪造速率。
- 防止云端聊天混入本机原生样本，并隔离相同聊天／轮次 ID 的不同主机。
- 保留上游连接、原生观察补丁、系统 App 和正在运行的聊天；HUD 可以热更新。

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
