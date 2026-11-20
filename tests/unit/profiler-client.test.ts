import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Emitter } from '../../src/events/Emitter.js'
import { EventBus } from '../../src/events/native.js'
import { TOOLBAR_CSS, TOOLBAR_JS } from '../../src/profiler/client.generated.js'
import {
  type CacheBag,
  cacheCollector,
  databaseCollector,
  type EventBag,
  eventsCollector,
  type LogBag,
  logCollector,
  type QueryBag,
} from '../../src/profiler/collectors.js'
import { createProfiler } from '../../src/profiler/index.js'
import { MemoryProfileStore } from '../../src/profiler/MemoryProfileStore.js'
import { Profiler } from '../../src/profiler/Profiler.js'
import { preview, REDACTED } from '../../src/profiler/preview.js'

const CLIENT = join(import.meta.dirname, '..', '..', 'src', 'profiler', 'client')

/** An emitter with the two hooks the collectors read, and nothing else. */
class FakeEvents {
  readonly #listeners = new Map<string, Array<(payload: unknown) => void>>()
  readonly #taps: Array<(event: string, data: unknown) => void> = []
  on(event: string, listener: (payload: unknown) => void): void {
    const list = this.#listeners.get(event) ?? []
    list.push(listener)
    this.#listeners.set(event, list)
  }
  tap(observer: (event: string, data: unknown) => void): void {
    this.#taps.push(observer)
  }
  emit(event: string, payload: unknown): void {
    for (const tap of this.#taps) tap(event, payload)
    for (const listener of this.#listeners.get(event) ?? []) listener(payload)
  }
}

describe('profiler > the browser client', () => {
  it('is embedded as it is written: rerun scripts/build-profiler-client.mjs after an edit', () => {
    expect(TOOLBAR_JS).toBe(readFileSync(join(CLIENT, 'toolbar.js'), 'utf8'))
    expect(TOOLBAR_CSS).toBe(readFileSync(join(CLIENT, 'toolbar.css'), 'utf8'))
  })

  it('builds its nodes rather than writing markup', () => {
    // textContent, not innerHTML: whatever the bar shows came from a request.
    expect(TOOLBAR_JS).toContain('textContent')
    expect(TOOLBAR_JS).not.toContain('innerHTML')
    expect(TOOLBAR_JS).not.toContain('insertAdjacentHTML')
  })

  it('styles through a same-origin stylesheet and the CSSOM, never inline style', () => {
    // A `<style>` element or a `style` attribute is inline style, which a
    // `style-src` policy without 'unsafe-inline' drops with no error.
    expect(TOOLBAR_JS).toContain('/_assets/toolbar.css')
    expect(TOOLBAR_JS).toContain('style.cssText')
    expect(TOOLBAR_JS).not.toContain("createElement('style')")
    expect(TOOLBAR_JS).not.toMatch(/setAttribute\(\s*'style'/)
  })

  it('keeps the page clear of the bar, and remembers its state', () => {
    expect(TOOLBAR_JS).toContain('paddingBottom')
    // A page whose shell is the viewport is not padded (it would scroll the
    // document), and the bar's height is exposed for such a shell to use.
    expect(TOOLBAR_JS).toContain('scroller.scrollHeight > window.innerHeight')
    expect(TOOLBAR_JS).toContain("'--ream-toolbar-height'")
    expect(TOOLBAR_JS).toContain('localStorage')
  })

  it('follows the requests the page makes after it loaded', () => {
    expect(TOOLBAR_JS).toContain('window.fetch =')
    expect(TOOLBAR_JS).toContain('XMLHttpRequest.prototype.open')
    expect(TOOLBAR_JS).toContain('x-debug-token')
  })
})

describe('profiler > what the panels record', () => {
  function profilerWith(events: FakeEvents): Profiler {
    let profiler: Profiler
    const collectors = [
      databaseCollector(events, () => profiler.current<QueryBag>('database')),
      logCollector(events, () => profiler.current<LogBag>('logs')),
      eventsCollector(events, () => profiler.current<EventBag>('events')),
      cacheCollector(events, () => profiler.current<CacheBag>('cache')),
    ]
    profiler = new Profiler(collectors, new MemoryProfileStore(collectors))
    return profiler
  }

  it('places each query on the timeline and counts the ones that failed', async () => {
    const events = new FakeEvents()
    const profiler = profilerWith(events)
    const { token } = await profiler.profile(
      { method: 'GET', url: '/' },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 15))
        events.emit('db:query', { sql: 'select 1', bindings: [], duration: 5 })
        events.emit('db:query', { sql: 'boom', bindings: [], duration: 1, error: new Error('no') })
      },
      () => ({ status: 200 }),
    )
    const db = profiler.store.find(token)?.data.database
    expect(db?.failed).toBe(1)
    const queries = Array.isArray(db?.queries) ? db.queries : []
    const first = queries[0]
    // It ended about 15 ms in and took 5: it started about 10 ms in.
    expect(
      typeof first === 'object' && first !== null ? Reflect.get(first, 'at') : -1,
    ).toBeGreaterThan(5)
  })

  it('counts errors and warnings, and keeps a line context apart from its message', async () => {
    const events = new FakeEvents()
    const profiler = profilerWith(events)
    const { token } = await profiler.profile(
      { method: 'GET', url: '/' },
      async () => {
        events.emit('log:line', { level: 'error', message: 'failed', orderId: 7 })
        events.emit('log:line', { level: 'warn', msg: 'slow' })
        events.emit('log:line', { level: 'info', message: 'ok' })
      },
      () => ({ status: 200 }),
    )
    const logs = profiler.store.find(token)?.data.logs
    expect(logs?.errors).toBe(1)
    expect(logs?.warnings).toBe(1)
    expect(logs?.lines).toMatchObject([
      { level: 'error', message: 'failed', context: { orderId: 7 } },
      { level: 'warn', message: 'slow' },
      { level: 'info', message: 'ok' },
    ])
  })

  it('records the events a request emitted, not the ones with a panel of their own', async () => {
    const events = new FakeEvents()
    const profiler = profilerWith(events)
    const { token } = await profiler.profile(
      { method: 'GET', url: '/' },
      async () => {
        events.emit('order.created', { id: 7, password: 'hunter2' })
        events.emit('cache:hit', { key: 'user:1', value: 1, store: 'memory' })
        events.emit('db:query', { sql: 'select 1', bindings: [], duration: 1 })
        events.emit('log:line', { level: 'info', message: 'x' })
      },
      () => ({ status: 200 }),
    )
    events.emit('order.created', { id: 'outside any request' })
    const panel = profiler.store.find(token)?.data.events
    expect(panel?.total).toBe(1)
    expect(panel?.events).toMatchObject([
      { name: 'order.created', data: { id: 7, password: REDACTED } },
    ])
  })

  it('counts every cache operation by kind and by store, timed from when it started', async () => {
    const events = new FakeEvents()
    const profiler = profilerWith(events)
    const { token } = await profiler.profile(
      { method: 'GET', url: '/' },
      async () => {
        events.emit('cache:miss', { key: 'user:1', store: 'redis', duration: 4 })
        events.emit('cache:written', {
          key: 'user:1',
          value: { name: 'Ada' },
          store: 'redis',
          ttl: 300,
          duration: 1.5,
        })
        events.emit('cache:hit', {
          key: 'user:1',
          value: { name: 'Ada' },
          store: 'redis',
          graced: false,
          duration: 0.5,
        })
        events.emit('cache:hit', {
          key: 'stats',
          value: 42,
          store: 'memory',
          graced: true,
          duration: 0.25,
        })
        events.emit('cache:written', {
          key: 'flags',
          value: [],
          store: 'memory',
          ttl: null,
          duration: 0.25,
        })
        events.emit('cache:deleted', { key: 'user:1', store: 'redis', duration: 1 })
        events.emit('cache:expire', { key: 'stats', store: 'memory', duration: 0.5 })
        events.emit('cache:cleared', { store: 'memory', duration: 2 })
      },
      () => ({ status: 200 }),
    )
    events.emit('cache:miss', { key: 'outside any request', store: 'redis', duration: 1 })
    const cache = profiler.store.find(token)?.data.cache
    expect(cache).toMatchObject({
      total: 8,
      duration: 10,
      timed: true,
      hits: 2,
      graced: 1,
      misses: 1,
      writes: 2,
      deletes: 1,
      clears: 1,
      expirations: 1,
      capped: false,
      stores: [
        { name: 'redis', total: 4, hits: 1, misses: 1, writes: 1, deletes: 1, duration: 7 },
        { name: 'memory', total: 4, hits: 1, misses: 0, writes: 1, deletes: 0, duration: 3 },
      ],
    })
    expect(cache?.operations).toMatchObject([
      { operation: 'miss', key: 'user:1', store: 'redis', duration: 4 },
      { operation: 'written', key: 'user:1', ttl: 300, value: { name: 'Ada' } },
      { operation: 'hit', key: 'user:1', value: { name: 'Ada' } },
      { operation: 'hit', key: 'stats', graced: true, value: 42 },
      { operation: 'written', key: 'flags', ttl: null },
      { operation: 'deleted', key: 'user:1' },
      { operation: 'expire', key: 'stats' },
      { operation: 'cleared', store: 'memory', duration: 2 },
    ])
    expect(profiler.collectors.find((c) => c.name === 'cache')?.badge?.(cache ?? {})).toBe(
      '8 cache operations · 10 ms',
    )
  })

  it('places an operation on the timeline where it started, not where it was reported', async () => {
    const events = new FakeEvents()
    const profiler = profilerWith(events)
    const { token } = await profiler.profile(
      { method: 'GET', url: '/' },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 25))
        // Both reported now; the first took 15 ms, so it began 15 ms earlier.
        events.emit('cache:miss', { key: 'slow', store: 'memory', duration: 15 })
        events.emit('cache:hit', { key: 'quick', store: 'memory', duration: 0 })
      },
      () => ({ status: 200 }),
    )
    const operations = profiler.store.find(token)?.data.cache?.operations
    const [slow, quick] = Array.isArray(operations) ? operations : []
    const gap = Number(quick?.at) - Number(slow?.at)
    expect(gap).toBeGreaterThanOrEqual(14.5)
    expect(gap).toBeLessThan(16)
  })

  it('hides a value cached under a key that names a secret, and secret fields of any value', async () => {
    const events = new FakeEvents()
    const profiler = profilerWith(events)
    const { token } = await profiler.profile(
      { method: 'GET', url: '/' },
      async () => {
        events.emit('cache:written', {
          key: 'oauth:token:42',
          value: 'ya29.secret',
          store: 'redis',
        })
        events.emit('cache:hit', {
          key: 'user:42',
          value: { id: 42, password: 'hunter2' },
          store: 'redis',
        })
      },
      () => ({ status: 200 }),
    )
    expect(profiler.store.find(token)?.data.cache?.operations).toMatchObject([
      { key: 'oauth:token:42', value: REDACTED },
      { key: 'user:42', value: { id: 42, password: REDACTED } },
    ])
  })

  it('keeps counting past the listing cap, and still lists a cache that reports no time', async () => {
    const events = new FakeEvents()
    const profiler = profilerWith(events)
    const { token } = await profiler.profile(
      { method: 'GET', url: '/' },
      async () => {
        for (let n = 0; n < 350; n += 1) events.emit('cache:hit', { key: `k${n}`, store: 'memory' })
      },
      () => ({ status: 200 }),
    )
    const cache = profiler.store.find(token)?.data.cache
    expect(cache).toMatchObject({ total: 350, hits: 350, timed: false, capped: true })
    expect(Array.isArray(cache?.operations) ? cache.operations.length : 0).toBe(300)
    expect(profiler.collectors.find((c) => c.name === 'cache')?.badge?.(cache ?? {})).toBe(
      '350 cache operations',
    )
  })

  it('gives a request that never touched the cache no cache panel', async () => {
    const events = new FakeEvents()
    const profiler = profilerWith(events)
    const { token } = await profiler.profile(
      { method: 'GET', url: '/' },
      async () => {
        events.emit('order.created', { id: 1 })
      },
      () => ({ status: 200 }),
    )
    expect(profiler.store.find(token)?.data.cache).toEqual({})
  })

  it('wires the events panel when the emitter can be tapped, and only then', () => {
    const tapped = createProfiler(new FakeEvents())
    expect(tapped.collectors.map((c) => c.name)).toContain('events')
    expect(tapped.collectors.map((c) => c.name)).toContain('cache')
    const plain = createProfiler({ on: () => undefined })
    expect(plain.collectors.map((c) => c.name)).not.toContain('events')
    expect(plain.collectors.map((c) => c.name)).not.toContain('cache')
    expect(plain.collectors.map((c) => c.name)).toContain('app')
  })
})

