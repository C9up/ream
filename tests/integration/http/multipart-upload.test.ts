import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { type HttpMethod, RequestBuilder } from '../../../src/testing/RequestBuilder.js'
import type { TestResponse } from '../../../src/testing/TestClient.js'
import { HyperServer } from './loader.js'

/**
 * End-to-end proof that the test utility's `.file()` / `.field()` encoding is
 * consumed by the REAL Rust HyperServer multipart parser — no app boot, no
 * BodyParser middleware. The server parses `multipart/form-data` (multer) and
 * ships `req.multipart` (fields + base64 files); we assert what the builder
 * produced round-trips through it intact.
 *
 * This closes the loop on the framework fix: the production receive-path was
 * already correct — only the test-side encoder was missing. No Rust change.
 */
const networkAllowed = process.env.REAM_SKIP_NETWORK_TESTS !== '1'
const describeIfNetwork = networkAllowed ? describe : describe.skip

/** Multipart payload as the Rust HyperServer parses + ships it. */
interface MultipartPayload {
  fields: Array<{ name: string; value: string }>
  files: Array<{
    fieldName: string
    clientName: string
    contentType: string
    size: number
    contentB64: string
  }>
}

interface NapiRequestWithMultipart {
  method: string
  path: string
  query: string
  headers: Record<string, string>
  body: string
  multipart?: MultipartPayload
}

async function createServer(
  handler: (req: NapiRequestWithMultipart) => Promise<{
    status: number
    headers: Record<string, string>
    body: string
  }>,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = new HyperServer(0)
  server.onRequest(handler)
  await server.listen()
  const port = await server.port()
  return { port, close: () => server.close() }
}

/** Encode a body through the real RequestBuilder, capturing what it would send. */
async function encodeViaBuilder(
  build: (b: RequestBuilder) => RequestBuilder,
): Promise<{ headers: Record<string, string>; body: Buffer }> {
  let captured: { headers: Record<string, string>; body: Buffer } | null = null
  const sender = async (
    _method: HttpMethod,
    _path: string,
    init: { headers: Record<string, string>; body: Buffer },
  ): Promise<TestResponse> => {
    captured = init
    return {
      status: 200,
      headers: {},
      body: '',
      bodyBuffer: Buffer.alloc(0),
      json<T = unknown>(): T {
        return undefined as T
      },
    }
  }
  await build(new RequestBuilder(sender, 'POST', '/upload')).send()
  if (captured === null) throw new Error('builder did not invoke the sender')
  return captured
}

describeIfNetwork('hyper-server > multipart upload (RequestBuilder ↔ Rust parser)', () => {
  it('parses a .file() + .field() body the builder produced', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00])
    const enc = await encodeViaBuilder((b) =>
      b
        .field('title', 'My Doc')
        .file('document', png, { filename: 'doc.png', contentType: 'image/png' }),
    )
    expect(enc.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)

    const { port, close } = await createServer(async (req) => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req.multipart ?? null),
    }))

    try {
      const res = await fetch(`http://127.0.0.1:${port}/upload`, {
        method: 'POST',
        headers: enc.headers,
        body: enc.body,
      })
      expect(res.status).toBe(200)

      const parsed: unknown = JSON.parse(await res.text())
      if (parsed === null || typeof parsed !== 'object') {
        throw new Error('HyperServer did not expose a parsed multipart payload')
      }
      const mp = parsed as MultipartPayload

      expect(mp.fields).toContainEqual({ name: 'title', value: 'My Doc' })
      expect(mp.files).toHaveLength(1)
      const file = mp.files[0]
      expect(file.fieldName).toBe('document')
      expect(file.clientName).toBe('doc.png')
      expect(file.contentType).toBe('image/png')
      expect(file.size).toBe(png.length)
      // The exact bytes (incl. embedded CRLF + 0xff/0x00) survive the round-trip.
      expect(Buffer.from(file.contentB64, 'base64').equals(png)).toBe(true)
    } finally {
      await close()
    }
  })
})
