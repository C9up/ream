/**
 * The JSON-RPC methods of a booted application over a WebSocket route, driven
 * by comet's own client and WebSocket transport against the native server.
 */
import { createRpcClient } from '@c9up/comet'
import { createWebSocketTransport, RpcTransportError } from '@c9up/comet/websocket'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHyperServerFactory } from '../../../src/bootstrap/hyper-server.js'
import { Ignitor } from '../../../src/index.js'
import type { MiddlewareFunction } from '../../../src/middleware/Pipeline.js'
import { RpcRouter } from '../../../src/rpc/RpcRouter.js'

const networkAllowed = process.env.REAM_SKIP_NETWORK_TESTS !== '1'
const describeIfNetwork = networkAllowed ? describe : describe.skip

/**
 * Stands in for an auth guard on the handshake: `?as=<id>:<role>` signs in,
 * anything else is refused before a socket exists. A browser cannot set a
 * header on a WebSocket, which is why a real app uses its session cookie.
 */
const signIn: MiddlewareFunction = async (ctx, next) => {
  const as: unknown = ctx.request.qs().as
  if (typeof as !== 'string') {
    ctx.response.status(401).json({ error: 'unauthenticated' })
    return
  }
  const [id = '', role = ''] = as.split(':')
  ctx.auth = { isAuthenticated: true, user: { id, roles: [role] } }
  await next()
}

describeIfNetwork('RpcRouter over router.ws() with comet', () => {
  let ignitor: Ignitor
  let base = ''
  const logged: unknown[] = []
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })

  beforeAll(async () => {
    const serverFactory = createHyperServerFactory()
    if (serverFactory === undefined)
      throw new Error('no prebuilt HyperServer binary for this platform')
    const rpc = new RpcRouter()
    rpc.method('echo', (_ctx, params) => params)
    rpc.method('log', (_ctx, params) => {
      logged.push(params)
    })
    rpc.method('whoami', (ctx) => ctx.auth.user?.id ?? null)
    rpc.method('admin.stats', () => ({ users: 3 })).role('admin')
    rpc.method('hold', () => held)
    ignitor = await new Ignitor({ port: 0, gracefulShutdown: false, serverFactory })
      .routes((router) => {
        router.ws('/rpc', rpc.webSocket())
        router.ws('/private/rpc', rpc.webSocket()).use(signIn)
      })
      .httpServer()
      .start()
    base = `ws://127.0.0.1:${await ignitor.port()}`
  })

  afterAll(async () => {
    release()
    await ignitor.stop().catch(() => {})
  })

  it('calls, notifies and batches', async () => {
    const transport = createWebSocketTransport()
    const rpc = createRpcClient({ url: `${base}/rpc`, transport })
    expect(await rpc.call('echo', { text: 'héllo' })).toEqual({ text: 'héllo' })
    await rpc.notify('log', ['seen'])
    const results = await rpc.batch([
      { method: 'echo', params: [1] },
      { method: 'log', params: ['b'], notify: true },
      { method: 'nope' },
    ])
    expect(results[0]).toEqual({ ok: true, value: [1] })
    expect(results[2]?.ok).toBe(false)
    await expect.poll(() => logged.length).toBe(2)
    transport.close()
  })

  it('answers 50 concurrent calls on one socket, each with its own result', async () => {
    const transport = createWebSocketTransport()
    const rpc = createRpcClient({ url: `${base}/rpc`, transport })
    const many = await Promise.all(Array.from({ length: 50 }, (_, i) => rpc.call('echo', [i])))
    expect(many).toEqual(Array.from({ length: 50 }, (_, i) => [i]))
    transport.close()
  })

  it('runs every call with the auth of the handshake, through the method role gate', async () => {
    const adminTransport = createWebSocketTransport()
    const admin = createRpcClient({
      url: `${base}/private/rpc?as=u1:admin`,
      transport: adminTransport,
    })
    expect(await admin.call('whoami')).toBe('u1')
    expect(await admin.call('admin.stats')).toEqual({ users: 3 })

    const memberTransport = createWebSocketTransport()
    const member = createRpcClient({
      url: `${base}/private/rpc?as=u2:member`,
      transport: memberTransport,
    })
    expect(await member.call('whoami')).toBe('u2')
    const refused = await member.call('admin.stats').catch((error: unknown) => error)
    expect(refused).toMatchObject({ code: -32003, message: 'Insufficient role' })
    adminTransport.close()
    memberTransport.close()
  })

  it('refuses the handshake the route middleware refuses: no socket, no call', async () => {
    const transport = createWebSocketTransport()
    const rpc = createRpcClient({ url: `${base}/private/rpc`, transport })
    const error = await rpc.call('whoami').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RpcTransportError)
    expect(error instanceof RpcTransportError && error.code).toBe('E_COMET_CONNECTION_FAILED')
    transport.close()
  })

  it('fails what waits with the 1001 the server closes with on stop', async () => {
    const transport = createWebSocketTransport({ timeout: 10_000 })
    const rpc = createRpcClient({ url: `${base}/rpc`, transport })
    expect(await rpc.call('echo', [1])).toEqual([1])
    const waiting = rpc.call('hold').catch((e: unknown) => e)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await ignitor.stop()
    const error = await waiting
    expect(error).toBeInstanceOf(RpcTransportError)
    expect(error instanceof RpcTransportError && error.code).toBe('E_COMET_CONNECTION_CLOSED')
    expect(error instanceof Error && error.message).toContain('1001')
    transport.close()
  })
})
