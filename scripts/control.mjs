import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { pluginRoot, readStatus, alive } from './runtime.mjs'
import { loopbackURL } from './cdp.mjs'

const command = process.argv[2] ?? 'status'
const current = await readStatus()
const running = current && current.phase !== 'stopped' && alive(current.pid)
if (command === 'status') {
  console.log(JSON.stringify({ ...current, running: Boolean(running) }, null, 2))
} else if (command === 'start') {
  if (process.argv[3]) process.env.CODEX_SPEED_HUD_CDP = process.argv[3]
  loopbackURL(process.env.CODEX_SPEED_HUD_CDP ?? 'http://127.0.0.1:9222', ['http:'])
  if (running) { console.log(JSON.stringify({ ...current, running: true }, null, 2)); process.exit(0) }
  try { await access(path.join(pluginRoot, 'dist/hud.js')) } catch { throw new Error('Run npm install and npm run build in the plugin directory first') }
  await access(path.join(pluginRoot, 'dist/runner.mjs'))
  const child = spawn(process.execPath, [path.join(pluginRoot, 'dist/runner.mjs')], { detached: true, stdio: 'ignore', env: process.env })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  child.unref()
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 100))
    const status = await readStatus()
    if (status?.pid === child.pid) { console.log(JSON.stringify({ ...status, running: true }, null, 2)); process.exit(0) }
    if (!alive(child.pid)) break
  }
  throw new Error('HUD runner failed to start; run node dist/runner.mjs in the foreground for diagnostics')
} else if (command === 'stop') {
  if (running) {
    // Verify command ownership before signalling a PID that might have been reused.
    if (process.platform === 'linux') {
      const { readFile } = await import('node:fs/promises')
      const args = (await readFile(`/proc/${current.pid}/cmdline`, 'utf8')).split('\0')
      if (!args.some(arg => ['scripts/runner.mjs', 'dist/runner.mjs'].some(script => arg === path.join(current.pluginRoot, script)))) throw new Error('Saved PID is not a HUD runner; refusing to signal it')
    }
    process.kill(current.pid, 'SIGTERM')
    for (let i = 0; i < 100; i++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      const status = await readStatus()
      if (status?.phase === 'stopped') { console.log('HUD stopped; overlays removed.'); process.exit(0) }
    }
    throw new Error('Stop requested; renderer cleanup is still pending')
  }
  console.log('HUD is not running.')
} else throw new Error('Usage: node scripts/control.mjs start [http://127.0.0.1:9222] | status | stop')
