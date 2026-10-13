import { expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { installDesktop, removeDesktop } from '../scripts/desktop.mjs'

it('installs a persistent menu launcher, starts HUD automatically, preserves URI arguments and restores user customizations', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'hud desktop-'))
  const dataHome = path.join(temp, 'user'), desktop = path.join(dataHome, 'applications/chatgpt.desktop')
  const app = path.join(temp, 'app'), node = path.join(temp, 'node'), result = path.join(temp, 'app.args')
  await mkdir(path.dirname(desktop), { recursive: true })
  await writeFile(app, `#!/bin/sh\nprintf '%s\\n' "$@" > '${result}'\n`, { mode: 0o700 })
  await writeFile(node, '#!/bin/sh\ncase "$1" in */native-launch.mjs) shift; exec "$@";; *) exit 0;; esac\n', { mode: 0o700 })
  const original = `[Desktop Entry]\nName=ChatGPT\nExec="${app}" %U\nIcon=chatgpt\nType=Application\nMimeType=x-scheme-handler/codex;\n`
  await writeFile(desktop, original)
  try {
    const installed = await installDesktop({ dataHome, root: temp, node })
    const content = await readFile(desktop, 'utf8')
    expect(content).toContain(' %U'); expect(content).toContain('MimeType=x-scheme-handler/codex;')
    expect(content).toContain('X-Codex-Speed-HUD=true')
    const uri = 'codex://threads/example?x=$(echo untouched)'
    await promisify(execFile)(installed.launcher, [uri])
    expect((await readFile(result, 'utf8')).trim().split('\n')).toEqual(['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222', uri])
    expect(await readFile(installed.launcher, 'utf8')).toContain('scripts/control.mjs')
    await installDesktop({ dataHome, root: temp, node })
    await removeDesktop({ dataHome })
    expect(await readFile(desktop, 'utf8')).toBe(original)
  } finally { await rm(temp, { recursive: true, force: true }) }
})

it('removes an override cleanly when only a system desktop entry existed', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'hud-menu-'))
  const systemDesktop = path.join(temp, 'system.desktop')
  await writeFile(systemDesktop, '[Desktop Entry]\nName=ChatGPT\nExec=chatgpt %U\nType=Application\n')
  try {
    const installed = await installDesktop({ dataHome: path.join(temp, 'user'), systemDesktop })
    await removeDesktop({ dataHome: path.join(temp, 'user') })
    await expect(readFile(installed.desktop)).rejects.toThrow()
    expect(await readFile(systemDesktop, 'utf8')).toContain('Exec=chatgpt %U')
  } finally { await rm(temp, { recursive: true, force: true }) }
})
