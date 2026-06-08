/**
 * Server-Sent Events writer — owns one logical SSE stream and pushes
 * encoded events through the underlying `StreamBackend` (a thin
 * abstraction over the HyperServer NAPI `registerStream` / `writeStream`
 * / `closeStream` trio).
 *
 * Lifecycle:
 *
 *   1. `ctx.response.sse()` returns a ready-to-use writer. Internally it
 *      asks the backend to reserve a stream id and stamps the response
 *      with the right `Content-Type` + caching headers so the host
 *      router knows to switch into streaming mode.
 *   2. The handler calls `writer.send(event, data)` / `writer.comment(...)`
 *      to push frames. Each call returns a boolean — `false` once the
 *      client has disconnected, so callers can bail out of long loops
 *      without polling.
 *   3. The handler RETURNS the Response from the route — buffered body is
 *      empty, but `response.getStreamId()` is set, so Ream tells the
 *      Rust HyperServer to keep the connection open and feed the body
 *      from the stream registry.
 *   4. Background tasks keep pushing through `writer.send(...)` until
 *      either the client leaves (`onClose` callback fires) or the
 *      server calls `writer.end()`.
 *
 * The encoding follows the SSE wire format (RFC chez WHATWG):
 *
 *     event: <name>\n
 *     data: <stringified payload>\n
 *     id: <optional event id>\n
 *     \n
 *
 * Multi-line payloads are split on `\n` and each line is prefixed with
 * `data: ` so the consumer browser reassembles them with newlines.
 */

/** Minimal backend the writer needs — the HyperServer NAPI fits exactly. */
export interface StreamBackend {
  registerStream(streamId: string): Promise<boolean>
  writeStream(streamId: string, chunk: string): Promise<boolean>
  closeStream(streamId: string): Promise<boolean>
  onStreamDisconnect(streamId: string, callback: () => void): void
}

export interface SseStreamOptions {
  /** Keep-alive ping interval (ms). Defaults to 30s. Set to 0 to disable. */
  pingInterval?: number
  /** Initial `retry: <ms>` directive sent before any event. Defaults to 5_000. */
  retry?: number
}

const DEFAULT_PING_INTERVAL = 30_000
const DEFAULT_RETRY = 5_000

