/**
 * A WebSocket client for tests, over Node's own `WebSocket`.
 *
 * `TestClient.ws(path)` opens one against the booted application. Messages are
 * queued as they arrive, so a test reads them in order with `next()` whether
 * they came before or after it asked. A handshake the application refuses
 * rejects with `E_TEST_CLIENT_WEBSOCKET_REFUSED`, carrying the HTTP status the
 * middleware or guard answered.
 *
 * No upstream analogue: AdonisJS' test client (`@japa/api-client`) has no
 * WebSocket either, as its server has none.
 */

import { randomBytes } from 'node:crypto'
import { request, WebSocket } from 'node:http'
import { E_TEST_CLIENT_TIMEOUT, E_TEST_CLIENT_WEBSOCKET_REFUSED } from '../errors/codes.js'

export interface TestWebSocketOptions {
  /** Extra handshake headers (cookies, an `Authorization`, an `Origin`). */
  headers?: Record<string, string>
  /** Subprotocols to offer. */
  protocols?: string[]
  /** How long the handshake may take, ms. Default 5000. */
  timeoutMs?: number
}

type Received = string | Uint8Array

/** `node:http` exports the constructor as a value; this is its instance type. */
type NodeWebSocket = InstanceType<typeof WebSocket>

/** How the connection ended. */
export interface TestWebSocketClose {
  code: number
  reason: string
}

export class TestWebSocket {
  #socket: NodeWebSocket
  #queue: Received[] = []
  #waiting: Array<(message: Received) => void> = []
  #closed: Promise<TestWebSocketClose>

  private constructor(socket: NodeWebSocket) {
    this.#socket = socket
    socket.binaryType = 'arraybuffer'
    socket.addEventListener('message', (event) => {
      const data: unknown = event.data
      const message = data instanceof ArrayBuffer ? new Uint8Array(data) : String(data)
      const waiter = this.#waiting.shift()
      if (waiter) waiter(message)
      else this.#queue.push(message)
    })
    this.#closed = new Promise((resolve) => {
      socket.addEventListener('close', (event) => {
        resolve({ code: event.code, reason: event.reason })
      })
    })
  }

  /** Open a socket on `127.0.0.1:port`. */
  static async open(
    port: number,
    path: string,
    options: TestWebSocketOptions = {},
  ): Promise<TestWebSocket> {
    const url = `ws://127.0.0.1:${port}${path.startsWith('/') ? path : `/${path}`}`
    const headers = options.headers ?? {}
    // Node's WebSocket (undici's, exported by `node:http`) takes headers next
    // to the protocols; a browser's does not, and this is a test helper.
    const socket = new WebSocket(url, { protocols: options.protocols ?? [], headers })
    const timeoutMs = options.timeoutMs ?? 5000
    const opened = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve(true)
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        resolve(false)
      })
    })
    if (opened) return new TestWebSocket(socket)
    socket.close()
    // The WebSocket API hides why a handshake failed; ask again over plain
    // HTTP to learn the status the application answered.
    const refusal = await probe(port, path, headers, options.protocols ?? [])
    if (refusal !== undefined) throw refusal
    throw new E_TEST_CLIENT_WEBSOCKET_REFUSED(path)
  }

  /** The subprotocol the server chose, `''` when none. */
  get protocol(): string {
    return this.#socket.protocol
  }

  send(data: string | Uint8Array): void {
    // A copy on a plain ArrayBuffer: `send` refuses a view of a shared one.
    this.#socket.send(typeof data === 'string' ? data : new Uint8Array(data))
  }

  /** The next message, waiting at most `timeoutMs`. */
  next(timeoutMs = 5000): Promise<Received> {
    const queued = this.#queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting = this.#waiting.filter((waiter) => waiter !== deliver)
        reject(new E_TEST_CLIENT_TIMEOUT([`no WebSocket message within ${timeoutMs}ms`]))
      }, timeoutMs)
      const deliver = (message: Received): void => {
        clearTimeout(timer)
        resolve(message)
      }
      this.#waiting.push(deliver)
    })
  }

  /** The next message, parsed as JSON. */
  async nextJson(timeoutMs = 5000): Promise<unknown> {
    const message = await this.next(timeoutMs)
    return JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message))
  }

  close(code = 1000, reason = ''): void {
    this.#socket.close(code, reason)
  }

  /** Settles once the connection is over, whoever closed it. */
  get closed(): Promise<TestWebSocketClose> {
    return this.#closed
  }
}

/** Replay the handshake over plain HTTP; the refusal, when there was one. */
function probe(
  port: number,
  path: string,
  headers: Record<string, string>,
  protocols: string[],
): Promise<E_TEST_CLIENT_WEBSOCKET_REFUSED | undefined> {
  return new Promise((resolve) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        ...headers,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        ...(protocols.length > 0 ? { 'sec-websocket-protocol': protocols.join(', ') } : {}),
      },
    })
    req.on('upgrade', (_res, socket) => {
      socket.destroy()
      resolve(undefined)
    })
    req.on('response', (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
      })
      res.on('end', () =>
        resolve(new E_TEST_CLIENT_WEBSOCKET_REFUSED(path, { status: res.statusCode ?? 0, body })),
      )
    })
    req.on('error', () => resolve(undefined))
    req.end()
  })
}
