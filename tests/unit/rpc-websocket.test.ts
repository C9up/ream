/**
 * RpcRouter over a WebSocket: every message takes the path POST /rpc takes,
 * with the handshake's context, and one socket's calls are bounded.
 */
import { describe, expect, it } from 'vitest'
import { HttpContext } from '../../src/http/HttpContext.js'
import { ServerWebSocket, type WebSocketContext } from '../../src/http/WebSocket.js'
import { Container } from '../../src/index.js'
import { RpcProvider } from '../../src/rpc/RpcProvider.js'
import { RpcRouter, type RpcWebSocketOptions } from '../../src/rpc/RpcRouter.js'
import { rpcCall, sendRpc } from '../__helpers__/rpc.js'

interface OpenSocket {
  ctx: WebSocketContext
  /** Each text the server sent, parsed. */
  sent: unknown[]
  closes: Array<{ code: number | undefined; reason: string | undefined }>
  deliver(data: string | Uint8Array): void
  end(): void
}

/** A socket on a handshake context, its native side recorded. */
function openSocket(
  rpc: RpcRouter,
  options: RpcWebSocketOptions = {},
  auth: HttpContext['auth'] = { isAuthenticated: false },
): OpenSocket {
  const sent: unknown[] = []
  const closes: OpenSocket['closes'] = []
  const socket = new ServerWebSocket(
    'socket-1',
    {
      registerWebSocket: () => true,
      discardWebSocket: () => {},
      webSocketSendText: (_id, text) => {
        sent.push(JSON.parse(text))
        return 0
      },
      webSocketSendBinary: () => 0,
      webSocketBufferedAmount: () => 0,
      webSocketClose: (_id, code, reason) => {
        closes.push({ code, reason })
        return true
      },
    },
    [],
    (error) => {
      throw error
    },
  )
  const base = new HttpContext(
    'handshake-1',
    { method: 'GET', path: '/rpc', query: '', headers: {}, body: '' },
    {},
    { pattern: '/rpc', middleware: [] },
  )
  base.auth = auth
  const ctx = Object.assign(base, { socket })
  rpc.webSocket(options)(ctx)
  return {
    ctx,
    sent,
    closes,
    deliver: (data) => socket.receive(data, typeof data !== 'string'),
    end: () => socket.ended(1000, ''),
  }
}

