import bundled from './prices.json' with { type: 'json' }

export const PRICE_CARD = { version: bundled.updatedAt, currency: 'USD', source: bundled.source, models: bundled.models }
let revision = 0
export const pricingRevision = () => revision
export function applyPriceModels(models, updatedAt) {
  const ids = new Set(models.map(m => m.id))
  PRICE_CARD.models = [...models, ...bundled.models.filter(m => !ids.has(m.id))]
  PRICE_CARD.version = updatedAt.slice(0, 10)
  revision++
}
export function resolvePrice(model) {
  return PRICE_CARD.models.find(m => m.id === model)
    ?? PRICE_CARD.models.find(m => model?.startsWith(`${m.id}-`) && /^\d{4}-\d{2}-\d{2}$/.test(model.slice(m.id.length + 1)))
}

// User-specified rule, independent of the official table's general 272K threshold.
export function solContextThreshold() {
  const n = Number(process.env.CODEX_SPEED_HUD_SOL_CONTEXT_THRESHOLD ?? 500_000)
  return Number.isInteger(n) && n > 0 ? n : 500_000
}
const count = (usage, snake, camel) => Number(usage[snake] ?? usage[camel] ?? 0)
export function estimateUsage(usage, model, serviceTier = null) {
  const price = resolvePrice(model)
  const input = count(usage, 'input_tokens', 'inputTokens')
  const cached = count(usage, 'cached_input_tokens', 'cachedInputTokens')
  const write = count(usage, 'cache_write_input_tokens', 'cacheWriteInputTokens')
  const output = count(usage, 'output_tokens', 'outputTokens')
  if (!price || (usage.input_tokens ?? usage.inputTokens) == null || (usage.output_tokens ?? usage.outputTokens) == null
    || ![input, cached, write, output].every(n => Number.isFinite(n) && n >= 0) || cached + write > input) return null
  const threshold = price.id === 'gpt-6.1-sol' ? solContextThreshold() : price.contextThreshold
  const tier = serviceTier === 'priority' ? 'fast' : serviceTier === 'default' || serviceTier === 'auto' ? 'standard' : serviceTier ?? 'standard'
  if (!['standard', 'fast', 'ultrafast', 'batch', 'flex'].includes(tier)) return null
  const context = input > threshold ? 'long' : 'short'
  const rates = tier === 'standard' ? price[context] : price[tier]?.[context]
  if (!rates) return null
  const counts = [input - cached - write, cached, write, output]
  if (counts.some((n, i) => n > 0 && rates[i] === null)) return null
  return { usd: counts.reduce((sum, n, i) => sum + n * (rates[i] ?? 0), 0) / 1e6, tierAssumed: serviceTier == null }
}
