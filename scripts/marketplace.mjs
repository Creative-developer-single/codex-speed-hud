import { readFile } from 'node:fs/promises'
import path from 'node:path'

// Migrate an older checkout only when this local marketplace contains this HUD alone.
export async function registerMarketplace(cli, directory, run) {
  const invoke = args => run(cli, ['plugin', 'marketplace', ...args], { timeout: 30_000 })
  try { return await invoke(['add', directory, '--json']) } catch (error) {
    if (!error.stderr?.includes("marketplace 'agent-cost-monitor-local' is already added from a different source")) throw error
    const listing = JSON.parse((await invoke(['list', '--json'])).stdout)
    const old = listing.marketplaces?.find(m => m.name === 'agent-cost-monitor-local')
    if (old?.marketplaceSource?.sourceType !== 'local') throw error
    const catalog = JSON.parse(await readFile(path.join(old.root, '.agents/plugins/marketplace.json'), 'utf8'))
    if (catalog.name !== 'agent-cost-monitor-local' || catalog.plugins?.length !== 1 || catalog.plugins[0].name !== 'codex-speed-hud') throw error
    await invoke(['remove', 'agent-cost-monitor-local', '--json'])
    try { return await invoke(['add', directory, '--json']) } catch (replacementError) {
      await invoke(['add', old.marketplaceSource.source, '--json'])
      throw replacementError
    }
  }
}
