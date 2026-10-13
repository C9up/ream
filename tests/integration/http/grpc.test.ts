import { connect } from 'node:http2'
import { describe, expect, it } from 'vitest'
import type { NapiGrpcCall, NapiGrpcReply } from '../../../src/native/generated.js'
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

async function start(
  grpc: ((call: NapiGrpcCall) => Promise<NapiGrpcReply>) | undefined,
  http: (path: string, contentType: string) => string = (path) => `http ${path}`,
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
  if (grpc) server.onGrpc(grpc)
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
