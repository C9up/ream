import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeBus } from '../../../src/events/testing/FakeBus.js'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

describe('FakeBus > emit / dispatch', () => {
  it('captures emit AND dispatches to matching subscribers', async () => {
    const bus = new FakeBus()
    const received: string[] = []
    bus.subscribe('order.created', (json) => received.push(json))
    await bus.emit('order.created', JSON.stringify({ id: 'O-1' }))
    expect(bus.getEmitted()).toHaveLength(1)
    expect(received).toHaveLength(1)
    const envelope: Record<string, unknown> = JSON.parse(received[0])
    expect(envelope.name).toBe('order.created')
    expect(envelope.data).toBe(JSON.stringify({ id: 'O-1' }))
  })

  it("emit resolves with 'ok'", async () => {
    const bus = new FakeBus()
    const result = await bus.emit('a', '{}')
    expect(result).toBe('ok')
  })

  it('does not dispatch to non-matching subscribers', async () => {
    const bus = new FakeBus()
    const received: string[] = []
    bus.subscribe('order.created', (json) => received.push(json))
    await bus.emit('payment.received', '{}')
    expect(received).toEqual([])
  })

  it('extracts correlationId / causationId when data is JSON object', async () => {
    const bus = new FakeBus()
    await bus.emit(
      'order.created',
      JSON.stringify({
        id: 'O-1',
        correlationId: 'c-1',
        causationId: 'p-0',
      }),
    )
    const [entry] = bus.getEmitted()
    expect(entry.correlationId).toBe('c-1')
    expect(entry.causationId).toBe('p-0')
    expect(entry.parsedData).toEqual({
      id: 'O-1',
      correlationId: 'c-1',
      causationId: 'p-0',
    })
  })

  it('leaves correlationId / causationId undefined on non-JSON data', async () => {
    const bus = new FakeBus()
    await bus.emit('raw', 'not-json')
    const [entry] = bus.getEmitted()
    expect(entry.correlationId).toBeUndefined()
    expect(entry.causationId).toBeUndefined()
    expect(entry.parsedData).toBeUndefined()
    expect(entry.data).toBe('not-json')
  })

  it('subscriber throw does not break dispatch loop', async () => {
    const bus = new FakeBus()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const survivors: string[] = []
    bus.subscribe('evt', () => {
      throw new Error('boom')
    })
    bus.subscribe('evt', (j) => survivors.push(j))
    await bus.emit('evt', '{}')
    expect(survivors).toHaveLength(1)
    errSpy.mockRestore()
  })

  it('JSON-null payload preserves null in parsedData and is reachable via dataMatches', async () => {
    // Distinguishes JSON-null from a non-JSON payload like "not-json":
    // non-JSON → parsedData undefined ; JSON-null → parsedData === null.
    const bus = new FakeBus()
    await bus.emit('nullable', 'null')
    const [entry] = bus.getEmitted()
    expect(entry.parsedData).toBeNull()
    expect(entry.data).toBe('null')
    expect(() => bus.assertEmitted('nullable', { dataMatches: (d) => d === null })).not.toThrow()
  })
})

describe('FakeBus > subscribe / unsubscribe', () => {
  it('returns monotonically increasing subscription IDs starting at 1', () => {
    const bus = new FakeBus()
    const id1 = bus.subscribe('a', () => {})
    const id2 = bus.subscribe('b', () => {})
    const id3 = bus.subscribe('c', () => {})
    expect(id1).toBe(1)
    expect(id2).toBe(2)
    expect(id3).toBe(3)
  })

  it('unsubscribe is idempotent on unknown IDs', async () => {
    const bus = new FakeBus()
    await expect(bus.unsubscribe(9999)).resolves.toBeUndefined()
    const id = bus.subscribe('a', () => {})
    await bus.unsubscribe(id)
    await expect(bus.unsubscribe(id)).resolves.toBeUndefined()
  })

  it('unsubscribed callback no longer fires', async () => {
    const bus = new FakeBus()
    const received: string[] = []
    const id = bus.subscribe('a', (j) => received.push(j))
    await bus.unsubscribe(id)
    await bus.emit('a', '{}')
    expect(received).toEqual([])
  })

  it('subscriptionCount reflects registered subscribers', async () => {
    const bus = new FakeBus()
    await expect(bus.subscriptionCount()).resolves.toBe(0)
    const id = bus.subscribe('a', () => {})
    bus.subscribe('b', () => {})
    await expect(bus.subscriptionCount()).resolves.toBe(2)
    await bus.unsubscribe(id)
    await expect(bus.subscriptionCount()).resolves.toBe(1)
  })
})

