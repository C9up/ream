/**
 * Named-route URL helpers, as free functions.
 *
 * Usage:
 *   import { urlFor, signedUrlFor } from '@c9up/ream/services/urlBuilder'
 *   const href = urlFor('users.show', { id: '42' })
 *   const link = signedUrlFor('email.verify', { id: '42' }, { expiresIn: '1h' })
 *
 * Both delegate to the router — the same code `router.urlFor` /
 * `router.makeSignedUrl` run — so a route renamed in one place cannot mean two
 * things. They exist as functions rather than as another proxy object because
 * that is all there is to the URL builder: two calls, no state.
 *
 * `signedUrlFor` needs an APP_KEY-backed signer and says so if there is none.
 */

import type { SignedUrlOptions } from '../router/Router.js'
import { getRouter } from './router.js'

const NOT_READY =
  'URL builder used before initialization. ' +
  'Routes are registered during the boot phase — build URLs from inside a ' +
  'controller, a view, or a preload, not at module top level.'

/** Generate a URL from a named route, filling `:param` placeholders. */
export function urlFor(name: string, params?: Record<string, string>): string {
  const router = getRouter()
  if (!router) throw new Error(NOT_READY)
  return router.urlFor(name, params)
}

/** Generate a tamper-proof signed URL for a named route. */
export function signedUrlFor(
  name: string,
  params?: Record<string, string>,
  options?: SignedUrlOptions,
): string {
  const router = getRouter()
  if (!router) throw new Error(NOT_READY)
  return router.makeSignedUrl(name, params, options)
}
