// biome-ignore-all lint/complexity/noThisInStatic: `this` inside a static method
// IS the calling class, and that is the whole mechanism here — `this.prototype`
// is what scopes a macro to the subclass that declared it. Using
// `Macroable.prototype` put every macro on all eight subclasses at once.
// Removing the `this` reintroduces that bug.

/**
 * Macroable — lets a package extend a class at runtime with extra methods
 * (`macro`) and computed properties (`getter`), AdonisJS-style. A framework
 * class (Request, Response, HttpContext, Router, …) extends this so an add-on
 * can attach behaviour without a subclass:
 *
 *   Request.macro('wantsJson', function () { return this.accepts(['json']) === 'json' })
 *   HttpContext.getter('tenant', function () { return resolveTenant(this) })
 *
 * TypeScript sees only the base class; consumers type their macros with
 * declaration merging (`declare module`) exactly as in AdonisJS.
 */

/**
 * A macro method. When invoked, `this` is the instance it's attached to —
 * declare it explicitly in your callback (`function (this: Request) { … }`) to
 * type the receiver; the alias itself leaves `this` open so any class fits.
 */
export type MacroFn = (...args: unknown[]) => unknown

/** A getter implementation — declare `this` in your callback to type the receiver. */
export type GetterFn = () => unknown

// biome-ignore lint/complexity/noStaticOnlyClass: eight classes extend this one to inherit macro()/getter(); it is a base class, not a namespace.
export class Macroable {
  /**
   * Attach a method to every instance of THIS class (AdonisJS `macro`).
   *
   * `this.prototype`, not `Macroable.prototype`: eight classes extend this one,
   * and defining on the base put every macro on all of them — a
   * `Response.macro('json', …)` also landed on `Request`, `Router` and
   * `HttpContext`, and two subclasses declaring the same name clobbered each
   * other silently.
   */
  // `{ prototype: object }`, not `typeof Macroable`: a subclass whose
  // constructor takes arguments — `Request`, say — has a different static side,
  // so `Request.macro(...)` was "the 'this' context of type 'typeof Request' is
  // not assignable". What this needs from `this` is the prototype it defines on.
  static macro(this: { prototype: object }, name: string, fn: MacroFn): void {
    Object.defineProperty(this.prototype, name, {
      value: fn,
      writable: true,
      configurable: true,
    })
  }

  /**
   * Attach a computed property to every instance of THIS class (AdonisJS
   * `getter`). With `singleton`, the value is computed once per instance and
   * cached.
   */
  static getter(this: { prototype: object }, name: string, fn: GetterFn, singleton = false): void {
    if (!singleton) {
      Object.defineProperty(this.prototype, name, { get: fn, configurable: true })
      return
    }
    const cacheKey = Symbol(name)
    Object.defineProperty(this.prototype, name, {
      configurable: true,
      get(this: Record<symbol, unknown>) {
        if (!(cacheKey in this)) {
          Object.defineProperty(this, cacheKey, { value: fn.call(this), configurable: true })
        }
        return this[cacheKey]
      },
    })
  }
}