// Wildcard parity fixtures — authoritative source is
// `packages/ream/crates/ream-events/src/router.rs::wildcard_matches`.
// Any divergence is a bug HERE.
describe('FakeBus > matchesWildcard parity with router.rs', () => {
  const bus = new FakeBus()
  const cases: ReadonlyArray<[string, string, boolean, string]> = [
    ['order.created', 'order.created', true, 'exact match'],
    ['order.*', 'order.created', true, 'single-segment leaf wildcard'],
    ['order.*', 'order.items.created', false, 'single * does NOT span multiple segments'],
    ['order.**', 'order.items.created', true, 'trailing ** spans multi-segment'],
    ['order.**', 'order.created', true, 'trailing ** still matches one segment'],
    ['order.**', 'payment.received', false, '** prefix mismatch'],
    ['*.created', 'order.created', true, 'leading single-segment wildcard'],
    [
      '*.created',
      'order.items.created',
      false,
      'single-* wildcard does not span segments even at leading',
    ],
    ['**', 'anything.at.all', true, 'global ** matches any depth'],
    ['**', 'anything', true, 'global ** matches single segment'],
    ['*', 'anything', true, 'lone * matches single segment'],
    ['*', 'anything.with.dots', false, 'lone * does not match dots'],
    ['order.created', 'order.deleted', false, 'literal mismatch'],
    // Edge fixtures — parity with router.rs at the boundary.
    ['', '', true, 'empty pattern matches empty event (length-eq, zero segments)'],
    ['', 'x', false, 'empty pattern rejects non-empty event'],
    ['x', '', false, 'non-empty pattern rejects empty event'],
    ['x.', 'x.', true, 'trailing-dot pattern matches the same trailing-dot event'],
    ['x.', 'x.y', false, 'trailing-dot pattern does not match a deeper event'],
    [
      'order.**.created',
      'order.x.created',
      false,
      'mid-** is treated as a literal segment (parity with Rust router; not a depth wildcard)',
    ],
    [
      '**.created',
      'order.created',
      false,
      'leading-** is treated as a literal segment (parity with Rust router)',
    ],
    ['*.*', 'a.b', true, 'two single-segment wildcards'],
    ['*.*', 'a', false, 'two single-segment wildcards reject 1-segment event'],
    ['*.*.*', 'a.b.c', true, 'three consecutive single-segment wildcards'],
    ['*', '', true, 'lone * matches empty event (parity with router.rs: no dot in name)'],
  ]
  for (const [pattern, name, expected, reason] of cases) {
    it(`matchesWildcard('${pattern}', '${name}') === ${expected} — ${reason}`, () => {
      expect(bus.matchesWildcard(pattern, name)).toBe(expected)
    })
  }
})

describe('FakeBus > getEmitted defensive clone', () => {
  it('returns a snapshot — mutating the result does not affect future reads', async () => {
    const bus = new FakeBus()
    await bus.emit('a', JSON.stringify({ n: 1 }))
    const first = bus.getEmitted()
    expect(first[0].parsedData).toEqual({ n: 1 })
    if (!isObject(first[0].parsedData)) throw new Error('parsedData not object')
    first[0].parsedData.n = 999
    const second = bus.getEmitted()
    expect(second[0].parsedData).toEqual({ n: 1 })
  })
})

