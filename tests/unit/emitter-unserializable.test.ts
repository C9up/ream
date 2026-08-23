/**
 * `JSON.stringify` was evaluated as an argument to `bus.emit(...)`, so a cyclic
 * or BigInt payload threw synchronously — straight past the `.catch` — and
 * crashed the caller of an emit that is documented as fire-and-forget.
 */
import { describe, expect, it, vi } from 'vitest'
import { Emitter } from '../../src/events/Emitter.js'

function emitter() {
  const bus = {
    emit: vi.fn(async () => {}),
    on: vi.fn(),
    request: vi.fn(async () => ''),
  }
  return { emitter: new Emitter(bus as never), bus }
}

describe('ream > emitting an unserializable payload', () => {
  it('does not throw at the call site on a cycle', async () => {
    const { emitter: e } = emitter()
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic.self = cyclic
    // The rejection must not escape either: `emit` reports and resolves.
    await expect(e.emit('thing:happened', cyclic)).resolves.toBeUndefined()
  })

  it('does not reach the bus with something it cannot carry', async () => {
    const { emitter: e, bus } = emitter()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    await e.emit('thing:happened', cyclic)
    expect(bus.emit).not.toHaveBeenCalled()
  })

  it('still emits an ordinary payload', async () => {
    const { emitter: e, bus } = emitter()
    await e.emit('thing:happened', { id: 1 })
    expect(bus.emit).toHaveBeenCalledTimes(1)
  })
})
