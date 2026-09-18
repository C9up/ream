/**
 * Static file serving middleware.
 *
 * The shape is `@adonisjs/static`'s, whose own work is done by `serve-static`:
 * the same option names, the same defaults, the same response headers. Ream
 * cannot delegate to `serve-static` itself —
 *
 * NAMED DEVIATION (NAPI): `serve-static` writes to a Node `ServerResponse`, and
 * Ream's response crosses the NAPI boundary as a complete object; there is no
 * such object to hand it. So the BEHAVIOUR is reproduced here rather than the
 * code, and every deviation from it below is deliberate and marked.
 *
 * One deviation is a deliberate improvement, kept per the rule that we do not
 * give up safety for parity: the file is opened with `O_NOFOLLOW` and its
 * metadata read from the descriptor, so the bytes served are the ones that
 * passed the containment checks. `serve-static` re-reads by path.
 *
 * Usage:
 *   server.use(new StaticMiddleware({ root: app.publicPath() }))
 *
 * @implements MISS-25
 */

import * as fs from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { matchesIfNoneMatch, statTag } from '../http/etag.js'
import type { HttpContext } from '../http/HttpContext.js'
import { contentType } from '../http/mime.js'

/** How a request for a dotfile is answered (`send`'s `dotfiles`). */
export type DotFilesPolicy = 'allow' | 'deny' | 'ignore'

export interface StaticConfig {
  /** Root directory to serve files from. */
  root: string

  /** Serve at all. `false` makes every request fall through. Default `true`. */
  enabled?: boolean

  /**
   * Answer `Range` requests with `206`, and advertise `Accept-Ranges: bytes`.
   * Default `true` — without it a browser cannot seek in audio or video, and
   * an interrupted download restarts from zero.
   */
  acceptRanges?: boolean

  /**
   * Emit `Cache-Control`. Default `true`. When `false`, `maxAge` and
   * `immutable` are ignored, as upstream documents.
   */
  cacheControl?: boolean

  /**
   * Dotfiles: `'ignore'` (fall through, the default), `'deny'` (403), or
   * `'allow'` (serve). The default is why `.env` in the served root is not
   * an accident waiting to happen.
   */
  dotFiles?: DotFilesPolicy

  /** Emit `ETag` and honour `If-None-Match`. Default `true`. */
  etag?: boolean

  /**
   * FALLBACK extensions, NOT an allowlist: when the requested path has no
   * file, try appending each of these. `['html']` makes `/about` serve
   * `about.html`. Default: none.
   *
   * The name and meaning are upstream's. An earlier version of this file used
   * the same option as an allowlist — the opposite meaning — which silently
   * restricted the server for anyone porting an AdonisJS config across, and
   * refused formats the framework itself produces (`.avif`, from prism).
   */
  extensions?: string[] | false

  /** Add `immutable` to `Cache-Control`. Needs `maxAge`. Default `false`. */
  immutable?: boolean

  /** Index file for a directory request. Default `'index.html'`; `false` disables. */
  index?: string | string[] | false

  /** Emit `Last-Modified` and honour `If-Modified-Since`. Default `true`. */
  lastModified?: boolean

  /** `Cache-Control: max-age`, in MILLISECONDS as upstream. Default `0`. */
  maxAge?: number

  /** Extra headers, per file. Runs last, so it can override the above. */
  headers?: (filePath: string, stat: fs.Stats) => Record<string, string>

  /**
   * Serve only under this URL prefix.
   *
   * NAMED DEVIATION: AdonisJS has no such option — its middleware is mounted at
   * the URL root and falls through. Ream keeps it because the router is the
   * same object the application writes to, and narrowing is occasionally what
   * an application wants. The default is upstream's behaviour: no prefix.
   */
  prefix?: string
}

/** A single satisfiable byte range. */
interface ByteRange {
  start: number
  end: number
}

