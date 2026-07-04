/**
 * Request — wraps raw HTTP request data from the NAPI layer.
 *
 * Provides a fluent, AdonisJS-compatible API for reading request data.
 * JSON body parsing is lazy — deferred until first access via input()/all()/body().
 *
 * @implements FR21
 */

import type { CookieSigner } from '../security/CookieSigner.js'
import type { Dict } from '../types/helpers.js'

export interface RawRequest {
  method: string
  path: string
  query: string
  headers: Dict
  body: string
  bodyEncoding?: 'utf8' | 'base64'
  /** Socket-level peer address (filled by the HTTP server). */
  remoteAddr?: string
  /**
   * Resolved client IP — pre-computed by the Rust-side HyperServer using the
   * configured trusted-proxy CIDR list. JS reads this field directly; CIDR
   * matching no longer happens in TS. When absent (mock/test fixtures) the
   * `ip()` accessor falls back to legacy header parsing.
   */
  ip?: string
  /**
   * Pre-parsed `multipart/form-data` payload — the HyperServer parses bodies
   * server-side via `multer` and ships fields/files in this typed shape.
   * Files are base64-encoded so the payload stays JSON-safe.
   */
  multipart?: {
    fields: Array<{ name: string; value: string }>
    files: Array<{
      fieldName: string
      clientName: string
      contentType: string
      size: number
      contentB64: string
    }>
  }
  /**
   * Pre-parsed `Cookie:` header — name → value map computed by the Rust
   * cookie crate. JS reads via `request.cookie(name)`. When absent (test
   * fixtures), the accessor falls back to inline header parsing.
   */
  cookies?: Dict
}

export class Request {
  #raw: RawRequest
  #params: Dict
  #cookieSigner?: CookieSigner
  #parsedBody: Dict<unknown> | undefined
  #parsedQs: Dict<unknown> | undefined
  #merged: Dict<unknown> | undefined
  #files: Map<string, import('../bodyparser/MultipartFile.js').MultipartFile[]> = new Map()
  #validated: unknown

  /**
   * CSRF token for this request (AdonisJS idiom: `request.csrfToken`). Seeded
   * by the `@c9up/blackhole` middleware when CSRF is enabled; `undefined`
   * otherwise. Also published to `ctx.store` for templating helpers.
   */
  csrfToken?: string

  constructor(raw: RawRequest, params: Dict = {}) {
    this.#raw = raw
    this.#params = params
  }

  // ─── HTTP accessors ───────────────────────────────────────

  /** HTTP method (GET, POST, etc.). */
  method(): string {
    return this.#raw.method
  }

  /** Request URL (path + query string). */
  url(includeQs = true): string {
    if (includeQs && this.#raw.query) {
      return `${this.#raw.path}?${this.#raw.query}`
    }
    return this.#raw.path
  }

  /** Request path (without query string). */
  path(): string {
    return this.#raw.path
  }

