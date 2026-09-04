/**
 * What `loader.js` re-exports from the shipped native binary.
 *
 * The file existed and was empty, so every test importing it was told "not a
 * module" — which is why they sat outside the typecheck. These five are the
 * NAPI smoke surface: they exist to prove the boundary carries values, errors
 * and panics, and they are not part of the package's public API, so they are
 * declared here rather than in the generated bindings.
 */

/** Round-trips a string across the boundary. */
export declare function hello(name: string): string

/** Round-trips two numbers. */
export declare function add(a: number, b: number): number

/**
 * Throws a `ReamError` from Rust, to prove it arrives as one.
 *
 * Declared as returning a string because that is what the Rust says
 * (`napi::Result<String>`): the throw is the point, but the signature is not
 * `never` — a `never` here would tell the compiler the line after it is dead.
 */
export declare function throwReamError(): string

/** Panics in Rust, to prove a panic becomes an exception rather than a crash. */
export declare function triggerPanic(): string

/** Does nothing — the cost of crossing the boundary, with no work attached. */
export declare function noop(): void
