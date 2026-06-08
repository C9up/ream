/**
 * SseStream close-idempotency regression. Both `end()` (server-side)
 * and the backend `onStreamDisconnect` signal funnel into the close
 * listeners. When BOTH fire (server end() followed by the client-drop
 * signal, or vice-versa), each registered `onClose` cleanup must run
 * exactly once — not be replayed.
 */
import { describe, expect, it } from 'vitest'
import { SseStream } from '../../src/http/SseStream.js'

/** Minimal in-memory backend that lets the test trigger disconnect. */
function makeBackend() {
  let disconnect: (() => void) | undefined
  const backend = {
    registerStream: async () => true,
    writeStream: async () => true,
    closeStream: async () => true,
    onStreamDisconnect: (_id: string, cb: () => void) => {
      disconnect = cb
    },
  }
  return {
    backend,
    fireDisconnect: () => disconnect?.(),
  }
}

describe('SseStream > onClose idempotency', () => {
  it('runs each onClose listener once when end() is followed by a backend disconnect', async () => {
    const { backend, fireDisconnect } = makeBackend()
    // pingInterval 0 so no timer leaks across the test.
    const stream = new SseStream('s1', backend, { pingInterval: 0 })

    let closes = 0
    stream.onClose(() => {
      closes += 1
    })

    await stream.end()
    expect(closes).toBe(1)

    // Backend now signals the client dropped — listeners must NOT replay.
    fireDisconnect()
    expect(closes).toBe(1)
  })

  it('runs each onClose listener once when a backend disconnect is followed by end()', async () => {
    const { backend, fireDisconnect } = makeBackend()
    const stream = new SseStream('s2', backend, { pingInterval: 0 })

    let closes = 0
    stream.onClose(() => {
      closes += 1
    })

    fireDisconnect()
    expect(closes).toBe(1)

    // A late server-side end() must be a no-op for the listeners.
    await stream.end()
    expect(closes).toBe(1)
  })

  it('a single backend disconnect fires every listener exactly once', async () => {
    const { backend, fireDisconnect } = makeBackend()
    const stream = new SseStream('s3', backend, { pingInterval: 0 })

    const order: string[] = []
    stream.onClose(() => order.push('a'))
    stream.onClose(() => order.push('b'))

    fireDisconnect()
    fireDisconnect() // second signal must not replay
    expect(order).toEqual(['a', 'b'])
  })

  it('onClose registered AFTER close still runs immediately (once)', async () => {
    const { backend } = makeBackend()
    const stream = new SseStream('s4', backend, { pingInterval: 0 })
    await stream.end()

    let late = 0
    stream.onClose(() => {
      late += 1
    })
    expect(late).toBe(1)
  })
})

describe('SseStream > frame injection guard', () => {
  function makeCapturingBackend() {
    const writes: string[] = []
    const backend = {
      registerStream: async () => true,
      writeStream: async (_id: string, chunk: string) => {
        writes.push(chunk)
        return true
      },
      closeStream: async () => true,
      onStreamDisconnect: () => {},
    }
    return { backend, writes }
  }

  it('strips CR/LF from the event name so it cannot splice extra frames', async () => {
    const { backend, writes } = makeCapturingBackend()
    const stream = new SseStream('s', backend, { pingInterval: 0 })
    // A hostile event name trying to open a second event + inject data.
    await stream.send('evil\nevent: spoof\ndata: injected', { ok: true })
    const frame = writes.at(-1) ?? ''
    // Exactly ONE `event:` line — the newline-spliced second one is gone
    // (the injected text survives only inert, on the single event line).
    expect(frame.match(/^event: /gm)?.length).toBe(1)
    // No injected `data:` LINE (the real payload line is `data: {"ok":true}`).
    const dataLines = (frame.match(/^data: .*/gm) ?? []).filter((l) => !l.includes('{"ok":true}'))
    expect(dataLines).toEqual([])
  })

  it('strips CR/LF from the event id', async () => {
    const { backend, writes } = makeCapturingBackend()
    const stream = new SseStream('s', backend, { pingInterval: 0 })
    await stream.send('tick', { n: 1 }, 'id\nevent: spoof')
    const frame = writes.at(-1) ?? ''
    expect(frame.match(/^id: /gm)?.length).toBe(1)
    // The only `event:` line is the legit "tick" — no spliced second one.
    expect(frame.match(/^event: .*/gm)).toEqual(['event: tick'])
  })

  it('keeps legitimate multi-line data intact (each line re-prefixed)', async () => {
    const { backend, writes } = makeCapturingBackend()
    const stream = new SseStream('s', backend, { pingInterval: 0 })
    await stream.send('msg', 'line1\nline2')
    const frame = writes.at(-1) ?? ''
    expect(frame).toContain('data: line1')
    expect(frame).toContain('data: line2')
  })
})

describe('Response.abortStream — handler threw after sse()', () => {
  it('closes the backend slot and drops the streamId so no dead stream is serialized', async () => {
    const { Response } = await import('../../src/http/Response.js')
    const closed: string[] = []
    const backend = {
      registerStream: async () => true,
      writeStream: async () => true,
      closeStream: async (id: string) => {
        closed.push(id)
        return true
      },
      onStreamDisconnect: () => {},
    }
    const res = new Response()
    res.setStreamBackend(backend)
    const stream = await res.sse({ pingInterval: 0 })
    expect(res.getStreamId()).toBe(stream.id)

    // Simulate the kernel's catch path after a post-sse() throw.
    await res.abortStream()

    // Backend slot released + id cleared so serializeResponse emits a
    // plain error response, not a stream.
    expect(closed).toContain(stream.id)
    expect(res.getStreamId()).toBeUndefined()
    // And the response can now carry an error body (finished flag reset).
    res.status(500).json({ error: 'boom' })
    expect(res.getBody()).toContain('boom')
  })

  it('abortStream is a no-op when no stream was opened', async () => {
    const { Response } = await import('../../src/http/Response.js')
    const res = new Response()
    await expect(res.abortStream()).resolves.toBeUndefined()
    expect(res.getStreamId()).toBeUndefined()
  })
})

describe('SseStream > ping self-heals on missed disconnect', () => {
  it('closes the stream when a keepalive write returns false (client gone, signal missed)', async () => {
    let writeReturns = true
    const backend = {
      registerStream: async () => true,
      // First the retry frame succeeds; later keepalives report the
      // client is gone (false) without ever firing onStreamDisconnect —
      // the race the fix guards against.
      writeStream: async () => writeReturns,
      closeStream: async () => true,
      onStreamDisconnect: () => {
        /* deliberately never fires — simulates the missed signal */
      },
    }
    const stream = new SseStream('s', backend, { pingInterval: 5 })
    let closed = 0
    stream.onClose(() => {
      closed += 1
    })
    expect(stream.isOpen()).toBe(true)

    // Client drops; next keepalive write returns false.
    writeReturns = false
    // Wait for a ping tick + its async .then to settle.
    await new Promise((r) => setTimeout(r, 20))

    expect(stream.isOpen()).toBe(false)
    expect(closed).toBe(1)
  })
})
