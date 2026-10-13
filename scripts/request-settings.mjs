import { readFile, writeFile, rename } from 'node:fs/promises'

// Only a turn's captured mode; no text or credentials. Survives HUD restarts.
export class RequestSettings {
  entries = new Map()
  constructor(filename) { this.filename = filename }
  key(threadId, turnId) { return JSON.stringify([threadId, turnId]) }
  get(threadId, turnId) { return this.entries.get(this.key(threadId, turnId)) ?? null }
  async load() {
    try {
      const text = await readFile(this.filename, 'utf8')
      if (text.length > 4_000_000) return
      const rows = JSON.parse(text)
      if (!Array.isArray(rows)) return
      for (const row of rows.slice(-10_000)) {
        if (typeof row?.threadId === 'string' && typeof row?.turnId === 'string' && typeof row?.fastMode === 'boolean')
          this.entries.set(this.key(row.threadId, row.turnId), { fastMode: row.fastMode })
      }
    } catch { /* New or incompatible cache. */ }
  }
  async capture(threadId, turnId, settings) {
    if (!threadId || !turnId || typeof settings?.fastMode !== 'boolean') return
    const key = this.key(threadId, turnId)
    if (this.entries.has(key)) return
    this.entries.set(key, { fastMode: settings.fastMode })
    while (this.entries.size > 10_000) this.entries.delete(this.entries.keys().next().value)
    const rows = [...this.entries].map(([key, value]) => {
      const [threadId, turnId] = JSON.parse(key)
      return { threadId, turnId, ...value }
    })
    const temporary = `${this.filename}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(rows), { mode: 0o600 })
    await rename(temporary, this.filename)
  }
}
