/**
 * Which names an RpcRouter publishes: only the controller methods it is
 * told to, and never one in the namespace JSON-RPC reserves.
 */
import { describe, expect, it } from 'vitest'
import { RpcRouter } from '../../src/rpc/RpcRouter.js'
import { rpcCall, sendRpc, thrownReamError } from '../__helpers__/rpc.js'

const methodNotFound = (id: number) => ({
  jsonrpc: '2.0',
  error: { code: -32601, message: 'Method not found' },
  id,
})

describe('RpcRouter > namespace() exposes only the methods it is given', () => {
  class UserController {
    async show(_ctx: unknown, params: unknown) {
      return { shown: params }
    }
    async update() {
      return 'updated'
    }
    private async resetAllPasswords() {
      return 'all passwords reset'
    }
    protected internalHelper() {
      return 'internal'
    }
    get computed() {
      return 'getter'
    }
    // Keeps the TS-private members referenced.
    expose() {
      return [this.resetAllPasswords, this.internalHelper]
    }
  }

  it('registers the listed methods and nothing else', () => {
    const rpc = new RpcRouter()
    rpc.namespace('user', UserController, ['show'])
    expect(rpc.getMethods()).toEqual(['user.show'])
  })

  it('answers Method not found for a TypeScript-private, protected or unlisted method', async () => {
    const rpc = new RpcRouter()
    rpc.namespace('user', UserController, ['show', 'update'])
    const cases: Array<[number, string]> = [
      [1, 'user.resetAllPasswords'],
      [2, 'user.internalHelper'],
      [3, 'user.expose'],
      [4, 'user.constructor'],
    ]
    for (const [id, method] of cases) {
      expect((await sendRpc(rpc, rpcCall(method, id))).payload).toEqual(methodNotFound(id))
    }
  })

  it('dispatches a listed method to the controller', async () => {
    const rpc = new RpcRouter()
    rpc.namespace('user', UserController, ['show'])
    const { payload } = await sendRpc(rpc, rpcCall('user.show', 9, { id: 3 }))
    expect(payload).toEqual({ jsonrpc: '2.0', result: { shown: { id: 3 } }, id: 9 })
  })

  it('refuses a name the controller has no plain method for', () => {
    const rpc = new RpcRouter()
    for (const name of ['missing', 'constructor', 'toString', 'hasOwnProperty', 'computed', '']) {
      // Names arrive untyped from JavaScript callers.
      const names: string[] = [name]
      const error = thrownReamError(() => {
        Reflect.apply(rpc.namespace, rpc, ['user', UserController, names])
      })
      expect(error.code).toBe('E_RPC_UNKNOWN_CONTROLLER_METHOD')
    }
    expect(rpc.getMethods()).toEqual([])
  })

  it('registers nothing when one listed name is unknown', () => {
    const rpc = new RpcRouter()
    const names: string[] = ['show', 'missing']
    expect(
      thrownReamError(() => {
        Reflect.apply(rpc.namespace, rpc, ['user', UserController, names])
      }).code,
    ).toBe('E_RPC_UNKNOWN_CONTROLLER_METHOD')
    expect(rpc.getMethods()).toEqual([])
  })

  it('accepts a method inherited from a base controller', async () => {
    class Base {
      ping() {
        return 'pong'
      }
    }
    class Child extends Base {}
    const rpc = new RpcRouter()
    rpc.namespace('child', Child, ['ping'])
    const { payload } = await sendRpc(rpc, rpcCall('child.ping'))
    expect(payload).toEqual({ jsonrpc: '2.0', result: 'pong', id: 1 })
  })
})

describe('RpcRouter > reserved and invalid method names', () => {
  it('refuses to register a name in the reserved rpc. namespace', () => {
    const rpc = new RpcRouter()
    expect(thrownReamError(() => rpc.method('rpc.discover', () => 'x')).code).toBe(
      'E_RPC_RESERVED_METHOD_NAME',
    )
    class Introspection {
      discover() {
        return 'x'
      }
    }
    expect(thrownReamError(() => rpc.namespace('rpc', Introspection, ['discover'])).code).toBe(
      'E_RPC_RESERVED_METHOD_NAME',
    )
    expect(rpc.getMethods()).toEqual([])
  })

  it('refuses an empty or non-string name', () => {
    const rpc = new RpcRouter()
    expect(thrownReamError(() => rpc.method('', () => 'x')).code).toBe('E_RPC_INVALID_METHOD_NAME')
    expect(
      thrownReamError(() => {
        Reflect.apply(rpc.method, rpc, [42, () => 'x'])
      }).code,
    ).toBe('E_RPC_INVALID_METHOD_NAME')
  })

  it('allows names that merely contain rpc', () => {
    const rpc = new RpcRouter()
    rpc.method('rpcx', () => 'a')
    rpc.method('my.rpc.x', () => 'b')
    rpc.method('RPC.upper', () => 'c')
    expect(rpc.getMethods()).toEqual(['rpcx', 'my.rpc.x', 'RPC.upper'])
  })

  it('answers Method not found for an rpc. call', async () => {
    expect((await sendRpc(new RpcRouter(), rpcCall('rpc.discover'))).payload).toEqual(
      methodNotFound(1),
    )
  })
})
