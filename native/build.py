#!/usr/bin/env python3
"""Reproducible optional native build. Never starts/stops the desktop App or changes network config."""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import tarfile
import tomllib
import urllib.request

REVISION='740e5af33c71225640e0c1c1555c514c2c93ab74'
VERSION='0.162.0-alpha.17.2'
ARCHIVE_SHA='14454949ed75479ad3f24fac97b962f7afdce163e72c0a68b2142d0dca207631'
here=pathlib.Path(__file__).resolve().parent
parser=argparse.ArgumentParser()
parser.add_argument('--original',default='/usr/lib/chatgpt/resources/codex')
parser.add_argument('--cache',default=str(pathlib.Path(os.environ.get('CODEX_SPEED_HUD_DATA',pathlib.Path.home()/'.cache/codex-speed-hud'))/'native-client'))
parser.add_argument('--stage-existing',action='store_true',help='Validate and stage a previously completed release build')
args=parser.parse_args()
cache=pathlib.Path(args.cache).resolve();cache.mkdir(parents=True,exist_ok=True)
original=pathlib.Path(args.original).resolve()
def digest(p):
    h=hashlib.sha256()
    with open(p,'rb') as f:
        while block:=f.read(1024*1024): h.update(block)
    return h.hexdigest()
def run(command,**kwargs): return subprocess.run(command,check=True,**kwargs)
original_sha=digest(original)
if subprocess.check_output([original,'--version'],text=True).strip()!=f'codex-cli {VERSION}':
    raise SystemExit('Installed client version is unsupported; keep the original client active.')
archive=cache/'source.tar.gz'
source=cache/f'codex-{REVISION}'
if not args.stage_existing:
    if not archive.exists():
        urllib.request.urlretrieve(f'https://codeload.github.com/openai/codex/tar.gz/{REVISION}',archive)
    if digest(archive)!=ARCHIVE_SHA: raise SystemExit('Official source archive digest mismatch')
    if not source.exists():
        with tarfile.open(archive) as tar: tar.extractall(cache,filter='data')
    if not (source/'speed-observer-patch.json').exists(): run(['python3',str(here/'apply.py'),str(source)])
rs=source/'codex-rs'
manifest=json.loads((source/'speed-observer-patch.json').read_text())
if manifest['revision']!=REVISION or digest(archive)!=ARCHIVE_SHA: raise SystemExit('Source provenance mismatch')
with tarfile.open(archive) as tar:
    baseline=tomllib.loads(tar.extractfile(f'codex-{REVISION}/codex-rs/Cargo.lock').read().decode())
    for name, hashes in manifest['files'].items():
        before=tar.extractfile(f'codex-{REVISION}/codex-rs/{name}').read()
        if hashlib.sha256(before).hexdigest()!=hashes['before'] or digest(rs/name)!=hashes['after']:
            raise SystemExit(f'Unexpected source modification: {name}')
    # Audit every original native source/build asset, not just the inserted hooks.
    for member in tar.getmembers():
        prefix=f'codex-{REVISION}/codex-rs/'
        if not member.isfile() or not member.name.startswith(prefix): continue
        name=member.name[len(prefix):]
        if name=='Cargo.lock' or name in manifest['files']: continue
        if digest(rs/name)!=hashlib.sha256(tar.extractfile(member).read()).hexdigest():
            raise SystemExit(f'Unexpected modification outside observer patch: {name}')
if digest(rs/'codex-api/src/speed_observer.rs')!=digest(here/'observer.rs'): raise SystemExit('Observer source does not match this plugin')
if not args.stage_existing:
    # Updating the upstream workspace's stamped version is expected; external versions must stay pinned.
    run(['cargo','+stable','check','-p','codex-api'],cwd=rs)
updated=tomllib.loads((rs/'Cargo.lock').read_text())
def external(lock): return {(p['name'],p['version'],p['source']) for p in lock['package'] if 'source' in p}
if external(baseline)-external(updated): raise SystemExit('An original external dependency changed; refusing to stage')
if not args.stage_existing:
    env={**os.environ,'CARGO_PROFILE_RELEASE_LTO':'false','CARGO_PROFILE_RELEASE_DEBUG':'0','CARGO_PROFILE_RELEASE_CODEGEN_UNITS':'16'}
    run(['cargo','+stable','build','-p','codex-cli','--bin','codex','--release','--locked','-j','8'],cwd=rs,env=env)
    run(['cargo','+stable','test','-p','codex-api','--locked','-j','4'],cwd=rs)
binary=rs/'target/release/codex'
if subprocess.check_output([binary,'--version'],text=True).strip()!=f'codex-cli {VERSION}': raise SystemExit('Patched client identity mismatch')
run(['python3',str(here/'smoke.py'),str(binary),str(original)])
run(['python3',str(here/'smoke.py'),str(binary),str(original),'--websocket'])
if digest(original)!=original_sha: raise SystemExit('The installed App changed during validation')
destination=cache/'codex'
shutil.copyfile(binary, destination.with_suffix('.tmp'));destination.with_suffix('.tmp').chmod(0o700)
destination.with_suffix('.tmp').replace(destination)
helper=original.parent/'codex-code-mode-host'
if helper.exists() and not (cache/'codex-code-mode-host').exists(): (cache/'codex-code-mode-host').symlink_to(helper)
manifest={'schema':1,'enabled':True,'validated':True,'revision':REVISION,'version':VERSION,'binary':str(destination),
    'sha256':digest(destination),'originalBinary':str(original),'originalSha256':original_sha,
    'observerSha256':digest(here/'observer.rs'),'originalExternalDependenciesUnchanged':True,'upstreamProxy':False,'timingHeaderEnabled':False}
temporary=cache/'enabled.json.tmp';temporary.write_text(json.dumps(manifest,indent=2));temporary.chmod(0o600);temporary.replace(cache/'enabled.json')
print(json.dumps({'staged':True,'activeInCurrentApp':False,'nextNormalLaunch':True,'binary':str(destination)}))
