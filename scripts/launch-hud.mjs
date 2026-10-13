import { spawn } from 'node:child_process'
import path from 'node:path'
import { pluginRoot } from './runtime.mjs'

async function run(script, args = []) {
  const child = spawn(process.execPath, [path.join(pluginRoot, 'scripts', script), ...args], { stdio: 'inherit' })
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  if (code !== 0) process.exit(code ?? 1)
}
await run('launch-app.mjs')
await run('control.mjs', ['start', `http://127.0.0.1:${process.env.CODEX_SPEED_HUD_PORT ?? 9222}`])
