// GENERATED FROM THE RUST — do not edit.
//
// Produced by scripts/generate-napi-types.mjs from napi-derive's type-def
// output. Editing this file by hand puts it back where it started: a
// description that can disagree with the code it describes.

/**
 * Typed response object crossing the TS→NAPI→Rust boundary.
 *
 * Using `#[napi(object)]` (instead of `String` carrying JSON) means napi-rs
 * walks the JS object tree directly into Rust fields — zero JSON parse overhead.
 *
 * When `stream_id` is set, `body` is ignored and the hyper response is fed
 * from the matching entry in the shared `StreamRegistry`. The handler must
 * have called [`HyperServer::register_stream`] with that id BEFORE
 * returning, otherwise the response collapses to a 500 (E_STREAM_UNKNOWN).
 */

export interface NapiResponse {
  status: number
  headers: Record<string, string>
  body: string
  streamId?: string
}

/**
 * Configuration for the wire-level shield filter. Mirrors the Rust
 * `ShieldConfig` shape; the JS layer constructs it from `ShieldMiddleware`
 * options at boot and hands it off to `HyperServer.configureShield`.
 */

export interface NapiShieldConfig {
  pathTraversal: boolean
  paramPollution: boolean
}

/**
 * Configuration for the wire-level rate limiter. `windowSecs` is the size
 * of the fixed window in seconds; `max` is the request budget per key
 * (resolved client IP) per window.
 */

export interface NapiRateLimitConfig {
  max: number
  windowSecs: number
}

/**
 * NAPI-exposed event bus.
 * Uses shared Tokio runtime (no per-instance runtime).
 */

export declare class EventBus {
  constructor(requestHandlerTimeoutMs?: number | undefined | null)
  /** Emit an event (async — does NOT block Node.js thread). */
  emit(name: string, data: string): Promise<string>
  /**
   * Subscribe to events matching a pattern. Callback receives event JSON string.
   * Returns subscription ID.
   *
   * NOTE: This is `pub fn` (sync) — napi-rs cannot make `async fn` capture
   * `JsFunction` because JsFunction isn't Send. The block_on here runs on the
   * JS thread (no async context above), so it doesn't deadlock the runtime.
   */
  subscribe(pattern: string, callback: (eventJson: string) => void): number
  /** Unsubscribe by subscription ID. */
  unsubscribe(subId: number): Promise<void>
  /** Register a request handler. */
  onRequest(
    name: string,
    callback: (eventJson: string, reply: (response: string) => void) => void,
  ): void
  /** Send a request and get a response (async with timeout). */
  request(name: string, data: string, timeoutMs?: number | undefined | null): Promise<string>
  /** Check if a pattern matches an event name (wildcard matching via Rust). */
  matchesWildcard(pattern: string, eventName: string): boolean
  /** Get subscription count. */
  subscriptionCount(): Promise<number>
}

/** NAPI-exposed Hyper HTTP server. */

export declare class HyperServer {
  /**
   * `host` is the bind address: an IPv4 literal (`0.0.0.0` to accept from
   * every interface) or the `localhost` alias. Omitted → loopback only,
   * the safe default for a dev machine.
   */
  constructor(port?: number | undefined | null, host?: string | undefined | null)
  /** Register the request handler. Callback receives JSON request string, must return JSON response string. */
  onRequest(callback: (request: string) => Promise<string> | string): void
  /**
   * Configure the trusted-proxy CIDR list used by `request.ip` resolution.
   * Must be called BEFORE `listen()`. Empty list = legacy permissive mode
   * (any peer can populate `X-Forwarded-For`).
   */
  configureTrustedProxies(cidrs: Array<string>): void
  /**
   * Install (or replace) the wire-level rate limiter. Pass `None` to
   * disable. Must be called BEFORE `listen()`.
   */
  configureRateLimit(config?: NapiRateLimitConfig | undefined | null): void
  /**
   * Configure the wire-level security shield. Must be called BEFORE
   * `listen()` — the configuration is captured into the security filter
   * when the server starts. Calling after `listen()` has no effect.
   */
  configureShield(config: NapiShieldConfig): void
  /** Start the HTTP server. */
  listen(): Promise<void>
  /** Get the actual bound port. */
  port(): Promise<number>
  /**
   * Shut down the server and release the handles that keep the host's event
   * loop alive.
   *
   * `listen()` registers the JS callback as a `ThreadsafeFunction` (which
   * holds a libuv ref so `ream start` stays alive). Three `Arc` clones of the
   * request handler capture it: this struct's `self.handler`, the inner
   * `ReamServer.handler`, and the accept-loop task's clone. ALL three must
   * drop for napi-rs to release the tsfn on `Drop` (refcount → 0). The old
   * `close()` only signalled shutdown, leaving every clone alive — so an
   * in-process host (test harness) leaked the handle and never drained.
   */
  close(): Promise<void>
  /**
   * Reserve a slot in the stream registry. Returns `false` if the id
   * already exists (caller picked a colliding UUID). Always returns
   * before `listen()` need have run.
   */
  registerStream(streamId: string): Promise<boolean>
  /**
   * Push a chunk onto a registered stream. Returns `false` when the
   * stream has already finished (receiver dropped — client gone or
   * `closeStream` called) so the caller can bail out of its push
   * loop. Backpressure is handled silently: a full buffer drops the
   * frame rather than awaiting — SSE is fire-and-forget by design.
   */
  writeStream(streamId: string, chunk: string): Promise<boolean>
  /**
   * Push a BINARY chunk onto a registered stream, waiting for room.
   *
   * The counterpart of [`write_stream`](Self::write_stream) for a body the
   * client reassembles — a file, an export, an archive. Two differences,
   * both required there and both wrong for SSE:
   *
   * * it takes bytes, not a `String`, so a payload that is not valid UTF-8
   *   survives the crossing intact;
   * * it AWAITS when the channel is full instead of dropping the frame, so
   *   a slow client slows the producer rather than silently receiving a
   *   truncated file.
   *
   * Returns `false` when the receiver is gone (client disconnected or the
   * stream was closed), so the caller can stop reading its source.
   */
  writeStreamBytes(streamId: string, chunk: Uint8Array): Promise<boolean>
  /**
  * Close a stream from the server side. The matching response body
  * finishes cleanly (hyper writes the final chunk + `0
  
  ` for
  * HTTP/1.1 chunked encoding). Idempotent.
  */
  closeStream(streamId: string): Promise<boolean>
  /**
   * Install a one-shot callback fired the moment the matching stream
   * receiver is dropped — i.e. the client disconnected or
   * `closeStream` was called. Used by the JS SDK to drop subscription
   * bookkeeping when an SSE viewer leaves.
   *
   * The callback runs on the libuv loop via the threadsafe-function
   * machinery, so JS code in the callback uses regular await /
   * reentrant container calls without crossing-thread surprises.
   */
  onStreamDisconnect(streamId: string, callback: (streamId: string) => void): void
}

