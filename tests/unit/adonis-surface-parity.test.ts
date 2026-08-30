/**
 * Members AdonisJS exposes that ream did not, found by diffing the published
 * `.d.ts` surface class by class rather than by working from a report.
 *
 * None of them changes behaviour on their own — they are the introspection an
 * app, a debug screen or a migrated call site reaches for and used to find
 * missing.
 */
import { describe, expect, it } from 'vitest'
import { Emitter } from '../../src/events/Emitter.js'
import { FakeBus } from '../../src/events/testing/FakeBus.js'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { RawRequest } from '../../src/http/Request.js'
import { Router } from '../../src/router/Router.js'
import { CookieSigner } from '../../src/security/CookieSigner.js'

function ctx(path = '/users/1'): HttpContext {
  const raw: RawRequest = { method: 'GET', path, query: '', headers: {}, body: '' }
  return new HttpContext(
    'req-1',
    raw,
    {},
    { pattern: '/users/:id', name: 'users.show', middleware: [] },
  )
}

describe('Router introspection (AdonisJS parity)', () => {
  it('groups routes by domain, with `root` for the undomained ones', () => {
    const router = new Router()
    router.get('/a', () => {})
    router.get('/b', () => {}).domain('blog.example.com')

    const json = router.toJSON()
    expect(Object.keys(json).sort()).toEqual(['blog.example.com', 'root'])
    expect(json.root?.map((r) => r.path)).toEqual(['/a'])
  })

  it('reports whether any route is domain-scoped', () => {
    const plain = new Router()
    plain.get('/a', () => {})
    expect(plain.usingDomains).toBe(false)

    const scoped = new Router()
    scoped.get('/b', () => {}).domain('blog.example.com')
    expect(scoped.usingDomains).toBe(true)
  })

  it('commit() builds the lookup index up front', () => {
    const router = new Router()
    router.get('/a', () => {})

    // The index is lazy, so this only moves the cost from the first request to
    // the end of boot.
    expect(router.commited).toBe(false)
    router.commit()
    expect(router.commited).toBe(true)
  })

  it('registering a route invalidates the index again', () => {
    const router = new Router()
    router.get('/a', () => {})
    router.commit()

    router.get('/b', () => {})
    expect(router.commited).toBe(false)
  })
})

describe('HttpContext.inspect (AdonisJS parity)', () => {
  it('summarises the request in one line', () => {
    expect(ctx().inspect()).toBe('GET /users/1 (users.show)')
  })

  it('falls back to the pattern when the route has no name', () => {
    const raw: RawRequest = { method: 'POST', path: '/x', query: '', headers: {}, body: '' }
    const bare = new HttpContext('r', raw, {}, { pattern: '/x', middleware: [] })
    expect(bare.inspect()).toBe('POST /x (/x)')
  })
})

describe('back-references (AdonisJS request.ctx / response.ctx)', () => {
  it('both sides point back at their context', () => {
    const c = ctx()
    expect(c.request.ctx).toBe(c)
    expect(c.response.ctx).toBe(c)
  })
})

describe('Emitter.eventsListeners (AdonisJS parity)', () => {
  it('lists every event with its listeners', () => {
    const e = new Emitter(new FakeBus() as never)
    const listener = () => {}
    e.on('a', listener)
    e.on('b', () => {})

    const map = e.eventsListeners
    expect([...map.keys()].sort()).toEqual(['a', 'b'])
    expect(map.get('a')).toEqual([listener])
  })

  it('hands back copies, so inspecting cannot unsubscribe', async () => {
    const e = new Emitter(new FakeBus() as never)
    let ran = false
    e.on('a', () => {
      ran = true
    })

    e.eventsListeners.get('a')?.splice(0)
    await e.emit('a', {})

    expect(ran).toBe(true)
  })
})

describe('Encryption.base64 (AdonisJS parity)', () => {
  const signer = new CookieSigner('a-sufficiently-long-app-key-for-tests')

  it('round-trips url-safe, unpadded', () => {
    const encoded = signer.base64.encode('a value with / and + and =')
    expect(encoded).not.toMatch(/[+/=]/)
    expect(signer.base64.decode(encoded)).toBe('a value with / and + and =')
  })

  it('answers null rather than handing back mangled bytes', () => {
    expect(signer.base64.decode('not valid base64!!')).toBe(null)
  })
})

describe('Router.builder — the fluent UrlBuilder (AdonisJS parity)', () => {
  function router(): Router {
    const r = new Router()
    r.get('/users/:id', () => {}).as('users.show')
    r.get('/posts/:id?', () => {}).as('posts.show')
    return r
  }

  it('assembles params and a query string', () => {
    // urlFor takes everything at once; this is the form for when the pieces
    // arrive separately.
    expect(router().builder().params({ id: '1' }).qs({ tab: 'posts' }).make('users.show')).toBe(
      '/users/1?tab=posts',
    )
  })

  it('prefixes with a domain', () => {
    expect(
      router().builderForDomain('https://acme.test').params({ id: '2' }).make('users.show'),
    ).toBe('https://acme.test/users/2')
  })

  it('takes a literal path when route lookup is off', () => {
    expect(router().builder().disableRouteLookup().make('/raw/path')).toBe('/raw/path')
  })

  it('fails the same way urlFor does on a missing param', () => {
    expect(() => router().builder().make('users.show')).toThrow(/missing params/)
  })

  it('urlBuilder is the property name for the same thing', () => {
    expect(router().urlBuilder.params({ id: '3' }).make('users.show')).toBe('/users/3')
  })
})

describe('Router.parsePattern (AdonisJS parity)', () => {
  it('lists the params a pattern declares, in order', () => {
    const r = new Router()
    expect(r.parsePattern('/a/:one/b/:two')).toEqual([
      { name: 'one', optional: false },
      { name: 'two', optional: false },
    ])
  })

  it('reports an optional param as optional, without the marker in the name', () => {
    const r = new Router()
    expect(r.parsePattern('/posts/:id?')).toEqual([{ name: 'id', optional: true }])
  })

  it('answers empty for a static pattern', () => {
    expect(new Router().parsePattern('/health')).toEqual([])
  })
})

describe('Router > a host matches case-insensitively', () => {
  function scoped() {
    const router = new Router()
    router.get('/a', () => {}).domain('api.example.com')
    router.get('/b', () => {}).domain('*.example.com')
    router.commit()
    return router
  }

  it('matches an exact domain whatever case the client sent', () => {
    // A hostname is case-insensitive (RFC 4343), and some proxies and older
    // clients do send it uppercased. Comparing verbatim sends that request to
    // a fallback, or to a 404.
    const router = scoped()

    expect(router.match('GET', '/a', 'api.example.com')).toBeDefined()
    expect(router.match('GET', '/a', 'API.EXAMPLE.COM')).toBeDefined()
    expect(router.match('GET', '/a', 'Api.Example.Com')).toBeDefined()
  })

  it('matches a wildcard domain the same way', () => {
    const router = scoped()

    expect(router.match('GET', '/b', 'blog.example.com')).toBeDefined()
    expect(router.match('GET', '/b', 'BLOG.EXAMPLE.COM')).toBeDefined()
  })

  it('still refuses a host the pattern does not cover', () => {
    const router = scoped()

    expect(router.match('GET', '/a', 'api.evil.test')).toBeUndefined()
    expect(router.match('GET', '/b', 'example.com')).toBeUndefined()
  })

  it('ignores the port', () => {
    expect(scoped().match('GET', '/a', 'API.example.com:8080')).toBeDefined()
  })
})
