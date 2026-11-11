/**
 * The limits the native server applies at the socket, read from the
 * application's configuration.
 *
 * - Body limits come from `config/bodyparser.ts`: the native server enforces
 *   each section's `limit` WHILE reading the body, so nothing past it is ever
 *   buffered. The request still reaches routing, without its body and marked
 *   `bodyTooLarge`; reading the body then throws the 413 the body parser
 *   raises. The body parser keeps its own check; the two read one config.
 * - Timeouts and the connection cap come from `config/app.ts` → `http`, where
 *   an AdonisJS app sets `headersTimeout`, `requestTimeout` and
 *   `keepAliveTimeout` for Node's server. `maxConnections` has no AdonisJS
 *   option (Node's `server.maxConnections` is left unbounded there); it is a
 *   deliberate DoS bound, and past it new clients wait in the listen backlog.
 *
 * Why the body limits are applied natively at all (NAPI constraint): the
 * native server hands JS a request whose body is already read, where AdonisJS
 * leaves the body in Node's stream until the parser pulls it. Without a limit
 * at the read, every body is buffered before any JS-side limit can apply.
 */

import type { BodyParserConfig } from '../bodyparser/BodyParserMiddleware.js'
import { parseSize } from '../bodyparser/parseSize.js'
import { ReamError } from '../errors/ReamError.js'

/** One body-parser section as the native server takes it (bytes). */
export interface NativeBodyLimit {
  limit?: number
  types?: string[]
}

/**
 * The multipart section, with the part counts the native parser enforces
 * while it parses: it stops at the first field or file past its bound.
 */
export interface NativeMultipartLimit extends NativeBodyLimit {
  maxFields?: number
  maxFiles?: number
}

/** Body limits per body-parser section; an omitted section keeps its default. */
export interface NativeBodyLimits {
  json?: NativeBodyLimit
  form?: NativeBodyLimit
  raw?: NativeBodyLimit
  multipart?: NativeMultipartLimit
}

/** Timeouts in milliseconds (`0` disables one) and the connection cap (`0` = unbounded). */
export interface NativeConnectionConfig {
  headersTimeout?: number
  requestTimeout?: number
  keepAliveTimeout?: number
  maxConnections?: number
}

const SECTIONS = ['json', 'form', 'raw', 'multipart'] as const

/** Translate `config/bodyparser.ts` into the native server's body limits. */
export function nativeBodyLimits(config: BodyParserConfig): NativeBodyLimits {
  const limits: NativeBodyLimits = {}
  for (const section of SECTIONS) {
    const given = config[section]
    if (!given) continue
    const native: NativeBodyLimit = {}
    if (given.limit !== undefined) native.limit = parseSize(given.limit)
    if (given.types !== undefined) native.types = [...given.types]
    limits[section] = native
  }
  const multipart = config.multipart
  if (multipart) {
    limits.multipart = {
      ...limits.multipart,
      ...(multipart.maxFields !== undefined && { maxFields: multipart.maxFields }),
      ...(multipart.maxFiles !== undefined && { maxFiles: multipart.maxFiles }),
    }
  }
  return limits
}

const CONNECTION_KEYS = [
  'headersTimeout',
  'requestTimeout',
  'keepAliveTimeout',
  'maxConnections',
] as const

const MAX_U32 = 2 ** 32 - 1

/**
 * Pick the connection settings out of the `http` block of `config/app.ts`.
 * Throws on a value that is not a whole number of milliseconds (or
 * connections) the native server can hold, rather than letting it wrap.
 */
export function nativeConnectionConfig(http: unknown): NativeConnectionConfig {
  const config: NativeConnectionConfig = {}
  if (typeof http !== 'object' || http === null) return config
  for (const key of CONNECTION_KEYS) {
    const value: unknown = Reflect.get(http, key)
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_U32) {
      throw new ReamError(
        'E_IGNITOR_INVALID_HTTP_CONFIG',
        `\`http.${key}\` must be a whole number between 0 and ${MAX_U32}, received ${String(value)}.`,
        { hint: 'Timeouts are in milliseconds; 0 disables the bound.' },
      )
    }
    config[key] = value
  }
  return config
}
