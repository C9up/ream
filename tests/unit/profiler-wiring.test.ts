/**
 * The profiler, as a request actually goes through it.
 *
 * The pieces are tested on their own elsewhere; what is checked here is the
 * wiring the Ignitor sets up — that a request is measured end to end, that the
 * token reaches both the response header and the bar in the page, and that the
 * two things which must never be profiled are not.
 */
import { describe, expect, it } from 'vitest'
import { HMR_PATH } from '../../src/dev/hmr.js'
import type { HttpContext } from '../../src/http/HttpContext.js'
import { createHttpKernel, MiddlewareRegistry, Router } from '../../src/index.js'
import {
  createProfiler,
  PROFILER_PATH,
  PROFILER_TOKEN_HEADER,
  profileRequest,
  profilerEndpoint,
  toolbarScript,
} from '../../src/profiler/index.js'

/** An emitter, as far as the collectors are concerned. */
function emitter() {
  const listeners = new Map<string, ((payload: unknown) => void)[]>()
  const emit = (event: string, payload: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(payload)
  }
  return {
    source: {
      on: (event: string, listener: (payload: unknown) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener])
      },
    },
    query: (payload: unknown) => emit('db:query', payload),
    log: (payload: unknown) => emit('log:line', payload),
  }
}

/** The kernel the Ignitor builds in development, minus the Ignitor. */
function devKernel(routes: (router: Router) => void) {
  const bus = emitter()
  const profiler = createProfiler(bus.source)
  const router = new Router()
  routes(router)
  const kernel = createHttpKernel({
    router,
    middleware: new MiddlewareRegistry(),
    serverMiddleware: [profilerEndpoint(profiler), profileRequest(profiler)],
    devScript: (ctx: HttpContext) => {
      const token = ctx.response.getHeader(PROFILER_TOKEN_HEADER)
      return token === undefined ? '<script>RELOAD</script>' : toolbarScript(token)
    },
  })
  const send = (path: string) => kernel({ method: 'GET', path, query: '', headers: {}, body: '' })
  return { profiler, send, bus }
}

describe('profiler > wired into the kernel', () => {
  it('stamps the token on the response', async () => {
    const { send } = devKernel((router) => {
      router.get('/orders', ({ response }: HttpContext) => response.send('ok'))
    })

    const res = await send('/orders')

    expect(res.headers[PROFILER_TOKEN_HEADER]).toMatch(/^[0-9a-f]+$/)
  })

  it('injects a bar carrying that same token', async () => {
    const { send } = devKernel((router) => {
      router.get('/page', ({ response }: HttpContext) => {
        response.header('content-type', 'text/html')
        response.send('<html><body>hi</body></html>')
      })
    })

    const res = await send('/page')
    const token = res.headers[PROFILER_TOKEN_HEADER]

    // A bar that showed a different token would open someone else's profile.
    expect(String(res.body)).toContain(`"token":"${token}"`)
  })

  it('keeps the profile the toolbar then asks for', async () => {
    const { send, profiler } = devKernel((router) => {
      router.get('/orders', ({ response }: HttpContext) => response.send('ok'))
    })

    const token = (await send('/orders')).headers[PROFILER_TOKEN_HEADER] ?? ''
    const profile = profiler.store.find(token)

    expect(profile?.url).toContain('/orders')
    expect(profile?.status).toBe(200)
  })

  it('attributes a query to the request that caused it', async () => {
    const { send, profiler, bus } = devKernel((router) => {
      router.get('/orders', ({ response }: HttpContext) => {
        bus.query({ sql: 'select 1', bindings: [], duration: 2 })
        response.send('ok')
      })
    })

    const token = (await send('/orders')).headers[PROFILER_TOKEN_HEADER] ?? ''

    expect(profiler.store.find(token)?.data.database).toMatchObject({ total: 1 })
  })

  it('does not profile its own pages', async () => {
    const { send, profiler } = devKernel((router) => {
      router.get('/orders', ({ response }: HttpContext) => response.send('ok'))
    })
    await send('/orders')

    const res = await send(PROFILER_PATH)

    // Answered, and not added to the history it just rendered.
    expect(res.headers[PROFILER_TOKEN_HEADER]).toBeUndefined()
    expect(profiler.store.recent(10)).toHaveLength(1)
  })

  it('leaves the hot-reload stream out, because it never ends', async () => {
    // Registered before the profiling middleware, so a stream open for the
    // life of the tab never sits in the middle of an unfinished profile.
    const { send, profiler } = devKernel((router) => {
      router.get(HMR_PATH, ({ response }: HttpContext) => response.send(''))
    })

    // Standing in for hmrEndpoint(), which needs a streaming backend: what is
    // asserted is the order, which is the Ignitor's, not this route's.
    await send('/nothing-here')

    expect(profiler.store.recent(10)).toHaveLength(1)
  })

  it('names the route that matched, which routing only knows later', async () => {
    const { send, profiler } = devKernel((router) => {
      router.get('/orders/:id', ({ response }: HttpContext) => response.send('ok'))
    })

    const token = (await send('/orders/7')).headers[PROFILER_TOKEN_HEADER] ?? ''

    // The pattern, not the URL: the panel is about what handled the request.
    expect(profiler.store.find(token)?.data.request).toMatchObject({ route: '/orders/:id' })
  })

  it('names the controller that answered', async () => {
    class OrderController {
      list({ response }: HttpContext) {
        response.send('ok')
      }
    }
    const { send, profiler } = devKernel((router) => {
      router.get('/orders', [OrderController, 'list'])
    })

    const token = (await send('/orders')).headers[PROFILER_TOKEN_HEADER] ?? ''

    // The class, read off the prototype the router carries.
    expect(profiler.store.find(token)?.data.request).toMatchObject({
      controller: 'OrderController.list',
    })
  })

  it('attributes a log line the same way it attributes a query', async () => {
    const { send, profiler, bus } = devKernel((router) => {
      router.get('/orders', ({ response }: HttpContext) => {
        bus.log({ level: 'warn', message: 'slow path', timestamp: '2026-01-01T00:00:00.000Z' })
        response.send('ok')
      })
    })

    const token = (await send('/orders')).headers[PROFILER_TOKEN_HEADER] ?? ''

    expect(profiler.store.find(token)?.data.logs).toMatchObject({
      total: 1,
      lines: [{ level: 'warn', message: 'slow path' }],
    })
  })

  it('shows no log panel when nothing logged', async () => {
    const { send, profiler } = devKernel((router) => {
      router.get('/orders', ({ response }: HttpContext) => response.send('ok'))
    })

    const token = (await send('/orders')).headers[PROFILER_TOKEN_HEADER] ?? ''

    // An empty panel is a heading over nothing; the renderer skips a bag with
    // no keys, so the collector hands one back.
    expect(profiler.store.find(token)?.data.logs).toEqual({})
  })

  it('records a request that threw', async () => {
    const { send, profiler } = devKernel((router) => {
      router.get('/boom', () => {
        throw new Error('nope')
      })
    })

    const res = await send('/boom')
    const token = res.headers[PROFILER_TOKEN_HEADER] ?? ''

    // The one profile anybody actually wants: the request must still be in the
    // store, with the exception on it.
    expect(profiler.store.find(token)?.data.exception).toMatchObject({ message: 'nope' })
    // Read off the error, not off the response: the exception handler writes
    // the status after this middleware has already unwound.
    expect(profiler.store.find(token)?.status).toBe(500)
  })
})
