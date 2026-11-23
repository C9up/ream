/**
 * Env value interpolation — AdonisJS-style variable substitution + identifiers,
 * applied by {@link loadEnvFiles} as each `.env` value is loaded.
 *
 * - `$VAR` / `${VAR}` are replaced with the value of `VAR` (looked up against
 *   `process.env` + the file's own values, themselves interpolated). A missing
 *   reference expands to an empty string. `\$` is a literal dollar sign.
 * - `identifier:rest` — when `identifier` is registered, its resolver turns
 *   `rest` into the final value. `file` is built in: `KEY=file:secrets/db`
 *   reads `secrets/db` relative to the application root (an absolute path is
 *   allowed), the way Docker/Kubernetes secrets are fed to an app.
 *   `identifier\:rest` is the escape: it yields the literal `identifier:rest`.
 *   Unregistered prefixes (like `postgres://…`) are left untouched.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { E_ENV_FILE_NOT_FOUND, E_IDENTIFIER_ALREADY_DEFINED } from '../errors/codes.js'

/**
 * Turn the remainder of an `identifier:rest` value into its final form.
 * Receives the variable's name and the application root, as AdonisJS's
 * resolvers do; may be async (the loader awaits it).
 */
export type IdentifierResolver = (
  value: string,
  key: string,
  appRoot: URL,
) => string | Promise<string>

/**
 * The built-in `file:` identifier (AdonisJS `EnvParser`): the contents of the
 * named file, verbatim — not trimmed, as upstream. Synchronous on purpose: a
 * plain `.env` then loads without a single await, so a caller that does not
 * await {@link loadEnvFiles} still sees every value.
 */
function readFileIdentifier(value: string, key: string, appRoot: URL): string {
  const fileUrl = new URL(value, appRoot)
  try {
    return readFileSync(fileUrl, 'utf8')
  } catch (error) {
    if (isMissingFile(error)) {
      throw new E_ENV_FILE_NOT_FOUND(key, fileURLToPath(fileUrl))
    }
    throw error
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

const identifiers = new Map<string, IdentifierResolver>([['file', readFileIdentifier]])

/**
 * Register an identifier resolver (AdonisJS `Env.defineIdentifier`). A name
 * already taken throws `E_IDENTIFIER_ALREADY_DEFINED`: two packages silently
 * replacing each other's decoder is the failure this prevents.
 */
export function defineIdentifier(name: string, resolver: IdentifierResolver): void {
  if (identifiers.has(name)) {
    throw new E_IDENTIFIER_ALREADY_DEFINED([name])
  }
  identifiers.set(name, resolver)
}

/** Register an identifier resolver only if the name is free (AdonisJS `defineIdentifierIfMissing`). */
export function defineIdentifierIfMissing(name: string, resolver: IdentifierResolver): void {
  if (!identifiers.has(name)) identifiers.set(name, resolver)
}

/** Remove a registered identifier (AdonisJS `Env.removeIdentifier`). */
export function removeIdentifier(name: string): void {
  identifiers.delete(name)
}

const REFERENCE = /(\\)?\$(?:\{([^}]+)\}|([A-Za-z_][A-Za-z0-9_]*))/g

/**
 * Expand `$VAR` / `${VAR}` references. `lookup` resolves a referenced variable
 * name to its value (or undefined, which expands to an empty string).
 */
export function interpolate(value: string, lookup: (name: string) => string | undefined): string {
  return value.replace(REFERENCE, (full, escaped, braced, bare) => {
    // `\$FOO` → literal `$FOO` (drop only the escaping backslash).
    if (escaped) return full.slice(1)
    const name = braced ?? bare
    return lookup(name.trim()) ?? ''
  })
}

/**
 * Apply the registered identifier `value` starts with, if any: `id:rest` goes
 * through the resolver, the escape `id\:rest` becomes the literal `id:rest`,
 * anything else is returned as is. Registration order decides between two
 * identifiers that both match, as upstream.
 */
export function applyIdentifier(
  value: string,
  key: string,
  appRoot: URL,
): string | Promise<string> {
  if (!value.includes(':')) return value
  for (const [identifier, resolver] of identifiers) {
    if (value.startsWith(`${identifier}:`)) {
      return resolver(value.slice(identifier.length + 1), key, appRoot)
    }
    if (value.startsWith(`${identifier}\\:`)) {
      return identifier + value.slice(identifier.length + 1)
    }
  }
  return value
}
