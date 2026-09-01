/**
 * Static file serving middleware.
 *
 * Serves files from a directory with cache headers and ETag support.
 *
 * Usage:
 *   server.use(new StaticMiddleware({ root: 'public' }))
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

export interface StaticConfig {
  /** Root directory to serve files from. */
  root: string
  /** URL prefix (default: /static). */
  prefix?: string
  /** Max-age for Cache-Control header in seconds (default: 86400 = 1 day). */
  maxAge?: number
  /** File extensions to serve (default: common web assets). */
  extensions?: string[]
}

const DEFAULT_EXTENSIONS = [
  '.html',
  '.css',
  '.js',
  '.json',
  '.xml',
  '.txt',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.ico',
  '.webp',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp4',
  '.webm',
  '.mp3',
  '.ogg',
  '.pdf',
  '.zip',
]

export class StaticMiddleware {
  #root: string
  #prefix: string
  #maxAge: number
  #extensions: Set<string>

  constructor(config: StaticConfig) {
    this.#root = path.resolve(config.root)
    this.#prefix = config.prefix ?? '/static'
    this.#maxAge = config.maxAge ?? 86400
    this.#extensions = new Set(config.extensions ?? DEFAULT_EXTENSIONS)
  }

  async handle(ctx: HttpContext, next: () => Promise<void>): Promise<void> {
    if (ctx.request.method() !== 'GET' && ctx.request.method() !== 'HEAD') {
      return next()
    }

    const resolved = await this.#openServableFile(ctx.request.path())
    if (!resolved) return next()
    const { handle, ext, stat } = resolved

    // The handle is ours until the read stream takes it; every path that does
    // not hand it over closes it, or the process leaks a descriptor per 304.
    let owned = true
    try {
      const etag = statTag(stat)

      if (matchesIfNoneMatch(ctx.request.header('if-none-match'), etag)) {
        ctx.response.status(304)
        return
      }

      // One table for the whole package (`src/http/mime.ts`), generated from
      // mime-db. A second hand-written one here is how `.js` came to be
      // served as `application/javascript` from one code path and
      // `text/javascript` from the other.
      ctx.response.header('Content-Type', contentType(ext) || 'application/octet-stream')
      ctx.response.header('Content-Length', String(stat.size))
      ctx.response.header('Cache-Control', `public, max-age=${this.#maxAge}`)
      ctx.response.header('ETag', etag)

      if (ctx.request.method() === 'HEAD') {
        ctx.response.status(200)
        return
      }

      // Streamed, not read whole.
      //
      // `readFileSync` stalled the event loop for EVERY concurrent request
      // while one client asked for a file, and the allowed extensions include
      // `.mp4`, `.zip` and `.pdf` — so one large asset became every other
      // request's latency, and each request allocated the file again. The
      // stream applies backpressure and holds one chunk at a time.
      //
      // The read stream owns the handle from here and closes it at end.
      ctx.response.status(200)
      owned = false
      await ctx.response.stream(handle.createReadStream())
    } finally {
      if (owned) await handle.close().catch(() => {})
    }
  }

  /**
   * Open a request path as a real, in-root, regular file, or answer `null`
   * when it is not servable (wrong prefix/extension, outside the root,
   * missing, or a symlink escaping the root). `null` tells `handle` to call
   * `next()`.
   *
   * The file is OPENED here rather than merely checked, and its metadata read
   * from the descriptor: what gets served is then the same file that passed
   * the checks, which a path re-read after the fact cannot promise.
   */
  async #openServableFile(
    reqPath: string,
  ): Promise<{ handle: FileHandle; ext: string; stat: fs.Stats } | null> {
    // Match only when the prefix is followed by `/` or end-of-path —
    // otherwise `/staticx/foo.js` would be intercepted when the configured
    // prefix is `/static`, hijacking unrelated routes.
    if (!(reqPath === this.#prefix || reqPath.startsWith(`${this.#prefix}/`))) {
      return null
    }

    // Strip prefix and resolve file path
    const relativePath = reqPath.slice(this.#prefix.length) || '/index.html'
    const ext = path.extname(relativePath).toLowerCase()
    if (!this.#extensions.has(ext)) return null

    const filePath = path.resolve(this.#root, relativePath.replace(/^\//, ''))

    // Two containment checks. The first uses `path.sep` to reject sibling
    // directories with a shared prefix (`/var/www-static-secret` slipping
    // past a guard for `/var/www-static`). The second resolves symlinks
    // via realpath so a symlink planted inside the root cannot point
    // outside it. We do realpath AFTER the lexical check so a non-existent
    // path returns `next()` rather than throwing.
    const rootWithSep = this.#root.endsWith(path.sep) ? this.#root : this.#root + path.sep
    if (filePath !== this.#root && !filePath.startsWith(rootWithSep)) {
      return null
    }

    let realFilePath: string
    let realRoot: string
    try {
      realFilePath = await fsp.realpath(filePath)
      realRoot = await fsp.realpath(this.#root)
    } catch {
      return null
    }
    const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep
    if (realFilePath !== realRoot && !realFilePath.startsWith(realRootWithSep)) {
      return null
    }

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
      return { handle, ext, stat }
    } catch {
      await handle.close().catch(() => {})
      return null
    }
  }
}
