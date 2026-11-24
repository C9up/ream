/**
 * Ending a streamed response from the server ends the HTTP response: the
 * client reads the end of the body. The disconnect watcher an SSE stream
 * installs used to keep the body channel open, so after `end()` the client
 * kept waiting, mute, until it left by itself.
 */
import { connect } from 'node:net'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHyperServerFactory } from '../../../src/bootstrap/hyper-server.js'
import { Ignitor } from '../../../src/index.js'

/** A raw HTTP/1.1 GET; resolves with what was read once the server ends the response. */
function readToEnd(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let received = ''
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1')
      // Chunked encoding: the last chunk marks the end of the body.
      if (received.endsWith('0\r\n\r\n')) {
        socket.destroy()
        resolve(received)
      }
    })
    socket.on('end', () => resolve(received))
    socket.on('error', reject)
    // Keep-alive: the only thing that can end the body is the server.
    socket.write(`GET ${path} HTTP/1.1\r\nHost: app.test\r\n\r\n`)
  })
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`not ended within ${ms} ms`)), ms),
    ),
  ])
}

describe('a streamed response ended by the server ends on the wire', () => {
  let ignitor: Ignitor
  let port = 0
  const closed: string[] = []

  beforeAll(async () => {
    ignitor = await new Ignitor({
      port: 0,
      gracefulShutdown: false,
      serverFactory: createHyperServerFactory(),
    })
      .routes((router) => {
        router.get('/sse', async ({ response }) => {
          const stream = await response.sse()
          stream.onClose(() => closed.push('sse'))
          stream.send('hello', { n: 1 })
          setTimeout(() => void stream.end(), 50)
        })
        router.get('/stream', ({ response }) => response.stream(Readable.from(['one ', 'two'])))
      })
      .httpServer()
      .start()
    port = await ignitor.port()
  })

  afterAll(async () => {
    await ignitor.stop()
  })

  it('SseStream.end(): the client reads the event, then the end of the body', async () => {
    const body = await within(readToEnd(port, '/sse'), 2000)
    expect(body).toContain('text/event-stream')
    expect(body).toContain('event: hello')
    expect(body.endsWith('0\r\n\r\n')).toBe(true)
    // `end()` runs the close listeners once the native close has returned,
    // which may be just after the client read the end.
    for (let i = 0; i < 50 && !closed.includes('sse'); i++)
      await new Promise((r) => setTimeout(r, 20))
    expect(closed).toContain('sse')
  })

  it('a streamed non-SSE body ends too', async () => {
    const body = await within(readToEnd(port, '/stream'), 2000)
    expect(body).toContain('one ')
    expect(body.endsWith('0\r\n\r\n')).toBe(true)
  })
})
