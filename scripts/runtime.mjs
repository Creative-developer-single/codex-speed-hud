import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'

export const pluginRoot = fileURLToPath(new URL('../', import.meta.url))
export const runtimeDir = process.env.CODEX_SPEED_HUD_DATA ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'codex-speed-hud')
export const statusPath = path.join(runtimeDir, 'status.json')
export const lockPath = path.join(runtimeDir, 'runner.lock')
export async function readStatus() { try { return JSON.parse(await readFile(statusPath, 'utf8')) } catch { return null } }
export async function writeStatus(value) {
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 })
  const temporary = `${statusPath}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify({ ...value, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
  await rename(temporary, statusPath)
}
export function alive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true } catch { return false } }
