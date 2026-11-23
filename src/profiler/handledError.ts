/**
 * Where the HTTP kernel tells the profiler about an error it answered.
 *
 * The kernel turns an error into a response at the layer that threw, so the
 * profiling middleware, further out, sees its `next()` resolve and never
 * catches the error itself. It listens here instead, for the request it wraps.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

const listener = new AsyncLocalStorage<(error: unknown) => void>()

/** Run `work` with `onError` told about each error the kernel answers inside it. */
export function listenForHandledErrors<T>(
  onError: (error: unknown) => void,
  work: () => Promise<T>,
): Promise<T> {
  return listener.run(onError, work)
}

/** Called by the kernel with each error it answers. */
export function noteHandledError(error: unknown): void {
  listener.getStore()?.(error)
}
