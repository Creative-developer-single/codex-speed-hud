import { describe, expect, it } from 'vitest'
import { HostMessageDecoder, notificationFrom } from '../src/protocol.mjs'

describe('installed host protocol adapter', () => {
  it('accepts direct and wrapped notifications, ignores unrelated app messages', () => {
    const notification = { method: 'item/agentMessage/delta', params: { threadId: 't', turnId: 'u', itemId: 'i', delta: 'hello' } }
    expect(notificationFrom({ type: 'mcp-notification', hostId: 'remote:test', ...notification }).hostId).toBe('remote:test')
    expect(notificationFrom({ hostId: 'remote:test', message: { notification } }).method).toBe(notification.method)
    expect(notificationFrom({ method: 'account/read', params: {} })).toBeNull()
    expect(notificationFrom({ method: 'turn/started' })).toBeNull()
  })
  it('decodes chunked strings split inside JSON keys and delta text without ACKs', () => {
    const decoder = new HostMessageDecoder()
    const message = (sequence, kind, tokens) => ({ marker: 'codex-host-chunked-message-v1', transferId: 'x', sequence, kind, tokens })
    decoder.accept(message(0, 'start'))
    decoder.accept(message(1, 'chunk', [
      { type: 'object-start' }, { type: 'key', value: 'method' }, { type: 'value', value: 'item/agentMessage/delta' },
      { type: 'key', value: 'params' }, { type: 'object-start' },
      { type: 'string-start', target: 'key' }, { type: 'string-chunk', value: 'del' },
    ]))
    decoder.accept(message(2, 'chunk', [
      { type: 'string-chunk', value: 'ta' }, { type: 'string-end' },
      { type: 'string-start', target: 'value' }, { type: 'string-chunk', value: '你好' },
    ]))
    decoder.accept(message(3, 'chunk', [{ type: 'string-chunk', value: ' world' }, { type: 'string-end' }, { type: 'container-end' }, { type: 'container-end' }]))
    expect(decoder.accept(message(4, 'end'))).toEqual({ method: 'item/agentMessage/delta', params: { delta: '你好 world' } })
    expect(decoder.transfers.size).toBe(0)
  })
  it('rejects gaps, expires incomplete transfers, and does not pollute prototypes', () => {
    const decoder = new HostMessageDecoder()
    const m = (id, sequence, kind, tokens) => ({ marker: 'codex-host-chunked-message-v1', transferId: id, sequence, kind, tokens })
    decoder.accept(m('gap', 0, 'start'), 0)
    decoder.accept(m('gap', 2, 'chunk', []), 1)
    expect(decoder.dropped).toBe(1)
    decoder.accept(m('late', 0, 'start'), 1)
    decoder.accept({}, 30_002)
    expect(decoder.dropped).toBe(2)
    decoder.accept(m('safe', 0, 'start'))
    decoder.accept(m('safe', 1, 'chunk', [{ type: 'object-start' }, { type: 'key', value: '__proto__' }, { type: 'value', value: 'safe' }, { type: 'container-end' }]))
    expect(Object.getPrototypeOf(decoder.accept(m('safe', 2, 'end')))).toBe(Object.prototype)
  })
})
