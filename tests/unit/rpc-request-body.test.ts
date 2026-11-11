/**
 * What /rpc accepts as a request body: JSON under a JSON media type only
 * (anything else is a CORS simple request a foreign page can send with the
 * victim's cookies), and a body that is not JSON is a Parse error.
 */
import { describe, expect, it } from 'vitest'
import { ConfigStore, Container } from '../../src/index.js'
import { RpcProvider } from '../../src/rpc/RpcProvider.js'
import { RpcRouter } from '../../src/rpc/RpcRouter.js'
import { rpcCall, sendRpc } from '../__helpers__/rpc.js'

function transferRouter(): { rpc: RpcRouter; calls: unknown[] } {
  const calls: unknown[] = []
  const rpc = new RpcRouter()
  rpc.method('bank.transfer', (_ctx, params) => {
    calls.push(params)
    return 'transferred'
  })
  return { rpc, calls }
}

describe('RpcRouter > Content-Type', () => {
  it('answers 415 to a form-urlencoded body and never runs the handler', async () => {
    const { rpc, calls } = transferRouter()
    const form = 'jsonrpc=2.0&method=bank.transfer&params[to]=attacker&params[amount]=1000&id=1'
    const out = await sendRpc(rpc, form, 'application/x-www-form-urlencoded')
    expect(out).toEqual({ status: 415, payload: undefined })
    expect(calls).toEqual([])
  })

  it('answers 415 to a body without a Content-Type (no-cors fetch)', async () => {
    const { rpc, calls } = transferRouter()
    const out = await sendRpc(rpc, rpcCall('bank.transfer', 2, { to: 'attacker' }), null)
    expect(out.status).toBe(415)
    expect(calls).toEqual([])
  })

  it('answers 415 to text/plain and multipart bodies carrying JSON', async () => {
    const { rpc, calls } = transferRouter()
    for (const type of ['text/plain', 'text/plain; x=application/json', 'multipart/form-data']) {
      expect((await sendRpc(rpc, rpcCall('bank.transfer'), type)).status).toBe(415)
    }
    expect(calls).toEqual([])
  })

  it('dispatches application/json with parameters and in any case', async () => {
    const { rpc, calls } = transferRouter()
    for (const type of [
      'application/json',
      'application/json; charset=utf-8',
      'Application/JSON',
      'application/json-rpc',
      'application/jsonrequest',
    ]) {
      expect(await sendRpc(rpc, rpcCall('bank.transfer'), type)).toEqual({
        status: 200,
        payload: { jsonrpc: '2.0', result: 'transferred', id: 1 },
      })
    }
    expect(calls).toHaveLength(5)
  })

  it('honours a configured list of content types', async () => {
    const rpc = new RpcRouter({ contentTypes: ['Application/Vnd.Acme+json'] })
    rpc.method('ping', () => 'pong')
    expect((await sendRpc(rpc, rpcCall('ping'), 'application/vnd.acme+json')).status).toBe(200)
    expect((await sendRpc(rpc, rpcCall('ping'), 'application/json')).status).toBe(415)
  })

  it('takes the list from config rpc.contentTypes through the provider', async () => {
    const config = new ConfigStore()
    config.set('rpc', { contentTypes: ['application/x-rpc'] })
    const provider = new RpcProvider({ container: new Container(), config })
    provider.rpc.method('ping', () => 'pong')
    expect((await sendRpc(provider.rpc, rpcCall('ping'), 'application/x-rpc')).status).toBe(200)
    expect((await sendRpc(provider.rpc, rpcCall('ping'), 'application/json')).status).toBe(415)
  })
})

describe('RpcRouter > malformed JSON', () => {
  const parseError = { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }

  it('answers -32700 Parse error to truncated JSON', async () => {
    const rpc = new RpcRouter()
    rpc.method('ping', () => 'pong')
    const out = await sendRpc(rpc, '{"jsonrpc": "2.0", "method": "ping", "params": "bar", "baz]')
    expect(out).toEqual({ status: 200, payload: parseError })
  })

  it('answers -32700 Parse error to an invalid batch', async () => {
    const rpc = new RpcRouter()
    const out = await sendRpc(
      rpc,
      '[{"jsonrpc": "2.0", "method": "sum", "params": [1,2,4], "id": "1"},{"jsonrpc": "2.0", "method"]',
    )
    expect(out.payload).toEqual(parseError)
    expect((await sendRpc(rpc, '[')).payload).toEqual(parseError)
  })

  it('answers -32700 Parse error to an empty body', async () => {
    expect((await sendRpc(new RpcRouter(), '')).payload).toEqual(parseError)
  })

  it('still answers -32600 Invalid Request to well-formed JSON that is no request', async () => {
    const rpc = new RpcRouter()
    for (const body of ['{}', '1', '"x"', 'null']) {
      expect((await sendRpc(rpc, body)).payload).toEqual({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid Request' },
        id: null,
      })
    }
  })

  it('handles a JSON array as a batch', async () => {
    const rpc = new RpcRouter()
    rpc.method('echo', (_ctx, params) => params)
    const out = await sendRpc(
      rpc,
      JSON.stringify([
        { jsonrpc: '2.0', method: 'echo', params: { a: 1 }, id: 1 },
        { jsonrpc: '2.0', method: 'echo', params: { b: 2 }, id: 2 },
      ]),
    )
    expect(out.payload).toEqual([
      { jsonrpc: '2.0', result: { a: 1 }, id: 1 },
      { jsonrpc: '2.0', result: { b: 2 }, id: 2 },
    ])
  })

  it('treats a top-level array as a batch, not as an object carrying _body', async () => {
    const rpc = new RpcRouter()
    rpc.method('echo', (_ctx, params) => params)
    const out = await sendRpc(
      rpc,
      JSON.stringify({ _body: [{ jsonrpc: '2.0', method: 'echo', params: {}, id: 1 }] }),
    )
    expect(out.payload).toEqual({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Invalid Request' },
      id: null,
    })
  })
})

describe('RpcRouter > batch size', () => {
  function batch(size: number): string {
    return JSON.stringify(
      Array.from({ length: size }, (_, i) => ({
        jsonrpc: '2.0',
        method: 'bank.transfer',
        params: { n: i },
        id: i,
      })),
    )
  }

  it('refuses a batch of 51 calls with 400 / -32600 before running any of them', async () => {
    // Each call of a batch runs a handler on the same request; the cap is the
    // request-side bound on that work.
    const { rpc, calls } = transferRouter()
    const out = await sendRpc(rpc, batch(51))
    expect(out.status).toBe(400)
    expect(out.payload).toEqual({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Batch too large (max 50)' },
      id: null,
    })
    expect(calls).toEqual([])
  })

  it('runs a batch of exactly 50 calls', async () => {
    const { rpc, calls } = transferRouter()
    const out = await sendRpc(rpc, batch(50))
    expect(out.status).toBe(200)
    expect(Array.isArray(out.payload) ? out.payload : []).toHaveLength(50)
    expect(calls).toHaveLength(50)
  })
})
