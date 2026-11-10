import { connect, constants } from 'node:http2'
import { describe, expect, it } from 'vitest'
import type { NapiGrpcCall, NapiGrpcLimits, NapiGrpcReply } from '../../../src/native/generated.js'
import { HyperServer } from './loader.js'

/**
 * gRPC on the HTTP port, through the real native server.
 *
 * The client is `node:http2` speaking the gRPC wire format by hand — a 5-byte
 * prefix (compressed flag, big-endian length) before the message, the status
 * in the trailers — so the test needs no gRPC library and sees exactly what
 * crosses the socket.
 */

const networkAllowed = process.env.REAM_SKIP_NETWORK_TESTS !== '1'
const describeIfNetwork = networkAllowed ? describe : describe.skip

interface GrpcResult {
  status: string | undefined
  message: string | undefined
  reply: Uint8Array
}

function grpcCall(
  port: number,
  path: string,
  message: Uint8Array,
  metadata: Record<string, string> = {},
): Promise<GrpcResult> {
  return new Promise((resolve, reject) => {
    const session = connect(`http://127.0.0.1:${port}`)
    session.on('error', reject)
    const request = session.request({
      ':method': 'POST',
      ':path': path,
      'content-type': 'application/grpc',
      te: 'trailers',
      ...metadata,
    })
    const frame = new Uint8Array(5 + message.length)
    new DataView(frame.buffer).setUint32(1, message.length)
    frame.set(message, 5)
    request.end(frame)

    const chunks: Buffer[] = []
    let status: string | undefined
    let statusMessage: string | undefined
    const readStatus = (headers: Record<string, unknown>) => {
      const code = headers['grpc-status']
      const text = headers['grpc-message']
      if (typeof code === 'string') status = code
      if (typeof text === 'string') statusMessage = decodeURIComponent(text)
    }
    // A trailers-only response carries the status in the headers.
    request.on('response', readStatus)
    request.on('trailers', readStatus)
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('error', reject)
    request.on('end', () => {
      session.close()
      const body = Buffer.concat(chunks)
      const length = body.length >= 5 ? body.readUInt32BE(1) : 0
      resolve({
        status,
        message: statusMessage,
        reply: new Uint8Array(body.subarray(5, 5 + length)),
      })
    })
  })
}

interface RawCallOptions {
  headers?: Record<string, string | string[]>
  /** Messages sent, each framed; one by default. */
  messages?: Uint8Array[]
  /** Request trailers, sent after the messages. */
  trailers?: Record<string, string>
  /** Leave the request side open after the messages. */
  keepOpen?: boolean
  /** Reset the stream (CANCEL) this many ms after sending. */
  cancelAfter?: number
  /** Give up waiting for the status after this many ms. */
  waitMax?: number
}

interface RawResult {
  /** `grpc-status`, or what happened instead. */
  status: string
  message: string | undefined
  ms: number
}

function framed(message: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + message.length)
  new DataView(frame.buffer).setUint32(1, message.length)
  frame.set(message, 5)
  return frame
}

/** A gRPC call as a hostile or impatient client makes it. */
function rawCall(port: number, path: string, options: RawCallOptions = {}): Promise<RawResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    const session = connect(`http://127.0.0.1:${port}`)
    session.on('error', () => {})
    const request = session.request(
      {
        ':method': 'POST',
        ':path': path,
        'content-type': 'application/grpc',
        te: 'trailers',
        ...options.headers,
      },
      { endStream: false, waitForTrailers: options.trailers !== undefined },
    )
    let status: string | undefined
    let message: string | undefined
    let settled = false
    const finish = (fallback: string) => {
      if (settled) return
      settled = true
      clearTimeout(giveUp)
      resolve({ status: status ?? fallback, message, ms: Date.now() - started })
      session.destroy()
    }
    const readStatus = (headers: Record<string, unknown>) => {
      const code = headers['grpc-status']
      const text = headers['grpc-message']
      if (typeof code === 'string') status = code
      if (typeof text === 'string') message = decodeURIComponent(text)
    }
    request.on('response', readStatus)
    request.on('trailers', readStatus)
    request.on('data', () => {})
    request.on('error', () => {})
    request.on('close', () => finish(`closed rst=${request.rstCode}`))
    const giveUp = setTimeout(() => finish('still open'), options.waitMax ?? 3000)
    const trailers = options.trailers
    if (trailers !== undefined) {
      request.on('wantTrailers', () => request.sendTrailers(trailers))
    }
    const messages = options.messages ?? [new Uint8Array([1, 2, 3])]
    messages.forEach((message, index) => {
      const last = index === messages.length - 1
      if (last && options.keepOpen !== true) request.end(framed(message))
      else request.write(framed(message))
    })
    if (messages.length === 0 && options.keepOpen !== true) request.end()
    if (options.cancelAfter !== undefined) {
      setTimeout(() => request.close(constants.NGHTTP2_CANCEL), options.cancelAfter)
    }
  })
}

