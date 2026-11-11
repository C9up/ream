/**
 * BodyParser middleware — parses request bodies by content-type.
 *
 * Supports JSON, form-urlencoded, and raw text.
 * Multipart (file uploads) handled separately.
 * Configured via config/bodyparser.ts.
 */

import { readModuleConfig } from '../config/moduleConfig.js'
import { Exception } from '../http/Exception.js'
import type { HttpContext } from '../http/HttpContext.js'
import { hydrateMultipartPayload } from './MultipartFile.js'
import { parseSize } from './parseSize.js'
import { parseQueryString, type QsParseOptions } from './qsParse.js'

export interface BodyParserConfig {
  /**
   * HTTP methods whose body is parsed at all. AdonisJS defaults to
   * `['POST', 'PUT', 'PATCH', 'DELETE']` and returns early for anything else,
   * so a GET that happens to carry a JSON content-type is left untouched.
   */
  allowedMethods?: string[]
  json?: {
    limit?: string | number // e.g. '1mb', '1.5 mb' or a number of bytes
    types?: string[]
  }
  form?: {
    limit?: string | number
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
    limit?: string | number
    types?: string[]
  }
  multipart?: {
    /** Total multipart body size cap (sum of all file sizes). Default: '20mb'. */
    limit?: string | number
    /**
     * Maximum number of files per request. AdonisJS has no such option — it
     * bounds a multipart body by total size and field count only, so ten
     * thousand one-byte files pass. Kept as a DoS bound, at the same scale as
     * `maxFields` so it never rejects an upload AdonisJS would have accepted.
     */
    maxFiles?: number
    /** Maximum number of form fields. AdonisJS default: 1000. */
    maxFields?: number
    types?: string[]
  }
}

interface ResolvedBodyParserConfig {
  allowedMethods: string[]
  json: Required<NonNullable<BodyParserConfig['json']>>
  form: Required<NonNullable<BodyParserConfig['form']>>
  raw: Required<NonNullable<BodyParserConfig['raw']>>
  multipart: Required<NonNullable<BodyParserConfig['multipart']>>
}

const DEFAULT_CONFIG: ResolvedBodyParserConfig = {
  // AdonisJS define_config: allowedMethods. A body is parsed only for methods
  // that are supposed to carry one.
  allowedMethods: ['POST', 'PUT', 'PATCH', 'DELETE'],
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
    maxFiles: 1000,
    maxFields: 1000,
    types: ['multipart/form-data'],
  },
}

export default class BodyParserMiddleware {
  #config: ResolvedBodyParserConfig
  /** Each section's limit in bytes, read once so a bad size fails at boot. */
  readonly #limits: { json: number; form: number; raw: number; multipart: number }

