import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import type { HttpKernelRequest, HttpKernelResponse } from '../../src/HttpKernel.js'
import type {
  GrpcHandler,
  GrpcLimits,
  HyperServerLike,
  NativeGrpcHandler,
} from '../../src/index.js'
import { Ignitor, Router, Server } from '../../src/index.js'

/**
 * `server.grpc(handler)` reaches the native server before it listens: that is
 * how a package serves gRPC on the HTTP port without ream knowing it exists.
 */

class MockServer implements HyperServerLike {
  readonly events: string[] = []
  grpcHandler: NativeGrpcHandler | undefined
  onRequest(_cb: (req: HttpKernelRequest) => Promise<HttpKernelResponse>): void {}
  async listen(): Promise<void> {
    this.events.push('listen')
  }
  async port(): Promise<number> {
    return 0
  }
  async close(): Promise<void> {}
}

class GrpcMockServer extends MockServer {
  limits: GrpcLimits | undefined
  cancel: ((id: number) => void) | undefined
  onGrpc(handler: NativeGrpcHandler, limits?: GrpcLimits): void {
    this.events.push('onGrpc')
    this.grpcHandler = handler
    this.limits = limits
  }
  onGrpcCancel(cancel: (id: number) => void): void {
    this.events.push('onGrpcCancel')
    this.cancel = cancel
  }
}

const handler: GrpcHandler = async () => ({ code: 12, details: 'unimplemented' })

function ignitorWith(server: MockServer, register: boolean, limits?: GrpcLimits): Ignitor {
  return new Ignitor({ port: 0, serverFactory: () => server, gracefulShutdown: false })
    .httpServer()
    .tap((app) => {
      if (!register) return
      app.booting(async () => {
        const resolved = await app.container.make('server')
        if (!(resolved instanceof Server)) throw new Error('server binding is not a Server')
        resolved.grpc(handler, limits)
      })
    })
}

describe('ignitor > gRPC', () => {
  it('hands the registered handler to the server before it listens', async () => {
    const server = new GrpcMockServer()
    const app = await ignitorWith(server, true).start()
    expect(server.events).toEqual(['onGrpcCancel', 'onGrpc', 'listen'])
    // The native server's numbered call reaches the registered handler.
    expect(
      await server.grpcHandler?.({
        id: 1,
        path: '/t.Svc/M',
        metadata: {},
        message: new Uint8Array(),
        ip: '127.0.0.1',
      }),
    ).toEqual({ code: 12, details: 'unimplemented' })
    await app.stop()
  })

  it('registers nothing when no handler is set', async () => {
    const server = new GrpcMockServer()
    const app = await ignitorWith(server, false).start()
    expect(server.events).toEqual(['listen'])
    await app.stop()
  })

  it('hands the message limits given with the handler to the server', async () => {
    const server = new GrpcMockServer()
    const app = await ignitorWith(server, true, {
      maxReceiveMessageLength: 1024,
      maxSendMessageLength: -1,
    }).start()
    expect(server.limits).toEqual({ maxReceiveMessageLength: 1024, maxSendMessageLength: -1 })
    await app.stop()
  })

  it('refuses to start a server that cannot serve gRPC once a handler is set', async () => {
    await expect(ignitorWith(new MockServer(), true).start()).rejects.toMatchObject({
      code: 'E_IGNITOR_GRPC_UNSUPPORTED',
    })
  })
})

describe('server.grpc', () => {
  it('refuses a second handler instead of replacing the first', () => {
    const server = new Server(new Router())
    server.grpc(handler)
    expect(() => server.grpc(async () => ({ message: new Uint8Array() }))).toThrow(
      expect.objectContaining({ code: 'E_SERVER_GRPC_ALREADY_SET' }),
    )
    expect(server.getGrpcHandler()).toBe(handler)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, -2])(
    'refuses a message limit of %s, before any handler is set',
    (value) => {
      const server = new Server(new Router())
      expect(() => server.grpc(handler, { maxSendMessageLength: value })).toThrow(
        expect.objectContaining({ code: 'E_SERVER_GRPC_INVALID_LIMIT' }),
      )
      expect(server.getGrpcHandler()).toBeUndefined()
    },
  )
})
