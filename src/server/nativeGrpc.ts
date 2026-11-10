/**
 * The gRPC handler as the native server calls it.
 *
 * The native server numbers each call and, separately, reports the numbers
 * of the calls a client gave up on — a reset stream or a closed connection —
 * before the handler answered. This turns those reports into the `signal` of
 * each {@link GrpcCall}, so that a handler can stop the work it started.
 *
 * Calls reach JavaScript in increasing id order, but a cancel travels on its
 * own queue and can arrive before its call: one for an id not seen yet is
 * kept until that call arrives; one for an id already seen and finished is
 * dropped.
 */

import type { GrpcCall, GrpcHandler, GrpcReply } from './Server.js'

/** A call as the native server hands it over: numbered, without a signal. */
export interface NativeGrpcCall extends Omit<GrpcCall, 'signal'> {
  id: number
}

export type NativeGrpcHandler = (call: NativeGrpcCall) => Promise<GrpcReply>

export interface CancellableGrpc {
  /** Give to the native server's `onGrpc`. */
  onCall: NativeGrpcHandler
  /** Give to the native server's `onGrpcCancel`. */
  onCancel: (id: number) => void
}

export function cancellableGrpc(handler: GrpcHandler): CancellableGrpc {
  const running = new Map<number, AbortController>()
  // Cancels that arrived before their call.
  const early = new Set<number>()
  let lastSeen = 0

  return {
    async onCall({ id, ...call }) {
      lastSeen = Math.max(lastSeen, id)
      const controller = new AbortController()
      for (const cancelled of early) {
        if (cancelled > id) continue
        early.delete(cancelled)
        if (cancelled === id) controller.abort()
      }
      running.set(id, controller)
      try {
        return await handler({ ...call, signal: controller.signal })
      } finally {
        running.delete(id)
      }
    },
    onCancel(id) {
      const controller = running.get(id)
      if (controller !== undefined) controller.abort()
      else if (id > lastSeen) early.add(id)
    },
  }
}
