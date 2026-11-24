/**
 * A cookie NAME is compared exactly as the browser sent it; only the value is
 * percent-decoded. A sibling subdomain that plants `%73ession` (or
 * `__%48ost-sid`, a name the browser does not treat as `__Host-` prefixed)
 * must never be read as `session` / `__Host-sid`, in either header order.
 */
import 'reflect-metadata'
import { connect } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHyperServerFactory } from '../../../src/bootstrap/hyper-server.js'
import { Ignitor } from '../../../src/index.js'

/** One raw HTTP/1.1 exchange: the Cookie header is exactly what is written here. */
function rawGet(
  port: number,
  path: string,
  cookie?: string,
): Promise<{ head: string; body: string }> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    let received = ''
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1')
    })
    socket.on('close', () => {
      const cut = received.indexOf('\r\n\r\n')
      resolve({ head: received.slice(0, cut), body: received.slice(cut + 4) })
    })
    socket.on('error', () => {})
    const cookieLine = cookie === undefined ? '' : `Cookie: ${cookie}\r\n`
    socket.write(`GET ${path} HTTP/1.1\r\nHost: app.test\r\nConnection: close\r\n${cookieLine}\r\n`)
  })
}

describe('cookie names are not percent-decoded on read', () => {
  let ignitor: Ignitor
  let port = 0
  const previousKey = process.env.APP_KEY

  beforeAll(async () => {
    process.env.APP_KEY = 'a-test-app-key-of-32-bytes-long!!'
    ignitor = await new Ignitor({
      port: 0,
      gracefulShutdown: false,
      serverFactory: createHyperServerFactory(),
    })
      .routes((router) => {
        router.get('/mint/:who', ({ request, response }) => {
          response.cookie('session', `session-of-${request.param('who')}`)
          response.send('ok')
        })
        router.get('/read', ({ request, response }) =>
          response.json({
            signed: request.cookie('session'),
            plain: request.plainCookie('session', undefined, { encoded: false }),
            hostPrefixed: request.plainCookie('__Host-sid', undefined, { encoded: false }),
            cookies: request.cookies(),
          }),
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

  async function mint(who: string): Promise<string> {
    const { head } = await rawGet(port, `/mint/${who}`)
    const line = head.split('\r\n').find((l) => l.toLowerCase().startsWith('set-cookie: session='))
    if (line === undefined) throw new Error(`no session cookie in: ${head}`)
    return line.slice('set-cookie: session='.length).split(';')[0] ?? ''
  }

  async function read(cookie: string): Promise<{
    signed: string | null
    plain: string | null
    hostPrefixed: string | null
    cookies: Record<string, string>
  }> {
    return JSON.parse((await rawGet(port, '/read', cookie)).body)
  }

  it('an encoded twin stays a cookie of its own, whether it comes after or before the real one', async () => {
    const after = await read('session=legit; %73ession=tossed')
    const before = await read('%73ession=tossed; session=legit')
    expect(after.plain).toBe('legit')
    expect(before.plain).toBe('legit')
    expect(after.cookies).toEqual({ session: 'legit', '%73ession': 'tossed' })
  })

  it('of two byte-identical names the first still wins', async () => {
    expect((await read('session=legit; session=tossed')).plain).toBe('legit')
  })

  it("an attacker's validly signed session sent as %73ession is not the one request.cookie() verifies", async () => {
    const victim = await mint('victim')
    const attacker = await mint('attacker')
    expect((await read(`session=${victim}; %73ession=${attacker}`)).signed).toBe(
      'session-of-victim',
    )
    expect((await read(`%73ession=${attacker}; session=${victim}`)).signed).toBe(
      'session-of-victim',
    )
    expect((await read(`%73ession=${attacker}`)).signed).toBeNull()
  })

  it('__%48ost-sid is never read as __Host-sid', async () => {
    expect((await read('__%48ost-sid=attacker')).hostPrefixed).toBeNull()
    expect((await read('__Host-sid=legit; __%48ost-sid=attacker')).hostPrefixed).toBe('legit')
    expect((await read('__%48ost-sid=attacker; __Host-sid=legit')).hostPrefixed).toBe('legit')
  })

  it('the VALUE is still percent-decoded', async () => {
    expect((await read('session=a%20b%3Bc')).plain).toBe('a b;c')
  })
})
