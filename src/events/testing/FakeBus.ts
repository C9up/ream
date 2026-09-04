/**
 * In-memory `EventBus` substitute for tests — captures every
 * `emit(name, data)` / `request(name, data)` call and exposes
 * `assertEmitted` / `assertNotEmitted` helpers in the same shape as
 * Rover's `FakeMail`, Bay's `FakeQueue`, Storage's `FakeStorage`,
 * Nova's `FakeNova`, and Relay's `FakeRelay`.
 *
 * Mirrors the public `EventBus` surface (`emit`, `subscribe`,
 * `unsubscribe`, `onRequest`, `request`, `matchesWildcard`,
 * `subscriptionCount`) with pure-TS, NAPI-free semantics. Wildcard
 * matching is ported from `crates/ream-events/src/router.rs` — the
 * Rust router is authoritative; any divergence is a bug here.
 *
 * Reach via `@c9up/ream/events/testing` (NOT the main barrel).
 */

export interface CapturedEmit {
  kind: 'emit'
  name: string
  data: string
  parsedData?: unknown
  correlationId?: string
  causationId?: string
}

export interface CapturedRequest {
  kind: 'request'
  name: string
  data: string
  parsedData?: unknown
}

export interface FakeBusPredicate {
  name?: string
  dataMatches?: (data: unknown) => boolean
  correlationId?: string
  causationId?: string
}

export type FakeBusPredicateArg = FakeBusPredicate | ((event: CapturedEmit) => boolean)

interface Subscription {
  pattern: string
  /**
   * Subscribers may be sync or async; whatever they return is awaited and
   * dropped, and an async rejection is logged via `console.error` rather than
   * escaping to `unhandledRejection`.
   *
   * `unknown`, not `void | PromiseLike<void>`: a bare `void` return type
   * accepts a function returning anything, but a UNION containing it does not
   * — so widening the native bus's `=> void` to that union made it NARROWER in
   * practice, and `(json) => received.push(json)` stopped compiling.
   */
  callback: (eventJson: string) => unknown
}

/** Request handler may return `void` (sync, fire-and-forget after `reply`)
 *  or `PromiseLike<void>` (async — the bus awaits and routes any rejection
 *  through `request()`'s reject path). */
export type FakeBusRequestHandler = (
  eventJson: string,
  reply: (response: string) => void,
) => void | PromiseLike<void>

export class FakeBus {
  #emitted: CapturedEmit[] = []
  #requests: CapturedRequest[] = []
  #subscribers = new Map<number, Subscription>()
  #requestHandlers = new Map<string, FakeBusRequestHandler>()
  #nextSubId = 1

  emit(name: string, data: string): Promise<string> {
    const { parsedData, correlationId, causationId } = parseEmitData(data)
    const entry: CapturedEmit = {
      kind: 'emit',
      name,
      data,
      parsedData,
      correlationId,
      causationId,
    }
    this.#emitted.push(entry)
    // Snapshot subscribers so a callback adding/removing during dispatch
    // can't perturb the in-flight iteration — matches the router.rs
    // "clone matching handlers; release lock; call without holding lock"
    // pattern.
    const targets: Subscription[] = []
    for (const sub of this.#subscribers.values()) {
      if (this.matchesWildcard(sub.pattern, name)) targets.push(sub)
    }
    const payloadJson = buildEventJson(entry)
    for (const sub of targets) {
      // Subscribers can be sync (`(json) => void`) or async (`(json) =>
      // Promise<void>`). Sync throws surface via the `try/catch`; async
      // rejections would otherwise escape to `unhandledRejection`. Wrap
      // both paths so a misbehaving subscriber logs loudly instead of
      // crashing the test process — mirror of the request-handler error
      // surface at `onError` below.
      try {
        const ret = sub.callback(payloadJson)
        if (isThenable(ret)) {
          ret.then(undefined, (err: unknown) => {
            console.error(
              `[FakeBus] subscriber for "${sub.pattern}" rejected on event "${name}":`,
              err,
            )
          })
        }
      } catch (err) {
        console.error(`[FakeBus] subscriber for "${sub.pattern}" threw on event "${name}":`, err)
      }
    }
    return Promise.resolve('ok')
  }

  subscribe(pattern: string, callback: (eventJson: string) => unknown): number {
    const id = this.#nextSubId++
    this.#subscribers.set(id, { pattern, callback })
    return id
  }

  unsubscribe(subscriptionId: number): Promise<void> {
    this.#subscribers.delete(subscriptionId)
    return Promise.resolve()
  }

  onRequest(name: string, callback: FakeBusRequestHandler): void {
    if (this.#requestHandlers.has(name)) {
      throw new Error(
        `FakeBus.onRequest: a handler is already registered for "${name}". Call reset() between registrations.`,
      )
    }
    this.#requestHandlers.set(name, callback)
  }

