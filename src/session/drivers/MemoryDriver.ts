import type { SessionDriver } from '../Session.js'

const SWEEP_THRESHOLD = 1000

export class MemoryDriver implements SessionDriver {
  #store: Map<string, { data: Record<string, unknown>; expiresAt: number }> = new Map()

  async read(sessionId: string): Promise<Record<string, unknown>> {
    const entry = this.#store.get(sessionId)
    if (!entry || entry.expiresAt < Date.now()) {
      this.#store.delete(sessionId)
      return {}
    }
    return { ...entry.data }
  }

  async write(sessionId: string, data: Record<string, unknown>, ttl: number): Promise<void> {
    if (this.#store.size >= SWEEP_THRESHOLD) {
      const now = Date.now()
      for (const [id, entry] of this.#store) {
        if (entry.expiresAt < now) this.#store.delete(id)
      }
    }
    this.#store.set(sessionId, { data, expiresAt: Date.now() + ttl * 1000 })
  }

  async destroy(sessionId: string): Promise<void> {
    this.#store.delete(sessionId)
  }

  async touch(sessionId: string, ttl: number): Promise<void> {
    const entry = this.#store.get(sessionId)
    if (entry) {
      entry.expiresAt = Date.now() + ttl * 1000
    }
  }
}