  constructor(explicitConfig: BodyParserConfig | undefined = undefined) {
    // The default value is load-bearing: an OPTIONAL parameter still counts
    // toward `Function.length`, and the container refuses to auto-construct a
    // class that declares parameters it has no metadata for. A parameter with a
    // default counts for nothing, which is what lets
    // `router.use([() => import('…')])` build this middleware.
    // Nothing is passed when the container builds this middleware from
    // `router.use([() => import('@c9up/ream/bodyparser_middleware')])`, so the
    // settings come from `config/bodyparser.ts` — the file this class's own
    // documentation has always named.
    const config = explicitConfig ?? readModuleConfig<BodyParserConfig>('bodyparser')
    assertNoEnabledFlag(config)
    this.#config = {
      allowedMethods: config?.allowedMethods ?? DEFAULT_CONFIG.allowedMethods,
      json: { ...DEFAULT_CONFIG.json, ...config?.json },
      form: { ...DEFAULT_CONFIG.form, ...config?.form },
      raw: { ...DEFAULT_CONFIG.raw, ...config?.raw },
      multipart: { ...DEFAULT_CONFIG.multipart, ...config?.multipart },
    }
    this.#limits = {
      json: parseSize(this.#config.json.limit),
      form: parseSize(this.#config.form.limit),
      raw: parseSize(this.#config.raw.limit),
      multipart: parseSize(this.#config.multipart.limit),
    }
  }

  async handle(ctx: HttpContext, next: () => Promise<void>) {
    // Only methods that are supposed to carry a body get one parsed
    // (AdonisJS `allowedMethods`). Comparison is case-sensitive on the
    // canonical upper-case verb, as AdonisJS' `includes()` is.
    if (!this.#config.allowedMethods.includes(ctx.request.method())) {
      return next()
    }

    // Many clients send `content-length: 0` on a bodyless request, which the
    // parsers below do not recognise as empty (AdonisJS returns early here for
    // the same reason).
    if (!ctx.request.hasBody()) {
      return next()
    }

    const contentType = ctx.request.header('content-type') ?? ''
    // A body over its native limit (`bodyTooLarge`) was never kept: `raw()`
    // throws the same 413 below instead of handing back an empty string. The
    // route is already matched here, so an unknown URL answered 404 first.
    const rawBody = ctx.request.raw()

    // Size check. Thrown rather than written: the app's exception handler
    // negotiates the response, so an HTML app gets an error page instead of a
    // JSON envelope it never asked for — and can override the rendering.
    if (Buffer.byteLength(rawBody, 'utf8') > this.#getLimit(contentType)) {
      throw entityTooLarge('request entity too large')
    }

    // JSON — parsed here and only here, under one of `json.types`. A body
    // with any other media type (or none) is never read as JSON.
    if (matchesType(contentType, this.#config.json.types)) {
      ctx.request.setParsedBody(parseJsonBody(rawBody))
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
        this.#assertMultipartWithinLimits(payload.files, payload.fields)
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

  #getLimit(contentType: string): number {
    if (matchesType(contentType, this.#config.json.types)) return this.#limits.json
    if (matchesType(contentType, this.#config.form.types)) return this.#limits.form
    if (matchesType(contentType, this.#config.multipart.types)) return this.#limits.multipart
    return this.#limits.raw
  }

  /**
   * Throws when the multipart payload exceeds a configured limit.
   *
   * All three raise the same 413 `E_REQUEST_ENTITY_TOO_LARGE` AdonisJS raises
   * for `maxFields` and for an oversized body — one code for "you sent too
   * much", whichever dimension it was.
   */
  #assertMultipartWithinLimits(files: Array<{ size: number }>, fields: Array<unknown>): void {
    const cfg = this.#config.multipart

    if (fields.length > cfg.maxFields) {
      throw entityTooLarge('Fields length limit exceeded')
    }

    if (files.length > cfg.maxFiles) {
      throw entityTooLarge('Files length limit exceeded')
    }

    const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
    if (totalBytes > this.#limits.multipart) {
      throw entityTooLarge('request entity too large')
    }
  }
}

/**
 * A JSON body as the request body: an object as is, any other JSON value under
 * `_body` (the shape the raw-text parser uses), and `{}` for malformed JSON.
 */
function parseJsonBody(raw: string): Record<string, unknown> {
  if (raw.length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return { ...parsed }
  }
  return { _body: parsed }
}

/** The one exception every body-size limit raises (AdonisJS parity). */
function entityTooLarge(message: string): Exception {
  return new Exception(message, { status: 413, code: 'E_REQUEST_ENTITY_TOO_LARGE' })
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
 * is turned off by giving it no `types`.
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

  // `multipart.tmpDir` was accepted and never read by anything: the Rust
  // multipart parser hands the body over in memory, so no file is ever written
  // to a temporary directory — an app pointing it at a volume was silently
  // getting nothing. Saying so beats letting it keep believing.
  const multipart: unknown = config.multipart
  if (multipart !== null && typeof multipart === 'object' && 'tmpDir' in multipart) {
    throw new Error(
      '[E_BODYPARSER_CONFIG] `multipart.tmpDir` is not supported — uploaded files are held in ' +
        'memory and never written to a temporary directory. Choose the destination when you ' +
        'store the file: `await file.move(directory)`.',
    )
  }
}
