/**
 * The one implementation behind every `@c9up/ream/services/*` accessor.
 *
 * Each accessor stands in for a singleton that only exists once the Ignitor has
 * built it, so the module-level export is a proxy that forwards to whatever the
 * boot phase installed. Written out per service, the proxy was copied five
 * times and the `symbol`/`then` guard below reached only three of them — a fix
 * that has to be applied by hand five times is a fix that will be missed.
 *
 * @see services/app.ts for the accessor shape this backs.
 */

/**
 * Build the proxy an accessor module default-exports.
 *
 * @param read     Returns the live singleton, or `undefined` before boot.
 * @param notReady Message thrown when something reads the accessor too early.
 */
export function createServiceProxy<T extends object>(
  read: () => T | undefined,
  notReady: string,
): T {
  // The target is never read through — every trap forwards to `read()`.
  const target: T = Object.create(null)
  return new Proxy(target, {
    get(_target, prop) {
      // A module loader inspects what it imports before anyone uses it: it
      // reads `then` to decide whether the namespace is thenable, and various
      // symbols for interop and formatting. Throwing on those turns a plain
      // `import { setX } from '.../services/x'` into a crash at import time,
      // far from any real use. They are not members of what this stands in
      // for, so answer undefined and let a genuine access be the one that
      // reports.
      if (typeof prop === 'symbol' || prop === 'then') {
        return undefined
      }
      const instance = read()
      if (!instance) {
        throw new Error(notReady)
      }
      // Bind methods so private-field writes inside the class resolve against
      // the real instance brand instead of the Proxy.
      const value = Reflect.get(instance, prop, instance)
      return typeof value === 'function' ? value.bind(instance) : value
    },
  })
}
