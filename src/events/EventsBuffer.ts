/**
 * What {@link import('./Emitter.js').Emitter.fake} hands back: the events that
 * were emitted while faking, and the assertions to check them.
 *
 * AdonisJS parity (`@adonisjs/events` `EventsBuffer`). A faked event never
 * reaches its listeners nor the bus — it lands here instead, so a test asserts
 * on what the code decided to announce without running the reaction to it.
 */

import { AssertionError } from 'node:assert'

/** An event name: a string, or the class of a class-based event. */
export type BufferedEventName = string | (new (...args: never[]) => unknown)

/** One captured emission. */
export interface BufferedEvent<Data = unknown> {
  event: BufferedEventName
  data: Data
}

/** Narrows an assertion to one emission among several of the same event. */
export type EventFinder<Data = unknown> = (event: BufferedEvent<Data>) => boolean

export class EventsBuffer {
  readonly #events: BufferedEvent[] = []
  readonly #restore: () => void

  constructor(restore: () => void) {
    this.#restore = restore
  }

  /** Record an emission. Called by the emitter while faking. */
  add(event: BufferedEventName, data: unknown): void {
    this.#events.push({ event, data })
  }

  /** Every captured emission, in the order they happened. */
  all(): BufferedEvent[] {
    return [...this.#events]
  }

  /** How many emissions were captured. */
  size(): number {
    return this.#events.length
  }

  /** Was this event emitted (optionally, one matching `finder`)? */
  exists<Data = unknown>(event: BufferedEventName, finder?: EventFinder<Data>): boolean {
    return this.find(event, finder) !== null
  }

  /** The first matching emission, or `null`. */
  find<Data = unknown>(
    event: BufferedEventName,
    finder?: EventFinder<Data>,
  ): BufferedEvent<Data> | null {
    for (const buffered of this.#events) {
      if (buffered.event !== event) continue
      const typed = buffered as BufferedEvent<Data>
      if (finder === undefined || finder(typed)) return typed
    }
    return null
  }

  /** Fail unless the event was emitted. */
  assertEmitted<Data = unknown>(event: BufferedEventName, finder?: EventFinder<Data>): void {
    if (this.exists(event, finder)) return
    throw new AssertionError({
      message: `Expected "${nameOf(event)}" event to be emitted`,
      operator: 'assertEmitted',
      expected: nameOf(event),
      actual: this.#emittedNames(),
    })
  }

  /** Fail unless the event was emitted exactly `count` times. */
  assertEmittedCount(event: BufferedEventName, count: number): void {
    const actual = this.#events.filter((buffered) => buffered.event === event).length
    if (actual === count) return
    throw new AssertionError({
      message: `Expected "${nameOf(event)}" event to be emitted "${count}" times, instead it was emitted "${actual}" times`,
      operator: 'assertEmittedCount',
      expected: count,
      actual,
    })
  }

  /** Fail if the event was emitted. */
  assertNotEmitted<Data = unknown>(event: BufferedEventName, finder?: EventFinder<Data>): void {
    if (!this.exists(event, finder)) return
    throw new AssertionError({
      message: `Unexpected "${nameOf(event)}" event was emitted`,
      operator: 'assertNotEmitted',
      expected: [],
      actual: this.#emittedNames(),
    })
  }

  /** Fail if anything at all was emitted. */
  assertNoneEmitted(): void {
    if (this.#events.length === 0) return
    throw new AssertionError({
      message: `Expected zero events to be emitted, instead received "${this.#events.length}" events`,
      operator: 'assertNoneEmitted',
      expected: 0,
      actual: this.#events.length,
    })
  }

  /** Drop the captured events, keeping the fake in place. */
  flush(): void {
    this.#events.length = 0
  }

  /**
   * Restore the emitter when the buffer leaves a `using` block, so a test that
   * throws mid-way cannot leave events faked for the next one.
   */
  [Symbol.dispose](): void {
    this.#restore()
  }

  #emittedNames(): string[] {
    return this.#events.map((buffered) => nameOf(buffered.event))
  }
}

/** A readable name for an event, whether it is a string or a class. */
function nameOf(event: BufferedEventName): string {
  return typeof event === 'string' ? event : event.name
}
