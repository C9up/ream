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

/**
 * @internal Set the signer, or clear it with `undefined`.
 *
 * Called by the Ignitor for EVERY boot, key or no key. Leaving a previous
 * application's signer in place when this one has none is the dangerous
 * reading: `import encryption from '.../services/encryption'` would answer
 * with a key this application never configured, and sign its cookies with it.
 * Last boot owns the locator — the same rule as `setApp` / `setRouter` /
 * `setServer` beside it. A process running two applications at once should
 * resolve `'encryption'` from its own container, which is per-application.
 */
export function setEncryption(signer: CookieSigner | undefined): void {
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
