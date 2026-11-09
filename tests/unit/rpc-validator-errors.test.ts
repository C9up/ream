/**
 * A validator that fails for a reason other than invalid params is an
 * internal failure: its message stays off the wire in production, and a
 * bug inside a rule is not reported as a validator with no validate method.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Container } from '../../src/index.js'
import { RpcRouter } from '../../src/rpc/RpcRouter.js'
import { rpcCall, sendRpc } from '../__helpers__/rpc.js'

const internalError = (id: number) => ({
  jsonrpc: '2.0',
  error: { code: -32603, message: 'Internal error' },
  id,
})

const previousEnv = process.env.NODE_ENV
afterEach(() => {
  process.env.NODE_ENV = previousEnv
})

function withValidator(validator: object, registered = true): RpcRouter {
  const container = new Container()
  if (registered) container.singleton('validator:pay', () => validator)
  const rpc = new RpcRouter()
  rpc.useContainer(container)
  rpc.method('pay', () => 'paid').validate('pay')
  return rpc
}

const leaky = {
  validateResultAsync: async () => {
    throw new Error('relation "accounts" does not exist (postgres://app:s3cret@10.0.3.7/main)')
  },
}

describe('RpcRouter > validator failures', () => {
  it('answers Internal error in production when a validator throws', async () => {
    process.env.NODE_ENV = 'production'
    expect((await sendRpc(withValidator(leaky), rpcCall('pay', 6))).payload).toEqual(
      internalError(6),
    )
  })

  it('keeps the validator failure detail in development', async () => {
    process.env.NODE_ENV = 'development'
    const { payload } = await sendRpc(withValidator(leaky), rpcCall('pay', 6))
    expect(payload).toMatchObject({ error: { code: -32603 } })
    expect(JSON.stringify(payload)).toContain('relation \\"accounts\\" does not exist')
  })

  it('does not report a TypeError inside a rule as a missing validate method', async () => {
    process.env.NODE_ENV = 'development'
    const buggy = {
      validateResultAsync: async (data: unknown) => {
        const nested: unknown = Reflect.get(Object(data), 'nested')
        return Reflect.get(Object(Reflect.get(Object(nested), 'deep')), 'value').valid
      },
    }
    const { payload } = await sendRpc(withValidator(buggy), rpcCall('pay', 7))
    expect(JSON.stringify(payload)).not.toContain('no usable validate method')
    expect(JSON.stringify(payload)).toContain('Cannot read properties of undefined')
  })

  it('reports a validator without any validate method as such in development', async () => {
    process.env.NODE_ENV = 'development'
    const { payload } = await sendRpc(withValidator({}), rpcCall('pay', 8))
    expect(JSON.stringify(payload)).toContain('no usable validate method')
  })

  it('answers Internal error in production for a validator without a validate method', async () => {
    process.env.NODE_ENV = 'production'
    expect((await sendRpc(withValidator({}), rpcCall('pay', 8))).payload).toEqual(internalError(8))
  })

  it('keeps the unregistered-validator configuration hint off the wire in production', async () => {
    process.env.NODE_ENV = 'production'
    expect((await sendRpc(withValidator(leaky, false), rpcCall('pay', 9))).payload).toEqual(
      internalError(9),
    )
    process.env.NODE_ENV = 'development'
    const dev = await sendRpc(withValidator(leaky, false), rpcCall('pay', 9))
    expect(JSON.stringify(dev.payload)).toContain('is not registered')
  })

  it('still answers Invalid params with the validator errors', async () => {
    process.env.NODE_ENV = 'production'
    const rejecting = { validateResult: () => ({ valid: false, errors: ['amount is required'] }) }
    expect((await sendRpc(withValidator(rejecting), rpcCall('pay', 10))).payload).toEqual({
      jsonrpc: '2.0',
      error: { code: -32602, message: 'Invalid params', data: ['amount is required'] },
      id: 10,
    })
  })
})
