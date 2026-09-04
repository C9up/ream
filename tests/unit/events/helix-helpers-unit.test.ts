/**
 * Unit suite for the helix testing helpers — direct coverage with a tiny
 * `BusLike` stub instead of going through the napi binding. The existing
 * `tests/helix/helix-helpers.test.ts` suite uses the real EventBus, which
 * blanks v8 coverage on this file (the napi traversal hides the JS).
 */
import { describe, expect, it } from 'vitest'
import {
  assertEmitted,
  assertNotEmitted,
  type CollectedEvent,
  collect,
  fake,
  waitForChain,
  waitForEvent,
} from '../../../src/events/helix/helpers.js'
import { defined } from '../../__helpers__/defined.js'

type Subscriber = (eventJson: string) => void
function makeStubBus() {
  const subs: Array<{ pattern: string; cb: Subscriber }> = []
  const bus = {
    subscribe(pattern: string, cb: Subscriber): number {
      subs.push({ pattern, cb })
      return subs.length
    },
    deliver(envelope: object) {
      const json = JSON.stringify(envelope)
      for (const s of subs) s.cb(json)
    },
    deliverRaw(raw: string) {
      for (const s of subs) s.cb(raw)
    },
  }
  return bus
}

describe('events > helix > collect', () => {
  it('captures envelopes parsed from the bus subscriber callback', () => {
    const bus = makeStubBus()
    const { events, subId } = collect(bus, 'order.*')
    expect(subId).toBe(1)
    bus.deliver({ name: 'order.created', data: '{"id":"1"}' })
    bus.deliver({ name: 'order.paid', data: '{"id":"1"}' })
    expect(events).toHaveLength(2)
    expect(defined(events[0]).name).toBe('order.created')
  })

  it('stashes a parse-error stub when the payload is not JSON', () => {
    const bus = makeStubBus()
    const { events } = collect(bus, '*')
    bus.deliverRaw('not-json')
    expect(events).toHaveLength(1)
    expect(defined(events[0])._parseError).toBe(true)
    expect(defined(events[0])._raw).toBe('not-json')
  })
})

describe('events > helix > fake', () => {
  it('delegates to collect (same shape, no interception yet)', () => {
    const bus = makeStubBus()
    const { events } = fake(bus, '*')
    bus.deliver({ name: 'anything', data: '{}' })
    expect(events).toHaveLength(1)
  })
})

describe('events > helix > assertEmitted', () => {
  function ev(name: string, data?: unknown): CollectedEvent {
    return { name, data }
  }

  it('passes silently when the event is present (no payload check)', () => {
    assertEmitted([ev('order.created')], 'order.created')
  })

  it('throws when no event with that name was emitted', () => {
    expect(() => assertEmitted([ev('other')], 'order.created')).toThrow(/HELIX_ASSERT_EMITTED/)
  })

  it("throws with '(none)' marker when no events at all were collected", () => {
    expect(() => assertEmitted([], 'order.created')).toThrow(/none/)
  })

  it('passes when payload partially matches a string-encoded data field', () => {
    assertEmitted([ev('order.created', '{"id":"1","amount":50}')], 'order.created', {
      id: '1',
    })
  })

  it('passes when payload partially matches an object data field', () => {
    assertEmitted(
      [ev('order.created', { id: '1', amount: 50, nested: { ok: true } })],
      'order.created',
      { nested: { ok: true } },
    )
  })

  it('throws when the event is present but no payload matches', () => {
    expect(() =>
      assertEmitted([ev('order.created', { id: '2' })], 'order.created', {
        id: '1',
      }),
    ).toThrow(/no payload matched/)
  })
})

describe('events > helix > assertNotEmitted', () => {
  it('passes when no matching event exists', () => {
    assertNotEmitted([{ name: 'other', data: undefined }], 'order.created')
  })

  it('throws when the event was emitted at least once', () => {
    expect(() =>
      assertNotEmitted(
        [
          { name: 'order.created', data: undefined },
          { name: 'order.created', data: undefined },
        ],
        'order.created',
      ),
    ).toThrow(/2 time/)
  })
})

describe('events > helix > waitForEvent', () => {
  it('resolves immediately when the event already exists', async () => {
    const events: CollectedEvent[] = [{ name: 'ready', data: undefined }]
    await expect(waitForEvent(events, 'ready')).resolves.toMatchObject({
      name: 'ready',
    })
  })

  it('resolves once the event is appended asynchronously', async () => {
    const events: CollectedEvent[] = []
    const promise = waitForEvent(events, 'later', {
      interval: 5,
      timeout: 200,
    })
    setTimeout(() => events.push({ name: 'later', data: undefined }), 10)
    await expect(promise).resolves.toMatchObject({ name: 'later' })
  })

  it('rejects with HELIX_TIMEOUT when the event never appears', async () => {
    await expect(waitForEvent([], 'nope', { interval: 5, timeout: 30 })).rejects.toThrow(
      /HELIX_TIMEOUT/,
    )
  })

  it('honours a partial payload predicate on the matching event', async () => {
    const events: CollectedEvent[] = [
      { name: 'tick', data: { n: 1 } },
      { name: 'tick', data: { n: 2 } },
    ]
    const out = await waitForEvent(events, 'tick', { payload: { n: 2 } })
    expect((out.data as { n: number }).n).toBe(2)
  })
})

describe('events > helix > waitForChain', () => {
  it('resolves when every name in the chain is present for the correlation ID', async () => {
    const events: CollectedEvent[] = [
      { name: 'a', correlationId: 'c1', data: undefined },
      { name: 'b', correlationId: 'c1', data: undefined },
      { name: 'c', correlationId: 'c1', data: undefined },
      // Different correlation ID — must be ignored.
      { name: 'b', correlationId: 'c2', data: undefined },
    ]
    const out = await waitForChain(events, 'c1', ['a', 'b', 'c'])
    expect(out.map((e) => e.name)).toEqual(['a', 'b', 'c'])
  })

  it('rejects when expectedNames is empty', async () => {
    await expect(waitForChain([], 'c1', [])).rejects.toThrow(/non-empty/)
  })

  it('rejects with HELIX_CHAIN_TIMEOUT when the chain is incomplete', async () => {
    const events: CollectedEvent[] = [{ name: 'a', correlationId: 'c1', data: undefined }]
    await expect(
      waitForChain(events, 'c1', ['a', 'b'], { interval: 5, timeout: 30 }),
    ).rejects.toThrow(/HELIX_CHAIN_TIMEOUT/)
  })
})