/**
 * Scheduler instance exposed to TypeScript.
 *
 * Usage (from TS):
 * ```ignore
 * const scheduler = new RustScheduler();
 * scheduler.register('cleanup', '0 *\/5 * * *', (payload) => { ... });
 * scheduler.start();
 * // later
 * scheduler.stop();
 * ```
 */

export declare class RustScheduler {
  constructor()
  /**
   * Register a task. `cronExpr` is a standard 5-field cron expression
   * evaluated in UTC.
   *
   * Throws with `DUPLICATE_TASK` if `name` already exists, or
   * `INVALID_CRON` if the expression is malformed.
   */
  register(
    name: string,
    cronExpr: string,
    callback: (invocation: { taskName: string; scheduledForMs: number }) => void,
  ): void
  /** Remove a task. Idempotent — unknown names are not an error. */
  unregister(name: string): void
  /** Launch the tick loop on the shared Tokio runtime. Idempotent. */
  start(): void
  /** Cancel the tick loop. Safe to call even if not running. */
  stop(): void
  /** Return the next fire time in ms epoch, or `null` if the task is unknown. */
  nextRun(name: string): number | null
}

/**
 * Sign a JWT payload with HMAC-SHA256 (Rust-native).
 * Returns the complete JWT token string.
 */

export declare function jwtSign(payload: string, secret: string): string

/**
 * Verify a JWT token and return the decoded payload JSON string.
 * Validates signature (constant-time), exp, and nbf claims.
 */

export declare function jwtVerify(token: string, secret: string): string

/**
 * Hash a password with Argon2id (Rust-native).
 * Returns the PHC-formatted hash string.
 */

export declare function argon2Hash(password: string): string

/** Verify a password against an Argon2id hash. */

export declare function argon2Verify(password: string, hash: string): boolean

/**
 * Hash a password with bcrypt (Rust-native).
 * `rounds` defaults to 12 when not supplied — matches the previous
 * warden-engine default and the OWASP-recommended cost floor enforced
 * by `sigil-engine`.
 */

export declare function bcryptHash(password: string, rounds?: number | undefined | null): string

/** Verify a password against a bcrypt hash. */

export declare function bcryptVerify(password: string, hash: string): boolean

/** Constant-time string comparison. */

export declare function constantTimeEq(a: string, b: string): boolean

/** HMAC-SHA256 sign. Returns base64url signature. */

export declare function hmacSign(data: string, secret: string): string

/** HMAC-SHA256 verify (constant-time). */

export declare function hmacVerify(data: string, signature: string, secret: string): boolean

/** Generate cryptographically secure random bytes as base64url. */

export declare function randomBytesBase64(len: number): string

/** Generate cryptographically secure random bytes as hex. */

export declare function randomHex(len: number): string

/**
 * Parse a GraphQL query using the Rust graphql-parser crate.
 * Returns JSON: { operationType, operationName, fields: [...], errors: [...] }
 * Invalid queries are rejected here — they never reach the TypeScript resolver layer.
 */

export declare function graphqlParse(query: string): string

/** Validate a GraphQL query string. Returns JSON array of error strings (empty = valid). */

export declare function graphqlValidate(query: string): string

/**
 * Extract argument scalar types from a GraphQL SDL schema.
 * Returns JSON: `{ "Type.field": { "argName": "ScalarType" } }` for argument
 * coercion in the TypeScript engine.
 */

export declare function graphqlSchemaArgTypes(sdl: string): string
