import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { LocalLogReader, NativeAccumulator } from '../scripts/log-reader.mjs'

const usage = (output, reasoning) => ({ output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: output + 100 })
const event = (type, payload = {}) => ({ type: 'event_msg', payload: { type, ...payload } })
const temporary = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

describe('native completion metadata', () => {
  it('uses per-turn totals and prefers raw records over duplicate legacy counters', () => {
    const a = new NativeAccumulator()
    a.accept(event('token_count', { info: { total_token_usage: usage(500, 400) } }))
    a.accept({ type: 'turn_context', payload: { turn_id: 'u', model: 'gpt-test' } })
    a.accept(event('task_started', { turn_id: 'u' }))
    a.accept({ type: 'token_usage_record', payload: { turn_id: 'u', response_id: 'r1', usage: usage(10, 8) } })
    a.accept({ type: 'token_usage_record', payload: { turn_id: 'u', response_id: 'r1', usage: usage(10, 8) } })
    a.accept(event('token_count', { info: { total_token_usage: usage(510, 408) } }))
    a.accept(event('token_count', { info: { total_token_usage: usage(510, 408) } }))
    a.accept(event('task_complete', { turn_id: 'u', time_to_first_token_ms: 345, last_agent_message: 'private content' }))
    expect(a.snapshot('u')).toEqual({ turnId: 'u', model: 'gpt-test', reasoningEffort: null, fastMode: null, nativeTTFT: 345, usage: { output_tokens: 10, reasoning_output_tokens: 8, total_tokens: 110 } })
    expect(a.sessionUsage().total_tokens).toBe(110)
    expect(JSON.stringify(a.snapshot('u'))).not.toContain('private')
    expect(a.snapshot('missing')).toBeNull()
  })
  it('restores completed model and effort records without guessing absent speed modes', () => {
    const a = new NativeAccumulator()
    a.accept({ type: 'turn_context', payload: { turn_id: 'u', model: 'gpt-6.1-sol', effort: 'high' } })
    a.accept(event('task_complete', { turn_id: 'u' }))
    expect(a.previousResponse).toEqual({ turnId: 'u', model: 'gpt-6.1-sol', reasoningEffort: 'high', fastMode: null })
    a.accept({ type: 'turn_context', payload: { turn_id: 'v', model: 'gpt-6-luna', effort: 'medium', service_tier: 'priority' } })
    expect(a.previousResponse.turnId).toBe('u')
    a.accept(event('task_complete', { turn_id: 'v' }))
    expect(a.previousResponse).toMatchObject({ turnId: 'v', fastMode: true })
  })
  it('accumulates full history past the former tail limit without counting cached or reasoning twice', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'speed-hud-test-')); temporary.push(root)
    const directory = path.join(root, 'sessions'); await mkdir(directory)
    const threadId = '01900000-0000-7000-8000-000000000002'
    const file = path.join(directory, `rollout-${threadId}.jsonl`)
    const raw = (turn, response, input, cached, output) => ({ type: 'token_usage_record', payload: { turn_id: turn, response_id: response, usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output } } })
    const rows = [
      { type: 'session_meta', payload: { id: threadId } },
      raw('old', 'r1', 1000, 800, 100), raw('old', 'r1', 1000, 800, 100),
      ...Array.from({ length: 25 }, () => ({ type: 'response_item', payload: { text: 'synthetic'.repeat(12000) } })),
      raw('new', 'r2', 2000, 1800, 200),
    ]
    await writeFile(file, rows.map(x => JSON.stringify(x)).join('\n') + '\n')
    const reader = new LocalLogReader(root)
    const result = await reader.read(threadId, 'new')
    expect(result.sessionUsage).toMatchObject({ input_tokens: 3000, cached_input_tokens: 2600, output_tokens: 300, total_tokens: 3300 })
    expect((await reader.read(threadId, 'new')).sessionUsage.total_tokens).toBe(3300)
    await appendFile(file, JSON.stringify(raw('next', 'r3', 500, 400, 50)) + '\n')
    expect((await reader.read(threadId, 'next')).sessionUsage.total_tokens).toBe(3850)
  })
  it('accumulates legacy cumulative usage across counter resets', () => {
    const a = new NativeAccumulator()
    for (const total of [1000, 1200, 1200, 100, 200]) {
      a.accept(event('token_count', { info: { total_token_usage: { total_tokens: total } } }))
    }
    expect(a.sessionUsage().total_tokens).toBe(1400)
  })
  it('reads appended partial UTF-8 lines and refuses a mismatched session header', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'speed-hud-test-')); temporary.push(root)
    const directory = path.join(root, 'sessions', '2026', '10', '10'); await mkdir(directory, { recursive: true })
    const threadId = '01900000-0000-7000-8000-000000000001'
    const file = path.join(directory, `rollout-${threadId}.jsonl`)
    const initial = [
      { type: 'session_meta', payload: { id: threadId, base_instructions: 'synthetic-private-instructions'.repeat(1000) } },
      { type: 'turn_context', payload: { turn_id: 'u', model: 'gpt-test' } },
      event('task_started', { turn_id: 'u' }),
    ].map(x => JSON.stringify(x)).join('\n') + '\n'
    await writeFile(file, initial)
    const reader = new LocalLogReader(root)
    expect((await reader.read(threadId, 'u')).nativeTTFT).toBeNull()
    const tail = Buffer.from(JSON.stringify(event('task_complete', { turn_id: 'u', time_to_first_token_ms: 42, last_agent_message: '你好' })) + '\n')
    const cut = tail.indexOf(Buffer.from('你')) + 1
    await appendFile(file, tail.subarray(0, cut))
    expect((await reader.read(threadId, 'u')).nativeTTFT).toBeNull()
    await appendFile(file, tail.subarray(cut))
    expect((await reader.read(threadId, 'u')).nativeTTFT).toBe(42)
    expect((await reader.read(threadId)).previousFirstToken).toEqual({ turnId: 'u', ms: 42 })
    const restored = new LocalLogReader(root, { settings: (thread, turn) => thread === threadId && turn === 'u' ? { fastMode: true } : null })
    expect((await restored.read(threadId, 'u')).previousResponse.fastMode).toBe(true)
    await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id: 'wrong' } }) + '\n')
    expect((await reader.read(threadId, 'u')).source).toBe('日志聊天 ID 不匹配')
  })
})
