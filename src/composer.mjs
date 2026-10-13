import { composerThreadId, isVisible } from './context.mjs'

const TRIGGER = '[data-codex-intelligence-trigger="true"]'
const EFFORTS = { none: 'None', minimal: 'Minimal', low: 'Light', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max', ultra: 'Ultra', persistent: 'Persistent' }
export const effortLabel = effort => EFFORTS[effort] ?? '—'
export function modelLabel(model) {
  if (!model || model === 'unknown') return null
  const match = model.match(/^gpt-([\d.]+)-(.+)$/i)
  return match ? `GPT-${match[1]} ${match[2].split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' ')}` : model
}

/** Read only the active composer's selection metadata, never reply or input text. */
export function readComposer(document, threadId, visible = isVisible) {
  const triggers = [...document.querySelectorAll(TRIGGER)].filter(visible)
  const scoped = triggers.filter(trigger => composerThreadId(trigger) === threadId)
  // A known different conversation must never supply this turn's settings.
  const candidates = scoped.length ? scoped : triggers.filter(trigger => composerThreadId(trigger) === null)
  if (candidates.length !== 1) return { trigger: null, model: null, effort: null, effortLabel: null, fast: null }
  const trigger = candidates[0]
  const model = trigger.getAttribute('data-selected-model-label')
    ?? trigger.querySelector('[class*="ModelPickerTriggerModelText"]')?.textContent?.trim()
    ?? trigger.getAttribute('data-selected-model')
    ?? null
  const effort = trigger.getAttribute('data-selected-reasoning-effort')
  const effortNode = [...trigger.querySelectorAll('[data-reasoning-effort]')].find(node => node.getAttribute('data-reasoning-effort') === effort)
  const effortLabel = effortNode?.textContent?.trim() || EFFORTS[effort] || null
  const explicitFast = trigger.getAttribute('data-fast-mode-enabled')
  const tier = trigger.getAttribute('data-selected-service-tier')
  const indicator = trigger.querySelector('[class*="ModelPickerTriggerInlineModeIcon"]')
  const daybreak = trigger.querySelector('[data-daybreak-indicator]')
  // In this installed renderer the inline mode icon is fast/ultrafast, except daybreak.
  const fast = explicitFast !== null ? explicitFast === 'true'
    : tier !== null ? ['fast', 'priority', 'ultrafast'].includes(tier)
      : daybreak ? null : Boolean(indicator)
  return { trigger, model: model?.slice(0, 96) ?? null, effort, effortLabel, fast }
}