/** Let every pending promise chain settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
}

/** A promise the test resolves by hand. */
function gate(): { promise: Promise<void>; open(): void } {
  let open = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

function echoRouter(): { rpc: RpcRouter; seen: unknown[] } {
  const seen: unknown[] = []
  const rpc = new RpcRouter()
  rpc.method('echo', (_ctx, params) => params)
  rpc.method('log', (_ctx, params) => {
    seen.push(params)
  })
  return { rpc, seen }
}

describe('RpcRouter.webSocket() > messages', () => {
  it('answers a call, runs a notification without answering it, and batches', async () => {
    const { rpc, seen } = echoRouter()
    const s = openSocket(rpc)
    s.deliver(rpcCall('echo', 1, { text: 'héllo' }))
    s.deliver(JSON.stringify({ jsonrpc: '2.0', method: 'log', params: ['n'] }))
    s.deliver(
      JSON.stringify([
        { jsonrpc: '2.0', method: 'echo', params: [1], id: 'a' },
        { jsonrpc: '2.0', method: 'log', params: ['b'] },
        { jsonrpc: '2.0', method: 'nope', id: 'c' },
      ]),
    )
    await settle()
    expect(s.sent).toEqual([
      { jsonrpc: '2.0', result: { text: 'héllo' }, id: 1 },
      [
        { jsonrpc: '2.0', result: [1], id: 'a' },
        { jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id: 'c' },
      ],
    ])
    expect(seen).toEqual([['n'], ['b']])
  })

  it('gives every message the reply POST gives it', async () => {
    const { rpc } = echoRouter()
    const messages = [
      rpcCall('echo', 7, [1, 2]),
      'not json',
      '[]',
      JSON.stringify(
        Array.from({ length: 51 }, (_, i) => ({ jsonrpc: '2.0', method: 'echo', id: i })),
      ),
      JSON.stringify({ jsonrpc: '1.0', method: 'echo', id: 3 }),
      JSON.stringify([1]),
      JSON.stringify({ jsonrpc: '2.0', method: 'rpc.discover', id: 4 }),
    ]
    for (const message of messages) {
      const s = openSocket(rpc)
      s.deliver(message)
      await settle()
      const post = await sendRpc(rpc, message)
      expect(s.sent, message).toEqual([post.payload])
    }
  })

  it('sends nothing for an all-notification batch, as POST answers 204', async () => {
    const { rpc, seen } = echoRouter()
    const batch = JSON.stringify([
      { jsonrpc: '2.0', method: 'log', params: [1] },
      { jsonrpc: '2.0', method: 'log', params: [2] },
    ])
    const s = openSocket(rpc)
    s.deliver(batch)
    await settle()
    expect(s.sent).toEqual([])
    expect(seen).toEqual([[1], [2]])
    expect((await sendRpc(rpc, batch)).status).toBe(204)
  })

  it('answers a binary message with the Parse error an unparsable body gets', async () => {
    const { rpc } = echoRouter()
    const s = openSocket(rpc)
    s.deliver(new TextEncoder().encode(rpcCall('echo')))
    await settle()
    expect(s.sent).toEqual([
      { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
    ])
  })

  it('answers a result whose toJSON throws with -32603 and its id, on both paths', async () => {
    const rpc = new RpcRouter()
    rpc.method('bad', () => ({
      toJSON() {
        throw new Error('no shape')
      },
    }))
    const s = openSocket(rpc)
    s.deliver(rpcCall('bad', 9))
    await settle()
    const post = await sendRpc(rpc, rpcCall('bad', 9))
    expect(post.status).toBe(200)
    expect(s.sent).toEqual([post.payload])
    expect(post.payload).toMatchObject({ jsonrpc: '2.0', error: { code: -32603 }, id: 9 })
  })

  it('keeps a shared value and BigInt in a reply, as response.json() does', async () => {
    const rpc = new RpcRouter()
    const shared = { n: 1 }
    rpc.method('graph', () => ({ a: shared, b: shared, big: 12n }))
    const s = openSocket(rpc)
    s.deliver(rpcCall('graph'))
    await settle()
    expect(s.sent).toEqual([
      { jsonrpc: '2.0', result: { a: { n: 1 }, b: { n: 1 }, big: '12' }, id: 1 },
    ])
  })
})

describe('RpcRouter.webSocket() > auth', () => {
  it('runs every call with the handshake auth, through the method gates', async () => {
    const rpc = new RpcRouter()
    rpc.method('admin.only', (ctx) => ctx.auth.user?.id).role('admin')
    const admin = openSocket(
      rpc,
      {},
      {
        isAuthenticated: true,
        user: { id: 'u1', roles: ['admin'] },
      },
    )
    const member = openSocket(
      rpc,
      {},
      {
        isAuthenticated: true,
        user: { id: 'u2', roles: ['member'] },
      },
    )
    const anonymous = openSocket(rpc)
    for (const s of [admin, member, anonymous]) s.deliver(rpcCall('admin.only'))
    await settle()
    expect(admin.sent).toEqual([{ jsonrpc: '2.0', result: 'u1', id: 1 }])
    expect(member.sent).toEqual([
      { jsonrpc: '2.0', error: { code: -32003, message: 'Insufficient role' }, id: 1 },
    ])
    expect(anonymous.sent).toEqual([
      { jsonrpc: '2.0', error: { code: -32003, message: 'Unauthorized' }, id: 1 },
    ])
  })
})

describe('RpcRouter.webSocket() > bounds', () => {
  it('answers a quick call while slow ones hold their slots', async () => {
    const rpc = new RpcRouter()
    const hold = gate()
    rpc.method('slow', async () => {
      await hold.promise
      return 'slow'
    })
    rpc.method('quick', () => 'quick')
    const s = openSocket(rpc, { maxInFlight: 3 })
    s.deliver(rpcCall('slow', 1))
    s.deliver(rpcCall('slow', 2))
    s.deliver(rpcCall('quick', 3))
    await settle()
    expect(s.sent).toEqual([{ jsonrpc: '2.0', result: 'quick', id: 3 }])
    hold.open()
    await settle()
    expect(s.sent).toHaveLength(3)
  })

  it('runs at most maxInFlight messages at once and starts the next as one ends', async () => {
    const rpc = new RpcRouter()
    const gates = [gate(), gate(), gate()]
    let running = 0
    let peak = 0
    rpc.method('work', async (_ctx, params) => {
      const index = Array.isArray(params) && typeof params[0] === 'number' ? params[0] : 0
      running++
      peak = Math.max(peak, running)
      await gates[index]?.promise
      running--
      return index
    })
    const s = openSocket(rpc, { maxInFlight: 2 })
    for (let i = 0; i < 3; i++) s.deliver(rpcCall('work', i, [i]))
    await settle()
    expect(running).toBe(2)
    gates[1]?.open()
    await settle()
    expect(s.sent).toEqual([{ jsonrpc: '2.0', result: 1, id: 1 }])
    expect(running).toBe(2)
    gates[0]?.open()
    gates[2]?.open()
    await settle()
    expect(s.sent).toHaveLength(3)
    expect(peak).toBe(2)
  })

  it('closes with 1013 a socket whose client keeps sending past maxQueued', async () => {
    const rpc = new RpcRouter()
    const hold = gate()
    rpc.method('slow', async () => {
      await hold.promise
    })
    const s = openSocket(rpc, { maxInFlight: 1, maxQueued: 2 })
    for (let i = 0; i < 4; i++) s.deliver(rpcCall('slow', i))
    await settle()
    expect(s.closes).toEqual([{ code: 1013, reason: 'Too many JSON-RPC messages waiting' }])
    hold.open()
  })

  it('drops what waits when the socket closes', async () => {
    const rpc = new RpcRouter()
    const hold = gate()
    let runs = 0
    rpc.method('slow', async () => {
      runs++
      await hold.promise
    })
    const s = openSocket(rpc, { maxInFlight: 1 })
    for (let i = 0; i < 3; i++) s.deliver(rpcCall('slow', i))
    await settle()
    s.end()
    hold.open()
    await settle()
    expect(runs).toBe(1)
  })

  it('takes the defaults for bounds that are not positive integers', async () => {
    const rpc = new RpcRouter()
    const hold = gate()
    let running = 0
    rpc.method('slow', async () => {
      running++
      await hold.promise
    })
    const s = openSocket(rpc, { maxInFlight: 0, maxQueued: Number.NaN })
    for (let i = 0; i < 20; i++) s.deliver(rpcCall('slow', i))
    await settle()
    expect(running).toBe(16)
    expect(s.closes).toEqual([])
    hold.open()
  })
})

describe('RpcProvider > rpc.webSocket', () => {
  function providerWith(rpcConfig: Record<string, unknown>) {
    const container = new Container()
    const mounted: Array<{ kind: string; path: string; guards: string[] }> = []
    const route = (kind: string, path: string) => {
      const guards: string[] = []
      const entry = { kind, path, guards }
      mounted.push(entry)
      return {
        guard(...guards: string[]) {
          entry.guards.push(...guards)
          return this
        },
      }
    }
    container.singleton('router', () => ({
      post: (path: string) => route('post', path),
      ws: (path: string) => route('ws', path),
    }))
    const provider = new RpcProvider({
      container,
      config: { get: (key: string) => (key === 'rpc' ? rpcConfig : undefined), set: () => {} },
    })
    return { provider, mounted }
  }

  it('mounts the WebSocket route on the POST path, behind the same guards', async () => {
    const { provider, mounted } = providerWith({
      path: '/api/rpc',
      guards: ['jwt'],
      webSocket: true,
    })
    provider.register()
    await provider.start()
    expect(mounted).toEqual([
      { kind: 'post', path: '/api/rpc', guards: ['jwt'] },
      { kind: 'ws', path: '/api/rpc', guards: ['jwt'] },
    ])
  })

  it('mounts no WebSocket route unless asked', async () => {
    for (const webSocket of [undefined, false]) {
      const { provider, mounted } = providerWith({ webSocket })
      provider.register()
      await provider.start()
      expect(mounted.map((m) => m.kind)).toEqual(['post'])
    }
  })
})
