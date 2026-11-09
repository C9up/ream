/**
 * The lock a second replica needs: without one, every instance runs every
 * scheduled task on every tick.
 */
import { describe, expect, it, vi } from 'vitest'
import type { LockRedisClient, ReamError } from '../../src/index.js'
import { locks, RedisLockBackend } from '../../src/index.js'

/** A Redis double honouring the two commands the backend issues. */
function fakeRedis() {
  const store = new Map<string, { value: string; expiresAt: number }>()
  const calls: unknown[][] = []
  const live = (key: string) => {
    const entry = store.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= Date.now()) {
      store.delete(key)
      return undefined
    }
    return entry
  }
  const client: LockRedisClient & { calls: unknown[][]; store: typeof store } = {
    calls,
    store,
    async set(key, value, ...args) {
      calls.push(['set', key, value, ...args])
      const px = args[args.indexOf('PX') + 1]
      const nx = args.includes('NX')
      if (nx && live(key) !== undefined) return null
      store.set(key, { value, expiresAt: Date.now() + Number(px) })
      return 'OK'
    },
    async eval(_script, _numKeys, ...args) {
      const [key, token] = args as [string, string]
      calls.push(['eval', key, token])
      if (live(key)?.value !== token) return 0
      store.delete(key)
      return 1
    },
  }
  return client
}

describe('RedisLockBackend', () => {
  it('lets one instance in and turns the other away', async () => {
    const redis = fakeRedis()
    const first = new RedisLockBackend(redis)
    const second = new RedisLockBackend(redis)

    expect(await first.acquire('invoices', 60_000)).toBe(true)
    expect(await second.acquire('invoices', 60_000)).toBe(false)
  })

  it('frees the name on release, for whichever instance asks next', async () => {
    const redis = fakeRedis()
    const first = new RedisLockBackend(redis)
    const second = new RedisLockBackend(redis)

    await first.acquire('invoices', 60_000)
    await first.release('invoices')

    expect(await second.acquire('invoices', 60_000)).toBe(true)
  })

  it('does not release a lease that is no longer its own', async () => {
    const redis = fakeRedis()
    const slow = new RedisLockBackend(redis)
    const next = new RedisLockBackend(redis)

    // The first instance takes a short lease and overruns it; the second
    // acquires the freed name and starts running.
    await slow.acquire('invoices', 20)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(await next.acquire('invoices', 60_000)).toBe(true)

    // The overrunning instance now finishes and releases. A plain DEL here
    // would free the lock a task is currently running under, and let a third
    // instance start alongside it.
    await slow.release('invoices')

    expect(redis.store.has('ream:schedule:lock:invoices')).toBe(true)
  })

  it('releases a name it never acquired without touching Redis', async () => {
    const redis = fakeRedis()
    const backend = new RedisLockBackend(redis)

    await expect(backend.release('never-held')).resolves.toBeUndefined()
    expect(redis.calls).toHaveLength(0)
  })

  it('sets the lease with NX and an integer millisecond TTL', async () => {
    const redis = fakeRedis()
    const backend = new RedisLockBackend(redis)

    // A fractional TTL is a protocol error, not a rounding detail.
    await backend.acquire('invoices', 1500.5)

    const [command, key, , px, ttl, nx] = redis.calls[0] as [
      string,
      string,
      string,
      string,
      number,
      string,
    ]
    expect(command).toBe('set')
    expect(key).toBe('ream:schedule:lock:invoices')
    expect(px).toBe('PX')
    expect(Number.isInteger(ttl)).toBe(true)
    expect(nx).toBe('NX')
  })

  it('refuses a TTL that bounds nothing', async () => {
    const backend = new RedisLockBackend(fakeRedis())
    // A lease that expires the instant it is taken lets every instance
    // acquire the same lock — the outcome locking exists to prevent.
    await expect(backend.acquire('invoices', 0)).rejects.toMatchObject({
      code: 'E_SCHEDULE_INVALID_LOCK_TTL',
    } satisfies Partial<ReamError>)
  })

  it('honours a key prefix', async () => {
    const redis = fakeRedis()
    const backend = new RedisLockBackend(redis, { prefix: 'acme:lock:' })

    await backend.acquire('invoices', 60_000)

    expect(redis.store.has('acme:lock:invoices')).toBe(true)
  })

  it('resolves the client once, however many tasks fire', async () => {
    const redis = fakeRedis()
    const resolve = vi.fn(() => redis)
    const backend = new RedisLockBackend(resolve)

    await backend.acquire('a', 60_000)
    await backend.release('a')
    await backend.acquire('b', 60_000)

    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('retries the lookup after the resolver rejected once', async () => {
    const redis = fakeRedis()
    let calls = 0
    const backend = new RedisLockBackend(async () => {
      calls += 1
      if (calls === 1) throw new Error('not ready')
      return redis
    })

    await expect(backend.acquire('invoices', 60_000)).rejects.toThrow('not ready')
    expect(await backend.acquire('invoices', 60_000)).toBe(true)
    // The recovered client is kept: no third lookup.
    await backend.release('invoices')
    expect(calls).toBe(2)
  })

  it('retries the lookup after the resolver threw synchronously', async () => {
    const redis = fakeRedis()
    let calls = 0
    const backend = new RedisLockBackend(() => {
      calls += 1
      if (calls === 1) throw new Error('no connection yet')
      return redis
    })

    await expect(backend.acquire('invoices', 60_000)).rejects.toThrow('no connection yet')
    expect(await backend.acquire('invoices', 60_000)).toBe(true)
  })

  it('surfaces the original error unchanged', async () => {
    const failure = Object.assign(new Error('boom'), { code: 'E_REDIS_DOWN' })
    const backend = new RedisLockBackend(async () => {
      throw failure
    })

    await expect(backend.acquire('invoices', 60_000)).rejects.toBe(failure)
  })

  it('shares one lookup between tasks firing at once, and both see its failure', async () => {
    let calls = 0
    let fail: (error: Error) => void = () => {}
    const backend = new RedisLockBackend(() => {
      calls += 1
      return new Promise<LockRedisClient>((_resolve, reject) => {
        fail = reject
      })
    })

    const first = backend.acquire('a', 60_000)
    const second = backend.acquire('b', 60_000)
    fail(new Error('down'))

    await expect(first).rejects.toThrow('down')
    await expect(second).rejects.toThrow('down')
    expect(calls).toBe(1)
  })
})

describe('locks', () => {
  it('builds the backend each helper names', async () => {
    const redis = fakeRedis()
    expect(locks.redis({ connection: redis })()).toBeInstanceOf(RedisLockBackend)
    expect(await locks.memory()().acquire('a', 1000)).toBe(true)
  })

  it('says what is missing when a connection name has nothing to resolve', async () => {
    // Either quasar is absent, or it is present and nothing registered its
    // provider yet. Both name the thing to fix; neither acquires a lock that
    // does not exist and lets every replica through.
    const backend = locks.redis({ connection: 'main' })()
    await expect(backend.acquire('invoices', 60_000)).rejects.toThrow(/quasar|redis/i)
  })
})
