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

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[])

  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // deletion
        dp[i][j - 1] + 1,      // insertion
        dp[i - 1][j - 1] + cost, // substitution
      )
    }
  }

  return dp[m][n]
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
    .map((candidate) => ({ candidate, distance: levenshtein(input.toLowerCase(), candidate.toLowerCase()) }))
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
  const matches = findClosestMatches(input, candidates)
  if (matches.length === 0) return ''

  if (matches.length === 1) {
    return `Did you mean '${matches[0].candidate}'?`
  }

  const suggestions = matches.map((m) => `'${m.candidate}'`).join(', ')
  return `Did you mean one of: ${suggestions}?`
}
