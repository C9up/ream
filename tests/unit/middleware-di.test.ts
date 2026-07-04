import { describe, expect, it } from 'vitest'
import { Container } from '../../src/container/Container.js'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { RawRequest } from '../../src/http/Request.js'
import { type MiddlewareClass, resolveMiddlewareEntry } from '../../src/server/Server.js'

/** A dependency the middleware expects the container to inject. */
class Greeter {
  greet(): string {
    return 'hello'
  }
}

/** Middleware whose constructor takes an injected dependency (AdonisJS @inject). */
class GreetMiddleware implements MiddlewareClass {
  constructor(readonly greeter: Greeter) {}
  async handle(ctx: HttpContext, next: () => Promise<void>): Promise<void> {
    ctx.store.set('greeting', this.greeter.greet())
    await next()
  }
}

const RAW: RawRequest = { method: 'GET', path: '/', query: '', headers: {}, body: '' }

function makeCtx(container?: Container): HttpContext {
  return new HttpContext('req-1', RAW, {}, { pattern: '/', middleware: [] }, container)
}

describe('resolveMiddlewareEntry — container DI', () => {
  it('resolves the class through ctx.containerResolver so @inject deps are wired', async () => {
    const container = new Container()
    container.singleton(GreetMiddleware, () => new GreetMiddleware(new Greeter()))
    const mw = resolveMiddlewareEntry(async () => ({ default: GreetMiddleware }))

    const ctx = makeCtx(container)
    await mw(ctx, async () => {})
    // The injected Greeter ran — a plain `new GreetMiddleware()` would have
    // left `this.greeter` undefined and thrown.
    expect(ctx.store.get('greeting')).toBe('hello')
  })

  it('falls back to new Class() when no container is present (mock ctx)', async () => {
    class PlainMiddleware implements MiddlewareClass {
      async handle(ctx: HttpContext, next: () => Promise<void>): Promise<void> {
        ctx.store.set('ran', true)
        await next()
      }
    }
    const mw = resolveMiddlewareEntry(async () => ({ default: PlainMiddleware }))
    const ctx = makeCtx()
    await mw(ctx, async () => {})
    expect(ctx.store.get('ran')).toBe(true)
  })

  it('caches the imported class (imports once across calls)', async () => {
    const container = new Container()
    container.singleton(GreetMiddleware, () => new GreetMiddleware(new Greeter()))
    let imports = 0
    const mw = resolveMiddlewareEntry(async () => {
      imports += 1
      return { default: GreetMiddleware }
    })
    const ctx = makeCtx(container)
    await mw(ctx, async () => {})
    await mw(ctx, async () => {})
    expect(imports).toBe(1)
  })
})
