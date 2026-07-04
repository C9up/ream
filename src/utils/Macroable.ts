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

export class Macroable {
  /** Attach a method to every instance of this class (AdonisJS `macro`). */
  static macro(name: string, fn: MacroFn): void {
    Object.defineProperty(this.prototype, name, {
      value: fn,
      writable: true,
      configurable: true,
    })
  }

  /**
   * Attach a computed property to every instance (AdonisJS `getter`). With
   * `singleton`, the value is computed once per instance and cached.
   */
  static getter(name: string, fn: GetterFn, singleton = false): void {
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
