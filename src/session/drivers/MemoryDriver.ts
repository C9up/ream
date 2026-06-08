import type { SessionDriver } from '../Session.js'

export class MemoryDriver implements SessionDriver {
  private store: Map<string, { data: Record<string, unknown>; expiresAt: number }> = new Map()

  async read(sessionId: string): Promise<Record<string, unknown>> {
    const entry = this.store.get(sessionId)
    if (!entry || entry.expiresAt < Date.now()) {
      this.store.delete(sessionId)
      return {}
    }
    return { ...entry.data }
  }

  async write(sessionId: string, data: Record<string, unknown>, ttl: number): Promise<void> {
    this.store.set(sessionId, { data, expiresAt: Date.now() + ttl * 1000 })
  }

  async destroy(sessionId: string): Promise<void> {
    this.store.delete(sessionId)
  }

  async touch(sessionId: string, ttl: number): Promise<void> {
    const entry = this.store.get(sessionId)
    if (entry) {
      entry.expiresAt = Date.now() + ttl * 1000
    }
  }
}