  /**
   * Resolved client IP. The HyperServer computes this once per request from
   * the socket peer + `X-Forwarded-For` / `X-Real-IP` headers, gated by the
   * configured trusted-proxy CIDR list, and ships the resolved value on
   * `request.ip`. JS reads that field as-is.
   *
   * When `#raw.ip` is missing — only happens in test fixtures that
   * hand-build `RawRequest` without going through the Rust pipeline — fall
   * back to the socket peer (`remoteAddr`). Do NOT consult `X-Forwarded-For`
   * or `X-Real-IP` here: those headers are attacker-controlled on direct
   * requests and the trusted-proxy gate lives in Rust. Honouring them in
   * the TS fallback would let test fixtures masking real spoofing
   * regressions (two semantics for the same API). Fixtures that need to
   * simulate a proxy-resolved IP must set `#raw.ip` directly to the
   * desired resolved value.
   */
  ip(): string {
    if (this.#raw.ip) return this.#raw.ip
    return this.#raw.remoteAddr ?? '127.0.0.1'
  }

  /**
   * Return all cookies sent on this request as a name → value map. The
   * HyperServer parses the `Cookie:` header once via the `cookie` crate
   * (RFC 6265) and ships the result on `RawRequest.cookies`. Test fixtures
   * that don't pre-fill the field fall back to inline parsing of the raw
   * header — same tolerant `;`-split with quoted-value passthrough.
   */
  cookies(): Dict {
    if (this.#raw.cookies) return { ...this.#raw.cookies }
    const header = this.#raw.headers.cookie
    if (!header) return {}
    const result: Dict = {}
    for (const pair of header.split(';')) {
      const trimmed = pair.trim()
      if (!trimmed) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) continue
      const k = trimmed.slice(0, eqIdx).trim()
      const v = trimmed.slice(eqIdx + 1)
      // Empty value (`name=`) is valid per RFC 6265 — used in session/logout
      // flows that explicitly clear cookies. Only the key being empty is
      // grounds to skip. Aligns the fallback with the pre-parsed path
      // (HyperServer's cookie crate also accepts empty values).
      if (k) result[k] = v
    }
    return result
  }

  /** Inject the APP_KEY-backed cookie signer — wired by HttpContext. */
  setCookieSigner(signer: CookieSigner): void {
    this.#cookieSigner = signer
  }

  /**
   * Signed cookie value, verified with APP_KEY (AdonisJS default). Returns null
   * when absent OR when the signature is invalid (tampered / not signed).
   */
  cookie(name: string): string | null {
    const raw = this.plainCookie(name)
    if (raw === null) return null
    return this.#cookieSigner ? this.#cookieSigner.unsign(raw) : raw
  }

  /** Raw (unsigned) cookie value (AdonisJS `plainCookie`), or null when absent. */
  plainCookie(name: string): string | null {
    const cookies = this.#raw.cookies ?? this.cookies()
    return cookies[name] ?? null
  }

  /**
   * Encrypted cookie value, decrypted with APP_KEY (AdonisJS `encryptedCookie`).
   * Returns null when absent, undecryptable, or no encryption service.
   */
  encryptedCookie(name: string): string | null {
    const raw = this.plainCookie(name)
    if (raw === null || !this.#cookieSigner) return null
    return this.#cookieSigner.decrypt(raw)
  }

  /** Get the raw body as a string (decoded from base64 if binary). */
  raw(): string {
    if (this.#raw.bodyEncoding === 'base64') {
      return Buffer.from(this.#raw.body, 'base64').toString('utf8')
    }
    return this.#raw.body
  }

  /** Get the raw body as a Buffer (preserves binary integrity for file uploads). */
  rawBuffer(): Buffer {
    if (this.#raw.bodyEncoding === 'base64') {
      return Buffer.from(this.#raw.body, 'base64')
    }
    return Buffer.from(this.#raw.body, 'utf8')
  }

  // ─── Headers ──────────────────────────────────────────────

  /** Get a single request header (case-insensitive). */
  header(key: string): string | undefined {
    return this.#raw.headers[key.toLowerCase()]
  }

  /** Get all request headers. */
  headers(): Readonly<Dict> {
    return this.#raw.headers
  }

  // ─── Route params ─────────────────────────────────────────

  /** Get a single route parameter. */
  param(key: string, defaultValue?: string): string | undefined {
    return this.#params[key] ?? defaultValue
  }

  /** Get all route parameters. */
  params(): Readonly<Dict> {
    return this.#params
  }

  // ─── Query string ─────────────────────────────────────────

  /** Get parsed query string as an object. */
  qs(): Dict<unknown> {
    if (!this.#parsedQs) {
      this.#parsedQs = parseQueryString(this.#raw.query)
    }
    return { ...this.#parsedQs }
  }

  // ─── Body ─────────────────────────────────────────────────

  /** Get the parsed request body. */
  body(): unknown {
    this.#ensureParsedBody()
    return this.#parsedBody
  }

  // ─── Merged input (body + qs) ─────────────────────────────

  /** Get a single input value from body or query string. */
  input<T = unknown>(key: string, defaultValue?: T): T {
    const merged = this.all()
    if (key in merged) {
      // biome-ignore lint/suspicious/noExplicitAny: generic accessor — caller brands the value type via T
      return merged[key] as any as T
    }
    // biome-ignore lint/suspicious/noExplicitAny: generic default — caller brands the value type via T
    return defaultValue as any as T
  }

  /** Get all input (query string merged with body). */
  all(): Dict<unknown> {
    if (!this.#merged) {
      this.#ensureParsedBody()
      this.#merged = { ...this.qs(), ...this.#parsedBody }
    }
    return { ...this.#merged }
  }

  /** Cherry-pick specific keys from input. */
  only<K extends string>(keys: K[]): Partial<Record<K, unknown>> {
    const merged = this.all()
    const result: Partial<Record<K, unknown>> = {}
    for (const key of keys) {
      if (key in merged) {
        result[key] = merged[key]
      }
    }
    return result
  }

  /** Get all input except specific keys. */
  except(keys: string[]): Dict<unknown> {
    const merged = this.all()
    const keySet = new Set(keys)
    const result: Dict<unknown> = {}
    for (const [k, v] of Object.entries(merged)) {
      if (!keySet.has(k)) result[k] = v
    }
    return result
  }

  // ─── Content negotiation ──────────────────────────────────

  /** Check if the request content-type matches any of the given types. */
  is(types: string[]): string | null {
    const ct = this.#raw.headers['content-type'] ?? ''
    for (const type of types) {
      if (type === 'json' && ct.includes('application/json')) return 'json'
      if (type === 'html' && ct.includes('text/html')) return 'html'
      if (type === 'xml' && ct.includes('xml')) return 'xml'
      if (type === 'multipart' && ct.includes('multipart/form-data')) return 'multipart'
      if (ct.includes(type)) return type
    }
    return null
  }

  /**
   * Content negotiation — which of the offered types does the client accept,
   * honouring RFC 7231 §5.3.2 quality values?
   *
   * Walks the parsed Accept header in descending q-order and returns the
   * first server-offered type that matches. The server's preference order
   * (`types` argument) is the tiebreaker only when multiple client entries
   * share the same q. A bare `accepts(types)` therefore respects the
   * client's stated priorities (`application/json;q=0.9, text/html;q=0.1`
   * beats a server passing `['html', 'json']`).
   *
   * Aliases (`'json'` ↔ `application/json`, `'html'` ↔ `text/html`,
   * `'xml'` ↔ any subtype containing `xml`) are honoured.
   */
  accepts(types: string[]): string | null {
    const header = this.#raw.headers.accept ?? '*/*'
    const entries = parseAcceptHeader(header)
    if (entries.length === 0) return null
    // Group by q so the highest q always wins; within one q-bucket, server
    // offer order is the tiebreaker (devs control that order intentionally).
    const buckets = bucketByQ(entries)
    for (const bucket of buckets) {
      for (const type of types) {
        for (const entry of bucket) {
          if (acceptMatches(entry.value, type)) return type
        }
      }
    }
    return null
  }

  /**
   * Language negotiation from Accept-Language honouring RFC 4647 / 7231
   * quality values. Returns the first offered language whose tag (or its
   * primary subtag) matches the highest-q client entry, falling back to
   * `langs[0]` when nothing matches and the client header is empty/absent.
   */
  language(langs: string[]): string | null {
    const header = this.#raw.headers['accept-language'] ?? ''
    if (!header.trim()) return langs[0] ?? null
    const entries = parseAcceptHeader(header)
    if (entries.length === 0) return null
    const buckets = bucketByQ(entries)
    for (const bucket of buckets) {
      for (const lang of langs) {
        for (const entry of bucket) {
          if (languageMatches(entry.value, lang)) return lang
        }
      }
    }
    return null
  }

  // ─── Internals ────────────────────────────────────────────

  // ─── Files ─────────────────────────────────────────────────

  /** Get an uploaded file by field name. */
  file(
    fieldName: string,
    options?: import('../bodyparser/MultipartFile.js').FileValidationOptions,
  ): import('../bodyparser/MultipartFile.js').MultipartFile | null {
    const files = this.#files.get(fieldName)
    if (!files || files.length === 0) return null
    const file = files[0]
    if (options) file.validate(options)
    return file
  }

  /** Get all uploaded files for a field name. */
  files(
    fieldName: string,
    options?: import('../bodyparser/MultipartFile.js').FileValidationOptions,
  ): import('../bodyparser/MultipartFile.js').MultipartFile[] {
    const files = this.#files.get(fieldName) ?? []
    if (options) {
      for (const f of files) f.validate(options)
    }
    return files
  }

  /** Get all uploaded files. */
  allFiles(): Map<string, import('../bodyparser/MultipartFile.js').MultipartFile[]> {
    return this.#files
  }

  /**
   * Pre-parsed `multipart/form-data` payload as the HyperServer wrote it.
   * Returns `undefined` when the request wasn't multipart (or the test
   * fixture didn't fill the field). BodyParser hydrates `MultipartFile`
   * instances from this — application code should keep using
   * `request.file()` / `request.files()`.
   */
  multipart(): NonNullable<RawRequest['multipart']> | undefined {
    return this.#raw.multipart
  }

  /** @internal Set files (called by BodyParser middleware). */
  setFiles(files: import('../bodyparser/MultipartFile.js').MultipartFile[]): void {
    this.#files.clear()
    for (const file of files) {
      const existing = this.#files.get(file.fieldName) ?? []
      existing.push(file)
      this.#files.set(file.fieldName, existing)
    }
  }

  // ─── Internals ────────────────────────────────────────────

  /** @internal Set the parsed body (called by BodyParser middleware). */
  setParsedBody(body: Dict<unknown>): void {
    this.#parsedBody = body
    this.#merged = undefined // reset merged cache
  }

  /**
   * @internal Store the validated + transformed payload (called by the
   * validation middleware after a route validator passes).
   */
  setValidated(data: unknown): void {
    this.#validated = data
  }

  /**
   * The validated + coerced payload produced by the route's `.validate()`
   * validator, or `undefined` when the route declares no validator. Prefer
   * this over `body()` in a validated handler — it carries the sanitized,
   * type-coerced values, not the raw input. Returns `unknown`; narrow it at
   * the call site (the validator already guaranteed the shape).
   */
  validated(): unknown {
    return this.#validated
  }

  #ensureParsedBody(): void {
    if (this.#parsedBody !== undefined) return
    const raw = this.#raw.body
    if (!raw || raw.length === 0) {
      this.#parsedBody = {}
      return
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      this.#parsedBody = isPlainObject(parsed) ? parsed : { _body: parsed }
    } catch {
      this.#parsedBody = {}
    }
  }
}

/** Parse a query string (key=value&key2=value2) into an object. */
/**
 * Test whether an IPv4 address is within a CIDR range. Bare IP entries
 * (`10.0.0.42`) are accepted as `/32`. IPv6 falls back to string equality
 * — a full v6 implementation isn't required by the current security tests.
 */
/**
 * Type guard for plain JSON-decoded objects. Excludes `null` (which is
 * `typeof === 'object'`) and arrays so consumers can index by string key
 * without a separate runtime check.
 */
function isPlainObject(value: unknown): value is Dict<unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Decode a percent-encoded segment without throwing on malformed input.
 * Browsers happily send `q=%E0%A4%A` (truncated UTF-8 sequences) — refusing
 * the whole request would let any client knock the route handler offline.
 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseQueryString(qs: string): Dict<unknown> {
  if (!qs) return {}
  const result: Dict<unknown> = {}
  for (const pair of qs.split('&')) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx === -1) {
      result[safeDecode(pair)] = ''
    } else {
      const key = safeDecode(pair.slice(0, eqIdx))
      const value = safeDecode(pair.slice(eqIdx + 1))
      result[key] = value
    }
  }
  return result
}

interface AcceptEntry {
  value: string
  q: number
  index: number
}

/**
 * Parse an Accept-style header (Accept, Accept-Language, Accept-Encoding…)
 * into entries sorted by descending q-value, with the client's original
 * order as a stable tiebreaker. Entries with `q=0` are dropped (RFC 7231:
 * "the value 0 means not acceptable"). A bare wildcard entry is preserved.
 */
function parseAcceptHeader(header: string): AcceptEntry[] {
  const entries: AcceptEntry[] = []
  let index = 0
  for (const raw of header.split(',')) {
    const part = raw.trim()
    if (!part) continue
    const [valueRaw, ...params] = part.split(';')
    const value = (valueRaw ?? '').trim().toLowerCase()
    if (!value) continue
    let q = 1
    for (const param of params) {
      const [k, v] = param.split('=')
      if ((k ?? '').trim().toLowerCase() === 'q') {
        const parsed = Number.parseFloat((v ?? '').trim())
        if (Number.isFinite(parsed)) q = parsed
      }
    }
    if (q <= 0) continue
    entries.push({ value, q, index })
    index += 1
  }
  entries.sort((a, b) => b.q - a.q || a.index - b.index)
  return entries
}

/**
 * Match an Accept entry value (already lowercased) against an offered
 * type. Honours short aliases (`json` ↔ `application/json`, `html` ↔
 * `text/html`, `xml` ↔ any subtype containing `xml`) and the full
 * wildcard (matches anything). A `type/<wildcard>` entry matches any
 * subtype with the same primary type.
 */
function acceptMatches(entry: string, offered: string): boolean {
  if (entry === '*/*' || entry === '*') return true
  const o = offered.trim().toLowerCase()
  if (entry === o) return true
  // Expand short aliases to their canonical media-type so the wildcard
  // and exact-match checks below see the full type.
  const expanded = expandAlias(o)
  if (expanded && entry === expanded) return true
  if (o === 'xml' && entry.includes('xml')) return true
  // type/<wildcard> entry (e.g. `text/*` matches `text/html`).
  if (entry.endsWith('/*')) {
    const prefix = entry.slice(0, -1) // keep trailing slash
    if (expanded?.startsWith(prefix)) return true
    return o.startsWith(prefix)
  }
  return false
}

function expandAlias(short: string): string | null {
  if (short === 'json') return 'application/json'
  if (short === 'html') return 'text/html'
  if (short === 'text') return 'text/plain'
  if (short === 'form') return 'application/x-www-form-urlencoded'
  if (short === 'multipart') return 'multipart/form-data'
  return null
}

function bucketByQ<T extends { q: number }>(entries: T[]): T[][] {
  const buckets: T[][] = []
  let current: T[] = []
  let lastQ = Number.POSITIVE_INFINITY
  for (const entry of entries) {
    if (entry.q !== lastQ) {
      if (current.length > 0) buckets.push(current)
      current = []
      lastQ = entry.q
    }
    current.push(entry)
  }
  if (current.length > 0) buckets.push(current)
  return buckets
}

/**
 * Language tag match. Returns true when the Accept-Language entry equals
 * the offered tag (case-insensitive), or when the entry's primary subtag
 * matches the offered tag (RFC 4647 basic filtering: `en` matches `en-US`
 * but not vice versa). Wildcard `*` matches anything.
 */
function languageMatches(entry: string, offered: string): boolean {
  if (entry === '*') return true
  const o = offered.trim().toLowerCase()
  if (entry === o) return true
  if (entry.startsWith(`${o}-`)) return true
  const primary = entry.split('-')[0]
  if (primary && primary === o.split('-')[0]) return true
  return false
}
