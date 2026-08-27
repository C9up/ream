/**
 * Run `callback`, never returning before `minimumMs` has elapsed.
 *
 * A login that answers in 3ms for an unknown address and 80ms for a known one
 * tells an attacker which addresses exist, whatever the response body says.
 * Holding every path to the same floor removes that signal.
 *
 * The callback can call `returnEarly()` to opt out — on a path where the timing
 * carries nothing, waiting is pure latency.
 */
export async function safeTiming<T>(
  minimumMs: number,
  callback: (timing: { returnEarly(): void }) => Promise<T>,
): Promise<T> {
  const startedAt = performance.now()
  let returnEarly = false

  let result: T | undefined
  let caught: unknown
  let threw = false
  try {
    result = await callback({
      returnEarly() {
        returnEarly = true
      },
    })
  } catch (error) {
    caught = error
    threw = true
  }

  // The floor applies to the failing path too: an error that comes back faster
  // than a success is the same leak in the other direction.
  if (!returnEarly) {
    const remaining = minimumMs - (performance.now() - startedAt)
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining))
    }
  }

  if (threw) throw caught
  // `result` is assigned whenever the callback returned, and we rethrew above
  // when it did not.
  return result as T
}
