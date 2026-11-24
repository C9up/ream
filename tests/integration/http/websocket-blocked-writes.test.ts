/**
 * A client that stops reading cannot pin its connection. A blocked write to
 * it (its pongs after a ping flood, or the application's own messages) is
 * raced against the idle timeout, a requested close and the backlog kill, so
 * the server can always end the connection, free the backlog and tell the
 * application.
 */
import { connect, type Socket } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHyperServerFactory } from '../../../src/bootstrap/hyper-server.js'
import type { ServerWebSocket } from '../../../src/http/WebSocket.js'
import { Ignitor } from '../../../src/index.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Open a socket on `path` by hand and stop reading as soon as it is open. */
async function openAndStopReading(port: number, path: string): Promise<Socket> {
  const tcp = connect(port, '127.0.0.1')
  await new Promise<void>((resolve) => tcp.once('connect', () => resolve()))
  tcp.write(
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
  )
  await new Promise<void>((resolve, reject) => {
    tcp.once('data', (chunk) => {
      if (chunk.toString('latin1').startsWith('HTTP/1.1 101')) resolve()
      else reject(new Error('handshake refused'))
    })
  })
  tcp.pause()
  tcp.on('error', () => {})
  return tcp
}

/** Masked pings (125-byte payload) until the server stops taking bytes for 1 s, at most 24 MB. */
async function floodPings(tcp: Socket): Promise<void> {
  const ping = Buffer.concat([Buffer.from([0x89, 0x80 | 125, 0, 0, 0, 0]), Buffer.alloc(125, 0x41)])
  const chunk = Buffer.concat(Array.from({ length: 500 }, () => ping))
  let sent = 0
  let stalledSince = 0
  while (sent < 24 * 1024 * 1024) {
    if (tcp.writableLength < 1024 * 1024) {
      tcp.write(chunk)
      sent += chunk.length
      stalledSince = 0
    } else {
      if (stalledSince === 0) stalledSince = Date.now()
      if (Date.now() - stalledSince > 1000) break
    }
    await sleep(1)
  }
}

/** Wait until `socket` reports its close, at most `ms`. */
async function closeOf(
  closes: Map<ServerWebSocket, { code: number; reason: string }>,
  socket: ServerWebSocket,
  ms: number,
): Promise<{ code: number; reason: string } | undefined> {
  const until = Date.now() + ms
  while (Date.now() < until && !closes.has(socket)) await sleep(50)
  return closes.get(socket)
}

describe('WebSocket > a client that does not read', () => {
  let ignitor: Ignitor
  let port = 0
  const sockets: ServerWebSocket[] = []
  const closes = new Map<ServerWebSocket, { code: number; reason: string }>()

  beforeAll(async () => {
    ignitor = await new Ignitor({
      port: 0,
      gracefulShutdown: false,
      serverFactory: createHyperServerFactory(),
    })
      // 1 s of silence closes a connection; the backlog bound is raised only
      // so a write blocks below it on loopback.
      .configure('app', { http: { webSocket: { idleTimeout: 1000, maxBufferedBytes: '16mb' } } })
      .routes((router) => {
        router.ws('/feed', ({ socket }) => {
          sockets.push(socket)
          socket.on('close', (code, reason) => closes.set(socket, { code, reason }))
        })
      })
      .httpServer()
      .start()
    port = await ignitor.port()
  })

  afterAll(async () => {
    await ignitor.stop()
  })

  async function pinned(): Promise<{ tcp: Socket; server: ServerWebSocket }> {
    const tcp = await openAndStopReading(port, '/feed')
    const server = sockets.at(-1)
    if (server === undefined) throw new Error('no server socket')
    return { tcp, server }
  }

  /** Push 10 MB the client will never read: a write ends up blocked. */
  function push(server: ServerWebSocket): void {
    const message = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 160; i++) expect(server.send(message)).toBe(true)
  }

  it('after a ping flood the idle timeout still closes it', async () => {
    const { tcp, server } = await pinned()
    await floodPings(tcp)
    expect(await closeOf(closes, server, 5000)).toEqual({ code: 1001, reason: 'idle timeout' })
    tcp.destroy()
  }, 40_000)

  it('a blocked data write is ended by the idle timeout and the backlog is freed', async () => {
    const { tcp, server } = await pinned()
    push(server)
    await sleep(200)
    expect(server.bufferedAmount).toBeGreaterThan(1024 * 1024)
    expect(await closeOf(closes, server, 5000)).toEqual({ code: 1001, reason: 'idle timeout' })
    expect(server.bufferedAmount).toBe(0)
    tcp.destroy()
  }, 20_000)
})

describe('WebSocket > close() while a write is blocked', () => {
  let ignitor: Ignitor
  let port = 0
  const sockets: ServerWebSocket[] = []
  const closes = new Map<ServerWebSocket, { code: number; reason: string }>()

  beforeAll(async () => {
    ignitor = await new Ignitor({
      port: 0,
      gracefulShutdown: false,
      serverFactory: createHyperServerFactory(),
    })
      // No idle bound: only the requested close can end the connection.
      .configure('app', { http: { webSocket: { idleTimeout: 0, maxBufferedBytes: '16mb' } } })
      .routes((router) => {
        router.ws('/feed', ({ socket }) => {
          sockets.push(socket)
          socket.on('close', (code, reason) => closes.set(socket, { code, reason }))
        })
      })
      .httpServer()
      .start()
    port = await ignitor.port()
  })

  afterAll(async () => {
    await ignitor.stop()
  })

  it('is carried out within the 5 s close timeout, and the application hears it', async () => {
    const tcp = await openAndStopReading(port, '/feed')
    const server = sockets.at(-1)
    if (server === undefined) throw new Error('no server socket')
    const message = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 160; i++) server.send(message)
    await sleep(500)
    expect(server.bufferedAmount).toBeGreaterThan(1024 * 1024)
    server.close(1008, 'signed out')
    expect(await closeOf(closes, server, 7000)).toEqual({ code: 1008, reason: 'signed out' })
    expect(server.bufferedAmount).toBe(0)
    tcp.destroy()
  }, 20_000)
})
