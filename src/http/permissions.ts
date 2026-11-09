/**
 * The permission check shared by the route, RPC and GraphQL gates, so the
 * three cannot drift apart.
 */

import type { AuthState } from './HttpContext.js'

/**
 * Whether the request's identity holds every permission in `required` — what
 * the route, RPC and GraphQL `.permission()` gates ask.
 *
 * The permissions are the user's own (top-level `auth.permissions`, or
 * `auth.user.permissions` where warden puts them). When the request was
 * authenticated with a token, each permission must ALSO be allowed by
 * `auth.user.currentAccessToken`: an intersection, never a union. A token
 * scope named like a permission grants nothing the user lacks, and a token
 * limited to `profile` does not carry every permission of its user. A token
 * whose `allows` cannot be called denies.
 */
export function holdsPermissions(
  auth: AuthState | undefined,
  required: readonly string[],
): boolean {
  const granted = auth?.permissions ?? auth?.user?.permissions ?? []
  const token = auth?.user?.currentAccessToken
  return required.every((permission) => {
    if (!granted.includes(permission)) return false
    if (token === undefined || token === null) return true
    return typeof token.allows === 'function' && token.allows(permission) === true
  })
}
