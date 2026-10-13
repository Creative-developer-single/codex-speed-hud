import { EventEmitter } from 'node:events'

export function loopbackURL(input, protocols = ['http:', 'ws:']) {
  const url = new URL(input)
  if (!protocols.includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password) throw new Error('Only unauthenticated loopback DevTools URLs are supported')
  return url
}

export async function listTargets(endpoint) {
  const url = loopbackURL(endpoint, ['http:'])
  url.pathname = '/json/list'; url.search = ''
  const response = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'error' })
  if (!response.ok) throw new Error(`DevTools returned HTTP ${response.status}`)
  const targets = await response.json()
  if (!Array.isArray(targets)) throw new Error('Invalid DevTools target list')
  return targets
}

export class CDPClient extends EventEmitter {
  constructor(url) {
    super()
    this.socket = new WebSocket(loopbackURL(url, ['ws:']))
    this.nextId = 1
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('DevTools connect timeout')); this.close() }, 3000)
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('DevTools connection failed')) }, { once: true })
    })
    this.socket.addEventListener('message', event => {
      let value
      try { value = JSON.parse(event.data) } catch { return }
      if (value.id) {
        const pending = this.pending.get(value.id)
        if (!pending) return
        clearTimeout(pending.timer); this.pending.delete(value.id)
        if (value.error) pending.reject(new Error(value.error.message))
        else pending.resolve(value.result)
      } else this.emit('event', value)
    })
    this.socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('DevTools disconnected')) }
      this.pending.clear(); this.emit('disconnect')
    })
  }
  async call(method, params = {}) {
    await this.ready
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`DevTools timeout: ${method}`)) }, 8000)
      this.pending.set(id, { resolve, reject, timer })
      try { this.socket.send(JSON.stringify({ id, method, params })) } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }
  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error('HUD evaluation failed (check installed App compatibility)')
    return result.result?.value
  }
  close() { this.socket.close() }
}
