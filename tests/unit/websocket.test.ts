import { describe, expect, it } from 'vitest'
import { ServerWebSocket, type WebSocketBackend, WebSocketHub } from '../../src/http/WebSocket.js'
import { createHttpKernel, MiddlewareRegistry } from '../../src/index.js'
import { Router } from '../../src/router/Router.js'
import { nativeWebSocketConfig } from '../../src/server/nativeLimits.js'

/** Records what the hub asks of the native server. */
function recordingBackend(sendAnswer = 10) {
  const calls: string[] = []
  const backend: WebSocketBackend = {
    registerWebSocket: (id) => {
      calls.push(`register ${id.length}`)
      return true
    },
    discardWebSocket: () => {
      calls.push('discard')
    },
    webSocketSendText: (_id, text) => {
      calls.push(`text ${text}`)
      return sendAnswer
    },
    webSocketSendBinary: (_id, data) => {
      calls.push(`binary ${data.length}`)
      return sendAnswer
    },
    webSocketBufferedAmount: () => 42,
    webSocketClose: (_id, code, reason) => {
      calls.push(`close ${code} ${reason}`)
      return true
    },
  }
  return { backend, calls }
}

describe('WebSocketHub', () => {
  it('hands messages to every listener and the close once', async () => {
    const { backend } = recordingBackend()
    const hub = new WebSocketHub(backend)
    const socket = hub.open([])
    const seen: unknown[] = []
    socket.on('message', (data, isBinary) => seen.push([data, isBinary]))
    socket.on('close', (code, reason) => seen.push(['close', code, reason]))

    hub.dispatch({ id: socket.id, kind: 'message', text: 'hi' })
    hub.dispatch({ id: socket.id, kind: 'message', binary: new Uint8Array([1]) })
    hub.dispatch({ id: socket.id, kind: 'close', code: 1000, reason: 'bye' })
    hub.dispatch({ id: socket.id, kind: 'message', text: 'after close' })

    expect(seen).toEqual([
      ['hi', false],
      [new Uint8Array([1]), true],
      ['close', 1000, 'bye'],
    ])
    expect(await socket.closed).toEqual({ code: 1000, reason: 'bye' })
    expect(socket.readyState).toBe('closed')
    expect(hub.size).toBe(0)
  })

  it('reports a throwing listener and still runs the others', () => {
    const { backend } = recordingBackend()
    const errors: unknown[] = []
    const hub = new WebSocketHub(backend, (error) => errors.push(error))
    const socket = hub.open([])
    const seen: string[] = []
    socket.on('message', () => {
      throw new Error('listener bug')
    })
    socket.on('message', (data) => seen.push(String(data)))
    hub.dispatch({ id: socket.id, kind: 'message', text: 'x' })
    expect(seen).toEqual(['x'])
    expect(errors).toHaveLength(1)
  })

  it('reports a dropped connection as 1006', async () => {
    const { backend } = recordingBackend()
    const hub = new WebSocketHub(backend)
    const socket = hub.open([])
    hub.dispatch({ id: socket.id, kind: 'close' })
    expect(await socket.closed).toEqual({ code: 1006, reason: '' })
  })

  it('discards a socket that never opened, once', () => {
    const { backend, calls } = recordingBackend()
    const hub = new WebSocketHub(backend)
    const socket = hub.open([])
    hub.discard(socket)
    hub.discard(socket)
    expect(calls.filter((c) => c === 'discard')).toHaveLength(1)
    expect(hub.size).toBe(0)
  })
})

describe('ServerWebSocket', () => {
  it('sends text and bytes through the backend', () => {
    const { backend, calls } = recordingBackend()
    const socket = new ServerWebSocket('a', backend, [], () => {})
    expect(socket.send('hi')).toBe(true)
    expect(socket.send(new Uint8Array(3))).toBe(true)
    expect(calls).toEqual(['text hi', 'binary 3'])
    expect(socket.bufferedAmount).toBe(42)
  })

  it('reports a refused send and stops sending once the server closes it for backlog', () => {
    const { backend } = recordingBackend(-2)
    const socket = new ServerWebSocket('a', backend, [], () => {})
    expect(socket.send('x')).toBe(false)
    expect(socket.readyState).toBe('closing')
    expect(socket.send('y')).toBe(false)
  })

  it('closes once', () => {
    const { backend, calls } = recordingBackend()
    const socket = new ServerWebSocket('a', backend, [], () => {})
    socket.close(4000, 'bye')
    socket.close()
    expect(calls).toEqual(['close 4000 bye'])
    expect(socket.send('x')).toBe(false)
  })

  it('accepts only a subprotocol the client offered', () => {
    const { backend } = recordingBackend()
    const socket = new ServerWebSocket('a', backend, ['chat.v1', 'chat.v2'], () => {})
    expect(socket.acceptProtocol('chat.v2').protocol).toBe('chat.v2')
    expect(() => socket.acceptProtocol('chat.v3')).toThrow(/E_WEBSOCKET_PROTOCOL/)
  })
})

