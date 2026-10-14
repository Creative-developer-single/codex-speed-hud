"""Upgrade a verified, owned observation patch without touching foreign source edits."""
import hashlib
import json
import pathlib
import subprocess
import tarfile

REVISION = '740e5af33c71225640e0c1c1555c514c2c93ab74'
ARCHIVE_SHA = '14454949ed75479ad3f24fac97b962f7afdce163e72c0a68b2142d0dca207631'
OLD_OBSERVER_SHA = 'e360865fbb4e919f154f2c61e100cb1444a17352b4aca25d83ae1a2d7767aae3'
OWNED = {'codex-api/Cargo.toml', 'codex-api/src/lib.rs', 'codex-api/src/endpoint/responses.rs',
         'codex-api/src/endpoint/responses_websocket.rs', 'codex-api/src/sse/responses.rs',
         'core/src/turn_timing.rs', 'core/src/session/turn.rs', 'core/src/compact.rs', 'core/src/compact_remote_v2.rs'}

def digest(content): return hashlib.sha256(content).hexdigest()

def refresh_source(source, archive, here):
    source, archive, here = map(pathlib.Path, (source, archive, here))
    manifest = json.loads((source/'speed-observer-patch.json').read_text())
    observer = source/'codex-rs/codex-api/src/speed_observer.rs'
    if manifest.get('revision') != REVISION or digest(archive.read_bytes()) != ARCHIVE_SHA:
        raise SystemExit('Source provenance mismatch; refusing to refresh')
    if not manifest['files'] or not set(manifest['files']) <= OWNED:
        raise SystemExit('Foreign patch files; refusing to refresh')
    if digest(observer.read_bytes()) not in {OLD_OBSERVER_SHA, manifest.get('observerSha256')}:
        raise SystemExit('Observer contains unrecognized edits; refusing to refresh')
    originals = {}
    # Validate the entire original source before restoring any owned file.
    with tarfile.open(archive) as tar:
        prefix = f'codex-{REVISION}/codex-rs/'
        for member in tar.getmembers():
            if not member.isfile() or not member.name.startswith(prefix): continue
            name = member.name[len(prefix):]
            if name == 'Cargo.lock': continue
            before = tar.extractfile(member).read()
            hashes = manifest['files'].get(name)
            expected = hashes['after'] if hashes else digest(before)
            if (hashes and digest(before) != hashes['before']) or digest((source/'codex-rs'/name).read_bytes()) != expected:
                raise SystemExit(f'Foreign source edits: {name}; refusing to refresh')
            if hashes: originals[name] = before
    for name, before in originals.items(): (source/'codex-rs'/name).write_bytes(before)
    subprocess.run(['python3', str(here/'apply.py'), str(source)], check=True)