describe('FakeBus > onRequest / request', () => {
  it('happy path — handler reply resolves the promise', async () => {
    const bus = new FakeBus()
    bus.onRequest('ping', (_data, reply) => reply('pong'))
    await expect(bus.request('ping', '{}')).resolves.toBe('pong')
  })

  it('captures the request alongside emits', async () => {
    const bus = new FakeBus()
    bus.onRequest('ping', (_d, r) => r('pong'))
    await bus.request('ping', JSON.stringify({ id: 'R-1' }))
    const captured = bus.getRequests()
    expect(captured).toHaveLength(1)
    expect(captured[0].kind).toBe('request')
    expect(captured[0].name).toBe('ping')
    expect(captured[0].parsedData).toEqual({ id: 'R-1' })
  })

  it('rejects when no handler is registered', async () => {
    const bus = new FakeBus()
    await expect(bus.request('missing', '{}')).rejects.toThrow(
      /no request handler registered for "missing"/,
    )
  })

  it('rejects on duplicate onRequest for the same name', () => {
    const bus = new FakeBus()
    bus.onRequest('ping', (_d, r) => r('a'))
    expect(() => bus.onRequest('ping', (_d, r) => r('b'))).toThrow(/already registered/)
  })

  it('rejects after the timeout if the handler never replies', async () => {
    vi.useFakeTimers()
    try {
      const bus = new FakeBus()
      bus.onRequest('slow', () => {
        /* never reply */
      })
      const promise = bus.request('slow', '{}', 100)
      vi.advanceTimersByTime(101)
      await expect(promise).rejects.toThrow(/did not reply within 100ms/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('handler throw rejects the request without leaking the timeout', async () => {
    const bus = new FakeBus()
    bus.onRequest('boom', () => {
      throw new Error('kaboom')
    })
    await expect(bus.request('boom', '{}', 10_000)).rejects.toThrow(/kaboom/)
  })

  it('async handler rejection is surfaced as request rejection (no timeout wait)', async () => {
    const bus = new FakeBus()
    bus.onRequest('boom-async', async () => {
      throw new Error('async-boom')
    })
    await expect(bus.request('boom-async', '{}', 10_000)).rejects.toThrow(/async-boom/)
  })

  it('handler that throws AFTER reply logs via console.error and does not affect resolution', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bus = new FakeBus()
    bus.onRequest('post-reply-throw', (_d, reply) => {
      reply('ok')
      throw new Error('post-condition failed')
    })
    await expect(bus.request('post-reply-throw', '{}')).resolves.toBe('ok')
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe('FakeBus > assertion helpers', () => {
  let bus: FakeBus
  beforeEach(() => {
    bus = new FakeBus()
  })

  it('assertEmitted passes when an emit matches the name', async () => {
    await bus.emit('order.created', '{}')
    expect(() => bus.assertEmitted('order.created')).not.toThrow()
  })

  it('assertEmitted accepts wildcard names', async () => {
    await bus.emit('order.created', '{}')
    expect(() => bus.assertEmitted('order.*')).not.toThrow()
  })

  it('assertEmitted with dataMatches predicate filters by payload', async () => {
    await bus.emit('order.created', JSON.stringify({ id: 'O-1' }))
    await bus.emit('order.created', JSON.stringify({ id: 'O-2' }))
    expect(() =>
      bus.assertEmitted('order.created', {
        dataMatches: (d) => isObject(d) && d.id === 'O-2',
      }),
    ).not.toThrow()
  })

  it('assertEmitted function predicate receives the CapturedEmit', async () => {
    await bus.emit('order.created', JSON.stringify({ id: 'O-9', correlationId: 'trace-9' }))
    expect(() =>
      bus.assertEmitted('order.created', (e) => e.correlationId === 'trace-9'),
    ).not.toThrow()
  })

  it('assertEmitted failure message contains the captured state', async () => {
    await bus.emit('payment.received', JSON.stringify({ amount: 42 }))
    expect(() => bus.assertEmitted('order.created')).toThrow(/payment\.received/)
    expect(() => bus.assertEmitted('order.created')).toThrow(/Captured \(1\)/)
  })

  it('assertNotEmitted throws when a match exists', async () => {
    await bus.emit('order.created', '{}')
    expect(() => bus.assertNotEmitted('order.created')).toThrow(
      /at least one captured emit matches/,
    )
  })

  it('assertNotEmitted passes when nothing matches', () => {
    expect(() => bus.assertNotEmitted('order.created')).not.toThrow()
  })

  it('predicate.correlationId / causationId narrow the match', async () => {
    await bus.emit('order.created', JSON.stringify({ correlationId: 'trace-a' }))
    await bus.emit(
      'order.created',
      JSON.stringify({ correlationId: 'trace-b', causationId: 'p-1' }),
    )
    expect(() => bus.assertEmitted('order.created', { correlationId: 'trace-a' })).not.toThrow()
    expect(() => bus.assertEmitted('order.created', { causationId: 'p-1' })).not.toThrow()
    expect(() => bus.assertEmitted('order.created', { correlationId: 'trace-zzz' })).toThrow(
      /FakeBus\.assertEmitted/,
    )
  })
})

describe('FakeBus > reset', () => {
  it('clears emits, requests, subscribers, handlers, and resets sub-id counter', async () => {
    const bus = new FakeBus()
    bus.subscribe('a', () => {})
    bus.onRequest('ping', (_d, r) => r('pong'))
    await bus.emit('a', '{}')
    await bus.request('ping', '{}')
    bus.reset()
    expect(bus.getEmitted()).toEqual([])
    expect(bus.getRequests()).toEqual([])
    await expect(bus.subscriptionCount()).resolves.toBe(0)
    // Re-registering the same request handler post-reset must succeed.
    expect(() => bus.onRequest('ping', (_d, r) => r('again'))).not.toThrow()
    // Subscription IDs restart at 1.
    expect(bus.subscribe('z', () => {})).toBe(1)
  })
})

describe('FakeBus > cross-contract: works with the existing event-bus/helix helpers', () => {
  it('collect() observing a FakeBus receives emit envelopes', async () => {
    const { collect, assertEmitted } = await import('../../../src/events/helix/helpers.js')
    const bus = new FakeBus()
    const { events } = collect(bus, 'order.*')
    await bus.emit('order.created', JSON.stringify({ id: 'O-1', correlationId: 'c-1' }))
    expect(events).toHaveLength(1)
    expect(events[0].name).toBe('order.created')
    expect(events[0].correlationId).toBe('c-1')
    expect(() => assertEmitted(events, 'order.created')).not.toThrow()
  })
})

// Cloning fallback path — defends the structuredClone-fail branch.
describe('FakeBus > clone fallback', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('falls back to JSON round-trip when structuredClone throws', async () => {
    const bus = new FakeBus()
    await bus.emit('evt', '{}')
    const realClone = globalThis.structuredClone
    const throwingClone: typeof structuredClone = () => {
      throw new Error('simulated non-cloneable')
    }
    globalThis.structuredClone = throwingClone
    try {
      const cloned = bus.getEmitted()
      expect(cloned).toHaveLength(1)
      expect(cloned[0].name).toBe('evt')
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      globalThis.structuredClone = realClone
    }
  })

  it('structuredClone fail + parsedData undefined yields a clone with parsedData undefined', async () => {
    // Non-JSON payload → parsedData undefined. If structuredClone also
    // throws, cloneViaJson(undefined) throws inside (`JSON.parse(undefined)`),
    // is caught, and returns undefined. Locks the accidental correctness.
    const bus = new FakeBus()
    await bus.emit('raw', 'not-json')
    const realClone = globalThis.structuredClone
    const throwingClone: typeof structuredClone = () => {
      throw new Error('simulated non-cloneable')
    }
    globalThis.structuredClone = throwingClone
    try {
      const cloned = bus.getEmitted()
      expect(cloned).toHaveLength(1)
      expect(cloned[0].name).toBe('raw')
      expect(cloned[0].data).toBe('not-json')
      expect(cloned[0].parsedData).toBeUndefined()
    } finally {
      globalThis.structuredClone = realClone
    }
  })
})
