import { readdir, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'

const safeId = v => typeof v === 'string' && /^[\w.-]{1,160}$/.test(v) ? v : null
const number = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
const numeric = ['startedAt', 'completedAt', 'durationMs', 'firstStreamMs', 'toolTPS', 'toolLastAt', 'toolTokens', 'toolStreamMs', 'toolAverageTPS', 'outputTokens', 'totalAverageTPS']

// Only accept the native worker's bounded, numeric schema. Do not consume arbitrary payloads.
export function sanitizeObserver(value) {
  if (value?.schema !== 1 || value.source !== 'native-observer' || !safeId(value.id) || !safeId(value.threadId) || !safeId(value.turnId)
    || !['response', 'compaction'].includes(value.kind) || !['waiting', 'streaming', 'completed', 'failed', 'interrupted'].includes(value.status)) return null
  const result = { schema: 1, source: 'native-observer', id: value.id, threadId: value.threadId, turnId: value.turnId,
    model: safeId(value.model), responseId: safeId(value.responseId), kind: value.kind, status: value.status,
    limited: value.limited === true, toolHeld: value.toolHeld === true }
  for (const key of numeric) result[key] = number(value[key])
  if (result.startedAt === null || result.durationMs === null) return null
  if (result.limited) for (const key of ['toolTPS', 'toolAverageTPS', 'totalAverageTPS', 'firstStreamMs']) result[key] = null
  return result
}

export class ObserverReader {
  constructor(directory, { now = () => Date.now() } = {}) { this.directory = directory; this.now = now; this.samples = new Map(); this.phase = 'waiting_native_client' }
  async poll() {
    let files
    try { files = await readdir(this.directory) } catch { this.phase = 'waiting_native_client'; return }
    for (const name of files.filter(f => /^\d+-\d+-\d+\.json$/.test(f))
      .sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1])).slice(-512)) {
      let file
      try {
        file = await open(path.join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > 8192 || this.now() - stat.mtimeMs > 600_000) continue
        const value = sanitizeObserver(JSON.parse(await file.readFile('utf8')))
        if (!value || name !== `${value.id}.json`) continue
        this.samples.set(value.id, value)
      } catch { /* Partial file, unknown schema or absent producer: leave renderer measurements active. */ }
      finally { await file?.close().catch(() => {}) }
    }
    while (this.samples.size > 2048) this.samples.delete(this.samples.keys().next().value)
    this.phase = this.samples.size ? 'observed' : 'waiting_native_client'
  }
  read(threadId, turnId) {
    if (!threadId || !turnId) return null
    const samples = [...this.samples.values()].filter(v => v.threadId === threadId && v.turnId === turnId)
      .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id, 'en', { numeric: true }))
    const latest = samples.at(-1)
    if (!latest) return null
    const result = { ...latest, toolHeld: latest.toolHeld || latest.toolLastAt === null || this.now() - latest.toolLastAt >= 1500 }
    const completed = samples.filter(v => v.status === 'completed' && !v.limited && v.outputTokens !== null && v.durationMs > 0)
    const output = completed.reduce((n, v) => n + v.outputTokens, 0), duration = completed.reduce((n, v) => n + v.durationMs, 0)
    result.turnAverageTPS = duration > 0 ? output * 1000 / duration : null
    result.turnCompletedRequests = completed.length
    return result
  }
  status() {
    const lastSampleAt = Math.max(0, ...[...this.samples.values()].map(s => s.startedAt + s.durationMs)) || null
    return { phase: this.phase, samples: this.samples.size, lastSampleAt, recentlyObserved: lastSampleAt !== null && this.now() - lastSampleAt < 20_000,
      upstreamProxy: false, timingHeaderEnabled: false }
  }
}
