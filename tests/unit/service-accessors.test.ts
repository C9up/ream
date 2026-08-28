import 'reflect-metadata'
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'

/**
 * Every `@c9up/ream/services/*` accessor stands in for a singleton the Ignitor
 * installs at boot. Read before that, it must throw a message naming what was
 * missed — but it must NOT throw when a module loader merely inspects it,
 * which happens on plain `import` and long before any real use.
 *
 * Covered as a set on purpose: the guard was written per accessor and reached
 * three of the five.
 */
const ACCESSORS = [
  { name: 'services/app', load: () => import('../../src/services/app.js') },
  { name: 'services/router', load: () => import('../../src/services/router.js') },
  { name: 'services/server', load: () => import('../../src/services/server.js') },
  { name: 'services/console', load: () => import('../../src/services/console.js') },
  { name: 'services/config', load: () => import('../../src/services/config.js') },
  { name: 'services/encryption', load: () => import('../../src/services/encryption.js') },
  { name: 'events/services/main', load: () => import('../../src/events/services/main.js') },
] as const

describe('service accessors > pre-boot behaviour', () => {
  for (const { name, load } of ACCESSORS) {
    describe(name, () => {
      it('answers undefined to `then` instead of throwing', async () => {
        // An ESM namespace is probed for `then` to decide whether it is
        // thenable. Throwing here turns `import` itself into a crash.
        const mod = await load()
        expect(() => Reflect.get(mod.default, 'then')).not.toThrow()
        expect(Reflect.get(mod.default, 'then')).toBeUndefined()
      })

      it('answers undefined to symbol probes instead of throwing', async () => {
        const mod = await load()
        for (const sym of [
          Symbol.toPrimitive,
          Symbol.toStringTag,
          Symbol.iterator,
          Symbol.for('nodejs.util.inspect.custom'),
        ]) {
          expect(() => Reflect.get(mod.default, sym)).not.toThrow()
          expect(Reflect.get(mod.default, sym)).toBeUndefined()
        }
      })

      it('survives util.inspect, which is what a logger reaches for', async () => {
        // Every hook inspect uses is a symbol, so the guard covers it. Note
        // that `JSON.stringify` is NOT in this set: `toJSON` is a real member
        // of some of these singletons, so throwing on it is correct.
        const mod = await load()
        expect(() => inspect(mod.default)).not.toThrow()
      })

      it('throws a message naming the missing wiring on a real read', async () => {
        const mod = await load()
        expect(() => Reflect.get(mod.default, 'somethingReal')).toThrow(/accessed before/i)
      })
    })
  }
})

describe('services/config > reads through the app locator', () => {
  it('resolves the store the app owns, and follows it when the app is replaced', async () => {
    const [{ default: config }, { setApp, clearApp }, { Application }] = await Promise.all([
      import('../../src/services/config.js'),
      import('../../src/services/app.js'),
      import('../../src/Application.js'),
    ])

    const first = new Application()
    first.config.set('app.name', 'first')
    setApp(first)
    expect(config.get('app.name')).toBe('first')

    // Not a cached copy: rebinding the app must move the store with it, which
    // is the whole reason this accessor holds no instance of its own.
    const second = new Application()
    second.config.set('app.name', 'second')
    setApp(second)
    expect(config.get('app.name')).toBe('second')

    clearApp(second)
    expect(() => config.get('app.name')).toThrow(/accessed before/i)
  })
})

describe('services/encryption > APP_KEY-gated', () => {
  it('names APP_KEY when unregistered, then delegates to the signer', async () => {
    const [{ default: encryption, setEncryption, clearEncryption }, { CookieSigner }] =
      await Promise.all([
        import('../../src/services/encryption.js'),
        import('../../src/security/CookieSigner.js'),
      ])

    // Absent is the normal state without APP_KEY, so the message has to point
    // at the key rather than at the boot phase.
    expect(() => encryption.sign('x')).toThrow(/E_MISSING_APP_KEY/)

    const signer = new CookieSigner('a-key-long-enough-to-pass')
    setEncryption(signer)
    const signed = encryption.sign('payload')
    expect(signer.unsign(signed)).toBe('payload')

    clearEncryption(signer)
    expect(() => encryption.sign('x')).toThrow(/E_MISSING_APP_KEY/)
  })
})

describe('services/urlBuilder > delegates to the router', () => {
  it('builds the same URL the router does, and refuses before routes exist', async () => {
    const [{ urlFor, signedUrlFor }, { setRouter, clearRouter }, { Router }] = await Promise.all([
      import('../../src/services/urlBuilder.js'),
      import('../../src/services/router.js'),
      import('../../src/router/Router.js'),
    ])

    expect(() => urlFor('users.show')).toThrow(/used before initialization/i)

    const router = new Router()
    router.get('/users/:id', () => 'ok').as('users.show')
    setRouter(router)

    // Same code path, not a reimplementation — that is the point of the
    // delegation, so a renamed route cannot mean two things.
    expect(urlFor('users.show', { id: '42' })).toBe(router.urlFor('users.show', { id: '42' }))

    // Signing needs a signer the router was handed; without one it says so
    // rather than returning an unsigned URL.
    expect(() => signedUrlFor('users.show', { id: '42' })).toThrow(/E_MISSING_APP_KEY/)

    clearRouter(router)
    expect(() => urlFor('users.show')).toThrow(/used before initialization/i)
  })
})
