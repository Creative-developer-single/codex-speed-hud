import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { readActiveContext } from '../src/context.mjs'
import { notificationFrom } from '../src/protocol.mjs'
import { installHUD } from '../src/overlay.mjs'

function fixture(marker = false) {
  const d = new JSDOM(`<body><div data-app-action-sidebar-thread-active="true" data-app-action-sidebar-thread-host-id="durable" data-app-action-sidebar-thread-id="local:dot-chat"></div>${marker ? '<div data-codex-composer-root><div data-above-composer-conversation-id="local:dot-chat"></div></div>' : ''}</body>`, { url: 'http://127.0.0.1/' })
  if (marker) d.window.document.querySelector('[data-codex-composer-root]').getBoundingClientRect = () => ({ width: 700, height: 100 })
  let clock = 0
  d.window.performance.now = () => clock
  const hud = installHUD(d.window, s => s.length)
  const emit = (method, params = {}, hostId = 'durable') => d.window.dispatchEvent(new d.window.MessageEvent('message', { data: { type: 'mcp-notification', hostId, method, params: { threadId: 'local:dot-chat', turnId: 'turn', ...params } } }))
  return { d, hud, emit, at: v => { clock = v }, close: () => { hud.destroy(); d.window.close() } }
}

describe('durable cloud-coordinated desktop conversations', () => {
  it.each([false, true])('normalizes UI local keys and preserves durable identity (composer=%s)', marker => {
    const f = fixture(marker)
    try {
      expect(readActiveContext(f.d.window, () => ['local', 'durable'])).toMatchObject({ threadId: 'dot-chat', hostId: 'durable' })
      expect(f.hud.snapshot()).toMatchObject({ threadId: 'dot-chat', hostId: 'durable' })
    } finally { f.close() }
  })

  it('measures cloud deltas, resets per turn, and isolates identical local IDs and other cloud chats', () => {
    const f = fixture(true)
    try {
      f.emit('turn/started', { turn: { id: 'turn' } })
      f.emit('turn/started', { threadId: 'dot-chat', turn: { id: 'turn' } }, 'local')
      f.at(100); f.emit('item/agentMessage/delta', { itemId: 'a', delta: 'ab' })
      f.at(200); f.emit('item/agentMessage/delta', { threadId: 'dot-chat', itemId: 'a', delta: 'x'.repeat(100) }, 'local')
      f.at(600); f.emit('item/agentMessage/delta', { itemId: 'a', delta: 'cd' })
      f.emit('item/agentMessage/delta', { threadId: 'other-cloud', itemId: 'a', delta: 'x'.repeat(1000) })
      f.emit('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 100, outputTokens: 20 } } })
      f.emit('thread/tokenUsage/updated', { threadId: 'dot-chat', tokenUsage: { total: { inputTokens: 1_000_000, outputTokens: 1_000_000 } } }, 'local')
      expect(f.hud.snapshot()).toMatchObject({ hostId: 'durable', threadId: 'dot-chat', firstTokenMs: 100, shownTPS: 8, averageTPS: 8, sessionTokens: 120 })
      f.hud.applyNative({ hostId: 'durable', threadId: 'dot-chat', turnId: 'turn', nativeStream: { source: 'native-observer', threadId: 'dot-chat', turnId: 'turn', firstStreamMs: 1, toolTPS: 999 }, sessionUsage: { inputTokens: 1e9, outputTokens: 1e9 } })
      expect(f.hud.snapshot()).toMatchObject({ nativeStream: null, firstTokenMs: 100, sessionTokens: 120 })
      f.emit('turn/completed', { turn: { id: 'turn', status: 'completed' } })
      expect(f.hud.snapshot().shownTPS).toBe(8)
      f.at(1000); f.emit('turn/started', { turnId: 'next', turn: { id: 'next' } })
      expect(f.hud.snapshot()).toMatchObject({ averageTPS: null, shownTPS: 8 })
    } finally { f.close() }
  })

  it('uses same-item server timestamps for completion-only averages, never batch arrival gaps or history', () => {
    const f = fixture()
    try {
      f.emit('turn/started', { turn: { id: 'turn' } })
      f.at(100); f.emit('item/started', { startedAtMs: 10_000, item: { id: 'message', type: 'agentMessage' } })
      f.at(101); f.emit('item/completed', { completedAtMs: 12_000, item: { id: 'message', type: 'agentMessage', text: 'abcdefgh' } })
      expect(f.hud.snapshot()).toMatchObject({ shownTPS: 4, averageTPS: 4, measurementKind: 'cloud-message-average', firstTokenMs: 100 })
      const shadow = f.d.window.document.getElementById('codex-speed-hud').shadowRoot
      expect(shadow.querySelector('[data-speed]').title).toContain('消息平均吞吐')
      f.emit('item/completed', { completedAtMs: 12_000, item: { id: 'message', type: 'agentMessage', text: 'abcdefgh' } })
      f.emit('item/completed', { completedAtMs: 15_000, item: { id: 'history', type: 'agentMessage', text: 'historical'.repeat(1000) } })
      f.at(200); f.emit('item/started', { startedAtMs: 20_000, item: { id: 'batch', type: 'agentMessage' } })
      f.at(201); f.emit('item/completed', { completedAtMs: 20_000, item: { id: 'batch', type: 'agentMessage', text: 'no timing' } })
      expect(f.hud.snapshot()).toMatchObject({ shownTPS: 4, averageTPS: 4 })
      f.emit('turn/completed', { turn: { id: 'turn', status: 'completed' } })
      f.at(5000); expect(f.hud.snapshot()).toMatchObject({ shownTPS: 4, averageTPS: 4 })
    } finally { f.close() }
  })

  it('does not fabricate first flow when attached mid-turn and strips raw secrets from model events', () => {
    const f = fixture()
    try {
      const raw = { type: 'mcp-notification', hostId: 'durable', method: 'rawResponseItem/completed', params: { threadId: 'local:dot-chat', turnId: 'turn', item: { type: 'function_call', arguments: 'SECRET', encrypted_content: 'CIPHERTEXT' } } }
      const adapted = notificationFrom({ hostId: 'durable', notification: raw })
      expect(adapted).toMatchObject({ hostId: 'durable', params: { threadId: 'dot-chat', item: { type: 'function_call' } } })
      expect(JSON.stringify(adapted)).not.toMatch(/SECRET|CIPHERTEXT|arguments|encrypted_content/)
      expect(notificationFrom({ ...raw, type: 'mcp-response' })).toBeNull()
      f.emit(raw.method, raw.params)
      f.at(100); f.emit('item/agentMessage/delta', { itemId: 'partial', delta: 'ab' })
      f.at(600); f.emit('item/agentMessage/delta', { itemId: 'partial', delta: 'cd' })
      expect(f.hud.snapshot()).toMatchObject({ firstTokenMs: null, shownTPS: 8 })
    } finally { f.close() }
  })
})
