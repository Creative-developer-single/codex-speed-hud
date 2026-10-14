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

it('keeps generation trigger timing across retries, rejecting legacy or inconsistent first-flow samples', () => {
  const a = { ...sample('1-1-1'), startedAt: 1300, generationId: 'g1', firstFlowBasis: 'generation-trigger', generationStartedAt: 1000, firstEventAt: 1500, firstStreamMs: 500 }
  const b = { ...a, id: '1-2-1', startedAt: 2100, firstEventAt: 2200, firstStreamMs: 1200 }
  const r = new ObserverReader('/unused', { now: () => 3000 })
  r.samples.set(a.id, sanitizeObserver(a)); r.samples.set(b.id, sanitizeObserver(b))
  expect(r.read('thread', 'turn')).toMatchObject({ id: b.id, firstStreamMs: 500, firstEventAt: 1500, generationStartedAt: 1000 })
  expect(sanitizeObserver(sample('1-3-1')).firstStreamMs).toBeNull()
  expect(sanitizeObserver({ ...a, firstStreamMs: 200 }).firstStreamMs).toBeNull()
  const c = { ...b, id: '1-3-1', startedAt: 2600, generationId: 'g2', generationStartedAt: 2500, firstEventAt: 2700, firstStreamMs: 200 }
  r.samples.set(c.id, sanitizeObserver(c))
  expect(r.read('thread', 'turn')).toMatchObject({ generationId: 'g2', firstStreamMs: 200 })
  expect(r.read('background', 'turn')).toBeNull()
})

it('upgrades only a hash-verified previous owned client path and preserves unrelated overrides', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hud-previous-client-'))
  try {
    await mkdir(path.join(dir, 'native-client'))
    const manifest = { enabled: true, validated: true, schema: 1, revision: '740e5af33c71225640e0c1c1555c514c2c93ab74', binary: '/owned/codex-new', originalBinary: '/app/codex', sha256: 'new', originalSha256: 'original', previousBinary: '/owned/codex', previousSha256: 'old' }
    await writeFile(path.join(dir, 'native-client/enabled.json'), JSON.stringify(manifest))
    const hash = async p => ({ '/app/codex': 'original', '/owned/codex-new': 'new', '/owned/codex': 'old' })[p]
    const env = { CODEX_CLI_PATH: '/owned/codex', HTTPS_PROXY: 'existing' }
    expect((await nativeEnvironment({ directory: dir, environment: env, hash })).CODEX_CLI_PATH).toBe('/owned/codex-new')
    expect(await nativeEnvironment({ directory: dir, environment: env, hash: async p => p === '/owned/codex' ? 'foreign' : hash(p) })).toEqual(env)
    const other = { ...env, CODEX_CLI_PATH: '/unrelated/client' }
    expect(await nativeEnvironment({ directory: dir, environment: other, hash })).toEqual(other)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
