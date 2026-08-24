/**
 * Duration parsing, matching what AdonisJS accepts.
 *
 * Adonis runs every duration through `string.seconds.parse()`
 * (`@poppinss/string`), which delegates string forms to `@lukeed/ms`. A config
 * carrying `age: '2 hours'` or `maxAge: '30 mins'` therefore has to work here
 * too — this is a value an app moves over verbatim.
 *
 * Two rules taken straight from that implementation, both easy to get wrong:
 *
 *  - A **number is already in seconds** and is returned untouched. It is NOT
 *    milliseconds, whatever a reading of the guides suggests: `seconds.parse`
 *    starts with `if (typeof duration === 'number') return duration`.
 *  - A **string with no unit is in milliseconds**. `@lukeed/ms` falls through
 *    its unit branches and returns the bare number as ms, so Adonis' `'7200'`
 *    is seven seconds, not two hours. Treating it as seconds — which is the
 *    intuitive reading — would silently stretch every such value by 1000.
 */

/**
 * The unit vocabulary of `@lukeed/ms`, in the order its regex tests them.
 * Written out rather than reusing its regex so the accepted spellings are
 * readable: `2h`, `2 hrs`, `2 hours` all mean the same thing.
 */
const DURATION_PATTERN =
  /^(-?(?:\d+)?\.?\d+) *(m(?:illiseconds?|s(?:ecs?)?))?(s(?:ec(?:onds?|s)?)?)?(m(?:in(?:utes?|s)?)?)?(h(?:ours?|rs?)?)?(d(?:ays?)?)?(w(?:eeks?|ks?)?)?(y(?:ears?|rs?)?)?$/

const SECOND = 1000
const MINUTE = SECOND * 60
const HOUR = MINUTE * 60
const DAY = HOUR * 24
const YEAR = DAY * 365.25

/**
 * Parse a duration string to MILLISECONDS, or `undefined` when it is not a
 * duration. Mirrors `@lukeed/ms`'s `parse`, including its quirk that a value
 * with no unit is milliseconds.
 */
export function parseDurationMs(value: string): number | undefined {
  const matched = DURATION_PATTERN.exec(value.toLowerCase())
  if (matched === null) return undefined
  const amount = Number.parseFloat(matched[1] ?? '')
  // `@lukeed/ms` rejects a zero amount here (`(num = parseFloat(...))` is
  // falsy), and so must we, or `'0 hours'` would part company with Adonis.
  if (!amount) return undefined
  if (matched[3] !== undefined) return amount * SECOND
  if (matched[4] !== undefined) return amount * MINUTE
  if (matched[5] !== undefined) return amount * HOUR
  if (matched[6] !== undefined) return amount * DAY
  if (matched[7] !== undefined) return amount * DAY * 7
  if (matched[8] !== undefined) return amount * YEAR
  // No unit — and `matched[2]` (an explicit `ms`) lands here too.
  return amount
}

/**
 * A duration as SECONDS, the way `string.seconds.parse` returns it: a number
 * passes through untouched, a string is parsed and floored.
 *
 * @param label - what is being parsed, for the error message.
 */
export function durationToSeconds(value: number | string, label: string): number {
  if (typeof value === 'number') return Math.trunc(value)
  const milliseconds = parseDurationMs(value)
  if (milliseconds === undefined) {
    throw new Error(
      `Cannot read "${value}" as ${label}. Use a number of seconds, or a duration such as '30m', '2 hours' or '7 days'.`,
    )
  }
  return Math.floor(milliseconds / SECOND)
}
