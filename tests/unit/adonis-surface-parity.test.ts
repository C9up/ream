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
import { createHttpKernel, MiddlewareRegistry } from '../../src/index.js'
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

  it('never serves a domain-scoped route to a request that carries no host', () => {
    // An HTTP/1.0 request may omit Host entirely. A missing host must match
    // no domain at all, or the domain restriction is bypassed by leaving the
    // header out.
    const router = new Router()
    router.get('/admin', () => {}).domain('admin.example.com')
    router.get('/tenant/:id', () => {}).domain('*.example.com')
    router.get('/public', () => {})
    router.commit()

    expect(router.match('GET', '/admin', undefined)).toBeUndefined()
    expect(router.match('GET', '/tenant/1', undefined)).toBeUndefined()
    expect(router.match('GET', '/admin', '')).toBeUndefined()
    expect(router.match('GET', '/public', undefined)).toBeDefined()
    expect(router.match('GET', '/admin', 'admin.example.com')).toBeDefined()
  })
})

describe('Router > the matching domain owns the request', () => {
  function tenantRouter() {
    const router = new Router()
    router.get('/dashboard', () => {}).as('root.dashboard')
    router
      .get('/dashboard', () => {})
      .domain('*.app.test')
      .as('tenant.dashboard')
    router.get('/users/:id', () => {}).as('root.user')
    router
      .get('/users/:id', () => {})
      .domain('*.app.test')
      .as('tenant.user')
    router.get('/pricing', () => {}).as('root.pricing')
    router.commit()
    return router
  }

  it('serves the domain-bound route, not the domain-less one on the same static path', () => {
    const match = tenantRouter().match('GET', '/dashboard', 'acme.app.test')
    expect(match?.route.name).toBe('tenant.dashboard')
  })

  it('does the same for a parametric path', () => {
    const match = tenantRouter().match('GET', '/users/7', 'acme.app.test')
    expect(match?.route.name).toBe('tenant.user')
    expect(match?.params).toEqual({ id: '7' })
  })

  it('serves the domain-less routes when no domain matches the host', () => {
    const router = tenantRouter()
    expect(router.match('GET', '/dashboard', 'app.test')?.route.name).toBe('root.dashboard')
    expect(router.match('GET', '/dashboard', undefined)?.route.name).toBe('root.dashboard')
    expect(router.match('GET', '/users/7', 'evil.test')?.route.name).toBe('root.user')
  })

  it('does not fall back to a domain-less route once a domain matched', () => {
    // The host belongs to a tenant: a path only the root domain declares is
    // not that tenant's to serve.
    expect(tenantRouter().match('GET', '/pricing', 'acme.app.test')).toBeUndefined()
    expect(tenantRouter().match('GET', '/pricing', 'app.test')?.route.name).toBe('root.pricing')
  })

  it('a group domain behaves the same way', () => {
    const router = new Router()
    router.get('/', () => {}).as('home')
    router
      .group(() => {
        router.get('/', () => {}).as('admin.home')
      })
      .domain('admin.example.com')
    router.commit()
    expect(router.match('GET', '/', 'admin.example.com')?.route.name).toBe('admin.home')
    expect(router.match('GET', '/', 'www.example.com')?.route.name).toBe('home')
  })

  it('prefers an exact domain over a wildcard covering the same host, whatever the order', () => {
    const router = new Router()
    router
      .get('/', () => {})
      .domain('*.example.com')
      .as('tenant.home')
    router
      .get('/', () => {})
      .domain('admin.example.com')
      .as('admin.home')
    router.commit()
    expect(router.match('GET', '/', 'admin.example.com')?.route.name).toBe('admin.home')
    expect(router.match('GET', '/', 'acme.example.com')?.route.name).toBe('tenant.home')
  })
})

