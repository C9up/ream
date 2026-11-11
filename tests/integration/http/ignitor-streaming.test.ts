/**
 * Downloads stream through a booted application, not only through a bare
 * server. The byte channel lives on the native server, and only the backend
 * the Ignitor builds hands it to `Response`: when that backend left it out,
 * every download, `response.stream()` and static file was read whole,
 * base64-encoded and refused past the response ceiling.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHyperServerFactory } from '../../../src/bootstrap/hyper-server.js'
import { Response } from '../../../src/http/Response.js'
import { Ignitor } from '../../../src/index.js'

const networkAllowed = process.env.REAM_SKIP_NETWORK_TESTS !== '1'
const describeIfNetwork = networkAllowed ? describe : describe.skip

describeIfNetwork('Ignitor > downloads are streamed, never buffered', () => {
  const payload = randomBytes(512 * 1024)
  const dir = mkdtempSync(join(tmpdir(), 'ream-ignitor-stream-'))
  const file = join(dir, 'archive.bin')
  writeFileSync(file, payload)

  let ignitor: Ignitor
  let port = 0

  beforeAll(async () => {
    const serverFactory = createHyperServerFactory()
    if (serverFactory === undefined)
      throw new Error('no prebuilt HyperServer binary for this platform')
    ignitor = await new Ignitor({ port: 0, gracefulShutdown: false, serverFactory })
      .routes((router) => {
        router.get('/download', ({ response }) => response.download(file))
        router.get('/stream', ({ response }) =>
          response.stream(Readable.from([payload.subarray(0, 1000), payload.subarray(1000)])),
        )
      })
      .httpServer()
      .start()
    port = await ignitor.port()
  })

  afterAll(async () => {
    await ignitor.stop()
  })

  it('sends a file through download() without ever calling sendBuffer', async () => {
    const sendBuffer = vi.spyOn(Response.prototype, 'sendBuffer')
    try {
      const res = await fetch(`http://127.0.0.1:${port}/download`)
      expect(res.status).toBe(200)
      expect(res.headers.get('x-ream-body-encoding')).toBeNull()
      const received = Buffer.from(await res.arrayBuffer())
      expect(received.equals(payload)).toBe(true)
      expect(sendBuffer).not.toHaveBeenCalled()
    } finally {
      sendBuffer.mockRestore()
    }
  })

  it('pipes response.stream() byte for byte without buffering it', async () => {
    const sendBuffer = vi.spyOn(Response.prototype, 'sendBuffer')
    try {
      const res = await fetch(`http://127.0.0.1:${port}/stream`)
      expect(res.status).toBe(200)
      const received = Buffer.from(await res.arrayBuffer())
      expect(received.equals(payload)).toBe(true)
      expect(sendBuffer).not.toHaveBeenCalled()
    } finally {
      sendBuffer.mockRestore()
    }
  })
})
