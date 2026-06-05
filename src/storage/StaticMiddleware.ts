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

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { HttpContext } from '../http/HttpContext.js'

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

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
}

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

    const resolved = this.#resolveServableFile(ctx.request.path())
    if (!resolved) return next()
    const { realFilePath, ext, stat } = resolved

    const etag = createHash('md5').update(`${stat.size}-${stat.mtimeMs}`).digest('hex')

    // ETag check — 304 Not Modified
    const ifNoneMatch = ctx.request.header('if-none-match')
    if (ifNoneMatch === etag) {
      ctx.response.status(304)
      return
    }

    const mime = MIME_TYPES[ext] ?? 'application/octet-stream'
    ctx.response.header('Content-Type', mime)
    ctx.response.header('Content-Length', String(stat.size))
    ctx.response.header('Cache-Control', `public, max-age=${this.#maxAge}`)
    ctx.response.header('ETag', etag)

    if (ctx.request.method() === 'HEAD') {
      ctx.response.status(200)
      return
    }

    // Send the raw Buffer — `content.toString()` would interpret PNG /
    // PDF / ZIP bytes as UTF-8 and replace any byte the encoding can't
    // round-trip (anything in the surrogate range, plus invalid
    // sequences) with U+FFFD.
    const content = fs.readFileSync(realFilePath)
    ctx.response.status(200).sendBuffer(content)
  }

  /**
   * Resolve a request path to a real, in-root, existing file, or `null` when it
   * is not servable (wrong prefix/extension, outside the root, missing, or a
   * symlink escaping the root). Returning `null` tells `handle` to call `next()`.
   */
  #resolveServableFile(
    reqPath: string,
  ): { realFilePath: string; ext: string; stat: fs.Stats } | null {
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
    // via realpathSync so a symlink planted inside the root cannot point
    // outside it. We do realpath AFTER the lexical check so a non-existent
    // path returns `next()` rather than throwing.
    const rootWithSep = this.#root.endsWith(path.sep) ? this.#root : this.#root + path.sep
    if (filePath !== this.#root && !filePath.startsWith(rootWithSep)) {
      return null
    }

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return null
    }

    let realFilePath: string
    let realRoot: string
    try {
      realFilePath = fs.realpathSync(filePath)
      realRoot = fs.realpathSync(this.#root)
    } catch {
      return null
    }
    const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep
    if (realFilePath !== realRoot && !realFilePath.startsWith(realRootWithSep)) {
      return null
    }

    return { realFilePath, ext, stat: fs.statSync(realFilePath) }
  }
}
