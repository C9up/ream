import type { SessionDriver } from '../Session.js'

const store: Map<string, { data: Record<string, unknown>; expiresAt: number }> = new Map()

export class MemoryDriver implements SessionDriver {
  async read(sessionId: string): Promise<Record<string, unknown>> {
    const entry = store.get(sessionId)
    if (!entry || entry.expiresAt < Date.now()) {
      store.delete(sessionId)
      return {}
    }
    return { ...entry.data }
  }

  async write(sessionId: string, data: Record<string, unknown>, ttl: number): Promise<void> {
    store.set(sessionId, { data, expiresAt: Date.now() + ttl * 1000 })
  }

  async destroy(sessionId: string): Promise<void> {
    store.delete(sessionId)
  }

  async touch(sessionId: string, ttl: number): Promise<void> {
    const entry = store.get(sessionId)
    if (entry) {
      entry.expiresAt = Date.now() + ttl * 1000
    }
  }
}
