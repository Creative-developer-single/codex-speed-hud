#!/usr/bin/env python3
"""Validate the public file allowlist and release archives without reading runtime data."""
from pathlib import Path
import json
import re
import zipfile

ROOT = Path(__file__).resolve().parent.parent
FILES = {'.gitignore', 'README.md', 'LICENSE', 'PRIVACY.md', 'SECURITY.md',
         'CONTRIBUTING.md', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', 'package.json',
         'package-lock.json', 'plugin.json', 'vitest.config.mjs'}
DIRS = {'src', 'scripts', 'skills', 'native', 'demo', '.codex-plugin', '.agents',
        'docs', 'licenses', '.github', 'tests'}
IGNORED = {'node_modules', '.git', '__pycache__', 'artifacts', 'output', '.playwright-cli', 'target'}
PRIVATE = re.compile(r'/home/[^/\s]+/|/Users/[^/\s]+/|\bgh[opusr]_[A-Za-z0-9]{30,}|\bsk-[A-Za-z0-9_-]{32,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----')

def public_files(runtime=False):
    for p in sorted(ROOT.rglob('*')):
        rel = p.relative_to(ROOT)
        if any(x in IGNORED for x in rel.parts) or not p.is_file():
            continue
        if p.is_symlink():
            raise ValueError(f'Symlink is not allowed: {rel}')
        if rel.parts[0] in DIRS or len(rel.parts) == 1 and rel.name in FILES:
            yield p
        elif runtime and rel.as_posix() in {'dist/hud.js', 'dist/runner.mjs'}:
            yield p

def inspect_content(name, content):
    if name.endswith(('.png', '.jpg', '.jpeg', '.webp')):
        return
    text = content.decode('utf-8')
    # The validator's own regex identifies forbidden content, not real data.
    if name != 'scripts/check_release.py' and PRIVATE.search(text):
        raise ValueError(f'Private path, real session identifier or credential pattern in {name}')
    if any(x in Path(name).parts for x in IGNORED) or Path(name).name in {'auth.json', 'status.json', 'enabled.json', 'request-settings.json'}:
        raise ValueError(f'Runtime or build data in {name}')

def validate_source():
    version = json.loads((ROOT / 'package.json').read_text())['version']
    for name in ['plugin.json', '.codex-plugin/plugin.json', 'package-lock.json']:
        assert json.loads((ROOT / name).read_text())['version'] == version, name
    assert json.loads((ROOT / 'package-lock.json').read_text())['packages']['']['version'] == version
    assert f"const VERSION = '{version}'" in (ROOT / 'src/overlay.mjs').read_text()
    for name in ['licenses/codex-LICENSE', 'licenses/codex-NOTICE', 'licenses/js-tiktoken-LICENSE', 'licenses/base64-js-LICENSE']:
        assert (ROOT / name).is_file(), name
    paths = list(public_files(runtime=True))
    for path in paths:
        inspect_content(path.relative_to(ROOT).as_posix(), path.read_bytes())
    return version, paths

def validate_archive(filename):
    with zipfile.ZipFile(filename) as archive:
        names = archive.namelist()
        assert archive.testzip() is None
        assert names and all(n.startswith('codex-speed-hud/') for n in names)
        for n in names:
            name = n.removeprefix('codex-speed-hud/')
            assert '..' not in Path(name).parts and not name.startswith('/')
            inspect_content(name, archive.read(n))
        for required in ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses/codex-LICENSE', 'licenses/js-tiktoken-LICENSE', 'plugin.json']:
            assert f'codex-speed-hud/{required}' in names

if __name__ == '__main__':
    version, files = validate_source()
    print(f'Public source {version}: {len(files)} allowed files; versions, licenses and private-data checks passed.')
