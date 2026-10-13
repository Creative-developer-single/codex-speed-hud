import { open, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { estimateUsage, PRICE_CARD, pricingRevision, solContextThreshold } from './pricing.mjs'

const READ_LIMIT = 2_000_000
const USAGE_KEYS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']
const add = (target, usage) => {
  for (const key of USAGE_KEYS) {
    const n = Number(usage?.[key])
    if (Number.isFinite(n) && n >= 0) target[key] = (target[key] ?? 0) + n
  }
}

/** Contains numeric metadata only. Raw JSONL lines and reply bodies are discarded. */
export class NativeAccumulator {
  turns = new Map()
  currentTurnId = null
  model = null
  total = null
  seenResponses = new Set()
  sessionRaw = null
  sessionFallback = null
  previousFirstToken = null
  previousResponse = null
  previousCompaction = null
  rawCosts = []
  fallbackCosts = []
  costCache = null

  constructor({ settings = () => null } = {}) { this.settings = settings }
  costRecord(usage, model, turnId, serviceTier) {
    const numeric = {}; add(numeric, usage)
    return { usage: numeric, model, turnId, serviceTier }
  }

  get(id) {
    if (!this.turns.has(id)) {
      this.turns.set(id, { turnId: id, model: this.model, reasoningEffort: null, fastMode: null, nativeTTFT: null, raw: null, fallback: null })
      while (this.turns.size > 16) this.turns.delete(this.turns.keys().next().value)
    }
    return this.turns.get(id)
  }
  accept(record) {
    const p = record.payload ?? {}
    if (record.type === 'compacted') {
      const usage = p.latest_token_usage_record
      const outputTokens = usage?.usage?.output_tokens
      this.previousCompaction = { responseId: p.compaction_response_id ?? null, turnId: usage?.turn_id ?? null,
        outputTokens: Number.isFinite(outputTokens) && outputTokens >= 0 ? outputTokens : null, completedAt: Date.parse(record.timestamp) || null }
    }
    if (record.type === 'turn_context') {
      this.model = p.model ?? this.model
      if (p.turn_id) this.currentTurnId = p.turn_id
    }
    if (record.type === 'event_msg' && p.type === 'task_started') this.currentTurnId = p.turn_id ?? null
    const id = p.turn_id ?? this.currentTurnId
    if (record.type === 'turn_context' && id) {
      const turn = this.get(id)
      turn.model = this.model
      turn.reasoningEffort = p.effort ?? p.reasoning_effort ?? null
      turn.fastMode = typeof p.service_tier === 'string' ? ['fast', 'priority', 'ultrafast'].includes(p.service_tier) : null
      turn.serviceTier = p.service_tier ?? null
    }
    if (record.type === 'token_usage_record' && p.usage) {
      const responseId = p.response_id
      if (responseId && this.seenResponses.has(responseId)) return
      if (responseId) {
        this.seenResponses.add(responseId)
      }
      this.sessionRaw ??= {}; add(this.sessionRaw, p.usage)
      this.rawCosts.push(this.costRecord(p.usage, p.model ?? this.model, id, p.service_tier ?? this.turns.get(id)?.serviceTier))
      this.costCache = null
      if (id) {
        const turn = this.get(id)
        turn.raw ??= {}; add(turn.raw, p.usage)
        turn.model = p.model ?? this.model
      }
    }
    if (record.type === 'event_msg' && p.type === 'token_count' && p.info) {
      const total = p.info.total_token_usage
      let delta = null
      if (total && this.total) {
        const reset = total.total_tokens < this.total.total_tokens
        delta = Object.fromEntries(USAGE_KEYS.filter(key => Number.isFinite(total[key])).map(key => [key, Math.max(0, total[key] - (reset ? 0 : this.total[key] ?? 0))]))
      } else delta = p.info.last_token_usage ?? null
      // A cumulative difference is not a request prompt length. Price last_token_usage only;
      // incomplete legacy history stays unknown instead of inventing context tiers.
      if (total && (!this.total || USAGE_KEYS.some(key => total[key] !== this.total[key]))) {
        const last = p.info.last_token_usage
        const pricedUsage = this.total || (last?.total_tokens === total.total_tokens) ? last : null
        this.fallbackCosts.push(this.costRecord(pricedUsage, this.model, id, this.turns.get(id)?.serviceTier))
        this.costCache = null
      }
      if (total) { this.sessionFallback ??= {}; add(this.sessionFallback, this.total ? delta : total) }
      this.total = total ?? this.total
      if (id && delta) { const turn = this.get(id); turn.fallback ??= {}; add(turn.fallback, delta) }
    }
    if (record.type === 'event_msg' && p.type === 'task_complete' && p.turn_id) {
      const turn = this.get(p.turn_id)
      this.previousResponse = { turnId: p.turn_id, model: turn.model, reasoningEffort: turn.reasoningEffort, fastMode: turn.fastMode }
      const n = p.time_to_first_token_ms
      if (Number.isFinite(n) && n >= 0) {
        turn.nativeTTFT = n
        this.previousFirstToken = { turnId: p.turn_id, ms: n }
      }
    }
  }
  snapshot(id) {
    const turn = this.turns.get(id)
    if (!turn) return null
    return { turnId: id, model: turn.model, reasoningEffort: turn.reasoningEffort, fastMode: turn.fastMode, nativeTTFT: turn.nativeTTFT, usage: turn.raw ?? turn.fallback }
  }
  sessionUsage() { return this.sessionRaw ?? this.sessionFallback }
  sessionCost() {
    const records = this.sessionRaw ? this.rawCosts : this.fallbackCosts
    const signature = `${pricingRevision()}:${solContextThreshold()}:${records.length}:${records.map(r => this.settings(r.turnId)?.fastMode ?? '').join(',')}`
    if (this.costCache?.signature === signature) return this.costCache.value
    let subtotalUsd = 0, unpriced = 0, assumedTier = 0
    for (const record of records) {
      const fast = this.settings(record.turnId)?.fastMode
      const tier = record.serviceTier ?? (typeof fast === 'boolean' ? fast ? 'fast' : 'standard' : null)
      const cost = estimateUsage(record.usage, record.model, tier)
      if (!cost) { unpriced++; continue }
      subtotalUsd += cost.usd
      if (cost.tierAssumed) assumedTier++
    }
    const value = { usd: records.length && !unpriced ? subtotalUsd : null, subtotalUsd, requests: records.length, unpriced, assumedTier,
      priceDate: PRICE_CARD.version, source: PRICE_CARD.source, solThreshold: solContextThreshold() }
    this.costCache = { signature, value }
    return value
  }
}

export class LocalLogReader {
  constructor(codexHome, { settings = () => null } = {}) { this.codexHome = codexHome; this.settings = settings; this.paths = new Map(); this.files = new Map(); this.listedAt = 0 }
  async discover() {
    if (Date.now() - this.listedAt < 10_000) return
    const found = new Map()
    let scanned = 0
    async function walk(directory) {
      let entries
      try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
      // Newest date directories first; the monitor follows live sessions, not archives.
      entries.sort((a, b) => b.name.localeCompare(a.name))
      for (const entry of entries) {
        if (scanned >= 1200) return
        const filename = path.join(directory, entry.name)
        if (entry.isDirectory()) await walk(filename)
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          scanned++
          const id = entry.name.match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i)?.[1]
          if (id && !found.has(id)) found.set(id, filename)
        }
      }
    }
    await walk(path.join(this.codexHome, 'sessions'))
    this.paths = found; this.listedAt = Date.now()
  }
  async read(threadId, turnId) {
    await this.discover()
    const filename = this.paths.get(threadId)
    if (!filename) return { source: '未找到本机会话日志' }
    let details
    try { details = await stat(filename) } catch { return { source: '日志暂不可读' } }
    let cached = this.files.get(filename)
    if (!cached || details.size < cached.offset || cached.inode !== details.ino) {
      cached = { offset: 0, carry: Buffer.alloc(0), discardLine: false, accumulator: new NativeAccumulator({ settings: turnId => this.settings(threadId, turnId) }), inode: details.ino, verified: false }
      this.files.set(filename, cached)
      if (this.files.size > 8) this.files.delete(this.files.keys().next().value)
    }
    if (details.size !== cached.offset) {
      const file = await open(filename, 'r')
      try {
        if (!cached.verified) {
          // Session headers include base instructions and commonly exceed 8 KiB.
          const header = Buffer.alloc(Math.min(READ_LIMIT, details.size))
          const { bytesRead } = await file.read(header, 0, header.length, 0)
          let meta
          const newline = header.subarray(0, bytesRead).indexOf(10)
          try { meta = JSON.parse(header.subarray(0, newline < 0 ? bytesRead : newline).toString()) } catch { return { source: '无法验证日志归属' } }
          if (meta.type !== 'session_meta' || meta.payload?.id !== threadId) return { source: '日志聊天 ID 不匹配' }
          cached.verified = true
        }
        // Scan history from byte zero, in bounded chunks; never mistake a tail for a session total.
        const end = Math.min(details.size, cached.offset + 16_000_000)
        while (cached.offset < end) {
          const buffer = Buffer.alloc(Math.min(1_000_000, end - cached.offset))
          const { bytesRead } = await file.read(buffer, 0, buffer.length, cached.offset)
          if (!bytesRead) break
          cached.offset += bytesRead
          let chunk = buffer.subarray(0, bytesRead)
          if (cached.discardLine) {
            const newline = chunk.indexOf(10)
            if (newline < 0) continue
            chunk = chunk.subarray(newline + 1); cached.discardLine = false
          }
          const combined = Buffer.concat([cached.carry, chunk])
          const lastNewline = combined.lastIndexOf(10)
          if (lastNewline >= 0) {
            for (const line of combined.subarray(0, lastNewline).toString('utf8').split('\n')) {
              if (line.length > READ_LIMIT) continue
              try { cached.accumulator.accept(JSON.parse(line)) } catch { /* Partial or incompatible lines are ignored. */ }
            }
            cached.carry = combined.subarray(lastNewline + 1)
          } else cached.carry = combined
          if (cached.carry.length > READ_LIMIT) { cached.carry = Buffer.alloc(0); cached.discardLine = true }
        }
      } finally { await file.close() }
    }
    const complete = cached.offset >= details.size
    const snapshot = cached.accumulator.snapshot(turnId)
    if (snapshot && snapshot.fastMode === null) snapshot.fastMode = this.settings(threadId, turnId)?.fastMode ?? null
    const previous = cached.accumulator.previousResponse
    const previousResponse = previous ? { ...previous, fastMode: previous.fastMode ?? this.settings(threadId, previous.turnId)?.fastMode ?? null } : null
    return { source: complete ? 'connected' : '正在统计历史记录', ...snapshot, sessionUsage: complete ? cached.accumulator.sessionUsage() : null, sessionCost: complete ? cached.accumulator.sessionCost() : null, previousFirstToken: complete ? cached.accumulator.previousFirstToken : null, previousResponse: complete ? previousResponse : null, previousCompaction: complete ? cached.accumulator.previousCompaction : null, responseIds: complete ? [...cached.accumulator.seenResponses].slice(-256) : [] }
  }
}
