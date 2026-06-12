import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import type { AppContext } from '../../src/index.js'
import { Container, ReamError, RpcProvider, RpcRouter } from '../../src/index.js'

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
