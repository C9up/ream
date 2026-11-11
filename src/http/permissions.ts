/**
 * The permission check shared by the route, RPC and GraphQL gates, so the
 * three cannot drift apart.
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
