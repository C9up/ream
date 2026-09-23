/**
 * The naming conventions the generators follow.
 *
 * Ported from the Rust generator they replace, case for case: a rename here
 * changes what `make:controller user` produces, so the rules are written out
 * rather than approximated.
 */

/** Add the suffix unless the name already carries it. */
export function ensureSuffix(name: string, suffix: string): string {
  return name.endsWith(suffix) ? name : `${name}${suffix}`
}

/** `user_profile` / `user-profile` / `user profile` → `UserProfile`. */
export function toPascalCase(name: string): string {
  return name
    .split(/[_\-\s]/)
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

/**
 * `UserProfile` → `user_profile`, `HTTPServer` → `http_server`.
 *
 * The acronym case is why this is not a one-line regex: an underscore goes
 * before a capital that FOLLOWS a lowercase, or that follows a capital and is
 * followed by a lowercase — which is where `HTTPServer` splits.
 */
export function toSnakeCase(name: string): string {
  const chars = [...name]
  let out = ''
  for (const [index, char] of chars.entries()) {
    if (char.toUpperCase() === char && char.toLowerCase() !== char) {
      const previous = chars[index - 1]
      const next = chars[index + 1]
      const previousLower =
        previous !== undefined &&
        previous === previous.toLowerCase() &&
        previous !== previous.toUpperCase()
      const nextLower =
        next !== undefined && next === next.toLowerCase() && next !== next.toUpperCase()
      const previousUpper =
        previous !== undefined &&
        previous === previous.toUpperCase() &&
        previous !== previous.toLowerCase()
      if (index > 0 && (previousLower || (nextLower && previousUpper))) out += '_'
      out += char.toLowerCase()
      continue
    }
    out += char
  }
  return out
}

/** Drop a trailing `Middleware` / `middleware` / `_middleware`, whatever the case. */
export function stripSuffixInsensitive(name: string, suffix: string): string {
  const lower = name.toLowerCase()
  const suffixLower = suffix.toLowerCase()
  if (lower.length > suffixLower.length && lower.endsWith(suffixLower)) {
    return name.slice(0, name.length - suffix.length).replace(/[_-]+$/, '')
  }
  return name
}

/** Longer than this is not a name, it is a paste accident. */
export const MAX_NAME_LENGTH = 128

/**
 * Is this a name a generator may build a path from?
 *
 * Refused rather than sanitised: a name with a separator in it is either a
 * mistake or an attempt to write outside the project, and quietly rewriting it
 * would produce a file somewhere the user did not ask for.
 */
export function nameProblem(name: string): string | undefined {
  if (name.trim() === '') return 'the name is empty'
  if (name.length > MAX_NAME_LENGTH) return `the name is longer than ${MAX_NAME_LENGTH} characters`
  if (/[/\\]/.test(name)) return 'a name may not contain a path separator'
  if (name.includes('..')) return 'a name may not contain ".."'
  if (!/^[A-Za-z][A-Za-z0-9_\-:]*$/.test(name)) {
    return 'a name starts with a letter and holds letters, digits, "_", "-" or ":"'
  }
  return undefined
}