export class StaticMiddleware {
  readonly #root: string
  readonly #enabled: boolean
  readonly #acceptRanges: boolean
  readonly #cacheControl: boolean
  readonly #dotFiles: DotFilesPolicy
  readonly #etag: boolean
  readonly #extensions: string[]
  readonly #immutable: boolean
  readonly #index: string[]
  readonly #lastModified: boolean
  readonly #maxAge: number
  readonly #headers?: (filePath: string, stat: fs.Stats) => Record<string, string>
  readonly #prefix: string

  constructor(config: StaticConfig) {
    this.#root = path.resolve(config.root)
    this.#enabled = config.enabled ?? true
    this.#acceptRanges = config.acceptRanges ?? true
    this.#cacheControl = config.cacheControl ?? true
    this.#dotFiles = config.dotFiles ?? 'ignore'
    this.#etag = config.etag ?? true
    this.#extensions = config.extensions === false ? [] : (config.extensions ?? [])
    this.#immutable = config.immutable ?? false
    this.#index =
      config.index === false
        ? []
        : typeof config.index === 'string'
          ? [config.index]
          : (config.index ?? ['index.html'])
    this.#lastModified = config.lastModified ?? true
    this.#maxAge = config.maxAge ?? 0
    this.#headers = config.headers
    this.#prefix = config.prefix ?? ''
  }

