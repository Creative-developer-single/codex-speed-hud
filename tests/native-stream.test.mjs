import { describe, expect, it } from 'vitest'
import { NativeStreamMetrics } from '../scripts/native-stream-metrics.mjs'
import { SpeedMetrics } from '../src/metrics.mjs'
import { NativeAccumulator } from '../scripts/log-reader.mjs'
const message = (item, delta) => ({ type: 'response.function_call_arguments.delta', item_id: item, delta })

describe('native stream measurements', () => {
  it('correlates compression first flow with an observed start and preserves missing measurements', () => {
    let clock = 0
    const m = new SpeedMetrics({ countTokens: s => s.length, now: () => clock })
    const emit = (method, item) => m.accept({ hostId: 'local', method, params: { threadId: 't', turnId: 'u', item } }, clock)
    emit('turn/started'); emit('item/started', { id: 'c', type: 'contextCompaction' })
    const epoch = m.snapshot('t').compaction.startedEpoch
    m.applyNative({ threadId: 't', nativeCompactionEvents: [{ turnId: 'other', firstEventAt: epoch + 100 }, { turnId: 'u', firstEventAt: epoch - 1 }] })
    expect(m.snapshot('t').compaction.firstStreamMs).toBeUndefined()
    m.applyNative({ threadId: 't', nativeCompactionEvents: [{ turnId: 'u', firstEventAt: epoch + 400 }, { turnId: 'u', firstEventAt: epoch + 200 }] })
    expect(m.snapshot('t').compaction.firstStreamMs).toBe(200)
    clock = 1000; emit('item/completed', { id: 'c', type: 'contextCompaction' })
    m.applyNative({ threadId: 't', nativeCompactionEvents: [] })
    expect(m.snapshot('t').compaction.firstStreamMs).toBe(200)
    expect(m.snapshot('t').compaction.totalAverageTPS).toBeNull()
    const restored = new SpeedMetrics({ countTokens: s => s.length })
    restored.applyNative({ threadId: 't', previousCompaction: { responseId: 'r', turnId: 'u', completedAt: epoch + 1000, outputTokens: 100 }, nativeCompactionEvents: [{ turnId: 'u', firstEventAt: epoch + 200 }] })
    expect(restored.snapshot('t').compaction.firstStreamMs).toBeUndefined()
  })
  it('excludes acknowledgements from first flow, handles parallel tools, and retains final snapshots without text', () => {
    const m = new NativeStreamMetrics({ countTokens: s => s.length, now: () => 1000 })
    const id = m.begin({ model: 'gpt-6.1-sol', threadId: 't', turnId: 'u' }, 'response', 1000)
    m.event(id, { type: 'response.created', response: { id: 'r1' } }, 1100)
    expect(m.snapshot()[0].firstStreamMs).toBeNull()
    m.event(id, { type: 'response.output_item.added', item: { type: 'reasoning' } }, 1200)
    m.event(id, message('a', 'ab'), 1300); m.event(id, message('a', 'cdef'), 1800)
    m.event(id, { type: 'response.custom_tool_call_input.delta', item_id: 'b', delta: 'x' }, 1800)
    m.event(id, { type: 'response.custom_tool_call_input.delta', item_id: 'b', delta: 'yz' }, 2300)
    expect(m.snapshot(2300)[0]).toMatchObject({ model: 'gpt-6.1-sol', firstStreamMs: 200, toolAverageTPS: 9, toolTokens: 9, toolTPS: 4 })
    m.event(id, { type: 'response.completed', response: { usage: { output_tokens: 20 } } }, 2400)
    expect(m.snapshot(5000)[0]).toMatchObject({ toolHeld: true, toolTPS: 4, outputTokens: 20, firstStreamMs: 200 })
    expect([...m.requests.values()][0].tools.get('a').text).toBe('')
    expect(JSON.stringify(m.snapshot())).not.toContain('cdef')
  })
  it('keeps opaque compaction un-tokenized and distinguishes full-duration throughput from generation rate', () => {
    const m = new NativeStreamMetrics({ countTokens: () => { throw new Error('Must not tokenize ciphertext') } })
    const id = m.begin({}, 'compaction', 1000)
    m.event(id, { type: 'response.completed', response: { output: [{ type: 'compaction', encrypted_content: 'secret-ciphertext' }], usage: { output_tokens: 1000 } } }, 11000)
    expect(m.snapshot()[0]).toMatchObject({ firstStreamMs: null, toolTPS: null, totalAverageTPS: 100, kind: 'compaction' })
    expect(JSON.stringify(m.snapshot())).not.toContain('ciphertext')
  })
  it('measures compaction lifecycle separately and associates final native usage, without fabricating historical duration', () => {
    let clock = 0
    const m = new SpeedMetrics({ countTokens: s => s.length, now: () => clock })
    const emit = (method, item) => m.accept({ hostId: 'local', method, params: { threadId: 't', turnId: 'u', item } }, clock)
    emit('turn/started'); emit('item/started', { id: 'c', type: 'contextCompaction' })
    clock = 1000
    expect(m.snapshot('t')).toMatchObject({ status: 'compacting', firstTokenMs: null, compaction: { elapsedMs: 1000 } })
    clock = 10000; emit('item/completed', { id: 'c', type: 'contextCompaction' })
    m.applyNative({ threadId: 't', previousCompaction: { responseId: 'r', turnId: 'u', completedAt: Date.now(), outputTokens: 1000 } })
    expect(m.snapshot('t').compaction).toMatchObject({ totalAverageTPS: 100, elapsedMs: 10000 })
    expect(m.snapshot('t').firstTokenMs).toBeNull()
    const restored = new SpeedMetrics({ countTokens: s => s.length })
    restored.applyNative({ threadId: 't', previousCompaction: { responseId: 'r', turnId: 'u', completedAt: Date.now(), outputTokens: 1000 } })
    expect(restored.snapshot('t').compaction.totalAverageTPS).toBeNull()
    const a = new NativeAccumulator()
    a.accept({ type: 'compacted', timestamp: new Date().toISOString(), payload: { compaction_response_id: 'r', latest_token_usage_record: { turn_id: 'u', usage: { output_tokens: 1000 } }, replacement_history: [{ encrypted_content: 'private' }] } })
    expect(a.previousCompaction.outputTokens).toBe(1000)
    expect(JSON.stringify(a.previousCompaction)).not.toContain('private')
  })
})
