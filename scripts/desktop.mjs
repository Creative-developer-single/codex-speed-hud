import os from 'node:os'
import path from 'node:path'
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { pluginRoot } from './runtime.mjs'

const marker = 'X-Codex-Speed-HUD=true'
const exists = async p => { try { await access(p); return true } catch { return false } }
const shell = s => `'${String(s).replaceAll("'", "'\\''")}'`
const desktopArg = s => `"${String(s).replace(/[\\"`$]/g, '\\$&').replaceAll('%', '%%')}"`

export async function installDesktop({ dataHome = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local/share'),
  systemDesktop = '/usr/share/applications/chatgpt.desktop', root = pluginRoot, node = process.execPath, port = 9222 } = {}) {
  if (process.platform !== 'linux') throw new Error('Persistent application-menu integration currently supports Linux only')
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local debug port')
  const desktop = path.join(dataHome, 'applications', 'chatgpt.desktop')
  const directory = path.join(dataHome, 'codex-speed-hud')
  const backup = path.join(directory, 'original-chatgpt.desktop')
  const launcher = path.join(directory, 'launch-chatgpt.sh')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await mkdir(path.dirname(desktop), { recursive: true })
  let previous = null
  try { previous = await readFile(desktop, 'utf8') } catch { /* System entry will be overridden. */ }
  if (previous && !previous.includes(marker) && !await exists(backup)) await writeFile(backup, previous, { mode: 0o600 })
  const original = previous?.includes(marker) ? await readFile(await exists(backup) ? backup : systemDesktop, 'utf8')
    : previous ?? await readFile(systemDesktop, 'utf8')
  const exec = original.match(/^Exec=("[^"]+"|[^\s]+)(.*)$/m)
  if (!exec) throw new Error('ChatGPT application entry has no supported Exec command')
  const application = exec[1].replace(/^"|"$/g, '')
  // Keep the original command, URI arguments, icon and desktop ID. No transport/config changes.
  const script = `#!/bin/sh\n# Managed by Codex Speed HUD. Local debugging and an optional validated native observer.\n${shell(node)} ${shell(path.join(root, 'scripts/control.mjs'))} start ${shell(`http://127.0.0.1:${port}`)} >/dev/null 2>&1 &\nexec ${shell(node)} ${shell(path.join(root, 'scripts/native-launch.mjs'))} ${shell(application)} --remote-debugging-address=127.0.0.1 --remote-debugging-port=${port} "$@"\n`
  await writeFile(launcher + '.tmp', script, { mode: 0o700 }); await chmod(launcher + '.tmp', 0o700); await rename(launcher + '.tmp', launcher)
  const content = original.replace(/^Exec=.*$/m, `Exec=${desktopArg(launcher)}${exec[2]}`).trimEnd() + `\n${marker}\n`
  await writeFile(desktop + '.tmp', content, { mode: 0o644 }); await rename(desktop + '.tmp', desktop)
  return { installed: true, desktop, launcher, port, restartRequired: true, automaticHUD: true }
}

export async function removeDesktop({ dataHome = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local/share') } = {}) {
  const desktop = path.join(dataHome, 'applications', 'chatgpt.desktop')
  const directory = path.join(dataHome, 'codex-speed-hud')
  const backup = path.join(directory, 'original-chatgpt.desktop')
  let content
  try { content = await readFile(desktop, 'utf8') } catch { return { removed: false } }
  if (!content.includes(marker)) throw new Error('Application entry was changed externally; refusing to overwrite it')
  if (await exists(backup)) { await writeFile(desktop, await readFile(backup), { mode: 0o644 }); await unlink(backup) }
  else await unlink(desktop)
  await unlink(path.join(directory, 'launch-chatgpt.sh')).catch(() => {})
  return { removed: true, desktop }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? 'install'
  if (command === 'install') console.log(JSON.stringify(await installDesktop({ port: Number(process.env.CODEX_SPEED_HUD_PORT ?? 9222) }), null, 2))
  else if (command === 'remove') console.log(JSON.stringify(await removeDesktop(), null, 2))
  else throw new Error('Usage: desktop.mjs install | remove')
}
