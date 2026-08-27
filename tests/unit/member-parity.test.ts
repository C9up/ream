import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import type { EventBus } from '../../src/events/native.js'
import {
  BaseEvent,
  Container,
  Emitter,
  Env,
  EnvValidationException,
  RedirectBuilder,
  Request,
  Response,
  Router,
  Secret,
} from '../../src/index.js'

describe('Secret > members AdonisJS exposes', () => {
  it('redacts through valueOf, so coercion cannot leak the value', () => {
    // `+secret` and `secret == 'x'` reach for valueOf. Without it they fall
    // through to the raw value — the one thing the class exists to prevent.
    const secret = new Secret('super-secret-key')
    expect(secret.valueOf()).toBe('[redacted]')
    expect(`${secret}`).not.toContain('super-secret')
  })

  it('redacts through toLocaleString', () => {
    expect(new Secret('super-secret-key').toLocaleString()).toBe('[redacted]')
  })

  it('maps the value without ever unwrapping it', () => {
    const mapped = new Secret('  key  ').map((v) => v.trim())
    expect(mapped).toBeInstanceOf(Secret)
    expect(mapped.release()).toBe('key')
    expect(mapped.toString()).toBe('[redacted]')
  })

  it('carries a custom redaction keyword through map', () => {
    const mapped = new Secret('value', '***').map((v) => v.toUpperCase())
    expect(mapped.toString()).toBe('***')
  })
})

describe('Env.rules', () => {
  it('validates an arbitrary record, not just process.env', () => {
    const validator = Env.rules({ PORT: Env.schema.number() })
    expect(validator.validate({ PORT: '3333' })).toEqual({ PORT: 3333 })
  })

  it('aggregates every failure rather than stopping at the first', () => {
    const validator = Env.rules({
      PORT: Env.schema.number(),
      HOST: Env.schema.string(),
    })
    try {
      validator.validate({})
      expect.unreachable('should have thrown')
    } catch (error) {
      // Every failure lands in `help`, which is where AdonisJS puts the detail.
      expect(error).toBeInstanceOf(EnvValidationException)
      const help = error instanceof EnvValidationException ? error.help : ''
      expect(help).toContain('PORT')
      expect(help).toContain('HOST')
    }
  })
})

/**
 * A bus that satisfies the interface and records nothing. Written out rather
 * than cast: `new Emitter(fake as never)` is what the older tests do, and it is
 * exactly the cast that let `new Emitter()` — missing its required bus — sit in
 * this file unnoticed.
 */
function silentBus(): EventBus {
  return {
    emit: () => Promise.resolve(''),
    subscribe: () => 0,
    unsubscribe: () => Promise.resolve(),
    onRequest: () => {},
    request: () => Promise.resolve(''),
    matchesWildcard: () => false,
    subscriptionCount: () => Promise.resolve(0),
  }
}

describe('BaseEvent.dispatch', () => {
  class OrderShipped extends BaseEvent {
    constructor(readonly orderId: string) {
      super()
    }
  }

  it('constructs and emits in one call', async () => {
    // The AdonisJS idiom: an event is almost always built only to be emitted.
    const emitter = new Emitter(silentBus())
    const seen: unknown[] = []
    emitter.on(OrderShipped, (event) => {
      seen.push(event)
    })
    BaseEvent.useEmitter(emitter)
    try {
      await OrderShipped.dispatch('order-1')
      expect(seen).toHaveLength(1)
      expect(seen[0]).toBeInstanceOf(OrderShipped)
    } finally {
      BaseEvent.resetEmitter(emitter)
    }
  })

  it('exposes the emitter, so a test can swap it without a provider', () => {
    const emitter = new Emitter(silentBus())
    BaseEvent.useEmitter(emitter)
    try {
      expect(BaseEvent.emitter).toBe(emitter)
    } finally {
      BaseEvent.resetEmitter(emitter)
    }
  })

  it('stays a no-op when no emitter is wired', async () => {
    await expect(OrderShipped.dispatch('order-2')).resolves.toBeUndefined()
  })
})

