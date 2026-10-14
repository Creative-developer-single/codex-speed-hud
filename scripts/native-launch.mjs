import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runtimeDir } from './runtime.mjs'

export async function hashFile(filename) {
  const hash = createHash('sha256')
  for await (const part of createReadStream(filename)) hash.update(part)
  return hash.digest('hex')
}

export async function nativeEnvironment({ directory = runtimeDir, environment = process.env, hash = hashFile } = {}) {
  const env = { ...environment }
  try {
    const manifest = JSON.parse(await readFile(path.join(directory, 'native-client/enabled.json'), 'utf8'))
    if (manifest.enabled !== true || manifest.schema !== 1 || manifest.revision !== '740e5af33c71225640e0c1c1555c514c2c93ab74'
      || !path.isAbsolute(manifest.binary) || !path.isAbsolute(manifest.originalBinary) || manifest.validated !== true) return env
    // An App update or changed binary automatically falls back to the packaged client.
    const previousOwned = env.CODEX_CLI_PATH === manifest.previousBinary && path.isAbsolute(manifest.previousBinary ?? '')
      && path.dirname(manifest.previousBinary) === path.dirname(manifest.binary)
      && await hash(manifest.previousBinary) === manifest.previousSha256
    if (!previousOwned && env.CODEX_CLI_PATH?.trim() && env.CODEX_CLI_PATH !== manifest.binary && env.CODEX_CLI_PATH !== manifest.originalBinary) return env
    if (env.CODEX_CLI_PATH === manifest.binary || previousOwned) {
      delete env.CODEX_CLI_PATH
      delete env.CODEX_SPEED_HUD_NATIVE_DIR
    }
    if (await hash(manifest.originalBinary) !== manifest.originalSha256 || await hash(manifest.binary) !== manifest.sha256) return env
    env.CODEX_CLI_PATH = manifest.binary
    env.CODEX_SPEED_HUD_NATIVE_DIR = path.join(directory, 'native-metrics')
    return env
  } catch { return env }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [application, ...args] = process.argv.slice(2)
  if (!application) throw new Error('Usage: native-launch.mjs application [arguments...]')
  const child = spawn(application, args, { env: await nativeEnvironment(), stdio: 'inherit' })
  child.once('error', () => { process.exitCode = 1 })
  child.once('exit', code => { process.exitCode = code ?? 1 })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal))
}
