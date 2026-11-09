import 'reflect-metadata'
import { connect } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import BodyParserMiddleware from '../../../src/bodyparser/BodyParserMiddleware.js'
import type { HttpContext } from '../../../src/http/HttpContext.js'
import { Ignitor } from '../../../src/index.js'
import { HyperServer } from './loader.js'

/**
 * An over-limit body over the real stack — native server, kernel, router, body
 * parser, exception handler. The native server keeps none of it and hands the
 * request over without a body; routing answers first, and the 413 is raised
 * by whatever reaches for the body, then rendered by the exception handler.
 */
const networkAllowed = process.env.REAM_SKIP_NETWORK_TESTS !== '1'
const describeIfNetwork = networkAllowed ? describe : describe.skip

const parseBody = (ctx: HttpContext, next: () => Promise<void>) =>
  new BodyParserMiddleware({ json: { limit: '1kb' }, raw: { limit: '1kb' } }).handle(ctx, next)

/** Send raw bytes; resolve with the response once complete, closed, or after `waitMs`. */
function rawExchange(port: number, chunks: string[], waitMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    let received = ''
    const finish = () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(received)
    }
    const timer = setTimeout(finish, waitMs)
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1')
      const [head, body = ''] = received.split('\r\n\r\n')
      const length = /content-length:\s*(\d+)/i.exec(head ?? '')?.[1]
      if (length !== undefined && body.length >= Number(length)) finish()
    })
    socket.on('close', finish)
    socket.on('error', () => {})
    for (const chunk of chunks) socket.write(chunk)
  })
}

describeIfNetwork('over-limit body > routing first, 413 from the body parser', () => {
  let ignitor: Ignitor
  let port = 0
  let bodyReads = 0

  beforeAll(async () => {
    ignitor = await new Ignitor({
      port: 0,
      gracefulShutdown: false,
      serverFactory: (p, host) => new HyperServer(p, host),
    })
      .configure('bodyparser', { json: { limit: '1kb' }, raw: { limit: '1kb' } })
      .routes((router) => {
        router
          .post('/parsed', ({ request, response }) => {
            bodyReads += 1
            response.json({ body: request.body() })
          })
          .use(parseBody)
        router.post('/ignores-body', ({ response }) => response.json({ ok: true }))
        router.post('/reads-raw', ({ request, response }) =>
          response.json({ length: request.raw().length }),
        )
      })
      .httpServer()
      .start()
    port = await ignitor.port()
  })

  afterAll(async () => {
    await ignitor.stop()
  })

  const big = JSON.stringify({ note: 'x'.repeat(4096) })

  it('answers 404 for an unknown route before any 413', async () => {
    const response = await rawExchange(port, [
      'POST /nowhere HTTP/1.1\r\nHost: x\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: 41943040\r\n\r\n',
    ])
    expect(response).toMatch(/^HTTP\/1\.1 404/)
  })

  it('renders the 413 through the exception handler as JSON', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/parsed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: big,
    })
    expect(res.status).toBe(413)
    expect(JSON.stringify(await res.json())).toContain('request entity too large')
    expect(bodyReads).toBe(0)
  })

  it('renders the 413 through the exception handler as HTML', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/parsed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/html' },
      body: big,
    })
    expect(res.status).toBe(413)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    expect(await res.text()).toContain('<h1>413</h1>')
  })

  it('lets a route that never reads the body answer normally', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/ignores-body`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: big,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('refuses to hand a route without the body parser an empty body as if complete', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/reads-raw`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', accept: 'application/json' },
      body: 'y'.repeat(4096),
    })
    expect(res.status).toBe(413)
  })

  it('refuses a chunked body once it crosses the limit', async () => {
    const response = await rawExchange(port, [
      'POST /parsed HTTP/1.1\r\nHost: x\r\nAccept: application/json\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n',
      `800\r\n{"note":"${'x'.repeat(2037)}"}\r\n`,
    ])
    expect(response).toMatch(/^HTTP\/1\.1 413/)
    expect(response).toContain('E_REQUEST_ENTITY_TOO_LARGE')
  })

  it('answers an Expect: 100-continue client without inviting the body', async () => {
    const response = await rawExchange(port, [
      'POST /parsed HTTP/1.1\r\nHost: x\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: 41943040\r\nExpect: 100-continue\r\n\r\n',
    ])
    expect(response).not.toContain('100 Continue')
    expect(response).toMatch(/^HTTP\/1\.1 413/)
  })

  it('still parses a body under the limit', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/parsed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'small' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ body: { note: 'small' } })
  })
})
