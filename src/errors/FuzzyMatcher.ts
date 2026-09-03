/**
 * Fuzzy Matcher — suggests corrections for typos using Levenshtein distance.
 *
 * @implements FR72
 */

/**
 * Calculate Levenshtein distance between two strings.
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length

  if (m === 0) return n
  if (n === 0) return m

  // Two rows rather than the whole matrix: the recurrence only ever reads the
  // row above and the cell to the left, so the rest was allocated and never
  // looked at again.
  let previous: number[] = Array.from({ length: n + 1 }, (_, j) => j)

  for (let i = 1; i <= m; i++) {
    const current: number[] = [i]
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current.push(
        Math.min(
          cell(previous, j) + 1, // deletion
          cell(current, j - 1) + 1, // insertion
          cell(previous, j - 1) + cost, // substitution
        ),
      )
    }
    previous = current
  }

  return cell(previous, n)
}

/**
 * One cell of a row that has already been filled.
 *
 * Each row is built left to right and every column is written before it is
 * read, so a miss cannot happen — and this is where that invariant is stated
 * rather than asserted past it. Reading the row directly would have every
 * access typed "a number, or nothing", which is not what the algorithm knows.
 */
function cell(row: number[], index: number): number {
  const value = row[index]
  if (value === undefined) {
    throw new RangeError(`levenshtein: column ${index} was read before it was written`)
  }
  return value
}

/**
 * Find the closest matches from a list of candidates.
 *
 * @param input - The typo'd string
 * @param candidates - Available options
 * @param maxDistance - Maximum Levenshtein distance to consider (default: 3)
 * @param maxResults - Maximum suggestions to return (default: 3)
 * @returns Sorted array of { candidate, distance }
 */
/**
 * Find the closest matches from a list of candidates.
 * Exact matches (distance 0) are excluded — this is for "did you mean" suggestions.
 *
 * @param input - The typo'd string (max 100 chars — longer inputs return empty)
 * @param candidates - Available options
 * @param maxDistance - Maximum Levenshtein distance to consider (default: 3)
 * @param maxResults - Maximum suggestions to return (default: 3)
 * @returns Sorted array of { candidate, distance }
 */
export function findClosestMatches(
  input: string,
  candidates: string[],
  maxDistance = 3,
  maxResults = 3,
): Array<{ candidate: string; distance: number }> {
  // Guard against very long inputs to avoid O(m*n) allocation pressure
  if (input.length > 100 || candidates.length === 0) return []

  const results = candidates
    .map((candidate) => ({
      candidate,
      distance: levenshtein(input.toLowerCase(), candidate.toLowerCase()),
    }))
    .filter((r) => r.distance <= maxDistance && r.distance > 0)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, maxResults)

  return results
}

/**
 * Format a "did you mean?" suggestion string.
 *
 * @param input - What the user typed
 * @param candidates - Available options to match against
 * @returns Formatted suggestion string, or empty string if no matches
 */
export function didYouMean(input: string, candidates: string[]): string {
  const [best, ...rest] = findClosestMatches(input, candidates)
  if (best === undefined) return ''

  if (rest.length === 0) {
    return `Did you mean '${best.candidate}'?`
  }
  const matches = [best, ...rest]

  const suggestions = matches.map((m) => `'${m.candidate}'`).join(', ')
  return `Did you mean one of: ${suggestions}?`
}
