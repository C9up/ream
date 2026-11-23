/**
 * WebSocket connections on a route.
 *
 * NAMED DEVIATION — AdonisJS ships no WebSocket in its core (read in
 * `@adonisjs/http-server` 9.3.2 and `@adonisjs/core` 7.7.0: nothing handles
 * an upgrade; its realtime package, Transmit, is SSE), so there is no
 * upstream shape to copy. What is
 * kept is the spirit of its routes: a WebSocket route is declared on the
 * router like any other (`router.ws('/chat', handler)`), takes the same
 * grouping, prefixes, names, middleware and guards, and its handler receives
 * the `HttpContext` — with the socket on it.
 *
 * The middleware and guards run on the HANDSHAKE request, before any socket
 * exists: an unauthenticated client gets its 401 as plain HTTP and never an
 * open connection. Only when the handler is reached does the kernel register
 * a socket and answer `101`; the native server then completes the handshake.
 *
 * The native server has already refused what it can on its own: a malformed
 * handshake, a version other than 13, a browser `Origin` the configuration
 * does not allow (`config/app.ts` → `http.webSocket.allowedOrigins`, same
 * origin by default — a WebSocket is not covered by the same-origin policy,
 * so without this any site could open an authenticated socket in a visitor's
 * name). Frame and message size, idle time and the backlog of a slow client
 * are bounded there too.
 */

import { randomUUID } from 'node:crypto'
import { E_WEBSOCKET_PROTOCOL, E_WEBSOCKET_REGISTER } from '../errors/codes.js'
import { Exception } from './Exception.js'
import type { HttpContext } from './HttpContext.js'

/** The native calls a socket needs. The real `HyperServer` implements them. */
export interface WebSocketBackend {
  registerWebSocket(id: string): boolean
  discardWebSocket(id: string): void
  webSocketSendText(id: string, text: string): number
  webSocketSendBinary(id: string, data: Uint8Array): number
  webSocketBufferedAmount(id: string): number
  webSocketClose(id: string, code?: number, reason?: string): boolean
}

/** What the native server reports about a socket. */
export interface WebSocketEvent {
  id: string
  kind: string
  text?: string
  binary?: Uint8Array
  code?: number
  reason?: string
}

/** A message as a listener receives it. */
export type WebSocketMessage = string | Uint8Array

type MessageListener = (data: WebSocketMessage, isBinary: boolean) => void
type CloseListener = (code: number, reason: string) => void

export type WebSocketState = 'open' | 'closing' | 'closed'

/** How a socket ended. */
export interface WebSocketClose {
  /** The client's close code, the server's, or `1006` when the connection just dropped. */
  code: number
  reason: string
}

/**
 * The server side of one WebSocket connection.
 *
 * Attach listeners in the route handler: messages can arrive as soon as the
 * handshake completes, and one with no `message` listener is dropped.
 */
export class ServerWebSocket {
  readonly id: string
  /** The subprotocol chosen with {@link acceptProtocol}, `''` when none. */
  #protocol = ''
  #state: WebSocketState = 'open'
  #backend: WebSocketBackend
  #onListenerError: (error: unknown) => void
  #messageListeners = new Set<MessageListener>()
  #closeListeners = new Set<CloseListener>()
  #closed: Promise<WebSocketClose>
  #resolveClosed: (close: WebSocketClose) => void = () => {}
  /** Subprotocols the client offered, in its order of preference. */
  readonly offeredProtocols: readonly string[]

