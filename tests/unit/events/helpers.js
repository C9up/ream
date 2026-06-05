/**
 * Helix bus testing helpers — collect, fake, assertEmitted, assertNotEmitted, waitForEvent
 *
 * @implements FR64, FR65, FR66, FR67, FR68
 */

/**
 * Collect events matching a pattern into an array.
 *
 * Usage:
 *   const { events } = collect(bus, 'order.created')
 *   bus.emit('order.created', '{"id":"1"}')
 *   // events[0].name === 'order.created'
 *
 * @param {object} bus - Emitter instance
 * @param {string} pattern - Event pattern to match
 * @returns {{ events: object[], subId: number }}
 */
export function collect(bus, pattern) {
  const events = []
  const subId = bus.subscribe(pattern, (eventJson) => {
    try {
      events.push(JSON.parse(eventJson))
    } catch {
      events.push({ _raw: eventJson, _parseError: true })
    }
  })
  return { events, subId }
}

/**
 * Fake (intercept) events matching a pattern.
 * Captures events into an array for assertions.
 *
 * Note: True interception (suppressing other subscribers) requires bus-level
 * support. Current implementation captures events like collect() — other
 * subscribers still receive the event. Use unsubscribe() on real handlers
 * before calling fake() if suppression is needed.
 *
 * @param {object} bus - Emitter instance
 * @param {string} pattern - Event pattern to intercept
 * @returns {{ events: object[], subId: number }}
 */
export function fake(bus, pattern) {
  const events = []
  const subId = bus.subscribe(pattern, (eventJson) => {
    try {
      events.push(JSON.parse(eventJson))
    } catch {
      events.push({ _raw: eventJson, _parseError: true })
    }
  })
  return { events, subId }
}

/**
 * Assert that an event was emitted with optional partial payload matching.
 *
 * @param {object[]} events - Collected events array from collect() or fake()
 * @param {string} name - Event name to look for
 * @param {object} [payload] - Optional partial payload to match against event.data
 * @throws {Error} If no matching event found
 */
export function assertEmitted(events, name, payload) {
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
      const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
      return partialMatch(data, payload)
    })

    if (!payloadMatch) {
      const actualPayloads = matching
        .map((e) => {
          const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
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

/**
 * Assert that an event was NOT emitted.
 *
 * @param {object[]} events - Collected events array
 * @param {string} name - Event name that should NOT have been emitted
 * @throws {Error} If the event was found
 */
export function assertNotEmitted(events, name) {
  const matching = events.filter((e) => e.name === name)
  if (matching.length > 0) {
    throw new Error(
      `[HELIX_ASSERT_NOT_EMITTED] Expected event '${name}' to NOT be emitted, but it was emitted ${matching.length} time(s).`,
    )
  }
}

/**
 * Wait for a specific event to appear in the collected events, with timeout.
 *
 * @param {object[]} events - Collected events array (will be polled)
 * @param {string} name - Event name to wait for
 * @param {object} [options] - { timeout: number (ms), interval: number (ms), payload: object }
 * @returns {Promise<object>} The matching event
 * @throws {Error} On timeout with list of events received so far
 */
export function waitForEvent(events, name, options = {}) {
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
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
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

/**
 * Wait for an entire event chain to complete (tracked via correlationId).
 *
 * Collects events sharing the same correlationId as the trigger event,
 * then waits until all expected event names in the chain have appeared.
 *
 * @param {object[]} events - Collected events array (from collect() with wildcard)
 * @param {string} correlationId - The correlationId to track
 * @param {string[]} expectedNames - Event names that must all appear in the chain
 * @param {object} [options] - { timeout: number (ms), interval: number (ms) }
 * @returns {Promise<object[]>} The matched chain events
 * @throws {Error} On timeout showing completed and pending events
 *
 * @implements FR68
 */
export function waitForChain(events, correlationId, expectedNames, options = {}) {
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
 * Arrays are matched element-by-element (expected elements must match at the same index).
 */
function partialMatch(actual, expected) {
  if (actual === expected) return true
  if (expected === null || expected === undefined) return actual === expected
  if (typeof expected !== 'object') return actual === expected
  if (typeof actual !== 'object' || actual === null) return false

  // Array handling
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false
    return expected.every((item, i) => i < actual.length && partialMatch(actual[i], item))
  }

  // Object handling
  for (const key of Object.keys(expected)) {
    if (!(key in actual)) return false
    if (!partialMatch(actual[key], expected[key])) return false
  }
  return true
}
