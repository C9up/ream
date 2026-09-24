/**
 * Render an error for a human reading a terminal (AdonisJS `prettyPrintError`).
 *
 * Its own module rather than a helper inside `Ignitor.ts`: the console kernel
 * renders the failures of the command it ran, and reaching into the Ignitor for
 * that would make the two import each other.
 */

import { ReamError } from './ReamError.js'
import { renderError } from './renderError.js'

export function prettyPrintError(error: unknown): void {
  // A framework error already says what it is, what it was doing and what to
  // try — printing a source excerpt under it would bury that.
  if (error instanceof ReamError) {
    console.error(error.toDevString())
    return
  }
  console.error(renderError(error))
}
