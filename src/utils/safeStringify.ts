/**
 * JSON.stringify for a payload ream sends, as AdonisJS's `safeStringify`
 * (`@poppinss/utils/json`, read in 7.1.2) behaves: `BigInt` values become
 * strings, and a reference back to an enclosing object — a cycle — is written
 * as the string `"[Circular]"` instead of throwing.
 *
 * Only a cycle is replaced. An object reached twice through different paths
 * (`{ a: shared, b: shared }`) is written both times, as native
 * `JSON.stringify` writes it: the previous version remembered every object it
 * had seen and dropped the second one, so a response silently lost data
 * whenever a value was shared.
 *
 * Upstream reaches the same output through a fallback serializer
 * (safe-stable-stringify) that also sorts the keys of a payload holding a
 * cycle; key order here is always the object's own.
 */
export function safeStringify(value: unknown): string {
  // The objects on the path from the root to the value being written. The
  // replacer's `this` is the holder of the current key: entries above it are
  // finished subtrees and leave the stack.
  const path: object[] = []
  return JSON.stringify(value, function replace(this: unknown, _key: string, val: unknown) {
    if (typeof val === 'bigint') return val.toString()
    if (typeof val !== 'object' || val === null) return val
    while (path.length > 0 && path[path.length - 1] !== this) path.pop()
    if (path.includes(val)) return '[Circular]'
    path.push(val)
    return val
  })
}
