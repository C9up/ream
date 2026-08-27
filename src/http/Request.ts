/**
 * Request — wraps raw HTTP request data from the NAPI layer.
 *
 * Provides a fluent, AdonisJS-compatible API for reading request data.
 * JSON body parsing is lazy — deferred until first access via input()/all()/body().
 *
 * @implements FR21
 */

import { parseQueryString } from '../bodyparser/qsParse.js'
import type { CookieSigner } from '../security/CookieSigner.js'
import type { SignedUrl } from '../security/SignedUrl.js'
import type { Dict } from '../types/helpers.js'
import { Macroable } from '../utils/Macroable.js'
import { getPath, omitPaths, pickPaths } from '../utils/objectPath.js'
import { unpackCookieValue } from './Response.js'

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
   * Connection scheme as seen by the server (`http`/`https`), when the Rust
   * layer ships it. Defaults to `http` in `protocol()` when absent; the
   * `X-Forwarded-Proto` header only overrides it when trust-proxy is enabled.
   */
  scheme?: 'http' | 'https'
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

export class Request extends Macroable {
  #raw: RawRequest
  #params: Dict<string | string[]>
  #cookieSigner?: CookieSigner
  #signedUrl?: SignedUrl
  #allowMethodSpoofing = false
  #trustProxy = false
  #routeInfo?: { name?: string; pattern: string; reference?: string }
  #response?: { fresh(): boolean }
  #parsedBody: Dict<unknown> | undefined
  #parsedQs: Dict<unknown> | undefined
  #merged: Dict<unknown> | undefined
  #original: Dict<unknown> | undefined
  /** Set by {@link updateRawBody}; `raw()` reports it instead of the wire body. */
  #rawBodyOverride: string | undefined
  #files: Map<string, import('../bodyparser/MultipartFile.js').MultipartFile[]> = new Map()
  #validated: unknown

  /**
   * CSRF token for this request (AdonisJS idiom: `request.csrfToken`). Seeded
   * by the `@c9up/blackhole` middleware when CSRF is enabled; `undefined`
   * otherwise. Also published to `ctx.store` for templating helpers.
   */
  csrfToken?: string

  /**
   * `true` only when CSRF was enabled, the request method guarded, the route not
   * excepted, AND the token validated for this request — set by the
   * `@c9up/blackhole` middleware. Unlike {@link csrfToken} (seeded on every
   * passing request, even when verification was skipped), this is the trustworthy
   * "the request was CSRF-verified" signal a consumer reads to fail-close on
   * state-changing routes. `undefined` when the middleware never ran.
   */
  csrfProtected?: boolean

  constructor(raw: RawRequest, params: Dict<string | string[]> = {}) {
    super()
    this.#raw = raw
    this.#params = params
  }

  // ─── HTTP accessors ───────────────────────────────────────

  /**
   * The HTTP method, honouring `_method` form spoofing when enabled (AdonisJS
   * `method`). With spoofing enabled and a real POST, the `_method` field
   * (`PUT`/`PATCH`/`DELETE`) overrides — the classic HTML-form workaround.
   * Spoofing is OFF by default (opt in via {@link setMethodSpoofing}); routing
   * always uses {@link intended}.
   */
  method(): string {
    if (this.#allowMethodSpoofing && this.intended().toUpperCase() === 'POST') {
      const spoofed = this.input('_method', this.intended())
      if (typeof spoofed === 'string' && spoofed) return spoofed.toUpperCase()
    }
    return this.intended()
  }

  /** The real HTTP method, ignoring any `_method` spoofing (AdonisJS `intended`). */
  intended(): string {
    return this.#raw.method
  }

  /**
   * The context this request belongs to (AdonisJS `request.ctx`).
   *
   * Wired by HttpContext. Optional because a Request built by hand — a test,
   * a fixture — has no context around it.
   */
  ctx?: object

  /**
   * Seat the parsed body (AdonisJS `setInitialBody`).
   *
   * What a body parser calls once it has decoded the payload. An alias of
   * {@link setParsedBody}, which is the name ream used first — both are here so
   * a middleware written against either resolves.
   */
  setInitialBody(body: Dict<unknown>): void {
    this.setParsedBody(body)
  }

  /** @internal Give the request access to its response — wired by HttpContext (for `fresh()`). */
  setResponse(response: { fresh(): boolean }): void {
    this.#response = response
  }

