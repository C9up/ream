/**
 * Render an error for a human reading a terminal (AdonisJS `prettyPrintError`).
 *
 * Its own module rather than a helper inside `Ignitor.ts`: the console kernel
 * renders the failures of the command it ran, and reaching into the Ignitor for
 * that would make the two import each other.
 */

import { ReamError } from './ReamError.js'

export function prettyPrintError(error: unknown): void {
  if (error instanceof ReamError) {
    console.error(error.toDevString())
  } else if (error instanceof Error) {
    console.error(`\n  ${error.message}\n`)
    if (error.stack) console.error(error.stack)
  } else {
    console.error(error)
  }
}
