import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { registerMarketplace } from '../scripts/marketplace.mjs'

it.each([false, true])('migrates only the single-HUD local marketplace, restoring the source on failed add (failure=%s)', async fail => {
  const old = await mkdtemp(path.join(os.tmpdir(), 'hud-marketplace-'))
  try {
    await mkdir(path.join(old, '.agents/plugins'), { recursive: true })
    await writeFile(path.join(old, '.agents/plugins/marketplace.json'), JSON.stringify({ name: 'agent-cost-monitor-local', plugins: [{ name: 'codex-speed-hud' }] }))
    const calls = []
    const run = async (_, args) => {
      calls.push(args.slice(2))
      if (calls.length === 1) throw Object.assign(Error('collision'), { stderr: "marketplace 'agent-cost-monitor-local' is already added from a different source" })
      if (args[2] === 'list') return { stdout: JSON.stringify({ marketplaces: [{ name: 'agent-cost-monitor-local', root: old, marketplaceSource: { sourceType: 'local', source: old } }] }) }
      if (fail && calls.length === 4) throw Error('replacement failed')
      return { stdout: '{}' }
    }
    if (fail) await expect(registerMarketplace('codex', '/new', run)).rejects.toThrow('replacement failed')
    else await registerMarketplace('codex', '/new', run)
    expect(calls[2]).toEqual(['remove', 'agent-cost-monitor-local', '--json'])
    if (fail) expect(calls.at(-1)).toEqual(['add', old, '--json'])
    await writeFile(path.join(old, '.agents/plugins/marketplace.json'), JSON.stringify({ name: 'agent-cost-monitor-local', plugins: [{ name: 'other' }] }))
    calls.length = 0
    await expect(registerMarketplace('codex', '/new', run)).rejects.toThrow('collision')
    expect(calls.some(c => c[0] === 'remove')).toBe(false)
  } finally { await rm(old, { recursive: true, force: true }) }
})
