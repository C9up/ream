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
