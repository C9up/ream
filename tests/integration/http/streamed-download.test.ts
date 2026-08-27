/**
 * A binary body streamed over a real socket, end to end.
 *
 * Everything else about the streaming path is tested in halves: the Rust
 * registry in `cargo test`, the TS pump against a recording backend, the
 * native method against the shipped `.node`. This is the only test that runs
 * the whole chain — TS pushes chunks, NAPI carries them, the registry queues
 * them, hyper writes chunked HTTP, a real client reads them back — and the
 * only one that would catch bytes being mangled anywhere along it.
 */
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { Response } from '../../../src/http/Response.js'
import { HyperServer } from './loader.js'

const networkAllowed = process.env.REAM_SKIP_NETWORK_TESTS !== '1'
const describeIfNetwork = networkAllowed ? describe : describe.skip

interface NapiRequest {
  method: string
  path: string
}

/** Boot a server whose handler can push onto its own stream registry. */
async function serve(
  handler: (req: NapiRequest, server: InstanceType<typeof HyperServer>) => Promise<unknown>,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = new HyperServer(0)
  server.onRequest(async (req: NapiRequest) => handler(req, server))
  await server.listen()
  return { port: await server.port(), close: () => server.close() }
}

describeIfNetwork('streamed binary download over HTTP', () => {
  it('delivers every byte intact, chunked, without buffering the body', async () => {
    // 1 MiB of random bytes: large enough to span many frames, and random so a
    // truncation or a re-encoding cannot accidentally still match.
    const payload = randomBytes(1024 * 1024)
    const CHUNK = 64 * 1024

    const { port, close } = await serve(async (_req, server) => {
      const streamId = 'download-e2e'
      await server.registerStream(streamId)
      // Push AFTER returning the response: the client must be reading while we
      // write, which is the whole point of streaming.
      void (async () => {
        for (let offset = 0; offset < payload.length; offset += CHUNK) {
          const ok = await server.writeStreamBytes(
            streamId,
            new Uint8Array(payload.subarray(offset, offset + CHUNK)),
          )
          if (!ok) break
        }
        await server.closeStream(streamId)
      })()
      return {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        body: '',
        streamId,
      }
    })

    try {
      const res = await fetch(`http://127.0.0.1:${port}/file.bin`)
      expect(res.status).toBe(200)
      const received = Buffer.from(await res.arrayBuffer())

      expect(received).toHaveLength(payload.length)
      expect(received.equals(payload)).toBe(true)
    } finally {
      await close()
    }
  })

  it('carries bytes no UTF-8 decoder would survive', async () => {
    // The reason writeStreamBytes exists: the String-taking writeStream would
    // mangle these into replacement characters.
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x80])

    const { port, close } = await serve(async (_req, server) => {
      const streamId = 'binary-e2e'
      await server.registerStream(streamId)
      void (async () => {
        await server.writeStreamBytes(streamId, new Uint8Array(payload))
        await server.closeStream(streamId)
      })()
      return { status: 200, headers: {}, body: '', streamId }
    })

    try {
      const res = await fetch(`http://127.0.0.1:${port}/x.png`)
      const received = Buffer.from(await res.arrayBuffer())
      expect(received.equals(payload)).toBe(true)
    } finally {
      await close()
    }
  })

  it('preserves chunk order across many frames', async () => {
    // Each frame carries its own index, so a reordering shows up as a
    // mismatch rather than as a byte count that happens to add up.
    const frames = 200
    const { port, close } = await serve(async (_req, server) => {
      const streamId = 'order-e2e'
      await server.registerStream(streamId)
      void (async () => {
        for (let i = 0; i < frames; i++) {
          await server.writeStreamBytes(streamId, new Uint8Array(Buffer.from(`${i},`)))
        }
        await server.closeStream(streamId)
      })()
      return { status: 200, headers: {}, body: '', streamId }
    })

    try {
      const res = await fetch(`http://127.0.0.1:${port}/order`)
      const text = await res.text()
      expect(text).toBe(Array.from({ length: frames }, (_, i) => `${i},`).join(''))
    } finally {
      await close()
    }
  })
})

describeIfNetwork('Response.stream over a real server', () => {
  it('serves a file through Response + serializeResponse, not just the raw registry', async () => {
    // The test that matters most: it drives the SAME path the kernel does —
    // `stream()` registers, `settle()` resolves, the response goes back with
    // its stream id, and only then does the body get attached. An earlier
    // version awaited the pump inside settle(), which closed the stream before
    // Rust ever looked the id up: every download answered E_STREAM_UNKNOWN
    // while every unit test stayed green.
    const payload = randomBytes(256 * 1024)

    const server = new HyperServer(0)
    let pumped: Promise<void> = Promise.resolve()

    server.onRequest(async () => {
      const res = new Response()
      res.setStreamBackend(server as unknown as never)
      res.header('content-type', 'application/octet-stream')
      await res.stream(Readable.from([payload]))
      await res.settle()
      pumped = res.streamed()
      return {
        status: res.getStatus(),
        headers: res.getHeaders(),
        body: res.getBody(),
        ...(res.getStreamId() !== undefined ? { streamId: res.getStreamId() } : {}),
      }
    })
    await server.listen()
    const port = await server.port()

    try {
      const got = Buffer.from(await (await fetch(`http://127.0.0.1:${port}/f.bin`)).arrayBuffer())
      expect(got.equals(payload)).toBe(true)
      await pumped
    } finally {
      await server.close()
    }
  })

  it('falls back to a buffered body when nothing can stream', async () => {
    // No backend wired: the response carries the bytes itself, base64-marked,
    // and the client still gets them.
    const payload = Buffer.from([0x00, 0xff, 0x7f])

    const server = new HyperServer(0)
    server.onRequest(async () => {
      const res = new Response()
      await res.stream(Readable.from([payload]))
      await res.settle()
      return { status: res.getStatus(), headers: res.getHeaders(), body: res.getBody() }
    })
    await server.listen()
    const port = await server.port()

    try {
      const got = Buffer.from(await (await fetch(`http://127.0.0.1:${port}/f.bin`)).arrayBuffer())
      expect(got.equals(payload)).toBe(true)
    } finally {
      await server.close()
    }
  })
})
