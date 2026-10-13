---
name: speed-hud
description: Start, inspect, or stop the local Codex App TTFT and visible token-speed overlay.
---

Resolve the plugin root from this skill's location (`../..`). Run only the action requested by the user:

- Start: `node scripts/control.mjs start`
- Inspect: `node scripts/control.mjs status`
- Stop: `node scripts/control.mjs stop`

If the user requests another loopback DevTools port, pass its HTTP URL to `start`, e.g. `node scripts/control.mjs start http://127.0.0.1:9333`. An already-running runner keeps its endpoint; stop and start it to switch.

If the bundled HUD is missing, use the setup skill. If status is `waiting_cdp`, follow setup instructions without terminating the active desktop App. `connected` means attached; `notifications > 0` is required before claiming stream events have actually been observed. Native TTFT and live estimated visible tok/s have different sources and timing. There are no automatic lifecycle hooks or repeated model tool calls.