async function start(
  grpc: ((call: NapiGrpcCall) => Promise<NapiGrpcReply>) | undefined,
  http: (path: string, contentType: string) => string = (path) => `http ${path}`,
  options: { limits?: NapiGrpcLimits; requestTimeout?: number } = {},
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = new HyperServer(0)
  server.onRequest(async (raw) => {
    const path = typeof raw.path === 'string' ? raw.path : ''
    const headers = raw.headers
    const contentType =
      typeof headers === 'object' && headers !== null
        ? String(Reflect.get(headers, 'content-type') ?? '')
        : ''
    return { status: 200, headers: {}, body: http(path, contentType) }
  })
  if (grpc) server.onGrpc(grpc, options.limits)
  if (options.requestTimeout !== undefined) {
    server.configureConnections({ requestTimeout: options.requestTimeout })
  }
  await server.listen()
  return { port: await server.port(), close: () => server.close() }
}

describeIfNetwork('hyper-server > gRPC', () => {
  it('hands the message to JS as bytes and sends the reply back intact', async () => {
    const seen: NapiGrpcCall[] = []
    const { port, close } = await start(async (call) => {
      seen.push(call)
      return { message: call.message.slice().reverse() }
    })
    try {
      // Bytes a UTF-8 string or a base64 detour would corrupt or inflate.
      const message = Uint8Array.from([0x00, 0xff, 0xfe, 0x80, 0x0a, 0x00])
      const result = await grpcCall(port, '/t.Svc/Echo', message, {
        authorization: 'Bearer t0ken',
      })
      expect(result.status).toBe('0')
      expect([...result.reply]).toEqual([...message].reverse())

      expect(seen).toHaveLength(1)
      expect(seen[0]?.path).toBe('/t.Svc/Echo')
      expect([...(seen[0]?.message ?? [])]).toEqual([...message])
      expect(seen[0]?.metadata.authorization).toBe('Bearer t0ken')
      expect(seen[0]?.ip).toBe('127.0.0.1')
    } finally {
      await close()
    }
  })

  it('answers a status the handler returns', async () => {
    const { port, close } = await start(async () => ({ code: 5, details: 'no such thing' }))
    try {
      const result = await grpcCall(port, '/t.Svc/Find', new Uint8Array())
      expect(result.status).toBe('5')
      expect(result.message).toBe('no such thing')
    } finally {
      await close()
    }
  })

  it('answers INTERNAL to a handler that throws, without sending its error', async () => {
    const { port, close } = await start(async () => {
      throw new Error('database password is hunter2')
    })
    try {
      const result = await grpcCall(port, '/t.Svc/Boom', new Uint8Array())
      expect(result.status).toBe('13')
      expect(result.message).toBe('Internal error')
    } finally {
      await close()
    }
  })

  it('refuses request trailers before the handler, so none can reach the metadata', async () => {
    const seen: NapiGrpcCall[] = []
    const { port, close } = await start(async (call) => {
      seen.push(call)
      return { message: new Uint8Array() }
    })
    try {
      // A trailer would replace the header a proxy or the security filter
      // already checked.
      const replaced = await rawCall(port, '/t.Svc/Echo', {
        headers: { authorization: 'Bearer real' },
        trailers: { authorization: 'Bearer forged' },
      })
      const alone = await rawCall(port, '/t.Svc/Echo', {
        trailers: { authorization: 'Bearer forged' },
      })
      expect([replaced.status, alone.status]).toEqual(['13', '13'])
      expect(seen).toEqual([])
    } finally {
      await close()
    }
  })

  /** A server whose handler counts its calls. */
  async function counted(
    options: { limits?: NapiGrpcLimits; requestTimeout?: number },
    reply: Uint8Array = new Uint8Array(),
  ) {
    const calls: NapiGrpcCall[] = []
    const server = await start(
      async (call) => {
        calls.push(call)
        return { message: reply }
      },
      undefined,
      options,
    )
    return { ...server, calls }
  }

  it('answers a call whose request never ends at the request timeout', async () => {
    const { port, close, calls } = await counted({ requestTimeout: 300 })
    try {
      const result = await rawCall(port, '/t.Svc/Echo', { keepOpen: true, waitMax: 3000 })
      expect(result.status).toBe('4')
      expect(result.ms).toBeGreaterThanOrEqual(250)
      expect(result.ms).toBeLessThan(2000)
      expect(calls).toEqual([])
    } finally {
      await close()
    }
  })

  it('refuses a second message on a unary call at once', async () => {
    const { port, close, calls } = await counted({ requestTimeout: 2000 })
    try {
      const result = await rawCall(port, '/t.Svc/Echo', {
        messages: [new Uint8Array([1]), new Uint8Array([2])],
        keepOpen: true,
      })
      expect(result).toMatchObject({
        status: '12',
        message: 'Received a second request message',
      })
      expect(result.ms).toBeLessThan(1000)
      expect(calls).toEqual([])
    } finally {
      await close()
    }
  })

  it('refuses a request past maxReceiveMessageLength before the handler', async () => {
    const { port, close, calls } = await counted({ limits: { maxReceiveMessageLength: 4 } })
    try {
      const refused = await rawCall(port, '/t.Svc/Echo', { messages: [new Uint8Array(5)] })
      expect(refused).toMatchObject({
        status: '8',
        message: 'Received message larger than max (5 vs 4)',
      })
      const served = await rawCall(port, '/t.Svc/Echo', { messages: [new Uint8Array(4)] })
      expect(served.status).toBe('0')
      expect(calls).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it('answers RESOURCE_EXHAUSTED instead of a reply past maxSendMessageLength', async () => {
    const { port, close } = await counted(
      { limits: { maxSendMessageLength: 2 } },
      new Uint8Array([1, 2, 3]),
    )
    try {
      expect(await rawCall(port, '/t.Svc/Echo')).toMatchObject({
        status: '8',
        message: 'Sent message larger than max (3 vs. 2)',
      })
    } finally {
      await close()
    }
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, -2])(
    'refuses a message limit of %s',
    (value) => {
      const server = new HyperServer(0)
      expect(() =>
        server.onGrpc(async () => ({ message: new Uint8Array() }), {
          maxReceiveMessageLength: value,
        }),
      ).toThrow(/whole number of bytes/)
    },
  )

  it('keeps serving HTTP on the same port', async () => {
    const { port, close } = await start(async (call) => ({ message: call.message }))
    try {
      const response = await fetch(`http://127.0.0.1:${port}/page`)
      expect(await response.text()).toBe('http /page')
    } finally {
      await close()
    }
  })

  it('leaves a gRPC request on the HTTP path when no gRPC handler is set', async () => {
    const reached: string[] = []
    const { port, close } = await start(undefined, (path, contentType) => {
      reached.push(`${path} ${contentType}`)
      return 'http'
    })
    try {
      await grpcCall(port, '/t.Svc/Echo', new Uint8Array())
      expect(reached).toEqual(['/t.Svc/Echo application/grpc'])
    } finally {
      await close()
    }
  })
})
