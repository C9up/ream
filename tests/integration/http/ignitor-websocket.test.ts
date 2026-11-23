/**
 * WebSocket routes through a booted application: router, middleware, guards,
 * the kernel's handshake answer, the native server, a real client.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHyperServerFactory } from '../../../src/bootstrap/hyper-server.js'
import type { ServerWebSocket } from '../../../src/http/WebSocket.js'
import { errors, Ignitor } from '../../../src/index.js'
import type { MiddlewareFunction } from '../../../src/middleware/Pipeline.js'
import { TestClient } from '../../../src/testing/TestClient.js'

const networkAllowed = process.env.REAM_SKIP_NETWORK_TESTS !== '1'
const describeIfNetwork = networkAllowed ? describe : describe.skip

/** Stands in for an auth guard: only `Authorization: Bearer ok` gets through. */
const requireToken: MiddlewareFunction = async (ctx, next) => {
  if (ctx.request.header('authorization') !== 'Bearer ok') {
    ctx.response.status(401).json({ error: 'unauthenticated' })
    return
  }
  ctx.store.set('user', 'alice')
  await next()
}

describeIfNetwork('Ignitor > WebSocket routes', () => {
  let ignitor: Ignitor
  let client: TestClient
  const opened: ServerWebSocket[] = []
  const serverCloses: Array<{ code: number; reason: string }> = []
  let guardedHandlerRuns = 0

  beforeAll(async () => {
    const serverFactory = createHyperServerFactory()
    if (serverFactory === undefined)
      throw new Error('no prebuilt HyperServer binary for this platform')
    ignitor = await new Ignitor({ port: 0, gracefulShutdown: false, serverFactory })
      .configure('app', { http: { webSocket: { maxMessageSize: '1kb', maxFrameSize: '1kb' } } })
      .routes((router) => {
        router.ws('/echo', ({ socket }) => {
          opened.push(socket)
          socket.on('message', (data) => socket.send(data))
          socket.on('close', (code, reason) => serverCloses.push({ code, reason }))
        })
        router
          .ws('/private', ({ socket, store }) => {
            guardedHandlerRuns++
            socket.send(`hello ${String(store.get('user'))}`)
          })
          .use(requireToken)
        router.ws('/chat', ({ socket }) => {
          socket.acceptProtocol('chat.v2')
          socket.send(socket.protocol)
        })
        router.ws('/bye', ({ socket }) => {
          socket.send('closing')
          socket.close(4000, 'bye')
        })
        router.ws('/broken', () => {
          throw new Error('handler failed before the handshake completed')
        })
      })
      .httpServer()
      .start()
    const port = await ignitor.port()
    client = new TestClient(async () => ({ port, close: () => {} }))
  })

  afterAll(async () => {
    await client.close()
    await ignitor.stop()
  })

  it('echoes text and binary, and reports the client close to the server', async () => {
    const socket = await client.ws('/echo')
    socket.send('héllo')
    expect(await socket.next()).toBe('héllo')
    socket.send(new Uint8Array([0, 255, 7]))
    expect(await socket.next()).toEqual(new Uint8Array([0, 255, 7]))
    const server = opened.at(-1)
    socket.close(4001, 'done')
    expect(await server?.closed).toEqual({ code: 4001, reason: 'done' })
    expect(serverCloses.at(-1)).toEqual({ code: 4001, reason: 'done' })
    expect(server?.readyState).toBe('closed')
    expect(server?.send('late')).toBe(false)
  })

  it('runs the route middleware on the handshake: refused before any socket exists', async () => {
    const refused = await client.ws('/private').catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(errors.E_TEST_CLIENT_WEBSOCKET_REFUSED)
    expect(refused instanceof errors.E_TEST_CLIENT_WEBSOCKET_REFUSED && refused.status).toBe(401)
    expect(refused).toMatchObject({ code: 'E_TEST_CLIENT_WEBSOCKET_REFUSED' })
    expect(guardedHandlerRuns).toBe(0)

    const socket = await client.ws('/private', { headers: { authorization: 'Bearer ok' } })
    expect(await socket.next()).toBe('hello alice')
    expect(guardedHandlerRuns).toBe(1)
    socket.close()
  })

  it('answers a plain request to a WebSocket route 426', async () => {
    const res = await fetch(`http://127.0.0.1:${client.port || (await bootPort(client))}/echo`)
    expect(res.status).toBe(426)
    expect(res.headers.get('upgrade')).toBe('websocket')
  })

  it('answers the handshake with the subprotocol the handler accepted', async () => {
    const socket = await client.ws('/chat', { protocols: ['chat.v1', 'chat.v2'] })
    expect(socket.protocol).toBe('chat.v2')
    expect(await socket.next()).toBe('chat.v2')
    socket.close()
    // Not offered: the handler's acceptProtocol throws, the handshake fails.
    const refused = await client.ws('/chat', { protocols: ['chat.v1'] }).catch((e: unknown) => e)
    expect(refused instanceof errors.E_TEST_CLIENT_WEBSOCKET_REFUSED && refused.status).toBe(500)
  })

  it('lets the server close with its own code once queued messages are out', async () => {
    const socket = await client.ws('/bye')
    expect(await socket.next()).toBe('closing')
    expect(await socket.closed).toEqual({ code: 4000, reason: 'bye' })
  })

  it('turns a handler that throws into a plain error response', async () => {
    const refused = await client.ws('/broken').catch((error: unknown) => error)
    expect(refused instanceof errors.E_TEST_CLIENT_WEBSOCKET_REFUSED && refused.status).toBe(500)
  })

  it('closes a message over http.webSocket.maxMessageSize with 1009', async () => {
    const socket = await client.ws('/echo')
    socket.send('x'.repeat(2048))
    expect((await socket.closed).code).toBe(1009)
  })

  it('says the running server accepts WebSockets', () => {
    expect(ignitor.getServer().supportsWebSockets()).toBe(true)
  })

  it('refuses a foreign browser origin before routing (403)', async () => {
    const refused = await client
      .ws('/echo', { headers: { origin: 'https://evil.test' } })
      .catch((error: unknown) => error)
    expect(refused instanceof errors.E_TEST_CLIENT_WEBSOCKET_REFUSED && refused.status).toBe(403)
  })
})

async function bootPort(client: TestClient): Promise<number> {
  await client.boot()
  return client.port
}
