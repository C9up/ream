import { describe, expect, it } from 'vitest'
import type { GrpcCall } from '../../src/index.js'
import { cancellableGrpc, type NativeGrpcCall } from '../../src/server/nativeGrpc.js'

function nativeCall(id: number): NativeGrpcCall {
  return { id, path: '/t.Svc/M', metadata: {}, message: new Uint8Array(), ip: '127.0.0.1' }
}

/** A handler that waits until released, recording the signal of each call. */
function waiting() {
  const signals = new Map<string, AbortSignal>()
  const releases: (() => void)[] = []
  const handler = (call: GrpcCall) => {
    signals.set(call.path, call.signal)
    return new Promise<{ message: Uint8Array }>((resolve) => {
      releases.push(() => resolve({ message: new Uint8Array() }))
    })
  }
  const releaseAll = () => {
    for (const release of releases) release()
  }
  return { handler, signals, releaseAll }
}

describe('cancellableGrpc', () => {
  it('hands the call over without its id, with a signal', async () => {
    const seen: GrpcCall[] = []
    const calls = cancellableGrpc(async (call) => {
      seen.push(call)
      return { message: new Uint8Array([1]) }
    })
    expect(await calls.onCall(nativeCall(1))).toEqual({ message: new Uint8Array([1]) })
    expect(seen[0]).not.toHaveProperty('id')
    expect(seen[0]?.signal.aborted).toBe(false)
  })

  it('aborts the signal of a running call the native server reports cancelled', async () => {
    let signal: AbortSignal | undefined
    const calls = cancellableGrpc((call) => {
      signal = call.signal
      return new Promise((resolve) => {
        call.signal.addEventListener('abort', () => resolve({ code: 1, details: 'Cancelled' }))
      })
    })
    const reply = calls.onCall(nativeCall(1))
    calls.onCancel(1)
    expect(await reply).toEqual({ code: 1, details: 'Cancelled' })
    expect(signal?.aborted).toBe(true)
  })

  it('keeps a cancel that arrives before its call, and aborts the call on arrival', async () => {
    const { handler, signals, releaseAll } = waiting()
    const calls = cancellableGrpc(handler)
    calls.onCancel(1)
    const pending = calls.onCall(nativeCall(1))
    expect(signals.get('/t.Svc/M')?.aborted).toBe(true)
    releaseAll()
    await pending
  })

  it('drops a cancel for a call that already ended, so a later call is not aborted', async () => {
    const calls = cancellableGrpc(async (call) => {
      expect(call.signal.aborted).toBe(false)
      return { message: new Uint8Array() }
    })
    await calls.onCall(nativeCall(1))
    calls.onCancel(1)
    await calls.onCall(nativeCall(2))
  })

  it('forgets an early cancel once a later call has arrived', async () => {
    const aborted: boolean[] = []
    const calls = cancellableGrpc(async (call) => {
      aborted.push(call.signal.aborted)
      return { message: new Uint8Array() }
    })
    // Call 3 never reaches JS: call 4 neither inherits its cancel, nor does
    // that cancel stay kept forever.
    calls.onCancel(3)
    await calls.onCall(nativeCall(4))
    calls.onCancel(5)
    await calls.onCall(nativeCall(6))
    expect(aborted).toEqual([false, false])
  })
})
