import { randomUUID } from 'node:crypto'
import { Tiktoken } from 'js-tiktoken/lite'
import ranks from 'js-tiktoken/ranks/o200k_base'

const encoder = new Tiktoken(ranks)
const uuid = /^[a-zA-Z0-9_.-]{1,160}$/
const safeId = v => typeof v === 'string' && uuid.test(v) ? v : null

/** Raw bodies are transient. Public snapshots contain numeric metadata only. */
export class NativeStreamMetrics {
  constructor({ countTokens = text => encoder.encode(text, [], []).length, now = () => Date.now() } = {}) {
    this.countTokens = countTokens; this.now = now; this.requests = new Map()
  }
  begin(metadata = {}, kind = 'response', at = null) {
    const id = randomUUID()
    const request = { id, responseId: null, threadId: safeId(metadata.threadId), turnId: safeId(metadata.turnId),
      kind, startedAt: at, lastEventAt: at, firstStreamMs: null, completedAt: null, model: safeId(metadata.model), tools: new Map(), outputTokens: null, status: 'waiting' }
    this.requests.set(id, request)
    while (this.requests.size > 128) {
      const key = [...this.requests].find(([, r]) => r.completedAt !== null)?.[0] ?? this.requests.keys().next().value
      this.requests.delete(key)
    }
    return id
  }
  event(id, event, at = this.now()) {
    const r = this.requests.get(id)
    if (!r || r.completedAt !== null || !event || typeof event.type !== 'string') return
    r.lastEventAt = at
    const type = event.type
    r.responseId ??= safeId(event.response?.id ?? event.response_id)
    // response.created / in_progress are acknowledgements, not model output.
    const outputEvent = type.endsWith('.delta') || type === 'response.reasoning_summary_part.added'
      || (type === 'response.output_item.added' && ['message', 'reasoning', 'function_call', 'custom_tool_call', 'compaction'].includes(event.item?.type))
    if (outputEvent && r.firstStreamMs === null && r.startedAt !== null) r.firstStreamMs = Math.max(0, at - r.startedAt)
    if (['response.function_call_arguments.delta', 'response.custom_tool_call_input.delta', 'response.mcp_call_arguments.delta'].includes(type) && typeof event.delta === 'string') {
      const key = safeId(event.item_id ?? event.call_id) ?? (Number.isInteger(event.output_index) ? String(event.output_index) : null)
      if (key === null || r.tools.size >= 64 && !r.tools.has(key)) return
      let tool = r.tools.get(key)
      if (!tool) { tool = { text: '', tokens: 0, firstAt: at, lastAt: at, streamMs: 0, samples: [], lastTPS: null, limited: false }; r.tools.set(key, tool) }
      if (tool.limited) return
      const elapsed = at - tool.lastAt
      if (elapsed >= 0 && elapsed < 1500) tool.streamMs += elapsed
      tool.lastAt = at
      tool.text += event.delta
      if (tool.text.length > 256_000) { tool.text = ''; tool.limited = true; return }
      tool.tokens = this.countTokens(tool.text)
      tool.samples.push({ at, tokens: tool.tokens })
      while (tool.samples.length > 2 && tool.samples[1].at < at - 2000) tool.samples.shift()
      const first = tool.samples[0]
      if (at - first.at >= 250) tool.lastTPS = Math.max(0, (tool.tokens - first.tokens) * 1000 / (at - first.at))
      r.status = 'streaming'
    }
    if (['response.completed', 'response.failed', 'response.incomplete'].includes(type)) {
      const output = event.response?.usage?.output_tokens
      if (Number.isFinite(output) && output >= 0) r.outputTokens = output
      this.complete(id, at, type === 'response.completed' ? 'completed' : 'failed')
    }
  }
  complete(id, at = this.now(), status = 'completed') {
    const r = this.requests.get(id); if (!r || r.completedAt !== null) return
    r.completedAt = at; r.status = status
    for (const tool of r.tools.values()) { tool.text = ''; tool.samples = [] }
  }
  snapshot(at = this.now()) {
    return [...this.requests.values()].map(r => {
      const tools = [...r.tools.values()], newest = tools.sort((a, b) => b.lastAt - a.lastAt)[0]
      const tokens = tools.filter(t => !t.limited && t.streamMs > 0).reduce((sum, t) => sum + t.tokens, 0)
      const streamMs = tools.reduce((sum, t) => sum + t.streamMs, 0)
      const durationMs = r.startedAt === null ? null : (r.completedAt ?? at) - r.startedAt
      return { id: r.id, responseId: r.responseId, threadId: r.threadId, turnId: r.turnId, kind: r.kind, model: r.model,
        startedAt: r.startedAt, completedAt: r.completedAt, status: r.status, firstStreamMs: null, requestFirstStreamMs: r.firstStreamMs, firstFlowBasis: 'unknown',
        toolTPS: newest?.lastTPS ?? null, toolLastAt: newest?.lastAt ?? null, toolHeld: r.completedAt !== null || !newest || at - newest.lastAt >= 1500,
        toolTokens: tools.reduce((sum, t) => sum + t.tokens, 0), toolStreamMs: streamMs,
        toolAverageTPS: streamMs >= 250 && !tools.some(t => t.limited) ? tokens * 1000 / streamMs : null,
        durationMs, outputTokens: r.outputTokens, totalAverageTPS: r.completedAt !== null && durationMs > 0 && r.outputTokens !== null ? r.outputTokens * 1000 / durationMs : null,
        limited: tools.some(t => t.limited) }
    })
  }
}

