import { it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

it('refreshes only verified observation source and refuses unrelated or unknown edits before writing', async () => {
  const code = `
from pathlib import Path
import sys,tempfile,tarfile,json,hashlib,io
sys.path.insert(0,'native')
import refresh
with tempfile.TemporaryDirectory() as d:
 p=Path(d);source=p/'codex-fixture';rs=source/'codex-rs';rs.mkdir(parents=True)
 archive=p/'source.tar.gz';before={'codex-api/src/lib.rs':b'original', 'core/src/unrelated.rs':b'untouched'}
 with tarfile.open(archive,'w:gz') as t:
  for name,content in before.items():
   info=tarfile.TarInfo('codex-fixture/codex-rs/'+name);info.size=len(content);t.addfile(info,io.BytesIO(content))
 for name,content in before.items():
  f=rs/name;f.parent.mkdir(parents=True,exist_ok=True);f.write_bytes(content)
 changed=rs/'codex-api/src/lib.rs';changed.write_bytes(b'owned patch')
 observer=rs/'codex-api/src/speed_observer.rs';observer.write_bytes(b'known observer')
 h=lambda b:hashlib.sha256(b).hexdigest()
 refresh.REVISION='fixture';refresh.ARCHIVE_SHA=h(archive.read_bytes());refresh.OLD_OBSERVER_SHA=h(observer.read_bytes())
 (source/'speed-observer-patch.json').write_text(json.dumps({'revision':'fixture','files':{'codex-api/src/lib.rs':{'before':h(b'original'),'after':h(b'owned patch')}}}))
 here=p/'installer';here.mkdir();(here/'apply.py').write_text("from pathlib import Path;import sys;Path(sys.argv[1],'applied').touch()")
 foreign=rs/'core/src/unrelated.rs';foreign.write_bytes(b'user edit')
 try:refresh.refresh_source(source,archive,here);raise AssertionError('accepted foreign edit')
 except SystemExit:pass
 assert changed.read_bytes()==b'owned patch' and foreign.read_bytes()==b'user edit'
 foreign.write_bytes(b'untouched');observer.write_bytes(b'unknown observer')
 try:refresh.refresh_source(source,archive,here);raise AssertionError('accepted unknown observer')
 except SystemExit:pass
 assert changed.read_bytes()==b'owned patch'
 observer.write_bytes(b'known observer');refresh.refresh_source(source,archive,here)
 assert changed.read_bytes()==b'original' and foreign.read_bytes()==b'untouched' and (source/'applied').exists()
print('verified')
`
  const { stdout } = await promisify(execFile)('python3', ['-c', code])
  expect(stdout.trim()).toBe('verified')
})
