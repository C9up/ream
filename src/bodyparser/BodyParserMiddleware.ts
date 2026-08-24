/**
 * BodyParser middleware — parses request bodies by content-type.
 *
 * Supports JSON, form-urlencoded, and raw text.
 * Multipart (file uploads) handled separately.
 * Configured via config/bodyparser.ts.
 */

import type { HttpContext } from '../http/HttpContext.js'
import { hydrateMultipartPayload } from './MultipartFile.js'
import { parseSize } from './parseSize.js'
import { parseQueryString, type QsParseOptions } from './qsParse.js'

export interface BodyParserConfig {
  json?: {
    limit?: string // e.g. '1mb'
    types?: string[]
  }
  form?: {
    limit?: string
    types?: string[]
    /**
     * Turn `''` into `null`. AdonisJS defaults this to `true`, so an empty
     * text input arrives as `null` rather than an empty string — which is what
     * a "nullable" validation rule expects to see.
     */
    convertEmptyStringsToNull?: boolean
    /** Trim surrounding whitespace. AdonisJS defaults this to `true`. */
    trimWhitespaces?: boolean
    /** Options for the bracket-notation parser (`depth`, `parameterLimit`). */
    queryString?: QsParseOptions
  }
  raw?: {
    limit?: string
    types?: string[]
  }
  multipart?: {
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
    limit: '1mb',
    types: ['application/json', 'application/vnd.api+json'],
  },
  form: {
    limit: '1mb',
    types: ['application/x-www-form-urlencoded'],
    // AdonisJS ships both as `true` (define_config: form.convertEmptyStringsToNull
    // / trimWhitespaces), so a migrated form behaves the same here.
    convertEmptyStringsToNull: true,
    trimWhitespaces: true,
    queryString: {},
  },
  raw: {
    // AdonisJS parses `text/*` out of the box (define_config: raw.types).
    limit: '1mb',
    types: ['text/*'],
  },
  multipart: {
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
    assertNoEnabledFlag(config)
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
    if (matchesType(contentType, this.#config.json.types)) {
      // `Request` lazy-parses JSON on first read; nothing to do here.
    }

    // Form URL-encoded
    if (matchesType(contentType, this.#config.form.types)) {
      ctx.request.setParsedBody(
        parseQueryString(rawBody, {
          ...this.#config.form.queryString,
          convertEmptyStringsToNull: this.#config.form.convertEmptyStringsToNull,
          trimWhitespaces: this.#config.form.trimWhitespaces,
        }),
      )
    }

    // Raw text — wrap the string under `_body` so consumers can still
    // reach it through `request.input('_body')`. This matches the fallback
    // shape used by `Request.#ensureParsedBody` when JSON yields a non-object.
    if (matchesType(contentType, this.#config.raw.types)) {
      ctx.request.setParsedBody({ _body: rawBody })
    }

    // Multipart — the Rust-side HyperServer parses the body server-side
    // (multer crate) and ships the structured payload on `request.multipart`.
    // JS just hydrates `MultipartFile` instances from the typed envelope.
    if (matchesType(contentType, this.#config.multipart.types)) {
      const payload = ctx.request.multipart()
      if (payload) {
        if (this.#rejectMultipart(ctx, payload.files, payload.fields)) return
        const { fields, files } = hydrateMultipartPayload(payload)
        // Fingerprint each file's real type from its magic bytes BEFORE handlers
        // run, so `request.file(field, { extnames })` validates against the
        // detected type (not the attacker-controlled filename/header).
        await Promise.all(files.map((file) => file.detectType()))
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

/**
 * Whether a request's content-type is claimed by one of `types`.
 *
 * AdonisJS configures wildcards (`raw.types` defaults to `text/*`), so a bare
 * substring test would never match `text/plain` against `text/*`. Parameters
 * are stripped first: `application/json; charset=utf-8` is a JSON body.
 */
function matchesType(contentType: string, types: string[]): boolean {
  const actual = (contentType.split(';')[0] ?? '').trim().toLowerCase()
  if (!actual) return false
  return types.some((candidate) => {
    const pattern = candidate.trim().toLowerCase()
    if (pattern === '*/*') return true
    if (pattern.endsWith('/*')) {
      return actual.startsWith(`${pattern.slice(0, -1)}`)
    }
    return actual === pattern
  })
}

/**
 * `enabled` was an atlas-era invention: AdonisJS has no such flag, and a parser
 * is turned off by giving it no `types`. It also never worked for JSON, which
 * `Request` lazy-parses on first read regardless.
 *
 * Silently ignoring a config key that used to mean something would re-enable a
 * parser an app deliberately switched off, so it fails loudly with the
 * replacement spelled out.
 */
function assertNoEnabledFlag(config?: BodyParserConfig): void {
  if (!config) return
  for (const section of ['json', 'form', 'raw', 'multipart'] as const) {
    const value: unknown = config[section]
    if (value !== null && typeof value === 'object' && 'enabled' in value) {
      throw new Error(
        `[E_BODYPARSER_CONFIG] \`${section}.enabled\` is no longer supported — AdonisJS has no such option. ` +
          `To disable this parser, give it no types: \`${section}: { types: [] }\`.`,
      )
    }
  }
}
