import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import type { HttpKernelRequest, HttpKernelResponse } from '../../src/HttpKernel.js'
import type { GrpcHandler, HyperServerLike } from '../../src/index.js'
import { Ignitor, Router, Server } from '../../src/index.js'

/**
 * `server.grpc(handler)` reaches the native server before it listens: that is
 * how a package serves gRPC on the HTTP port without ream knowing it exists.
 */

class MockServer implements HyperServerLike {
  readonly events: string[] = []
  grpcHandler: GrpcHandler | undefined
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
  onGrpc(handler: GrpcHandler): void {
    this.events.push('onGrpc')
    this.grpcHandler = handler
  }
}

const handler: GrpcHandler = async () => ({ code: 12, details: 'unimplemented' })

function ignitorWith(server: MockServer, register: boolean): Ignitor {
  return new Ignitor({ port: 0, serverFactory: () => server, gracefulShutdown: false })
    .httpServer()
    .tap((app) => {
      if (!register) return
      app.booting(async () => {
        const resolved = await app.container.make('server')
        if (!(resolved instanceof Server)) throw new Error('server binding is not a Server')
        resolved.grpc(handler)
      })
    })
}

describe('ignitor > gRPC', () => {
  it('hands the registered handler to the server before it listens', async () => {
    const server = new GrpcMockServer()
    const app = await ignitorWith(server, true).start()
    expect(server.grpcHandler).toBe(handler)
    expect(server.events).toEqual(['onGrpc', 'listen'])
    await app.stop()
  })

  it('registers nothing when no handler is set', async () => {
    const server = new GrpcMockServer()
    const app = await ignitorWith(server, false).start()
    expect(server.events).toEqual(['listen'])
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
})
