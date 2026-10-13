import { expect, it } from 'vitest'
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ObserverReader, sanitizeObserver } from '../scripts/observer-reader.mjs'
import { nativeEnvironment } from '../scripts/native-launch.mjs'

const sample = (id, threadId = 'thread', turnId = 'turn') => ({ schema: 1, source: 'native-observer', id, threadId, turnId,
  model: 'gpt-test', kind: 'response', status: 'completed', startedAt: Date.now() - 1000, completedAt: Date.now(), durationMs: 1000,
  firstStreamMs: 50, outputTokens: 100, totalAverageTPS: 100, toolTPS: 40, toolLastAt: Date.now(), toolHeld: true, toolTokens: 30, toolStreamMs: 600 })

it('uses explicit chat and turn IDs, rejects foreign schema/text, and averages only this user turn', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hud-observer-'))
  try {
    const rows = [sample('1-123-1'), { ...sample('1-123-2'), kind: 'compaction', durationMs: 2000, outputTokens: 200 }, sample('1-123-3', 'background'), sample('1-123-4', 'thread', 'history')]
    for (const row of rows) await writeFile(path.join(dir, row.id + '.json'), JSON.stringify({ ...row, prompt: 'SECRET', delta: 'PRIVATE' }))
    await symlink(path.join(dir, '1-123-1.json'), path.join(dir, '1-123-5.json'))
    const r = new ObserverReader(dir); await r.poll()
    expect(r.samples.size).toBe(4)
    expect(r.read('thread', 'turn')).toMatchObject({ turnAverageTPS: 100, turnCompletedRequests: 2 })
    expect(r.read('thread', 'unknown')).toBeNull()
    expect(JSON.stringify([...r.samples.values()])).not.toMatch(/SECRET|PRIVATE|prompt|delta/)
    expect(sanitizeObserver({ ...rows[0], limited: true }).toolTPS).toBeNull()
    expect(sanitizeObserver({ ...rows[0], threadId: null })).toBeNull()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('falls back after upgrade/hash mismatch and respects another custom client, without altering network env', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hud-native-launch-'))
  const env = { HTTPS_PROXY: 'existing', TEST: 'value' }
  try {
    await mkdir(path.join(dir, 'native-client'))
    const manifest = { enabled: true, validated: true, schema: 1, revision: '740e5af33c71225640e0c1c1555c514c2c93ab74',
      binary: '/custom/codex', originalBinary: '/app/codex', sha256: 'patched', originalSha256: 'original' }
    await writeFile(path.join(dir, 'native-client/enabled.json'), JSON.stringify(manifest))
    const hash = async p => p === '/app/codex' ? 'original' : 'patched'
    expect(await nativeEnvironment({ directory: dir, environment: env, hash })).toEqual({ ...env, CODEX_CLI_PATH: manifest.binary, CODEX_SPEED_HUD_NATIVE_DIR: path.join(dir, 'native-metrics') })
    expect((await nativeEnvironment({ directory: dir, environment: { ...env, CODEX_CLI_PATH: manifest.originalBinary }, hash })).CODEX_CLI_PATH).toBe(manifest.binary)
    expect(await nativeEnvironment({ directory: dir, environment: env, hash: async () => 'changed' })).toEqual(env)
    const custom = { ...env, CODEX_CLI_PATH: '/other/codex' }
    expect(await nativeEnvironment({ directory: dir, environment: custom, hash })).toEqual(custom)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('finds a new producer after reboot even when many older samples have larger process IDs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hud-observer-reboot-'))
  try {
    for (let i = 1; i <= 513; i++) {
      const row = sample(`900000-1-${i}`, 'old-thread', 'old-turn')
      await writeFile(path.join(dir, row.id + '.json'), JSON.stringify(row))
    }
    const fresh = sample('1-2-1')
    await writeFile(path.join(dir, fresh.id + '.json'), JSON.stringify(fresh))
    const reader = new ObserverReader(dir); await reader.poll()
    expect(reader.read('thread', 'turn')).toMatchObject({ id: '1-2-1', turnCompletedRequests: 1 })
  } finally { await rm(dir, { recursive: true, force: true }) }
})
