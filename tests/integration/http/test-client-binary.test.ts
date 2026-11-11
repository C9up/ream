import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TestClient } from '../../../src/testing/TestClient.js'
import { HyperServer } from './loader.js'
import { rawField } from './napi-request.js'

/**
 * The bytes a test uploads are the bytes the server receives. The request
 * body used to round-trip through a UTF-8 string inside the TestClient, so
 * every byte of a PNG or a PDF that is not valid UTF-8 reached the server as
 * U+FFFD — and a test of magic-byte detection or of a stored checksum failed
 * for a reason that is not in the code under test.
 */
const networkAllowed = process.env.REAM_SKIP_NETWORK_TESTS !== '1'
const describeIfNetwork = networkAllowed ? describe : describe.skip

/** The base64 content of the first uploaded file, as the native parser read it. */
function firstFile(raw: Record<string, unknown>): string {
  const payload = rawField(raw, 'multipart')
  if (typeof payload !== 'object' || payload === null) return ''
  const files: unknown = Reflect.get(payload, 'files')
  if (!Array.isArray(files)) return ''
  const first: unknown = files[0]
  if (typeof first !== 'object' || first === null) return ''
  const content: unknown = Reflect.get(first, 'contentB64')
  return typeof content === 'string' ? content : ''
}

describeIfNetwork('TestClient > binary request bodies (real HyperServer)', () => {
  let client: TestClient

  beforeAll(async () => {
    client = new TestClient(async () => {
      const server = new HyperServer(0)
      server.onRequest(async (raw) => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: firstFile(raw) }),
      }))
      await server.listen()
      return { port: await server.port(), close: () => server.close() }
    })
    await client.boot()
  })

  afterAll(async () => {
    await client.close()
  })

  it('uploads a binary file byte for byte', async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x80, 0x00,
    ])
    const response = await client
      .post('/upload')
      .file('avatar', png, { filename: 'a.png', contentType: 'image/png' })
      .send()

    const body: unknown = response.body()
    const file = typeof body === 'object' && body !== null ? Reflect.get(body, 'file') : undefined
    expect(typeof file === 'string' ? Buffer.from(file, 'base64') : undefined).toEqual(png)
  })
})
