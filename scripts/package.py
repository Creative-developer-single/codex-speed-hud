#!/usr/bin/env python3
"""Create source/runtime ZIPs from an explicit allowlist, including license notices."""
import argparse
import hashlib
from pathlib import Path
import zipfile
from check_release import ROOT, public_files, validate_source, validate_archive

parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, default=ROOT / 'release')
args = parser.parse_args()
version, _ = validate_source()
for name in ['dist/hud.js', 'dist/runner.mjs']:
    if not (ROOT / name).is_file():
        raise SystemExit('Build bundles first: npm run build')
args.output.mkdir(parents=True, exist_ok=True)
checksums = []
for label, runtime in [('', True), ('-source', False)]:
    dest = args.output / f'codex-speed-hud-{version}{label}.zip'
    with zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for file in public_files(runtime):
            relative = file.relative_to(ROOT)
            info = zipfile.ZipInfo(f'codex-speed-hud/{relative.as_posix()}', date_time=(2026, 10, 13, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, file.read_bytes())
    validate_archive(dest)
    checksums.append(f'{hashlib.sha256(dest.read_bytes()).hexdigest()}  {dest.name}')
    print(f'{dest}: {dest.stat().st_size:,} bytes; contents verified')
(args.output / 'SHA256SUMS').write_text('\n'.join(checksums) + '\n')
