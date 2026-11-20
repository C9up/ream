/**
 * An RPC call that fails unexpectedly is answered -32603 AND reported.
 *
 * The router turns the failure into a response and returns normally, so the
 * kernel's exception handler never sees it. It used to be written nowhere:
 * in production the caller read "Internal error" and the server kept no
 * message, no stack, no method and no correlation id.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Emitter } from '../../src/events/Emitter.js'
import { FakeBus } from '../../src/events/testing/FakeBus.js'
import type { ChildLoggerSource } from '../../src/http/HttpContext.js'
import { HttpContext } from '../../src/http/HttpContext.js'
import { Container } from '../../src/index.js'
import { RpcRouter } from '../../src/rpc/RpcRouter.js'
import { rpcCall } from '../__helpers__/rpc.js'

interface Line {
  level: string
  message: string
  data?: Record<string, unknown>
}

function recordingLogger(lines: Line[]): ChildLoggerSource {
  const at =
    (level: string) =>
    (message: string, data?: Record<string, unknown>): void => {
      lines.push({ level, message, data })
    }
  return {
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
  }
}

async function call(router: RpcRouter, body: string) {
  const lines: Line[] = []
  const emitted: unknown[] = []
  const ctx = new HttpContext(
    'req-42',
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
  ctx.setBaseLogger(recordingLogger(lines))
  const events = new Emitter(new FakeBus())
  events.on('exception', (payload) => {
    emitted.push(payload)
  })
  ctx.events = events
  await router.handle(ctx)
  // Listeners run on the emitter's own schedule.
  await new Promise((resolve) => setImmediate(resolve))
  return { payload: JSON.parse(ctx.response.getBody()), lines, emitted }
}

const previousEnv = process.env.NODE_ENV
afterEach(() => {
  process.env.NODE_ENV = previousEnv
})

describe('RpcRouter > reporting an unexpected failure', () => {
  it('logs a handler error with its stack, method and request id, and still masks the reply', async () => {
    process.env.NODE_ENV = 'production'
    const rpc = new RpcRouter()
    rpc.method('boom', async () => {
      throw new Error('database exploded')
    })

    const { payload, lines, emitted } = await call(rpc, rpcCall('boom', 1))

    expect(payload).toEqual({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal error' },
      id: 1,
    })
    expect(lines).toHaveLength(1)
    const [line] = lines
    expect(line?.level).toBe('error')
    expect(line?.message).toBe('database exploded')
    expect(line?.data).toMatchObject({ requestId: 'req-42', rpcMethod: 'boom', rpcId: 1 })
    expect(String(Reflect.get(Object(line?.data?.err), 'stack'))).toContain('database exploded')
    expect(emitted).toEqual([
      { id: 'req-42', method: 'POST', path: '/rpc', rpcMethod: 'boom', error: 'database exploded' },
    ])
  })

  it('does not log a domain error the handler chose to answer', async () => {
    const rpc = new RpcRouter()
    rpc.method('find', () => {
      throw Object.assign(new Error('Not found'), { code: -32004 })
    })

    const { payload, lines, emitted } = await call(rpc, rpcCall('find', 2))

    expect(payload).toMatchObject({ error: { code: -32004, message: 'Not found' } })
    expect(lines).toEqual([])
    expect(emitted).toEqual([])
  })

  it('logs a 4xx refusal at warn, as a route would', async () => {
    const rpc = new RpcRouter()
    rpc.method('admin', () => {
      throw Object.assign(new Error('Forbidden'), { status: 403 })
    })

    const { lines } = await call(rpc, rpcCall('admin', 3))

    expect(lines.map((line) => line.level)).toEqual(['warn'])
  })

  it('logs a validator that throws', async () => {
    process.env.NODE_ENV = 'production'
    const container = new Container()
    container.singleton('validator:pay', () => ({
      validateResultAsync: async () => {
        throw new Error('relation "accounts" does not exist')
      },
    }))
    const rpc = new RpcRouter()
    rpc.useContainer(container)
    rpc.method('pay', () => 'paid').validate('pay')

    const { payload, lines } = await call(rpc, rpcCall('pay', 4))

    expect(payload).toMatchObject({ error: { code: -32603, message: 'Internal error' } })
    expect(lines).toHaveLength(1)
    expect(lines[0]?.level).toBe('error')
    expect(lines[0]?.message).toBe(`Validator 'pay' failed: relation "accounts" does not exist`)
    expect(lines[0]?.data).toMatchObject({ rpcMethod: 'pay', rpcId: 4 })
  })

  it('logs each failing call of a batch on its own', async () => {
    const rpc = new RpcRouter()
    rpc.method('boom', () => {
      throw new Error('again')
    })
    const batch = `[${rpcCall('boom', 5)},${rpcCall('boom', 6)}]`

    const { lines } = await call(rpc, batch)

    expect(lines.map((line) => line.data?.rpcId)).toEqual([5, 6])
  })
})
