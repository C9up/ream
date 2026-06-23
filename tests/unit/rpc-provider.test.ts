import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import type { AppContext } from '../../src/index.js'
import { Container, ReamError, RpcProvider, RpcRouter } from '../../src/index.js'
import { MiddlewareRegistry } from '../../src/middleware/Pipeline.js'

function buildApp(container: Container): AppContext {
  const config = { get: () => undefined, set: () => {} }
  return { container, config }
}

/** Minimal router stub — the provider only calls `post()`; record the paths. */
function stubRouter(): { posted: string[]; router: { post(path: string): void } } {
  const posted: string[] = []
  return {
    posted,
    router: {
      post(path: string): void {
        posted.push(path)
      },
    },
  }
}

describe('RpcProvider > container binding', () => {
  it('binds a shared RpcRouter under the `rpc` token', () => {
    const container = new Container()
    const provider = new RpcProvider(buildApp(container))
    provider.register()
    expect(container.resolve('rpc')).toBe(provider.rpc)
    expect(provider.rpc).toBeInstanceOf(RpcRouter)
  })

  // Pinning test (epic-24 retro A1): the collision guard was silently dropped by
  // the 56.6 refactor and re-added on review — these lock it so a future refactor
  // cannot erase it unnoticed.
  it('re-registering the same provider instance is idempotent (no throw)', () => {
    const container = new Container()
    const provider = new RpcProvider(buildApp(container))
    provider.register()
    expect(() => provider.register()).not.toThrow()
    expect(container.resolve('rpc')).toBe(provider.rpc)
  })

  it('throws RPC_PROVIDER_ALREADY_REGISTERED when a different provider claims the `rpc` token', () => {
    const container = new Container()
    new RpcProvider(buildApp(container)).register()
    const other = new RpcProvider(buildApp(container))
    try {
      other.register()
      expect.fail('expected register() to throw on a duplicate rpc binding')
    } catch (error) {
      expect(error).toBeInstanceOf(ReamError)
      if (error instanceof ReamError) {
        expect(error.code).toBe('RPC_PROVIDER_ALREADY_REGISTERED')
      }
    }
  })
})

describe('RpcProvider > endpoint mount', () => {
  it('mounts POST /rpc on the core router at boot', async () => {
    const container = new Container()
    const { posted, router } = stubRouter()
    container.singleton('router', () => router)
    const provider = new RpcProvider(buildApp(container))
    provider.register()
    await provider.boot()
    expect(posted).toEqual(['/rpc'])
  })

  it('dispatches a registered method end-to-end through the mounted handler', async () => {
    const container = new Container()
    const posted: Array<(ctx: unknown) => Promise<void>> = []
    container.singleton('router', () => ({
      post(_path: string, handler: (ctx: unknown) => Promise<void>): void {
        posted.push(handler)
      },
    }))
    const provider = new RpcProvider(buildApp(container))
    provider.register()
    provider.rpc.method('ping.echo', () => 'pong')
    await provider.boot()

    // Invoke the captured route handler with a minimal JSON-RPC request ctx.
    const out: unknown[] = []
    const ctx = {
      request: {
        body: () => ({ jsonrpc: '2.0', method: 'ping.echo', params: {}, id: 1 }),
      },
      response: {
        status(_code: number) {
          return this
        },
        json(payload: unknown) {
          out.push(payload)
        },
      },
    }
    await posted[0](ctx)
    expect(out).toEqual([{ jsonrpc: '2.0', result: 'pong', id: 1 }])
  })

  it('DI-resolves namespace controllers through the container (parity with GraphQL)', async () => {
    const container = new Container()
    const posted: Array<(ctx: unknown) => Promise<void>> = []
    container.singleton('router', () => ({
      post(_path: string, handler: (ctx: unknown) => Promise<void>): void {
        posted.push(handler)
      },
    }))
    class Counter {
      n = 0
      bump(): number {
        this.n++
        return this.n
      }
    }
    const shared = new Counter()
    container.singleton(Counter, () => shared)

    const provider = new RpcProvider(buildApp(container))
    provider.register() // wires rpc.useContainer(container)
    provider.rpc.namespace('counter', Counter)
    await provider.boot()

    const call = (id: number): Promise<void> =>
      posted[0]({
        request: {
          body: () => ({ jsonrpc: '2.0', method: 'counter.bump', params: {}, id }),
        },
        response: {
          status(_code: number) {
            return this
          },
          json(_payload: unknown) {},
        },
      })
    await call(1)
    await call(2)
    // make(Counter) returns the shared singleton, so state accumulates. A bare
    // `new Counter()` per call would leave `shared.n` at 0.
    expect(shared.n).toBe(2)
  })
})

