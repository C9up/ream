/**
 * BodyParser middleware — parses request bodies by content-type.
 *
 * Supports JSON, form-urlencoded, and raw text.
 * Multipart (file uploads) handled separately.
 * Configured via config/bodyparser.ts.
 */

import type { HttpContext } from '../http/HttpContext.js'
import { hydrateMultipartPayload } from './MultipartFile.js'

export interface BodyParserConfig {
  json?: {
    enabled?: boolean
    limit?: string // e.g. '1mb'
    types?: string[]
  }
  form?: {
    enabled?: boolean
    limit?: string
    types?: string[]
  }
  raw?: {
    enabled?: boolean
    limit?: string
    types?: string[]
  }
  multipart?: {
    enabled?: boolean
    /** Total multipart body size cap (sum of all file sizes). Default: '20mb'. */
    limit?: string
    /** Maximum number of files per request. Default: 20. */
    maxFiles?: number
    maxFields?: number
    tmpDir?: string
    types?: string[]
  }
}

interface ResolvedBodyParserConfig {
  json: Required<NonNullable<BodyParserConfig['json']>>
  form: Required<NonNullable<BodyParserConfig['form']>>
  raw: Required<NonNullable<BodyParserConfig['raw']>>
  multipart: Required<NonNullable<BodyParserConfig['multipart']>>
}

const DEFAULT_CONFIG: ResolvedBodyParserConfig = {
  json: {
    enabled: true,
    limit: '1mb',
    types: ['application/json', 'application/vnd.api+json'],
  },
  form: {
    enabled: true,
    limit: '1mb',
    types: ['application/x-www-form-urlencoded'],
  },
  raw: {
    enabled: false,
    limit: '1mb',
    types: ['text/plain'],
  },
  multipart: {
    enabled: true,
    limit: '20mb',
    maxFiles: 20,
    maxFields: 500,
    tmpDir: '/tmp',
    types: ['multipart/form-data'],
  },
}

export default class BodyParserMiddleware {
  #config: ResolvedBodyParserConfig

  constructor(config?: BodyParserConfig) {
    this.#config = {
      json: { ...DEFAULT_CONFIG.json, ...config?.json },
      form: { ...DEFAULT_CONFIG.form, ...config?.form },
      raw: { ...DEFAULT_CONFIG.raw, ...config?.raw },
      multipart: { ...DEFAULT_CONFIG.multipart, ...config?.multipart },
    }
  }

  async handle(ctx: HttpContext, next: () => Promise<void>) {
    const contentType = ctx.request.header('content-type') ?? ''
    const rawBody = ctx.request.raw()

    // Size check
    if (Buffer.byteLength(rawBody, 'utf8') > parseSize(this.#getLimit(contentType))) {
      ctx.response.status(413).json({
        error: { code: 'E_REQUEST_ENTITY_TOO_LARGE', message: 'Request body exceeds size limit' },
      })
      return
    }

    // JSON
    if (this.#config.json.enabled && matchesType(contentType, this.#config.json.types)) {
      // Request already lazy-parses JSON — nothing to do
    }

    // Form URL-encoded
    if (this.#config.form.enabled && matchesType(contentType, this.#config.form.types)) {
      ctx.request.setParsedBody(parseFormUrlEncoded(rawBody))
    }

    // Raw text — wrap the string under `_body` so consumers can still
    // reach it through `request.input('_body')`. This matches the fallback
    // shape used by `Request.#ensureParsedBody` when JSON yields a non-object.
    if (this.#config.raw.enabled && matchesType(contentType, this.#config.raw.types)) {
      ctx.request.setParsedBody({ _body: rawBody })
    }

    // Multipart — the Rust-side HyperServer parses the body server-side
    // (multer crate) and ships the structured payload on `request.multipart`.
    // JS just hydrates `MultipartFile` instances from the typed envelope.
    if (this.#config.multipart.enabled && matchesType(contentType, this.#config.multipart.types)) {
      const payload = ctx.request.multipart()
      if (payload) {
        if (this.#rejectMultipart(ctx, payload.files, payload.fields)) return
        const { fields, files } = hydrateMultipartPayload(payload)
        ctx.request.setParsedBody(fields)
        ctx.request.setFiles(files)
      }
    }

    await next()
  }

  #getLimit(contentType: string): string {
    if (matchesType(contentType, this.#config.json.types)) return this.#config.json.limit
    if (matchesType(contentType, this.#config.form.types)) return this.#config.form.limit
    if (matchesType(contentType, this.#config.multipart.types)) return this.#config.multipart.limit
    return this.#config.raw.limit
  }

  /** Returns true (and writes a 413/400) when the multipart payload exceeds configured limits. */
  #rejectMultipart(
    ctx: HttpContext,
    files: Array<{ size: number }>,
    fields: Array<unknown>,
  ): boolean {
    const cfg = this.#config.multipart
    const maxBytes = parseSize(cfg.limit)

    if (fields.length > cfg.maxFields) {
      ctx.response.status(400).json({
        error: {
          code: 'E_TOO_MANY_FIELDS',
          message: `Upload exceeds maxFields (${cfg.maxFields})`,
        },
      })
      return true
    }

    if (files.length > cfg.maxFiles) {
      ctx.response.status(400).json({
        error: { code: 'E_TOO_MANY_FILES', message: `Upload exceeds maxFiles (${cfg.maxFiles})` },
      })
      return true
    }

    const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
    if (totalBytes > maxBytes) {
      ctx.response.status(413).json({
        error: { code: 'E_REQUEST_ENTITY_TOO_LARGE', message: 'Upload exceeds size limit' },
      })
      return true
    }

    return false
  }
}

function matchesType(contentType: string, types: string[]): boolean {
  return types.some((t) => contentType.includes(t))
}

function parseSize(size: string): number {
  const match = size.match(/^(\d+)(kb|mb|gb)?$/i)
  if (!match) return 1024 * 1024 // default 1mb
  const num = parseInt(match[1], 10)
  switch (match[2]?.toLowerCase()) {
    case 'kb':
      return num * 1024
    case 'mb':
      return num * 1024 * 1024
    case 'gb':
      return num * 1024 * 1024 * 1024
    default:
      return num
  }
}

function parseFormUrlEncoded(body: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (!body) return result
  for (const pair of body.split('&')) {
    if (!pair) continue
    const eqIdx = pair.indexOf('=')
    if (eqIdx === -1) {
      result[decodeFormComponent(pair)] = ''
    } else {
      result[decodeFormComponent(pair.slice(0, eqIdx))] = decodeFormComponent(pair.slice(eqIdx + 1))
    }
  }
  return result
}

// `application/x-www-form-urlencoded` reserves `+` for space (RFC 1866 / WHATWG
// URL form spec), so the substitution must happen before percent-decoding —
// otherwise a literal `+` (encoded as `%2B`) would be turned into a space too.
//
// Malformed percent-encoding (e.g. a truncated `a=%E0%A4%A`) makes
// decodeURIComponent throw URIError; mirror Request.ts#safeDecode and fall back
// to the substituted-but-undecoded value so an invalid body is a parse miss,
// not a 500.
function decodeFormComponent(value: string): string {
  const spaced = value.replace(/\+/g, ' ')
  try {
    return decodeURIComponent(spaced)
  } catch {
    return spaced
  }
}