describe('profiler > previews', () => {
  it('hides the value of a key that names a secret', () => {
    expect(
      preview({
        email: 'a@b.c',
        password: 'x',
        apiKey: 'k',
        nested: { authorization: 'Bearer y' },
      }),
    ).toEqual({
      email: 'a@b.c',
      password: REDACTED,
      apiKey: REDACTED,
      nested: { authorization: REDACTED },
    })
  })

  it('cuts a cycle, a long string and a long list', () => {
    const node: Record<string, unknown> = { name: 'root' }
    node.self = node
    expect(preview(node)).toEqual({ name: 'root', self: '[circular]' })
    expect(String(preview('x'.repeat(1000)))).toContain('(1000 chars)')
    const list = preview(Array.from({ length: 100 }, (_, i) => i))
    expect(Array.isArray(list) ? list.at(-1) : undefined).toBe('… 75 more')
  })

  it('stops at a depth, and names the class it stopped at', () => {
    class Deep {
      inner = { a: { b: { c: { d: 1 } } } }
    }
    expect(JSON.stringify(preview(new Deep()))).toContain('[Object]')
    expect(preview(new Deep())).toMatchObject({ '@type': 'Deep' })
  })

  it('keeps a bigint, a date and an error readable', () => {
    expect(preview({ n: 10n, d: new Date(0), e: new TypeError('bad') })).toEqual({
      n: '10n',
      d: '1970-01-01T00:00:00.000Z',
      e: { name: 'TypeError', message: 'bad' },
    })
  })
})

