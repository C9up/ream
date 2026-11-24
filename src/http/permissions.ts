/**
 * The guard and permission checks shared by the route, RPC and GraphQL gates,
 * so the three cannot drift apart.
 */

import type { AuthState } from './HttpContext.js'

/**
 * Whether the request's identity holds every permission in `required` — what
 * the route, RPC and GraphQL `.permission()` gates ask.
 *
 * When the auth state exposes `hasAllPermissions` (the auth layer resolves
 * permissions itself, as warden does through its rights resolver), its
 * answer decides: a permission granted only by the resolver passes, one left
 * only in the payload does not. Anything but `true` denies, and an error from
 * the resolver propagates rather than grants. Only an auth state without that
 * method falls back to the payload: top-level `auth.permissions`, or
 * `auth.user.permissions`.
 *
 * When the request was authenticated with a token, each permission must ALSO
 * be allowed by `auth.user.currentAccessToken`: an intersection, never a
 * union. A token scope named like a permission grants nothing the user
 * lacks, and a token limited to `profile` does not carry every permission of
 * its user. A token whose `allows` cannot be called denies.
 */
export async function holdsPermissions(
  auth: AuthState | undefined,
  required: readonly string[],
): Promise<boolean> {
  if (!(await userHolds(auth, required))) return false
  const token = auth?.user?.currentAccessToken
  if (token === undefined || token === null) return true
  return required.every(
    (permission) => typeof token.allows === 'function' && token.allows(permission) === true,
  )
}

async function userHolds(
  auth: AuthState | undefined,
  required: readonly string[],
): Promise<boolean> {
  if (typeof auth?.hasAllPermissions === 'function') {
    return (await auth.hasAllPermissions(required)) === true
  }
  const granted = auth?.permissions ?? auth?.user?.permissions ?? []
  return required.every((permission) => granted.includes(permission))
}

/**
 * Whether the request's identity meets every role requirement — what the
 * route and RPC `.role()` gates ask.
 *
 * Each requirement is a list of roles the user needs ONE of: a `.role('a',
 * 'b')` call, a group's `.role()`, each role of an `@Role('a', 'b')` decorator
 * on its own. Every requirement must be met, so a level added by a group, a
 * nested group, a second `.role()` call or a decorator only ever restricts
 * access: a route's `.role('editor')` inside a group's `.role('admin')` does
 * not let an editor who is not an admin through.
 *
 * The roles are read at the top level (`auth.roles`) or under the user
 * (`auth.user.roles`, where warden puts them).
 */
export function holdsRoles(
  auth: AuthState | undefined,
  requirements: readonly (readonly string[])[],
): boolean {
  const held = auth?.roles ?? auth?.user?.roles ?? []
  return requirements.every((oneOf) => oneOf.some((role) => held.includes(role)))
}

/**
 * Whether one of `guards` vouches for the request — what a `.guard('jwt')`
 * on a route, an RPC method or a GraphQL resolver asks.
 *
 * A guard list RESTRICTS which guards may authenticate the request, as
 * AdonisJS `middleware.auth({ guards })` does by calling
 * `ctx.auth.authenticateUsing(guards)`. Only checking `isAuthenticated` let a
 * request authenticated by any other guard through: a session cookie riding a
 * cross-site form post ran a route meant to be bearer-token only.
 *
 * - Already authenticated by one of `guards` (`authenticatedViaGuard`): yes.
 * - Otherwise, when the auth state exposes `authenticateUsing`, the request is
 *   authenticated with those guards. Its error propagates — a 401
 *   (`E_UNAUTHORIZED_ACCESS`) carries the redirect or challenge the guard
 *   answers with; see {@link isUnauthorizedError} to turn it into a denial.
 * - Otherwise no: an auth state that cannot tell which guard authenticated it
 *   fails closed.
 */
export async function authenticatedByGuards(
  auth: AuthState | undefined,
  guards: readonly string[],
): Promise<boolean> {
  if (viaOneOf(auth, guards)) return true
  if (typeof auth?.authenticateUsing !== 'function') return false
  await auth.authenticateUsing([...guards])
  return viaOneOf(auth, guards)
}

function viaOneOf(auth: AuthState | undefined, guards: readonly string[]): boolean {
  const via = auth?.authenticatedViaGuard
  return auth?.isAuthenticated === true && via !== undefined && guards.includes(via)
}

/**
 * The guards a request may be authenticated by when every level of `levels`
 * must accept it: the guards present in each one, in the first level's order.
 *
 * A request is authenticated by ONE guard (`authenticatedViaGuard`), so a
 * group's `.guard('jwt')` and a route's `.guard('web')` leave no guard at all:
 * nothing can satisfy both, and the route answers 401. Authenticating the
 * request again with each level's guards would instead let a session cookie
 * satisfy one level and a bearer token the other, with the user of the last
 * one ending up on `ctx.auth`.
 */
export function guardsOfEveryLevel(levels: readonly (readonly string[])[]): string[] {
  const [first, ...rest] = levels
  if (first === undefined) return []
  return first.filter(
    (guard, index) =>
      first.indexOf(guard) === index && rest.every((level) => level.includes(guard)),
  )
}

/**
 * Whether the request is authenticated by a guard every level accepts — what
 * a route's guards ask once a group, a nested group, the route itself and an
 * `@Guard()` decorator have each named theirs. Each level is a requirement:
 * `.guard('jwt', 'web')` accepts either guard, a group's `.guard('jwt')`
 * around a route's `.guard('jwt', 'web')` accepts only `jwt`, and levels with
 * no guard in common refuse every request.
 */
export async function authenticatedByGuardLevels(
  auth: AuthState | undefined,
  levels: readonly (readonly string[])[],
): Promise<boolean> {
  const allowed = guardsOfEveryLevel(levels)
  if (allowed.length === 0) return false
  return authenticatedByGuards(auth, allowed)
}

/** An authentication failure (status 401), as opposed to a crash behind it. */
export function isUnauthorizedError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'status' in error && error.status === 401
}
