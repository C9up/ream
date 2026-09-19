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

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
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
    await ctx.response.streamed()

    expect(backend.body.equals(payload)).toBe(true)
    expect(ctx.response.getHeader('content-type')).toBe('image/png')
  })

  it('sends a quoted, weak ETag and honours a list in If-None-Match', async () => {
    writeFileSync(join(root, 'a.css'), 'body{}')
    const first = makeCtx('/static/a.css')
    await middleware.handle(first.ctx, vi.fn())
    await first.ctx.response.streamed()
    const etag = first.ctx.response.getHeader('etag')

    // RFC 9110 §8.8.3: an entity-tag is a quoted string. A bare digest is not
    // one, and a strict cache may ignore it.
    expect(etag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/)

    // …and §13.1.2: the header is a list, compared weakly.
    const { ctx, backend } = makeCtx('/static/a.css', {
      'if-none-match': `"something-else", ${(etag ?? '').replace(/^W\//, '')}`,
    })
    await middleware.handle(ctx, vi.fn())
    await ctx.response.streamed()
    expect(ctx.response.getStatus()).toBe(304)
    expect(backend.chunks).toEqual([])
  })

  it('answers 304 for If-None-Match: *', async () => {
    writeFileSync(join(root, 'a.css'), 'body{}')
    const { ctx } = makeCtx('/static/a.css', { 'if-none-match': '*' })
    await middleware.handle(ctx, vi.fn())
    await ctx.response.streamed()
    expect(ctx.response.getStatus()).toBe(304)
  })

  it('sends headers but no body for HEAD', async () => {
    writeFileSync(join(root, 'a.txt'), 'hello')
    const { ctx, backend } = makeCtx('/static/a.txt', {}, 'HEAD')

    await middleware.handle(ctx, vi.fn())
    await ctx.response.streamed()

    expect(ctx.response.getStatus()).toBe(200)
    expect(ctx.response.getHeader('content-length')).toBe('5')
    expect(backend.chunks).toEqual([])
  })

  it('resolves the content type from the generated table', async () => {
    writeFileSync(join(root, 'app.js'), 'export {}')
    const { ctx } = makeCtx('/static/app.js')
    await middleware.handle(ctx, vi.fn())
    await ctx.response.streamed()
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
      await ctx.response.streamed()

      expect(next).toHaveBeenCalled()
      expect(backend.chunks).toEqual([])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('falls through for a missing file, a bad prefix and a non-GET method', async () => {
    // There is no extension allowlist, upstream has none either, and the
    // directory being served is the PUBLIC one — a `secret.env` placed in it
    // is served, exactly as AdonisJS would. What protects a secret is not
    // putting it here; what the middleware guarantees is the dotfile rule and
    // containment, both covered below.
    const cases: Array<[string, string]> = [
      ['/static/never.txt', 'GET'],
      ['/staticx/evil.css', 'GET'],
      ['/static/never.txt', 'POST'],
    ]
    for (const [path, method] of cases) {
      const { ctx, backend } = makeCtx(path, {}, method)
      const next = vi.fn<() => Promise<void>>(async () => {})
      await middleware.handle(ctx, next)
      await ctx.response.streamed()
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
      await ctx.response.streamed()
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
    await probe.ctx.response.streamed()
    const etag = probe.ctx.response.getHeader('etag') ?? ''
    await probe.ctx.response.streamed()

    // A 304 opens the file to stat it and hands the handle to nobody. Without
    // the close, this loop exhausts the descriptor table.
    for (let i = 0; i < 400; i += 1) {
      const { ctx } = makeCtx('/static/a.css', { 'if-none-match': etag })
      await middleware.handle(ctx, vi.fn())
      await ctx.response.streamed()
      expect(ctx.response.getStatus()).toBe(304)
    }
    // Still serving after 400 opens.
    const { ctx, backend } = makeCtx('/static/a.css')
    await middleware.handle(ctx, vi.fn())
    await ctx.response.streamed()
    await ctx.response.streamed()
    expect(backend.body.toString()).toBe('body{}')
  })
})

/**
 * The half AdonisJS gets for free by wrapping `serve-static`, and this file had
 * to write by hand: date validation, byte ranges, dotfiles, index and fallback
 * extensions. Same option names, same defaults, same headers.
 */
describe('StaticMiddleware > AdonisJS parity', () => {
  let root: string
  let middleware: StaticMiddleware

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ream-static-parity-'))
    middleware = new StaticMiddleware({ root })
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('serves from the URL root, with no prefix, as upstream does', async () => {
    writeFileSync(join(root, 'logo.png'), 'PNG')
    const { ctx, backend } = makeCtx('/logo.png')
    await middleware.handle(ctx, vi.fn())
    await ctx.response.streamed()
    expect(ctx.response.getStatus()).toBe(200)
    expect(backend.body.toString()).toBe('PNG')
  })

  it('serves .avif — an allowlist would have refused what prism produces', async () => {
    writeFileSync(join(root, 'hero.avif'), 'AVIF')
    const { ctx, backend } = makeCtx('/hero.avif')
    await middleware.handle(ctx, vi.fn())
    await ctx.response.streamed()
    expect(ctx.response.getStatus()).toBe(200)
    expect(backend.body.toString()).toBe('AVIF')
  })

  it('sends Last-Modified and answers 304 to a fresh If-Modified-Since', async () => {
    writeFileSync(join(root, 'a.css'), 'body{}')
    const first = makeCtx('/a.css')
    await middleware.handle(first.ctx, vi.fn())
    await first.ctx.response.streamed()
    const lastModified = first.ctx.response.getHeader('last-modified')
    expect(lastModified).toMatch(/GMT$/)

    // No If-None-Match here: the date is the only validator the client sends,
    // which is the case this exists for.
    const { ctx, backend } = makeCtx('/a.css', {
      'if-modified-since': String(lastModified),
    })
    await middleware.handle(ctx, vi.fn())
    await ctx.response.streamed()
    expect(ctx.response.getStatus()).toBe(304)
    expect(backend.chunks).toEqual([])
  })

  it('serves the file when If-Modified-Since predates it', async () => {
    writeFileSync(join(root, 'a.css'), 'body{}')
    const { ctx, backend } = makeCtx('/a.css', {
      'if-modified-since': new Date(0).toUTCString(),
    })
    await middleware.handle(ctx, vi.fn())
    await ctx.response.streamed()
    expect(ctx.response.getStatus()).toBe(200)
    expect(backend.body.toString()).toBe('body{}')
  })

  it('answers a byte range with 206 and the right slice', async () => {
    writeFileSync(join(root, 'clip.mp4'), 'abcdefghij')
    const { ctx, backend } = makeCtx('/clip.mp4', { range: 'bytes=2-5' })
    await middleware.handle(ctx, vi.fn())
    await ctx.response.streamed()
    expect(ctx.response.getStatus()).toBe(206)
    expect(ctx.response.getHeader('content-range')).toBe('bytes 2-5/10')
    expect(ctx.response.getHeader('content-length')).toBe('4')
    expect(backend.body.toString()).toBe('cdef')
  })

  it('reads a suffix range from the END of the file', async () => {
    // `bytes=-3` is the last three bytes, not the first three — the one part
    // of the grammar that inverts, and the one worth pinning.
    writeFileSync(join(root, 'clip.mp4'), 'abcdefghij')
    const { ctx, backend } = makeCtx('/clip.mp4', { range: 'bytes=-3' })
    await middleware.handle(ctx, vi.fn())
    await ctx.response.streamed()
    expect(ctx.response.getStatus()).toBe(206)
    expect(backend.body.toString()).toBe('hij')
  })

  it('answers 416 with Content-Range for a range past the end', async () => {
    writeFileSync(join(root, 'clip.mp4'), 'abcdefghij')
    const { ctx, backend } = makeCtx('/clip.mp4', { range: 'bytes=50-60' })
    await middleware.handle(ctx, vi.fn())
    await ctx.response.streamed()
    expect(ctx.response.getStatus()).toBe(416)
    expect(ctx.response.getHeader('content-range')).toBe('bytes */10')
    expect(backend.chunks).toEqual([])
  })

  it('advertises Accept-Ranges so a client knows it can seek', async () => {
    writeFileSync(join(root, 'a.txt'), 'hello')
    const { ctx } = makeCtx('/a.txt')
    await middleware.handle(ctx, vi.fn())
    await ctx.response.streamed()
    expect(ctx.response.getHeader('accept-ranges')).toBe('bytes')
  })

  it('serves the whole file when If-Range does not match the current version', async () => {
    // Otherwise a resumed download stitches bytes from two different versions.
    writeFileSync(join(root, 'clip.mp4'), 'abcdefghij')
    const { ctx, backend } = makeCtx('/clip.mp4', {
      range: 'bytes=2-5',
      'if-range': '"a-stale-etag"',
    })
    await middleware.handle(ctx, vi.fn())
    await ctx.response.streamed()
    expect(ctx.response.getStatus()).toBe(200)
    expect(backend.body.toString()).toBe('abcdefghij')
  })

  it('ignores a dotfile by default, and denies one when asked', async () => {
    writeFileSync(join(root, '.env'), 'SECRET=1')

    const ignored = makeCtx('/.env')
    const next = vi.fn<() => Promise<void>>(async () => {})
    await middleware.handle(ignored.ctx, next)
    await ignored.ctx.response.streamed()
    expect(next).toHaveBeenCalledTimes(1)
    expect(ignored.backend.chunks).toEqual([])

    const denying = new StaticMiddleware({ root, dotFiles: 'deny' })
    const denied = makeCtx('/.env')
    await denying.handle(denied.ctx, vi.fn())
    await denied.ctx.response.streamed()
    expect(denied.ctx.response.getStatus()).toBe(403)
  })

  it('serves index.html for a directory, and nothing when index is off', async () => {
    writeFileSync(join(root, 'index.html'), '<h1>home</h1>')
    const { ctx, backend } = makeCtx('/')
    await middleware.handle(ctx, vi.fn())
    await ctx.response.streamed()
    expect(backend.body.toString()).toBe('<h1>home</h1>')

    const noIndex = new StaticMiddleware({ root, index: false })
    const bare = makeCtx('/')
    const next = vi.fn<() => Promise<void>>(async () => {})
    await noIndex.handle(bare.ctx, next)
    await bare.ctx.response.streamed()
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('treats `extensions` as a FALLBACK list, not an allowlist', async () => {
    // Upstream's meaning: /about with no file tries about.html. Read as an
    // allowlist — which this option used to be — the same config would instead
    // have restricted the server to .html and refused every image.
    writeFileSync(join(root, 'about.html'), '<h1>about</h1>')
    writeFileSync(join(root, 'photo.jpg'), 'JPEG')
    const withFallback = new StaticMiddleware({ root, extensions: ['html'] })

    const page = makeCtx('/about')
    await withFallback.handle(page.ctx, vi.fn())
    await page.ctx.response.streamed()
    expect(page.backend.body.toString()).toBe('<h1>about</h1>')

    const image = makeCtx('/photo.jpg')
    await withFallback.handle(image.ctx, vi.fn())
    await image.ctx.response.streamed()
    expect(image.ctx.response.getStatus()).toBe(200)
    expect(image.backend.body.toString()).toBe('JPEG')
  })

  it('builds Cache-Control the way upstream does, immutable included', async () => {
    writeFileSync(join(root, 'a.css'), 'body{}')

    // maxAge is MILLISECONDS upstream, max-age is seconds on the wire.
    const cached = new StaticMiddleware({ root, maxAge: 86_400_000, immutable: true })
    const hit = makeCtx('/a.css')
    await cached.handle(hit.ctx, vi.fn())
    await hit.ctx.response.streamed()
    expect(hit.ctx.response.getHeader('cache-control')).toBe('public, max-age=86400, immutable')

    // immutable on a response that expires at once tells a cache two opposite
    // things, so upstream drops it without a max-age.
    const noAge = new StaticMiddleware({ root, immutable: true })
    const plain = makeCtx('/a.css')
    await noAge.handle(plain.ctx, vi.fn())
    await plain.ctx.response.streamed()
    expect(plain.ctx.response.getHeader('cache-control')).toBe('public, max-age=0')

    const off = new StaticMiddleware({ root, cacheControl: false, maxAge: 86_400_000 })
    const bare = makeCtx('/a.css')
    await off.handle(bare.ctx, vi.fn())
    await bare.ctx.response.streamed()
    expect(bare.ctx.response.getHeader('cache-control')).toBeUndefined()
  })

  it('falls through entirely when disabled', async () => {
    writeFileSync(join(root, 'a.txt'), 'hello')
    const disabled = new StaticMiddleware({ root, enabled: false })
    const { ctx, backend } = makeCtx('/a.txt')
    const next = vi.fn<() => Promise<void>>(async () => {})
    await disabled.handle(ctx, next)
    await ctx.response.streamed()
    expect(next).toHaveBeenCalledTimes(1)
    expect(backend.chunks).toEqual([])
  })
})

/**
 * Containment. Everything here is an attempt to read a file the server was
 * never asked to publish, and every one of them must end in `next()` — never
 * in bytes, and never in a 500 either, since a crash on a crafted path is its
 * own denial of service.
 */
describe('StaticMiddleware > nothing outside the root', () => {
  let root: string
  let outside: string
  let middleware: StaticMiddleware

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ream-static-jail-'))
    outside = mkdtempSync(join(tmpdir(), 'ream-static-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'SECRET')
    middleware = new StaticMiddleware({ root })
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  const traversals = [
    ['plain', '/../../../etc/passwd'],
    ['percent-encoded dot-dot', '/%2e%2e/%2e%2e/etc/passwd'],
    ['encoded slash', '/..%2f..%2fetc/passwd'],
    ['fully encoded', '/%2e%2e%2f%2e%2e%2fetc%2fpasswd'],
    ['doubled slashes', '//etc/passwd'],
    ['dot-segments in the middle', '/assets/../../etc/passwd'],
    ['trailing NUL', '/a.txt%00.png'],
    ['malformed percent', '/%'],
    ['lone percent mid-path', '/img/%zz/a.png'],
  ] as const

  for (const [name, path] of traversals) {
    it(`refuses to leave the root: ${name}`, async () => {
      const { ctx, backend } = makeCtx(path)
      const next = vi.fn<() => Promise<void>>(async () => {})
      await middleware.handle(ctx, next)
      await ctx.response.streamed()
      expect(next, path).toHaveBeenCalledTimes(1)
      expect(backend.chunks, path).toEqual([])
      // Not a crash either: a thrown decode would be a 500 on a path anyone
      // can type.
      expect(ctx.response.getStatus(), path).not.toBe(500)
    })
  }

  it('refuses a symlink planted inside the root that points outside it', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'))
    const { ctx, backend } = makeCtx('/link.txt')
    const next = vi.fn<() => Promise<void>>(async () => {})
    await middleware.handle(ctx, next)
    await ctx.response.streamed()
    expect(next).toHaveBeenCalledTimes(1)
    expect(backend.body.toString()).not.toContain('SECRET')
  })

  it('refuses a symlinked DIRECTORY that points outside the root', async () => {
    symlinkSync(outside, join(root, 'pub'))
    const { ctx, backend } = makeCtx('/pub/secret.txt')
    const next = vi.fn<() => Promise<void>>(async () => {})
    await middleware.handle(ctx, next)
    await ctx.response.streamed()
    expect(next).toHaveBeenCalledTimes(1)
    expect(backend.body.toString()).not.toContain('SECRET')
  })

  it('does not treat a sibling directory with a shared prefix as inside', async () => {
    // `/tmp/ream-static-jail-XXXX` must not admit `/tmp/ream-static-jail-XXXXevil`.
    const sibling = `${root}-evil`
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, 'secret.txt'), 'SECRET')
    try {
      const { ctx, backend } = makeCtx(`/../${basename(sibling)}/secret.txt`)
      const next = vi.fn<() => Promise<void>>(async () => {})
      await middleware.handle(ctx, next)
      await ctx.response.streamed()
      expect(next).toHaveBeenCalledTimes(1)
      expect(backend.body.toString()).not.toContain('SECRET')
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })

  it('still serves a legitimate nested file, so the guard is not just refusing everything', async () => {
    mkdirSync(join(root, 'img'), { recursive: true })
    writeFileSync(join(root, 'img', 'logo.png'), 'PNG')
    const { ctx, backend } = makeCtx('/img/logo.png')
    await middleware.handle(ctx, vi.fn())
    await ctx.response.streamed()
    expect(backend.body.toString()).toBe('PNG')
  })

  it('serves a path whose percent-encoding is legitimate', async () => {
    // Encoding is not an attack by itself: a space in a filename arrives as
    // %20 and must still resolve.
    writeFileSync(join(root, 'my logo.png'), 'PNG')
    const { ctx, backend } = makeCtx('/my%20logo.png')
    await middleware.handle(ctx, vi.fn())
    await ctx.response.streamed()
    expect(backend.body.toString()).toBe('PNG')
  })
})

/**
 * The same guarantee, stated against the real filesystem rather than against a
 * fixture: whatever the request looks like, the bytes of a real system file
 * must never reach the client. Asserting on `next()` alone would still pass if
 * the middleware served the wrong thing through a path this suite did not
 * model, so these compare against what is actually on disk.
 */
describe('StaticMiddleware > system files stay unreachable', () => {
  let root: string
  let middleware: StaticMiddleware
  // Read now, so the comparison is against the real content and not a guess.
  const systemFile = '/etc/hostname'
  const systemContent = existsSync(systemFile) ? readFileSync(systemFile, 'utf8').trim() : ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ream-static-sys-'))
    middleware = new StaticMiddleware({ root })
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const attempts = [
    // With no prefix the middleware is mounted at the URL root, so this is the
    // shape that looks like it ought to work. It resolves to <root>/etc/...,
    // which does not exist.
    '/etc/hostname',
    '/etc/passwd',
    '/../../../../../../etc/hostname',
    '/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/hostname',
    '/./../.././../etc/hostname',
  ]

  for (const path of attempts) {
    it(`serves nothing for ${path}`, async () => {
      const { ctx, backend } = makeCtx(path)
      const next = vi.fn<() => Promise<void>>(async () => {})
      await middleware.handle(ctx, next)
      await ctx.response.streamed()

      expect(next, path).toHaveBeenCalledTimes(1)
      expect(backend.chunks, path).toEqual([])
      if (systemContent.length > 0) {
        expect(backend.body.toString(), path).not.toContain(systemContent)
      }
    })
  }

  it('cannot be reached through a prefix either', async () => {
    const prefixed = new StaticMiddleware({ root, prefix: '/static' })
    const { ctx, backend } = makeCtx('/static/../../../../etc/hostname')
    const next = vi.fn<() => Promise<void>>(async () => {})
    await prefixed.handle(ctx, next)
    await ctx.response.streamed()
    expect(next).toHaveBeenCalledTimes(1)
    expect(backend.chunks).toEqual([])
  })

  it('serves a file the app really did put in the root, named like a system one', async () => {
    // The guard is about location, not about names: <root>/etc/hostname is the
    // application's own file and is published like any other.
    mkdirSync(join(root, 'etc'), { recursive: true })
    writeFileSync(join(root, 'etc', 'hostname'), 'mine')
    const { ctx, backend } = makeCtx('/etc/hostname')
    await middleware.handle(ctx, vi.fn())
    await ctx.response.streamed()
    expect(backend.body.toString()).toBe('mine')
  })
})
