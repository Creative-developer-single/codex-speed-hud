import { spawn } from 'node:child_process'
import { access, readFile, readdir } from 'node:fs/promises'

const port = Number(process.env.CODEX_SPEED_HUD_PORT ?? 9222)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid debug port')
let executable = process.env.CODEX_SPEED_HUD_APP
if (!executable) {
  const candidates = process.platform === 'darwin'
    ? ['/Applications/ChatGPT.app/Contents/MacOS/ChatGPT', '/Applications/Codex.app/Contents/MacOS/Codex']
    : ['/usr/lib/chatgpt/ChatGPT', '/usr/lib/codex/Codex', '/opt/Codex/codex']
  for (const candidate of candidates) { try { await access(candidate); executable = candidate; break } catch { /* Try the next installation. */ } }
}
if (!executable) throw new Error('Set CODEX_SPEED_HUD_APP to the installed desktop executable')
if (process.platform === 'linux') {
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    let args
    try { args = (await readFile(`/proc/${entry}/cmdline`, 'utf8')).split('\0') } catch { continue }
    if (args[0] === executable && !args.some(arg => arg.startsWith('--type='))) {
      throw new Error('Desktop App is already running. Quit it normally, then run this launcher; it will not terminate active chats.')
    }
  }
}
const child = spawn(executable, ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`], { detached: true, stdio: 'ignore' })
await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
child.unref()
console.log(`Desktop launch requested with loopback DevTools port ${port}. Start the HUD runner separately.`)