// Audit 2026-06-13 fixes: RPC auth-nesting + validator/middleware execution.
describe('RpcProvider > auth, validation & middleware execution', () => {
  // Capture the mounted POST handler (typed (ctx: unknown) to sidestep HttpContext).
  function mount(container: Container, build: (rpc: RpcRouter) => void) {
    const posted: Array<(ctx: unknown) => Promise<void>> = []
    container.singleton('router', () => ({
      post(_path: string, handler: (ctx: unknown) => Promise<void>): void {
        posted.push(handler)
      },
    }))
    const provider = new RpcProvider(buildApp(container))
    provider.register()
    build(provider.rpc)
    return { provider, posted }
  }

  function call(handler: (ctx: unknown) => Promise<void>, body: unknown, auth?: unknown) {
    const out: unknown[] = []
    return handler({
      request: { body: () => body },
      response: {
        status(_code: number) {
          return this
        },
        json(payload: unknown) {
          out.push(payload)
        },
      },
      auth,
    }).then(() => out)
  }

  it('reads RPC role gates from nested ctx.auth.user.roles (Warden), not just top-level', async () => {
    const container = new Container()
    const { provider, posted } = mount(container, (rpc) => {
      rpc.method('admin.ping', () => 'pong').role('admin')
    })
    await provider.boot()
    // Roles live ONLY under auth.user (the Warden shape) — pre-fix this denied.
    const out = await call(
      posted[0],
      { jsonrpc: '2.0', method: 'admin.ping', params: {}, id: 1 },
      {
        authenticated: true,
        user: { roles: ['admin'] },
      },
    )
    expect(out).toEqual([{ jsonrpc: '2.0', result: 'pong', id: 1 }])
  })

  it('processes a batch wrapped by request.body() as { _body: [...] }', async () => {
    const container = new Container()
    const { provider, posted } = mount(container, (rpc) => {
      rpc.method('demo.echo', (_ctx, params) => params)
    })
    await provider.boot()
    // A top-level JSON array (JSON-RPC batch) reaches the handler wrapped in the
    // `{ _body: [...] }` envelope `request.body()` puts around non-objects.
    const out = await call(posted[0], {
      _body: [
        { jsonrpc: '2.0', method: 'demo.echo', params: { x: 1 }, id: 0 },
        { jsonrpc: '2.0', method: 'demo.echo', params: { y: 2 }, id: 1 },
      ],
    })
    expect(out).toEqual([
      [
        { jsonrpc: '2.0', result: { x: 1 }, id: 0 },
        { jsonrpc: '2.0', result: { y: 2 }, id: 1 },
      ],
    ])
  })

  it('honors a handler error carrying a numeric code (domain errors, not -32603)', async () => {
    const container = new Container()
    const { provider, posted } = mount(container, (rpc) => {
      rpc.method('task.find', () => {
        throw Object.assign(new Error('Task not found'), {
          code: -32004,
          data: { id: 'abc' },
        })
      })
    })
    await provider.boot()
    const out = await call(posted[0], {
      jsonrpc: '2.0',
      method: 'task.find',
      params: {},
      id: 1,
    })
    expect(out).toEqual([
      {
        jsonrpc: '2.0',
        error: { code: -32004, message: 'Task not found', data: { id: 'abc' } },
        id: 1,
      },
    ])
  })

  it('still maps a plain (codeless) handler throw to -32603', async () => {
    const container = new Container()
    const { provider, posted } = mount(container, (rpc) => {
      rpc.method('task.boom', () => {
        throw new Error('kaboom')
      })
    })
    await provider.boot()
    const out = await call(posted[0], {
      jsonrpc: '2.0',
      method: 'task.boom',
      params: {},
      id: 2,
    })
    expect(out).toEqual([{ jsonrpc: '2.0', error: { code: -32603, message: 'kaboom' }, id: 2 }])
  })

  it('runs a declared RPC validator and rejects invalid params with -32602', async () => {
    const container = new Container()
    container.singleton('validator:createUser', () => ({
      validate: () => ({ valid: false, errors: ['email is required'] }),
    }))
    const { provider, posted } = mount(container, (rpc) => {
      rpc.method('user.create', () => 'created').validate('createUser')
    })
    await provider.boot()
    const out = await call(posted[0], { jsonrpc: '2.0', method: 'user.create', params: {}, id: 2 })
    expect(out[0]).toMatchObject({ error: { code: -32602 } })
  })

  it('hard-errors (not silent skip) when a declared validator is unregistered', async () => {
    const container = new Container()
    const { provider, posted } = mount(container, (rpc) => {
      rpc.method('user.create', () => 'created').validate('missing')
    })
    await provider.boot()
    const out = await call(posted[0], { jsonrpc: '2.0', method: 'user.create', params: {}, id: 3 })
    expect(out[0]).toMatchObject({ error: { code: -32603 } })
  })

  it('runs declared RPC named middleware; a throwing guard becomes a JSON-RPC error', async () => {
    const container = new Container()
    const registry = new MiddlewareRegistry()
    registry.register('deny', async () => {
      throw new ReamError('RPC_DENIED', 'denied by middleware')
    })
    container.singleton('middleware', () => registry)
    const { provider, posted } = mount(container, (rpc) => {
      rpc.method('x.y', () => 'ok').middleware('deny')
    })
    await provider.boot()
    const out = await call(posted[0], { jsonrpc: '2.0', method: 'x.y', params: {}, id: 4 })
    expect(out[0]).toHaveProperty('error')
    expect(out[0]).not.toHaveProperty('result')
  })

  it('does not reply to a notification (no id) but still runs it (JSON-RPC §4.1)', async () => {
    const container = new Container()
    let ran = false
    const { provider, posted } = mount(container, (rpc) => {
      rpc.method('ping', () => {
        ran = true
        return 'pong'
      })
    })
    await provider.boot()
    let status = 0
    let sent: unknown
    const json: unknown[] = []
    await posted[0]({
      request: { body: () => ({ jsonrpc: '2.0', method: 'ping', params: {} }) },
      response: {
        status(c: number) {
          status = c
          return this
        },
        json(p: unknown) {
          json.push(p)
        },
        send(d: unknown) {
          sent = d
        },
      },
    })
    expect(ran).toBe(true) // side-effect ran
    expect(json).toEqual([]) // no JSON-RPC reply
    expect(status).toBe(204) // No Content
    expect(sent).toBe('')
  })

  it('group() restores the previous group config when the callback throws', async () => {
    const container = new Container()
    const { provider, posted } = mount(container, (rpc) => {
      expect(() =>
        rpc.group({ guards: ['g'] }, () => {
          throw new Error('boom')
        }),
      ).toThrow('boom')
      // Registered AFTER the throwing group — must NOT inherit its guard, or an
      // unauthenticated call would be denied -32003 (leaked group config).
      rpc.method('free.ping', () => 'pong')
    })
    await provider.boot()
    const out = await call(posted[0], {
      jsonrpc: '2.0',
      method: 'free.ping',
      params: {},
      id: 9,
    })
    expect(out).toEqual([{ jsonrpc: '2.0', result: 'pong', id: 9 }])
  })

  it('runs the handler when declared middleware passes (calls next)', async () => {
    const container = new Container()
    const registry = new MiddlewareRegistry()
    let ran = false
    registry.register('pass', async (_ctx, next) => {
      ran = true
      await next()
    })
    container.singleton('middleware', () => registry)
    const { provider, posted } = mount(container, (rpc) => {
      rpc.method('x.z', () => 'ok').middleware('pass')
    })
    await provider.boot()
    const out = await call(posted[0], { jsonrpc: '2.0', method: 'x.z', params: {}, id: 5 })
    expect(ran).toBe(true)
    expect(out).toEqual([{ jsonrpc: '2.0', result: 'ok', id: 5 }])
  })
})
