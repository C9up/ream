import { describe, expect, it } from 'vitest'
import { databaseCollector, type QueryBag } from '../../src/profiler/collectors.js'
import { profilerEndpoint } from '../../src/profiler/endpoint.js'
import { MemoryProfileStore } from '../../src/profiler/MemoryProfileStore.js'
import { Profiler } from '../../src/profiler/Profiler.js'
import { escapeHtml, renderProfileList, renderProfilePage } from '../../src/profiler/render.js'
import { toolbarScript } from '../../src/profiler/toolbar.js'
import type { Profile } from '../../src/profiler/types.js'

/**
 * What the toolbar and the profiler read from, and what they render.
 *
 * A profiler renders the URL someone asked for, the SQL a query ran and the
 * message an error carried — every one of them reachable by whoever sent the
 * request. Most of what is checked below is that none of it can become script
 * in the developer's own browser.
 */

function recorded(): { profiler: Profiler; store: MemoryProfileStore } {
  let profiler: Profiler
  const collectors = [
    databaseCollector({ on: () => undefined }, () => profiler.current<QueryBag>('database')),
  ]
  const store = new MemoryProfileStore(collectors)
  profiler = new Profiler(collectors, store)
  return { profiler, store }
}

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    token: 'abc123',
    time: Date.UTC(2026, 0, 1),
    method: 'GET',
    url: '/orders',
    status: 200,
    duration: 12.5,
    data: {},
    ...overrides,
  }
}

/** A context in the shape the endpoint asks for. */
function context(url: string) {
  const recordedResponse: { status: number; headers: Record<string, string>; body: unknown } = {
    status: 200,
    headers: {},
    body: undefined,
  }
  let nexted = false
  return {
    recordedResponse,
    wasNexted: () => nexted,
    next: async () => {
      nexted = true
    },
    ctx: {
      request: { url: () => url },
      response: {
        header: (name: string, value: string) => {
          recordedResponse.headers[name] = value
        },
        send: (body: unknown) => {
          recordedResponse.body = body
        },
        status: (code: number) => {
          recordedResponse.status = code
        },
      },
    },
  }
}

describe('profiler > the endpoint', () => {
  it('leaves every other request alone', async () => {
    const { profiler } = recorded()
    const { ctx, next, wasNexted, recordedResponse } = context('/orders')

    await profilerEndpoint(profiler)(ctx, next)

    expect(wasNexted()).toBe(true)
    expect(recordedResponse.body).toBeUndefined()
  })

  it('serves one profile as JSON, uncached', async () => {
    const { profiler, store } = recorded()
    store.save(profile())
    const { ctx, next, recordedResponse } = context('/__ream/profiler/abc123.json')

    await profilerEndpoint(profiler)(ctx, next)

    expect(recordedResponse.headers['content-type']).toBe('application/json')
    // A cached profile would show the previous request's numbers after a reload.
    expect(recordedResponse.headers['cache-control']).toBe('no-store')
    expect(recordedResponse.body).toMatchObject({ token: 'abc123', status: 200 })
  })

  it('answers 404 for a token that aged out', async () => {
    const { profiler } = recorded()
    const { ctx, next, recordedResponse } = context('/__ream/profiler/gone.json')

    await profilerEndpoint(profiler)(ctx, next)

    // A real answer, so the bar stops asking instead of rendering an empty one.
    expect(recordedResponse.status).toBe(404)
  })

  it('serves the history as a page', async () => {
    const { profiler, store } = recorded()
    store.save(profile())
    const { ctx, next, recordedResponse } = context('/__ream/profiler')

    await profilerEndpoint(profiler)(ctx, next)

    expect(recordedResponse.headers['content-type']).toContain('text/html')
    expect(String(recordedResponse.body)).toContain('/orders')
  })

  it('ignores the query string', async () => {
    const { profiler, store } = recorded()
    store.save(profile())
    const { ctx, next, recordedResponse } = context('/__ream/profiler/abc123.json?v=2')

    await profilerEndpoint(profiler)(ctx, next)

    expect(recordedResponse.body).toMatchObject({ token: 'abc123' })
  })
})

