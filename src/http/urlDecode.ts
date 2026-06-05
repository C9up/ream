/**
 * Safe URL decoding helpers for untrusted request inputs.
 */

/** Decode URI component and keep raw value on malformed escapes. */
export function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Decode x-www-form-urlencoded component (`+` => space) safely. */
export function safeDecodeFormComponent(value: string): string {
  const normalized = value.replace(/\+/g, ' ')
  return safeDecodeURIComponent(normalized)
}
