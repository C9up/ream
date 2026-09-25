import { describe, expect, it } from 'vitest'
import {
  databaseCollector,
  exceptionCollector,
  memoryCollector,
  type QueryBag,
  requestCollector,
} from '../../src/profiler/collectors.js'
import { MemoryProfileStore } from '../../src/profiler/MemoryProfileStore.js'
import { Profiler } from '../../src/profiler/Profiler.js'

/**
 * One profile per request, and the token that finds it again.
 *
 * The case worth testing is attribution: a SQL query is reported by a listener
 * the data layer calls, with no idea which request caused it. On a server
 * answering three at once, putting each one back where it belongs is the whole
 * job — so that is what most of this measures.
 */

/** An emitter, in the shape the collector asks for. */
class FakeEvents {
  readonly #listeners = new Map<string, Array<(payload: unknown) => void>>()

  on(event: string, listener: (payload: unknown) => void): this {
    const existing = this.#listeners.get(event) ?? []
    existing.push(listener)
    this.#listeners.set(event, existing)
    return this
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(payload)
  }
}

function build(): { profiler: Profiler; events: FakeEvents; store: MemoryProfileStore } {
  const events = new FakeEvents()
  let profiler: Profiler
  const database = databaseCollector(events, () => profiler.current<QueryBag>('database'))
  const collectors = [requestCollector(), database, exceptionCollector(), memoryCollector()]
  const store = new MemoryProfileStore(collectors)
  profiler = new Profiler(collectors, store)
  return { profiler, events, store }
}

const GET = { method: 'GET', url: '/orders' }
const ok = () => ({ status: 200 })

