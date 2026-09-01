import { describe, expect, it, vi } from 'vitest'
import { RedisDriver } from '../../src/session/drivers/RedisDriver.js'

function fakeClient() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
      return 'OK'
    }),
    del: vi.fn(async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key]
      for (const k of keys) store.delete(k)
      return keys.length
    }),
    expire: vi.fn(async () => 1),
  }
}

describe('session RedisDriver', () => {
  it('round-trips a session payload', async () => {
    const client = fakeClient()
    const driver = new RedisDriver(client)

    await driver.write('sid', { userId: 42 }, 120)
    expect(await driver.read('sid')).toEqual({ userId: 42 })
  })

  it('namespaces keys so a shared database stays legible', async () => {
    const client = fakeClient()
    await new RedisDriver(client, { prefix: 'app:sess:' }).write('sid', {}, 60)
    expect([...client.store.keys()]).toEqual(['app:sess:sid'])
  })

  it('sets the TTL in the same command as the value', async () => {
    const client = fakeClient()
    await new RedisDriver(client).write('sid', {}, 90)
    // A SET followed by a separate EXPIRE leaves the key immortal if the
    // process dies between the two.
    expect(client.set).toHaveBeenCalledWith('ream:session:sid', '{}', 'EX', 90)
  })

  it('reports an absent session as absent, not as an empty one', async () => {
    expect(await new RedisDriver(fakeClient()).read('never-seen')).toBe(null)
  })

  it('treats a corrupt payload as an absent session', async () => {
    const client = fakeClient()
    client.store.set('ream:session:sid', '{ not json')
    // Throwing here would 500 every request carrying that cookie, with no way
    // for the visitor to recover.
    expect(await new RedisDriver(client).read('sid')).toBe(null)
  })

  it('treats a non-object payload as an absent session', async () => {
    const client = fakeClient()
    client.store.set('ream:session:sid', '"a string"')
    expect(await new RedisDriver(client).read('sid')).toBe(null)
  })

  it('destroys a session', async () => {
    const client = fakeClient()
    const driver = new RedisDriver(client)
    await driver.write('sid', { a: 1 }, 60)
    await driver.destroy('sid')
    expect(await driver.read('sid')).toBe(null)
  })

  it('slides the expiry on touch', async () => {
    const client = fakeClient()
    await new RedisDriver(client).touch('sid', 300)
    expect(client.expire).toHaveBeenCalledWith('ream:session:sid', 300)
  })

  it('resolves its client once, on the first command', async () => {
    let resolved = 0
    const client = fakeClient()
    const driver = new RedisDriver(async () => {
      resolved += 1
      return client
    })

    expect(resolved).toBe(0)
    await Promise.all([driver.read('a'), driver.read('b')])
    expect(resolved).toBe(1)
  })
})

describe('session RedisDriver > a transient connection failure', () => {
  it('retries instead of caching the rejection forever', async () => {
    // The in-flight slot was cleared inside `.then`, so a REJECTED promise
    // stayed in it and every later call handed back that same rejection. One
    // refused connection at boot — Redis still starting, a network blip — and
    // the driver never tried again for the life of the process.
    let attempts = 0
    const resolver = vi.fn(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('ECONNREFUSED')
      return fakeClient()
    })
    const driver = new RedisDriver(resolver)

    await expect(driver.read('sid')).rejects.toThrow('ECONNREFUSED')
    // The second call must reach the resolver again rather than replay the first.
    await expect(driver.read('sid')).resolves.toBeNull()
    expect(attempts).toBe(2)

    // …and once connected, the client is memoised as before.
    await driver.write('sid', { a: 1 })
    expect(await driver.read('sid')).toEqual({ a: 1 })
    expect(attempts).toBe(2)
  })
})
