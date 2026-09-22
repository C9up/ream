/**
 * Matching the globs an application declares under `hotHook.boundaries`.
 *
 * A dependency for this would be `picomatch` plus `fast-glob`, which is two
 * packages and their trees for the three wildcards these patterns actually use.
 * The patterns are written by hand in a `package.json` and read once at boot;
 * what they need is to be right, not fast.
 *
 * The dialect is the one those files already use:
 *   *   any run of characters inside one path segment
 *   **  any number of segments, including none
 *   ?   exactly one character inside a segment
 *
 * A leading `./` is optional, and matching is done on POSIX-shaped paths
 * relative to the project root, so a Windows checkout and a Linux one read the
 * same pattern the same way.
 */

/** Turn one glob into an anchored regular expression. */
export function globToRegExp(pattern: string): RegExp {
  const cleaned = pattern.replace(/^\.\//, '')
  let out = ''
  for (let i = 0; i < cleaned.length; i += 1) {
    const char = cleaned[i]
    if (char === '*') {
      if (cleaned[i + 1] === '*') {
        // `**/` swallows the separator so that `a/**/b` also matches `a/b`;
        // a trailing `**` simply matches the rest.
        i += 1
        if (cleaned[i + 1] === '/') {
          i += 1
          out += '(?:[^/]+/)*'
        } else {
          out += '.*'
        }
        continue
      }
      out += '[^/]*'
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    // Everything else is literal, including the characters a regular
    // expression would otherwise read as syntax.
    out += (char ?? '').replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

/**
 * A matcher over several globs.
 *
 * Returns a predicate rather than a class: the graph takes a function, and a
 * project with no boundaries gets one that is honestly always false instead of
 * an empty object that has to be checked for.
 */
export function globMatcher(patterns: readonly string[]): (path: string) => boolean {
  const expressions = patterns.map(globToRegExp)
  if (expressions.length === 0) return () => false
  return (path: string) => {
    const normalised = path.replace(/\\/g, '/').replace(/^\.\//, '')
    return expressions.some((expression) => expression.test(normalised))
  }
}