describe('Emitter > tap', () => {
  function emitter(): Emitter {
    return new Emitter(new EventBus())
  }

  it('sees every emission synchronously, ahead of the listeners', async () => {
    const events = emitter()
    const seen: string[] = []
    events.tap((name) => seen.push(`tap:${name}`))
    events.on('order.created', () => {
      seen.push('listener')
    })
    void events.emit('order.created', { id: 1 })
    // Seen at the call, before anything was awaited.
    expect(seen[0]).toBe('tap:order.created')
    await events.emit('order.created', { id: 2 })
    expect(seen).toEqual(['tap:order.created', 'listener', 'tap:order.created', 'listener'])
  })

  it('cannot break the emission, and stops when unsubscribed', async () => {
    const events = emitter()
    const seen: string[] = []
    const off = events.tap(() => {
      throw new Error('broken observer')
    })
    events.on('a', () => {
      seen.push('a')
    })
    await events.emit('a', null)
    off()
    await events.emit('a', null)
    expect(seen).toEqual(['a', 'a'])
  })

  it('still sees an event that is faked', async () => {
    const events = emitter()
    const seen: string[] = []
    events.tap((name) => seen.push(name))
    events.fake()
    await events.emit('mail:sent', {})
    expect(seen).toEqual(['mail:sent'])
  })
})
