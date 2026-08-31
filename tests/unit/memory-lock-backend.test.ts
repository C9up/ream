import { beforeEach, describe, expect, it } from 'vitest'
import type { ReamError } from '../../src/index.js'
import { MemoryLockBackend } from '../../src/index.js'

describe('MemoryLockBackend', () => {
  let backend: MemoryLockBackend

  beforeEach(() => {
    backend = new MemoryLockBackend()
  })

  it('acquire returns true on first call for a given name', async () => {
    expect(await backend.acquire('task-a', 1000)).toBe(true)
  })

  it('acquire returns false while the lock is held by the same backend', async () => {
    expect(await backend.acquire('task-a', 1000)).toBe(true)
    expect(await backend.acquire('task-a', 1000)).toBe(false)
  })

  it('acquire on a different name succeeds while another lock is held', async () => {
    expect(await backend.acquire('task-a', 1000)).toBe(true)
    expect(await backend.acquire('task-b', 1000)).toBe(true)
  })

  it('acquire returns true again once the TTL has elapsed', async () => {
    // Simulate an expired lock by forcing its expiry into the past.
    backend.__setExpiryForTesting('task-a', Date.now() - 1)
    expect(await backend.acquire('task-a', 1000)).toBe(true)
  })

  it('release followed by acquire returns true immediately (no TTL wait)', async () => {
    expect(await backend.acquire('task-a', 60_000)).toBe(true)
    await backend.release('task-a')
    expect(await backend.acquire('task-a', 60_000)).toBe(true)
  })

  it('release on an unknown name is a no-op (does not throw)', async () => {
    await expect(backend.release('never-registered')).resolves.toBeUndefined()
  })

  it('two distinct backend instances do not share state (single-process only — use Redis/DB for cross-process)', async () => {
    const other = new MemoryLockBackend()
    expect(await backend.acquire('task-a', 1000)).toBe(true)
    // The other backend must be able to acquire the same name — it
    // has its own independent Map.
    expect(await other.acquire('task-a', 1000)).toBe(true)
  })

  it('rejects invalid ttlMs values (0, negative, NaN, Infinity)', async () => {
    const invalid = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]
    for (const ttl of invalid) {
      await expect(backend.acquire('ttl-test', ttl)).rejects.toMatchObject({
        code: 'E_SCHEDULE_INVALID_LOCK_TTL',
      } satisfies Partial<ReamError>)
    }
  })

  it('opportunistic sweep prunes expired entries when the map grows past the threshold', async () => {
    // Seed 300 expired entries (threshold is 256). The next acquire
    // triggers a sweep; all expired entries should be gone afterward,
    // leaving only the newly-acquired one.
    for (let i = 0; i < 300; i++) {
      backend.__setExpiryForTesting(`expired-${i}`, Date.now() - 1000)
    }
    expect(backend.__sizeForTesting()).toBe(300)
    expect(await backend.acquire('fresh', 60_000)).toBe(true)
    expect(backend.__sizeForTesting()).toBe(1)
  })
})
