/**
 * Drive an RpcRouter through a real HttpContext and read back what the
 * caller would receive.
 */
import { HttpContext } from '../../src/http/HttpContext.js'
import { isReamError, type ReamError } from '../../src/index.js'
import type { RpcRouter } from '../../src/rpc/RpcRouter.js'

function makeCtx(body: string, contentType: string | null): HttpContext {
  const headers: Record<string, string> = { 'content-length': String(Buffer.byteLength(body)) }
  if (contentType !== null) headers['content-type'] = contentType
  return new HttpContext(
    'req-1',
    { method: 'POST', path: '/rpc', query: '', headers, body },
    {},
    { pattern: '/rpc', middleware: [] },
  )
}

export async function sendRpc(
  router: RpcRouter,
  body: string,
  /** `null` sends no Content-Type at all. */
  contentType: string | null = 'application/json',
): Promise<{ status: number; payload: unknown }> {
  const ctx = makeCtx(body, contentType)
  await router.handle(ctx)
  const raw = ctx.response.getBody()
  const payload: unknown = raw === '' ? undefined : JSON.parse(raw)
  return { status: ctx.response.getStatus(), payload }
}

export function rpcCall(method: string, id: number | string = 1, params: unknown = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', method, params, id })
}

export function thrownReamError(fn: () => void): ReamError {
  try {
    fn()
  } catch (error) {
    if (isReamError(error)) return error
    throw error
  }
  throw new Error('expected a ReamError')
}
