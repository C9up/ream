import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import type { HttpKernelRequest, HttpKernelResponse } from '../../src/HttpKernel.js'
import type { WebSocketEvent } from '../../src/http/WebSocket.js'
import type { HyperServerLike } from '../../src/index.js'
import { Ignitor } from '../../src/index.js'

/**
 * `server.supportsWebSockets()` is what a package asks before it offers a
 * WebSocket transport: true only while a server holding every primitive is
 * up — never before it starts, never after it stops, never on a bare host.
 */

class BareServer implements HyperServerLike {
  onRequest(_cb: (req: HttpKernelRequest) => Promise<HttpKernelResponse>): void {}
  async listen(): Promise<void> {}
  async port(): Promise<number> {
    return 0
  }
  async close(): Promise<void> {}
}

class SocketServer extends BareServer {
  onWebSocketEvent(_cb: (event: WebSocketEvent) => void): void {}
  registerWebSocket(_id: string): boolean {
    return true
  }
  discardWebSocket(_id: string): void {}
  webSocketSendText(_id: string, _text: string): number {
    return 0
  }
  webSocketSendBinary(_id: string, _data: Uint8Array): number {
    return 0
  }
  webSocketBufferedAmount(_id: string): number {
    return 0
  }
  webSocketClose(_id: string, _code?: number, _reason?: string): boolean {
    return true
  }
}

function ignitorOn(server: HyperServerLike): Ignitor {
  return new Ignitor({ port: 0, serverFactory: () => server, gracefulShutdown: false }).httpServer()
}

describe('server.supportsWebSockets()', () => {
  it('is false before the server starts, true while it runs, false once it stops', async () => {
    const ignitor = ignitorOn(new SocketServer())
    expect(ignitor.getServer().supportsWebSockets()).toBe(false)
    await ignitor.start()
    expect(ignitor.getServer().supportsWebSockets()).toBe(true)
    await ignitor.stop()
    expect(ignitor.getServer().supportsWebSockets()).toBe(false)
  })

  it('is false on a server without the WebSocket primitives', async () => {
    const ignitor = ignitorOn(new BareServer())
    await ignitor.start()
    expect(ignitor.getServer().supportsWebSockets()).toBe(false)
    await ignitor.stop()
  })
})
