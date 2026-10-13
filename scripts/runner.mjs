import os from 'node:os'
import path from 'node:path'
import { readFile, open, unlink, mkdir } from 'node:fs/promises'
import { CDPClient, listTargets, loopbackURL } from './cdp.mjs'
import { LocalLogReader } from './log-reader.mjs'
import { createPricingSync } from './pricing-sync.mjs'
import { RequestSettings } from './request-settings.mjs'
import { NativeTelemetryReader } from './telemetry-reader.mjs'
import { ObserverReader } from './observer-reader.mjs'
import { pluginRoot, runtimeDir, writeStatus, lockPath, alive } from './runtime.mjs'

const endpoint = process.env.CODEX_SPEED_HUD_CDP ?? 'http://127.0.0.1:9222'
loopbackURL(endpoint, ['http:'])
await mkdir(runtimeDir, { recursive: true, mode: 0o700 })
try { const pid = Number(await readFile(lockPath, 'utf8')); if (alive(pid)) process.exit(0); await unlink(lockPath) } catch { /* No existing runner. */ }
let lock
try { lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(String(process.pid)) } catch { process.exit(0) }
await writeStatus({ pid: process.pid, pluginRoot, endpoint, phase: 'initializing', states: [] })
const bundle = await readFile(path.join(pluginRoot, 'dist/hud.js'), 'utf8')
const settings = new RequestSettings(path.join(runtimeDir, 'request-settings.json'))
await settings.load()
const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')
const logs = new LocalLogReader(codexHome, { settings: (threadId, turnId) => settings.get(threadId, turnId) })
const telemetry = new NativeTelemetryReader(path.join(codexHome, 'logs_2.sqlite'))
const observer = new ObserverReader(path.join(runtimeDir, 'native-metrics'))
const prices = createPricingSync({ cachePath: path.join(runtimeDir, 'openai-pricing.json') })
await prices.initialize()
// Refresh in the background so a slow pricing source cannot stall stream monitoring.
void prices.refresh()
const connections = new Map()
const scriptIds = new Map()
let stopped = false
let wake
const sleep = () => new Promise(resolve => { wake = resolve; const timer = setTimeout(resolve, 1000); wake = () => { clearTimeout(timer); resolve() } })

const onStop = () => { stopped = true; wake?.() }
process.on('SIGTERM', onStop); process.on('SIGINT', onStop)
try {
  while (!stopped) {
    void prices.refresh()
    await telemetry.poll()
    await observer.poll()
    const states = []
    let phase = 'waiting_cdp'
    let error = null
    try {
      const targets = (await listTargets(endpoint)).filter(target => target.type === 'page' && target.webSocketDebuggerUrl && (
        /^app:\/\//.test(target.url ?? '')
        || /^(?:codex|chatgpt):\/\//.test(target.url ?? '')
        || (process.env.CODEX_SPEED_HUD_TEST_TARGET === '1' && target.url?.startsWith('http://127.0.0.1:'))
      ))
      phase = targets.length ? 'connected' : 'waiting_renderer'
      const active = new Set(targets.map(target => target.id))
      for (const [id, connection] of connections) if (!active.has(id)) { connection.client.close(); connections.delete(id) }
      for (const target of targets) {
        try {
          let connection = connections.get(target.id)
          if (!connection) {
            const client = new CDPClient(target.webSocketDebuggerUrl)
            connection = { client, scriptId: null }
            connections.set(target.id, connection)
            client.on('disconnect', () => { if (connections.get(target.id) === connection) connections.delete(target.id) })
            const compatible = await client.evaluate('typeof window.electronBridge?.sendMessageFromView === "function"')
            if (!compatible && process.env.CODEX_SPEED_HUD_TEST_TARGET !== '1') { client.close(); connections.delete(target.id); continue }
            await client.call('Page.enable')
            for (const identifier of scriptIds.get(target.id) ?? []) {
              await client.call('Page.removeScriptToEvaluateOnNewDocument', { identifier })
            }
            scriptIds.delete(target.id)
            const script = await client.call('Page.addScriptToEvaluateOnNewDocument', { source: bundle })
            connection.scriptId = script.identifier
            scriptIds.set(target.id, new Set([script.identifier]))
            await client.evaluate(bundle)
          }
          let state = await connection.client.evaluate('window.__codexSpeedHUD?.snapshot() ?? null')
          if (!state) { await connection.client.evaluate(bundle); state = await connection.client.evaluate('window.__codexSpeedHUD?.snapshot() ?? null') }
          if (state?.threadId && state.hostId === 'local') {
            await settings.capture(state.threadId, state.turnId, state.requestSettings)
            const native = await logs.read(state.threadId, state.turnId)
            Object.assign(native, telemetry.read(state.threadId, native))
            const observed = observer.read(state.threadId, state.turnId)
            if (observed) native.nativeStream = observed
            await connection.client.evaluate(`window.__codexSpeedHUD?.applyNative(${JSON.stringify({ ...native, threadId: state.threadId, turnId: state.turnId, hostId: state.hostId })})`)
            state = await connection.client.evaluate('window.__codexSpeedHUD?.snapshot() ?? null')
          }
          if (state) states.push(state)
        } catch (cause) {
          phase = 'degraded'; error = cause.message
          const connection = connections.get(target.id)
          if (connection?.scriptId) {
            try { await connection.client.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: connection.scriptId }); scriptIds.delete(target.id) } catch { /* Retry cleanup after reconnect. */ }
          }
          connection?.client.close(); connections.delete(target.id)
        }
      }
      if (phase === 'connected' && !states.length) phase = 'waiting_renderer'
    } catch (cause) {
      error = cause.message
      // A vanished endpoint invalidates old connections; reconnect on the next poll.
      for (const connection of connections.values()) connection.client.close()
      connections.clear()
    }
    const { catalog, ...pricing } = prices.snapshot()
    await writeStatus({ pid: process.pid, pluginRoot, endpoint, phase, error, pricing, telemetry: telemetry.status(), observer: observer.status(), states })
    await sleep()
  }
} finally {
  telemetry.close()
  for (const { client, scriptId } of connections.values()) {
    try {
      if (scriptId) await client.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId })
      await client.evaluate('window.__codexSpeedHUD?.destroy()')
    } catch { /* Renderer may already have exited. */ }
    client.close()
  }
  await lock.close()
  try { if (Number(await readFile(lockPath, 'utf8')) === process.pid) await unlink(lockPath) } catch { /* Already removed. */ }
  await writeStatus({ pid: process.pid, pluginRoot, endpoint, phase: 'stopped', states: [] })
}
