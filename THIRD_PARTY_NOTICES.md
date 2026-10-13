# Third-party notices

The original HUD and observer are MIT-licensed under the root LICENSE. Third-party code retains its own license; the project license does not relicense upstream code.

| Component | Use | License and notice |
| --- | --- | --- |
| OpenAI Codex, commit `740e5af33c71225640e0c1c1555c514c2c93ab74` | Modified hook snippets in `native/apply.py` and the unified patch; downloaded upstream source at build time | [Apache-2.0](licenses/codex-LICENSE), [upstream NOTICE](licenses/codex-NOTICE) |
| js-tiktoken 1.0.21 / o200k_base rank data | Bundled JS tokenizer and token rank data | [MIT](licenses/js-tiktoken-LICENSE), [upstream source](https://github.com/dqbd/tiktoken) |
| base64-js 1.5.1 | Tokenizer dependency bundled in JS output | [MIT](licenses/base64-js-LICENSE), [upstream source](https://github.com/beatgammit/base64-js) |

The Codex hook snippets have been modified to attach a bounded local response observer after decoding. `native/observer.rs` is original project code. No complete official App source or compiled native binary is included in releases. A rebuilt Codex binary contains additional upstream dependencies with their own notices and requires a separate license inventory before redistribution.

The npm lockfile records development dependencies. Build and test tooling is not bundled into the runtime ZIP. Keep this file and the `licenses/` directory in both source and runtime packages.
