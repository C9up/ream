import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Emitter } from '../../src/events/Emitter.js'
import { EventBus } from '../../src/events/native.js'
import { TOOLBAR_CSS, TOOLBAR_JS } from '../../src/profiler/client.generated.js'
import {
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
        events.emit('cache:hit', { key: 'user:1', password: 'hunter2' })
        events.emit('db:query', { sql: 'select 1', bindings: [], duration: 1 })
        events.emit('log:line', { level: 'info', message: 'x' })
      },
      () => ({ status: 200 }),
    )
    events.emit('cache:miss', { key: 'outside any request' })
    const panel = profiler.store.find(token)?.data.events
    expect(panel?.total).toBe(1)
    expect(panel?.events).toMatchObject([
      { name: 'cache:hit', data: { key: 'user:1', password: REDACTED } },
    ])
  })

  it('wires the events panel when the emitter can be tapped, and only then', () => {
    const tapped = createProfiler(new FakeEvents())
    expect(tapped.collectors.map((c) => c.name)).toContain('events')
    const plain = createProfiler({ on: () => undefined })
    expect(plain.collectors.map((c) => c.name)).not.toContain('events')
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
