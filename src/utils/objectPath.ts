/**
 * Zero-dependency dot-path object access — the small subset of `lodash`
 * (`get`/`set`/`has`/`pick`/`omit`/`merge`) that Config and Request need for
 * AdonisJS-parity nested access (`config.get('database.mysql.host')`,
 * `request.input('user.address.city')`).
 *
 * AdonisJS uses `@poppinss/utils/lodash` for this. Ream stays lean and
 * dependency-free (same stance as aurora's hand-written `cn`/`clsx`), so we
 * reimplement exactly the four semantics we rely on — no more.
 *
 * Path syntax: `a.b.c` and `a[0].c` / `a.0.c` (bracket + dotted indices) are
 * both accepted, matching lodash's tokenizer for the shapes config/request
 * data actually take (plain JSON objects and arrays).
 */

/** A JSON-ish record we can index by string key. */
type UnknownRecord = Record<string, unknown>

/** True for plain objects and arrays (anything indexable by a path segment). */
function isIndexable(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

/**
 * Split a dot/bracket path into segments: `a.b[0].c` → `['a','b','0','c']`.
 * A single already-simple key (no `.`/`[`) is returned as-is, so keys that
 * happen to contain neither delimiter cost nothing.
 */
function toSegments(path: string): string[] {
  if (path.indexOf('.') === -1 && path.indexOf('[') === -1) return [path]
  const segments: string[] = []
  const matcher = /[^.[\]]+/g
  let match: RegExpExecArray | null = matcher.exec(path)
  while (match !== null) {
    segments.push(match[0])
    match = matcher.exec(path)
  }
  return segments
}

/**
 * Read a nested value by dot-path. Returns `defaultValue` when any segment is
 * missing or the resolved value is `undefined` (lodash.get semantics).
 */
export function getPath(source: unknown, path: string, defaultValue?: unknown): unknown {
  const segments = toSegments(path)
  let current: unknown = source
  for (const segment of segments) {
    if (!isIndexable(current)) return defaultValue
    current = current[segment]
  }
  return current === undefined ? defaultValue : current
}

/**
 * True when the full dot-path exists on `source` (each segment is an own key),
 * even if the leaf value is `undefined` (lodash.has semantics).
 */
export function hasPath(source: unknown, path: string): boolean {
  const segments = toSegments(path)
  let current: unknown = source
  for (const segment of segments) {
    if (!isIndexable(current) || !Object.hasOwn(current, segment)) return false
    current = current[segment]
  }
  return true
}

/**
 * Set a nested value by dot-path, creating intermediate plain objects as
 * needed, and return the (mutated) root.
 *
 * Deviation from lodash.set (named): integer segments create plain objects,
 * NOT arrays. Config trees and request-data picks are keyed objects; ream
 * never sets array indices through a path, so array auto-vivification would be
 * dead behaviour.
 */
export function setPath(target: UnknownRecord, path: string, value: unknown): UnknownRecord {
  const segments = toSegments(path)
  // The last segment is the one written; everything before it is walked. Split
  // off by name rather than by index, so neither has to be read back out of
  // the array afterwards and re-checked for existence.
  const last = segments.pop()
  if (last === undefined) return target
  let current: UnknownRecord = target
  for (const key of segments) {
    const next = current[key]
    if (!isIndexable(next)) {
      const created: UnknownRecord = {}
      current[key] = created
      current = created
    } else {
      current = next
    }
  }
  current[last] = value
  return target
}

/**
 * Return a new object containing only the given dot-paths (lodash.pick).
 * Missing paths are skipped; nested paths reconstruct their branch, so
 * `pickPaths({a:{b:1,c:2}}, ['a.b'])` yields `{a:{b:1}}`.
 */
export function pickPaths(source: unknown, paths: string[]): UnknownRecord {
  const result: UnknownRecord = {}
  for (const path of paths) {
    if (hasPath(source, path)) setPath(result, path, getPath(source, path))
  }
  return result
}

/**
 * Return a deep clone of `source` with the given dot-paths removed
 * (lodash.omit). Operates on JSON-ish data (body + query), so `structuredClone`
 * is a safe deep copy that never mutates the caller's input.
 */
export function omitPaths(source: UnknownRecord, paths: string[]): UnknownRecord {
  const result = structuredClone(source)
  for (const path of paths) {
    const segments = toSegments(path)
    const last = segments.pop()
    if (last === undefined) continue
    let current: unknown = result
    for (const key of segments) {
      if (!isIndexable(current)) break
      current = current[key]
    }
    if (isIndexable(current)) delete current[last]
  }
  return result
}

/**
 * Deep-merge `source` over `target` (recursively for nested plain objects;
 * scalars and arrays from `source` replace `target`). Returns a new object;
 * neither input is mutated. Backs `Config.defaults` — the AdonisJS semantics
 * where existing config wins over provided defaults.
 */
export function mergeDeep(target: unknown, source: unknown): unknown {
  if (!isIndexable(target) || Array.isArray(target)) return source === undefined ? target : source
  if (!isIndexable(source) || Array.isArray(source)) return source === undefined ? target : source
  const out: UnknownRecord = { ...target }
  for (const key of Object.keys(source)) {
    out[key] = mergeDeep(out[key], source[key])
  }
  return out
}
