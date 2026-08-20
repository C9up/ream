/**
 * Console UI — `this.logger` and `this.prompt` on every command (Console parity).
 *
 * Kept dependency-free: the framework ships no colour or prompt library, and
 * pulling one in for the CLI surface alone is not worth the install weight.
 */

import { stdout } from 'node:process'

/** Colour is opt-out via NO_COLOR and skipped when piped to a file. */
function supportsColour(stream: NodeJS.WriteStream): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '') return true
  return Boolean(stream.isTTY)
}

const CODES = {
  reset: '\u001B[0m',
  dim: '\u001B[2m',
  red: '\u001B[31m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  blue: '\u001B[34m',
  magenta: '\u001B[35m',
  cyan: '\u001B[36m',
} as const

export type Colour = keyof Omit<typeof CODES, 'reset'>

export function colourise(
  text: string,
  colour: Colour,
  stream: NodeJS.WriteStream = stdout,
): string {
  if (!supportsColour(stream)) return text
  return `${CODES[colour]}${text}${CODES.reset}`
}
