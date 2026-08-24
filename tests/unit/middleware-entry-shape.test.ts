/**
 * Telling a middleware from a lazy import.
 *
 * AdonisJS never infers this — `middlewareInfo` treats every function as a
 * closure, because its lazy entries are objects carrying a module reference.
 * Ream accepts a bare `() => import(...)` too, so a zero-arity function is
 * ambiguous: `handle.bind(this)` and `(...args) => {}` look exactly like an
 * import factory. `lazyMiddleware()` says which is which, and the ambiguous
 * case now fails with an error that names the fix.
 */
import { describe, expect, it } from 'vitest'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { RawRequest } from '../../src/http/Request.js'
import {
  lazyMiddleware,
  type MiddlewareClass,
  resolveMiddlewareEntry,
} from '../../src/server/Server.js'

const RAW: RawRequest = {
  method: 'GET',
  path: '/',
  query: '',
  headers: {},
  body: '',
}

function makeCtx(): HttpContext {
  return new HttpContext('req-1', RAW, {}, { pattern: '/', middleware: [] })
}

class Recorded implements MiddlewareClass {
  async handle(ctx: HttpContext, next: () => Promise<void>): Promise<void> {
    ctx.store.set('ran', 'class')
    await next()
  }
}

describe('ream > middleware entry shape', () => {
  it('runs a two-parameter function as middleware', async () => {
    const mw = resolveMiddlewareEntry(async (ctx, next) => {
      ctx.store.set('ran', 'fn')
      await next()
    })
    const ctx = makeCtx()
    await mw(ctx, async () => {})
    expect(ctx.store.get('ran')).toBe('fn')
  })

  it('runs a one-parameter function as middleware', async () => {
    const mw = resolveMiddlewareEntry(async (ctx) => {
      ctx.store.set('ran', 'ctx-only')
    })
    const ctx = makeCtx()
    await mw(ctx, async () => {})
    expect(ctx.store.get('ran')).toBe('ctx-only')
  })

  it('imports a zero-parameter factory', async () => {
    const mw = resolveMiddlewareEntry(async () => ({ default: Recorded }))
    const ctx = makeCtx()
    await mw(ctx, async () => {})
    expect(ctx.store.get('ran')).toBe('class')
  })

  it('lazyMiddleware() marks a factory explicitly', async () => {
    const mw = resolveMiddlewareEntry(lazyMiddleware(async () => ({ default: Recorded })))
    const ctx = makeCtx()
    await mw(ctx, async () => {})
    expect(ctx.store.get('ran')).toBe('class')
  })

  it('a bound middleware that lost its parameters fails with a usable message', async () => {
    // The trap: `.bind()` reports length 0, so this reads as an import factory.
    // It used to fail somewhere deeper with nothing pointing back here.
    class Handler {
      ran = false
      async handle(): Promise<void> {
        this.ran = true
      }
    }
    const handler = new Handler()
    const mw = resolveMiddlewareEntry(handler.handle.bind(handler))

    await expect(mw(makeCtx(), async () => {})).rejects.toThrow(/E_MIDDLEWARE_ENTRY/)
  })

  it('the error says how to fix it', async () => {
    const mw = resolveMiddlewareEntry(async () => undefined as never)
    await expect(mw(makeCtx(), async () => {})).rejects.toThrow(
      /lazyMiddleware|keep the `ctx` parameter/,
    )
  })
})
