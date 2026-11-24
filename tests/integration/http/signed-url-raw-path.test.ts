/**
 * `request.hasValidSignature()` checks the path the router matched, byte for
 * byte. A raw request line whose path a URL parser would normalise to the
 * signed one (`\..\`, `%2e%2e`, a leading `//host`) must not verify.
 */
import { createConnection } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHyperServerFactory } from '../../../src/bootstrap/hyper-server.js'
import { Ignitor } from '../../../src/index.js'

/** One raw request line over TCP (fetch would normalise the path itself). */
function rawGet(port: number, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(port, '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: app.test\r\nConnection: close\r\n\r\n`)
    })
    let data = ''
    socket.on('data', (chunk) => {
      data += chunk.toString()
    })
    socket.on('end', () => {
      const status = Number.parseInt(data.split(' ')[1] ?? '0', 10)
      const body = data.slice(data.indexOf('\r\n\r\n') + 4)
      resolve({ status, body: body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1) })
    })
    socket.on('error', reject)
  })
}

describe('signed URLs through the native HTTP server', () => {
  let ignitor: Ignitor
  let port = 0
  const previousKey = process.env.APP_KEY

  beforeAll(async () => {
    process.env.APP_KEY = 'k'.repeat(32)
    ignitor = await new Ignitor({
      port: 0,
      gracefulShutdown: false,
      serverFactory: createHyperServerFactory(),
    })
      .routes((router) => {
        router
          .get('/users/:id/verify-email', ({ request, response, params }) =>
            response.json({ valid: request.hasValidSignature(), id: params.id }),
          )
          .as('verify')
        router.get('/t/:tenant/users/:id/verify-email/*', ({ request, response, params }) =>
          response.json({ valid: request.hasValidSignature(), id: params.id }),
        )
        router.get('/*', ({ request, response }) =>
          response.json({ valid: request.hasValidSignature() }),
        )
      })
      .httpServer()
      .start()
    port = await ignitor.port()
  })

  afterAll(async () => {
    await ignitor.stop()
    if (previousKey === undefined) delete process.env.APP_KEY
    else process.env.APP_KEY = previousKey
  })

  function linkForUser5(): { link: string; query: string } {
    const link = ignitor.getRouter().makeSignedUrl('verify', { id: '5' }, { expiresIn: '1h' })
    return { link, query: link.slice(link.indexOf('?') + 1) }
  }

  async function read(target: string): Promise<{ valid: boolean; id?: string }> {
    return JSON.parse((await rawGet(port, target)).body)
  }

  it('the mailed link verifies, a tampered id does not', async () => {
    const { link, query } = linkForUser5()
    expect(await read(link)).toEqual({ valid: true, id: '5' })
    expect(await read(`/users/7/verify-email?${query}`)).toEqual({ valid: false, id: '7' })
  })

  it('backslash dot-segments do not verify with the signature of /users/5', async () => {
    const { query } = linkForUser5()
    expect(await read(`/users/7\\..\\5/verify-email?${query}`)).toEqual({
      valid: false,
      id: '7\\..\\5',
    })
  })

  it('percent-encoded dot-segments matched on another route do not verify', async () => {
    const { query } = linkForUser5()
    const target = `/t/acme/users/42/verify-email/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/users/5/verify-email?${query}`
    expect(await read(target)).toEqual({ valid: false, id: '42' })
  })

  it('a leading //host does not verify', async () => {
    const { query } = linkForUser5()
    expect((await read(`//anything/users/5/verify-email?${query}`)).valid).toBe(false)
  })
})
