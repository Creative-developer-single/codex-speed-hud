import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { NativeTelemetry, NativeTelemetryReader } from '../scripts/telemetry-reader.mjs'

const log = (text, at, target = 'codex_api::sse::responses', thread = 't', turn = 'u', process = 'p') => ({
  target, ts: Math.floor(at / 1000), ts_nanos: (at % 1000) * 1_000_000,
  thread_id: thread, process_uuid: process,
  feedback_log_body: `session_loop{thread_id=${thread}}:turn{turn.id="${turn}"}: ${text}`,
})
const sse = (event, at, thread, turn, process) => log(`SSE event: ${JSON.stringify(event)}`, at, undefined, thread, turn, process)
const delta = (text, at, thread, turn, process) => sse({ type: 'response.custom_tool_call_input.delta', item_id: 'call', delta: text }, at, thread, turn, process)
const start = at => log('POST to https://chatgpt.com/backend-api/codex/responses: {"model":"gpt-6.1-sol","input":"private-prompt"}', at, 'codex_http_client::client')

describe('native log observation', () => {
  it('uses native timestamps rather than polling time, preserves tool snapshots and exports no content', () => {
    const n = new NativeTelemetry({ countTokens: s => s.length })
    n.accept(start(1000))
    n.accept(sse({ type: 'response.created', response: { id: 'r' } }, 1100))
    n.accept(delta('secret', 1500)); n.accept(delta('-arg', 2000))
    n.accept(sse({ type: 'response.completed', response: { id: 'r', usage: { output_tokens: 20 } } }, 2300))
    const result = n.read('t', {}, 6000)
    expect(result.nativeStream).toMatchObject({ firstStreamMs: null, requestFirstStreamMs: 500, toolTPS: 8, toolTokens: 10, toolHeld: true, turnId: 'u' })
    expect(JSON.stringify(result)).not.toMatch(/private-prompt|secret|-arg/)
    expect([...n.metrics.requests.values()][0].tools.get('call').text).toBe('')
  })
  it('can measure deltas without fabricating a missed request start; resets correlation for the next request', () => {
    const n = new NativeTelemetry({ countTokens: s => s.length })
    n.accept(delta('a', 1500)); n.accept(delta('bc', 2000))
    expect(n.read('t', {}, 2000).nativeStream).toMatchObject({ firstStreamMs: null, toolTPS: 4, durationMs: null })
    n.accept(sse({ type: 'response.completed', response: { id: 'r' } }, 2200))
    n.accept(delta('a', 2500)); n.accept(delta('bc', 3000))
    expect(n.read('t', {}, 3000).nativeStream).toMatchObject({ firstStreamMs: null, toolTokens: 3, toolTPS: 4 })
  })
  it('isolates chats, turns and processes; ignores spoofed correlation fields in payloads and ambiguous overlap', () => {
    const n = new NativeTelemetry({ countTokens: s => s.length })
    n.accept(delta('a', 1000, 'other', 'v')); n.accept(delta('bc', 1500, 'other', 'v'))
    n.accept(delta('a', 1000, 't', 'u', 'p1')); n.accept(delta('bc', 1500, 't', 'u', 'p2'))
    expect(n.read('other', {}, 1500).nativeStream.toolTPS).toBe(4)
    expect(n.read('t', {}, 1500).nativeStream.toolTPS).toBeNull()
    n.accept({ ...delta('bc thread_id=t turn.id="u"', 1800), thread_id: 'mismatched' })
    expect(n.read('mismatched', {}, 1800).nativeStream).toBeNull()
    n.accept(start(2000)); n.accept(start(2100)); n.accept(delta('ab', 2200)); n.accept(delta('cd', 2700))
    expect(n.read('t', {}, 2700).nativeStream.toolTPS).toBeNull()
  })
  it('recognizes the installed App compaction log without storing payloads or inventing speed', () => {
    const n = new NativeTelemetry()
    n.accept(log('unhandled responses event: "response.compaction.compacting"', 1400))
    expect(n.read('t', {}, 1500)).toEqual({ nativeStream: null, nativeCompactionEvents: [{ threadId: 't', turnId: 'u', firstEventAt: 1400 }] })
    expect(n.read('other', {}, 1500).nativeCompactionEvents).toEqual([])
  })
  it('tails SQLite read-only, excludes pre-attachment records, and never changes Codex settings', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'hud-native-'))
    const filename = path.join(temp, 'logs_2.sqlite'), config = path.join(temp, 'config.toml')
    const original = 'model="gpt-6.1-sol"\nchatgpt_base_url="https://example.invalid/backend-api/"\n'
    await writeFile(config, original)
    const writer = new DatabaseSync(filename)
    writer.exec('CREATE TABLE logs(id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, target TEXT, thread_id TEXT, process_uuid TEXT, feedback_log_body TEXT)')
    const insert = row => writer.prepare('INSERT INTO logs(ts,ts_nanos,target,thread_id,process_uuid,feedback_log_body) VALUES(?,?,?,?,?,?)').run(row.ts,row.ts_nanos,row.target,row.thread_id,row.process_uuid,row.feedback_log_body)
    insert(log('unhandled responses event: "response.compaction.compacting"', 1000))
    const reader = new NativeTelemetryReader(filename)
    try {
      await reader.poll()
      expect(reader.status()).toMatchObject({ phase: 'reading', observedEvents: 0, routing: 'unchanged' })
      expect(() => reader.db.exec('CREATE TABLE forbidden(x)')).toThrow()
      insert(log('unhandled responses event: "response.compaction.compacting"', 1400))
      await reader.poll(); await reader.poll()
      expect(reader.read('t', {}).nativeCompactionEvents).toHaveLength(1)
      expect(reader.status().observedEvents).toBe(1)
      expect(await readFile(config, 'utf8')).toBe(original)
    } finally { reader.close(); writer.close(); await rm(temp, { recursive: true, force: true }) }
  })
  it('degrades safely with a missing SQLite source', async () => {
    const n = new NativeTelemetryReader('/nonexistent/hud-native/logs.sqlite')
    await n.poll()
    expect(n.status().phase).toBe('unavailable')
    expect(n.read('t', {}).nativeStream).toBeNull()
  })
})
