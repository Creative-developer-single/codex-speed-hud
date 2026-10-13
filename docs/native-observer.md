# Optional native observer

Supported client identity: `codex-cli 0.162.0-alpha.17.2`, official commit `740e5af33c71225640e0c1c1555c514c2c93ab74`.

Official source archive: `https://codeload.github.com/openai/codex/tar.gz/740e5af33c71225640e0c1c1555c514c2c93ab74`.

Archive SHA-256: `14454949ed75479ad3f24fac97b962f7afdce163e72c0a68b2142d0dca207631`.

## Build and activate

Linux is the validated target. Use Python **3.12+** (TOML and safe tar extraction), a Rust stable toolchain, and the official upstream native build prerequisites. The development build was tested with Rust 1.97.1. Allow substantial disk space and build time; the release artifact does not include native binaries or the official source cache.

```bash
python3 native/build.py --original /usr/lib/chatgpt/resources/codex
```

The script rejects different client versions, verifies archive/source provenance and unchanged original external dependencies, builds a release binary, runs codex-api tests, and compares outgoing SSE/WS requests with the packaged original client using a loopback fake server and dummy credentials. Real OpenAI traffic is not used for these tests. Original request identity and decoded JSON/header behavior are compared with explicit normalization of random metadata; this is not a packet-byte/TLS-fingerprint equivalence claim.

The default build cache is under `CODEX_SPEED_HUD_DATA` or `~/.cache/codex-speed-hud/native-client`. For a non-default `XDG_CACHE_HOME`, set `CODEX_SPEED_HUD_DATA` consistently for both build and HUD. Do not use a custom `--cache` path unless the launch manifest is placed in the HUD runtime directory.

After validation, the launcher selects the staged binary via the App's existing `CODEX_CLI_PATH` mechanism **on the next normal App launch**. It preserves upstream transport code and official startup arguments. It never replaces the system binary or forcibly restarts the App. Other custom client overrides are respected. Binary hashes are rechecked each launch; an App update or altered file falls back to the original client.

For an already completed build:

```bash
python3 native/build.py --stage-existing
```

`observer.phase=observed` plus real numeric samples is evidence of native capture. `connected` alone only confirms CDP attachment.

## Observation boundaries

Hooks are inserted after decoded SSE/WS event receipt and before the original converter filters tool argument deltas. The patch does not modify URL, credentials, headers/body, TLS, connection pooling, protocol choice, or retry logic. Hidden `runtime_metrics` remains disabled. Local first-flow timing includes `response.created`; WS warmup with `generate=false` is excluded.

A nonblocking bounded queue sends selected fields to a background worker for tokenization. No model proxy or additional upstream connection is introduced. Arguments exist transiently in worker memory; bounded numeric snapshots are atomically written with private filesystem permissions. Dropped/oversized samples invalidate the affected measurement rather than inventing a rate.

Compaction ciphertext is not copied or tokenized. Completed native output usage divided by full request duration supplies compaction throughput; no instantaneous compaction rate is claimed. Same-turn averages use completed final output usage once, avoiding a second addition of locally estimated tool tokens. Host/thread/turn IDs prevent background and historical mixing.

## Disable

Set `enabled` to false in `native-client/enabled.json`, then normally reopen the App. No current native process is hot-replaced. Keep the HUD running if visible-text estimates are still useful.

## Licensing

`native/observer.rs` is original MIT code. Modified Codex hook snippets in `native/apply.py` and the unified patch are derived from Apache-2.0 Codex at the pinned revision; retain `licenses/codex-LICENSE` and `licenses/codex-NOTICE`. Those files have been modified for this local observation feature. The upstream Rust project and its dependencies retain their original licenses; distribute a rebuilt native binary only with a separate dependency-license review.
