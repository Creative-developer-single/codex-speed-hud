const MARKERS = '[data-conversation-id], [data-above-composer-conversation-id]'
const COMPOSER = '[data-codex-composer-root]'
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
export function readActiveContext(window, knownHosts = () => [], visible = isVisible) {
  const { document } = window
  const selected = document.querySelector(SELECTED)
  const selection = identity(selected?.getAttribute('data-app-action-sidebar-thread-id')
    ?? selected?.querySelector('[data-app-action-sidebar-thread-id]')?.getAttribute('data-app-action-sidebar-thread-id'),
  selected?.getAttribute('data-app-action-sidebar-thread-host-id') ?? null)
  const visibleComposers = [...document.querySelectorAll(COMPOSER)].filter(visible)
  const unbound = visibleComposers.filter(root => !root.querySelector(MARKERS) && !root.closest(MARKERS))
  if (unbound.some(root => root.contains(document.activeElement)) || temporary(selection.threadId) && unbound.length) {
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
    if (!visible(owner)) continue
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
  if (unique.length === 1) return { threadId: unique[0].threadId, hostId: unique[0].hostId, source: 'visible-panel' }
  if (unique.length > 1) return { threadId: null, hostId: null, source: 'ambiguous-panels' }

  // A new/home composer without its formal ID must not inherit a stale sidebar or cached panel.
  if (temporary(selection.threadId) || visibleComposers.length) {
    return { threadId: null, hostId: selection.hostId ?? 'local', source: 'pending-new-thread' }
  }
  // Legacy renderers without panel markers still support a real selected sidebar ID.
  if (selection.threadId) return { ...selection, hostId: hostFor(selection), source: 'sidebar' }
  const route = window.location.pathname.match(/\/(?:threads?|conversations?)\/([a-zA-Z0-9-]+)/)?.[1]
  return { threadId: route ?? null, hostId: route ? hostFor({ threadId: route }) : 'local', source: route ? 'route' : 'none' }
}
