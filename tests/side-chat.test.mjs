import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { installHUD } from '../src/overlay.mjs'

function fixture({ bound = true, sideHost = 'local' } = {}) {
  const dom = new JSDOM(`<body>
    <div data-app-shell-header-slot-content><div data-toolbar><div aria-hidden="true"></div><span><button data-app-shell-workspace-layout-toggle="main" data-app-shell-focus-area="main">+</button></span></div></div>
    <div data-app-action-sidebar-thread-active="true" data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="local:main" data-app-action-sidebar-thread-host-id="local"></div>
    <section id="main" data-app-shell-focus-area="main"><div id="main-message" tabindex="0"></div><div data-codex-composer-root><div style="display:none" data-above-composer-conversation-id="main"></div><input></div></section>
    <aside id="side" data-app-shell-focus-area="right-panel" data-conversation-host-id="${sideHost}"><div data-app-shell-tab-panel-controller="right" data-tab-id="sidechat:side"><div id="side-message" tabindex="0"></div><div data-codex-composer-root>${bound ? '<div style="display:none" data-above-composer-conversation-id="local:side"></div><div data-above-composer-conversation-id="local:side" data-above-composer-fixed-content-portal="true"></div>' : ''}<input></div></div><section hidden><div data-codex-composer-root><div data-above-composer-conversation-id="cached"></div><input></div></section></aside>
  </body>`, { url: 'http://127.0.0.1/' })
  const w = dom.window, d = w.document
  for (const el of d.querySelectorAll('[data-codex-composer-root]')) el.getBoundingClientRect = () => ({ width: 400, height: 100 })
  let now = 0; w.performance.now = () => now
  const hud = installHUD(w, text => text.length)
  const emit = (threadId, method, params = {}, hostId = 'local') => w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'mcp-notification', hostId, method, params: { threadId, turnId: 'turn', ...params } } }))
  const point = selector => d.querySelector(selector).dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true }))
  return { w, d, hud, emit, point, at: t => { now = t }, close: () => { hud.destroy(); w.close() } }
}

describe('right-hand temporary chat compatibility', () => {
  it('selects the visible side chat despite the main sidebar and keeps rate, averages and usage isolated', () => {
    const f = fixture()
    try {
      expect(f.hud.snapshot()).toMatchObject({ threadId: 'side', hostId: 'local', contextSource: 'right-panel' })
      f.emit('main', 'turn/started', { turn: { id: 'turn' } })
      f.emit('side', 'turn/started', { turn: { id: 'turn' } })
      f.at(100); f.emit('side', 'item/agentMessage/delta', { itemId: 'a', delta: 'ab' })
      f.at(200); f.emit('main', 'item/agentMessage/delta', { itemId: 'a', delta: 'x'.repeat(1000) })
      f.at(600); f.emit('side', 'item/agentMessage/delta', { itemId: 'a', delta: 'cd' })
      f.emit('main', 'thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 100000, outputTokens: 100000 } } })
      f.emit('side', 'thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 100, outputTokens: 20 } } })
      expect(f.hud.snapshot()).toMatchObject({ threadId: 'side', firstTokenMs: 100, shownTPS: 8, averageTPS: 8, sessionTokens: 120 })
      f.emit('side', 'turn/completed', { turn: { id: 'turn', status: 'completed' } })
      f.at(1000); f.emit('side', 'turn/started', { turnId: 'next', turn: { id: 'next' } })
      expect(f.hud.snapshot()).toMatchObject({ threadId: 'side', firstTokenMs: 100, shownTPS: 8, averageTPS: null })
    } finally { f.close() }
  })

  it('retains the last interacted panel when focus moves to the HUD and supports message-area clicks', () => {
    const f = fixture()
    try {
      f.d.querySelector('#side input').focus()
      f.point('#main-message') // Pointer intent wins even while a side input still has keyboard focus.
      expect(f.hud.snapshot().threadId).toBe('main')
      f.d.querySelector('[data-codex-speed-hud-toggle]').focus()
      expect(f.hud.snapshot().threadId).toBe('main')
      f.point('#side-message')
      expect(f.hud.snapshot().threadId).toBe('side')
      f.d.getElementById('codex-speed-hud').shadowRoot.querySelector('[data-close]').focus()
      expect(f.hud.snapshot().threadId).toBe('side')
    } finally { f.close() }
  })

  it('does not borrow main or cached chat data before a new side chat gets its formal ID', () => {
    const f = fixture({ bound: false })
    try {
      expect(f.hud.snapshot()).toMatchObject({ threadId: null, contextSource: 'pending-new-thread' })
      f.emit('main', 'turn/started', { turn: { id: 'turn' } })
      f.emit('side', 'turn/started', { turn: { id: 'turn' } })
      f.at(100); f.emit('side', 'item/agentMessage/delta', { itemId: 'a', delta: 'ab' })
      f.at(600); f.emit('side', 'item/agentMessage/delta', { itemId: 'a', delta: 'cd' })
      expect(f.hud.snapshot().threadId).toBeNull()
      f.d.querySelector('#side [data-codex-composer-root]').insertAdjacentHTML('afterbegin', '<div data-above-composer-conversation-id="side"></div>')
      expect(f.hud.snapshot()).toMatchObject({ threadId: 'side', firstTokenMs: 100, shownTPS: 8 })
    } finally { f.close() }
  })

  it('returns to the main chat on side close and follows a reopened side panel', () => {
    const f = fixture()
    try {
      expect(f.hud.snapshot().threadId).toBe('side')
      f.d.querySelector('#side').hidden = true
      expect(f.hud.snapshot().threadId).toBe('main')
      f.point('#main-message')
      f.d.querySelector('#side').hidden = false
      expect(f.hud.snapshot().threadId).toBe('side')
      f.point('[data-app-action-sidebar-thread-row]')
      expect(f.hud.snapshot().threadId).toBe('main')
    } finally { f.close() }
  })

  it('isolates durable side chats from identical local IDs', () => {
    const f = fixture({ sideHost: 'durable' })
    try {
      expect(f.hud.snapshot()).toMatchObject({ threadId: 'side', hostId: 'durable' })
      f.emit('side', 'thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 100, outputTokens: 20 } } }, 'durable')
      f.emit('side', 'thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 1e6, outputTokens: 1e6 } } }, 'local')
      expect(f.hud.snapshot().sessionTokens).toBe(120)
    } finally { f.close() }
  })
})
