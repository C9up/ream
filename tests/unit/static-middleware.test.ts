/**
 * `StaticMiddleware` serves files without stalling the process.
 *
 * It used to `readFileSync` the whole file on the event loop, with `.mp4`,
 * `.zip` and `.pdf` among the allowed extensions — so one client fetching a
 * large asset became every other client's latency, and each request allocated
 * the file again. These tests pin what makes the streaming path trustworthy:
 * the bytes arrive intact, a conditional request is answered without reading
 * anything, and nothing outside the root is reachable through a link.
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpContext } from '../../src/http/HttpContext.js'
import type { StreamBackend } from '../../src/http/SseStream.js'
import { StaticMiddleware } from '../../src/storage/StaticMiddleware.js'

/** Collects what the streaming path pushes, the way the Rust registry would. */
class RecordingBackend implements StreamBackend {
  readonly chunks: Buffer[] = []
  closed = false

  async registerStream(): Promise<boolean> {
    return true
  }
  async writeStream(): Promise<boolean> {
    // Text frames: the static path never uses this, only writeStreamBytes.
    return true
  }
  async writeStreamBytes(_id: string, chunk: Uint8Array): Promise<boolean> {
    this.chunks.push(Buffer.from(chunk))
    return true
  }
  async closeStream(): Promise<boolean> {
    this.closed = true
    return true
  }
  onStreamDisconnect(): void {}
  get body(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

function makeCtx(path: string, headers: Record<string, string> = {}, method = 'GET') {
  const ctx = new HttpContext(
    'test',
    { method, path, query: '', headers, body: '' },
    {},
    { pattern: path, middleware: [] },
  )
  const backend = new RecordingBackend()
  ctx.response.setStreamBackend(backend)
  return { ctx, backend }
}

describe('StaticMiddleware', () => {
  let root: string
  let middleware: StaticMiddleware

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ream-static-'))
    middleware = new StaticMiddleware({ root, prefix: '/static' })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('streams the file instead of reading it whole', async () => {
    // Bigger than one chunk, so a single-buffer implementation would show up
    // as one write and a streamed one as several.
    const payload = Buffer.alloc(200_000, 7)
    writeFileSync(join(root, 'big.zip'), payload)
    const { ctx, backend } = makeCtx('/static/big.zip')

    await middleware.handle(ctx, vi.fn())
    await ctx.response.streamed()

    expect(backend.chunks.length).toBeGreaterThan(1)
    expect(backend.body.equals(payload)).toBe(true)
    expect(backend.closed).toBe(true)
    expect(ctx.response.getHeader('content-length')).toBe(String(payload.length))
  })

  it('serves bytes unchanged for a binary file', async () => {
    // Every byte value, including the ones UTF-8 cannot round-trip.
    const payload = Buffer.from(Array.from({ length: 256 }, (_v, i) => i))
    writeFileSync(join(root, 'all-bytes.png'), payload)
    const { ctx, backend } = makeCtx('/static/all-bytes.png')

    await middleware.handle(ctx, vi.fn())
    await ctx.response.streamed()

    expect(backend.body.equals(payload)).toBe(true)
    expect(ctx.response.getHeader('content-type')).toBe('image/png')
  })

  it('sends a quoted, weak ETag and honours a list in If-None-Match', async () => {
    writeFileSync(join(root, 'a.css'), 'body{}')
    const first = makeCtx('/static/a.css')
    await middleware.handle(first.ctx, vi.fn())
    const etag = first.ctx.response.getHeader('etag')

    // RFC 9110 §8.8.3: an entity-tag is a quoted string. A bare digest is not
    // one, and a strict cache may ignore it.
    expect(etag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/)

    // …and §13.1.2: the header is a list, compared weakly.
    const { ctx, backend } = makeCtx('/static/a.css', {
      'if-none-match': `"something-else", ${(etag ?? '').replace(/^W\//, '')}`,
    })
    await middleware.handle(ctx, vi.fn())
    expect(ctx.response.getStatus()).toBe(304)
    expect(backend.chunks).toEqual([])
  })

  it('answers 304 for If-None-Match: *', async () => {
    writeFileSync(join(root, 'a.css'), 'body{}')
    const { ctx } = makeCtx('/static/a.css', { 'if-none-match': '*' })
    await middleware.handle(ctx, vi.fn())
    expect(ctx.response.getStatus()).toBe(304)
  })

  it('sends headers but no body for HEAD', async () => {
    writeFileSync(join(root, 'a.txt'), 'hello')
    const { ctx, backend } = makeCtx('/static/a.txt', {}, 'HEAD')

    await middleware.handle(ctx, vi.fn())

    expect(ctx.response.getStatus()).toBe(200)
    expect(ctx.response.getHeader('content-length')).toBe('5')
    expect(backend.chunks).toEqual([])
  })

  it('resolves the content type from the generated table', async () => {
    writeFileSync(join(root, 'app.js'), 'export {}')
    const { ctx } = makeCtx('/static/app.js')
    await middleware.handle(ctx, vi.fn())
    // One table for the package: `text/javascript`, as mime-types resolves it,
    // not the `application/javascript` the middleware's own copy used to say.
    expect(ctx.response.getHeader('content-type')).toBe('text/javascript; charset=utf-8')
  })

  it('does not serve a symlink pointing outside the root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'ream-secret-'))
    try {
      writeFileSync(join(outside, 'secret.txt'), 'SECRET')
      symlinkSync(join(outside, 'secret.txt'), join(root, 'public.txt'))
      const { ctx, backend } = makeCtx('/static/public.txt')
      const next = vi.fn<() => Promise<void>>(async () => {})

      await middleware.handle(ctx, next)

      expect(next).toHaveBeenCalled()
      expect(backend.chunks).toEqual([])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('falls through for a missing file, a bad prefix, a bad extension and POST', async () => {
    writeFileSync(join(root, 'secret.env'), 'SECRET=1')
    const cases: Array<[string, string]> = [
      ['/static/never.txt', 'GET'],
      ['/staticx/evil.css', 'GET'],
      ['/static/secret.env', 'GET'],
      ['/static/never.txt', 'POST'],
    ]
    for (const [path, method] of cases) {
      const { ctx, backend } = makeCtx(path, {}, method)
      const next = vi.fn<() => Promise<void>>(async () => {})
      await middleware.handle(ctx, next)
      expect(next, `${method} ${path}`).toHaveBeenCalledTimes(1)
      expect(backend.chunks, `${method} ${path}`).toEqual([])
    }
  })

  it('blocks traversal even when the extension is allowed', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'ream-outside-'))
    try {
      writeFileSync(join(outside, 'secret.txt'), 'pwned')
      const { ctx, backend } = makeCtx(`/static/../../${join(outside, 'secret.txt')}`)
      const next = vi.fn<() => Promise<void>>(async () => {})
      await middleware.handle(ctx, next)
      expect(next).toHaveBeenCalledTimes(1)
      expect(backend.chunks).toEqual([])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('leaks no descriptor across many conditional requests', async () => {
    writeFileSync(join(root, 'a.css'), 'body{}')
    const probe = makeCtx('/static/a.css')
    await middleware.handle(probe.ctx, vi.fn())
    const etag = probe.ctx.response.getHeader('etag') ?? ''
    await probe.ctx.response.streamed()

    // A 304 opens the file to stat it and hands the handle to nobody. Without
    // the close, this loop exhausts the descriptor table.
    for (let i = 0; i < 400; i += 1) {
      const { ctx } = makeCtx('/static/a.css', { 'if-none-match': etag })
      await middleware.handle(ctx, vi.fn())
      expect(ctx.response.getStatus()).toBe(304)
    }
    // Still serving after 400 opens.
    const { ctx, backend } = makeCtx('/static/a.css')
    await middleware.handle(ctx, vi.fn())
    await ctx.response.streamed()
    expect(backend.body.toString()).toBe('body{}')
  })
})
