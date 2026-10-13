import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { applyPriceModels, PRICE_CARD } from './pricing.mjs'

export const PRICING_URL = 'https://developers.openai.com/api/docs/pricing.md'
const REFRESH_MS = 24 * 60 * 60_000
const MAX_BYTES = 2 * 1024 * 1024
const HEADERS = ['Model', 'Short context input', 'Short context cached input', 'Short context cache writes', 'Short context output', 'Long context input', 'Long context cached input', 'Long context cache writes', 'Long context output']
const validId = (id) => typeof id === 'string' && /^[a-z][a-z0-9.-]{0,99}$/.test(id)
const validRate = (value) => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100_000)
const validRates = (rates) => Array.isArray(rates) && rates.length === 4 && rates.every(validRate)

function cells(line) { return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()) }

function parseRate(cell) {
  if (cell === '-' || cell === '—') return null
  if (!/^\$\d+(?:\.\d+)?$/.test(cell)) throw new Error(`无法识别官方价格单元格：${cell}`)
  const value = Number(cell.slice(1))
  if (!validRate(value)) throw new Error('官方价格超出支持范围')
  return value
}

function displayName(id) {
  return id.replace(/^gpt-/, 'GPT-').replace(/-(astra|sol|luna|terra|codex|mini|nano|pro)(?=-|$)/g, (_, word) => ` ${word[0].toUpperCase()}${word.slice(1)}`)
}

export function validatePriceModels(models) {
  if (!Array.isArray(models) || models.length < 3 || models.length > 1000) throw new Error('价格表模型数量无效')
  const seen = new Set()
  for (const model of models) {
    if (!model || !validId(model.id) || seen.has(model.id) || typeof model.name !== 'string' || model.name.length > 100
      || !Number.isInteger(model.contextThreshold) || model.contextThreshold <= 0 || model.contextThreshold > 10_000_000 || !validRates(model.short) || !validRates(model.long)
      || model.short[0] === null || model.short[3] === null
      || (model.fast !== null && (!validRates(model.fast?.short) || !validRates(model.fast?.long)))
      || ['ultrafast', 'batch', 'flex'].some(tier => model[tier] != null && (!validRates(model[tier].short) || !validRates(model[tier].long)))
      || (model.fastMultiplier !== undefined && (!Number.isFinite(model.fastMultiplier) || model.fastMultiplier <= 0 || model.fastMultiplier > 100))) {
      throw new Error('价格表结构校验失败')
    }
    seen.add(model.id)
  }
  return models
}

