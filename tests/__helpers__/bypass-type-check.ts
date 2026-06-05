/**
 * Inject a runtime-bad value into a typed slot for testing a runtime guard.
 *
 * THIS IS THE *ONE* PLACE IN THE PROJECT WHERE `as T` IS PERMITTED.
 * Everywhere else, see cerebrum DNR 2026-05-04 ("no `any` AND no `as` casts in
 * new code"). Encapsulating the bypass here keeps ad-hoc `Object.create(null) +
 * Object.assign` workarounds from spreading across test files. Use this helper
 * ONLY when you are deliberately testing a runtime guard's response to a value
 * the type system says cannot exist — never as a "shut up the compiler"
 * shortcut.
 */
export function bypassTypeCheck<T>(value: unknown): T {
  return value as T
}
