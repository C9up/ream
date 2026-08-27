/**
 * Guard name → what `auth.use(name)` hands back.
 *
 * Empty here, and deliberately: ream owns no auth package, so it cannot know
 * the guards an app configured. The auth package fills it in, exactly as
 * AdonisJS does with `Authenticators`:
 *
 * ```ts
 * declare module '@c9up/ream/types' {
 *   interface Authenticators {
 *     session: SessionGuard
 *     jwt: JwtGuard
 *   }
 * }
 * ```
 *
 * Until something augments it, `keyof Authenticators` is `never` and `use()`
 * falls through to its `unknown` signature — the behaviour ream had before,
 * kept as the floor rather than as the ceiling.
 */
export type Authenticators = {}

/** A guard name this application knows about. */
export type AuthenticatorName = keyof Authenticators
