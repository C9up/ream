/**
 * Byte-size parsing and formatting, as `string.bytes` in AdonisJS.
 *
 * Upstream reaches for `@poppinss/string`, which wraps the `bytes` package.
 * Ream carries the ~40 lines instead of the dependency, matching that package's
 * semantics exactly: binary units (1 kb = 1024 b), a bare number string read as
 * bytes, and `null` — never a throw — when the input cannot be read.
 */

const UNITS = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
  pb: 1024 ** 5,
} as const

type Unit = keyof typeof UNITS

const PARSE = /^((?:-|\+)?(?:\d+(?:\.\d+)?)) *(kb|mb|gb|tb|pb)$/i
/** Trailing `.00`, or the zeros trailing a real decimal. */
const TRAILING_ZEROS = /(?:\.0*|(\.[^0]+)0+)$/

/**
 * Read a human-readable size into a number of bytes.
 *
 * A number passes through untouched. A string with no unit is read as bytes,
 * so `'1024'` and `1024` agree. Returns `null` when there is no number to find.
 */
export function parse(value: string | number): number | null {
  if (typeof value === 'number') return Number.isNaN(value) ? null : value
  if (typeof value !== 'string') return null

  const matched = PARSE.exec(value)
  const amount = matched ? Number.parseFloat(matched[1]) : Number.parseInt(value, 10)
  if (Number.isNaN(amount)) return null

  const unit = (matched ? matched[2].toLowerCase() : 'b') as Unit
  return Math.floor(UNITS[unit] * amount)
}

/**
 * Render a number of bytes for a human, picking the largest unit that leaves a
 * value at or above 1. Returns `null` for a non-finite input.
 */
export function format(valueInBytes: number, options?: { decimalPlaces?: number }): string | null {
  if (!Number.isFinite(valueInBytes)) return null

  const magnitude = Math.abs(valueInBytes)
  const unit: Unit =
    magnitude >= UNITS.pb
      ? 'pb'
      : magnitude >= UNITS.tb
        ? 'tb'
        : magnitude >= UNITS.gb
          ? 'gb'
          : magnitude >= UNITS.mb
            ? 'mb'
            : magnitude >= UNITS.kb
              ? 'kb'
              : 'b'

  const rendered = (valueInBytes / UNITS[unit])
    .toFixed(options?.decimalPlaces ?? 2)
    .replace(TRAILING_ZEROS, '$1')

  return `${rendered}${unit.toUpperCase()}`
}

export default { parse, format }
