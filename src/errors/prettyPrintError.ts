/**
 * Render an error for a human reading a terminal (AdonisJS `prettyPrintError`).
 *
 * Its own module rather than a helper inside `Ignitor.ts`: the console kernel
 * renders the failures of the command it ran, and reaching into the Ignitor for
 * that would make the two import each other.
 */

import { Exception } from '@c9up/flare'
import { errors } from './aggregate.js'
import { errorDocsUrl } from './docsUrl.js'
import { renderError } from './renderError.js'

const FRAMEWORK_ERRORS: readonly unknown[] = Object.values(errors)

/** Whether `error` is one of ream's own errors, documented in the error index. */
function isFrameworkError(error: unknown): error is Exception {
  return (
    error instanceof Exception &&
    error.code !== undefined &&
    FRAMEWORK_ERRORS.includes(error.constructor)
  )
}

/**
 * A framework error in a box: its code and message, the advice it carries
 * (`help`), and the link to its documentation.
 */
export function describeFrameworkError(error: Exception): string {
  const code = error.code ?? 'E_UNKNOWN'
  const content: string[] = [`[${code}] ${error.message}`]
  if (error.help !== undefined && error.help !== '') {
    content.push('')
    content.push(`Hint: ${error.help}`)
  }
  content.push(`Docs: ${errorDocsUrl(code)}`)

  const width = Math.min(Math.max(...content.map((line) => line.length)) + 4, 80)
  const border = '─'.repeat(width)
  return [`┌${border}┐`, ...content.map((line) => `│ ${line}`), `└${border}┘`].join('\n')
}

export function prettyPrintError(error: unknown): void {
  // A framework error already says what it is, what it was doing and what to
  // try — printing a source excerpt under it would bury that.
  if (isFrameworkError(error)) {
    console.error(describeFrameworkError(error))
    return
  }
  console.error(renderError(error))
}
