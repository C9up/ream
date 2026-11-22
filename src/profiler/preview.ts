/**
 * A bounded, redacted copy of a value, for a profiler panel.
 *
 * What the profiler keeps crosses a wire and sits in memory for the rest of the
 * dev session, so a payload is never stored as given: an event can carry a
 * whole model graph, a session a megabyte of flash data, a body an upload.
 * Depth, keys, items and string length are all capped, cycles are cut, and the
 * value of a key that names a secret is replaced rather than shown — the
 * profiler is the page a developer screenshares.
 */

/** A key whose value is never shown: credentials, and what carries them. */
const SECRET_KEY =
  /pass(word|phrase)?|secret|token|authorization|cookie|api[-_]?key|private[-_]?key|csrf|xsrf|credential/i

const MAX_DEPTH = 4
const MAX_KEYS = 40
const MAX_ITEMS = 25
const MAX_STRING = 400

/** What a redacted value becomes. */
export const REDACTED = '[redacted]'

/** Whether a key's value is hidden. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key)
}

/** A JSON-safe preview of `value`. */
export function preview(value: unknown): unknown {
  return walk(value, 0, new Set())
}

/**
 * `path` holds the objects from the root to `value`, so only a cycle is shown
 * as `[circular]`: a value reached through two keys is previewed under both.
 * Remembering every object seen showed `[circular]` for a shared one.
 */
function walk(value: unknown, depth: number, path: Set<object>): unknown {
  if (value === null || value === undefined) return value ?? null
  switch (typeof value) {
    case 'string':
      return value.length > MAX_STRING
        ? `${value.slice(0, MAX_STRING)}… (${value.length} chars)`
        : value
    case 'number':
      return Number.isFinite(value) ? value : String(value)
    case 'boolean':
      return value
    case 'bigint':
      return `${value}n`
    case 'symbol':
      return value.toString()
    case 'function':
      return `[function ${value.name || 'anonymous'}]`
  }
  if (typeof value !== 'object') return String(value)
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
  if (value instanceof Error) return { name: value.name, message: value.message }
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`
  if (path.has(value)) return '[circular]'
  if (depth >= MAX_DEPTH)
    return Array.isArray(value) ? `[array ${value.length}]` : `[${typeName(value)}]`
  path.add(value)
  try {
    return walkObject(value, depth, path)
  } finally {
    path.delete(value)
  }
}

/** {@link walk} for an object already on `path`. */
function walkObject(value: object, depth: number, path: Set<object>): unknown {
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => walk(item, depth + 1, path))
    if (value.length > MAX_ITEMS) items.push(`… ${value.length - MAX_ITEMS} more`)
    return items
  }
  if (value instanceof Map) {
    return walk(
      Object.fromEntries([...value.entries()].map(([k, v]) => [String(k), v])),
      depth,
      path,
    )
  }
  if (value instanceof Set) return walk([...value], depth, path)

  // A model or entity usually serialises itself the way it wants to be seen.
  const toJSON = Reflect.get(value, 'toJSON')
  const source: unknown = typeof toJSON === 'function' ? safeCall(() => toJSON.call(value)) : value
  if (source !== value) return walk(source, depth, path)

  const out: Record<string, unknown> = {}
  const name = typeName(value)
  if (name !== 'Object') out['@type'] = name
  const keys = Object.keys(value)
  for (const key of keys.slice(0, MAX_KEYS)) {
    out[key] = isSecretKey(key) ? REDACTED : walk(Reflect.get(value, key), depth + 1, path)
  }
  if (keys.length > MAX_KEYS) out['…'] = `${keys.length - MAX_KEYS} more keys`
  return out
}

function typeName(value: object): string {
  const ctor = Reflect.get(value, 'constructor')
  const name = typeof ctor === 'function' ? Reflect.get(ctor, 'name') : undefined
  return typeof name === 'string' && name !== '' ? name : 'Object'
}

function safeCall(fn: () => unknown): unknown {
  try {
    return fn()
  } catch {
    return '[unserialisable]'
  }
}