  request(name: string, data: string, timeoutMs: number = 5000): Promise<string> {
    const handler = this.#requestHandlers.get(name)
    if (!handler) {
      return Promise.reject(new Error(`FakeBus: no request handler registered for "${name}"`))
    }
    // Only log requests the bus accepted. A handler-missing rejection
    // represents "code-under-test attempted a request the system was
    // not configured for" — that's a setup bug, not a bus call, and it
    // should not poison `getRequests()` symmetry with `getEmitted()`.
    const { parsedData } = parseEmitData(data)
    this.#requests.push({ kind: 'request', name, data, parsedData })
    return new Promise<string>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(
          new Error(`FakeBus.request: handler for "${name}" did not reply within ${timeoutMs}ms`),
        )
      }, timeoutMs)
      // Fake-timers note: `vi.useFakeTimers()` mocks the `setTimeout`
      // scheduled above. The happy-path resolve via `reply(...)` does
      // not depend on timer advancement, but the rejection branch does
      // — call `vi.advanceTimersByTime(timeoutMs)` to surface the
      // timeout when fake timers are active.
      const reply = (response: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(response)
      }
      const onError = (err: unknown): void => {
        if (settled) {
          console.error(`[FakeBus] request handler for "${name}" threw after reply:`, err)
          return
        }
        settled = true
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
      try {
        const ret = handler(data, reply)
        if (isThenable(ret)) ret.then(undefined, onError)
      } catch (err) {
        onError(err)
      }
    })
  }

  matchesWildcard(pattern: string, eventName: string): boolean {
    return wildcardMatches(pattern, eventName)
  }

  subscriptionCount(): Promise<number> {
    return Promise.resolve(this.#subscribers.size)
  }

  /**
   * Defensive clone of the captured emits. **Clone is lossy** for
   * non-cloneable values: `structuredClone` is tried first, JSON
   * round-trip is the fallback. BigInt, functions, and other
   * non-stringifiable payloads collapse to `undefined` in the fallback
   * path (with a `[FakeBus] non-cloneable capture` `console.warn`).
   * Internal assertions (`assertEmitted` etc.) read the live capture,
   * not the clone, so this caveat only affects external readers.
   */
  getEmitted(): CapturedEmit[] {
    return this.#emitted.map(cloneEmit)
  }

  /** See `getEmitted` — same lossy-clone caveat for non-cloneable values. */
  getRequests(): CapturedRequest[] {
    return this.#requests.map(cloneRequest)
  }

  reset(): void {
    this.#emitted = []
    this.#requests = []
    this.#subscribers.clear()
    this.#requestHandlers.clear()
    this.#nextSubId = 1
  }

  assertEmitted(name: string, predicate?: FakeBusPredicateArg): void {
    const match = makeMatcher(name, predicate)
    if (this.#emitted.some(match)) return
    throw new Error(
      `FakeBus.assertEmitted('${name}'${describePredicate(predicate)}) failed — no captured emit matches.\n${describeCaptured(this.#emitted)}`,
    )
  }

  assertNotEmitted(name: string, predicate?: FakeBusPredicateArg): void {
    const match = makeMatcher(name, predicate)
    if (!this.#emitted.some(match)) return
    throw new Error(
      `FakeBus.assertNotEmitted('${name}'${describePredicate(predicate)}) failed — at least one captured emit matches.\n${describeCaptured(this.#emitted)}`,
    )
  }
}

/** Port of `wildcard_matches` from `crates/ream-events/src/router.rs`.
 *  Authoritative source is the Rust router; any divergence is a bug. */
function wildcardMatches(pattern: string, eventName: string): boolean {
  if (pattern === '**') return true
  if (pattern === '*') return !eventName.includes('.')

  const patternParts = pattern.split('.')
  const nameParts = eventName.split('.')

  const last = patternParts[patternParts.length - 1]
  if (last === '**') {
    const prefix = patternParts.slice(0, patternParts.length - 1)
    if (nameParts.length < prefix.length) return false
    for (let i = 0; i < prefix.length; i += 1) {
      if (prefix[i] !== nameParts[i]) return false
    }
    return true
  }

  if (patternParts.length !== nameParts.length) return false
  for (let i = 0; i < patternParts.length; i += 1) {
    const p = patternParts[i]
    if (p !== '*' && p !== nameParts[i]) return false
  }
  return true
}

interface ParsedHeader {
  parsedData?: unknown
  correlationId?: string
  causationId?: string
}

function parseEmitData(data: string): ParsedHeader {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { parsedData: parsed }
  }
  return {
    parsedData: parsed,
    correlationId: readStringField(parsed, 'correlationId'),
    causationId: readStringField(parsed, 'causationId'),
  }
}

function readStringField(source: object, key: string): string | undefined {
  const record = source as Record<string, unknown>
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function buildEventJson(entry: CapturedEmit): string {
  // Mirror the Rust `Event` envelope shape (`crates/ream-events/src/event.rs` —
  // serde `rename_all = "camelCase"`): `{ id, name, data, correlationId,
  // causationId?, timestamp, sourceService, nodeId, ttl }`. `data` stays the
  // raw payload string the caller passed to `emit`, so subscribers using
  // `JSON.parse(event.data)` after `JSON.parse(eventJson)` work the same
  // against the fake as against the real bus. The five envelope-metadata
  // fields (`id`, `timestamp`, `sourceService`, `nodeId`, `ttl`) are
  // stubbed to the same defaults `Event::new` sets in Rust — synthetic but
  // type-shape complete, so code-under-test reading them does not branch
  // differently fake-vs-prod.
  const generatedId = globalThis.crypto.randomUUID()
  const envelope: Record<string, unknown> = {
    id: generatedId,
    name: entry.name,
    data: entry.data,
    correlationId: entry.correlationId ?? generatedId,
    timestamp: new Date().toISOString(),
    sourceService: '',
    nodeId: 'local',
    ttl: 255,
  }
  if (entry.causationId !== undefined) envelope.causationId = entry.causationId
  return JSON.stringify(envelope)
}

function cloneEmit(entry: CapturedEmit): CapturedEmit {
  try {
    return structuredClone(entry)
  } catch {
    console.warn(
      `[FakeBus] non-cloneable capture for "${entry.name}"; falling back to JSON round-trip.`,
    )
    return {
      kind: 'emit',
      name: entry.name,
      data: entry.data,
      parsedData: cloneViaJson(entry.parsedData),
      correlationId: entry.correlationId,
      causationId: entry.causationId,
    }
  }
}

function cloneRequest(entry: CapturedRequest): CapturedRequest {
  try {
    return structuredClone(entry)
  } catch {
    console.warn(
      `[FakeBus] non-cloneable capture for "${entry.name}"; falling back to JSON round-trip.`,
    )
    return {
      kind: 'request',
      name: entry.name,
      data: entry.data,
      parsedData: cloneViaJson(entry.parsedData),
    }
  }
}

function cloneViaJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return undefined
  }
}

