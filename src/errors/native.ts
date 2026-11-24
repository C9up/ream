/**
 * The NAPI boundary for errors.
 *
 * A native binding cannot throw a JavaScript class: it throws a plain `Error`
 * whose message is the JSON of `ream_napi_core::ReamError` —
 * `{ code, message, hint?, context? }`. Code that calls a binding runs it
 * through {@link callNative} (or {@link callNativeAsync}), which rethrows the
 * class the code names, the native error kept as `cause`. An application then
 * branches on `error.code`, not on the wording of a message.
 */

import type { Exception } from '@c9up/flare'
import {
  E_CRYPTO_FAILED,
  E_EVENTS_BUS_FAILED,
  E_EVENTS_HANDLER_FAILED,
  E_EVENTS_NO_REQUEST_HANDLER,
  E_EVENTS_TIMEOUT,
  E_GRAPHQL_INVALID_SCHEMA,
  E_GRAPHQL_SERIALIZE_FAILED,
  E_INVALID_WEBSOCKET_CONFIG,
  E_NATIVE_CALLBACK_FAILED,
  E_NATIVE_PANIC,
  E_SERVER_BIND_FAILED,
  E_SERVER_GRPC_INVALID_LIMIT,
  E_SERVER_INVALID_BODY_LIMIT,
  E_SERVER_INVALID_HOST,
  E_SERVER_INVALID_PORT,
  E_SERVER_INVALID_TRUSTED_PROXY,
  E_SERVER_LOCK_POISONED,
  E_SERVER_NO_HANDLER,
  E_SERVER_NOT_STARTED,
  E_WEBSOCKET_CLOSE_CODE,
  E_WEBSOCKET_CLOSE_REASON,
} from './codes.js'

/** What a native error carries, read from its message. */
export interface NativePayload {
  /** The code, when the message is a `ReamError` with one. */
  code: string | undefined
  /** The human message: the payload's, or the raw message when it is not one. */
  message: string
  hint: string | undefined
  context: Record<string, string>
}

function stringField(value: object, key: string): string | undefined {
  const field: unknown = Reflect.get(value, key)
  return typeof field === 'string' ? field : undefined
}

function stringRecord(value: unknown): Record<string, string> {
  const record: Record<string, string> = {}
  if (typeof value !== 'object' || value === null) return record
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') record[key] = entry
  }
  return record
}

/** Read the `ReamError` JSON a native error ships in its message. */
export function readNativePayload(error: unknown): NativePayload {
  const raw = error instanceof Error ? error.message : String(error)
  const plain: NativePayload = { code: undefined, message: raw, hint: undefined, context: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return plain
  }
  if (typeof parsed !== 'object' || parsed === null) return plain
  return {
    code: stringField(parsed, 'code'),
    message: stringField(parsed, 'message') ?? raw,
    hint: stringField(parsed, 'hint'),
    context: stringRecord(Reflect.get(parsed, 'context')),
  }
}

type NativeErrorFactory = (payload: NativePayload, options: ErrorOptions) => Exception

/** Every code the native bindings send, with the class it becomes. */
const NATIVE_ERRORS = new Map<string, NativeErrorFactory>([
  ['E_NATIVE_PANIC', (p, o) => new E_NATIVE_PANIC([p.message], o)],
  ['E_NATIVE_CALLBACK_FAILED', (p, o) => new E_NATIVE_CALLBACK_FAILED([p.message], o)],
  ['E_SERVER_INVALID_PORT', (p, o) => new E_SERVER_INVALID_PORT([p.message], o)],
  ['E_SERVER_INVALID_HOST', (p, o) => new E_SERVER_INVALID_HOST([p.message], o)],
  [
    'E_SERVER_GRPC_INVALID_LIMIT',
    (p, o) =>
      new E_SERVER_GRPC_INVALID_LIMIT(
        [p.context.name ?? 'a gRPC limit', p.context.value ?? p.message],
        o,
      ),
  ],
  ['E_SERVER_INVALID_BODY_LIMIT', (p, o) => new E_SERVER_INVALID_BODY_LIMIT([p.message], o)],
  ['E_SERVER_INVALID_TRUSTED_PROXY', (p, o) => new E_SERVER_INVALID_TRUSTED_PROXY([p.message], o)],
  ['E_SERVER_LOCK_POISONED', (p, o) => new E_SERVER_LOCK_POISONED([p.message], o)],
  ['E_SERVER_NO_HANDLER', (_, o) => new E_SERVER_NO_HANDLER(undefined, o)],
  ['E_SERVER_BIND_FAILED', (p, o) => new E_SERVER_BIND_FAILED([p.message], o)],
  ['E_SERVER_NOT_STARTED', (_, o) => new E_SERVER_NOT_STARTED(undefined, o)],
  ['E_INVALID_WEBSOCKET_CONFIG', (p, o) => new E_INVALID_WEBSOCKET_CONFIG([p.message], o)],
  ['E_WEBSOCKET_CLOSE_CODE', (p, o) => new E_WEBSOCKET_CLOSE_CODE([p.message], o)],
  ['E_WEBSOCKET_CLOSE_REASON', (p, o) => new E_WEBSOCKET_CLOSE_REASON([p.message], o)],
  ['E_CRYPTO_FAILED', (p, o) => new E_CRYPTO_FAILED([p.message], o)],
  ['E_GRAPHQL_INVALID_SCHEMA', (p, o) => new E_GRAPHQL_INVALID_SCHEMA([p.message], o)],
  ['E_GRAPHQL_SERIALIZE_FAILED', (p, o) => new E_GRAPHQL_SERIALIZE_FAILED([p.message], o)],
  [
    'E_EVENTS_NO_REQUEST_HANDLER',
    (p, o) => new E_EVENTS_NO_REQUEST_HANDLER([p.context.name ?? p.message], o),
  ],
  ['E_EVENTS_TIMEOUT', (p, o) => new E_EVENTS_TIMEOUT([p.message], o)],
  ['E_EVENTS_HANDLER_FAILED', (p, o) => new E_EVENTS_HANDLER_FAILED([p.message], o)],
  ['E_EVENTS_BUS_FAILED', (p, o) => new E_EVENTS_BUS_FAILED([p.message], o)],
])

/**
 * A native error as the class its code names, with the native error as its
 * `cause` and the payload's hint as its `help`. Anything else (no code, a
 * code this table does not know, a value that is not an `Error`) comes back
 * unchanged: inventing a code would be worse than admitting there is none.
 */
export function fromNativeError(error: unknown): unknown {
  if (!(error instanceof Error)) return error
  const payload = readNativePayload(error)
  const factory = payload.code === undefined ? undefined : NATIVE_ERRORS.get(payload.code)
  if (factory === undefined) return error
  const mapped = factory(payload, { cause: error })
  if (payload.hint !== undefined) mapped.help = payload.hint
  return mapped
}

/** Run a synchronous native call, a coded failure rethrown as its class. */
export function callNative<T>(call: () => T): T {
  try {
    return call()
  } catch (error) {
    throw fromNativeError(error)
  }
}

/** Await an asynchronous native call, a coded rejection rethrown as its class. */
export async function callNativeAsync<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    throw fromNativeError(error)
  }
}
