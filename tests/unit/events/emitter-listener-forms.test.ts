/**
 * The AdonisJS listener forms, on class events AND string events:
 * a function, `[Class, method?]`, `[() => import(...), method?]` (imported on
 * the first emit), and ream's bare-class shorthand. `off`, `clearListeners`,
 * `listenerCount` and `hasListeners` take either kind of event; `listen`
 * binds several classes; `listenIf` hands back the unsubscribe function.
 */
import { describe, expect, it } from 'vitest'
import { BaseEvent, Emitter, type EmitterResolver } from '../../../src/events/Emitter.js'
import { FakeBus } from '../../../src/events/testing/FakeBus.js'

class UserRegistered extends BaseEvent {
  constructor(public readonly email: string) {
    super()
  }
}

const log: string[] = []

class SendWelcome {
  handle(event: { email: string }): void {
    log.push(`welcome:${event.email}`)
  }

  audit(event: { email: string }): void {
    log.push(`audit:${event.email}`)
  }
}

let imports = 0
const LazyWelcome = async () => {
  imports += 1
  return { default: SendWelcome }
}

function fresh(resolver?: EmitterResolver): Emitter {
  log.length = 0
  imports = 0
  const emitter = new Emitter(new FakeBus(), resolver)
  BaseEvent.useEmitter(emitter)
  return emitter
}

describe('events > listener forms on a class event', () => {
  it('runs [Class], [Class, method] and a bare class', async () => {
    const emitter = fresh()
    emitter.on(UserRegistered, [SendWelcome])
    emitter.on(UserRegistered, [SendWelcome, 'audit'])
    await new UserRegistered('a@b.c').emit()
    expect(log).toEqual(['welcome:a@b.c', 'audit:a@b.c'])
  })

  it('imports a lazy listener on the first emit only, then reuses it', async () => {
    const emitter = fresh()
    emitter.on(UserRegistered, [LazyWelcome, 'handle'])
    expect(imports).toBe(0)
    await new UserRegistered('x@y.z').emit()
    await new UserRegistered('x@y.z').emit()
    expect(imports).toBe(1)
    expect(log).toEqual(['welcome:x@y.z', 'welcome:x@y.z'])
  })

  it('builds listener classes through the resolver', async () => {
    const built: unknown[] = []
    const emitter = fresh({
      async make(target) {
        built.push(target)
        return Reflect.construct(target, [])
      },
    })
    emitter.on(UserRegistered, [LazyWelcome])
    await new UserRegistered('r@s.t').emit()
    expect(built).toEqual([SendWelcome])
  })

  it('reports a missing method instead of calling something else', async () => {
    const emitter = fresh()
    const errors: unknown[] = []
    emitter.onError((_event, error) => errors.push(error))
    emitter.on(UserRegistered, [SendWelcome, 'nope'])
    await new UserRegistered('m@n.o').emit()
    expect(String(errors[0])).toContain('Missing method "nope"')
  })

  it('off / clearListeners / listenerCount / hasListeners take the class', async () => {
    const emitter = fresh()
    const fn = () => {
      log.push('fn')
    }
    emitter.on(UserRegistered, fn)
    emitter.on(UserRegistered, [SendWelcome, 'audit'])
    expect(emitter.listenerCount(UserRegistered)).toBe(2)
    expect(emitter.hasListeners(UserRegistered)).toBe(true)

    emitter.off(UserRegistered, fn)
    emitter.off(UserRegistered, [SendWelcome, 'audit'])
    expect(emitter.listenerCount(UserRegistered)).toBe(0)

    emitter.on(UserRegistered, fn)
    emitter.clearListeners(UserRegistered)
    expect(emitter.hasListeners(UserRegistered)).toBe(false)
    await new UserRegistered('q@r.s').emit()
    expect(log).toEqual([])
  })

  it('listen binds each class as [listener, "handle"], lazy or not', async () => {
    const emitter = fresh()
    emitter.listen(UserRegistered, [SendWelcome, LazyWelcome])
    expect(emitter.listenerCount(UserRegistered)).toBe(2)
    await new UserRegistered('l@m.n').emit()
    expect(log).toEqual(['welcome:l@m.n', 'welcome:l@m.n'])
  })

  it('once runs a class-event listener a single time', async () => {
    const emitter = fresh()
    emitter.once(UserRegistered, [SendWelcome])
    await new UserRegistered('o@p.q').emit()
    await new UserRegistered('o@p.q').emit()
    expect(log).toEqual(['welcome:o@p.q'])
    expect(emitter.listenerCount(UserRegistered)).toBe(0)
  })
})

describe('events > listener forms on a string event', () => {
  it('runs a listener class, a tuple and a lazy tuple', async () => {
    const emitter = fresh()
    emitter.on('user:registered', SendWelcome)
    emitter.on('user:registered', [SendWelcome, 'audit'])
    emitter.on('user:registered', [LazyWelcome, 'audit'])
    await emitter.emit('user:registered', { email: 's@t.u' })
    expect(log.sort()).toEqual(['audit:s@t.u', 'audit:s@t.u', 'welcome:s@t.u'])
  })

  it('off finds a tuple by target and method', async () => {
    const emitter = fresh()
    emitter.on('user:registered', [LazyWelcome, 'audit'])
    emitter.off('user:registered', [LazyWelcome, 'audit'])
    expect(emitter.listenerCount('user:registered')).toBe(0)
  })

  it('registers the same listener once, as AdonisJS does', async () => {
    const emitter = fresh()
    const fn = () => {
      log.push('fn')
    }
    emitter.on('x', fn)
    emitter.on('x', fn)
    await emitter.emit('x', undefined)
    expect(log).toEqual(['fn'])
  })

  it('listenIf returns the unsubscribe function, a no-op when the flag is off', async () => {
    const emitter = fresh()
    const off = emitter.listenIf(true, 'flagged', [SendWelcome])
    const noop = emitter.listenIf(() => false, 'flagged', [SendWelcome, 'audit'])
    expect(emitter.listenerCount('flagged')).toBe(1)
    noop()
    off()
    expect(emitter.listenerCount('flagged')).toBe(0)
  })
})
