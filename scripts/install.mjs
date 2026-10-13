import os from 'node:os'
import path from 'node:path'
import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pluginRoot } from './runtime.mjs'
import { installDesktop } from './desktop.mjs'
import { registerMarketplace } from './marketplace.mjs'

// A companion installer, not an unsupported arbitrary post-install manifest hook.
const run = promisify(execFile)
const exists = async p => { try { await access(p); return true } catch { return false } }
let cli = process.env.CODEX_SPEED_HUD_CODEX
if (!cli) {
  for (const p of ['/usr/lib/chatgpt/resources/codex', '/usr/lib/codex/resources/codex']) if (await exists(p)) { cli = p; break }
  cli ??= 'codex'
}
await access(path.join(pluginRoot, 'dist/hud.js'))
await access(path.join(pluginRoot, 'dist/runner.mjs'))
let marketplace = await exists(path.join(pluginRoot, '.agents/plugins/marketplace.json')) ? pluginRoot : path.resolve(pluginRoot, '../..')
if (!await exists(path.join(marketplace, '.agents/plugins/marketplace.json'))) {
  marketplace = path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local/share'), 'codex-speed-hud/marketplace')
  const source = path.join(marketplace, 'plugin')
  if (path.resolve(source) !== path.resolve(pluginRoot)) await cp(pluginRoot, source, { recursive: true, filter: p => !['node_modules', '.git', 'artifacts'].includes(path.basename(p)) })
  await mkdir(path.join(marketplace, '.agents/plugins'), { recursive: true })
  await writeFile(path.join(marketplace, '.agents/plugins/marketplace.json'), JSON.stringify({ name: 'agent-cost-monitor-local', interface: { displayName: 'AgentCost Monitor Local' }, plugins: [{ name: 'codex-speed-hud', source: { source: 'local', path: './plugin' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools' }] }, null, 2))
}
await registerMarketplace(cli, marketplace, run)
const { version } = JSON.parse(await readFile(path.join(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'))
const added = JSON.parse((await run(cli, ['plugin', 'add', 'codex-speed-hud@agent-cost-monitor-local', '--json'], { timeout: 30_000 })).stdout)
let identical = added.version === version
if (identical) for (const filename of ['dist/hud.js', 'dist/runner.mjs', 'scripts/install.mjs', 'scripts/control.mjs', 'scripts/desktop.mjs', 'scripts/native-launch.mjs', 'native/observer.rs', 'native/apply.py', 'native/build.py', 'native/smoke.py']) {
  try {
    if (!(await readFile(path.join(pluginRoot, filename))).equals(await readFile(path.join(added.installedPath, filename)))) { identical = false; break }
  } catch { identical = false; break }
}
if (!identical) {
  // This CLI treats add as idempotent. Refresh this one owned plugin through its supported commands.
  await run(process.execPath, [path.join(pluginRoot, 'scripts/control.mjs'), 'stop'], { timeout: 15_000 })
  await run(cli, ['plugin', 'remove', 'codex-speed-hud@agent-cost-monitor-local', '--json'], { timeout: 30_000 })
  await run(cli, ['plugin', 'add', 'codex-speed-hud@agent-cost-monitor-local', '--json'], { timeout: 30_000 })
}
const installedRoot = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'plugins/cache/agent-cost-monitor-local/codex-speed-hud', version)
await access(path.join(installedRoot, 'dist/runner.mjs'))
const desktop = process.platform === 'linux' ? await installDesktop({ root: installedRoot }) : { installed: false, reason: 'Persistent menu integration currently supports Linux only' }
await run(process.execPath, [path.join(installedRoot, 'scripts/control.mjs'), 'stop'], { timeout: 15_000 })
const { stdout } = await run(process.execPath, [path.join(installedRoot, 'scripts/control.mjs'), 'start'], { timeout: 15_000 })
const status = JSON.parse(stdout)
console.log(JSON.stringify({ installed: true, version, pluginRoot: installedRoot, desktop, running: status.running, phase: status.phase, telemetry: status.telemetry, note: status.phase === 'connected' ? 'Current App is connected. No restart is needed now.' : 'The existing App is not interrupted. The configured application-menu entry enables local debugging on the next normal launch.' }, null, 2))
