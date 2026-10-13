import { afterEach, describe, expect, it } from 'vitest'
import { estimateUsage } from '../scripts/pricing.mjs'
import { parseOfficialPricing, createPricingSync } from '../scripts/pricing-sync.mjs'
import { NativeAccumulator } from '../scripts/log-reader.mjs'
import { RequestSettings } from '../scripts/request-settings.mjs'
import { formatCumulative } from '../src/usage.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const dirs = []
afterEach(async () => { delete process.env.CODEX_SPEED_HUD_SOL_CONTEXT_THRESHOLD; await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))) })
const usage = (input, cached = 0, output = 0, write = 0) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, cache_write_input_tokens: write, total_tokens: input + output })
const context = (a, turn, model, extra = {}) => a.accept({ type: 'turn_context', payload: { turn_id: turn, model, ...extra } })
const raw = (a, id, u, extra = {}) => a.accept({ type: 'token_usage_record', payload: { response_id: id, usage: u, ...extra } })

describe('official-model cost estimates', () => {
  it('applies the specified 500K threshold to each Sol request, including cached input', () => {
    expect(estimateUsage(usage(500_000, 400_000, 1000), 'gpt-6.1-sol').usd).toBeCloseTo(.25)
    expect(estimateUsage(usage(500_001, 400_000, 1000), 'gpt-6.1-sol').usd).toBeCloseTo(.495004)
    expect(estimateUsage(usage(300_000), 'gpt-6-sol').usd).toBe(1.2)
    process.env.CODEX_SPEED_HUD_SOL_CONTEXT_THRESHOLD = '272000'
    expect(estimateUsage(usage(300_000), 'gpt-6.1-sol').usd).toBe(1.2)
  })
  it('subtracts cached and cache-written input and counts reasoning in output once', () => {
    const u = { ...usage(1000, 700, 100, 100), reasoning_output_tokens: 80 }
    expect(estimateUsage(u, 'gpt-6.1-sol', 'standard').usd).toBeCloseTo(.00172)
    expect(estimateUsage(u, 'gpt-6.1-sol', 'priority').usd).toBeCloseTo(.00344)
    expect(estimateUsage(u, 'gpt-6.1-sol', 'ultrafast').usd).toBeCloseTo(.01032)
    expect(estimateUsage(u, 'gpt-6.1-sol-2026-10-03').usd).toBeCloseTo(.00172)
    expect(estimateUsage(u, 'gpt-6.1-sol-preview')).toBeNull()
    expect(estimateUsage({ output_tokens: 100 }, 'gpt-6.1-sol')).toBeNull()
  })
  it('prices mixed models, deduplicates raw responses, and never tiers cumulative session input', () => {
    const a = new NativeAccumulator()
    context(a, 'u', 'gpt-6.1-sol', { service_tier: 'fast' })
    raw(a, '1', usage(300_000)); raw(a, '1', usage(300_000)); raw(a, '2', usage(300_000))
    a.accept({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(600_000), last_token_usage: usage(300_000) } } })
    context(a, 'v', 'gpt-6-luna')
    raw(a, '3', usage(100_000, 50_000, 1000))
    expect(a.sessionCost()).toMatchObject({ requests: 3, assumedTier: 1, unpriced: 0 })
    expect(a.sessionCost().usd).toBeCloseTo(2.406)
    context(a, 'w', 'gpt-unknown'); raw(a, '4', usage(100))
    expect(a.sessionCost()).toMatchObject({ usd: null, unpriced: 1 })
    expect(a.sessionCost().subtotalUsd).toBeCloseTo(2.406)
  })
  it('uses per-request legacy usage, avoids duplicate counters, and marks incomplete history unknown', () => {
    const a = new NativeAccumulator()
    context(a, 'u', 'gpt-6.1-sol')
    const token = (total, last) => a.accept({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(total), last_token_usage: usage(last) } } })
    token(300_000, 300_000); token(600_000, 300_000); token(600_000, 300_000)
    expect(a.sessionCost()).toMatchObject({ usd: 1.2, requests: 2 })
    const incomplete = new NativeAccumulator(); context(incomplete, 'u', 'gpt-6.1-sol')
    incomplete.accept({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(600_000), last_token_usage: usage(300_000) } } })
    expect(incomplete.sessionCost().usd).toBeNull()
  })
  it('persists captured Fast mode and uses it on replay, without following later selector edits', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'speed-price-')); dirs.push(dir)
    const store = new RequestSettings(path.join(dir, 'settings.json'))
    await store.capture('t', 'u', { fastMode: true }); await store.capture('t', 'u', { fastMode: false })
    const restored = new RequestSettings(store.filename); await restored.load()
    const a = new NativeAccumulator({ settings: id => restored.get('t', id) })
    context(a, 'u', 'gpt-6.1-sol'); raw(a, '1', usage(100_000))
    expect(a.sessionCost()).toMatchObject({ usd: .4, assumedTier: 0 })
  })
  it('formats compact token totals and keeps unpriced requests distinct from free use', () => {
    expect(formatCumulative(27_250_000, { usd: 12.34 })).toBe('27.25M/12.34$')
    expect(formatCumulative(1_250_000_000, { usd: 0 })).toBe('1.25B/0.00$')
    expect(formatCumulative(1234, { usd: .001 })).toBe('1.23K/<0.01$')
    expect(formatCumulative(1234, { usd: null })).toBe('1.23K/—$')
  })
})

const headers = '| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |'
const fixture = ['Standard', 'Fast', 'Ultrafast'].flatMap((tier, i) => [`### ${tier} pricing data`, headers, '| --- | --- | --- | --- | --- | --- | --- | --- | --- |', ...['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra'].map(id => `| ${id} | $${2 * (i + 1)} | $0.1 | $2.5 | $10 | $4 | $0.2 | $5 | $15 |`)]).join('\n') + '\nShort context: ≤272K input tokens. Long context: >272K input tokens.'
describe('pricing synchronization', () => {
  it('reads official tiers and rejects changed table shapes', () => {
    expect(parseOfficialPricing(fixture)[0]).toMatchObject({ id: 'gpt-6.1-sol', contextThreshold: 272_000, fast: { short: [4, .1, 2.5, 10] }, ultrafast: { short: [6, .1, 2.5, 10] } })
    expect(() => parseOfficialPricing(fixture.replace('Short context cached input', 'Changed'))).toThrow()
  })
  it('keeps the last successful prices after fetch failure and restores them offline', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'speed-sync-')); dirs.push(dir)
    let fails = false, applied = null
    const options = { cachePath: path.join(dir, 'prices.json'), apply: m => { applied = m }, fetcher: async () => { if (fails) throw new Error('offline'); return new Response(fixture) } }
    const sync = createPricingSync(options)
    expect((await sync.refresh(true)).origin).toBe('online')
    const previous = applied; fails = true
    expect((await sync.refresh(true)).error).toContain('上次成功价格')
    expect(applied).toBe(previous)
    const offline = createPricingSync(options); await offline.initialize()
    expect(offline.snapshot().origin).toBe('cache')
    expect(applied[0].ultrafast).toBeDefined()
  })
})
