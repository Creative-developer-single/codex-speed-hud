const MARKERS = '[data-conversation-id], [data-above-composer-conversation-id]'
const COMPOSER = '[data-codex-composer-root]'
const AREAS = '[data-app-shell-focus-area="main"], [data-app-shell-focus-area="right-panel"]'
const RIGHT = '[data-app-shell-focus-area="right-panel"]'
const SELECTED = '[data-app-action-sidebar-thread-active="true"], [data-app-action-sidebar-thread-row][aria-current="page"]'

export function isVisible(element) {
  if (!element || element.closest('[hidden], [aria-hidden="true"], [inert]')) return false
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  for (let parent = element; parent; parent = parent.parentElement) {
    const style = element.ownerDocument.defaultView.getComputedStyle(parent)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
  }
  return true
}

export function normalizeThreadId(raw, hostId = null) {
  if (typeof raw !== 'string' || !raw) return null
  if (hostId && raw.startsWith(`${hostId}:`)) return raw.slice(hostId.length + 1)
  // `local:` is a desktop sidebar key namespace, also used for durable tasks.
  // The explicit execution host remains durable; never reinterpret it as local.
  if ((!hostId || hostId === 'durable') && raw.startsWith('local:')) return raw.slice(6)
  return raw
}

function identity(raw, hostId = null) {
  if (!raw) return { threadId: null, hostId }
  return { threadId: normalizeThreadId(raw, hostId), hostId }
}
const temporary = id => id?.startsWith('client-new-thread:') === true
const markerIdentity = node => identity(node.getAttribute('data-conversation-id') ?? node.getAttribute('data-above-composer-conversation-id'),
  node.closest('[data-conversation-host-id]')?.getAttribute('data-conversation-host-id') ?? null)

/** The empty above-composer portal can be display:none; its owning composer is the visibility anchor. */
export function composerThreadId(element) {
  const ancestor = element.closest(MARKERS)
  const marker = ancestor ?? element.closest(COMPOSER)?.querySelector(MARKERS)
  return marker ? markerIdentity(marker).threadId : null
}

/** Resolve only DOM identity. Never choose a foreground chat from the newest/background notification. */
export function readActiveContext(window, knownHosts = () => [], visible = isVisible, preferredPanel = null) {
  const { document } = window
  const selected = document.querySelector(SELECTED)
  const selection = identity(selected?.getAttribute('data-app-action-sidebar-thread-id')
    ?? selected?.querySelector('[data-app-action-sidebar-thread-id]')?.getAttribute('data-app-action-sidebar-thread-id'),
  selected?.getAttribute('data-app-action-sidebar-thread-host-id') ?? null)
  const visibleComposers = [...document.querySelectorAll(COMPOSER)].filter(visible)
  const focused = visibleComposers.find(root => root.contains(document.activeElement))
  const preferred = preferredPanel?.isConnected && visibleComposers.some(root => preferredPanel === root || preferredPanel.contains(root)) ? preferredPanel : null
  const rightPanels = [...document.querySelectorAll(RIGHT)].filter(panel => visibleComposers.some(root => panel.contains(root)))
  // A visible side chat is independent of the sidebar's main-chat selection.
  // A user's explicit panel choice survives focus moving to the HUD toolbar.
  const scope = preferred ?? focused ?? (rightPanels.length === 1 ? rightPanels[0] : null)
  const composers = scope ? visibleComposers.filter(root => scope === root || scope.contains(root)) : visibleComposers
  const unbound = composers.filter(root => !root.querySelector(MARKERS) && !root.closest(MARKERS))
  if (unbound.some(root => root.contains(document.activeElement)) || unbound.length && (scope || temporary(selection.threadId))) {
    return { threadId: null, hostId: selection.hostId ?? 'local', source: 'pending-new-thread' }
  }
  const hostFor = candidate => {
    if (candidate.hostId) return candidate.hostId
    if (selection.hostId && selection.threadId === candidate.threadId) return selection.hostId
    const hosts = [...new Set(knownHosts(candidate.threadId))]
    if (hosts.length === 1) return hosts[0]
    if (hosts.length > 1) return null
    return temporary(selection.threadId) ? selection.hostId ?? 'local' : 'local'
  }
  const candidates = []
  for (const marker of document.querySelectorAll(MARKERS)) {
    const owner = marker.closest(COMPOSER) ?? marker
    if (!visible(owner) || scope && owner !== scope && !scope.contains(owner)) continue
    const candidate = markerIdentity(marker)
    if (!candidate.threadId || temporary(candidate.threadId)) continue
    candidates.push({ ...candidate, hostId: hostFor(candidate), owner })
  }
  const distinct = values => [...new Map(values.map(c => [JSON.stringify([c.hostId, c.threadId]), c])).values()]
  let unique = distinct(candidates)
  if (unique.length > 1) {
    const focused = distinct(candidates.filter(c => c.owner.contains(document.activeElement)))
    if (focused.length === 1) unique = focused
    else {
      const matching = unique.filter(c => c.threadId === selection.threadId && (!selection.hostId || c.hostId === selection.hostId))
      if (matching.length === 1) unique = matching
    }
  }
  if (unique.length === 1) return { threadId: unique[0].threadId, hostId: unique[0].hostId, source: unique[0].owner.closest(RIGHT) ? 'right-panel' : 'visible-panel' }
  if (unique.length > 1) return { threadId: null, hostId: null, source: 'ambiguous-panels' }

  // A new/home composer without its formal ID must not inherit a stale sidebar or cached panel.
  if (temporary(selection.threadId) || composers.length) {
    return { threadId: null, hostId: selection.hostId ?? 'local', source: 'pending-new-thread' }
  }
  // Legacy renderers without panel markers still support a real selected sidebar ID.
  if (selection.threadId) return { ...selection, hostId: hostFor(selection), source: 'sidebar' }
  const route = window.location.pathname.match(/\/(?:threads?|conversations?)\/([a-zA-Z0-9-]+)/)?.[1]
  return { threadId: route ?? null, hostId: route ? hostFor({ threadId: route }) : 'local', source: route ? 'route' : 'none' }
}


/** Track only explicit DOM panel interaction; background model events never select a chat. */
export function createContextTracker(window, knownHosts = () => []) {
  const { document } = window
  let preferred = null
  let previousRight = null
  const composers = () => [...document.querySelectorAll(COMPOSER)].filter(isVisible)
  function syncRight(roots) {
    const panels = [...document.querySelectorAll(RIGHT)].filter(p => roots.some(root => p.contains(root)))
    const right = panels.length === 1 ? panels[0] : null
    if (right !== previousRight) { preferred = null; previousRight = right }
  }
  function interact(event) {
    const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement
    if (!target || target.closest('#codex-speed-hud, [data-codex-speed-hud-toggle]')) return
    const roots = composers()
    syncRight(roots)
    for (let node = target; node && node !== document.body; node = node.parentElement) {
      if ((node.matches(AREAS) && roots.some(root => node.contains(root))) || roots.includes(node)) {
        preferred = node
        return
      }
    }
    if (target.closest('[data-app-action-sidebar-thread-row]')) {
      const main = [...document.querySelectorAll('[data-app-shell-focus-area="main"]')].filter(p => roots.some(root => p.contains(root)))
      if (main.length === 1) preferred = main[0]
    }
  }
  document.addEventListener('pointerdown', interact, true)
  document.addEventListener('focusin', interact, true)
  return {
    read() { syncRight(composers()); return readActiveContext(window, knownHosts, isVisible, preferred) },
    destroy() { document.removeEventListener('pointerdown', interact, true); document.removeEventListener('focusin', interact, true) },
  }
}