describe('Router > a parameterised domain', () => {
  function tenantRouter() {
    const router = new Router()
    router.get('/dashboard', () => {}).as('root.dashboard')
    router.get('/pricing', () => {}).as('root.pricing')
    router
      .get('/dashboard', () => {})
      .domain(':tenant.app.test')
      .as('tenant.dashboard')
    router
      .get('/users/:id', () => {})
      .domain(':tenant.app.test')
      .as('tenant.user')
    router.commit()
    return router
  }

  it('matches a host whose label fills the parameter, and hands back its value', () => {
    const match = tenantRouter().match('GET', '/dashboard', 'acme.app.test')
    expect(match?.route.name).toBe('tenant.dashboard')
    expect(match?.subdomains).toEqual({ tenant: 'acme' })
  })

  it('keeps path params and domain params apart', () => {
    const match = tenantRouter().match('GET', '/users/7', 'acme.app.test')
    expect(match?.route.name).toBe('tenant.user')
    expect(match?.params).toEqual({ id: '7' })
    expect(match?.subdomains).toEqual({ tenant: 'acme' })
  })

  it('compares the host case-insensitively and ignores the port', () => {
    const match = tenantRouter().match('GET', '/dashboard', 'ACME.App.Test:8080')
    expect(match?.route.name).toBe('tenant.dashboard')
    expect(match?.subdomains).toEqual({ tenant: 'acme' })
  })

  it('fills a parameter with exactly one label', () => {
    // NAMED DEVIATION — upstream's matcher takes everything before the static
    // suffix, so `a.b.app.test` gave `tenant: 'a.b'` and `.app.test` gave an
    // empty tenant. Neither names a tenant.
    const router = tenantRouter()
    expect(router.match('GET', '/dashboard', 'a.b.app.test')?.route.name).toBe('root.dashboard')
    expect(router.match('GET', '/dashboard', '.app.test')?.route.name).toBe('root.dashboard')
    expect(router.match('GET', '/dashboard', 'app.test')?.route.name).toBe('root.dashboard')
    expect(router.match('GET', '/dashboard', 'acme.evil.test')?.route.name).toBe('root.dashboard')
  })

  it('does not fall back to a domain-less route once the parameterised domain matched', () => {
    const router = tenantRouter()
    expect(router.match('GET', '/pricing', 'acme.app.test')).toBeUndefined()
    expect(router.match('GET', '/pricing', 'app.test')?.route.name).toBe('root.pricing')
  })

  it('never serves the domain to a request that carries no host', () => {
    expect(tenantRouter().match('GET', '/dashboard', undefined)?.route.name).toBe('root.dashboard')
    expect(tenantRouter().match('GET', '/users/7', undefined)).toBeUndefined()
  })

  it('takes a parameter in any label, and several of them', () => {
    const router = new Router()
    router
      .get('/', () => {})
      .domain(':tenant.:region.app.test')
      .as('regional')
    router
      .get('/', () => {})
      .domain('api.:tenant.test')
      .as('api')
    router.commit()

    const regional = router.match('GET', '/', 'acme.eu.app.test')
    expect(regional?.route.name).toBe('regional')
    expect(regional?.subdomains).toEqual({ tenant: 'acme', region: 'eu' })
    const api = router.match('GET', '/', 'api.acme.test')
    expect(api?.route.name).toBe('api')
    expect(api?.subdomains).toEqual({ tenant: 'acme' })
  })

  it('a group domain behaves the same way', () => {
    const router = new Router()
    router.get('/', () => {}).as('home')
    router
      .group(() => {
        router.get('/', () => {}).as('tenant.home')
      })
      .domain(':tenant.app.test')
    router.commit()
    const match = router.match('GET', '/', 'acme.app.test')
    expect(match?.route.name).toBe('tenant.home')
    expect(match?.subdomains).toEqual({ tenant: 'acme' })
  })

  it('ranks an exact domain first, then a parameterised one, then a wildcard, whatever the order', () => {
    const router = new Router()
    router
      .get('/', () => {})
      .domain('*.app.test')
      .as('wildcard')
    router
      .get('/', () => {})
      .domain(':tenant.app.test')
      .as('tenant')
    router
      .get('/', () => {})
      .domain('admin.app.test')
      .as('admin')
    router.commit()

    expect(router.match('GET', '/', 'admin.app.test')?.route.name).toBe('admin')
    expect(router.match('GET', '/', 'admin.app.test')?.subdomains).toEqual({})
    expect(router.match('GET', '/', 'acme.app.test')?.route.name).toBe('tenant')
    // Two labels: the parameter takes one, so only the wildcard covers it.
    expect(router.match('GET', '/', 'a.b.app.test')?.route.name).toBe('wildcard')
    expect(router.match('GET', '/', 'a.b.app.test')?.subdomains).toEqual({})
  })

  it('refuses a domain whose parameter has no name', () => {
    const router = new Router()
    router.get('/', () => {}).domain(':.app.test')
    expect(() => router.commit()).toThrow(/E_INVALID_ROUTE_DOMAIN/)
  })

  it('hands the values to the handler as ctx.subdomains', async () => {
    const router = new Router()
    router
      .get('/whoami', (ctx) => {
        ctx.response.json({ subdomains: ctx.subdomains })
      })
      .domain(':tenant.app.test')
    router.get('/whoami', (ctx) => {
      ctx.response.json({ subdomains: ctx.subdomains })
    })
    const kernel = createHttpKernel({ router, middleware: new MiddlewareRegistry() })

    const tenant = await kernel(request('/whoami', 'acme.app.test'))
    expect(JSON.parse(tenant.body)).toEqual({ subdomains: { tenant: 'acme' } })
    const root = await kernel(request('/whoami', 'app.test'))
    expect(JSON.parse(root.body)).toEqual({ subdomains: {} })
  })
})

function request(path: string, host: string) {
  return { method: 'GET', path, query: '', headers: { host, accept: 'application/json' }, body: '' }
}