/** Cryptographic-quality stream id — 16 random bytes, hex-encoded. */
function generateStreamId(): string {
  const bytes = new Uint8Array(16)
  // `crypto.getRandomValues` is the WHATWG primitive available on every
  // supported Node version (>=22). Avoids pulling in `node:crypto` for
  // a 32-char hex string.
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Active SSE writer returned by `response.sse()`. */
export class SseStream {
  readonly id: string
  #backend: StreamBackend
  #open = true
  #closeFired = false
  #pingTimer: ReturnType<typeof setInterval> | null = null
  #closeListeners: Array<() => void> = []

  constructor(id: string, backend: StreamBackend, options?: SseStreamOptions) {
    this.id = id
    this.#backend = backend

    // The backend disconnect signal and a server-side end() can BOTH
    // fire (e.g. server end() followed by the client-drop signal). The
    // shared #fireClose() guards idempotency so user cleanups run once.
    backend.onStreamDisconnect(id, () => {
      this.#open = false
      this.#stopPing()
      this.#fireClose()
    })

    const ping = options?.pingInterval ?? DEFAULT_PING_INTERVAL
    if (ping > 0) {
      this.#pingTimer = setInterval(() => {
        if (!this.#open) return
        // Comment frames keep the connection alive without firing a
        // JS event on the client. `writeStream` returns false once the
        // client has disconnected (per the NAPI contract); if we see
        // that while still "open" the disconnect signal was missed —
        // e.g. the client dropped in the window between registerStream
        // and the constructor wiring onStreamDisconnect. Self-heal:
        // stop the timer and run close listeners once, so a dropped-
        // at-open stream can't leave an orphaned keepalive ticking
        // against a dead registry slot.
        void this.#backend.writeStream(this.id, ':keepalive\n\n').then((ok) => {
          if (!ok && this.#open) {
            this.#open = false
            this.#stopPing()
            this.#fireClose()
          }
        })
      }, ping)
      // The keepalive must not pin the Node event loop — letting the
      // process exit on its own when nothing else is keeping it busy
      // matches Adonis Transmit's behavior.
      if (typeof this.#pingTimer === 'object' && 'unref' in this.#pingTimer) {
        ;(this.#pingTimer as { unref: () => void }).unref()
      }
    }
  }

  /** True until the client disconnects or the server calls `end()`. */
  isOpen(): boolean {
    return this.#open
  }

  /**
   * Send a named SSE event. `data` is JSON-stringified unless it is
   * already a string. Returns `false` if the stream is closed.
   *
   * `eventId` is optional — set it when you want browsers to send
   * `Last-Event-ID` on reconnection. Useful for resumable streams.
   */
  async send(event: string, data: unknown, eventId?: string): Promise<boolean> {
    if (!this.#open) return false
    const payload = typeof data === 'string' ? data : JSON.stringify(data)
    return this.#backend.writeStream(this.id, encodeFrame(event, payload, eventId))
  }

  /**
   * Send a comment frame (`:text\n\n`) — useful for keep-alives and
   * for human-readable inline debug. Comments are NOT delivered to
   * `EventSource.onmessage`; the browser silently consumes them.
   */
  async comment(text: string): Promise<boolean> {
    if (!this.#open) return false
    // Strip newlines so a malicious comment cannot inject `\n\n` and
    // close a frame early.
    const sanitized = text.replace(/[\r\n]+/g, ' ')
    return this.#backend.writeStream(this.id, `:${sanitized}\n\n`)
  }

  /** Register a callback fired once the underlying connection drops. */
  onClose(callback: () => void): void {
    if (!this.#open) {
      // Already closed — run the callback synchronously so behavior
      // matches the standard observer pattern.
      try {
        callback()
      } catch {
        // Swallow — same isolation as the normal listener loop.
      }
      return
    }
    this.#closeListeners.push(callback)
  }

  /**
   * End the stream from the server side. Idempotent. The matching
   * NAPI receiver finishes its work and hyper closes the body.
   */
  async end(): Promise<void> {
    if (!this.#open) return
    this.#open = false
    this.#stopPing()
    await this.#backend.closeStream(this.id)
    this.#fireClose()
  }

  #stopPing(): void {
    if (this.#pingTimer !== null) {
      clearInterval(this.#pingTimer)
      this.#pingTimer = null
    }
  }

  /**
   * Run every close listener exactly once. Both end() (server-side) and
   * the backend disconnect signal funnel through here; the #closeFired
   * latch stops user cleanups from being replayed when both fire.
   */
  #fireClose(): void {
    if (this.#closeFired) return
    this.#closeFired = true
    for (const cb of this.#closeListeners) {
      try {
        cb()
      } catch {
        // Listener errors are isolated — one bad cleanup callback
        // mustn't take down the rest.
      }
    }
  }
}

/**
 * Open a new SSE stream against the given backend. Returns once the
 * registry slot is reserved — safe to call `send()` immediately, even
 * before the handler has returned (frames buffer in the bounded mpsc
 * inside Rust).
 *
 * The `retry: <ms>` directive is sent as the first thing on the wire
 * (a comment frame would be invisible to the client; the retry hint
 * needs to land before any real event so browsers know how long to
 * wait before reconnecting if the connection drops).
 */
export async function openSseStream(
  backend: StreamBackend,
  options?: SseStreamOptions,
): Promise<SseStream> {
  const id = generateStreamId()
  const registered = await backend.registerStream(id)
  if (!registered) {
    // Hex collision is astronomically improbable, but surfacing it
    // cleanly beats a silent stream-id mismatch (the response builder
    // would then 500 with E_STREAM_UNKNOWN, which is far less helpful).
    throw new Error(`[ream] failed to reserve SSE stream id ${id} — collision in the registry`)
  }
  // First frame: the recommended retry hint. Conforms to the EventSource
  // reconnection backoff spec; falling through with the default 5s.
  await backend.writeStream(id, `retry: ${options?.retry ?? DEFAULT_RETRY}\n\n`)
  return new SseStream(id, backend, options)
}

/** Encode a single SSE event in the wire format. */
function encodeFrame(event: string, data: string, eventId?: string): string {
  // `event:` line first if we have a name (a frame without `event:` is
  // delivered as a generic `message` event by the browser — both forms
  // are valid).
  const lines: string[] = []
  // `event:` and `id:` are single-line tokens — strip CR/LF so a
  // caller-supplied event name or id can't splice extra SSE frames
  // (the same injection `comment()` guards against). `data` is safe:
  // it's split on `\n` and each line re-prefixed, so newlines there
  // stay inside one logical event.
  if (event) lines.push(`event: ${event.replace(/[\r\n]+/g, ' ')}`)
  // Multi-line data is allowed by SSE but each line must repeat the
  // `data: ` prefix. Splitting on `\n` keeps the browser's
  // reassembly intact (it joins back with `\n`).
  for (const line of data.split('\n')) {
    lines.push(`data: ${line}`)
  }
  if (eventId) lines.push(`id: ${eventId.replace(/[\r\n]+/g, ' ')}`)
  // Trailing blank line terminates the event.
  return `${lines.join('\n')}\n\n`
}