  /** @internal Record the matched route — wired by HttpContext (for `matchesRoute()`). */
  setRouteInfo(info: { name?: string; pattern: string; reference?: string }): void {
    this.#routeInfo = info
  }

  /**
   * Whether the client's cached copy is still fresh (AdonisJS `fresh`) —
   * delegates to the response's `ETag`/`If-None-Match` revalidation check, so a
   * handler can answer `304 Not Modified`. False before the response is wired.
   */
  fresh(): boolean {
    return this.#response?.fresh() ?? false
  }

  /** The negation of {@link fresh} (AdonisJS `stale`). */
  stale(): boolean {
    return !this.fresh()
  }

  /**
   * True when the matched route's name, pattern, or controller reference is one
   * of `identifier` (AdonisJS `matchesRoute`).
   *
   * Takes a list as well as a single value, as upstream does — the usual call
   * is "am I on any of these routes", and a caller with several had to write
   * the `.some()` themselves.
   *
   * The reference is the `'ControllerName.method'` form the router already
   * accepts as a handler, which is the identity AdonisJS matches on through
   * `route.handler.reference`. Absent for an inline handler, which has no name
   * to be addressed by.
   */
  matchesRoute(identifier: string | string[]): boolean {
    const info = this.#routeInfo
    if (!info) return false
    const candidates = Array.isArray(identifier) ? identifier : [identifier]
    return candidates.some(
      (one) => info.name === one || info.pattern === one || info.reference === one,
    )
  }

  /**
   * Enable/disable `_method` form spoofing (AdonisJS gates this behind the
   * `allowMethodSpoofing` config; ream exposes it as an explicit opt-in, off by
   * default, so an attacker can never silently rewrite a POST into a DELETE).
   */
  setMethodSpoofing(enabled: boolean): void {
    this.#allowMethodSpoofing = enabled
  }

  /**
   * The request URL — the PATHNAME by default, as in AdonisJS
   * (`url(includeQueryString)`, false unless asked). Ream defaulted to
   * including the query string, so a value used as a cache key, a log line or
   * a route comparison silently carried the query with it.
   *
   * Pass `true` for path + query; {@link completeUrl} adds the origin.
   */
  url(includeQs = false): string {
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
   * Enable/disable trusting proxy headers (`X-Forwarded-Proto`/`-Host`/`-For`)
   * for `protocol()`/`host()`/`ips()`. OFF by default — turning it on when the
   * app is NOT behind a trusted proxy lets clients spoof their scheme/host/IP,
   * so it's an explicit opt-in (same stance as {@link setMethodSpoofing}).
   */
  setTrustProxy(enabled: boolean): void {
    this.#trustProxy = enabled
  }

  /**
   * The HTTP/2 `:authority` pseudo-header, falling back to `Host` (AdonisJS
   * `authority`).
   *
   * Deliberately does NOT consult `X-Forwarded-Host` and ignores trust-proxy,
   * as Adonis does: no proxy convention forwards the original `:authority`,
   * so honouring a forwarded header here would let a proxy rewrite the value
   * you validate a redirect target against. Use {@link host} when you do want
   * the proxy-aware value.
   */
  authority(): string | null {
    const pseudo = this.#raw.headers[':authority']
    if (pseudo) return pseudo
    return this.#raw.headers.host ?? null
  }

  /**
   * The request host including port (AdonisJS `host`). Honours
   * `X-Forwarded-Host` ONLY when trust-proxy is enabled; otherwise the `Host`
   * header. Returns null when neither is present.
   */
  host(): string | null {
    if (this.#trustProxy) {
      const forwarded = this.#raw.headers['x-forwarded-host']
      if (forwarded) return forwarded.split(',')[0].trim()
    }
    return this.#raw.headers.host ?? null
  }

  /**
   * The request protocol — `http` or `https` (AdonisJS `protocol`). Honours
   * `X-Forwarded-Proto` only under trust-proxy; otherwise the connection scheme
   * the Rust layer reported (defaulting to `http`).
   */
  protocol(): string {
    if (this.#trustProxy) {
      const forwarded = this.#raw.headers['x-forwarded-proto']
      if (forwarded) return forwarded.split(',')[0].trim().toLowerCase()
    }
    return this.#raw.scheme ?? 'http'
  }

  /** True when the request protocol is `https` (AdonisJS `secure`). */
  secure(): boolean {
    return this.protocol() === 'https'
  }

  /**
   * The client IP chain (AdonisJS `ips`). Under trust-proxy, the parsed
   * `X-Forwarded-For` list (left-most = original client); otherwise just the
   * single resolved {@link ip}.
   */
  ips(): string[] {
    if (this.#trustProxy) {
      const forwarded = this.#raw.headers['x-forwarded-for']
      if (forwarded) {
        return forwarded
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
      }
    }
    return [this.ip()]
  }

  /** The request hostname without port (AdonisJS `hostname`), or null. */
  hostname(): string | null {
    const host = this.host()
    if (host === null) return null
    // Strip the port. IPv6 literals are bracketed (`[::1]:3000`) — keep the brackets' contents.
    if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1) || host
    const colon = host.indexOf(':')
    return colon === -1 ? host : host.slice(0, colon)
  }

