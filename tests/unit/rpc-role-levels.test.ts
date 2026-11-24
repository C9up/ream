/**
 * An RPC method's `.role()` calls add requirements, as a route's do: a second
 * call restricts the method further and never widens it.
 */
import { describe, expect, it } from 'vitest'
import { HttpContext } from '../../src/http/HttpContext.js'
import { RpcRouter } from '../../src/rpc/RpcRouter.js'

async function call(rpc: RpcRouter, roles: string[]): Promise<unknown> {
  const body = JSON.stringify({ jsonrpc: '2.0', method: 'reports.export', params: {}, id: 1 })
  const ctx = new HttpContext(
    'req-1',
    {
      method: 'POST',
      path: '/rpc',
      query: '',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      },
      body,
    },
    {},
    { pattern: '/rpc', middleware: [] },
  )
  ctx.auth = { isAuthenticated: true, user: { id: 'u1', roles } }
  await rpc.handle(ctx)
  return JSON.parse(ctx.response.getBody())
}

describe('RpcMethodBuilder.role()', () => {
  function reports(): RpcRouter {
    const rpc = new RpcRouter()
    rpc
      .method('reports.export', () => 'done')
      .role('admin', 'owner')
      .role('auditor')
    return rpc
  }

  it('refuses a caller who meets one call only', async () => {
    for (const roles of [['owner'], ['auditor']]) {
      expect(await call(reports(), roles)).toMatchObject({
        error: { code: -32003, message: 'Insufficient role' },
      })
    }
  })

  it('answers a caller holding one role of each call', async () => {
    expect(await call(reports(), ['owner', 'auditor'])).toMatchObject({ result: 'done' })
  })

  it('refuses a call that names no role rather than adding an empty requirement', () => {
    const rpc = new RpcRouter()
    expect(() => rpc.method('reports.export', () => 'done').role()).toThrow(
      expect.objectContaining({ code: 'E_EMPTY_GATE_REQUIREMENT' }),
    )
  })
})