function makeMatcher(
  name: string,
  predicate: FakeBusPredicateArg | undefined,
): (e: CapturedEmit) => boolean {
  if (typeof predicate === 'function') {
    return (e) => wildcardMatches(name, e.name) && predicate(e)
  }
  if (predicate === undefined) {
    return (e) => wildcardMatches(name, e.name)
  }
  return (e) => {
    if (!wildcardMatches(name, e.name)) return false
    if (predicate.name !== undefined && !wildcardMatches(predicate.name, e.name)) return false
    if (predicate.correlationId !== undefined && e.correlationId !== predicate.correlationId)
      return false
    if (predicate.causationId !== undefined && e.causationId !== predicate.causationId) return false
    if (predicate.dataMatches) {
      const arg = e.parsedData !== undefined ? e.parsedData : e.data
      if (!predicate.dataMatches(arg)) return false
    }
    return true
  }
}

function describePredicate(predicate: FakeBusPredicateArg | undefined): string {
  if (predicate === undefined) return ''
  if (typeof predicate === 'function') return ', <function predicate>'
  if (Object.keys(predicate).length === 0) {
    return ', <empty predicate>'
  }
  return `, ${safeStringify(predicate)}`
}

function describeCaptured(captured: CapturedEmit[]): string {
  if (captured.length === 0) return 'Captured: (none)'
  const lines = captured.map(
    (c, i) =>
      `  [${i}] name="${c.name}" data=${safeStringify(c.parsedData ?? c.data)}` +
      (c.correlationId !== undefined ? ` correlationId="${c.correlationId}"` : '') +
      (c.causationId !== undefined ? ` causationId="${c.causationId}"` : ''),
  )
  return `Captured (${captured.length}):\n${lines.join('\n')}`
}

function safeStringify(value: unknown): string {
  // JSON.stringify already detects true cycles and throws TypeError —
  // the outer catch handles that. A previous manual WeakSet walk
  // mis-labelled DAG sibling references as `<circular>` because it
  // never released entries on subtree exit.
  try {
    return JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v === 'function') return '<function>'
      // JSON.stringify throws on BigInt; preserve the value lossy-but-
      // readable so a single BigInt in a captured payload does not
      // collapse the whole failure message to "<unstringifiable>".
      if (typeof v === 'bigint') return `${v}n`
      return v
    })
  } catch {
    return '<unstringifiable>'
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || typeof value !== 'object') return false
  if (!('then' in value)) return false
  return typeof value.then === 'function'
}
