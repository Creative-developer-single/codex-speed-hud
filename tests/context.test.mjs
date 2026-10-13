import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { readActiveContext } from '../src/context.mjs'
import { readComposer } from '../src/composer.mjs'

const sidebar = '<div data-app-action-sidebar-thread-active="true" data-app-action-sidebar-thread-id="local:client-new-thread:draft" data-app-action-sidebar-thread-host-id="local"></div>'
const panel = (id, { hidden = false, host = '', marker = true } = {}) => `<section ${hidden ? 'hidden' : ''} ${host ? `data-conversation-host-id="${host}"` : ''}><div data-codex-composer-root>${marker ? `<div style="display:none" data-above-composer-conversation-id="${id}"></div>` : ''}<button data-codex-intelligence-trigger="true" data-selected-model-label="${id}"></button></div></section>`
function fixture(html) {
  const d = new JSDOM(`<body>${html}</body>`, { url: 'http://127.0.0.1/' })
  for (const e of d.window.document.querySelectorAll('[data-codex-composer-root],button')) e.getBoundingClientRect = () => ({ width: 700, height: 80 })
  return d
}

describe('foreground conversation identity', () => {
  it('does not borrow the previous visible panel while a new unbound composer is opening', () => {
    const d = fixture(sidebar + panel('previous') + panel('', { marker: false }))
    expect(readActiveContext(d.window)).toMatchObject({ threadId: null, source: 'pending-new-thread' })
    d.window.document.querySelector('[data-app-action-sidebar-thread-id]').setAttribute('data-app-action-sidebar-thread-id', 'local:previous')
    d.window.document.querySelector('section:last-child button').focus()
    expect(readActiveContext(d.window)).toMatchObject({ threadId: null, source: 'pending-new-thread' })
    d.window.close()
  })
  it('uses the visible composer formal ID despite a temporary sidebar and an empty/hidden portal', () => {
    const d = fixture(sidebar + panel('background', { hidden: true }) + panel('new-chat'))
    expect(readActiveContext(d.window)).toEqual({ threadId: 'new-chat', hostId: 'local', source: 'visible-panel' })
    expect(readComposer(d.window.document, 'new-chat').model).toBe('new-chat')
    d.window.close()
  })
  it('rejects hidden cached panels and a stale real sidebar when the new composer has no formal ID', () => {
    const d = fixture(sidebar.replace('client-new-thread:draft', 'background') + panel('background', { hidden: true }) + panel('', { marker: false }))
    expect(readActiveContext(d.window)).toMatchObject({ threadId: null, source: 'pending-new-thread' })
    d.window.close()
  })
  it('uses visible identity when the sidebar still points to a previous real conversation', () => {
    const d = fixture(sidebar.replace('client-new-thread:draft', 'previous') + panel('previous', { hidden: true }) + panel('current'))
    expect(readActiveContext(d.window).threadId).toBe('current')
    d.window.close()
  })
  it('does not choose the newest background host for an ambiguous conversation', () => {
    const d = fixture(sidebar + panel('same-chat'))
    expect(readActiveContext(d.window, () => ['local', 'remote-ssh:developer'])).toMatchObject({ threadId: 'same-chat', hostId: null })
    d.window.close()
  })
  it('uses native host identity before a stale temporary sidebar host and strips local prefixes', () => {
    const d = fixture(sidebar + panel('new-chat'))
    expect(readActiveContext(d.window, () => ['remote-ssh:developer']).hostId).toBe('remote-ssh:developer')
    d.window.document.querySelector('[data-above-composer-conversation-id]').setAttribute('data-above-composer-conversation-id', 'local:new-chat')
    expect(readActiveContext(d.window)).toMatchObject({ threadId: 'new-chat', hostId: 'local' })
    d.window.close()
  })
  it('resolves split panels by focused composer or matching sidebar and otherwise leaves them ambiguous', () => {
    const d = fixture(sidebar + panel('a') + panel('b'))
    expect(readActiveContext(d.window)).toMatchObject({ threadId: null, source: 'ambiguous-panels' })
    d.window.document.querySelector('section:last-child button').focus()
    expect(readActiveContext(d.window).threadId).toBe('b')
    d.window.document.activeElement.blur()
    d.window.document.querySelector('[data-app-action-sidebar-thread-id]').setAttribute('data-app-action-sidebar-thread-id', 'local:a')
    expect(readActiveContext(d.window).threadId).toBe('a')
    d.window.close()
  })
  it('does not use another visible conversation to populate missing model settings', () => {
    const d = fixture(panel('other'))
    expect(readComposer(d.window.document, 'new-chat').model).toBeNull()
    d.window.close()
  })
})