describe('profiler', () => {
  it('records a request and hands back a token that finds it', async () => {
    const { profiler, store } = build()

    const { token } = await profiler.profile(GET, async () => 'body', ok)

    const profile = store.find(token)
    expect(profile?.method).toBe('GET')
    expect(profile?.url).toBe('/orders')
    expect(profile?.status).toBe(200)
    expect(profile?.duration).toBeGreaterThanOrEqual(0)
  })

  it('attributes a query to the request that caused it', async () => {
    const { profiler, events, store } = build()

    const { token } = await profiler.profile(
      GET,
      async () => {
        events.emit('db:query', { sql: 'select 1', bindings: [], duration: 3 })
        events.emit('db:query', { sql: 'select 2', bindings: [7], duration: 1.5 })
        return null
      },
      ok,
    )

    const database = store.find(token)?.data.database
    expect(database?.total).toBe(2)
    expect(database?.duration).toBe(4.5)
  })

  it('keeps two concurrent requests apart', async () => {
    // The reason this uses an async store at all. Interleaved on purpose: a
    // naive "current request" variable passes the sequential test and puts
    // every query on the last request to start.
    const { profiler, events, store } = build()

    const slow = profiler.profile(
      { method: 'GET', url: '/slow' },
      async () => {
        events.emit('db:query', { sql: 'slow-1', bindings: [], duration: 1 })
        await new Promise((resolve) => setTimeout(resolve, 20))
        events.emit('db:query', { sql: 'slow-2', bindings: [], duration: 1 })
        return null
      },
      ok,
    )
    const quick = profiler.profile(
      { method: 'GET', url: '/quick' },
      async () => {
        events.emit('db:query', { sql: 'quick-1', bindings: [], duration: 1 })
        return null
      },
      ok,
    )

    const [slowDone, quickDone] = await Promise.all([slow, quick])

    const slowQueries = store.find(slowDone.token)?.data.database
    const quickQueries = store.find(quickDone.token)?.data.database
    expect(slowQueries?.total).toBe(2)
    expect(quickQueries?.total).toBe(1)
  })

  it('ignores a query fired outside any request', async () => {
    // A console command, a boot-time warm-up. There is no request to bill it
    // to, and inventing one would make a profile lie.
    const { profiler, events, store } = build()
    events.emit('db:query', { sql: 'from a command', bindings: [], duration: 9 })

    const { token } = await profiler.profile(GET, async () => null, ok)

    expect(store.find(token)?.data.database?.total).toBe(0)
  })

  it('keeps counting past the cap, and says it stopped listing', async () => {
    // A loop issuing ten thousand queries is the bug this panel exists to
    // show; keeping all ten thousand would take the dev server with it.
    const { profiler, events, store } = build()

    const { token } = await profiler.profile(
      GET,
      async () => {
        for (let n = 0; n < 600; n++) {
          events.emit('db:query', { sql: `select ${n}`, bindings: [], duration: 0.1 })
        }
        return null
      },
      ok,
    )

    const database = store.find(token)?.data.database
    expect(database?.total).toBe(600)
    expect(database?.queries).toHaveLength(500)
    expect(database?.capped).toBe(true)
  })

  it('records the statement that threw', async () => {
    const { profiler, events, store } = build()

    const { token } = await profiler.profile(
      GET,
      async () => {
        events.emit('db:query', {
          sql: 'select * from nope',
          bindings: [],
          duration: 2,
          error: new Error('no such table: nope'),
        })
        return null
      },
      ok,
    )

    const queries = store.find(token)?.data.database?.queries
    expect(Array.isArray(queries) && queries[0]).toMatchObject({
      error: 'no such table: nope',
    })
  })

  it('never lets a broken collector break the request', async () => {
    // A panel that throws is a missing panel, not a 500.
    const store = new MemoryProfileStore([])
    const profiler = new Profiler(
      [
        {
          name: 'broken',
          start: () => {
            throw new Error('start failed')
          },
          finish: () => {
            throw new Error('finish failed')
          },
        },
      ],
      store,
    )

    const { result, token } = await profiler.profile(GET, async () => 'still answered', ok)

    expect(result).toBe('still answered')
    expect(store.find(token)?.data.broken).toEqual({})
  })

  it('records the request that threw, and still throws', async () => {
    // The profile you most want to look at. Losing it would mean the profiler
    // goes quiet exactly when something broke.
    const { profiler, events, store } = build()
    let status = 200

    await expect(
      profiler.profile(
        GET,
        async () => {
          events.emit('db:query', { sql: 'select 1', bindings: [], duration: 2 })
          status = 500
          throw new Error('boom')
        },
        () => ({ status }),
      ),
    ).rejects.toThrow('boom')

    const profile = store.recent()[0]
    expect(profile?.status).toBe(500)
    const saved = store.find(profile?.token ?? '')
    expect(saved?.data.exception).toMatchObject({ name: 'Error', message: 'boom' })
    // …and what it had done before it broke is still there.
    expect(saved?.data.database?.total).toBe(1)
  })

  it('reports a thrown value that is not an Error', async () => {
    const { profiler, store } = build()

    await expect(
      profiler.profile(GET, async () => Promise.reject('just a string'), ok),
    ).rejects.toBe('just a string')

    const token = store.recent()[0]?.token ?? ''
    expect(store.find(token)?.data.exception).toMatchObject({ message: 'just a string' })
  })
})

describe('profiler > the store', () => {
  it('keeps the newest and drops the oldest past its bound', () => {
    const store = new MemoryProfileStore([], 3)
    for (let n = 0; n < 5; n++) {
      store.save({
        token: `t${n}`,
        time: n,
        method: 'GET',
        url: `/${n}`,
        status: 200,
        duration: 1,
        data: {},
      })
    }

    expect(store.find('t0')).toBeUndefined()
    expect(store.find('t4')).toBeDefined()
    expect(store.recent().map((profile) => profile.token)).toEqual(['t4', 't3', 't2'])
  })

  it('asks each collector for its badge', () => {
    const collectors = [
      {
        name: 'database',
        badge: (data: Record<string, unknown>) => `${String(data.total)} queries`,
        start: () => ({}),
        finish: () => ({}),
      },
    ]
    const store = new MemoryProfileStore(collectors)
    store.save({
      token: 'abc',
      time: 1,
      method: 'GET',
      url: '/',
      status: 200,
      duration: 1,
      data: { database: { total: 12 } },
    })

    expect(store.recent()[0]?.badges).toEqual({ database: '12 queries' })
  })

  it('forgets everything when asked', () => {
    const store = new MemoryProfileStore([])
    store.save({ token: 'a', time: 1, method: 'GET', url: '/', status: 200, duration: 1, data: {} })
    store.clear()
    expect(store.recent()).toEqual([])
  })
})
