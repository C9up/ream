import { Exception } from '@c9up/flare'
import { describe, expect, it } from 'vitest'
import {
  callNative,
  callNativeAsync,
  fromNativeError,
  readNativePayload,
} from '../../src/errors/native.js'
import { errors } from '../../src/index.js'

/** A native error as a binding throws it: `ReamError` JSON in a plain Error. */
function nativeError(payload: Record<string, unknown>): Error {
  return new Error(JSON.stringify(payload))
}

/** Every code a native binding sends whose class takes the message as is. */
const MESSAGE_CODES = [
  'E_NATIVE_PANIC',
  'E_NATIVE_CALLBACK_FAILED',
  'E_SERVER_INVALID_PORT',
  'E_SERVER_INVALID_HOST',
  'E_SERVER_INVALID_BODY_LIMIT',
  'E_SERVER_INVALID_TRUSTED_PROXY',
  'E_SERVER_LOCK_POISONED',
  'E_SERVER_BIND_FAILED',
  'E_INVALID_WEBSOCKET_CONFIG',
  'E_WEBSOCKET_CLOSE_CODE',
  'E_WEBSOCKET_CLOSE_REASON',
  'E_CRYPTO_FAILED',
  'E_GRAPHQL_SERIALIZE_FAILED',
  'E_EVENTS_TIMEOUT',
  'E_EVENTS_HANDLER_FAILED',
] as const

describe('native errors > the NAPI boundary', () => {
  it.each(MESSAGE_CODES)('%s becomes its class, the native error as cause', (code) => {
    const native = nativeError({ code, message: 'refused here' })
    const error = fromNativeError(native)
    expect(error).toBeInstanceOf(Exception)
    expect(error).toBeInstanceOf(errors[code])
    expect(error).toMatchObject({ code, message: 'refused here', cause: native })
  })

  it('a class with a fixed message keeps it', () => {
    expect(
      fromNativeError(nativeError({ code: 'E_SERVER_NOT_STARTED', message: 'x' })),
    ).toMatchObject({ code: 'E_SERVER_NOT_STARTED', message: 'Server not started' })
    expect(
      fromNativeError(nativeError({ code: 'E_SERVER_NO_HANDLER', message: 'x' })),
    ).toMatchObject({
      code: 'E_SERVER_NO_HANDLER',
      message: 'No handler registered. Call onRequest() before listen()',
    })
  })

  it('a schema that does not parse says so before its reason', () => {
    expect(
      fromNativeError(nativeError({ code: 'E_GRAPHQL_INVALID_SCHEMA', message: 'line 1: oops' })),
    ).toMatchObject({
      code: 'E_GRAPHQL_INVALID_SCHEMA',
      message: 'The GraphQL schema could not be read: line 1: oops',
    })
    expect(
      fromNativeError(nativeError({ code: 'E_EVENTS_BUS_FAILED', message: 'task cancelled' })),
    ).toMatchObject({
      code: 'E_EVENTS_BUS_FAILED',
      message: 'The native event bus failed: task cancelled',
    })
  })

  it('reads the arguments a class takes from the context', () => {
    const limit = fromNativeError(
      nativeError({
        code: 'E_SERVER_GRPC_INVALID_LIMIT',
        message: 'ignored',
        context: { name: 'maxSendMessageLength', value: '1.5' },
      }),
    )
    expect(limit).toMatchObject({
      code: 'E_SERVER_GRPC_INVALID_LIMIT',
      message:
        'maxSendMessageLength must be a whole number of bytes, or -1 for no limit — got 1.5.',
    })
    const missing = fromNativeError(
      nativeError({
        code: 'E_EVENTS_NO_REQUEST_HANDLER',
        message: "No request handler for 'query:x'",
        context: { name: 'query:x' },
      }),
    )
    expect(missing).toMatchObject({
      code: 'E_EVENTS_NO_REQUEST_HANDLER',
      message: 'no request handler registered for "query:x"',
    })
  })

  it('falls back to the message when the context lacks an argument', () => {
    expect(
      fromNativeError(nativeError({ code: 'E_SERVER_GRPC_INVALID_LIMIT', message: '-2' })),
    ).toMatchObject({
      message: 'a gRPC limit must be a whole number of bytes, or -1 for no limit — got -2.',
    })
    expect(
      fromNativeError(nativeError({ code: 'E_EVENTS_NO_REQUEST_HANDLER', message: 'q' })),
    ).toMatchObject({ message: 'no request handler registered for "q"' })
  })

  it("carries the payload's hint as help", () => {
    const error = fromNativeError(
      nativeError({
        code: 'E_NATIVE_PANIC',
        message: 'Rust panic caught: boom',
        hint: 'report it',
      }),
    )
    expect(error).toMatchObject({ code: 'E_NATIVE_PANIC', help: 'report it' })
  })

  it('leaves alone what carries no known code', () => {
    const plain = new Error('not json')
    expect(fromNativeError(plain)).toBe(plain)
    const unknown = nativeError({ code: 'SOMETHING_ELSE', message: 'x' })
    expect(fromNativeError(unknown)).toBe(unknown)
    const uncoded = nativeError({ message: 'x' })
    expect(fromNativeError(uncoded)).toBe(uncoded)
    const scalar = new Error('42')
    expect(fromNativeError(scalar)).toBe(scalar)
    expect(fromNativeError('a string')).toBe('a string')
  })

  it('reads a payload, keeping only string fields', () => {
    expect(
      readNativePayload(
        nativeError({ code: 'E_X', message: 7, hint: 'h', context: { a: 'b', n: 1 } }),
      ),
    ).toEqual({
      code: 'E_X',
      message: '{"code":"E_X","message":7,"hint":"h","context":{"a":"b","n":1}}',
      hint: 'h',
      context: { a: 'b' },
    })
    expect(readNativePayload('plain')).toEqual({
      code: undefined,
      message: 'plain',
      hint: undefined,
      context: {},
    })
    expect(
      readNativePayload(nativeError({ code: 'E_X', message: 'm', context: 'no' })),
    ).toMatchObject({ context: {} })
  })

  it('callNative returns the result, or throws the class', () => {
    expect(callNative(() => 3)).toBe(3)
    expect(() =>
      callNative(() => {
        throw nativeError({ code: 'E_WEBSOCKET_CLOSE_CODE', message: '1005 is not sendable' })
      }),
    ).toThrow(errors.E_WEBSOCKET_CLOSE_CODE)
  })

  it('callNativeAsync resolves the result, or rejects with the class', async () => {
    await expect(callNativeAsync(async () => 4)).resolves.toBe(4)
    await expect(
      callNativeAsync(async () => {
        throw nativeError({ code: 'E_SERVER_BIND_FAILED', message: 'Server bind failed: in use' })
      }),
    ).rejects.toThrow(errors.E_SERVER_BIND_FAILED)
  })
})
