import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { installHUD } from '../src/overlay.mjs'

function fixture(marker = true) {
  const d = new JSDOM(`<body><div data-app-action-sidebar-thread-active="true" data-app-action-sidebar-thread-id="local:client-new-thread:draft" data-app-action-sidebar-thread-host-id="local"></div><section hidden><div data-codex-composer-root><div data-above-composer-conversation-id="background"></div></div></section><section id="foreground"><div data-codex-composer-root>${marker ? '<div style="display:none" data-above-composer-conversation-id="new-chat"></div>' : ''}<button data-codex-intelligence-trigger="true" data-selected-model-label="GPT-6.1 Sol" data-selected-reasoning-effort="high" data-fast-mode-enabled="true"></button></div></section></body>`, { url: 'http://127.0.0.1/' })
  const w = d.window
  let clock = 0
  w.performance.now = () => clock
  for (const e of w.document.querySelectorAll('[data-codex-composer-root],button')) e.getBoundingClientRect = () => ({ width: 700, height: 80 })
  const hud = installHUD(w, text => text.length)
  const emit = (method, threadId, params = {}, hostId = 'local') => w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'mcp-notification', hostId, method, params: { threadId, turnId: 'first-turn', ...params } } }))
  return { d, w, hud, emit, at: n => { clock = n }, finish: () => { hud.destroy(); w.close() } }
}

describe('first user turn in a new conversation', () => {
  it('measures the first turn while the sidebar retains its temporary ID and never mixes background rates, usage or model records', () => {
    const f = fixture()
    const { hud, emit, at, w } = f
    try {
      emit('turn/started', 'background', { turn: { id: 'first-turn' } })
      emit('turn/started', 'new-chat', { turn: { id: 'first-turn' } })
      at(100); emit('item/agentMessage/delta', 'new-chat', { itemId: 'reply', delta: 'a' })
      at(150); emit('item/agentMessage/delta', 'background', { itemId: 'bg-reply', delta: 'x'.repeat(100) })
      at(600); emit('item/agentMessage/delta', 'new-chat', { itemId: 'reply', delta: 'bc' })
      expect(hud.snapshot().displayTPS).toBe(6)
      at(650); emit('item/agentMessage/delta', 'background', { itemId: 'bg-reply', delta: 'x'.repeat(1000) })
      hud.applyNative({ threadId: 'background', sessionUsage: { input_tokens: 1_000_000, output_tokens: 1_000_000 }, previousResponse: { turnId: 'bg', model: 'gpt-6-luna', reasoningEffort: 'low', fastMode: false } })
      expect(hud.snapshot()).toMatchObject({ threadId: 'new-chat', hostId: 'local', contextSource: 'visible-panel', firstTokenMs: 100, averageTPS: 6, visibleTokens: 3, sessionTokens: null })
      emit('item/completed', 'new-chat', { item: { id: 'reply', type: 'agentMessage', text: 'abc' } })
      expect(hud.snapshot()).toMatchObject({ recordedModel: 'GPT-6.1 Sol', recordedEffort: 'high', recordedFastMode: true })
      const shadow = w.document.getElementById('codex-speed-hud').shadowRoot
      expect(shadow.querySelector('[data-first]').textContent).toBe('0.10 s')
      expect(shadow.querySelector('[data-speed]').textContent).toBe('6.0')
      w.document.querySelector('[data-app-action-sidebar-thread-id]').setAttribute('data-app-action-sidebar-thread-id', 'local:new-chat')
      expect(hud.snapshot()).toMatchObject({ threadId: 'new-chat', firstTokenMs: 100, averageTPS: 6 })
    } finally { f.finish() }
  })
  it('preserves first-turn events when formal DOM identity appears after streaming has begun; never guesses from background events', () => {
    const f = fixture(false)
    const { hud, emit, at, w } = f
    try {
      emit('turn/started', 'background', { turn: { id: 'first-turn' } })
      expect(hud.snapshot().threadId).toBeNull()
      emit('turn/started', 'new-chat', { turn: { id: 'first-turn' } })
      at(100); emit('item/agentMessage/delta', 'new-chat', { itemId: 'reply', delta: 'a' })
      at(600); emit('item/agentMessage/delta', 'new-chat', { itemId: 'reply', delta: 'bc' })
      expect(hud.snapshot()).toMatchObject({ threadId: null, contextSource: 'pending-new-thread' })
      const marker = w.document.createElement('div'); marker.setAttribute('data-above-composer-conversation-id', 'new-chat'); marker.style.display = 'none'
      w.document.querySelector('#foreground [data-codex-composer-root]').append(marker)
      expect(hud.snapshot()).toMatchObject({ threadId: 'new-chat', firstTokenMs: 100, averageTPS: 6 })
      at(700); emit('item/agentMessage/delta', 'background', { itemId: 'bg-reply', delta: 'background' })
      expect(hud.snapshot()).toMatchObject({ threadId: 'new-chat', firstTokenMs: 100, averageTPS: 6, visibleTokens: 3 })
    } finally { f.finish() }
  })
})