describe('nativeWebSocketConfig', () => {
  it('reads sizes, the idle bound and the origins from http.webSocket', () => {
    expect(
      nativeWebSocketConfig({
        webSocket: {
          maxMessageSize: '1kb',
          maxFrameSize: 512,
          maxBufferedBytes: '2mb',
          idleTimeout: 0,
          allowedOrigins: ['https://app.test'],
        },
      }),
    ).toEqual({
      maxMessageSize: 1024,
      maxFrameSize: 512,
      maxBufferedBytes: 2 * 1024 * 1024,
      idleTimeout: 0,
      allowedOrigins: ['https://app.test'],
    })
    expect(nativeWebSocketConfig(undefined)).toEqual({})
    expect(nativeWebSocketConfig({ keepAliveTimeout: 5 })).toEqual({})
  })

  it('refuses what the native server could not take', () => {
    expect(() => nativeWebSocketConfig({ webSocket: { maxMessageSize: 0 } })).toThrow(
      /E_IGNITOR_INVALID_HTTP_CONFIG|maxMessageSize/,
    )
    expect(() => nativeWebSocketConfig({ webSocket: { idleTimeout: '60s' } })).toThrow(
      /idleTimeout/,
    )
    expect(() =>
      nativeWebSocketConfig({ webSocket: { allowedOrigins: 'https://a.test' } }),
    ).toThrow(/allowedOrigins/)
    expect(() => nativeWebSocketConfig({ webSocket: true })).toThrow(/webSocket/)
  })
})

describe('HttpKernel > WebSocket routes', () => {
  function handshake(path: string, headers: Record<string, string> = {}) {
    return {
      method: 'GET',
      path,
      query: '',
      headers: { host: 'app.test', accept: 'application/json', ...headers },
      body: '',
      websocket: true,
    }
  }

  function setup() {
    const { backend, calls } = recordingBackend()
    const hub = new WebSocketHub(backend)
    const router = new Router()
    let reached = 0
    router.ws('/live', ({ socket }) => {
      reached++
      socket.send('welcome')
    })
    router
      .ws('/guarded', () => {
        reached++
      })
      .use(async (ctx, next) => {
        if (ctx.request.header('authorization') === undefined) {
          ctx.response.status(401).json({ error: 'no' })
          return
        }
        await next()
      })
    router
      .ws('/after', () => {})
      .use(async (ctx, next) => {
        await next()
        // A middleware that changes its mind after the handler.
        ctx.response.status(403)
      })
    router.ws('/throws', () => {
      throw new Error('boom')
    })
    const kernel = createHttpKernel({
      router,
      middleware: new MiddlewareRegistry(),
      webSocketHub: () => hub,
    })
    return { kernel, calls, hub, reached: () => reached }
  }

  it('answers a handshake 101 with the socket it registered', async () => {
    const { kernel, calls, hub, reached } = setup()
    const res = await kernel(handshake('/live'))
    expect(res.status).toBe(101)
    expect(res.websocketId).toMatch(/^[0-9a-f-]{36}$/)
    expect(reached()).toBe(1)
    expect(calls).toEqual(['register 36', 'text welcome'])
    expect(hub.size).toBe(1)
  })

  it('answers a plain GET 426 without registering anything', async () => {
    const { kernel, calls } = setup()
    const res = await kernel({ ...handshake('/live'), websocket: false })
    expect(res.status).toBe(426)
    expect(res.headers.upgrade).toBe('websocket')
    expect(res.websocketId).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('lets route middleware refuse the handshake before any socket exists', async () => {
    const { kernel, calls, reached } = setup()
    const res = await kernel(handshake('/guarded'))
    expect(res.status).toBe(401)
    expect(res.websocketId).toBeUndefined()
    expect(calls).toEqual([])
    expect(reached()).toBe(0)
  })

  it('discards the socket when the answer is no longer 101', async () => {
    const { kernel, calls, hub } = setup()
    const res = await kernel(handshake('/after'))
    expect(res.status).toBe(403)
    expect(res.websocketId).toBeUndefined()
    expect(calls).toEqual(['register 36', 'discard'])
    expect(hub.size).toBe(0)
  })

  it('discards the socket when the handler throws', async () => {
    const { kernel, calls, hub } = setup()
    const res = await kernel(handshake('/throws'))
    expect(res.status).toBe(500)
    expect(res.websocketId).toBeUndefined()
    expect(calls).toEqual(['register 36', 'discard'])
    expect(hub.size).toBe(0)
  })

  it('answers 501 when the server has no WebSocket support', async () => {
    const router = new Router()
    router.ws('/live', () => {})
    const kernel = createHttpKernel({ router, middleware: new MiddlewareRegistry() })
    expect((await kernel(handshake('/live'))).status).toBe(501)
  })

  it('registers the route as a GET flagged websocket, with the builder chain', () => {
    const router = new Router()
    router.ws('/chat/:room', () => {}).as('chat')
    const route = router.getRoutes().find((r) => r.name === 'chat')
    expect(route?.method).toBe('GET')
    expect(route?.websocket).toBe(true)
  })
})
