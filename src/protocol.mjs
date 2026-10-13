import { normalizeThreadId } from './context.mjs'

const METHODS = new Set([
  'thread/started', 'turn/started', 'turn/completed', 'item/started', 'item/completed',
  'item/agentMessage/delta', 'item/reasoning/summaryPartAdded', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta',
  'thread/tokenUsage/updated', 'model/rerouted', 'error', 'rawResponseItem/completed',
])

/** Only known notifications are examined; tool arguments and prompts are not retained. */
export function notificationFrom(value, depth = 0, inheritedHost = null) {
  if (!value || typeof value !== 'object' || depth > 3) return null
  if (['mcp-response', 'mcp-request-delivery', 'fetch-response'].includes(value.type)) return null
  const hostId = value.hostId ?? inheritedHost ?? 'local'
  if (METHODS.has(value.method) && value.params && typeof value.params === 'object') {
    let params = value.params
    const threadId = normalizeThreadId(params.threadId ?? params.thread?.id, hostId)
    if (threadId) params = { ...params, threadId }
    if (value.method === 'rawResponseItem/completed') {
      const item = params.item
      if (!['reasoning', 'function_call', 'custom_tool_call', 'mcp_call', 'compaction'].includes(item?.type)
        && !(item?.type === 'message' && item.role === 'assistant')) return null
      // Only the fact of a model event is needed. Never retain raw arguments or ciphertext.
      params = { threadId, turnId: params.turnId, item: { type: item.type, role: item.role } }
    }
    return { method: value.method, params, hostId }
  }
  for (const key of ['notification', 'message', 'data']) {
    const found = notificationFrom(value[key], depth + 1, hostId)
    if (found) return { ...found, hostId: value.hostId ?? found.hostId }
  }
  return null
}

/** Passive decoder for the installed Electron preload's chunk protocol. Never sends ACKs. */
export class HostMessageDecoder {
  transfers = new Map()
  dropped = 0

  accept(value, now = Date.now()) {
    for (const [id, state] of this.transfers) {
      if (now - state.at > 30_000) { this.transfers.delete(id); this.dropped++ }
    }
    if (value?.marker !== 'codex-host-chunked-message-v1') return value
    const id = value.transferId
    if (typeof id !== 'string' || !Number.isSafeInteger(value.sequence)) return null
    if (value.kind === 'start') {
      if (this.transfers.size >= 16) { this.transfers.clear(); this.dropped++ }
      this.transfers.set(id, { sequence: value.sequence, stack: [], root: undefined, text: null, bytes: 0, at: now })
      return null
    }
    const state = this.transfers.get(id)
    if (!state) return null
    if (value.sequence <= state.sequence) return null
    if (value.sequence !== state.sequence + 1) { this.transfers.delete(id); this.dropped++; return null }
    state.sequence = value.sequence
    state.at = now
    try {
      if (value.kind === 'end') {
        this.transfers.delete(id)
        if (state.stack.length || state.text) throw new Error('Incomplete transfer')
        return state.root
      }
      if (value.kind !== 'chunk' || !Array.isArray(value.tokens)) throw new Error('Invalid chunk')
      for (const token of value.tokens) {
        state.bytes += typeof token.value === 'string' ? token.value.length * 2 : 16
        if (state.bytes > 8_000_000) throw new Error('Transfer too large')
        const top = () => state.stack.at(-1)
        const put = (child) => {
          const frame = top()
          if (!frame) state.root = child
          else if (Array.isArray(frame.value)) frame.value.push(child)
          else {
            if (frame.key === undefined) throw new Error('Missing key')
            Object.defineProperty(frame.value, frame.key, { value: child, enumerable: true, writable: true, configurable: true })
            frame.key = undefined
          }
        }
        switch (token.type) {
          case 'object-start':
          case 'array-start': {
            if (state.stack.length > 64) throw new Error('Transfer too deep')
            const child = token.type === 'object-start' ? {} : []
            put(child); state.stack.push({ value: child }); break
          }
          case 'container-end': if (!state.stack.pop()) throw new Error('Unbalanced transfer'); break
          case 'key': if (!top() || Array.isArray(top().value)) throw new Error('Invalid key'); top().key = token.value; break
          case 'value': put(token.value ?? null); break
          case 'string-start': state.text = { target: token.target, value: '' }; break
          case 'string-chunk': if (!state.text) throw new Error('Missing string'); state.text.value += token.value; break
          case 'string-end':
            if (!state.text) throw new Error('Missing string')
            if (state.text.target === 'key') { if (!top()) throw new Error('Missing object'); top().key = state.text.value }
            else put(state.text.value)
            state.text = null; break
          default: throw new Error('Unknown token')
        }
      }
    } catch { this.transfers.delete(id); this.dropped++ }
    return null
  }
}
