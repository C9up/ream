import { describe, expect, it } from 'vitest'
import { callNative, callNativeAsync } from '../../../src/errors/native.js'
import { errors } from '../../../src/index.js'
import { graphqlSchemaTypes, HyperServer, hmacVerify } from './loader.js'
import { track } from './servers.js'

/**
 * The http binding's refusals, from the shipped binary through the boundary:
 * each arrives as the ream error its code names.
 */
describe('native http binding > coded refusals', () => {
  it('a bind address that is not one is E_SERVER_INVALID_HOST', () => {
    expect(() => callNative(() => new HyperServer(0, 'not-a-host'))).toThrow(
      errors.E_SERVER_INVALID_HOST,
    )
  })

  it('a port above 65535 is E_SERVER_INVALID_PORT', () => {
    expect(() => callNative(() => new HyperServer(70000))).toThrow(errors.E_SERVER_INVALID_PORT)
  })

  it('a trusted proxy that is not one is E_SERVER_INVALID_TRUSTED_PROXY', () => {
    const server = track(new HyperServer(0))
    expect(() => callNative(() => server.configureTrustedProxies(['10.0.0/8']))).toThrow(
      errors.E_SERVER_INVALID_TRUSTED_PROXY,
    )
  })

  it('a negative body limit is E_SERVER_INVALID_BODY_LIMIT', () => {
    const server = track(new HyperServer(0))
    expect(() => callNative(() => server.configureBodyLimits({ json: { limit: -1 } }))).toThrow(
      errors.E_SERVER_INVALID_BODY_LIMIT,
    )
  })

  it('a fractional gRPC limit is E_SERVER_GRPC_INVALID_LIMIT, naming the option', () => {
    const server = track(new HyperServer(0))
    expect(() =>
      callNative(() =>
        server.onGrpc(async () => ({ code: 12, details: 'unused' }), {
          maxReceiveMessageLength: 1.5,
        }),
      ),
    ).toThrow(
      'maxReceiveMessageLength must be a whole number of bytes, or -1 for no limit — got 1.5.',
    )
  })

  it('a WebSocket limit of 0 is E_INVALID_WEBSOCKET_CONFIG', () => {
    const server = track(new HyperServer(0))
    expect(() => callNative(() => server.configureWebSockets({ maxMessageSize: 0 }))).toThrow(
      errors.E_INVALID_WEBSOCKET_CONFIG,
    )
  })

  it('a close code or reason a frame cannot carry is refused, coded', () => {
    const server = track(new HyperServer(0))
    expect(() => callNative(() => server.webSocketClose('socket', 1005))).toThrow(
      errors.E_WEBSOCKET_CLOSE_CODE,
    )
    expect(() => callNative(() => server.webSocketClose('socket', 1000, 'x'.repeat(124)))).toThrow(
      errors.E_WEBSOCKET_CLOSE_REASON,
    )
  })

  it('reading the port before listen() is E_SERVER_NOT_STARTED', async () => {
    const server = track(new HyperServer(0))
    await expect(callNativeAsync(() => server.port())).rejects.toThrow(errors.E_SERVER_NOT_STARTED)
  })

  it('listen() without a handler is E_SERVER_NO_HANDLER', async () => {
    const server = track(new HyperServer(0))
    await expect(callNativeAsync(() => server.listen())).rejects.toThrow(errors.E_SERVER_NO_HANDLER)
  })

  it('a schema that does not parse is E_GRAPHQL_INVALID_SCHEMA', () => {
    expect(() => callNative(() => graphqlSchemaTypes('type {'))).toThrow(
      errors.E_GRAPHQL_INVALID_SCHEMA,
    )
  })

  it('a signature that is not base64url does not verify, and does not throw', () => {
    expect(hmacVerify('data', '%%%not base64%%%', 'a-secret-of-some-length')).toBe(false)
  })
})

/** Binding a port needs a network; see hyper-server.test.ts. */
const describeIfNetwork = process.env.REAM_SKIP_NETWORK_TESTS !== '1' ? describe : describe.skip

describeIfNetwork('native http binding > bind', () => {
  it('a port another server holds is E_SERVER_BIND_FAILED', async () => {
    const handler = async () => ({ status: 200, headers: {}, body: '' })
    const first = track(new HyperServer(0))
    first.onRequest(handler)
    await first.listen()
    const second = track(new HyperServer(await first.port()))
    second.onRequest(handler)
    await expect(callNativeAsync(() => second.listen())).rejects.toThrow(
      errors.E_SERVER_BIND_FAILED,
    )
  })
})