export function parseOfficialPricing(markdown) {
  if (typeof markdown !== 'string' || Buffer.byteLength(markdown) > MAX_BYTES) throw new Error('官方价格表内容无效或过大')
  const threshold = markdown.match(/Short context:\s*≤(\d+)K input tokens\.\s*Long context:\s*>(\d+)K input tokens\./)
  if (!threshold || threshold[1] !== threshold[2]) {
    throw new Error('无法确认官方长上下文阈值；保留原价格')
  }
  const tiers = Object.fromEntries(['standard', 'fast', 'ultrafast', 'batch', 'flex'].map(t => [t, new Map()]))
  let tier = null
  let inTable = false
  for (const line of markdown.split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(line)) {
      tier = line.match(/^### (Standard|Fast(?: mode)?|Ultrafast|Batch|Flex) pricing data\s*$/)?.[1].toLowerCase().replace(' mode', '') ?? null
      inTable = false
      continue
    }
    if (!tier || !line.trim().startsWith('|')) { inTable = false; continue }
    const row = cells(line)
    if (row[0] === 'Model') {
      inTable = row.length === HEADERS.length && row.every((value, index) => value === HEADERS[index])
      if (!inTable) throw new Error('官方价格表列结构已改变；保留原价格')
      continue
    }
    if (!inTable || /^:?-+:?$/.test(row[0])) continue
    const id = row[0].replace(/\s*\([^)]*\)$/, '').replace(/`/g, '')
    if (!validId(id) || row.length !== 9) throw new Error('官方价格表模型行无法识别')
    if (tiers[tier].has(id)) throw new Error('官方价格表出现重复模型')
    tiers[tier].set(id, { short: row.slice(1, 5).map(parseRate), long: row.slice(5, 9).map(parseRate) })
  }
  if (!tiers.fast.size) throw new Error('未能读取官方 Fast 价格表；保留原价格')
  const models = [...tiers.standard].map(([id, rates]) => {
    // An all-dash long tier means this model has no context surcharge.
    const long = rates.long.every((rate) => rate === null) ? [...rates.short] : rates.long
    const fast = tiers.fast.get(id)
    let fastMultiplier
    if (fast) {
      const ratios = rates.short.flatMap((rate, index) => rate > 0 && fast.short[index] !== null ? [fast.short[index] / rate] : [])
      if (ratios.length && ratios.every((ratio) => Math.abs(ratio - ratios[0]) < 1e-8)
        && rates.short.every((rate, index) => (rate === null) === (fast.short[index] === null))) fastMultiplier = ratios[0]
    }
    const additional = Object.fromEntries(['ultrafast', 'batch', 'flex'].flatMap(t => {
      const v = tiers[t].get(id)
      return v ? [[t, { short: v.short, long: rates.long.every(r => r === null) && v.long.every(r => r === null) ? [...v.short] : v.long }]] : []
    }))
    return { id, name: displayName(id), short: rates.short, long, contextThreshold: Number(threshold[1]) * 1000, ...additional,
      fast: fast ? { short: fast.short, long: rates.long.every((rate) => rate === null) && fast.long.every((rate) => rate === null) ? [...fast.short] : fast.long } : null,
      ...(fastMultiplier === undefined ? {} : { fastMultiplier }) }
  })
  return validatePriceModels(models)
}

async function fetchMarkdown(fetcher) {
  const response = await fetcher(PRICING_URL, { signal: AbortSignal.timeout(20_000), redirect: 'error', headers: { accept: 'text/markdown, text/plain' } })
  if (!response.ok) throw new Error(`官方价格源返回 HTTP ${response.status}`)
  let size = 0
  const chunks = []
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > MAX_BYTES) throw new Error('官方价格表超过大小限制')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function createPricingSync({
  cachePath = process.env.CODEX_SPEED_HUD_PRICING_CACHE ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'codex-speed-hud', 'openai-pricing.json'),
  fetcher = globalThis.fetch,
  apply = applyPriceModels,
  now = () => new Date(),
} = {}) {
  let updatedAt = null
  let checkedAt = null
  let error = null
  let origin = 'bundled'
  let pending = null
  let ready = null
  let lastAttempt = 0

  function snapshot() {
    return { version: PRICE_CARD.version, currency: PRICE_CARD.currency, source: PRICE_CARD.source,
      origin, updatedAt, checkedAt, error, updating: pending !== null, autoRefreshHours: 24,
      catalog: PRICE_CARD.models.map(({ id, name, short, long, fast, fastMultiplier, priceSource }) => ({ id, name, short, long, fast, fastMultiplier, priceSource: priceSource ?? 'bundled' })) }
  }

  async function initialize() {
    if (ready) return ready
    ready = (async () => {
      try {
        const raw = await readFile(cachePath, 'utf8')
        if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('价格缓存过大')
        const cache = JSON.parse(raw)
        const time = Date.parse(cache.updatedAt)
        if (cache.schemaVersion !== 1 || cache.source !== PRICING_URL || typeof cache.updatedAt !== 'string' || !Number.isFinite(time) || time > now().getTime() + 60_000) throw new Error('价格缓存元数据无效')
        const models = validatePriceModels(cache.models)
        apply(models, cache.updatedAt)
        updatedAt = cache.updatedAt
        origin = 'cache'
      } catch (reason) {
        if (reason.code !== 'ENOENT') error = `本地价格缓存不可用：${reason.message}`
      }
    })()
    return ready
  }

  async function refresh(force = false) {
    await initialize()
    if (pending) return pending
    if (!force && (now().getTime() - Date.parse(updatedAt ?? '') < REFRESH_MS || now().getTime() - lastAttempt < REFRESH_MS)) return snapshot()
    lastAttempt = now().getTime()
    checkedAt = now().toISOString()
    pending = (async () => {
      try {
        const models = parseOfficialPricing(await fetchMarkdown(fetcher))
        const time = now().toISOString()
        await mkdir(path.dirname(cachePath), { recursive: true })
        const temporary = `${cachePath}.${process.pid}.tmp`
        await writeFile(temporary, JSON.stringify({ schemaVersion: 1, source: PRICING_URL, updatedAt: time, models }), { mode: 0o600 })
        await rename(temporary, cachePath)
        apply(models, time)
        updatedAt = time
        origin = 'online'
        error = null
      } catch (reason) {
        error = `价格更新失败，继续使用${origin === 'bundled' ? '内置价格' : '上次成功价格'}：${reason.message}`
      } finally { pending = null }
      return snapshot()
    })()
    return pending
  }

  return { initialize, refresh, snapshot }
}