  /**
   * Subdomains of the hostname (AdonisJS `subdomains`). `offset` drops the
   * registrable domain (default 2 → `example.com`); a leading `www` is removed.
   * Empty for an IP host or a host with no subdomain.
   */
  subdomains(offset = 2): string[] {
    const hostname = this.hostname()
    if (hostname === null || isIpLiteral(hostname)) return []
    const parts = hostname.split('.').reverse().slice(offset)
    if (parts.length > 0 && parts[parts.length - 1] === 'www') parts.pop()
    return parts
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
   * Signed cookie value, verified with APP_KEY (AdonisJS default). Returns
   * `defaultValue` (or null) when absent OR when the signature is invalid
   * (tampered / not signed).
   *
   * NAMED DEVIATION — the fallback is `??`, where AdonisJS writes `||`. A
   * cookie legitimately holding `0`, `false` or `""` is a value, not an
   * absence, and upstream hands back the default for all three. Kept.
   */
  cookie(name: string): string | null
  cookie(name: string, defaultValue: string): string
  cookie(name: string, defaultValue?: string): string | null
  cookie(name: string, defaultValue?: string): string | null {
    const raw = this.plainCookie<string>(name, undefined, { encoded: false })
    const value = raw === null ? null : this.#cookieSigner ? this.#cookieSigner.unsign(raw) : raw
    return value ?? defaultValue ?? null
  }

  /**
   * An unsigned cookie (AdonisJS `plainCookie`), unpacked.
   *
   * `response.plainCookie()` writes a base64url JSON envelope, so this reads
   * the value BACK WITH ITS TYPE — an object stays an object, a number a
   * number. A cookie set by something else, or written with `encode: false`,
   * comes back as the raw string.
   *
   * Pass `encoded: false` to skip unpacking entirely.
   */
  plainCookie<T = string>(name: string): T | null
  plainCookie<T = string>(name: string, defaultValue: T, options?: { encoded?: boolean }): T
  plainCookie<T = string>(
    name: string,
    defaultValue: undefined,
    options?: { encoded?: boolean },
  ): T | null
  plainCookie<T = string>(name: string, defaultValue?: T, options?: { encoded?: boolean }): T | null
  plainCookie<T = string>(
    name: string,
    defaultValue?: T,
    options?: { encoded?: boolean },
  ): T | null {
    const cookies = this.#raw.cookies ?? this.cookies()
    const raw = cookies[name]
    if (raw === undefined) return defaultValue ?? null
    // Caller's claim about an untyped store, same contract as `input<T>`.
    if (options?.encoded === false) return raw as T
    return unpackCookieValue(raw) as T
  }

  /**
   * Encrypted cookie value, decrypted with APP_KEY (AdonisJS `encryptedCookie`).
   * Returns `defaultValue` (or null) when absent, undecryptable, or no
   * encryption service.
   */
  encryptedCookie(name: string): string | null
  encryptedCookie(name: string, defaultValue: string): string
  encryptedCookie(name: string, defaultValue?: string): string | null
  encryptedCookie(name: string, defaultValue?: string): string | null {
    const raw = this.plainCookie<string>(name, undefined, { encoded: false })
    const value = raw === null || !this.#cookieSigner ? null : this.#cookieSigner.decrypt(raw)
    return value ?? defaultValue ?? null
  }

  /** @internal Inject the APP_KEY-backed signed-URL helper — wired by HttpContext. */
  setSignedUrl(signedUrl: SignedUrl): void {
    this.#signedUrl = signedUrl
  }

  /**
   * Verify the request's signed-URL `signature` (AdonisJS `hasValidSignature`).
   * Delegates to the {@link SignedUrl} helper, which recomputes the HMAC over
   * the current path + query, rejects an expired `expires`, and checks the
   * `purpose`. Returns false without an APP_KEY-backed signer.
   */
  hasValidSignature(purpose?: string): boolean {
    if (!this.#signedUrl) return false
    // `url(true)`: the signature covers the path AND the query string —
    // the expiry and the signature itself live in the query.
    return this.#signedUrl.verify(this.url(true), purpose)
  }

  /** Get the raw body as a string (decoded from base64 if binary). */
  raw(): string {
    if (this.#rawBodyOverride !== undefined) return this.#rawBodyOverride
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

  /** Get a single request header (case-insensitive), or `defaultValue` when absent. */
  header(key: string): string | undefined
  header(key: string, defaultValue: string): string
  header(key: string, defaultValue?: string): string | undefined
  header(key: string, defaultValue?: string): string | undefined {
    return this.#raw.headers[key.toLowerCase()] ?? defaultValue
  }

  /** Get all request headers. */
  headers(): Readonly<Dict> {
    return this.#raw.headers
  }

  // ─── Route params ─────────────────────────────────────────

  /**
   * Get a single route parameter.
   *
   * The catch-all `*` is an ARRAY of segments (AdonisJS hands it that way), so
   * it is returned joined here — `param('*')` reading `undefined` because the
   * value was not a string would be worse than the path it describes.
   * Use {@link params} to get the segments themselves.
   */
  param(key: string): string | undefined
  param(key: string, defaultValue: string): string
  param(key: string, defaultValue?: string): string | undefined
  param(key: string, defaultValue?: string): string | undefined {
    const value = this.#params[key]
    if (value === undefined) return defaultValue
    return Array.isArray(value) ? value.join('/') : value
  }

  /** Get all route parameters; `*` holds its segments as an array. */
  params(): Readonly<Dict<string | string[]>> {
    return this.#params
  }

  // ─── Identity and shape ───────────────────────────────────

  /**
   * The request id from `x-request-id` (AdonisJS `id`).
   *
   * Absent when the proxy or client did not set one — it is not invented here,
   * because a correlation id nobody else knows correlates nothing.
   */
  id(): string | undefined {
    return this.header('x-request-id')
  }

  /** The URL split into path and raw query string (AdonisJS `parsedUrl`). */
  parsedUrl(): { pathname: string; search: string; query: string } {
    const query = this.#raw.query ?? ''
    return {
      pathname: this.#raw.path,
      search: query ? `?${query}` : '',
      query,
    }
  }

  /** `X-Requested-With: xmlhttprequest` (AdonisJS `ajax`). */
  ajax(): boolean {
    return (this.header('x-requested-with') ?? '').toLowerCase() === 'xmlhttprequest'
  }

  /** Whether the client sent `X-Pjax` (AdonisJS `pjax`). */
  pjax(): boolean {
    return this.header('x-pjax') !== undefined
  }

  /**
   * Whether this is a speculative prefetch or prerender rather than a real
   * navigation (AdonisJS `prefetch`).
   *
   * Worth checking before anything with a side effect: a browser may fetch a
   * link the user never clicks, and counting that as a visit — or worse, acting
   * on it — attributes an intention nobody had.
   */
  prefetch(): boolean {
    const purpose = (
      this.header('sec-purpose') ??
      this.header('purpose') ??
      this.header('x-purpose') ??
      this.header('x-moz') ??
      ''
    ).toLowerCase()
    return purpose.includes('prefetch') || purpose.includes('prerender')
  }

  /**
   * The full URL — `protocol://host/path` (AdonisJS `completeUrl`).
   *
   * Pass `true` to keep the query string.
   */
  completeUrl(includeQueryString = false): string {
    const path = includeQueryString ? this.url(true) : this.url(false)
    return `${this.protocol()}://${this.host()}${path}`
  }

  /**
   * Where the user came from, per the `Referer` header — but only when it
   * points somewhere we trust (AdonisJS `getPreviousUrl`).
   *
   * A referrer is attacker-controlled, so redirecting back to it unchecked is
   * an open redirect. The host must be this request's own or one of
   * `allowedHosts`; anything else falls back.
   */
  getPreviousUrl(allowedHosts: string[] = [], fallback = '/'): string {
    const referer = this.header('referer') ?? this.header('referrer')
    if (!referer) return fallback
    let parsed: URL
    try {
      parsed = new URL(referer)
    } catch {
      return fallback
    }
    const trusted = new Set([this.host(), ...allowedHosts])
    if (!trusted.has(parsed.host)) return fallback
    return `${parsed.pathname}${parsed.search}`
  }

  // ─── Content negotiation ──────────────────────────────────

  /** Every media type the client accepts, best first (AdonisJS `types`). */
  types(): string[] {
    return this.#negotiated('accept')
  }

  /** Every language the client accepts, best first (AdonisJS `languages`). */
  languages(): string[] {
    return this.#negotiated('accept-language')
  }

  /** Every charset the client accepts, best first (AdonisJS `charsets`). */
  charsets(): string[] {
    return this.#negotiated('accept-charset')
  }

  /**
   * The best of the offered charsets per `Accept-Charset` (AdonisJS
   * `charset`), or null when none matches. The plural {@link charsets} lists
   * everything the client will take.
   */
  charset<T extends string>(charsets: T[]): T | null {
    return this.#bestOf('accept-charset', charsets)
  }

  /** Every encoding the client accepts, best first (AdonisJS `encodings`). */
  encodings(): string[] {
    return this.#negotiated('accept-encoding')
  }

  /**
   * The best of the offered encodings per `Accept-Encoding` (AdonisJS
   * `encoding`), or null when none matches.
   */
  encoding<T extends string>(encodings: T[]): T | null {
    return this.#bestOf('accept-encoding', encodings)
  }

  /**
   * The best of the offered values for one `Accept-*` header (AdonisJS
   * `charset` / `encoding`).
   *
   * Client preference decides: the header's q-order is walked first, and the
   * order the server offered them only breaks a tie within one q-bucket —
   * the same rule {@link accepts} follows. An absent header means the client
   * expressed no preference, so the server's first offer wins.
   */
  #bestOf<T extends string>(header: string, offered: T[]): T | null {
    const raw = this.#raw.headers[header]
    if (!raw?.trim()) return offered[0] ?? null
    const entries = parseAcceptHeader(raw)
    if (entries.length === 0) return null
    for (const bucket of bucketByQ(entries)) {
      for (const value of offered) {
        for (const entry of bucket) {
          const candidate = entry.value.toLowerCase()
          if (candidate === '*' || candidate === value.toLowerCase()) return value
        }
      }
    }
    return null
  }

  /**
   * Parse one `Accept-*` header into the client's preference order.
   *
   * Sorted by q descending, ties broken by the order the client wrote them —
   * which is what "preference" means when two entries share a q.
   */
  #negotiated(header: string): string[] {
    const raw = this.#raw.headers[header]
    if (!raw) return []
    return parseAcceptHeader(raw)
      .sort((a, b) => b.q - a.q || a.index - b.index)
      .map((entry) => entry.value)
  }

  // ─── Serialization ────────────────────────────────────────

  /** Every cookie, parsed (AdonisJS `cookiesList`). */
  cookiesList(): Dict {
    return this.cookies()
  }

  /**
   * A JSON-safe view of the request (AdonisJS `serialize`), for logs and error
   * reports. Carries no body: it may hold credentials, and a log line is the
   * last place they should land.
   */
  serialize(): Record<string, unknown> {
    return {
      id: this.id(),
      url: this.url(true),
      method: this.method(),
      protocol: this.protocol(),
      host: this.host(),
      headers: this.headers(),
      qs: this.qs(),
      params: this.params(),
    }
  }

  /** Same as {@link serialize} — what `JSON.stringify(request)` uses. */
  toJSON(): Record<string, unknown> {
    return this.serialize()
  }

  // ─── Query string ─────────────────────────────────────────

  /** Get parsed query string as an object. */
  qs(): Dict<unknown> {
    if (!this.#parsedQs) {
      // The same parser the body parser uses. A local one lived here and split
      // on "&" only: `?filter[status]=open` stayed the literal key
      // "filter[status]", and `?tags[]=a&tags[]=b` silently kept only "b" —
      // both are ordinary shapes for a filter or an HTML multi-select.
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

  /**
   * Get a single input value from body or query string, by AdonisJS
   * dot-notation (`input('user.address.city')`). Returns `defaultValue` when
   * the path is absent (parity with `lodash.get`, reimplemented dependency-free).
   */
  input<T = unknown>(key: string, defaultValue?: T): T {
    // Untyped request data: the caller declares the shape it expects (same
    // contract as AdonisJS `request.input<T>`, whose return is loose `any`).
    return getPath(this.all(), key, defaultValue) as T
  }

  /** Get all input (query string merged with body). */
  all(): Dict<unknown> {
    if (!this.#merged) {
      this.#ensureParsedBody()
      // `{ ...body, ...qs }` — the QUERY STRING wins, as in AdonisJS
      // (`#requestData = { ...#requestBody, ...#requestQs }`). Ream had it the
      // other way round, so `?id=1` with a body `{ id: 2 }` read 2 here and 1
      // there — silently, on the request field an app trusts most.
      this.#merged = { ...this.#parsedBody, ...this.qs() }
      // Snapshot the first-seen input as the immutable "original" (flash old-input).
      if (this.#original === undefined) this.#original = { ...this.#merged }
    }
    return { ...this.#merged }
  }

  /**
   * The original request input, captured once and never mutated (AdonisJS
   * `request.original`) — the basis for flash "old input" on validation errors.
   */
  original(): Dict<unknown> {
    this.all() // ensure the snapshot is captured
    return { ...(this.#original ?? {}) }
  }

  /**
   * Cherry-pick specific keys from input, honouring dot-notation for nested
   * branches (`only(['user.id'])` → `{ user: { id } }`) — AdonisJS `only`
   * (`lodash.pick`). Absent paths are skipped.
   */
  only(keys: string[]): Dict<unknown> {
    return pickPaths(this.all(), keys)
  }

  /**
   * Get all input except specific keys, honouring dot-notation for nested
   * branches — AdonisJS `except` (`lodash.omit`). Never mutates the input.
   */
  except(keys: string[]): Dict<unknown> {
    return omitPaths(this.all(), keys)
  }

  /**
   * True when the request carries a body — a `content-length` above zero or a
   * `transfer-encoding` header (AdonisJS `request.hasBody`). Lets a handler
   * branch on "was anything sent" without parsing.
   */
  hasBody(): boolean {
    const transferEncoding = this.#raw.headers['transfer-encoding']
    if (transferEncoding && transferEncoding.length > 0) return true
    const contentLength = Number.parseInt(this.#raw.headers['content-length'] ?? '', 10)
    return Number.isFinite(contentLength) && contentLength > 0
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
  accepts<T extends string>(types: T[]): T | null {
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
  language<T extends string>(langs: T[]): T | null {
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
   * Replace the request body (AdonisJS `updateBody`) — what a middleware that
   * sanitizes or normalises input calls. {@link all} is recomputed from the
   * query string and the new body on the next read.
   *
   * {@link original} keeps the first-seen input: flash old-input must show
   * what the user actually sent, not what a middleware rewrote it into.
   */
  updateBody(body: Dict<unknown>): void {
    this.all() // snapshot the original before it is replaced
    this.setParsedBody(body)
  }

  /**
   * Replace the query string data (AdonisJS `updateQs`). {@link all} is
   * recomputed on the next read; the raw query string is left alone, so
   * `parsedUrl()` still reports what the client sent.
   */
  updateQs(data: Dict<unknown>): void {
    this.all()
    this.#parsedQs = { ...data }
    this.#merged = undefined
  }

  /**
   * Replace the raw body (AdonisJS `updateRawBody`) — what the bodyparser
   * sets when it cannot parse the body, or for multipart. Does NOT reparse:
   * the parsed body is whatever {@link updateBody} last set.
   */
  updateRawBody(rawBody: string): void {
    this.#rawBodyOverride = rawBody
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

/** True for an IPv4 dotted-quad or a (bracketed) IPv6 literal — hosts with no subdomains. */
function isIpLiteral(host: string): boolean {
  if (host.startsWith('[') || host.includes('::')) return true
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host)
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
