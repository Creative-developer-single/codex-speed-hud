import { NativeStreamMetrics } from './native-stream-metrics.mjs'

const id = v => typeof v === 'string' && /^[a-zA-Z0-9_.-]{1,160}$/.test(v) ? v : null
const field = (text, name) => id(text.match(new RegExp(`\\b${name}="?([a-zA-Z0-9_.-]+)`))?.[1])
const targets = new Set(['codex_api::sse::responses', 'codex_http_client::client'])

/** Accept existing native logs. Never attach to a socket or enable body logging. */
export class NativeTelemetry {
  constructor(options) {
    this.metrics = new NativeStreamMetrics(options)
    this.active = new Map()
    this.compactions = []
    this.events = 0
  }
  accept(row) {
    if (!targets.has(row.target) || typeof row.feedback_log_body !== 'string' || row.feedback_log_body.length > 1_000_000) return
    const at = Number(row.ts) * 1000 + Number(row.ts_nanos ?? 0) / 1_000_000
    if (!Number.isFinite(at) || at < 0) return
    const body = row.feedback_log_body
    const marker = body.search(/SSE event: |unhandled responses event: |\bPOST to /)
    if (marker < 0) return
    // Read correlation only from the span, never from prompts/tool text.
    const span = body.slice(0, marker)
    const spanThread = field(span, 'thread_id') ?? field(span, 'thread\\.id')
    const threadId = id(row.thread_id) ?? spanThread
    if (!threadId || spanThread && threadId !== spanThread) return
    const turnId = field(span, 'turn_id') ?? field(span, 'turn\\.id')
    if (!turnId) return
    const key = JSON.stringify([row.process_uuid ?? '', threadId, turnId])
    const text = body.slice(marker)
    if (row.target === 'codex_api::sse::responses' && text.startsWith('unhandled responses event: "response.compaction.compacting"')) {
      this.compactions.push({ threadId, turnId, firstEventAt: at })
      if (this.compactions.length > 128) this.compactions.shift()
      this.events++
      return
    }
    if (row.target === 'codex_http_client::client') {
      const request = text.match(/^POST to (https?:\/\/\S+?):\s*(\{.*\})\s*$/s)
      if (!request) return
      try {
        const pathname = new URL(request[1]).pathname
        if (!/\/(?:responses|compact)$/.test(pathname)) return
        // Inspect already-written records only. Never extract headers or persist bodies.
        const parsed = JSON.parse(request[2])
        const old = this.active.get(key)
        if (old && this.metrics.requests.get(old)?.completedAt === null) {
          // Concurrent requests lack unique IDs here; skip ambiguous attribution.
          this.metrics.complete(old, at, 'interrupted')
          this.active.set(key, null)
          return
        }
        this.active.set(key, this.metrics.begin({ threadId, turnId, model: id(parsed.model) }, pathname.endsWith('/compact') ? 'compaction' : 'response', at))
        while (this.active.size > 128) this.active.delete(this.active.keys().next().value)
      } catch { /* Unsupported or truncated native format. */ }
      return
    }
    if (!text.startsWith('SSE event: ')) return
    let event
    try { event = JSON.parse(text.slice(11)) } catch { return }
    if (!event || typeof event.type !== 'string') return
    let requestId = this.active.get(key)
    if (this.active.has(key) && requestId === null) return
    const old = requestId && this.metrics.requests.get(requestId)
    const responseId = id(event.response?.id ?? event.response_id)
    if ((old && old.completedAt !== null) || (old?.responseId && responseId && old.responseId !== responseId)) {
      requestId = null // Missing next start must not inherit the previous timestamp.
    }
    if (!requestId) {
      requestId = this.metrics.begin({ threadId, turnId }, 'response', null)
      this.active.set(key, requestId)
    }
    this.metrics.event(requestId, event, at)
    this.events++
    while (this.active.size > 128) this.active.delete(this.active.keys().next().value)
  }
  read(threadId, native, now = Date.now()) {
    for (const r of this.metrics.requests.values()) {
      if (r.completedAt === null && now - (r.lastEventAt ?? r.startedAt ?? now) > 60_000) this.metrics.complete(r.id, now, 'interrupted')
    }
    const streams = this.metrics.snapshot(now).filter(r => r.threadId === threadId && (r.toolTokens > 0 || r.kind === 'compaction'))
      .map(r => ({ ...r, kind: r.responseId === native.previousCompaction?.responseId ? 'compaction' : r.kind }))
      .sort((a, b) => (b.toolLastAt ?? b.completedAt ?? b.startedAt ?? 0) - (a.toolLastAt ?? a.completedAt ?? a.startedAt ?? 0))
    return { nativeStream: streams[0] ?? null, nativeCompactionEvents: this.compactions.filter(c => c.threadId === threadId) }
  }
}

/** Read-only bounded SQLite tail. Failures cannot affect model connections. */
export class NativeTelemetryReader {
  constructor(filename, options) {
    this.filename = filename
    this.telemetry = new NativeTelemetry(options)
    this.db = null
    this.cursor = 0
    this.phase = 'waiting_logs'
    this.nextOpen = 0
  }
  async poll() {
    try {
      if (!this.db) {
        if (Date.now() < this.nextOpen) return
        const { DatabaseSync } = await import('node:sqlite')
        this.db = new DatabaseSync(this.filename, { readOnly: true })
        this.db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=50')
        // Attach at the tail: historical completions cannot reconstruct first flow.
        this.cursor = this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM logs').get().id
      }
      const ids = this.db.prepare('SELECT id FROM logs WHERE id > ? ORDER BY id LIMIT 4096').all(this.cursor)
      if (ids.length) {
        const end = ids.at(-1).id
        const rows = this.db.prepare(`SELECT id,ts,ts_nanos,target,thread_id,process_uuid,feedback_log_body FROM logs WHERE id > ? AND id <= ? AND target IN ('codex_api::sse::responses','codex_http_client::client') AND length(feedback_log_body) <= 1000000 ORDER BY id`).all(this.cursor, end)
        for (const row of rows) this.telemetry.accept(row)
        this.cursor = end
      }
      this.phase = 'reading'
    } catch {
      this.close()
      this.phase = 'unavailable'
      this.nextOpen = Date.now() + 30_000
    }
  }
  read(threadId, native) { return this.telemetry.read(threadId, native) }
  status() { return { phase: this.phase, cursor: this.cursor, observedEvents: this.telemetry.events, source: 'native-logs-readonly', routing: 'unchanged' } }
  close() { try { this.db?.close() } catch { /* Already closed. */ } this.db = null }
}
