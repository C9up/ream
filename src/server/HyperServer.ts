import type { HttpKernelRequest, HttpKernelResponse } from '../HttpKernel.js'
import { loadNapi } from '../helpers/napi-loader.js'

/**
 * Wire-level shield configuration handed off to the Rust filter at boot.
 * Each flag toggles one rule on/off; they all default to true on the Rust
 * side, so omitting `configureShield()` entirely leaves the server with no
 * filter installed.
 */
export interface RustShieldConfig {
  pathTraversal: boolean
  paramPollution: boolean
}

export interface RustRateLimitConfig {
  max: number
  windowSecs: number
}

export interface HyperServerLike {
  onRequest(callback: (request: HttpKernelRequest) => Promise<HttpKernelResponse>): void
  configureShield(config: RustShieldConfig): void
  configureTrustedProxies(cidrs: string[]): void
  configureRateLimit(config: RustRateLimitConfig | null): void
  listen(): Promise<void>
  port(): Promise<number>
  close(): Promise<void>
  /**
   * Reserve a streaming-response slot. The handler must call this and
   * pass the returned id back inside `HttpKernelResponse.streamId`
   * BEFORE returning, so the hyper-side response builder can feed the
   * body from the matching registry entry.
   */
  registerStream(streamId: string): Promise<boolean>
  /**
   * Push a UTF-8 chunk onto a registered stream. Returns `false` once
   * the client has disconnected — callers stop pushing.
   */
  writeStream(streamId: string, chunk: string): Promise<boolean>
  /**
   * End a stream from the server side. Idempotent.
   */
  closeStream(streamId: string): Promise<boolean>
  /**
   * Install a one-shot callback fired the moment the matching stream
   * receiver is dropped — i.e. the client disconnected OR
   * `closeStream` was called. Used by the JS SDK to drop bookkeeping
   * for subscriptions and SSE viewers.
   */
  onStreamDisconnect(streamId: string, callback: () => void): void
}

interface NativeModule {
  HyperServer: new (port: number) => HyperServerLike
}

let native: NativeModule | undefined

function loadNative(): NativeModule {
  if (native) return native
  native = loadNapi<NativeModule>({
    binaryName: 'index',
    callerMetaUrl: import.meta.url,
    errorCodePrefix: 'HYPER_SERVER',
  })
  return native
}

/** HyperServer — Rust-powered HTTP server. */
export class HyperServer implements HyperServerLike {
  #inner: HyperServerLike

  constructor(port: number) {
    const mod = loadNative()
    this.#inner = new mod.HyperServer(port)
  }

  onRequest(callback: (request: HttpKernelRequest) => Promise<HttpKernelResponse>): void {
    this.#inner.onRequest(callback)
  }

  configureShield(config: RustShieldConfig): void {
    this.#inner.configureShield(config)
  }

  configureTrustedProxies(cidrs: string[]): void {
    this.#inner.configureTrustedProxies(cidrs)
  }

  configureRateLimit(config: RustRateLimitConfig | null): void {
    this.#inner.configureRateLimit(config)
  }

  listen(): Promise<void> {
    return this.#inner.listen()
  }

  port(): Promise<number> {
    return this.#inner.port()
  }

  close(): Promise<void> {
    return this.#inner.close()
  }

  registerStream(streamId: string): Promise<boolean> {
    return this.#inner.registerStream(streamId)
  }

  writeStream(streamId: string, chunk: string): Promise<boolean> {
    return this.#inner.writeStream(streamId, chunk)
  }

  closeStream(streamId: string): Promise<boolean> {
    return this.#inner.closeStream(streamId)
  }

  onStreamDisconnect(streamId: string, callback: () => void): void {
    this.#inner.onStreamDisconnect(streamId, callback)
  }
}