  constructor(
    id: string,
    backend: WebSocketBackend,
    offeredProtocols: readonly string[],
    onListenerError: (error: unknown) => void,
  ) {
    this.id = id
    this.#backend = backend
    this.offeredProtocols = offeredProtocols
    this.#onListenerError = onListenerError
    this.#closed = new Promise((resolve) => {
      this.#resolveClosed = resolve
    })
  }

  get readyState(): WebSocketState {
    return this.#state
  }

  get protocol(): string {
    return this.#protocol
  }

  /** Bytes queued for the client and not yet written. */
  get bufferedAmount(): number {
    return Math.max(0, this.#backend.webSocketBufferedAmount(this.id))
  }

  /** Settles once the connection is over, whoever closed it. */
  get closed(): Promise<WebSocketClose> {
    return this.#closed
  }

  /**
   * Answer the handshake with one of the subprotocols the client offered.
   * Call it in the handler, before the handshake completes.
   */
  acceptProtocol(protocol: string): this {
    if (!this.offeredProtocols.includes(protocol)) {
      throw new E_WEBSOCKET_PROTOCOL([protocol, this.offeredProtocols.join(', ') || 'none'])
    }
    this.#protocol = protocol
    return this
  }

  /**
   * Queue a message — a string as text, bytes as binary. `false` when the
   * socket is closing or closed, or when the message would take the client's
   * backlog past `maxBufferedBytes`: the server then closes it with 1013
   * rather than buffer without bound for a client that does not read.
   */
  send(data: WebSocketMessage): boolean {
    if (this.#state !== 'open') return false
    const queued =
      typeof data === 'string'
        ? this.#backend.webSocketSendText(this.id, data)
        : this.#backend.webSocketSendBinary(this.id, data)
    if (queued === -2) this.#state = 'closing'
    return queued >= 0
  }

  /**
   * Start the closing handshake once what is queued has been written. `code`
   * is 1000, one of 1001–1014 an endpoint may send, or 3000–4999; `reason` is
   * at most 123 bytes of UTF-8.
   */
  close(code = 1000, reason = ''): void {
    if (this.#state !== 'open') return
    this.#state = 'closing'
    this.#backend.webSocketClose(this.id, code, reason)
  }

  on(event: 'message', listener: MessageListener): this
  on(event: 'close', listener: CloseListener): this
  on(event: 'message' | 'close', listener: MessageListener | CloseListener): this {
    if (event === 'message' && isMessageListener(listener)) this.#messageListeners.add(listener)
    if (event === 'close' && isCloseListener(listener)) this.#closeListeners.add(listener)
    return this
  }

  off(event: 'message', listener: MessageListener): this
  off(event: 'close', listener: CloseListener): this
  off(event: 'message' | 'close', listener: MessageListener | CloseListener): this {
    if (event === 'message' && isMessageListener(listener)) this.#messageListeners.delete(listener)
    if (event === 'close' && isCloseListener(listener)) this.#closeListeners.delete(listener)
    return this
  }

  /** @internal Called by the hub. */
  receive(data: WebSocketMessage, isBinary: boolean): void {
    for (const listener of this.#messageListeners) {
      this.#call(() => listener(data, isBinary))
    }
  }

  /** @internal Called by the hub. */
  ended(code: number, reason: string): void {
    if (this.#state === 'closed') return
    this.#state = 'closed'
    for (const listener of this.#closeListeners) {
      this.#call(() => listener(code, reason))
    }
    this.#messageListeners.clear()
    this.#closeListeners.clear()
    this.#resolveClosed({ code, reason })
  }

  /** A listener that throws is reported, never allowed to take the process down. */
  #call(run: () => void): void {
    try {
      run()
    } catch (error) {
      this.#onListenerError(error)
    }
  }
}

// `on`/`off` take either listener shape; the event name decides which. A
// function's arity is the only runtime trace of its shape, and both are
// accepted for both, so these guards only narrow the type.
function isMessageListener(listener: unknown): listener is MessageListener {
  return typeof listener === 'function'
}
function isCloseListener(listener: unknown): listener is CloseListener {
  return typeof listener === 'function'
}

/** The sockets of one server, and where its native events land. */
export class WebSocketHub {
  #backend: WebSocketBackend
  #sockets = new Map<string, ServerWebSocket>()
  #onListenerError: (error: unknown) => void

  constructor(backend: WebSocketBackend, onListenerError?: (error: unknown) => void) {
    this.#backend = backend
    this.#onListenerError =
      onListenerError ??
      ((error) => {
        console.error('[ream] a WebSocket listener threw:', error)
      })
  }

  /** Register a socket for a handshake about to be answered 101. */
  open(offeredProtocols: readonly string[]): ServerWebSocket {
    const id = randomUUID()
    if (!this.#backend.registerWebSocket(id)) {
      throw new E_WEBSOCKET_REGISTER()
    }
    const socket = new ServerWebSocket(id, this.#backend, offeredProtocols, this.#onListenerError)
    this.#sockets.set(id, socket)
    return socket
  }

  /** Forget a socket whose 101 will not be sent. It never opened: no close event. */
  discard(socket: ServerWebSocket): void {
    if (this.#sockets.delete(socket.id)) this.#backend.discardWebSocket(socket.id)
  }

  /** Sockets currently open, for a broadcast or a count. */
  get size(): number {
    return this.#sockets.size
  }

  sockets(): IterableIterator<ServerWebSocket> {
    return this.#sockets.values()
  }

  /** Hand a native event to its socket. */
  dispatch(event: WebSocketEvent): void {
    const socket = this.#sockets.get(event.id)
    if (socket === undefined) return
    if (event.kind === 'message') {
      if (event.text !== undefined) socket.receive(event.text, false)
      else if (event.binary !== undefined) socket.receive(event.binary, true)
      return
    }
    if (event.kind === 'close') {
      this.#sockets.delete(event.id)
      socket.ended(event.code ?? 1006, event.reason ?? '')
    }
  }
}

/** The context a WebSocket route handler receives: the request's, with its socket. */
export type WebSocketContext = HttpContext & { socket: ServerWebSocket }

/** Whether `ctx` is a WebSocket route's context. */
export function isWebSocketContext(ctx: HttpContext): ctx is WebSocketContext {
  return 'socket' in ctx && ctx.socket instanceof ServerWebSocket
}

/** 426 for a plain request to a WebSocket route. */
export class E_WEBSOCKET_UPGRADE_REQUIRED extends Exception {
  static override status = 426
  static override code = 'E_WEBSOCKET_UPGRADE_REQUIRED'

  constructor() {
    super('This route only accepts WebSocket connections', {
      status: 426,
      code: 'E_WEBSOCKET_UPGRADE_REQUIRED',
    })
  }
}

/** 501 when the server under the application cannot hold a WebSocket. */
export class E_WEBSOCKET_UNSUPPORTED extends Exception {
  static override status = 501
  static override code = 'E_WEBSOCKET_UNSUPPORTED'

  constructor() {
    super('This server cannot accept WebSocket connections', {
      status: 501,
      code: 'E_WEBSOCKET_UNSUPPORTED',
    })
  }
}

/**
 * Open the socket of a WebSocket route's handshake: register it, answer the
 * request 101, and hand back the context with the socket on it.
 */
export function openWebSocket(ctx: HttpContext, hub: WebSocketHub | undefined): WebSocketContext {
  if (!ctx.request.upgradesToWebSocket()) {
    ctx.response.header('upgrade', 'websocket')
    throw new E_WEBSOCKET_UPGRADE_REQUIRED()
  }
  if (hub === undefined) throw new E_WEBSOCKET_UNSUPPORTED()
  const offered = (ctx.request.header('sec-websocket-protocol') ?? '')
    .split(',')
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol !== '')
  const socket = hub.open(offered)
  ctx.response.acceptWebSocket(socket, hub)
  return Object.assign(ctx, { socket })
}