describe('Container > members AdonisJS exposes', () => {
  it('hasBinding is narrower than has: only what was registered', () => {
    // `has` answers "can this be resolved" — true for an alias or an @Service
    // class nobody registered. `hasBinding` answers "did someone register
    // this", which is what a provider asks before installing a default.
    const container = new Container()
    expect(container.hasBinding('nothing')).toBe(false)
    container.bind('something', () => 1)
    expect(container.hasBinding('something')).toBe(true)
  })

  it('restoreAll undoes every swap', async () => {
    const container = new Container()
    container.singleton('a', () => 'real-a')
    container.singleton('b', () => 'real-b')
    container.swap('a', () => 'fake-a')
    container.swap('b', () => 'fake-b')

    container.restoreAll()
    expect(await container.resolve('a')).toBe('real-a')
    expect(await container.resolve('b')).toBe('real-b')
  })

  it('restoreAll undoes only the listed swaps', async () => {
    const container = new Container()
    container.singleton('a', () => 'real-a')
    container.singleton('b', () => 'real-b')
    container.swap('a', () => 'fake-a')
    container.swap('b', () => 'fake-b')

    container.restoreAll(['a'])
    expect(await container.resolve('a')).toBe('real-a')
    expect(await container.resolve('b')).toBe('fake-b')
  })
})

describe('Router builders > members AdonisJS exposes', () => {
  it('route.getHandler returns the inline function', () => {
    const router = new Router()
    const handler = async (): Promise<void> => {}
    expect(router.get('/a', handler).getHandler()).toBe(handler)
  })

  it('route.getMiddleware lists named and inline entries together', () => {
    const router = new Router()
    const inline = async (_ctx: unknown, next: () => Promise<void>): Promise<void> => {
      await next()
    }
    const route = router.get('/a', async () => {}).middleware('auth')
    route.use(inline)
    expect(route.getMiddleware()).toEqual(['auth', inline])
  })

  it('route.toJSON describes the route without leaking functions into names', () => {
    const router = new Router()
    const route = router
      .get('/posts/:id', async () => {})
      .as('posts.show')
      .middleware('auth')
    expect(route.toJSON()).toMatchObject({
      name: 'posts.show',
      pattern: '/posts/:id',
      methods: ['GET'],
      middleware: ['auth'],
    })
  })

  it('group.routes exposes its members without handing out the backing array', () => {
    const router = new Router()
    const group = router.group(() => {
      router.get('/a', async () => {})
      router.get('/b', async () => {})
    })
    const routes = group.routes
    expect(routes).toHaveLength(2)
    // Mutating the view must not reach the group.
    expect(group.routes).toHaveLength(2)
  })

  it('on().setHandler registers a handler, and on().route exposes what was built', () => {
    const router = new Router()
    const brisk = router.on('/health')
    expect(brisk.route).toBeUndefined()
    const handler = async (): Promise<void> => {}
    const route = brisk.setHandler(handler)
    expect(brisk.route).toBe(route)
    expect(route.getHandler()).toBe(handler)
  })
})

describe('Request.qs > nested and repeated keys', () => {
  function get(query: string): Record<string, unknown> {
    return new Request({ method: 'GET', path: '/', query, headers: {}, body: '' }).qs()
  }

  it('keeps every value of a repeated key', () => {
    // A local parser split on "&" and assigned by key, so the second value
    // overwrote the first: `?tags[]=a&tags[]=b` silently became just "b".
    // An HTML multi-select posts exactly that.
    expect(get('tags[]=a&tags[]=b')).toEqual({ tags: ['a', 'b'] })
  })

  it('parses bracketed keys into nested objects', () => {
    expect(get('filter[status]=open')).toEqual({ filter: { status: 'open' } })
  })

  it('parses dotted keys into nested objects', () => {
    expect(get('page.size=20')).toEqual({ page: { size: '20' } })
  })

  it('still handles flat keys and a valueless one', () => {
    expect(get('a=1&b')).toEqual({ a: '1', b: '' })
  })
})

describe('RedirectBuilder > members AdonisJS exposes', () => {
  function redirectFor(referer: string, requestUrl: string): RedirectBuilder {
    return new RedirectBuilder(new Response(), { requestUrl, requestReferer: referer })
  }

  it('getPreviousUrl returns a same-origin referer', () => {
    const redirect = redirectFor('https://app.test/dashboard', 'https://app.test/login')
    expect(redirect.getPreviousUrl('/')).toBe('https://app.test/dashboard')
  })

  it('getPreviousUrl refuses a foreign referer — an open redirect', () => {
    const redirect = redirectFor('https://evil.test/steal', 'https://app.test/login')
    expect(redirect.getPreviousUrl('/safe')).toBe('/safe')
  })

  it('allowedHosts opts a foreign host back in', () => {
    const redirect = redirectFor('https://sso.test/done', 'https://app.test/login')
    redirect.allowedHosts = ['sso.test']
    expect(redirect.getPreviousUrl('/safe')).toBe('https://sso.test/done')
  })

  it('allowedHosts is empty by default, so back() stays same-origin', () => {
    expect(redirectFor('https://evil.test/x', 'https://app.test/y').allowedHosts).toEqual([])
  })
})
