/**
 * Helix bus testing helpers — collect, fake, assertEmitted, assertNotEmitted,
 * waitForEvent, waitForChain.
 *
 * Public testing API for asserting on events emitted through EventBus.
 *
 * @implements FR64, FR65, FR66, FR67, FR68 (Story 11.1)
 */

export interface CollectedEvent {
  name: string
  data: unknown
  correlationId?: string
  causationId?: string
  [key: string]: unknown
}

export interface CollectResult {
  events: CollectedEvent[]
  subId: number
}

interface BusLike {
  subscribe(pattern: string, callback: (eventJson: string) => void): number
}

/**
 * Collect events matching a pattern into an array.
 *
 *     const { events } = collect(bus, 'order.created')
 *     bus.emit('order.created', '{"id":"1"}')
 *     // events[0].name === 'order.created'
 */
export function collect(bus: BusLike, pattern: string): CollectResult {
  const events: CollectedEvent[] = []
  const subId = bus.subscribe(pattern, (eventJson: string) => {
    try {
      events.push(JSON.parse(eventJson) as CollectedEvent)
    } catch {
      events.push({
        _raw: eventJson,
        _parseError: true,
        name: '',
        data: undefined,
      } as CollectedEvent)
    }
  })
  return { events, subId }
}

/**
 * Fake (intercept) events matching a pattern.
 *
 * Currently captures events like collect() — true interception that suppresses
 * other subscribers requires bus-level support and is not yet implemented.
 */
export function fake(bus: BusLike, pattern: string): CollectResult {
  return collect(bus, pattern)
}

/**
 * Assert that an event was emitted, optionally matching a partial payload.
 */
export function assertEmitted(events: CollectedEvent[], name: string, payload?: unknown): void {
  const matching = events.filter((e) => e.name === name)

  if (matching.length === 0) {
    const emittedNames = [...new Set(events.map((e) => e.name))].join(', ')
    throw new Error(
      `[HELIX_ASSERT_EMITTED] Expected event '${name}' to be emitted, but it was not.\n` +
        `  Emitted events: ${emittedNames || '(none)'}`,
    )
  }

  if (payload !== undefined && payload !== null) {
    const payloadMatch = matching.find((e) => {
      const data = typeof e.data === 'string' ? safeJson(e.data) : e.data
      return partialMatch(data, payload)
    })

    if (!payloadMatch) {
      const actualPayloads = matching
        .map((e) => {
          const data = typeof e.data === 'string' ? safeJson(e.data) : e.data
          return JSON.stringify(data)
        })
        .join('\n    ')

      throw new Error(
        `[HELIX_ASSERT_EMITTED] Event '${name}' was emitted but no payload matched.\n` +
          `  Expected (partial): ${JSON.stringify(payload)}\n` +
          `  Actual payloads:\n    ${actualPayloads}`,
      )
    }
  }
}

/** Assert that an event was NOT emitted. */
export function assertNotEmitted(events: CollectedEvent[], name: string): void {
  const matching = events.filter((e) => e.name === name)
  if (matching.length > 0) {
    throw new Error(
      `[HELIX_ASSERT_NOT_EMITTED] Expected event '${name}' to NOT be emitted, but it was emitted ${matching.length} time(s).`,
    )
  }
}

export interface WaitForEventOptions {
  timeout?: number
  interval?: number
  payload?: unknown
}

/** Wait for a specific event to appear in the collected events, with timeout. */
export function waitForEvent(
  events: CollectedEvent[],
  name: string,
  options: WaitForEventOptions = {},
): Promise<CollectedEvent> {
  const timeout = options.timeout ?? 5000
  const interval = options.interval ?? 10
  const payload = options.payload

  return new Promise((resolve, reject) => {
    const start = Date.now()
    let settled = false

    const check = () => {
      if (settled) return

      const match = events.find((e) => {
        if (e.name !== name) return false
        if (payload === undefined) return true
        const data = typeof e.data === 'string' ? safeJson(e.data) : e.data
        return partialMatch(data, payload)
      })

      if (match) {
        settled = true
        resolve(match)
        return
      }

      if (Date.now() - start >= timeout) {
        settled = true
        const received = events.map((e) => e.name).join(', ')
        reject(
          new Error(
            `[HELIX_TIMEOUT] Timed out waiting for event '${name}' after ${timeout}ms.\n` +
              `  Events received so far: ${received || '(none)'}`,
          ),
        )
        return
      }

      setTimeout(check, interval)
    }

    check()
  })
}

export interface WaitForChainOptions {
  timeout?: number
  interval?: number
}

/**
 * Wait for an entire event chain to complete (tracked via correlationId).
 *
 * @implements FR68
 */
export function waitForChain(
  events: CollectedEvent[],
  correlationId: string,
  expectedNames: string[],
  options: WaitForChainOptions = {},
): Promise<CollectedEvent[]> {
  if (!expectedNames || expectedNames.length === 0) {
    return Promise.reject(new Error('[HELIX_CHAIN] expectedNames must be a non-empty array'))
  }
  const timeout = options.timeout ?? 5000
  const interval = options.interval ?? 10

  return new Promise((resolve, reject) => {
    const start = Date.now()
    let settled = false

    const check = () => {
      if (settled) return

      const chainEvents = events.filter((e) => e.correlationId === correlationId)
      const chainNames = chainEvents.map((e) => e.name)
      const allPresent = expectedNames.every((name) => chainNames.includes(name))

      if (allPresent) {
        settled = true
        resolve(chainEvents)
        return
      }

      if (Date.now() - start >= timeout) {
        settled = true
        const completed = expectedNames.filter((n) => chainNames.includes(n))
        const pending = expectedNames.filter((n) => !chainNames.includes(n))
        reject(
          new Error(
            `[HELIX_CHAIN_TIMEOUT] Event chain timed out after ${timeout}ms.\n` +
              `  Correlation ID: ${correlationId}\n` +
              `  Completed: ${completed.join(', ') || '(none)'}\n` +
              `  Pending: ${pending.join(', ')}`,
          ),
        )
        return
      }

      setTimeout(check, interval)
    }

    check()
  })
}

/**
 * Check if `actual` contains all key-value pairs from `expected` (deep partial match).
 * Arrays are matched element-by-element.
 */
function partialMatch(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true
  if (expected === null || expected === undefined) return actual === expected
  if (typeof expected !== 'object') return actual === expected
  if (typeof actual !== 'object' || actual === null) return false

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false
    return expected.every(
      (item, i) => i < (actual as unknown[]).length && partialMatch((actual as unknown[])[i], item),
    )
  }

  for (const key of Object.keys(expected as object)) {
    if (!(key in (actual as object))) return false
    if (
      !partialMatch(
        (actual as Record<string, unknown>)[key],
        (expected as Record<string, unknown>)[key],
      )
    )
      return false
  }
  return true
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