  async handle(ctx: HttpContext, next: () => Promise<void>): Promise<void> {
    if (!this.#enabled) return next()
    const method = ctx.request.method()
    if (method !== 'GET' && method !== 'HEAD') return next()

    const reqPath = ctx.request.path()

    // A dotfile under `deny` is answered, not passed on: falling through would
    // leak its existence through whatever the router answers next.
    if (this.#dotFiles === 'deny' && this.#hasDotSegment(reqPath)) {
      ctx.response.status(403).send('Forbidden')
      return
    }

    const resolved = await this.#openServableFile(reqPath)
    if (!resolved) return next()
    const { handle, filePath, stat } = resolved

    // The handle is ours until a read stream takes it; every path that does not
    // hand it over closes it, or the process leaks a descriptor per 304.
    let owned = true
    try {
      const etag = this.#etag ? statTag(stat) : undefined
      const lastModified = this.#lastModified ? stat.mtime.toUTCString() : undefined

      // One table for the whole package (`src/http/mime.ts`), generated from
      // mime-db. A second hand-written one here is how `.js` came to be served
      // as `application/javascript` from one path and `text/javascript` from
      // the other.
      ctx.response.header(
        'Content-Type',
        contentType(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
      )
      if (etag) ctx.response.header('ETag', etag)
      if (lastModified) ctx.response.header('Last-Modified', lastModified)
      if (this.#cacheControl) ctx.response.header('Cache-Control', this.#cacheControlValue())
      if (this.#acceptRanges) ctx.response.header('Accept-Ranges', 'bytes')
      if (this.#headers) {
        for (const [name, value] of Object.entries(this.#headers(filePath, stat))) {
          ctx.response.header(name, value)
        }
      }

      if (this.#isFresh(ctx, etag, stat)) {
        // A 304 carries no body and no Content-Length: the client reuses the
        // copy it already has.
        ctx.response.status(304)
        return
      }

      const range = this.#acceptRanges ? this.#resolveRange(ctx, stat, etag) : undefined
      if (range === 'unsatisfiable') {
        ctx.response.header('Content-Range', `bytes */${stat.size}`)
        ctx.response.status(416).send('')
        return
      }

      const length = range ? range.end - range.start + 1 : stat.size
      ctx.response.header('Content-Length', String(length))
      if (range) {
        ctx.response.header('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`)
      }

      if (method === 'HEAD') {
        // HEAD carries the headers a GET would, and no body.
        ctx.response.status(range ? 206 : 200)
        return
      }

      // Streamed, not read whole. `readFileSync` stalled the event loop for
      // every concurrent request while one client asked for a file, and one
      // large asset became every other request's latency. The read stream owns
      // the handle from here and closes it at end.
      ctx.response.status(range ? 206 : 200)
      owned = false
      await ctx.response.stream(
        range
          ? handle.createReadStream({ start: range.start, end: range.end })
          : handle.createReadStream(),
      )
    } finally {
      if (owned) await handle.close().catch(() => {})
    }
  }

  /** `Cache-Control`, built the way `send` builds it. */
  #cacheControlValue(): string {
    const seconds = Math.floor(this.#maxAge / 1000)
    let value = `public, max-age=${seconds}`
    // Upstream only honours `immutable` alongside a max-age: `immutable` on a
    // response that expires immediately tells a cache two opposite things.
    if (this.#immutable && seconds > 0) value += ', immutable'
    return value
  }

  /**
   * Is the client's copy still good? `If-None-Match` wins outright when
   * present, and `If-Modified-Since` is only consulted in its absence — the
   * order RFC 9110 §13.1.3 requires, and the reason a weak ETag plus a
   * second-resolution mtime do not contradict each other.
   */
  #isFresh(ctx: HttpContext, etag: string | undefined, stat: fs.Stats): boolean {
    const ifNoneMatch = ctx.request.header('if-none-match')
    if (ifNoneMatch !== undefined && ifNoneMatch !== null) {
      return etag !== undefined && matchesIfNoneMatch(ifNoneMatch, etag)
    }
    if (!this.#lastModified) return false
    const since = ctx.request.header('if-modified-since')
    if (since === undefined || since === null) return false
    const sinceMs = Date.parse(Array.isArray(since) ? since[0] : String(since))
    if (Number.isNaN(sinceMs)) return false
    // HTTP dates have one-second resolution; the file's mtime does not. Compare
    // at the coarser one, or a file written mid-second looks modified forever.
    return Math.floor(stat.mtimeMs / 1000) * 1000 <= sinceMs
  }

  /**
   * The range to serve, `undefined` for the whole file, or `'unsatisfiable'`
   * for a 416.
   *
   * Only a single range is honoured. Multiple ranges require a
   * `multipart/byteranges` body, which upstream supports and this does not —
   * a request for several is served whole, which is a response every client
   * accepts.
   */
  #resolveRange(
    ctx: HttpContext,
    stat: fs.Stats,
    etag: string | undefined,
  ): ByteRange | 'unsatisfiable' | undefined {
    const raw = ctx.request.header('range')
    if (raw === undefined || raw === null) return undefined
    const header = Array.isArray(raw) ? raw[0] : String(raw)

    // `If-Range` guards against a resumed download stitching bytes from two
    // different versions of the file: if the validator does not match, the
    // whole current file is the honest answer.
    const ifRange = ctx.request.header('if-range')
    if (ifRange !== undefined && ifRange !== null) {
      const value = Array.isArray(ifRange) ? ifRange[0] : String(ifRange)
      const matchesEtag = etag !== undefined && value.trim() === etag
      const asDate = Date.parse(value)
      const matchesDate = !Number.isNaN(asDate) && Math.floor(stat.mtimeMs / 1000) * 1000 <= asDate
      if (!matchesEtag && !matchesDate) return undefined
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
    if (!match) return undefined // not a form we serve: send the whole file
    const [, rawStart, rawEnd] = match
    if (rawStart === '' && rawEnd === '') return undefined

    let start: number
    let end: number
    if (rawStart === '') {
      // `bytes=-500`: the LAST 500 bytes, not the first.
      const suffix = Number(rawEnd)
      if (suffix === 0) return 'unsatisfiable'
      start = Math.max(stat.size - suffix, 0)
      end = stat.size - 1
    } else {
      start = Number(rawStart)
      end = rawEnd === '' ? stat.size - 1 : Math.min(Number(rawEnd), stat.size - 1)
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
      return 'unsatisfiable'
    }
    return { start, end }
  }

  #hasDotSegment(reqPath: string): boolean {
    return reqPath.split('/').some((segment) => segment.length > 1 && segment.startsWith('.'))
  }

  /**
   * Open a request path as a real, in-root, regular file, or answer `null` when
   * it is not servable. `null` tells `handle` to call `next()`.
   *
   * The file is OPENED here rather than merely checked, and its metadata read
   * from the descriptor: what gets served is then the same file that passed the
   * checks, which a path re-read after the fact cannot promise.
   */
  async #openServableFile(
    reqPath: string,
  ): Promise<{ handle: FileHandle; filePath: string; stat: fs.Stats } | null> {
    if (this.#prefix !== '') {
      // Match only when the prefix is followed by `/` or end-of-path —
      // otherwise `/staticx/foo.js` would be intercepted when the configured
      // prefix is `/static`, hijacking unrelated routes.
      if (!(reqPath === this.#prefix || reqPath.startsWith(`${this.#prefix}/`))) return null
      reqPath = reqPath.slice(this.#prefix.length) || '/'
    }

    if (this.#dotFiles === 'ignore' && this.#hasDotSegment(reqPath)) return null

    // The candidates, in upstream's order: the path itself, then the path with
    // each fallback extension, then the index files for a directory request.
    //
    // Percent-decoding happens BEFORE resolution on purpose: `%2e%2e%2f` is
    // `../` and has to be normalised away by `path.resolve` like any other
    // traversal, not carried through as an opaque segment. `decodeURIComponent`
    // THROWS on a malformed sequence (a lone `%`), which would otherwise become
    // a 500 on a request anyone can send.
    let decoded: string
    try {
      decoded = decodeURIComponent(reqPath)
    } catch {
      return null
    }
    // A NUL truncates the path in the syscall layer of some runtimes; Node
    // rejects it, but refusing here keeps the decision in one place.
    if (decoded.includes('\0')) return null
    const relative = decoded.replace(/^\/+/, '')
    const candidates: string[] = []
    if (relative !== '') {
      candidates.push(relative)
      for (const ext of this.#extensions) {
        candidates.push(`${relative}.${ext.replace(/^\./, '')}`)
      }
    }
    for (const index of this.#index) {
      candidates.push(relative === '' ? index : `${relative}/${index}`)
    }

    for (const candidate of candidates) {
      const opened = await this.#openInRoot(candidate)
      if (opened) return opened
    }
    return null
  }

  /** One candidate, fully contained and opened, or `null`. */
  async #openInRoot(
    relative: string,
  ): Promise<{ handle: FileHandle; filePath: string; stat: fs.Stats } | null> {
    const filePath = path.resolve(this.#root, relative)

    // Two containment checks. The first uses `path.sep` to reject sibling
    // directories with a shared prefix (`/var/www-static-secret` slipping past
    // a guard for `/var/www-static`). The second resolves symlinks via realpath
    // so a symlink planted inside the root cannot point outside it. Realpath
    // runs AFTER the lexical check so a non-existent path returns null rather
    // than throwing.
    const rootWithSep = this.#root.endsWith(path.sep) ? this.#root : this.#root + path.sep
    if (filePath !== this.#root && !filePath.startsWith(rootWithSep)) return null

    let realFilePath: string
    let realRoot: string
    try {
      realFilePath = await fsp.realpath(filePath)
      realRoot = await fsp.realpath(this.#root)
    } catch {
      return null
    }
    const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep
    if (realFilePath !== realRoot && !realFilePath.startsWith(realRootWithSep)) return null

    // O_NOFOLLOW closes the window the checks above leave open: between
    // `realpath` and the read, the last path component can be replaced by a
    // symlink pointing anywhere, and a read by name follows it. Refusing to
    // follow a link at open time makes that swap fail the open instead of
    // serving a file outside the root. A parent directory swapped in the same
    // window is not covered — that needs openat(), which Node does not expose.
    let handle: FileHandle
    try {
      handle = await fsp.open(realFilePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    } catch {
      return null
    }

    try {
      const stat = await handle.stat()
      if (!stat.isFile()) {
        await handle.close()
        return null
      }
      return { handle, filePath: realFilePath, stat }
    } catch {
      await handle.close().catch(() => {})
      return null
    }
  }
}

/**
 * Static config with the defaults filled in — `@adonisjs/static`'s
 * `defineConfig`, value for value.
 *
 *   // config/static.ts
 *   export default defineStaticConfig({ maxAge: 86_400_000 })
 */
export function defineStaticConfig(config: Partial<StaticConfig> = {}): Partial<StaticConfig> {
  return { enabled: true, dotFiles: 'ignore', etag: true, lastModified: true, ...config }
}