describe('profiler > what it renders', () => {
  it('escapes a URL that carries markup', () => {
    // The URL is whatever was requested. A profiler that turned a crafted one
    // into script in the developer's browser would be a hole with a friendly
    // face.
    const page = renderProfilePage(profile({ url: '/search?q=<script>alert(1)</script>' }), {})

    expect(page).not.toContain('<script>alert(1)</script>')
    expect(page).toContain('&lt;script&gt;')
  })

  it('escapes SQL and an error message', () => {
    const page = renderProfilePage(
      profile({
        data: {
          database: {
            total: 1,
            duration: 3,
            queries: [
              {
                sql: "select '<img onerror=alert(1)>'",
                bindings: ['</td><script>x</script>'],
                duration: 3,
                error: '<b>nope</b>',
              },
            ],
          },
        },
      }),
      {},
    )

    expect(page).not.toContain('<img onerror')
    expect(page).not.toContain('<script>x</script>')
    expect(page).not.toContain('<b>nope</b>')
  })

  it('escapes an exception message and its stack', () => {
    const page = renderProfilePage(
      profile({
        data: { exception: { name: 'Error', message: '<script>1</script>', stack: '<hr>' } },
      }),
      {},
    )

    expect(page).not.toContain('<script>1</script>')
    expect(page).not.toContain('<hr>')
  })

  it('marks a slow query and a failed status', () => {
    const page = renderProfilePage(
      profile({
        status: 500,
        data: {
          database: {
            total: 1,
            duration: 120,
            queries: [{ sql: 'select 1', bindings: [], duration: 120 }],
          },
        },
      }),
      {},
    )

    expect(page).toContain('slow')
    expect(page).toContain('120.00 ms')
  })

  it('says when the listing stopped short of the count', () => {
    const page = renderProfilePage(
      profile({ data: { database: { total: 600, duration: 1, queries: [], capped: true } } }),
      {},
    )
    expect(page).toContain('600')
  })

  it('escapes a token in the not-found notice', () => {
    const list = renderProfileList([], '<script>alert(1)</script>')
    expect(list).not.toContain('<script>alert(1)</script>')
  })

  it('escapes the quotes, not only the angle brackets', () => {
    expect(escapeHtml(`" ' & < >`)).toBe('&quot; &#39; &amp; &lt; &gt;')
  })
})

describe('profiler > the injected bar', () => {
  it('carries its own token, because a page cannot read its own headers', () => {
    const script = toolbarScript('deadbeef')
    expect(script).toContain('"token":"deadbeef"')
    expect(script).toContain('/__ream/profiler')
  })

  it('carries the nonce, or a CSP drops it silently', () => {
    expect(toolbarScript('abc', 'n0nce')).toContain('nonce="n0nce"')
  })

  it('cannot be broken out of by a nonce carrying a quote', () => {
    const script = toolbarScript('abc', 'a"onload="alert(1)')
    expect(script).not.toContain('onload="alert(1)"')
    expect(script).toContain('&quot;')
  })

  it('styles through the CSSOM, which no CSP blocks', () => {
    // A `<style>` element inserted at runtime is inline style: under a plain
    // `default-src 'self'` it is dropped with no error, and the bar renders as
    // a stack of grey text with nothing saying why.
    const script = toolbarScript('abc')
    expect(script).toContain('style.cssText')
    expect(script).not.toContain("createElement('style')")
  })

  it('builds its nodes rather than writing markup', () => {
    // textContent, not innerHTML: whatever the bar shows came from a request.
    const script = toolbarScript('abc')
    expect(script).toContain('textContent')
    expect(script).not.toContain('innerHTML')
  })
})
