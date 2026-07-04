/**
 * Env value interpolation — AdonisJS-style variable substitution + identifiers,
 * applied by {@link loadEnvFiles} as each `.env` value is loaded.
 *
 * - `$VAR` / `${VAR}` are replaced with the value of `VAR` (looked up against
 *   the values already loaded + `process.env`). A missing reference expands to
 *   an empty string. `\$` is a literal dollar sign (escape).
 * - `identifier:rest` — when `identifier` was registered via
 *   {@link defineIdentifier}, the registered callback transforms `rest`
 *   (e.g. a `base64:` decoder). Unregistered prefixes (like `postgres://…`)
 *   are left untouched.
 */

/** Transform the remainder of an `identifier:rest` value into its final form. */
export type IdentifierResolver = (value: string) => string

const identifiers = new Map<string, IdentifierResolver>()

/** Register an identifier resolver (AdonisJS `Env.defineIdentifier`). */
export function defineIdentifier(name: string, resolver: IdentifierResolver): void {
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
 * Expand `$VAR` / `${VAR}` references and apply an identifier prefix. `lookup`
 * resolves a referenced variable name to its current value (or undefined).
 */
export function interpolate(value: string, lookup: (name: string) => string | undefined): string {
  const substituted = value.replace(REFERENCE, (full, escaped, braced, bare) => {
    // `\$FOO` → literal `$FOO` (drop only the escaping backslash).
    if (escaped) return full.slice(1)
    const name = braced ?? bare
    return lookup(name) ?? ''
  })

  const prefixed = /^([A-Za-z_][A-Za-z0-9_]*):([\s\S]*)$/.exec(substituted)
  if (prefixed) {
    const resolver = identifiers.get(prefixed[1])
    if (resolver) return resolver(prefixed[2])
  }
  return substituted
}
