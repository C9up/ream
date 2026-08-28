/**
 * Cookie/value signing singleton service.
 *
 * Usage:
 *   import encryption from '@c9up/ream/services/encryption'
 *   const signed = encryption.sign('payload')
 *
 * Registered only when `APP_KEY` is set — there is nothing to sign with
 * otherwise — so the not-ready message names that rather than the boot phase.
 */

import type { CookieSigner } from '../security/CookieSigner.js'
import { createServiceProxy } from './createServiceProxy.js'

let instance: CookieSigner | undefined

/** @internal Set the signer (called by Ignitor once APP_KEY is validated). */
export function setEncryption(signer: CookieSigner): void {
  instance = signer
}

/**
 * @internal Unset the locator IF it still points at `signer` (called by
 * Ignitor.stop()). Ownership-guarded — see services/app.ts.
 */
export function clearEncryption(signer: CookieSigner): void {
  if (instance === signer) instance = undefined
}

/** @internal Get the signer directly. */
export function getEncryption(): CookieSigner | undefined {
  return instance
}

const encryption: CookieSigner = createServiceProxy<CookieSigner>(
  () => instance,
  '[E_MISSING_APP_KEY] Encryption accessed before it was registered. ' +
    'It exists only when APP_KEY is set (>= 16 characters) — check the ' +
    'environment before reaching for it, or you are reading it before boot.',
)

export default encryption
